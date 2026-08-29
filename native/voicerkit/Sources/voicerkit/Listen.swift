import Foundation
import Speech
import AVFoundation

enum ListenError: Error {
    case alreadyListening
    case recogniserUnavailable
    case onDeviceUnavailable
    case notAuthorised
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
    private let lock = NSLock()

    func start(id: Int, emit: @escaping (Event) -> Void) throws {
        guard !isRunning else { throw ListenError.alreadyListening }

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
            if error != nil || result?.isFinal == true {
                self.sendFinal()
            }
        }

        engine.prepare()
        try engine.start()
        isRunning = true
    }

    private func emitLevel(from buffer: AVAudioPCMBuffer) {
        guard let channel = buffer.floatChannelData?[0] else { return }
        let n = Int(buffer.frameLength)
        guard n > 0 else { return }
        var sum: Float = 0
        for i in 0..<n { sum += channel[i] * channel[i] }
        let rms = (sum / Float(n)).squareRoot()
        emit?(.partial(id: currentId, text: lastText, level: normalisedLevel(rms: rms)))
    }

    /// Guaranteed to emit at most one `final` per session, however many paths
    /// race to end it (user stop, recogniser end-of-speech, or an error).
    private func sendFinal() {
        lock.lock()
        guard isRunning, !finalSent else { lock.unlock(); return }
        finalSent = true
        isRunning = false
        lock.unlock()

        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        emit?(.final(id: currentId, text: lastText))
    }

    func stop() { sendFinal() }
}
