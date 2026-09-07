import Foundation
import ScreenCaptureKit
import AppKit

enum CaptureError: Error { case noDisplay, encodingFailed }

/// The factor between the image the agent was shown and the physical display.
/// A click arriving after a screenshot is interpreted in the screenshot's space,
/// so this is what converts it back.
nonisolated(unsafe) var lastCaptureScale: Double = 1.0

func captureMainDisplay(maxEdge: Int, quality: Double) async throws -> (String, Int, Int) {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first else { throw CaptureError.noDisplay }

    let (tw, th) = targetSize(w: display.width, h: display.height, maxEdge: maxEdge)
    lastCaptureScale = Double(display.width) / Double(tw)

    let filter = SCContentFilter(display: display, excludingWindows: [])
    let config = SCStreamConfiguration()
    config.width = tw
    config.height = th
    config.captureResolution = .best
    config.showsCursor = true

    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)

    let path = NSTemporaryDirectory() + "voicer-\(UUID().uuidString).jpg"
    let rep = NSBitmapImageRep(cgImage: image)
    guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: quality]) else {
        throw CaptureError.encodingFailed
    }
    try data.write(to: URL(fileURLWithPath: path))
    return (path, tw, th)
}
