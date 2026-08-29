// swift-tools-version:6.0
import PackageDescription

// No test target: XCTest and swift-testing both ship with Xcode.app, which is not
// installed. Pure functions are covered by `voicerkit --self-test`; the wire
// protocol is covered from the TypeScript side against the real binary.
//
// The Info.plist is linked into the binary's __TEXT section. Without it macOS
// TCC kills the process the moment it touches the microphone or the speech
// recogniser — a bare SwiftPM executable has no bundle to carry usage strings.
let package = Package(
    name: "voicerkit",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "voicerkit",
            path: "Sources/voicerkit",
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Resources/Info.plist",
                ])
            ]
        ),
    ]
)
