import Foundation
import Testing
@testable import BoardKit

/// GitHub is the required half of the board; the orchestrator's files are
/// enrichment. These pin what happens as that enrichment comes and goes.
struct AssemblerTests {

    private let prs = [
        PullRequest(number: 10, title: "ten", headRefName: "feat/ten", url: "https://gh/10",
                    reviewDecision: "APPROVED", mergeStateStatus: "CLEAN",
                    repo: "o/r", ciState: "green"),
        PullRequest(number: 11, title: "eleven", headRefName: "feat/eleven", url: "https://gh/11",
                    isDraft: true, repo: "o/r", ciState: "green"),
    ]

    @Test("with no orchestrator at all, every open PR still gets a card")
    func githubOnly() {
        let cards = BoardAssembler.cards(
            orchestrator: .absent, pullRequests: prs, linearWorkspace: "acme")

        #expect(cards.count == 2)
        #expect(cards.map(\.pill.label) == ["Mergeable", "Draft"])
        #expect(cards.first?.title == "ten")
        #expect(cards.first?.prUrl == "https://gh/10")
        #expect(cards.first?.branch == "feat/ten")
        // Nothing to link to but GitHub.
        #expect(cards.allSatisfy { $0.workspaceUrl == nil && $0.ticketUrl == nil })
    }

    @Test("a PR the orchestrator already tracks is not duplicated")
    func noDuplicates() {
        let snapshot = OrchestratorSnapshot(
            items: [BoardItem(id: "itm_10", title: "tracked", state: "pr-open",
                              pr: .init(number: 10))],
            agents: [], workspaces: [], isPresent: true)

        let cards = BoardAssembler.cards(
            orchestrator: snapshot, pullRequests: prs, linearWorkspace: "acme")

        #expect(cards.count == 2)
        #expect(cards.contains { $0.id == "itm_10" && $0.title == "tracked" })
        #expect(cards.filter { $0.num == 10 }.count == 1)
    }

    @Test("a PR the orchestrator has closed or rejected stays hidden")
    func rejectedStaysHidden() {
        // The orchestrator hiding a PR is a decision about that PR; resurrecting it
        // as a GitHub-only card would quietly overrule the operator.
        for state in ["closed", "rejected"] {
            let snapshot = OrchestratorSnapshot(
                items: [BoardItem(id: "itm_11", title: "rejected", state: state,
                                  pr: .init(number: 11))],
                agents: [], workspaces: [], isPresent: true)

            let cards = BoardAssembler.cards(
                orchestrator: snapshot, pullRequests: prs, linearWorkspace: "acme")

            #expect(cards.count == 1, "\(state) should leave only PR 10")
            #expect(cards.first?.num == 10)
        }
    }

    // MARK: - Landed PRs leave the board

    @Test("a PR poll.sh has seen merged is off the board, before the item catches up")
    func hiddenOnceMergedEvenWhileItemSaysOpen() {
        // The real case: board.json still said state=pr-open for two PRs that had
        // already landed, so they sat there as "PR Gone".
        let snapshot = OrchestratorSnapshot(
            items: [BoardItem(id: "itm_10", title: "landed", state: "pr-open",
                              pr: .init(number: 10)),
                    BoardItem(id: "itm_11", title: "still open", state: "pr-open",
                              pr: .init(number: 11))],
            agents: [], workspaces: [], mergedPRNumbers: [10], isPresent: true)

        let cards = BoardAssembler.cards(
            orchestrator: snapshot, pullRequests: prs, linearWorkspace: "acme")

        #expect(cards.map(\.id) == ["itm_11"])
    }

    @Test("it stays hidden once the orchestrator moves the item to merged")
    func staysHiddenAfterItemCatchesUp() {
        // Hiding on only one of the two signals makes a landed PR vanish and then
        // reappear as "Merged — reap" when the orchestrator gets round to it.
        for merged in [Set<Int>(), Set([10])] {
            let snapshot = OrchestratorSnapshot(
                items: [BoardItem(id: "itm_10", title: "landed", state: "merged",
                                  workspaceId: "ws-1", pr: .init(number: 10))],
                agents: [], workspaces: [], mergedPRNumbers: merged, isPresent: true)

            let cards = BoardAssembler.cards(
                orchestrator: snapshot, pullRequests: [], linearWorkspace: "acme")

            #expect(cards.isEmpty, "merged item with poll.sh reporting \(merged)")
        }
    }

    @Test("an unmerged PR that left the open list is still shown")
    func closedButNotMergedStillShows() {
        // Closed without merging is worth seeing — it is not the same as landing.
        let snapshot = OrchestratorSnapshot(
            items: [BoardItem(id: "itm_99", title: "closed unmerged", state: "pr-open",
                              pr: .init(number: 99))],
            agents: [], workspaces: [], mergedPRNumbers: [10], isPresent: true)

        let cards = BoardAssembler.cards(
            orchestrator: snapshot, pullRequests: [], linearWorkspace: "acme")

        #expect(cards.map(\.pill.label) == ["PR Gone"])
    }

