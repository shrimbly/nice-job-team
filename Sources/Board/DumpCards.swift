import BoardKit
import Foundation

/// Prints the cards the app would draw, in render-board.sh's own JSON shape, so the
/// two can be diffed directly:
///
///     Board.app/Contents/MacOS/Board --dump-cards | jq '.cards[] | {id, pill}'
enum DumpCards {
    static func run() async {
        let reader = OrchestratorReader()
        let snapshot = reader.read()
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

        let cards = BoardAssembler.cards(
            orchestrator: snapshot,
            pullRequests: pullRequests,
            linearWorkspace: config.linearWorkspace)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let cardsJSON = try? encoder.encode(cards),
              let text = String(data: cardsJSON, encoding: .utf8) else {
            FileHandle.standardError.write(Data("could not encode cards\n".utf8))
            return
        }
        print("{\"orchestrator\": \(snapshot.isPresent), \"note\": \(note.map { "\"\($0)\"" } ?? "null"), \"cards\": \(text)}")
    }
}
