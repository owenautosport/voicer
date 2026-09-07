import Foundation

/// A test framework in thirty lines, because XCTest and swift-testing both ship
/// with Xcode.app and only the command-line toolchain is installed here.
/// Run with `voicerkit --self-test`; exits non-zero on the first failure count.
struct SelfTest {
    nonisolated(unsafe) private static var failures = 0
    nonisolated(unsafe) private static var checks = 0

    static func expect(_ condition: Bool, _ what: String) {
        checks += 1
        if !condition {
            failures += 1
            FileHandle.standardError.write(Data("FAIL: \(what)\n".utf8))
        }
    }

    static func expectEqual<T: Equatable>(_ a: T, _ b: T, _ what: String) {
        expect(a == b, "\(what) — expected \(b), got \(a)")
    }

    static func run() -> Never {
        // targetSize
        expect(targetSize(w: 2560, h: 1600, maxEdge: 1280) == (1280, 800), "scales a 16:10 display down")
        expect(targetSize(w: 1600, h: 2560, maxEdge: 1280) == (800, 1280), "scales a portrait display down")
        expect(targetSize(w: 1024, h: 768, maxEdge: 1280) == (1024, 768), "never upscales a small display")

        // Request decoding
        if let req = try? Request.decode(#"{"cmd":"capture","id":7}"#) {
            expectEqual(req.id, 7, "decodes the request id")
            expectEqual(req.cmd, .capture, "decodes the capture command")
        } else {
            expect(false, "decodes a capture request")
        }
        if let req = try? Request.decode(#"{"cmd":"speak","id":2,"text":"hello there"}"#) {
            expectEqual(req.text, "hello there", "decodes speak text")
        } else {
            expect(false, "decodes a speak request")
        }
        expect((try? Request.decode("{not json")) == nil, "rejects malformed JSON")

        // Event encoding
        let line = Event.captured(id: 3, path: "/tmp/a.jpg", w: 1280, h: 800).encode()
        expect(!line.contains("\n"), "an event is exactly one line")
        expect(line.contains("\"event\":\"captured\""), "an event names itself")
        expect(line.contains("\"id\":3"), "an event carries its correlation id")

        // Level mapping
        expectEqual(normalisedLevel(rms: 0), 0, "silence is zero")
        expectEqual(normalisedLevel(rms: 10), 1, "a loud signal clamps to one")
        expect(normalisedLevel(rms: 0.05) > 0 && normalisedLevel(rms: 0.05) < 1, "speech lands mid-range")

        // Coordinate conversion
        expect(physicalPoint(x: 640, y: 400, scale: 2.0) == CGPoint(x: 1280, y: 800),
               "scales screenshot coordinates back to physical pixels")
        expect(physicalPoint(x: 100, y: 50, scale: 1.0) == CGPoint(x: 100, y: 50),
               "leaves unscaled coordinates alone")

        // Key combos
        if let c = try? KeyCombo.parse("cmd+s") {
            expect(c.modifiers.contains(.maskCommand), "parses the command modifier")
            expectEqual(c.keyCode, 1, "parses the letter s")
        } else {
            expect(false, "parses cmd+s")
        }
        if let c = try? KeyCombo.parse("cmd+shift+4") {
            expect(c.modifiers.contains(.maskCommand) && c.modifiers.contains(.maskShift),
                   "parses two modifiers")
        } else {
            expect(false, "parses cmd+shift+4")
        }
        expectEqual((try? KeyCombo.parse("return"))?.keyCode, 36, "parses a named key")
        expectEqual((try? KeyCombo.parse("escape"))?.keyCode, 53, "parses escape")
        expect((try? KeyCombo.parse("cmd+notakey")) == nil, "rejects an unknown key")

        let summary = "\(checks - failures)/\(checks) checks passed\n"
        FileHandle.standardOutput.write(Data(summary.utf8))
        exit(failures == 0 ? 0 : 1)
    }
}