    @Test("poll.sh's merged list decodes, and a missing one is not an error")
    func decodesMergedNumbers() throws {
        let numbers = try GitHubDecoder.mergedNumbers(
            fromSignals: try Fixtures.data("github.json"))
        #expect(numbers.isEmpty == false)

        #expect(try GitHubDecoder.mergedNumbers(fromSignals: Data("{}".utf8)).isEmpty)
        #expect(try GitHubDecoder.mergedNumbers(
            fromSignals: Data(#"{"repos":[{"repo":"o/r","open":[]}]}"#.utf8)).isEmpty)
    }

    @Test("agent status and workspace names enrich the card the item owns")
    func enrichment() {
        let snapshot = OrchestratorSnapshot(
            // The item and the agent agree, so this stays a test about enrichment —
            // see `stalePhaseIsLabelled` for what happens when they do not.
            items: [BoardItem(id: "itm_10", title: "tracked", state: "building",
                              workspaceId: "ws-1", outcome: "the outcome",
                              source: .init(kind: "linear", externalId: "ENG-1"),
                              pr: .init(number: 10))],
            agents: [AgentStatus(workspaceId: "ws-1", state: "building",
                                 phase: "writing it", sessionLiveness: "active",
                                 dirtyFiles: "3")],
            workspaces: [WorkspaceRef(id: "ws-1", name: "the workspace")],
            isPresent: true)

        let card = BoardAssembler.cards(
            orchestrator: snapshot, pullRequests: prs, linearWorkspace: "acme").first { $0.num == 10 }

        #expect(card?.pill == Pill(label: "Working", tone: .agent))
        #expect(card?.workspace == "the workspace")
        #expect(card?.workspaceUrl == "superset://v2-workspace/ws-1")
        #expect(card?.ticketUrl == "https://linear.app/acme/issue/ENG-1")
        #expect(card?.whatItIs == "the outcome")
        #expect(card?.whereItsAt == "writing it")
        #expect(card?.liveness == "active")
        #expect(card?.dirty == "3")
    }

    @Test("a phase left behind by the item's own state is labelled, not read as live")
    func stalePhaseIsLabelled() {
        // An agent writes "fixing" when it starts and routinely never writes again.
        // sync.sh reconciles the item against the live PR, so when the two disagree
        // it is the status file that is behind — and its phase is describing work
        // that has already finished.
        let snapshot = OrchestratorSnapshot(
            items: [BoardItem(id: "itm_10", title: "tracked", state: "pr-open",
                              workspaceId: "ws-1", pr: .init(number: 10))],
            agents: [AgentStatus(workspaceId: "ws-1", state: "fixing",
                                 phase: "rebasing onto main")],
            workspaces: [], isPresent: true)

        let card = BoardAssembler.cards(
            orchestrator: snapshot, pullRequests: prs, linearWorkspace: "acme").first { $0.num == 10 }

        #expect(card?.whereItsAt == "last agent update: rebasing onto main")
        // And the pill comes from the reconciled item, so the finished rebase does
        // not hold the card at "Fixing".
        #expect(card?.pill == Pill(label: "Mergeable", tone: .good))
    }

    @Test("the linear workspace comes from the orchestrator's config when it is there")
    func configuredLinearWorkspace() {
        #expect(BoardConfig.fallback.linearWorkspace == "acme")
        #expect(BoardConfig.fallback.repos == ["acme/platform"])
        // A missing config is not an error; it is the fallback.
        #expect(BoardConfig.load(from: URL(fileURLWithPath: "/nonexistent")) == .fallback)
    }

    @Test("a missing orchestrator directory reads as absent rather than throwing")
    func absentDirectory() {
        let reader = OrchestratorReader(root: URL(fileURLWithPath: "/nonexistent/superset"))
        #expect(reader.directoryExists == false)
        let snapshot = reader.read()
        #expect(snapshot.isPresent == false)
        #expect(snapshot.items.isEmpty)
    }

    @Test("cards encode every field, writing absent optionals as explicit nulls")
    func encodesExplicitNulls() throws {
        let cards = BoardAssembler.cards(
            orchestrator: .absent, pullRequests: prs, linearWorkspace: "acme")
        let objects = try Fixtures.encodeToJSONObjects(cards)

        // Matching jq's shape is what lets --dump-cards diff against the dashboard.
        #expect(objects.first?.count == 27)
        #expect(objects.first?["workspaceUrl"] is NSNull)
        #expect(objects.first?["ticketKey"] is NSNull)
    }
}

/// The backoff shape is what left an overnight-stale board on screen: the first
/// refresh after waking failed on a network that had not come back, and the loop
/// went straight to minutes.
struct RefreshScheduleTests {
    private let schedule = RefreshSchedule.standard

    @Test("a healthy loop polls on the interval")
    func healthy() {
        #expect(schedule.delay(afterFailures: 0) == 60)
    }

    @Test("the first failure is retried quickly, not backed off to minutes")
    func firstFailureRetriesFast() {
        #expect(schedule.delay(afterFailures: 1) == 15)
        #expect(schedule.delay(afterFailures: 1) < schedule.interval)
    }

    @Test("a run of failures backs off, and stops at the cap")
    func backsOffAndCaps() {
        #expect(schedule.delay(afterFailures: 2) == 30)
        #expect(schedule.delay(afterFailures: 3) == 60)
        #expect(schedule.delay(afterFailures: 4) == 120)
        #expect(schedule.delay(afterFailures: 5) == 240)
        #expect(schedule.delay(afterFailures: 6) == 480)
        #expect(schedule.delay(afterFailures: 7) == 600)
        // However long it has been failing, it never stops trying.
        for failures in 8...200 {
            #expect(schedule.delay(afterFailures: failures) == 600)
        }
    }

    @Test("delays only ever grow")
    func monotonic() {
        let delays = (1...12).map { schedule.delay(afterFailures: $0) }
        #expect(delays == delays.sorted())
    }
}
