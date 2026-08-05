import Foundation

// The orchestrator's own files. Everything is optional: the app has to render a
// board when these are stale, half-written, or missing altogether.

/// One entry in `board.json`'s `items`.
public struct BoardItem: Sendable, Decodable {
    public struct Source: Sendable, Decodable {
        public var kind: String?
        public var externalId: String?
    }

    /// The orchestrator's last-known PR facts. GitHub wins over these when both
    /// have an answer, but they are the only source once a PR leaves `--state open`.
    public struct PRRef: Sendable, Decodable {
        public var number: Int?
        public var url: String?
        public var reviewDecision: String?
        public var ciState: String?
        public var isDraft: Bool?
        public var mergeStateStatus: String?
    }

    public var id: String
    public var title: String
    public var state: String
    public var branch: String?
    public var workspaceId: String?
    public var outcome: String?
    public var source: Source?
    public var pr: PRRef?

    /// render-board.sh keeps merged items visible until the reaper takes them.
    public var isVisible: Bool { state != "closed" && state != "rejected" }

    public init(
        id: String, title: String, state: String, branch: String? = nil,
        workspaceId: String? = nil, outcome: String? = nil,
        source: Source? = nil, pr: PRRef? = nil
    ) {
        self.id = id
        self.title = title
        self.state = state
        self.branch = branch
        self.workspaceId = workspaceId
        self.outcome = outcome
        self.source = source
        self.pr = pr
    }
}

/// One agent's own status file, `workspaces/<id>.json`.
public struct AgentStatus: Sendable, Decodable {
    public var workspaceId: String
    public var state: String?
    public var phase: String?
    public var summary: String?
    public var needsOperator: Bool?
    // Added by poll.sh into signals/workspaces.json, never by the agent itself.
    public var sessionLiveness: String?
    public var dirtyFiles: String?
    public var unpushedCommits: String?

    public init(
        workspaceId: String, state: String? = nil, phase: String? = nil,
        summary: String? = nil, needsOperator: Bool? = nil,
        sessionLiveness: String? = nil, dirtyFiles: String? = nil,
        unpushedCommits: String? = nil
    ) {
        self.workspaceId = workspaceId
        self.state = state
        self.phase = phase
        self.summary = summary
        self.needsOperator = needsOperator
        self.sessionLiveness = sessionLiveness
        self.dirtyFiles = dirtyFiles
        self.unpushedCommits = unpushedCommits
    }
}

/// A live Superset workspace, from `signals/workspaces.json`. Only the name is used
/// — it is what the operator navigates by.
public struct WorkspaceRef: Sendable, Decodable {
    public var id: String
    public var name: String?

    public init(id: String, name: String?) {
        self.id = id
        self.name = name
    }
}

/// Everything the orchestrator contributes. All of it is enrichment: an empty
/// snapshot still produces a board, built from GitHub alone.
public struct OrchestratorSnapshot: Sendable {
    public var items: [BoardItem]
    public var agents: [AgentStatus]
    public var workspaces: [WorkspaceRef]
    /// PRs poll.sh has seen land. `gh pr list --state open` cannot report these, and
    /// an item's own state only says "merged" once the orchestrator gets to it, so
    /// this is the earliest the board can know a PR is done with.
    public var mergedPRNumbers: Set<Int>
    /// False when the orchestrator directory is not on disk at all.
    public var isPresent: Bool

    public static let absent = OrchestratorSnapshot(
        items: [], agents: [], workspaces: [], mergedPRNumbers: [], isPresent: false)

    public init(
        items: [BoardItem], agents: [AgentStatus], workspaces: [WorkspaceRef],
        mergedPRNumbers: Set<Int> = [], isPresent: Bool
    ) {
        self.items = items
        self.agents = agents
        self.workspaces = workspaces
        self.mergedPRNumbers = mergedPRNumbers
        self.isPresent = isPresent
    }
}

/// Reads the orchestrator's directory. Read-only by construction — this app never
/// writes to the orchestrator's state.
public struct OrchestratorReader: Sendable {
    public let root: URL

