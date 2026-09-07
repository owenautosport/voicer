import Foundation
import AVFoundation

/// Prefer premium, then enhanced, then anything English. The premium Siri
/// voices are markedly better than the default and are already on the machine.
func bestEnglishVoice() -> AVSpeechSynthesisVoice? {
    let english = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en") }
    let byQuality: (AVSpeechSynthesisVoiceQuality) -> AVSpeechSynthesisVoice? = { q in
        english.first { $0.quality == q && $0.language == "en-GB" }
            ?? english.first { $0.quality == q }
    }
    return byQuality(.premium) ?? byQuality(.enhanced) ?? english.first
}

final class Speaker: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    private let synth = AVSpeechSynthesizer()
    private var pending: [ObjectIdentifier: (Int, (Event) -> Void)] = [:]
    /// `pending` is written from the stdin reader thread and read from the main
    /// queue by the delegate. Unsynchronised, an entry can be lost — and a lost
    /// entry means `speech_done` is never emitted, the turn never finishes
    /// speaking, and the microphone button goes dead for the rest of the run.
    private let lock = NSLock()

    override init() {
        super.init()
        synth.delegate = self
    }

    func speak(id: Int, text: String, emit: @escaping (Event) -> Void) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            emit(.speechDone(id: id))
            return
        }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = bestEnglishVoice()
        utterance.rate = 0.52
        lock.lock()
        pending[ObjectIdentifier(utterance)] = (id, emit)
        lock.unlock()

        // AVSpeechSynthesizer is a main-thread API and delivers its delegate
        // callbacks on the main queue. Speaking from the reader thread can mean
        // they never arrive.
        DispatchQueue.main.async { [weak self] in self?.synth.speak(utterance) }
    }

    func stop() {
        DispatchQueue.main.async { [weak self] in
            self?.synth.stopSpeaking(at: .immediate)
        }
    }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        finish(utterance)
    }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        finish(utterance)
    }

    private func finish(_ utterance: AVSpeechUtterance) {
        lock.lock()
        let entry = pending.removeValue(forKey: ObjectIdentifier(utterance))
        lock.unlock()
        guard let (id, emit) = entry else { return }
        emit(.speechDone(id: id))
    }
}
