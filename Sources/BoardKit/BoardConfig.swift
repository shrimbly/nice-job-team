import Foundation

/// Which repos to poll and which Linear workspace ticket links point at. Read from
/// the orchestrator's `config.json` when it is there, and otherwise the defaults —
/// the app has to come up with no orchestrator on disk at all.
public struct BoardConfig: Sendable, Equatable {
    public var repos: [String]
    public var linearWorkspace: String
    /// Project key to the label its chip carries. Empty when one project runs,
    /// because a chip that is the same on every card says nothing.
    public var shortNames: [String: String]

    public static let fallback = BoardConfig(
        repos: ["acme/platform"],
        linearWorkspace: CardBuilder.defaultLinearWorkspace)

    public init(repos: [String], linearWorkspace: String, shortNames: [String: String] = [:]) {
        self.repos = repos
        self.linearWorkspace = linearWorkspace
        self.shortNames = shortNames
    }

    /// Project key to the repository it orchestrates.
    public var repoNames: [String: String] = [:]

    /// The chip label for a project. Falls back to the key, so an unconfigured
    /// project is still named rather than blank.
    public func shortName(for key: String) -> String {
        shortNames[key] ?? key
    }

    public func repoName(for key: String) -> String? { repoNames[key] }

    public static func load(from root: URL) -> BoardConfig {
        struct File: Decodable {
            struct Repo: Decodable {
                var name: String?
                var key: String?
                var shortName: String?
            }
            struct Operator: Decodable { var linearWorkspace: String? }
            var repos: [Repo]?
            var `operator`: Operator?
        }
        guard let data = try? Data(contentsOf: root.appendingPathComponent("config.json")),
              let file = try? JSONDecoder().decode(File.self, from: data) else { return .fallback }

        let repos = (file.repos ?? []).compactMap(\.name).filter { !$0.isEmpty }
        var shortNames: [String: String] = [:]
        var repoNames: [String: String] = [:]
        for repo in file.repos ?? [] {
            guard let name = repo.name, !name.isEmpty else { continue }
            // setup.sh derives the key the same way, so a config written before
            // `key` existed still lines up with its directory under `p/`.
            let key = repo.key ?? Self.derivedKey(from: name)
            shortNames[key] = repo.shortName?.isEmpty == false
                ? repo.shortName!
                : String(name.split(separator: "/").last ?? Substring(name))
            repoNames[key] = name
        }
        var config = BoardConfig(
            repos: repos.isEmpty ? BoardConfig.fallback.repos : repos,
            linearWorkspace: file.operator?.linearWorkspace ?? BoardConfig.fallback.linearWorkspace,
            shortNames: shortNames)
        config.repoNames = repoNames
        return config
    }

    static func derivedKey(from repoName: String) -> String {
        let lowered = repoName.lowercased()
        let mapped = lowered.map { $0.isLetter || $0.isNumber ? $0 : "-" }
        return String(mapped).split(separator: "-").joined(separator: "-")
    }
}

/// Assembles a board from both sources. GitHub is the required half: every open PR
/// gets a card whether or not the orchestrator has an item for it.
public enum BoardAssembler {
    /// - Parameter synthesizable: PR numbers this caller may turn into cards of
    ///   its own. `nil` means "anything unclaimed", which is right for a single
    ///   project. With several, every project is handed the whole PR list so its
    ///   items still enrich, but only the project that owns the repository may
    ///   invent a card — otherwise each project synthesizes the others' PRs and
    ///   every orchestrated PR appears twice, once titled from the item and once
    ///   from GitHub.
    public static func cards(
        orchestrator: OrchestratorSnapshot,
        pullRequests: [PullRequest],
        linearWorkspace: String,
        synthesizable: Set<Int>? = nil
    ) -> [Card] {
        // Every item claims its PR, including the closed and rejected ones. The
        // orchestrator hiding a PR is a decision about that PR, not an absence of
        // one, and re-adding it here would quietly overrule the operator.
        let claimed = Set(orchestrator.items.compactMap { $0.pr?.number })
        let unclaimed = pullRequests
            .filter { !claimed.contains($0.number) }
            .filter { synthesizable?.contains($0.number) ?? true }
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

    /// Every project's cards in one list, ordered by urgency across all of them.
    ///
    /// Not grouped by project on purpose. A heading per project would put a draft
    /// above a card that needs the operator, because the draft sits under an
    /// earlier heading. Urgency is the order that makes the board worth opening,
    /// and the chip carries the project instead.
    public static func cards(
        projects: [(project: ProjectRef, snapshot: OrchestratorSnapshot)],
        pullRequests: [PullRequest],
        config: BoardConfig
    ) -> [ProjectCard] {
        // A PR that any project's item claims is that item's card, everywhere.
        // Without this, a PR orchestrated by one project is "unclaimed" as far as
        // the others can see, and each of them invents a card for it.
        let claimedAnywhere = Set(
            projects.flatMap { $0.snapshot.items.compactMap { $0.pr?.number } })

        // Otherwise a PR belongs to the project that orchestrates its repository,
        // and only that project may synthesize it. A PR whose repository matches
        // no project is given to the first, so an unowned PR still gets a card
        // rather than silently going missing.
        var owner: [Int: String] = [:]
        for pr in pullRequests where !claimedAnywhere.contains(pr.number) {
            let match = projects.first { config.repoName(for: $0.project.key) == pr.repo }
            owner[pr.number] = (match ?? projects.first)?.project.key
        }

        let merged = projects.flatMap { entry in
            let mine = Set(owner.filter { $0.value == entry.project.key }.keys)
            return cards(orchestrator: entry.snapshot,
                         pullRequests: pullRequests,
                         linearWorkspace: config.linearWorkspace,
                         synthesizable: mine)
                .map {
                    ProjectCard(project: entry.project,
                                shortName: config.shortName(for: entry.project.key),
                                card: $0)
                }
        }
        // The same key CardBuilder sorts by, applied across the joined list. The
        // project key breaks a tie so two boards cannot swap places between reads.
        return merged.enumerated()
            .sorted { lhs, rhs in
                let l = (lhs.element.card.pill.tone.sortRank, -(lhs.element.card.num ?? 0),
                         lhs.element.project.key, lhs.offset)
                let r = (rhs.element.card.pill.tone.sortRank, -(rhs.element.card.num ?? 0),
                         rhs.element.project.key, rhs.offset)
                return l < r
            }
            .map(\.element)
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
