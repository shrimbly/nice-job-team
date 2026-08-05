// swift-tools-version:6.1
import PackageDescription

let package = Package(
    name: "Board",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "BoardKit"),
        .executableTarget(name: "Board", dependencies: ["BoardKit"]),
        .testTarget(
            name: "BoardKitTests",
            dependencies: ["BoardKit"],
            resources: [.copy("Fixtures")]),
    ]
)
