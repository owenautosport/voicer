import Foundation
import CoreGraphics
import ApplicationServices

enum ControlError: Error {
    case notTrusted
    case unknownKey(String)
    case eventCreationFailed
}

/// The agent clicks in the coordinate space of the screenshot it was shown,
/// which is downscaled. Convert back before posting anything.
func physicalPoint(x: Double, y: Double, scale: Double) -> CGPoint {
    CGPoint(x: x * scale, y: y * scale)
}

struct KeyCombo {
    let keyCode: CGKeyCode
    let modifiers: CGEventFlags

    private static let named: [String: CGKeyCode] = [
        "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51,
        "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
        "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    ]

    private static let letters: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
        "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
        "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
    ]

    static func parse(_ combo: String) throws -> KeyCombo {
        var modifiers: CGEventFlags = []
        var key: String?

        for part in combo.lowercased().split(separator: "+").map(String.init) {
            switch part {
            case "cmd", "command":   modifiers.insert(.maskCommand)
            case "shift":            modifiers.insert(.maskShift)
            case "alt", "option":    modifiers.insert(.maskAlternate)
            case "ctrl", "control":  modifiers.insert(.maskControl)
            default: key = part
            }
        }

        guard let key else { throw ControlError.unknownKey(combo) }
        guard let code = named[key] ?? letters[key] else { throw ControlError.unknownKey(key) }
        return KeyCombo(keyCode: code, modifiers: modifiers)
    }
}

enum Control {
    /// Prompts once, then never again — macOS remembers the answer per bundle.
    /// The option key is spelled literally because the SDK exposes it as a
    /// mutable global, which Swift 6 will not let us touch concurrently.
    static func ensureTrusted() throws {
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        guard AXIsProcessTrustedWithOptions(options) else { throw ControlError.notTrusted }
    }

    /// Ask at launch rather than mid-click. Two reasons: a permission dialog
    /// appearing while the agent is already moving the mouse is alarming, and
    /// until something asks, macOS does not list the app in System Settings at
    /// all — so there is no row for the user to tick ahead of time.
    static func promptIfUntrusted() {
        guard !AXIsProcessTrusted() else { return }
        _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    }

    static func click(at point: CGPoint, button: String) throws {
        try ensureTrusted()
        let (down, up, mouseButton): (CGEventType, CGEventType, CGMouseButton) =
            button == "right" ? (.rightMouseDown, .rightMouseUp, .right)
                              : (.leftMouseDown, .leftMouseUp, .left)
        let src = CGEventSource(stateID: .hidSystemState)
        // Move first: many controls only react to a click that follows a hover.
        CGEvent(mouseEventSource: src, mouseType: .mouseMoved,
                mouseCursorPosition: point, mouseButton: mouseButton)?.post(tap: .cghidEventTap)
        usleep(20000)
        CGEvent(mouseEventSource: src, mouseType: down,
                mouseCursorPosition: point, mouseButton: mouseButton)?.post(tap: .cghidEventTap)
        CGEvent(mouseEventSource: src, mouseType: up,
                mouseCursorPosition: point, mouseButton: mouseButton)?.post(tap: .cghidEventTap)
    }

    /// Unicode-first, so accented characters and emoji survive without a keymap.
    static func type(_ text: String) throws {
        try ensureTrusted()
        let src = CGEventSource(stateID: .hidSystemState)
        for chunk in text.chunked(20) {
            guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
            else { throw ControlError.eventCreationFailed }
            var utf16 = Array(chunk.utf16)
            down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
            usleep(8000)
        }
    }

    static func key(_ combo: String) throws {
        try ensureTrusted()
        let parsed = try KeyCombo.parse(combo)
        let src = CGEventSource(stateID: .hidSystemState)
        guard let down = CGEvent(keyboardEventSource: src, virtualKey: parsed.keyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: parsed.keyCode, keyDown: false)
        else { throw ControlError.eventCreationFailed }
        down.flags = parsed.modifiers
        up.flags = parsed.modifiers
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    static func scroll(at point: CGPoint, dy: Int) throws {
        try ensureTrusted()
        let src = CGEventSource(stateID: .hidSystemState)
        CGEvent(mouseEventSource: src, mouseType: .mouseMoved,
                mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
        CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 1,
                wheel1: Int32(dy), wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
    }
}

private extension String {
    func chunked(_ size: Int) -> [String] {
        guard !isEmpty else { return [] }
        return stride(from: 0, to: count, by: size).map {
            let start = index(startIndex, offsetBy: $0)
            let end = index(start, offsetBy: Swift.min(size, count - $0))
            return String(self[start..<end])
        }
    }
}
