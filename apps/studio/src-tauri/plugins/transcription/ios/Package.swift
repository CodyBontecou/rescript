// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "tauri-plugin-transcription",
    // swift-rs resolves this package through the macOS host toolchain even
    // when it compiles the target for iOS. Declare the dependency's minimum
    // host platform as well, otherwise SwiftPM assumes macOS 10.13 and rejects
    // FluidAudio (macOS 14+) before the iOS build starts.
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(
            name: "tauri-plugin-transcription",
            type: .static,
            targets: ["tauri-plugin-transcription"]
        )
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api"),
        .package(
            url: "https://github.com/argmaxinc/argmax-oss-swift",
            exact: "1.0.0"
        ),
        .package(
            url: "https://github.com/FluidInference/FluidAudio",
            revision: "88d6d8166880dee1ac7c32c80f8e10cd782f8ca8"
        )
    ],
    targets: [
        .target(
            name: "tauri-plugin-transcription",
            dependencies: [
                .byName(name: "Tauri"),
                .product(name: "WhisperKit", package: "argmax-oss-swift"),
                .product(name: "SpeakerKit", package: "argmax-oss-swift"),
                .product(name: "FluidAudio", package: "FluidAudio")
            ],
            path: "Sources"
        )
    ]
)
