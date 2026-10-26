import BoardKit
import Foundation
import Observation

/// Holds the board and keeps it current. The app is a thin client of the CLI
/// now: a refresh spawns `board refresh` (which owns gh, the card logic and the
/// stacks), then reads the root-level cards.json it wrote and draws that. With
/// `BOARD_REPOS` set and no orchestrator involved, `board refresh --repos
/// --stdout` hands the same document over stdout instead.
@MainActor
@Observable
final class BoardStore {
    private(set) var cards: [ProjectCard] = []
    /// True once a second project appears, so the chip only shows when it means
    /// something. One project makes the same label on every card.
    private(set) var showsProjects = false
    /// The document's own generatedAt — when the board was actually polled, not
    /// when this process happened to read the file.
    private(set) var lastUpdated: Date?
    private(set) var lastError: String?
    private(set) var isRefreshing = false
    private(set) var orchestratorPresent = false
    /// The CLI's degradation annotation, null on a clean render. The board is
    /// standing on stale or partial PR data exactly when this is set.
    private(set) var note: String?
    /// False when nothing is configured to poll. An empty board and an unconfigured
    /// one look identical and mean opposite things — "you are all clear" against
    /// "nobody is watching" — so the panel is told which it is.
    private(set) var hasRepos = false
    /// The review queue as the document carries it, newest activity first.
    private(set) var reviews: [ProjectReview] = []
    /// False when the document predates the reviews lane — the tab then says the
    /// CLI needs updating rather than showing a clear queue that is not.
    private(set) var reviewsAvailable = false
    /// config's review.countsAsNeedsYou, via the document.
    private(set) var reviewsCountAsNeedsYou = false
    /// The ref currently being turned into a review workspace, for the row to
    /// show "starting…" — workspace creation takes seconds, not frames.
    private(set) var startingReview: String?
    /// Last publish's per-card signals, for the notification diff. Seeded on the
    /// first publish so nothing already-mergeable at launch fires.
    private var cardSignals: [String: CardSignal] = [:]
    private var notificationsSeeded = false
    /// Posts merge/preview banners. Injected by the app; nil in tests and in
    /// any context without a screen, where the diff still runs (and is
    /// testable) but nothing is posted.
    var notifier: ((BoardNotification) -> Void)?

    /// The panel's "not first-hand data" flag, derived from the document rather
    /// than tracked by this process — the CLI is the one that knows.
    var usingStalePullRequests: Bool { note != nil }

    var needsOperatorCount: Int { statusModel.needsOperator }

    var statusModel: StatusItemModel {
        StatusItemModel(
            cards: cards, reviews: reviews.count, reviewsCountAsNeedsYou: reviewsCountAsNeedsYou)
    }

    static let schedule = RefreshSchedule.standard
    static var interval: TimeInterval { schedule.interval }

    /// `board refresh` polls gh over however many repos are configured; 30s (the
    /// Shell default) is not enough on a slow morning.
    private static let refreshTimeout: TimeInterval = 180
    /// The render-only fast path execs nothing external beyond node itself.
    private static let renderTimeout: TimeInterval = 60
    /// How long after our own spawn a file-system event is read as our own write
    /// landing, not as an agent's. The CLI's render is what changes the watched
    /// directory, so without this window every refresh would schedule the next.
    private static let selfWriteWindow: TimeInterval = 2.0

    private let root: URL
    private let cli: URL?
    /// `BOARD_REPOS`, verbatim, when set: the github-only mode with no
    /// orchestrator root — spawn with --repos, decode stdout, write nothing.
    private let environmentRepos: String?
    /// The environment the CLI is spawned with. When the app was pointed at a
    /// directory via BOARD_ORCHESTRATOR_DIR, the CLI must resolve the same root,
    /// and SUPERSET_ORCH_ROOT is how it is told.
    private let spawnEnvironment: [String: String]
    private var consecutiveFailures = 0
    /// When the loop last tried, for the retry countdown — distinct from
    /// lastUpdated, which follows the document and stops moving on failure.
    private var lastAttempt: Date?
    private var loop: Task<Void, Never>?
    private var watcher: DirectoryWatcher?
    private var selfWroteAt: Date?

    init(
        root: URL = OrchestratorLocation.root(),
        cli: URL? = Shell.locate("board", overrideEnvironment: "BOARD_CLI_PATH")
    ) {
        self.root = root
        self.cli = cli
        let environment = ProcessInfo.processInfo.environment
        let repos = environment["BOARD_REPOS"] ?? ""
        environmentRepos = repos.isEmpty ? nil : repos
        var spawn = environment
        if let dir = environment["BOARD_ORCHESTRATOR_DIR"], !dir.isEmpty {
            spawn["SUPERSET_ORCH_ROOT"] = root.path
        }
        spawnEnvironment = spawn
        if cli == nil {
            lastError = "board CLI not found — install it from cli/ (npm install -g .), or set BOARD_CLI_PATH"
        }
    }

