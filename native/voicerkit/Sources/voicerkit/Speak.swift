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
        pending[ObjectIdentifier(utterance)] = (id, emit)
        synth.speak(utterance)
    }

    func stop() { synth.stopSpeaking(at: .immediate) }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        finish(utterance)
    }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        finish(utterance)
    }

    private func finish(_ utterance: AVSpeechUtterance) {
        guard let (id, emit) = pending.removeValue(forKey: ObjectIdentifier(utterance)) else { return }
        emit(.speechDone(id: id))
    }
}
