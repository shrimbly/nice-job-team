import BoardKit
import Foundation
import Observation

/// Holds the board and keeps it current: GitHub on a timer, the orchestrator's
/// files whenever they change.
@MainActor
@Observable
final class BoardStore {
    private(set) var cards: [ProjectCard] = []
    /// True once a second project appears, so the chip only shows when it means
    /// something. One project makes the same label on every card.
    private(set) var showsProjects = false
    private(set) var lastUpdated: Date?
    private(set) var lastError: String?
    private(set) var isRefreshing = false
    private(set) var quotaRemaining: Int?
    private(set) var orchestratorPresent = false
    /// True while the board is GitHub's alone, so the panel can say so.
    private(set) var usingStalePullRequests = false

    var needsOperatorCount: Int { cards.count { $0.card.pill.tone.needsOperator } }

    static let schedule = RefreshSchedule.standard
    static var interval: TimeInterval { schedule.interval }

    private let reader: OrchestratorReader
    private let github: GitHubClient?
    private var config: BoardConfig
    private var pullRequests: [PullRequest] = []
    private var consecutiveFailures = 0
    private var loop: Task<Void, Never>?
    private var watcher: DirectoryWatcher?

    init(reader: OrchestratorReader = OrchestratorReader(), github: GitHubClient? = GitHubClient.locate()) {
        self.reader = reader
        self.github = github
        self.config = BoardConfig.load(from: reader.root)
        if github == nil {
            lastError = "gh not found — install the GitHub CLI, or set BOARD_GH_PATH"
        }
    }

    // MARK: - Lifecycle

    func start() {
        if watcher == nil { startWatching() }
        loop?.cancel()
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                guard let delay = self?.nextDelay else { return }
                try? await Task.sleep(for: .seconds(delay))
            }
        }
    }

    func stop() {
        loop?.cancel()
        loop = nil
        watcher = nil
    }

    /// Restarting the loop rather than firing a one-off keeps the next automatic
    /// refresh a full interval away from this one.
    func refreshNow() {
        guard !isRefreshing else { return }
        start()
    }

    /// A laptop that has been shut all night wakes holding an eight-hour-old board,
    /// and the network is not up yet, so the first refresh after waking tends to
    /// fail and send the loop into a long backoff exactly when the operator is
    /// looking at it. Clear that and start again from scratch.
    func wakeFromSleep() {
        consecutiveFailures = 0
        refreshNow()
    }

    /// Opening the panel is the strongest signal the operator wants current data.
    func refreshIfStale(olderThan age: TimeInterval = interval) {
        guard let lastUpdated else { return refreshNow() }
        guard Date().timeIntervalSince(lastUpdated) >= age else { return }
        consecutiveFailures = 0
        refreshNow()
    }

    private var nextDelay: TimeInterval { Self.schedule.delay(afterFailures: consecutiveFailures) }

    /// Seconds until the loop tries again, for the panel to show while it is failing.
    var retryingIn: TimeInterval? {
        guard consecutiveFailures > 0, let lastUpdated else { return nil }
        return max(0, nextDelay - Date().timeIntervalSince(lastUpdated))
    }

    // MARK: - Refreshing

    private func refresh() async {
        isRefreshing = true
        defer { isRefreshing = false }

        let reader = self.reader
        let projects = await Task.detached {
            reader.projects.map { (project: $0, snapshot: reader.read($0)) }
        }.value
        orchestratorPresent = reader.directoryExists && !projects.isEmpty
        showsProjects = projects.count > 1
        if orchestratorPresent {
            config = BoardConfig.load(from: reader.root)
            if watcher == nil { startWatching() }
        }

        if let github {
            do {
                let fetch = try await github.fetch(repos: config.repos)
                pullRequests = fetch.pullRequests
                quotaRemaining = fetch.quotaRemaining
                usingStalePullRequests = false
                lastError = nil
                consecutiveFailures = 0
            } catch {
                consecutiveFailures += 1
                lastError = "\(error)"
                // The orchestrator's last poll is better than an empty board, and
                // says plainly that it is not first-hand.
                if let fallback = lastPolledPullRequests(), !fallback.isEmpty {
                    pullRequests = fallback
                    usingStalePullRequests = true
                }
            }
        }

        // With no orchestrator on disk the app still has a job: every open PR gets
        // a card. One absent project keeps that path identical to the old one.
        let sources = projects.isEmpty
            ? [(project: ProjectRef(key: "", root: reader.root), snapshot: OrchestratorSnapshot.absent)]
            : projects
        cards = BoardAssembler.cards(
            projects: sources, pullRequests: pullRequests, config: config)
        lastUpdated = Date()
    }

    /// Rebuilds from the files alone — no GitHub call, because nothing on GitHub
    /// changed just because an agent wrote its status.
    private func reloadOrchestratorOnly() async {
        guard !isRefreshing else { return }
        let reader = self.reader
        let projects = await Task.detached {
            reader.projects.map { (project: $0, snapshot: reader.read($0)) }
        }.value
        orchestratorPresent = reader.directoryExists && !projects.isEmpty
        showsProjects = projects.count > 1
        guard !projects.isEmpty else { return }
        cards = BoardAssembler.cards(
            projects: projects, pullRequests: pullRequests, config: config)
    }

    /// Every project's last poll, joined. The signals live in `p/<key>/`, so this
    /// reads nothing at the root — and the fallback that keeps a GitHub outage
    /// from quietly emptying the board would stop working.
    private func lastPolledPullRequests() -> [PullRequest]? {
        var all: [PullRequest] = []
        var seen = Set<Int>()
        for project in reader.projects {
            let url = project.root.appendingPathComponent("signals/github.json")
            guard let data = try? Data(contentsOf: url),
                  let prs = try? GitHubDecoder.pullRequests(fromSignals: data) else { continue }
            for pr in prs where seen.insert(pr.number).inserted { all.append(pr) }
        }
        return all.isEmpty ? nil : all
    }

    private func startWatching() {
        watcher = DirectoryWatcher(url: reader.root) { [weak self] in
            Task { @MainActor in await self?.reloadOrchestratorOnly() }
        }
    }
}
