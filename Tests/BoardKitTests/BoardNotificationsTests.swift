import Foundation
import Testing
@testable import BoardKit

/// The rules behind the app's merge/preview notifications: they fire on the
/// edge (the poll a PR first becomes mergeable, or a preview deployment lands),
/// never every poll it stays that way, and never for what was already true when
/// the app first looked.
struct BoardNotificationsTests {

    private func card(
        id: String, label: String = "Working", tone: Tone = .agent,
        preview: String? = nil, pending: Bool = false,
        prUrl: String? = "https://gh/pr", shortName: String = "P",
        prTitle: String? = nil, title: String = "the change"
    ) -> ProjectCard {
        ProjectCard(
            projectKey: "p", shortName: shortName,
            card: Card(
                id: id, num: 1, title: title, branch: "", workspace: nil,
                workspaceId: nil, workspaceUrl: nil, boardState: "pr-open",
                prUrl: prUrl, ticketKey: nil, ticketUrl: nil, previewUrl: preview,
                review: nil, ci: "green", threads: 0, draft: false,
                mergeState: nil, needsOperator: false, agentState: nil,
                agentPhase: nil, agentSummary: nil, liveness: nil, dirty: nil,
                unpushed: nil, whatItIs: "w",
                pill: Pill(label: label, tone: tone == .agent && label == "Mergeable" ? .good : tone),
                whereItsAt: nil, previewPending: pending),
            prTitle: prTitle)
    }

    @Test("both mergeable labels count, nothing else does")
    func mergeableClassification() {
        #expect(BoardNotifier.isMergeable(card(id: "a", label: "★ Ready to merge").card))
        #expect(BoardNotifier.isMergeable(card(id: "b", label: "Mergeable").card))
        #expect(!BoardNotifier.isMergeable(card(id: "c", label: "Working").card))
        #expect(!BoardNotifier.isMergeable(card(id: "d", label: "Merged — reap").card))
    }

    @Test("an empty or nil preview URL is not a preview")
    func previewClassification() {
        let seed = BoardNotifier.snapshot([card(id: "a", preview: nil), card(id: "b", preview: "")])
        #expect(seed["a"]?.preview == nil)
        #expect(seed["b"]?.preview == nil)
        let live = BoardNotifier.snapshot([card(id: "c", preview: "https://x")])["c"]?.preview
        #expect(live == PreviewSignal(url: "https://x", pending: false))
        #expect(live?.isLive == true)
    }

    @Test("a card becoming mergeable fires once, with the PR url")
    func mergeableEdge() {
        let before = BoardNotifier.snapshot([card(id: "a", label: "Working")])
        let (events, after) = BoardNotifier.diff(
            previous: before, current: [card(id: "a", label: "★ Ready to merge", prUrl: "https://gh/pr/1")])
        #expect(events.count == 1)
        #expect(events[0].kind == .mergeable)
        #expect(events[0].url == "https://gh/pr/1")

        // Staying mergeable the next poll fires nothing.
        let (again, _) = BoardNotifier.diff(
            previous: after, current: [card(id: "a", label: "★ Ready to merge")])
        #expect(again.isEmpty)
    }

    @Test("a preview landing fires once, with the preview url")
    func previewEdge() {
        let before = BoardNotifier.snapshot([card(id: "a", preview: nil)])
        let (events, after) = BoardNotifier.diff(
            previous: before, current: [card(id: "a", preview: "https://preview.app")])
        #expect(events.count == 1)
        #expect(events[0].kind == .preview)
        #expect(events[0].url == "https://preview.app")

        let (again, _) = BoardNotifier.diff(
            previous: after, current: [card(id: "a", preview: "https://preview.app")])
        #expect(again.isEmpty)
    }

    /// The complaint this rule exists for: a push is not something to be told
    /// about, and the deploy it starts is what the banner waits for.
    @Test("a push starts a deploy in silence, and only the landing notifies")
    func deployLandingIsTheEdge() {
        let live = BoardNotifier.snapshot([card(id: "a", preview: "https://preview.app")])

        // The push. The URL is unchanged — the host keeps one per branch — and
        // it is still serving the previous change, so there is nothing to see.
        let (onPush, building) = BoardNotifier.diff(
            previous: live,
            current: [card(id: "a", preview: "https://preview.app", pending: true)])
        #expect(onPush.isEmpty)
        #expect(building["a"]?.preview?.isLive == false)

        // A poll while it is still building says nothing either.
        let (midway, stillBuilding) = BoardNotifier.diff(
            previous: building,
            current: [card(id: "a", preview: "https://preview.app", pending: true)])
        #expect(midway.isEmpty)

        // It lands.
        let (landed, _) = BoardNotifier.diff(
            previous: stillBuilding,
            current: [card(id: "a", preview: "https://preview.app")])
        #expect(landed.count == 1)
        #expect(landed[0].kind == .preview)
        #expect(landed[0].url == "https://preview.app")
    }

