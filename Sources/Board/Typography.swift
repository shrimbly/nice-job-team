import AppKit
import SwiftUI

/// The type scale. Four sizes, named for what they are used for rather than how
/// big they are — 12.5, 11, 10, 9.
///
/// It had grown to eight sizes (8, 9, 9.5, 10, 10.5, 11, 12, 12.5) laid down one
/// call site at a time. At this scale half a point is not a distinction anyone can
/// see; it is just a number that has to be matched by the next person.
///
/// One family throughout: SF Pro. The dashboard split prose and values across two
/// faces, but a monospaced face earns its keep by making columns line up, and
/// nothing here is in a column — the values sit inline in prose. What it was
/// actually buying was digits of equal width, and `monospacedDigit()` gives that
/// without the typewriter texture.
enum Typography {
    /// Card titles. Distinguished from `body` by weight rather than by size.
    static let title = Font.system(size: 12.5, weight: .medium)
    /// Prose — the "is / at" lines, the empty state.
    static let body = Font.system(size: 12.5)
    /// Footer buttons.
    static let control = Font.system(size: 11)
    /// Metadata: the branch, the facts strip, the copy toast.
    static let meta = Font.system(size: 10)
    static let toast = Font.system(size: 10, weight: .medium)
    static let note = Font.system(size: 10)
    /// The footer counts minutes and quota, both of which change under the reader —
    /// equal-width digits stop the line twitching as they do.
    static let footer = Font.system(size: 10).monospacedDigit()
    /// The smallest step, and only ever for a short uppercase label or an
    /// identifier — never for anything anyone has to read a line of.
    static let pill = Font.system(size: pillSize, weight: .semibold)
    /// The same face in AppKit terms. `PillColumn` needs a label's width before
    /// SwiftUI has laid it out, and only AppKit can measure a string on its own.
    /// Computed rather than stored: `NSFont` is not `Sendable`, and AppKit caches
    /// the system font anyway.
    static var pillMeasuring: NSFont { .systemFont(ofSize: pillSize, weight: .semibold) }
    private static let pillSize: CGFloat = 9
    /// Carries a PR number, so its digits hold their width.
    static let label = Font.system(size: 9, weight: .medium).monospacedDigit()

    /// Glyphs, not text, so they sit outside the scale — these are sized to balance
    /// optically against the text beside them.
    enum Icon {
        static let chip = Font.system(size: 12, weight: .medium)
        static let chevron = Font.system(size: 8, weight: .semibold)
        static let confirmation = Font.system(size: 8, weight: .bold)
    }

    /// Uppercase labels need a little positive tracking or the letters crowd.
    static let uppercaseTracking: CGFloat = 0.5

    /// Prose wants roughly 1.5 line-height; SwiftUI takes the extra as spacing on
    /// top of the font's own leading.
    static let bodyLineSpacing: CGFloat = 3
    static let metaLineSpacing: CGFloat = 2
}
