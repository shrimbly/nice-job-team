import Foundation
import Testing
@testable import BoardKit

/// What `board dismiss` is handed for a card.
///
/// Every card can be dismissed, so this is mostly the card's own id. The guard
/// is the point: the value becomes a CLI argument, so an id carrying
/// whitespace, or one that would be read as a flag, must not become a command.
struct CardDismissalTests {

    private func card(id: String) -> Card {
        Card(
            id: id, num: nil, title: "t", branch: "", workspace: nil,
            workspaceId: nil, workspaceUrl: nil, boardState: "pr-open",
            prUrl: nil, ticketKey: nil, ticketUrl: nil, previewUrl: nil,
            review: nil, ci: "green", threads: 0, draft: false,
            mergeState: nil, needsOperator: false, agentState: nil,
            agentPhase: nil, agentSummary: nil, liveness: nil, dirty: nil,
            unpushed: nil, whatItIs: "w",
            pill: Pill(label: "Working", tone: .agent), whereItsAt: nil,
            previewPending: nil)
    }

    @Test("a card the board invented carries its own id")
    func synthesizedIsDismissible() {
        #expect(card(id: "pr:acme/AcmeUI_frontend#12633").dismissalRef
            == "pr:acme/AcmeUI_frontend#12633")
    }

    /// The restriction is gone: a card an item stands behind goes the same way,
    /// by the item's id. Hiding it hides the card and not the item.
    @Test("a card an item stands behind can be dismissed too")
    func itemBackedIsDismissible() {
        #expect(card(id: "itm_438").dismissalRef == "itm_438")
        #expect(card(id: "itm_deploy-to-acme-api-entry").dismissalRef
            == "itm_deploy-to-acme-api-entry")
    }

    @Test("an id that could not be an argument is refused rather than passed on")
    func unsafeIsRefused() {
        // Each of these would reach the CLI as something other than one token.
        #expect(card(id: "").dismissalRef == nil)
        #expect(card(id: "   ").dismissalRef == nil)
        #expect(card(id: "itm 438").dismissalRef == nil)
        #expect(card(id: "itm_438\n").dismissalRef == nil)
        #expect(card(id: "--force").dismissalRef == nil)
        #expect(card(id: "-x").dismissalRef == nil)
    }
}
