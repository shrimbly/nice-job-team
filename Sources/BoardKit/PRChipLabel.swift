import Foundation

/// The text on a card's pull-request chip.
///
/// It lives here rather than in the view because two places need it and they must
/// not disagree: the chip that draws it, and the measurement that gives every PR
/// chip on the board one width. A label the measurer has not seen is a label that
/// gets truncated.
public enum PRChipLabel {
    /// A card standing for a stack says how many, not which — there is no room for
    /// three numbers in the row, and pressing it opens a menu that names them.
    public static func text(num: Int?, prUrl: String?, stackCount: Int) -> String {
        if stackCount > 1 { return "×\(stackCount) PRs" }
        if let num { return "PR-\(num)" }
        // A link with nothing to number it, against nowhere to go at all. The empty
        // slot needs a stand-in of about a real label's width, or the chips beside
        // it slide left on the cards that have no PR.
        return prUrl == nil ? "PR-XXX" : "PR"
    }

    /// Every label the board will draw, for the measurement.
    public static func texts(for cards: [(card: Card, stackCount: Int)]) -> [String] {
        cards.map { text(num: $0.card.num, prUrl: $0.card.prUrl, stackCount: $0.stackCount) }
    }
}
