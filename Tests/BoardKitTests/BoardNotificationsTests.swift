import Foundation
import Testing
@testable import BoardKit

/// The rules behind the app's merge/preview notifications: they fire on the
/// edge (the poll a PR first becomes mergeable, or a preview first appears),
/// never every poll it stays that way, and never for what was already true when
/// the app first looked.
struct BoardNotificationsTests {

    private func card(
        id: String, label: String = "Working", tone: Tone = .agent,
        preview: String? = nil, prUrl: String? = "https://gh/pr", shortName: String = "P",
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
                whereItsAt: nil),
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
        #expect(seed["a"]?.hasPreview == false)
        #expect(seed["b"]?.hasPreview == false)
        #expect(BoardNotifier.snapshot([card(id: "c", preview: "https://x")])["c"]?.hasPreview == true)
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

    @Test("a preview appearing fires once, with the preview url")
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
        #expect(snapshot["a"]?.hasPreview == true)
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

    @Test("the notification names the PR title when it differs from the card")
    func usesPrTitle() {
        let before = BoardNotifier.snapshot([card(id: "a", label: "Working")])
        let (events, _) = BoardNotifier.diff(
            previous: before,
            current: [card(id: "a", label: "Mergeable", prTitle: "fix: the real PR title", title: "short")])
        #expect(events[0].title == "fix: the real PR title")
    }
}
