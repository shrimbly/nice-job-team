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

    static func json(at url: URL) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: try Data(contentsOf: url)) as? [String: Any] ?? [:]
    }

    static func boardItems(in dir: URL) throws -> [BoardItem] {
        struct File: Decodable { var items: [BoardItem]? }
        return try JSONDecoder().decode(
            File.self, from: try Data(contentsOf: dir.appendingPathComponent("board.json"))).items ?? []
    }

    static func agents(in dir: URL) throws -> [AgentStatus] {
        let workspaces = dir.appendingPathComponent("workspaces")
        let names = try FileManager.default.contentsOfDirectory(atPath: workspaces.path)
        return try names.filter { $0.hasSuffix(".json") }.sorted().map {
            try JSONDecoder().decode(
                AgentStatus.self, from: try Data(contentsOf: workspaces.appendingPathComponent($0)))
        }
    }

    static func workspaces(in dir: URL) throws -> [WorkspaceRef] {
        struct File: Decodable { var workspaces: [WorkspaceRef]? }
        return try JSONDecoder().decode(
            File.self,
            from: try Data(contentsOf: dir.appendingPathComponent("workspaces-signal.json"))).workspaces ?? []
    }

    static func encodeToJSONObjects(_ cards: [Card]) throws -> [[String: Any]] {
        let data = try JSONEncoder().encode(cards)
        return try JSONSerialization.jsonObject(with: data) as? [[String: Any]] ?? []
    }

    /// Canonical text for one JSON value, so a key Swift's encoder omitted and an
    /// explicit jq `null` compare equal, and `true` never equals `1`.
    static func describe(_ value: Any?) -> String {
        guard let value, !(value is NSNull) else { return "null" }
        guard let data = try? JSONSerialization.data(
                withJSONObject: [value], options: [.sortedKeys, .fragmentsAllowed]),
              let text = String(data: data, encoding: .utf8) else { return "<unencodable>" }
        return String(text.dropFirst().dropLast())
    }
}
