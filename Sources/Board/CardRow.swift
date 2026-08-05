import AppKit
import BoardKit
import SwiftUI

/// One card. Two fixed rows — the title, then the status and the links — so every
/// card is the same height and the title always has the whole width to work with,
/// however many chips the card happens to carry.
struct CardRow: View {
    let card: Card
    /// One width for every pill on the board — see `PillColumn`.
    let pillWidth: CGFloat
    let isExpanded: Bool
    let toggle: () -> Void
    let open: (String) -> Void
    /// Reports a right-click copy, with the chip's frame so the panel can put the
    /// confirmation over it.
    let copied: (CGRect) -> Void

    @State private var isHovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private enum Metrics {
        static let inset: CGFloat = 8
        static let gap: CGFloat = 9
        /// The status and the links are the same height, so the second row is one
        /// strip rather than two things of different sizes sitting side by side.
        static let strip: CGFloat = 20
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            // Fades as the card's own height uncovers it. The card clips, so the
            // text is wiped into view from under the header rather than appearing
            // whole in a box that is still growing around it.
            if isExpanded { expansion.transition(.opacity) }
        }
        // Stated here as well as at the toggle. A lazy stack inside a scroll view is
        // not reliable about carrying an ambient animation down to a row, and this
        // one is keyed on the value itself, so the card opens on its own curve
        // whatever the container does with the transaction.
        .animation(Motion.disclosure(reduceMotion: reduceMotion), value: isExpanded)
        .background(Palette.card)
        .clipShape(RoundedRectangle.squircle(8))
        .overlay(RoundedRectangle.squircle(8).stroke(Palette.rule, lineWidth: 1))
        // The card moves as one thing. Without this, a change to the card's position
        // reaches every child separately and each interpolates its own way there —
        // the status pill's background arrived on time while its label did not, and
        // a title was drawn twice, at both ends of its journey at once.
        .geometryGroup()
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: Metrics.gap) {
                Text(card.title)
                    .font(Typography.title)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    // The title is the first thing truncated and the thing most
                    // worth reading, so the whole of it stays reachable.
                    .help(card.title)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.down")
                    .font(Typography.Icon.chevron)
                    .foregroundStyle(Palette.faint)
                    .rotationEffect(.degrees(isExpanded ? 180 : 0))
                    .animation(Motion.disclosure(reduceMotion: reduceMotion), value: isExpanded)
                    .frame(width: 14)
            }
            // The status leads the links: where the card has got to, then the places
            // to go and look at it. The pill holds the row's height on its own, so a
            // card with no links is still the same height as one with four.
            HStack(spacing: 6) {
                pill
                links
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(Metrics.inset)
        .background(hoverTint)
        .contentShape(Rectangle())
        .onHover { isHovering = $0 }
        .onTapGesture(perform: toggle)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(card.pill.label). \(card.title)")
        .accessibilityAddTraits(.isButton)
    }

    /// Ink over the card, so the lift works out as brighter on a dark card and
    /// darker on a light one without either being named. Only the header takes it —
    /// the expansion below is text, not a target.
    private var hoverTint: Color {
        Palette.ink.opacity(isHovering ? 0.06 : 0)
    }

    private var pill: some View {
        Text(card.pill.label.uppercased())
            .font(Typography.pill)
            .tracking(Typography.uppercaseTracking)
            .foregroundStyle(Palette.foreground(card.pill.tone))
            .lineLimit(1)
            // One width for every pill on the board, so the chips beside them start
            // at the same x on every card.
            .frame(width: pillWidth, height: Metrics.strip)
            .background(Palette.background(card.pill.tone), in: RoundedRectangle.squircle(5))
    }

    /// Every card carries all four slots, whether or not it has the link. A card
    /// with no pull request used to drop the widest chip in the row, and the two
    /// beside it slid left — so the row read as a different shape per card rather
    /// than as a column. A slot with nowhere to go is drawn empty instead.
    private var links: some View {
        HStack(spacing: 4) {
            // The workspace link is how the operator reaches the agent to instruct
            // it, so it still leads. Its name is read in the expansion, not here.
            Chip(help: card.workspace ?? "Superset workspace",
                 absent: "No workspace",
                 kind: .workspace, url: card.workspaceUrl, open: open, copied: copied)
            // The number is the label, so an empty slot needs a stand-in of about
            // its width — the one chip here wide enough for its absence to show.
            Chip(label: card.num.map { "PR-\($0)" } ?? (card.prUrl == nil ? "PR-XXX" : "PR"),
                 help: card.draft ? "Draft pull request" : "Open pull request",
                 absent: "No pull request yet",
                 kind: .pullRequest(isDraft: card.draft),
                 url: card.prUrl, open: open, copied: copied)
            Chip(help: card.ticketKey.map { "Linear issue \($0)" } ?? "Linear issue",
                 absent: "No Linear issue",
                 kind: .ticket, url: card.ticketUrl, open: open, copied: copied)
            // The only one whose label said nothing the icon does not.
            Chip(help: "Preview deployment",
                 absent: "No preview deployment",
                 kind: .preview, url: card.previewUrl, open: open, copied: copied)
        }
    }

    private var expansion: some View {
        VStack(alignment: .leading, spacing: 0) {
            Divider().overlay(Palette.rule)
            VStack(alignment: .leading, spacing: 7) {
                // No labels: the outcome and where it has got to are told apart by
                // what they say, and by one being quieter than the other.
                paragraph(card.whatItIs, color: Palette.soft)
                if let whereItsAt = card.whereItsAt, !whereItsAt.isEmpty {
                    paragraph(whereItsAt, color: Palette.ink)
                }
                if workspaceName != nil || !facts.isEmpty {
                    Divider().overlay(Palette.rule).padding(.top, 3)
                    VStack(alignment: .leading, spacing: 4) {
                        // The branch the agent is on, at full length. It sat in the
                        // chip row until a name long enough to matter was the one
                        // that got trimmed.
                        if let workspaceName {
                            Text(workspaceName)
                                .font(Typography.meta)
                                .foregroundStyle(Palette.soft)
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .textSelection(.enabled)
                        }
                        if !facts.isEmpty {
                            Text(facts.joined(separator: " · "))
                                .font(Typography.note)
                                .lineSpacing(Typography.metaLineSpacing)
                                .foregroundStyle(Palette.faint)
                                .textSelection(.enabled)
                        }
                    }
                    .padding(.top, 3)
                }
            }
            .padding(.horizontal, Metrics.inset)
            .padding(.top, 10)
            .padding(.bottom, 12)
        }
    }

    private func paragraph(_ text: String, color: Color) -> some View {
        Text(text)
            .font(Typography.body)
            .lineSpacing(Typography.bodyLineSpacing)
            .foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }

    /// Nil rather than empty, so the rule above it is not drawn for a blank line.
    private var workspaceName: String? {
        guard let name = card.workspace, !name.isEmpty else { return nil }
        return name
    }

    /// Said in words rather than in the API's own vocabulary. The raw values read
    /// badly on their own — a label of "review" in front of REVIEW_REQUIRED came out
    /// as "review review required" — and some of them say nothing worth the room.
    private var facts: [String] {
        var out: [String] = []
        if let review = card.review, !review.isEmpty { out.append(Self.review(review)) }
        if let checks = Self.checks(card.ci) { out.append(checks) }
        if card.threads > 0 {
            out.append("\(card.threads) unresolved comment\(card.threads == 1 ? "" : "s")")
        }
        if let merge = Self.merge(card.mergeState) { out.append(merge) }
        if let liveness = card.liveness { out.append("Agent \(liveness)") }
        if let dirty = card.dirty, dirty != "0" { out.append("\(dirty) uncommitted") }
        return out
    }

    private static func review(_ decision: String) -> String {
        switch decision {
        case "APPROVED": "Approved"
        case "CHANGES_REQUESTED": "Changes requested"
        case "REVIEW_REQUIRED": "Review requested"
        default: decision.lowercased().replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    private static func checks(_ state: String) -> String? {
        switch state {
        case "green": "Checks passing"
        case "red": "Checks failing"
        case "running": "Checks running"
        case "none": "No checks"
        default: nil
        }
    }

    /// Only when it says something the review and the checks have not. GitHub calls
    /// a PR BLOCKED whenever a required review is outstanding, which is already the
    /// first fact in the line.
    private static func merge(_ state: String?) -> String? {
        switch state {
        case "DIRTY": "Conflicts with main"
        case "BEHIND": "Behind main"
        default: nil
        }
    }
}

/// A link out. Every one of these opens the default browser — the app never shows
/// a web view of its own.
private struct Chip: View {
    /// What the chip links to. Everything about how it is drawn follows from this,
    /// including GitHub's own colouring for a pull request's state.
    enum Kind: Equatable {
        case workspace
        case pullRequest(isDraft: Bool)
        case ticket
        case preview

        /// `arrow.triangle.pull` is the closest thing SF Symbols has to GitHub's own
        /// `git-pull-request` glyph, and it is the same shape. Linear has no symbol
        /// at all, so it is drawn — see `glyph`.
        var icon: String? {
            switch self {
            case .ticket: nil
            case .workspace: "macwindow"
            case .pullRequest: "arrow.triangle.pull"
            case .preview: "globe"
            }
        }

        /// The pull request is the only chip that carries a colour. It is the one
        /// whose colour means something — GitHub greys a draft and greens an open
        /// PR, and the board says the same thing in the same values. Giving the
        /// others their brand colours too only made the row noisier.
        var accent: Color? {
            switch self {
            case .pullRequest(let isDraft):
                isDraft ? Palette.Brand.gitHubDraft : Palette.Brand.gitHubOpen
            case .workspace, .ticket, .preview: nil
            }
        }

        var lifted: Color? {
            switch self {
            case .pullRequest(let isDraft):
                isDraft ? Palette.Brand.gitHubDraftLifted : Palette.Brand.gitHubOpenLifted
            case .workspace, .ticket, .preview: nil
            }
        }
    }

    /// Only the pull request still shows text — its number is the one identifier
    /// short enough to sit in the row. The rest are their icon and their tooltip.
    var label: String?
    let help: String
    /// Said instead of `help` when there is no link, so an empty slot names what is
    /// missing rather than describing something that is not there.
    let absent: String
    let kind: Kind
    /// Nil when the card has no such link. The chip is still drawn, at the size it
    /// would be — see `links`.
    let url: String?
    let open: (String) -> Void
    let copied: (CGRect) -> Void

    @State private var isHovering = false

    private var isLive: Bool { url != nil }

    var body: some View {
        if let url {
            Button { open(url) } label: { box }
                .fixedSize(horizontal: true, vertical: false)
                .buttonStyle(.plain)
                // Reading the frame here rather than through a preference keeps it in
                // the panel's own space, which is where the confirmation has to be
                // placed.
                .overlay {
                    GeometryReader { proxy in
                        RightClickCatcher {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(url, forType: .string)
                            copied(proxy.frame(in: .named(BoardPanel.coordinateSpace)))
                        }
                    }
                }
                .onHover { isHovering = $0 }
                .help("\(help) — right-click to copy the link")
        } else {
            // Not a Button: there is nothing to press, and a disabled button still
            // takes the cursor. It holds the space and says why it is empty.
            box
                .fixedSize(horizontal: true, vertical: false)
                .help(absent)
                .accessibilityHidden(true)
        }
    }

    private var box: some View {
        HStack(spacing: 4) {
            glyph
            if let label {
                Text(label)
                    .font(Typography.label)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .foregroundStyle(foreground)
        .frame(height: 14)
        .padding(.horizontal, label == nil ? 6 : 5)
        .padding(.vertical, 3)
        .background(background, in: RoundedRectangle.squircle(5))
        .overlay(RoundedRectangle.squircle(5).stroke(border, lineWidth: 1))
    }

    @ViewBuilder private var glyph: some View {
        if kind == .ticket {
            // Drawn rather than named: it is a Shape, so it takes a fill instead of
            // inheriting the stack's foreground style.
            LinearMark().fill(foreground).frame(width: 11, height: 11)
        } else if let icon = kind.icon {
            Image(systemName: icon).font(Typography.Icon.chip)
        }
    }

    /// An empty slot is somewhere a link will be, not something to read: the faintest
    /// ink on the card, and never the accent — a pull request that does not exist has
    /// no state to be green or grey about.
    private var foreground: Color {
        guard isLive else { return Palette.faint.opacity(0.6) }
        if let accent = kind.accent { return isHovering ? (kind.lifted ?? accent) : accent }
        return isHovering ? Palette.ink : Palette.soft
    }

    private var background: Color {
        // Ink over the card rather than Palette.bg, which is *darker* than the card
        // in dark mode and made hover read as a hole rather than a highlight.
        guard isLive else { return .clear }
        if let accent = kind.accent { return isHovering ? accent.opacity(0.22) : .clear }
        return isHovering ? Palette.ink.opacity(0.09) : .clear
    }

    private var border: Color {
        guard isLive else { return Palette.rule2.opacity(0.55) }
        if let accent = kind.accent { return accent.opacity(isHovering ? 0.95 : 0.4) }
        return isHovering ? Palette.soft : Palette.rule2
    }
}