    /// The bug as reported: "it shows me all of my existing preview links". The
    /// URL is read out of the deploy host's comment on the PR, which is a
    /// second query — skip it, or have it rate-limited, and every card loses
    /// its preview at once. Treating that as the previews going away made their
    /// return look like a board's worth of deployments landing together.
    @Test("a poll that loses the preview url is ignorance, not a deployment")
    func blindPollDoesNotResetThePreview() {
        let live = BoardNotifier.snapshot([
            card(id: "a", preview: "https://a.app"),
            card(id: "b", preview: "https://b.app"),
        ])
        // The query that resolves preview URLs comes back empty for everything.
        let (blind, afterBlind) = BoardNotifier.diff(
            previous: live, current: [card(id: "a"), card(id: "b")])
        #expect(blind.isEmpty)
        // The board remembers what it saw rather than recording the absence.
        #expect(afterBlind["a"]?.preview?.url == "https://a.app")
        #expect(afterBlind["b"]?.preview?.url == "https://b.app")

        // And the URLs coming back is not news, because nothing was deployed.
        let (restored, _) = BoardNotifier.diff(
            previous: afterBlind,
            current: [card(id: "a", preview: "https://a.app"), card(id: "b", preview: "https://b.app")])
        #expect(restored.isEmpty)
    }

    /// The same blindness, mid-deploy: the board must not forget it was waiting.
    @Test("a blind poll mid-deploy still lets the landing notify")
    func blindPollMidDeploy() {
        let building = BoardNotifier.snapshot(
            [card(id: "a", preview: "https://a.app", pending: true)])
        let (_, afterBlind) = BoardNotifier.diff(previous: building, current: [card(id: "a")])
        #expect(afterBlind["a"]?.preview?.pending == true)
        let (landed, _) = BoardNotifier.diff(
            previous: afterBlind, current: [card(id: "a", preview: "https://a.app")])
        #expect(landed.count == 1)
        #expect(landed[0].kind == .preview)
    }

    @Test("a live preview at a new address notifies, host moves being real")
    func movedHost() {
        let live = BoardNotifier.snapshot([card(id: "a", preview: "https://old.app")])
        let (events, _) = BoardNotifier.diff(
            previous: live, current: [card(id: "a", preview: "https://new.app")])
        #expect(events.count == 1)
        #expect(events[0].url == "https://new.app")
    }

    @Test("both edges on one poll fire both notifications")
    func bothAtOnce() {
        let before = BoardNotifier.snapshot([card(id: "a", label: "Working", preview: nil)])
        let (events, _) = BoardNotifier.diff(
            previous: before,
            current: [card(id: "a", label: "Mergeable", preview: "https://p")])
        #expect(Set(events.map(\.kind)) == [.mergeable, .preview])
    }

    @Test("a card unseen last poll is seeded silently, never fired")
    func newCardSeeds() {
        // A brand-new already-mergeable card (a freshly configured project, say)
        // must not dump a banner — the diff has no baseline for it.
        let (events, snapshot) = BoardNotifier.diff(
            previous: [:], current: [card(id: "a", label: "★ Ready to merge", preview: "https://p")])
        #expect(events.isEmpty)
        #expect(snapshot["a"]?.mergeable == true)
        #expect(snapshot["a"]?.preview?.url == "https://p")
    }

    @Test("a card that leaves and returns is re-seeded, not re-fired")
    func goneAndBack() {
        let seeded = BoardNotifier.snapshot([card(id: "a", label: "★ Ready to merge")])
        // It drops off the board.
        let (_, afterGone) = BoardNotifier.diff(previous: seeded, current: [])
        #expect(afterGone["a"] == nil)
        // It comes back, still mergeable — but it is new to the snapshot again,
        // so it seeds rather than re-firing.
        let (events, _) = BoardNotifier.diff(
            previous: afterGone, current: [card(id: "a", label: "★ Ready to merge")])
        #expect(events.isEmpty)
    }

    /// The banner is one line under the menu bar, and the card's own title is
    /// the one written for a person — the PR's is written for a commit log,
    /// with its prefix and its trail of ticket ids. It is also the title the
    /// operator will be looking for on the board once the banner sends them
    /// there.
    @Test("the notification names the card, not the PR")
    func usesCardTitle() {
        let before = BoardNotifier.snapshot([card(id: "a", label: "Working")])
        let (events, _) = BoardNotifier.diff(
            previous: before,
            current: [card(id: "a", label: "Mergeable",
                           prTitle: "feat(scope): the long conventional-commit title (ENG-1, ENG-2)",
                           title: "The short one")])
        #expect(events[0].title == "The short one")
    }
}
