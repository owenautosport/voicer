import Foundation
import Speech
import AVFoundation

enum ListenError: Error, CustomStringConvertible {
    case alreadyListening
    case recogniserUnavailable
    case onDeviceUnavailable
    case notAuthorised
    case microphoneNotAuthorised

    /// Every failure names the pane that fixes it. A user staring at a dead
    /// microphone cannot act on the word "notAuthorised".
    var description: String {
        switch self {
        case .alreadyListening:
            return "Already listening."
        case .recogniserUnavailable:
            return "The en-GB speech recogniser is unavailable on this Mac."
        case .onDeviceUnavailable:
            return "On-device speech recognition is not installed for en-GB. "
                 + "Add English (UK) under System Settings > Keyboard > Dictation."
        case .notAuthorised:
            return "Voicer has no speech-recognition access. Grant it in "
                 + "System Settings > Privacy & Security > Speech Recognition."
        case .microphoneNotAuthorised:
            return "Voicer has no microphone access. Grant it in "
                 + "System Settings > Privacy & Security > Microphone."
        }
    }
}

/// Map RMS to a 0…1 bar height. Speech RMS is tiny and logarithmic to the ear,
/// so a linear mapping looks dead; this is a dB curve floored at -50 dB.
func normalisedLevel(rms: Float) -> Double {
    guard rms > 0 else { return 0 }
    let db = 20 * log10(Double(rms))
    return min(1, max(0, (db + 50) / 50))
}

