import Foundation

/// Which repos to poll and which Linear workspace ticket links point at. Read from
/// the orchestrator's `config.json` when it is there, and otherwise the defaults —
/// the app has to come up with no orchestrator on disk at all.
public struct BoardConfig: Sendable, Equatable {
    public var repos: [String]
    public var linearWorkspace: String

    public static let fallback = BoardConfig(
        repos: ["acme/platform"],
        linearWorkspace: CardBuilder.defaultLinearWorkspace)

    public init(repos: [String], linearWorkspace: String) {
        self.repos = repos
        self.linearWorkspace = linearWorkspace
    }

    public static func load(from root: URL) -> BoardConfig {
        struct File: Decodable {
            struct Repo: Decodable { var name: String? }
            struct Operator: Decodable { var linearWorkspace: String? }
            var repos: [Repo]?
            var `operator`: Operator?
        }
        guard let data = try? Data(contentsOf: root.appendingPathComponent("config.json")),
              let file = try? JSONDecoder().decode(File.self, from: data) else { return .fallback }

        let repos = (file.repos ?? []).compactMap(\.name).filter { !$0.isEmpty }
        return BoardConfig(
            repos: repos.isEmpty ? BoardConfig.fallback.repos : repos,
            linearWorkspace: file.operator?.linearWorkspace ?? BoardConfig.fallback.linearWorkspace)
    }
}

/// Assembles a board from both sources. GitHub is the required half: every open PR
/// gets a card whether or not the orchestrator has an item for it.
public enum BoardAssembler {
    public static func cards(
        orchestrator: OrchestratorSnapshot,
        pullRequests: [PullRequest],
        linearWorkspace: String
    ) -> [Card] {
        // Every item claims its PR, including the closed and rejected ones. The
        // orchestrator hiding a PR is a decision about that PR, not an absence of
        // one, and re-adding it here would quietly overrule the operator.
        let claimed = Set(orchestrator.items.compactMap { $0.pr?.number })
        let unclaimed = pullRequests
            .filter { !claimed.contains($0.number) }
            .sorted { $0.number > $1.number }
            .map(BoardItem.synthesized(from:))

        let cards = CardBuilder.build(
            items: orchestrator.items + unclaimed,
            pullRequests: pullRequests,
            agents: orchestrator.agents,
            workspaces: orchestrator.workspaces,
            linearWorkspace: linearWorkspace)

        return cards.filter { !hasLanded($0, merged: orchestrator.mergedPRNumbers) }
    }

    /// A merged PR is off the board. It asks nothing of the operator, and this app
    /// cannot reap the workspace behind it — that is the orchestrator's job.
    ///
    /// Both sources have to be checked or the card comes back: poll.sh sees the
    /// merge first, then the orchestrator moves the item to "merged", at which point
    /// render-board.sh's chain would light it up again as "Merged — reap". Hiding on
    /// only one of them makes a landed PR vanish and then reappear.
    static func hasLanded(_ card: Card, merged: Set<Int>) -> Bool {
        if card.boardState == "merged" { return true }
        if let number = card.num, merged.contains(number) { return true }
        return false
    }
}
