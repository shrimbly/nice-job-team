import Foundation
@testable import BoardKit

enum Fixtures {
    static var root: URL {
        guard let resources = Bundle.module.resourceURL else {
            fatalError("test resources missing — check Package.swift's .copy(\"Fixtures\")")
        }
        return resources.appendingPathComponent("Fixtures")
    }

    static func data(_ path: String) throws -> Data {
        try Data(contentsOf: root.appendingPathComponent(path))
    }
}