final class Listener: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var isRunning = false
    private var lastText = ""
    private var currentId = 0
    private var emit: ((Event) -> Void)?
    private var finalSent = false
    private var failure: String?
    private let lock = NSLock()

    /// Above this normalised level counts as somebody talking rather than the
    /// room being quiet. Speech sits around 0.4-0.8; room tone under 0.1.
    private static let voiceThreshold = 0.18

    private var silenceLimit: TimeInterval = 2.0
    private var heardVoice = false
    private var lastVoiceAt: CFAbsoluteTime = 0

    /// An empty room is not a fault. The recogniser reports "no speech
    /// detected" as an error, but the turn machine already treats an empty
    /// transcript as "said nothing, spend nothing" — reporting it as a failure
    /// would put a red alert in front of the user for staying quiet.
    private static func isSilence(_ error: Error) -> Bool {
        let ns = error as NSError
        return ns.domain == "kAFAssistantErrorDomain" && ns.code == 1110
    }

    /// The recogniser reports its refusals as raw NSErrors. Nobody can act on
    /// "kLSRErrorDomain Code=201", so the ones that a user can actually fix are
    /// translated into the setting that fixes them.
    private static func explain(_ error: Error) -> String {
        let ns = error as NSError
        switch (ns.domain, ns.code) {
        case ("kLSRErrorDomain", 201):
            return "Siri and Dictation are switched off, so this Mac has no speech "
                 + "recogniser. Turn on System Settings > Keyboard > Dictation."
        case ("kLSRErrorDomain", 203), ("kAFAssistantErrorDomain", 1101):
            return "The offline en-GB speech model is not installed. Turn on "
                 + "System Settings > Keyboard > Dictation and choose English (UK)."
        default:
            return ns.localizedDescription
        }
    }

    /// macOS does not reliably raise the microphone prompt just because an
    /// AVAudioEngine input tap was installed: a denied or never-asked
    /// microphone yields a perfectly valid input node that delivers nothing but
    /// zeros. Asking outright is the only way to tell silence from refusal.
    private static func microphoneAuthorised() -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return true
        case .notDetermined:
            // A box rather than a captured var: the callback runs on another
            // queue, and Swift 6 will not let a local be mutated from it.
            final class Answer: @unchecked Sendable { var granted = false }
            let answer = Answer()
            let sem = DispatchSemaphore(value: 0)
            AVCaptureDevice.requestAccess(for: .audio) { ok in
                answer.granted = ok
                sem.signal()
            }
            sem.wait()
            return answer.granted
        default:
            return false
        }
    }

    func start(id: Int, silenceMs: Int? = nil, emit: @escaping (Event) -> Void) throws {
        guard !isRunning else { throw ListenError.alreadyListening }

        guard Self.microphoneAuthorised() else { throw ListenError.microphoneNotAuthorised }

        guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
            throw ListenError.notAuthorised
        }
        guard let recogniser = SFSpeechRecognizer(locale: Locale(identifier: "en-GB")),
              recogniser.isAvailable else {
            throw ListenError.recogniserUnavailable
        }
        // Never silently fall back to the network: audio must not leave the machine.
        guard recogniser.supportsOnDeviceRecognition else {
            throw ListenError.onDeviceUnavailable
        }

        currentId = id
        self.emit = emit
        lastText = ""
        finalSent = false
        failure = nil
        heardVoice = false
        lastVoiceAt = CFAbsoluteTimeGetCurrent()
        if let silenceMs { silenceLimit = Double(silenceMs) / 1000 }

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = true
        request = req

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            req.append(buffer)
            self?.emitLevel(from: buffer)
        }

        task = recogniser.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            if let result {
                self.lastText = result.bestTranscription.formattedString
                if !result.isFinal {
                    emit(.partial(id: id, text: self.lastText, level: 0))
                }
            }
            if let error, !Self.isSilence(error) {
                // Never swallowed: a recogniser that fails and a user who said
                // nothing both end as an empty transcript, and only one of them
                // is something the user can do anything about.
                self.failure = Self.explain(error)
                FileHandle.standardError.write(
                    Data("recognition failed: \(error)\n".utf8))
            }
            if error != nil || result?.isFinal == true {
                self.sendFinal()
            }
        }

        engine.prepare()
        try engine.start()
        isRunning = true

        FileHandle.standardError.write(Data((
            "listening: mic=\(AVCaptureDevice.authorizationStatus(for: .audio).rawValue) "
          + "speech=\(SFSpeechRecognizer.authorizationStatus().rawValue) "
          + "onDevice=\(recogniser.supportsOnDeviceRecognition) "
          + "format=\(format.sampleRate)Hz/\(format.channelCount)ch\n").utf8))
    }

    private func emitLevel(from buffer: AVAudioPCMBuffer) {
        guard let channel = buffer.floatChannelData?[0] else { return }
        let n = Int(buffer.frameLength)
        guard n > 0 else { return }
        var sum: Float = 0
        for i in 0..<n { sum += channel[i] * channel[i] }
        let rms = (sum / Float(n)).squareRoot()
        let level = normalisedLevel(rms: rms)

        // End the turn on a pause, the way a listener does. Only after speech
        // has actually started: a limit that fired before the first word would
        // hang up on anyone slow to begin.
        let now = CFAbsoluteTimeGetCurrent()
        if level >= Self.voiceThreshold {
            heardVoice = true
            lastVoiceAt = now
        } else if heardVoice, silenceLimit > 0, now - lastVoiceAt > silenceLimit {
            // Off this thread: sendFinal tears down the tap we are inside.
            DispatchQueue.main.async { [weak self] in self?.sendFinal() }
            return
        }

        emit?(.partial(id: currentId, text: lastText, level: level))
    }

    /// Guaranteed to emit at most one reply per session, however many paths
    /// race to end it (user stop, recogniser end-of-speech, or an error).
    private func sendFinal() {
        lock.lock()
        guard isRunning, !finalSent else { lock.unlock(); return }
        finalSent = true
        isRunning = false
        let reason = failure
        lock.unlock()

        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil

        // Words beat an error: a partial transcript is still worth a turn. It is
        // only silence plus a failure that has to be reported as a failure.
        if lastText.isEmpty, let reason {
            emit?(.error(id: currentId, code: "recognition_failed", message: reason))
        } else {
            emit?(.final(id: currentId, text: lastText))
        }
    }

    func stop() { sendFinal() }
}