    // MARK: - Lifecycle

    func start() {
        // The board from a minute ago beats a blank panel: the last good document
        // is drawn immediately, while the first (possibly slow) refresh runs.
        if lastUpdated == nil { showCachedDocument() }
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
    /// Staleness is judged by the document's own generatedAt: a board that has
    /// not been re-polled is stale however recently this process read it.
    func refreshIfStale(olderThan age: TimeInterval = interval) {
        guard let lastUpdated else { return refreshNow() }
        guard Date().timeIntervalSince(lastUpdated) >= age else { return }
        consecutiveFailures = 0
        refreshNow()
    }

    private var nextDelay: TimeInterval { Self.schedule.delay(afterFailures: consecutiveFailures) }

    /// Seconds until the loop tries again, for the panel to show while it is failing.
    var retryingIn: TimeInterval? {
        guard consecutiveFailures > 0, let lastAttempt else { return nil }
        return max(0, nextDelay - Date().timeIntervalSince(lastAttempt))
    }

    // MARK: - Refreshing

    private func refresh() async {
        isRefreshing = true
        defer { isRefreshing = false }
        lastAttempt = Date()

        if let environmentRepos {
            await refreshFromRepos(environmentRepos)
            return
        }

        // The spawn and the read are separate failures on purpose: a refresh that
        // died half-way still leaves the last good document on disk, and showing
        // that board with the error in the footer beats showing neither.
        var spawnError: String?
        if let cli {
            do {
                _ = try await Shell.run(
                    cli, ["refresh"],
                    timeout: Self.refreshTimeout, environment: spawnEnvironment)
            } catch {
                spawnError = Self.tail(of: error)
            }
            selfWroteAt = Date()
        } else {
            spawnError = lastError
        }
        publishFromDisk(spawnError: spawnError)
        if orchestratorPresent, watcher == nil { startWatching() }
    }

    /// GITHUB-ONLY MODE: no orchestrator root, nothing on disk anywhere. The CLI
    /// polls the named repos in-memory and prints the document; failure keeps the
    /// cards already shown.
    private func refreshFromRepos(_ repos: String) async {
        guard let cli else {
            consecutiveFailures += 1
            return
        }
        do {
            let output = try await Shell.run(
                cli, ["refresh", "--repos", repos, "--stdout"],
                timeout: Self.refreshTimeout, environment: spawnEnvironment)
            let document = try JSONDecoder().decode(CardsDocument.self, from: output.stdout)
            publish(document, orchestrator: false)
            lastError = nil
            consecutiveFailures = 0
        } catch {
            consecutiveFailures += 1
            lastError = Self.tail(of: error)
        }
    }

    /// Reads and publishes the root document. `spawnError` is what the refresh
    /// that should have rewritten it said, if anything — kept as the footer's
    /// error even when the (older) document reads fine.
    private func publishFromDisk(spawnError: String?) {
        do {
            let data = try Data(contentsOf: root.appendingPathComponent("cards.json"))
            let document = try JSONDecoder().decode(CardsDocument.self, from: data)
            publish(document, orchestrator: true)
            lastError = spawnError
            consecutiveFailures = spawnError == nil ? 0 : consecutiveFailures + 1
        } catch {
            consecutiveFailures += 1
            lastError = spawnError ?? "cards.json unreadable — run board doctor"
        }
    }

    /// The document already on disk, published without judging anyone: a failure
    /// to read here is not a refresh failure, just nothing cached yet.
    private func showCachedDocument() {
        guard environmentRepos == nil else { return }
        guard let data = try? Data(contentsOf: root.appendingPathComponent("cards.json")),
              let document = try? JSONDecoder().decode(CardsDocument.self, from: data)
        else { return }
        publish(document, orchestrator: true)
    }

    private func publish(_ document: CardsDocument, orchestrator: Bool) {
        cards = document.cards
        notify(cards)
        reviews = document.reviews
        reviewsAvailable = document.reviewsAvailable
        reviewsCountAsNeedsYou = document.reviewsCountAsNeedsYou
        note = document.note
        showsProjects = document.projects.count > 1
        orchestratorPresent = orchestrator
        hasRepos = !document.projects.isEmpty || environmentRepos != nil
        lastUpdated = document.generatedAtDate
    }

    /// The last line the CLI said, which is where its BLOCKED/warn messages land —
    /// the footer has one line to spend.
    private static func tail(of error: Error) -> String {
        let text = "\(error)"
        let lines = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        return lines.last(where: { !$0.isEmpty }) ?? text
    }

    // MARK: - Review actions

    /// Reviews are dispatched and dismissed through the CLI so the record (the
    /// ledger, the workspace) is the CLI's whether the click came from here or
    /// from a terminal. Both verbs need the orchestrator root — the panel only
    /// offers them when `orchestratorPresent`.

    /// `board review dismiss` writes the ledger, then a render-only refresh
    /// rewrites cards.json without it. The row is removed optimistically first:
    /// the ledger write cannot un-dismiss, and waiting a render to hide a row
    /// the operator just closed reads as the click not taking.
    func dismissReview(_ review: Review) async {
        guard let cli else { return }
        reviews.removeAll { $0.review.ref == review.ref }
        do {
            _ = try await Shell.run(
                cli, ["review", "dismiss", review.ref],
                timeout: 30, environment: spawnEnvironment)
            selfWroteAt = Date()
            _ = try? await Shell.run(
                cli, ["refresh", "--render-only"],
                timeout: Self.renderTimeout, environment: spawnEnvironment)
            selfWroteAt = Date()
            publishFromDisk(spawnError: nil)
        } catch {
            lastError = Self.tail(of: error)
        }
    }

    /// `board dismiss <card id>`: takes a card off the board for good.
    ///
    /// Any card. A card the board invented for an unclaimed pull request has no
    /// item to carry a state that would hide it, and this is how those go; a
    /// card an item stands behind loses only its card — the item stays in
    /// board.json and everything that reasons about it goes on doing so.
    /// Reversible from the CLI (`board undismiss`), which is also where the
    /// ledger can be read back (`board dismiss --list`).
    func dismissCard(_ ref: String) async {
        guard let cli else { return }
        // Off the board before the CLI has answered, as a review dismissal is:
        // the operator has said what they want, and the render that follows is
        // what makes it true rather than what decides it.
        cards.removeAll { $0.card.dismissalRef == ref }
        do {
            _ = try await Shell.run(
                cli, ["dismiss", ref],
                timeout: 30, environment: spawnEnvironment)
            selfWroteAt = Date()
            _ = try? await Shell.run(
                cli, ["refresh", "--render-only"],
                timeout: Self.renderTimeout, environment: spawnEnvironment)
            selfWroteAt = Date()
            publishFromDisk(spawnError: nil)
        } catch {
            lastError = Self.tail(of: error)
        }
    }

    /// `board review start --json`: a Superset workspace on the PR's branch with
    /// a review agent in it. Returns the superset:// URL to open, nil on failure
    /// (the footer carries the CLI's one-line refusal).
    func startReview(_ review: Review) async -> String? {
        guard let cli, startingReview == nil else { return nil }
        startingReview = review.ref
        defer { startingReview = nil }
        do {
            let output = try await Shell.run(
                cli, ["review", "start", review.ref, "--json"],
                timeout: 120, environment: spawnEnvironment)
            struct Started: Decodable { let workspaceUrl: String }
            return try JSONDecoder().decode(Started.self, from: output.stdout).workspaceUrl
        } catch {
            lastError = Self.tail(of: error)
            return nil
        }
    }

    // MARK: - Notifications

    /// Fire a banner when a card becomes mergeable, or a preview deployment
    /// lands. The first publish only seeds the baseline — the operator opening
    /// the app to a board of already-mergeable PRs should not be met with a
    /// stack of banners for things that were true before they looked.
    private func notify(_ cards: [ProjectCard]) {
        guard notificationsSeeded else {
            cardSignals = BoardNotifier.snapshot(cards)
            notificationsSeeded = true
            return
        }
        let (events, snapshot) = BoardNotifier.diff(previous: cardSignals, current: cards)
        cardSignals = snapshot
        guard let notifier else { return }
        for event in events { notifier(event) }
    }

    // MARK: - The file watcher's fast path

    /// An agent wrote its status, or another process re-rendered the board:
    /// re-render from the files alone — `--render-only` polls nothing, so a
    /// read-only client can take this path as often as the directory changes —
    /// and re-read. Our own refresh also changes the directory, which is what
    /// the self-write window is for.
    private func filesChanged() async {
        if let selfWroteAt, Date().timeIntervalSince(selfWroteAt) < Self.selfWriteWindow { return }
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        if let cli {
            _ = try? await Shell.run(
                cli, ["refresh", "--render-only"],
                timeout: Self.renderTimeout, environment: spawnEnvironment)
            selfWroteAt = Date()
        }
        publishFromDisk(spawnError: nil)
    }

    private func startWatching() {
        // Nothing to watch in github-only mode — there is no directory at all.
        guard environmentRepos == nil else { return }
        // The FSEvents latency is the debounce: a burst of writes from one agent
        // arrives as a single callback.
        watcher = DirectoryWatcher(url: root) { [weak self] in
            Task { @MainActor in await self?.filesChanged() }
        }
    }
}
