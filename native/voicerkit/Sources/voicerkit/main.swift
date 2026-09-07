import Foundation
import Speech
import AppKit
import AVFoundation

if CommandLine.arguments.contains("--self-test") {
    SelfTest.run()
}

let out = FileHandle.standardOutput
let outLock = NSLock()

func emit(_ event: Event) {
    outLock.lock()
    defer { outLock.unlock() }
    out.write(Data((event.encode() + "\n").utf8))
}

let listener = Listener()
let speaker = Speaker()

// What we already hold, before anything asks for anything. "I think it already
// has that" is otherwise unanswerable: an ad-hoc signature changes on every
// build, so a grant given to the last build does not carry to this one.
FileHandle.standardError.write(Data((
    "permissions: accessibility=\(AXIsProcessTrusted()) "
  + "mic=\(AVCaptureDevice.authorizationStatus(for: .audio).rawValue) "
  + "speech=\(SFSpeechRecognizer.authorizationStatus().rawValue)\n").utf8))

// Only prompts when the grant is genuinely absent; puts Voicer in the
// Accessibility list so it can be granted before the agent needs to click.
Control.promptIfUntrusted()

/// Speech synthesis and the audio engine both need a live run loop. Reading
/// stdin happens on a background thread so the main thread can pump it.
let reader = Thread {
    while let line = readLine(strippingNewline: true) {
        guard !line.isEmpty else { continue }

        let request: Request
        do {
            request = try Request.decode(line)
        } catch {
            emit(.error(id: -1, code: "bad_request", message: "\(error)"))
            continue
        }

        switch request.cmd {
        case .capture:
            let sem = DispatchSemaphore(value: 0)
            Task {
                do {
                    // Sent per request: the settings live on the Electron side,
                    // and hardcoding them here made config.capture a dead letter.
                    let (path, w, h) = try await captureMainDisplay(
                        maxEdge: request.maxEdge ?? 1280,
                        quality: Double(request.quality ?? 70) / 100)
                    emit(.captured(id: request.id, path: path, w: w, h: h))
                } catch {
                    emit(.error(id: request.id, code: "capture_failed", message: "\(error)"))
                }
                sem.signal()
            }
            sem.wait()

        case .listenStart:
            do {
                // Asked lazily rather than at startup: a capture-only run should
                // never trip the speech-recognition permission at all.
                if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
                    let sem = DispatchSemaphore(value: 0)
                    SFSpeechRecognizer.requestAuthorization { _ in sem.signal() }
                    sem.wait()
                }
                try listener.start(id: request.id, silenceMs: request.silenceMs, emit: emit)
            } catch {
                emit(.error(id: request.id, code: "listen_failed", message: "\(error)"))
            }

        case .listenStop:
            listener.stop()

        case .cancel:
            listener.stop()
            speaker.stop()
            emit(.cancelled(id: request.id))

        case .speak:
            speaker.speak(id: request.id, text: request.text ?? "", emit: emit)

        case .click:
            do {
                try Control.click(
                    at: physicalPoint(x: request.x ?? 0, y: request.y ?? 0, scale: lastCaptureScale),
                    button: request.button ?? "left")
                emit(.acted(id: request.id))
            } catch {
                emit(.error(id: request.id, code: "click_failed", message: "\(error)"))
            }

        case .type:
            do {
                try Control.type(request.text ?? "")
                emit(.acted(id: request.id))
            } catch {
                emit(.error(id: request.id, code: "type_failed", message: "\(error)"))
            }

        case .key:
            do {
                try Control.key(request.combo ?? "")
                emit(.acted(id: request.id))
            } catch {
                emit(.error(id: request.id, code: "key_failed", message: "\(error)"))
            }

        case .scroll:
            do {
                try Control.scroll(
                    at: physicalPoint(x: request.x ?? 0, y: request.y ?? 0, scale: lastCaptureScale),
                    dy: request.dy ?? 0)
                emit(.acted(id: request.id))
            } catch {
                emit(.error(id: request.id, code: "scroll_failed", message: "\(error)"))
            }
        }
    }
    exit(0)
}
reader.start()

RunLoop.main.run()
