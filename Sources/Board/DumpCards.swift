import BoardKit
import Foundation

/// Prints the cards the app would draw, in render-board.sh's own JSON shape, so the
/// two can be diffed directly:
///
///     Board.app/Contents/MacOS/Board --dump-cards | jq '.cards[] | {id, pill}'
///
/// With one project that shape is exactly render-board.sh's, which is what makes
/// the diff worth running. With several the output grows a `projects` array, since
/// one flat list could not say which board a card came from. To diff one project
/// on a machine running several, pin it:
///
///     BOARD_ORCHESTRATOR_PROJECT=<key> Board --dump-cards
enum DumpCards {
    static func run() async {
        let reader = OrchestratorReader()
        let projects = reader.projects
        let config = BoardConfig.load(from: reader.root)

        var pullRequests: [PullRequest] = []
        var note: String?
        if let github = GitHubClient.locate() {
            do {
                pullRequests = try await github.fetch(repos: config.repos).pullRequests
            } catch {
                note = "gh failed: \(error)"
            }
        } else {
            note = "gh not found"
        }

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        func encode(_ cards: [Card]) -> String {
            guard let data = try? encoder.encode(cards),
                  let text = String(data: data, encoding: .utf8) else { return "[]" }
            return text
        }
        let present = reader.directoryExists && !projects.isEmpty
        let head = "{\"orchestrator\": \(present), \"note\": \(note.map { "\"\($0)\"" } ?? "null")"

        guard projects.count > 1 else {
            let only = BoardAssembler.cards(
                orchestrator: projects.first.map(reader.read) ?? .absent,
                pullRequests: pullRequests,
                linearWorkspace: config.linearWorkspace)
            print("\(head), \"cards\": \(encode(only))}")
            return
        }

        // The same call the panel makes, then grouped for reading. Building each
        // project separately here is what this tool used to do, and it reproduced
        // a bug the app no longer has: a diagnostic that takes its own path can
        // only ever describe itself.
        let merged = BoardAssembler.cards(
            projects: projects.map { (project: $0, snapshot: reader.read($0)) },
            pullRequests: pullRequests,
            config: config)
        let blocks = projects.map { project in
            let mine = merged.filter { $0.project.key == project.key }.map(\.card)
            return """
            {"key": "\(project.key)", "shortName": "\(config.shortName(for: project.key))", \
            "cards": \(encode(mine))}
            """
        }
        print("\(head), \"projects\": [\(blocks.joined(separator: ", "))]}")
    }
}