    /// Overridable so the app can be pointed at a copy of the orchestrator's files
    /// — the app only ever reads them, but a second board should not have to share
    /// the first one's directory to be looked at.
    public static var defaultRoot: URL {
        if let override = ProcessInfo.processInfo.environment["BOARD_ORCHESTRATOR_DIR"],
           !override.isEmpty {
            return URL(fileURLWithPath: (override as NSString).expandingTildeInPath)
        }
        return URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".claude/superset-orchestrator")
    }

    /// Where this project's board lives.
    ///
    /// The orchestrator moved per-project state into `p/<key>/` so that several
    /// projects can run side by side. `workspaces/` stayed at the root, because it
    /// is the agent status inbox and its key is a globally unique workspace id.
    /// So the reader needs both: this for the board and the signals, `root` for
    /// the inbox.
    ///
    /// Order: an explicit key, then a board at the root (the old single-project
    /// layout, still valid), then the only project under `p/`, then the most
    /// recently written one.
    public var projectRoot: URL {
        let fm = FileManager.default
        let projects = root.appendingPathComponent("p")

        if let key = ProcessInfo.processInfo.environment["BOARD_ORCHESTRATOR_PROJECT"],
           !key.isEmpty {
            return projects.appendingPathComponent(key)
        }
        if fm.fileExists(atPath: root.appendingPathComponent("board.json").path) {
            return root
        }
        guard let keys = try? fm.contentsOfDirectory(atPath: projects.path),
              !keys.isEmpty else { return root }
        if keys.count == 1 { return projects.appendingPathComponent(keys[0]) }

        let newest = keys
            .map { projects.appendingPathComponent($0) }
            .max { a, b in
                let da = (try? fm.attributesOfItem(atPath: a.appendingPathComponent("board.json").path)[.modificationDate] as? Date) ?? nil
                let db = (try? fm.attributesOfItem(atPath: b.appendingPathComponent("board.json").path)[.modificationDate] as? Date) ?? nil
                return (da ?? .distantPast) < (db ?? .distantPast)
            }
        return newest ?? root
    }

    public init(root: URL = OrchestratorReader.defaultRoot) {
        self.root = root
    }

    public var directoryExists: Bool {
        var isDir: ObjCBool = false
        let ok = FileManager.default.fileExists(atPath: root.path, isDirectory: &isDir)
        return ok && isDir.boolValue
    }

    public func read() -> OrchestratorSnapshot {
        guard directoryExists else { return .absent }

        let board = decode(BoardItemsFile.self, from: projectRoot.appendingPathComponent("board.json"))
        let workspaces = decode(WorkspacesSignal.self, from: projectRoot.appendingPathComponent("signals/workspaces.json"))

        // The agent's own file is the source of truth for state/phase/summary; the
        // signal file adds liveness and dirt that only poll.sh can see. Merge rather
        // than choose, so the app degrades to the raw files when poll.sh is stale.
        var agents = readAgentStatusFiles()
        let enrichment = Dictionary(
            (workspaces?.agentStatus ?? []).map { ($0.workspaceId, $0) },
            uniquingKeysWith: { _, last in last })
        for index in agents.indices {
            guard let extra = enrichment[agents[index].workspaceId] else { continue }
            agents[index].sessionLiveness = extra.sessionLiveness
            agents[index].dirtyFiles = extra.dirtyFiles
            agents[index].unpushedCommits = extra.unpushedCommits
        }

        return OrchestratorSnapshot(
            items: board?.items ?? [],
            agents: agents,
            workspaces: workspaces?.workspaces ?? [],
            mergedPRNumbers: readMergedPRNumbers(),
            isPresent: true)
    }

    /// poll.sh collects `--state merged` alongside the open PRs and nothing has
    /// ever read it. It is the cheapest way to know a PR landed: already on disk,
    /// no GitHub call of our own.
    private func readMergedPRNumbers() -> Set<Int> {
        let url = projectRoot.appendingPathComponent("signals/github.json")
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? GitHubDecoder.mergedNumbers(fromSignals: data)) ?? []
    }

    private func readAgentStatusFiles() -> [AgentStatus] {
        let dir = root.appendingPathComponent("workspaces")
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else {
            return []
        }
        // Sorted so a duplicate workspaceId resolves the same way on every read.
        return names.filter { $0.hasSuffix(".json") }.sorted().compactMap {
            decode(AgentStatus.self, from: dir.appendingPathComponent($0))
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, from url: URL) -> T? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    private struct BoardItemsFile: Decodable {
        var items: [BoardItem]?
    }

    private struct WorkspacesSignal: Decodable {
        var workspaces: [WorkspaceRef]?
        var agentStatus: [AgentStatus]?
    }
}
