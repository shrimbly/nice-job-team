import Foundation

/// What the menu-bar item shows: the count, and whether it is shouting. The
/// count and the tint are the app's whole job when the panel is shut, so the
/// rules live here — in the model, where a test can hold them — rather than in
/// the AppKit code that draws them.
public struct StatusItemModel: Sendable, Equatable {
    public let total: Int
    public let needsOperator: Int

    public init(cards: [ProjectCard], reviews: Int = 0, reviewsCountAsNeedsYou: Bool = false) {
        total = cards.count
        // Pending reviews join the alert only when config says so (the document
        // carries the flag) — by default the tab badge is their only signal, so
        // a quiet menu bar still means "no board card needs you".
        needsOperator =
            cards.count { $0.card.pill.tone.needsOperator }
            + (reviewsCountAsNeedsYou ? reviews : 0)
    }

    public init(total: Int, needsOperator: Int) {
        self.total = total
        self.needsOperator = needsOperator
    }

    /// The tint and the fill both follow this one answer.
    public var isAlert: Bool { needsOperator > 0 }

    /// Filled when alerting, so the shape changes along with the colour — the
    /// menu bar's template rendering can strip a tint, and colour alone is
    /// invisible to anyone who cannot tell the two apart.
    public var symbolName: String { isAlert ? "rectangle.stack.fill" : "rectangle.stack" }

    /// The number beside the icon: how many need the operator when any do,
    /// otherwise how many are on the board at all.
    public var countText: String { isAlert ? "\(needsOperator)" : "\(total)" }

    public var toolTip: String {
        isAlert ? "\(needsOperator) of \(total) need you" : "\(total) open"
    }
}
