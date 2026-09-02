import Foundation
import Testing
@testable import BoardKit

/// The count and the tint are the app's whole job when the panel is shut, so the
/// rules are held here rather than left to the AppKit drawing code: which count
/// shows, when the icon fills and tints, and what the tooltip says.
struct StatusItemLogicTests {

    private func card(id: String, tone: Tone) -> ProjectCard {
        ProjectCard(
            projectKey: "p", shortName: "P",
            card: Card(
                id: id, num: nil, title: "t", branch: "", workspace: nil,
                workspaceId: nil, workspaceUrl: nil, boardState: "queued",
                prUrl: nil, ticketKey: nil, ticketUrl: nil, previewUrl: nil,
                review: nil, ci: "none", threads: 0, draft: false,
                mergeState: nil, needsOperator: tone == .you, agentState: nil,
                agentPhase: nil, agentSummary: nil, liveness: nil, dirty: nil,
                unpushed: nil, whatItIs: "w",
                pill: Pill(label: "L", tone: tone), whereItsAt: nil))
    }

    @Test("a quiet board shows the total, unfilled and untinted")
    func quiet() {
        let model = StatusItemModel(cards: [
            card(id: "a", tone: .agent), card(id: "b", tone: .review),
            card(id: "c", tone: .mute),
        ])
        #expect(!model.isAlert)
        #expect(model.countText == "3")
        #expect(model.symbolName == "rectangle.stack")
        #expect(model.toolTip == "3 open")
    }

    @Test("only the 'you' tone counts as needing the operator")
    func onlyYouAlerts() {
        // bad is loud on the card, but it is the agent's problem until it is not.
        let model = StatusItemModel(cards: [
            card(id: "a", tone: .bad), card(id: "b", tone: .good),
        ])
        #expect(model.needsOperator == 0)
        #expect(!model.isAlert)
    }

    @Test("an alerting board shows the needs-you count, filled")
    func alerting() {
        let model = StatusItemModel(cards: [
            card(id: "a", tone: .you), card(id: "b", tone: .you),
            card(id: "c", tone: .agent), card(id: "d", tone: .mute),
        ])
        #expect(model.isAlert)
        #expect(model.needsOperator == 2)
        #expect(model.countText == "2")
        #expect(model.symbolName == "rectangle.stack.fill")
        #expect(model.toolTip == "2 of 4 need you")
    }

    @Test("an empty board is a quiet zero, not an alert")
    func empty() {
        let model = StatusItemModel(cards: [])
        #expect(!model.isAlert)
        #expect(model.countText == "0")
        #expect(model.toolTip == "0 open")
    }

    @Test("reviews stay out of the count unless the document says otherwise")
    func reviewsFollowTheFlag() {
        let quiet = StatusItemModel(
            cards: [card(id: "a", tone: .agent)], reviews: 3, reviewsCountAsNeedsYou: false)
        #expect(!quiet.isAlert)
        #expect(quiet.countText == "1")

        let folded = StatusItemModel(
            cards: [card(id: "a", tone: .you)], reviews: 3, reviewsCountAsNeedsYou: true)
        #expect(folded.isAlert)
        #expect(folded.needsOperator == 4)
        #expect(folded.countText == "4")
    }

    @Test("the model mirrors the tone's own needsOperator answer")
    func agreesWithTone() {
        for tone in Tone.allCases {
            let model = StatusItemModel(cards: [card(id: "x", tone: tone)])
            #expect(model.isAlert == tone.needsOperator)
        }
    }
}
