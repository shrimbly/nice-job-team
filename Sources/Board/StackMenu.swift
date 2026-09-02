import BoardKit
import SwiftUI

/// The chooser a stacked card's chips open: one row per PR in the stack, so a card
/// that stands for three of them can still take you to any one.
///
/// It comes off the chip the way the copy confirmation does — up out of it, tilted,
/// on the same spring — because it is the same gesture answered in the same place,
/// and a second entrance for a second thing appearing over a chip would be one
/// vocabulary too many. Where it differs is that this one is a surface to read and
/// click, not a word to glance at: it takes the card's own background rather than
/// the confirmation's inverted one, which is what lets the accents mean here exactly
/// what they mean on the cards.
struct StackMenu: View {
    /// Which of a PR's links the rows lead to. The chip that was pressed decides,
    /// and the row's glyph follows it, so the menu says what it will open without
    /// having to be labelled.
    enum Target {
        case pullRequest
        case preview

        func url(_ pr: StackRow) -> String? {
            switch self {
            case .pullRequest: pr.url
            case .preview: pr.previewUrl
            }
        }

        var icon: String {
            switch self {
            case .pullRequest: "arrow.triangle.pull"
            case .preview: "globe"
            }
        }

        var opens: String {
            switch self {
            case .pullRequest: "open on GitHub"
            case .preview: "open the preview"
            }
        }
    }

    /// Stated rather than measured, for the same reason `CopiedToast.height` is: the
    /// panel places this by its centre and has to know the size before SwiftUI has
    /// laid it out.
    static let rowHeight: CGFloat = 22
    static let rowSpacing: CGFloat = 1
    static let inset: CGFloat = 4
    static let width: CGFloat = 272
    /// The gap between the bottom of the menu and the top of the chip.
    static let clearance: CGFloat = 5
    /// How close the menu may come to the panel's edge.
    private static let margin: CGFloat = 8

    static func height(count: Int) -> CGFloat {
        inset * 2 + CGFloat(count) * rowHeight + CGFloat(max(0, count - 1)) * rowSpacing
    }

    /// Centred over the chip, its bottom edge `clearance` above the chip's top, and
    /// pulled back inside the panel when the chip is near an edge — the chip sits a
    /// long way right of centre, and a menu this wide would otherwise hang over the
    /// panel's own border.
    static func restingCentre(above chip: CGRect, count: Int, panelWidth: CGFloat) -> CGPoint {
        let half = width / 2
        let free = max(half + margin, panelWidth - half - margin)
        return CGPoint(x: min(max(chip.midX, half + margin), free),
                       y: chip.minY - clearance - height(count: count) / 2)
    }

    /// How far it travels, having started centred on the chip. Derived from the same
    /// numbers as the resting place so the pair cannot drift.
    static func rise(from chip: CGRect, count: Int) -> CGFloat {
        chip.height / 2 + clearance + height(count: count) / 2
    }

    /// Bottom of the stack first: the order they have to land in, and the order the
    /// chip's tooltip names them in.
    let prs: [StackRow]
    let target: Target
    let rise: CGFloat
    let open: (String) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var settled = false

    var body: some View {
        VStack(spacing: Self.rowSpacing) {
            ForEach(Array(prs.enumerated()), id: \.element.number) { index, pr in
                Row(pr: pr, target: target, open: open)
                    // The rows resolve a beat apart, out of the same blur the
                    // confirmation's letters use. The step is three times theirs:
                    // those are letters of one word and have to arrive as a word,
                    // these are separate things to choose between.
                    .blur(radius: settled ? 0 : Motion.toastLetterBlur(reduceMotion: reduceMotion))
                    .opacity(settled ? 1 : 0)
                    .animation(Motion.menuRow(index: index, reduceMotion: reduceMotion), value: settled)
            }
        }
        .padding(Self.inset)
        .frame(width: Self.width)
        .background(Palette.card, in: RoundedRectangle.squircle(8))
        .overlay(RoundedRectangle.squircle(8).stroke(Palette.rule, lineWidth: 1))
        .shadow(color: .black.opacity(0.3), radius: 8, y: 3)
        // On the menu's own frame rather than in the transition that inserts it —
        // see `CopiedToast`, which has the same reason: `position` returns a view as
        // large as everything it is offered, and a rotation out there would turn
        // about the panel's middle.
        .rotationEffect(.degrees(moving ? Motion.toastTilt : 0))
        .offset(y: moving ? rise : 0)
        .animation(Motion.copiedIn(reduceMotion: reduceMotion), value: settled)
        .onAppear { DispatchQueue.main.async { settled = true } }
    }

    private var moving: Bool { !settled && !reduceMotion }

    /// One PR. The glyph carries GitHub's own colouring, exactly as the chip on the
    /// card does, so nothing in here has to be learned twice.
    ///
    /// No state on the row. Every PR in a stack is nearly always in the same state
    /// as the rest of it — a column of three identical words, which is a column of
    /// nothing — and the glyph's colour already separates a draft from an open PR.
    /// Dropping it also gives the title the width, which is the part that differs.
    private struct Row: View {
        let pr: StackRow
        let target: Target
        let open: (String) -> Void

        @State private var isHovering = false

        /// The pull-request glyph takes GitHub's colouring, as its chip does. The
        /// preview's does not, for the same reason its chip does not: a deployment
        /// has no state to be green or grey about.
        private var accent: Color {
            switch target {
            case .pullRequest: pr.isDraft ? Palette.Brand.gitHubDraft : Palette.Brand.gitHubOpen
            case .preview: Palette.soft
            }
        }

        var body: some View {
            HStack(spacing: 5) {
                Image(systemName: target.icon)
                    .font(Typography.Icon.chip)
                    .foregroundStyle(accent)
                Text("#\(pr.number)")
                    .font(Typography.label)
                    .foregroundStyle(Palette.ink)
                Text(pr.title)
                    .font(Typography.meta)
                    .foregroundStyle(Palette.soft)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 5)
            .frame(height: StackMenu.rowHeight)
            .background(isHovering ? Palette.ink.opacity(0.09) : .clear,
                        in: RoundedRectangle.squircle(5))
            .contentShape(Rectangle())
            .onHover { isHovering = $0 }
            .onTapGesture { if let url = target.url(pr) { open(url) } }
            .help(target.url(pr) == nil ? pr.title : "\(pr.title) — \(target.opens)")
        }
    }
}
