import Foundation

/// One folded-in PR from a card's `stack`, exactly as cards.json carries it: what
/// a chip or a hover needs and nothing more. The CLI deliberately strips the
/// per-poll noise (thread counts, activity timestamps) before writing, so this is
/// the whole row, not a summary of one.
public struct StackRow: Sendable, Equatable, Decodable {
    public let number: Int
    public let title: String
    public let url: String?
    public let previewUrl: String?
    public let isDraft: Bool

    private enum CodingKeys: String, CodingKey {
        case number, title, url, previewUrl, isDraft
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        number = try container.decode(Int.self, forKey: .number)
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? ""
        url = try container.decodeIfPresent(String.self, forKey: .url)
        previewUrl = try container.decodeIfPresent(String.self, forKey: .previewUrl)
        // The CLI writes `false` rather than null, but a consumer must not invent
        // a requirement the producer never promised.
        isDraft = try container.decodeIfPresent(Bool.self, forKey: .isDraft) ?? false
    }

    public init(
        number: Int, title: String = "", url: String? = nil,
        previewUrl: String? = nil, isDraft: Bool = false
    ) {
        self.number = number
        self.title = title
        self.url = url
        self.previewUrl = previewUrl
        self.isDraft = isDraft
    }
}

/// The cards.json v2 document the CLI writes — `$SUPERSET_ORCH_ROOT/cards.json`,
/// each project directory's `cards.json`, and `board refresh --repos --stdout`
/// all share this one shape. The app is a reader of this file and of nothing
/// else: card logic, GitHub calls and stack folding all live in the CLI now.
public struct CardsDocument: Sendable, Decodable {
    public let version: Int
    /// lib.sh's now() shape: ISO seconds UTC, no millis.
    public let generatedAt: String
    /// The CLI's degradation annotation ("gh pr list for o/r failed") — null on a
    /// clean render. Present from day one, so it is decoded rather than guessed.
    public let note: String?
    /// Whether pending reviews join the menu-bar alert the way Needs-you cards
    /// do — config's review.countsAsNeedsYou, carried in the document so the app
    /// never reads config. Absent (an older CLI) means no.
    public let reviewsCountAsNeedsYou: Bool
    public let projects: [Project]

    private enum CodingKeys: String, CodingKey {
        case version, generatedAt, note, reviewsCountAsNeedsYou, projects
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(Int.self, forKey: .version)
        generatedAt = try container.decode(String.self, forKey: .generatedAt)
        note = try container.decodeIfPresent(String.self, forKey: .note)
        reviewsCountAsNeedsYou =
            try container.decodeIfPresent(Bool.self, forKey: .reviewsCountAsNeedsYou) ?? false
        projects = try container.decode([Project].self, forKey: .projects)
    }

    /// One project's block. A project with no cards still appears — "this board
    /// is empty" and "this board is not in the file" must not read the same.
    public struct Project: Sendable, Decodable {
        public let key: String
        public let shortName: String
        public let trackerKind: String
        public let cards: [Entry]
        /// The PRs awaiting the operator's review under this project's repo.
        /// Nil when the document predates the reviews lane — "queue is clear"
        /// and "this CLI does not report reviews" must not read the same.
        public let reviews: [Review]?

        private enum CodingKeys: String, CodingKey {
            case key, shortName, trackerKind, cards, reviews
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            key = try container.decode(String.self, forKey: .key)
            shortName = try container.decode(String.self, forKey: .shortName)
            trackerKind = try container.decode(String.self, forKey: .trackerKind)
            cards = try container.decode([Entry].self, forKey: .cards)
            reviews = try container.decodeIfPresent([Review].self, forKey: .reviews)
        }

        public init(
            key: String, shortName: String, trackerKind: String, cards: [Entry],
            reviews: [Review]? = nil
        ) {
            self.key = key
            self.shortName = shortName
            self.trackerKind = trackerKind
            self.cards = cards
            self.reviews = reviews
        }
    }

    /// One card entry: the 27-key Card flat in the object, plus the three things
    /// only the assembly knows — host, prTitle, and the folded stack.
    public struct Entry: Sendable, Decodable {
        public let card: Card
        public let host: String
        public let prTitle: String?
        public let stack: [StackRow]

        private enum CodingKeys: String, CodingKey {
            case host, prTitle, stack
        }

        public init(from decoder: Decoder) throws {
            // The card's keys sit beside host/prTitle/stack in the same object,
            // so the Card decodes from the same container.
            card = try Card(from: decoder)
            let container = try decoder.container(keyedBy: CodingKeys.self)
            host = try container.decodeIfPresent(String.self, forKey: .host) ?? "local"
            prTitle = try container.decodeIfPresent(String.self, forKey: .prTitle)
            stack = try container.decodeIfPresent([StackRow].self, forKey: .stack) ?? []
        }

        public init(card: Card, host: String = "local", prTitle: String? = nil, stack: [StackRow] = []) {
            self.card = card
            self.host = host
            self.prTitle = prTitle
            self.stack = stack
        }
    }

