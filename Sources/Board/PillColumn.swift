import AppKit
import BoardKit

/// Every status pill takes the width of the widest one on the board, so the chips
/// beside them start at the same x on every card rather than stepping in and out
/// down the panel.
///
/// The width comes from the labels actually on the board, not from the widest label
/// the builder can produce. `AWAITING-APPROVAL` — the raw item state, which the last
/// branch of the pill chain passes through verbatim — is half again as wide as
/// anything the board normally shows, and sizing for it would leave a gap on every
/// card for something most boards never display.
enum PillColumn {
    /// Room either side of the label.
    static let padding: CGFloat = 6

    /// This was once an invisible copy of the widest label, drawn inside every pill
    /// to size it, which meant SwiftUI did the measuring and the fit was exact. It
    /// also meant the label sat in a ZStack behind a hidden sibling and under a
    /// `fixedSize`, and a `Text` in that arrangement does not travel with the rest
    /// of a card when the panel relays out — it vanishes and reappears at the far
    /// end. A number costs a fraction of a point of accuracy and moves like
    /// everything else.
    static func width(for cards: [Card]) -> CGFloat {
        let widest = cards.map { measure($0.pill.label.uppercased()) }.max() ?? 0
        // A point of slack, because AppKit measures the string and SwiftUI lays it
        // out, and the two need not agree to the last fraction. Coming up short
        // would truncate the one label the number was taken from.
        return (widest + 1).rounded(.up) + padding * 2
    }

    private static func measure(_ label: String) -> CGFloat {
        (label as NSString).size(withAttributes: [
            .font: Typography.pillMeasuring,
            .kern: Typography.uppercaseTracking,
        ]).width
    }
}
