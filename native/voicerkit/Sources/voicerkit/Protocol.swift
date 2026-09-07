import Foundation

enum Command: String, Codable {
    case listenStart = "listen_start"
    case listenStop  = "listen_stop"
    case capture
    case speak
    case cancel
    case click
    case type
    case key
    case scroll
}

struct Request: Codable {
    let cmd: Command
    let id: Int
    let text: String?
    let x: Double?
    let y: Double?
    let dy: Int?
    let button: String?
    let combo: String?
    let silenceMs: Int?
    let maxEdge: Int?
    let quality: Int?

    static func decode(_ line: String) throws -> Request {
        try JSONDecoder().decode(Request.self, from: Data(line.utf8))
    }
}

/// Emitted as one line of JSON per event. Hand-encoded rather than Codable so
/// the wire format stays obvious and stable — the TypeScript side parses it.
enum Event {
    case partial(id: Int, text: String, level: Double)
    case final(id: Int, text: String)
    case captured(id: Int, path: String, w: Int, h: Int)
    case speechDone(id: Int)
    case acted(id: Int)
    case cancelled(id: Int)
    case error(id: Int, code: String, message: String)

    func encode() -> String {
        let o: [String: Any]
        switch self {
        case let .partial(id, text, level):
            o = ["id": id, "event": "partial", "text": text, "level": level]
        case let .final(id, text):
            o = ["id": id, "event": "final", "text": text]
        case let .captured(id, path, w, h):
            o = ["id": id, "event": "captured", "path": path, "w": w, "h": h]
        case let .speechDone(id):
            o = ["id": id, "event": "speech_done"]
        case let .acted(id):
            o = ["id": id, "event": "acted"]
        case let .cancelled(id):
            o = ["id": id, "event": "cancelled"]
        case let .error(id, code, message):
            o = ["id": id, "event": "error", "code": code, "message": message]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) else {
            return #"{"id":-1,"event":"error","code":"encode_failed","message":"unserialisable"}"#
        }
        return String(decoding: data, as: UTF8.self)
    }
}

/// Fit within `maxEdge` on the longest side, preserving aspect ratio.
/// Never upscales — a small display is sent at its native size.
func targetSize(w: Int, h: Int, maxEdge: Int) -> (Int, Int) {
    let longest = max(w, h)
    guard longest > maxEdge else { return (w, h) }
    let scale = Double(maxEdge) / Double(longest)
    return (Int((Double(w) * scale).rounded()), Int((Double(h) * scale).rounded()))
}