    public init(
        version: Int, generatedAt: String, note: String?, projects: [Project],
        reviewsCountAsNeedsYou: Bool = false
    ) {
        self.version = version
        self.generatedAt = generatedAt
        self.note = note
        self.reviewsCountAsNeedsYou = reviewsCountAsNeedsYou
        self.projects = projects
    }

    /// `generatedAt` as a Date, for "polled Xm ago". Nil when the stamp does not
    /// parse — the footer then says "never" rather than lying with the read time.
    public var generatedAtDate: Date? {
        try? Date(generatedAt, strategy: .iso8601)
    }

    /// The board as the panel draws it: every project's cards in one list,
    /// ordered by urgency across all of them.
    ///
    /// The file groups cards by project; the assembler ordered them globally by
    /// (tone rank, PR number descending, project key, stability). Each project's
    /// block preserves the global relative order of its own cards, and the first
    /// three keys tie only within one project, so re-sorting the concatenation by
    /// the same key reproduces the assembled order exactly — the app re-derives
    /// the order rather than inventing one of its own.
    public var cards: [ProjectCard] {
        var flat: [(card: ProjectCard, index: Int)] = []
        for project in projects {
            for (index, entry) in project.cards.enumerated() {
                flat.append((
                    ProjectCard(
                        projectKey: project.key,
                        shortName: project.shortName,
                        card: entry.card,
                        stack: entry.stack,
                        trackerKind: project.trackerKind,
                        host: entry.host,
                        prTitle: entry.prTitle),
                    index))
            }
        }
        return flat.sorted { lhs, rhs in
            let l = (lhs.card.card.pill.tone.sortRank, -(lhs.card.card.num ?? 0),
                     lhs.card.projectKey, lhs.index)
            let r = (rhs.card.card.pill.tone.sortRank, -(rhs.card.card.num ?? 0),
                     rhs.card.projectKey, rhs.index)
            return l < r
        }
        .map(\.card)
    }

    /// True once any project block carries the reviews key at all — the document
    /// was written by a CLI that knows the lane exists.
    public var reviewsAvailable: Bool {
        projects.contains { $0.reviews != nil }
    }

    /// The review queue as the panel draws it: every project's rows in one list,
    /// newest activity first. The CLI writes each project's block already sorted;
    /// re-sorting the concatenation by the same key keeps the cross-project order
    /// out of the app's hands, the way `cards` does.
    public var reviews: [ProjectReview] {
        projects.flatMap { project in
            (project.reviews ?? []).map {
                ProjectReview(projectKey: project.key, shortName: project.shortName, review: $0)
            }
        }
        .sorted { ($0.review.updatedAt ?? "") > ($1.review.updatedAt ?? "") }
    }
}

/// Where the orchestrator's root — and so the root-level cards.json — lives.
///
/// `BOARD_ORCHESTRATOR_DIR` is the app's own override, kept for a look at a copy
/// of another board. `SUPERSET_ORCH_ROOT` is the CLI's, honoured so the app and
/// the `board refresh` it spawns resolve the same directory from the same
/// environment. Below both, the machine config's `stateDir` may relocate the
/// root — the CLI's loadRoot reads it, and an app launched from Finder has no
/// exported env at all, so without this step a relocated stateDir left the app
/// reading (and FS-watching) the old default while every `board refresh` it
/// spawned wrote the real one: a board frozen on the last pre-move document.
/// The default is the CLI's default.
public enum OrchestratorLocation {
    public static func root(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> URL {
        for name in ["BOARD_ORCHESTRATOR_DIR", "SUPERSET_ORCH_ROOT"] {
            if let override = environment[name], !override.isEmpty {
                return URL(fileURLWithPath: (override as NSString).expandingTildeInPath)
            }
        }
        if let stateDir = machineStateDir(environment: environment) {
            return URL(fileURLWithPath: (stateDir as NSString).expandingTildeInPath)
        }
        return URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".claude/superset-orchestrator")
    }

    /// The machine config's `stateDir` — read exactly the way the CLI's loadRoot
    /// reads it: `$XDG_CONFIG_HOME/superset-board/config.json` (`~/.config` when
    /// XDG is unset), tolerantly — a missing, unreadable or non-object file, or
    /// a stateDir that is not a non-empty string, all mean "no relocation".
    static func machineStateDir(environment: [String: String]) -> String? {
        let base: URL
        if let xdg = environment["XDG_CONFIG_HOME"], !xdg.isEmpty {
            base = URL(fileURLWithPath: (xdg as NSString).expandingTildeInPath)
        } else {
            base = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".config")
        }
        let file = base.appendingPathComponent("superset-board/config.json")
        guard let data = try? Data(contentsOf: file),
              let parsed = try? JSONSerialization.jsonObject(with: data),
              let object = parsed as? [String: Any],
              let stateDir = object["stateDir"] as? String,
              !stateDir.isEmpty
        else { return nil }
        return stateDir
    }
}
