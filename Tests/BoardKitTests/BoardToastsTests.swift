import Foundation
import Testing
@testable import BoardKit

/// The rules of the app's banner stack: what arrives and what waits. Banners
/// do not age out — staying until dismissed is the contract — so the only rule
/// left to own is that nothing queued behind the pile is ever dropped.
struct BoardToastsTests {

    private func event(_ kind: BoardNotification.Kind = .mergeable) -> BoardNotification {
        BoardNotification(kind: kind, cardId: "a", title: "the change",
                          project: nil, url: "https://gh/pr/1")
    }

    /// As many banners as the pile draws at once, in arrival order.
    private func fullStack() -> [Toast] {
        var rows: [Toast] = []
        for _ in 0..<BoardToasts.visible { rows = BoardToasts.pushing(event(), onto: rows) }
        return rows
    }

    @Test("banners append newest-last")
    func appends() {
        let rows = BoardToasts.pushing(
            event(.preview),
            onto: BoardToasts.pushing(event(), onto: []))
        #expect(rows.map(\.event.kind) == [.mergeable, .preview])
    }

    @Test("a banner past what the pile draws waits behind it rather than being dropped")
    func queuesPastVisible() {
        var rows = fullStack()
        // Distinguish the newcomer by its kind. It joins the back of a full
        // pile; the oldest is still there, waiting for a dismissal to bring it
        // back, because nothing here has been read until it has been dismissed.
        rows = BoardToasts.pushing(event(.preview), onto: rows)
        #expect(rows.count == BoardToasts.visible + 1)
        #expect(rows.map(\.event.kind) == [.mergeable, .mergeable, .mergeable, .preview])
    }

    @Test("each kind has its headline")
    func headlines() {
        #expect(event(.mergeable).headline == "Ready to merge")
        #expect(event(.preview).headline == "Preview ready")
    }
}
