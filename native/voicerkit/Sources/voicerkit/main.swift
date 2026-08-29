import Foundation
import Speech
import AppKit

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
                    let (path, w, h) = try await captureMainDisplay(maxEdge: 1280, quality: 0.7)
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
                try listener.start(id: request.id, emit: emit)
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
