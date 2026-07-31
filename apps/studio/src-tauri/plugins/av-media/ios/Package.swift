// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "tauri-plugin-av-media",
    platforms: [
        .iOS(.v16)
    ],
    products: [
        .library(
            name: "tauri-plugin-av-media",
            type: .static,
            targets: ["tauri-plugin-av-media"]
        )
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(
            name: "tauri-plugin-av-media",
            dependencies: [.byName(name: "Tauri")],
            path: "Sources",
            linkerSettings: [
                .linkedFramework("StoreKit")
            ]
        )
    ]
)
