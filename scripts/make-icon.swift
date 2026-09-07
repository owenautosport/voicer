// Draws build/icon.png (1024²), the master for the .icns.
//
// CoreGraphics rather than Pillow or rsvg-convert: the Swift toolchain is
// already a requirement of this project, and neither of those is. Run through
// scripts/make-icon.sh, which also builds the iconset.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let side = 1024.0
let space = CGColorSpaceCreateDeviceRGB()

guard let ctx = CGContext(
    data: nil, width: Int(side), height: Int(side), bitsPerComponent: 8, bytesPerRow: 0,
    space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { fatalError("no context") }

// Draw in SVG's coordinates: origin top-left, y downwards.
ctx.translateBy(x: 0, y: side)
ctx.scaleBy(x: 1, y: -1)
ctx.setAllowsAntialiasing(true)

// Apple's tile proportions: 1024 canvas, ~100 margin, corner radius 0.2237 x tile.
let margin = 100.0
let tile = side - margin * 2
let radius = tile * 0.2237
let tileRect = CGRect(x: margin, y: margin, width: tile, height: tile)

ctx.saveGState()
ctx.addPath(CGPath(roundedRect: tileRect, cornerWidth: radius, cornerHeight: radius, transform: nil))
ctx.clip()
let gradient = CGGradient(
    colorsSpace: space,
    colors: [
        CGColor(red: 0.16, green: 0.16, blue: 0.18, alpha: 1),
        CGColor(red: 0.035, green: 0.035, blue: 0.043, alpha: 1),
    ] as CFArray,
    locations: [0, 1]
)!
ctx.drawLinearGradient(
    gradient,
    start: CGPoint(x: 0, y: margin), end: CGPoint(x: 0, y: margin + tile), options: [])
ctx.restoreGState()

// The same microphone the capsule draws, in a 24-unit box scaled to the tile.
let glyph = 470.0
let scale = glyph / 24.0
let ox = (side - glyph) / 2
let oy = (side - glyph) / 2 - 8   // optically centred: the stem hangs low
func p(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: ox + x * scale, y: oy + y * scale) }

ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
ctx.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
ctx.setLineWidth(2.0 * scale)
ctx.setLineCap(.round)

let capsule = CGRect(
    x: ox + 9 * scale, y: oy + 2.5 * scale, width: 6 * scale, height: 11 * scale)
ctx.addPath(CGPath(
    roundedRect: capsule, cornerWidth: 3 * scale, cornerHeight: 3 * scale, transform: nil))
ctx.fillPath()

ctx.addArc(
    center: p(12, 11), radius: 6.5 * scale,
    startAngle: 0, endAngle: .pi, clockwise: false)
ctx.strokePath()

ctx.move(to: p(12, 17.5))
ctx.addLine(to: p(12, 21.5))
ctx.strokePath()

guard let image = ctx.makeImage() else { fatalError("no image") }
let out = URL(fileURLWithPath: "build/icon.png")
guard let dest = CGImageDestinationCreateWithURL(
    out as CFURL, UTType.png.identifier as CFString, 1, nil
) else { fatalError("no destination") }
CGImageDestinationAddImage(dest, image, nil)
guard CGImageDestinationFinalize(dest) else { fatalError("write failed") }
print("wrote build/icon.png")
