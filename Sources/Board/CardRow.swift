import AppKit
import BoardKit
import SwiftUI

/// One card. Two fixed rows — the title, then the status and the links — so every
/// card is the same height and the title always has the whole width to work with,
/// however many chips the card happens to carry.
struct CardRow: View {
    let card: Card
    /// Which project this card came from, or nil when only one is running and the
    /// same label on every card would say nothing.
    var project: String? = nil
    /// Every PR this card stands for, bottom of the stack first. Empty unless the
    /// card stands for more than one — more than one PR was folded into it.
    var stack: [StackRow] = []
    /// Which tracker the ticket chip stands for, so a board that does not use
    /// Linear is neither drawn with Linear's mark nor described as Linear.
    var trackerKind: String = "linear"
    /// `local` or `cloud`. A cloud card's agent is on claude.ai, so its first chip
    /// opens a browser rather than the Superset app, and says so.
    var host: String = "local"
    /// The PR's own title, when it differs from the card's. The card is titled by
    /// the board item; this keeps the GitHub title reachable on the PR chip's hover.
    var prTitle: String? = nil
    /// One width for every pill on the board — see `PillColumn`.
    let pillWidth: CGFloat
    /// One width for every pull-request chip — see `PRChipColumn`.
    let prLabelWidth: CGFloat
    let isExpanded: Bool
    let toggle: () -> Void
    let open: (String) -> Void
    /// Reports a right-click copy, with the chip's frame so the panel can put the
    /// confirmation over it.
    let copied: (CGRect) -> Void
    /// Reports a press on a chip of a stacked card, with the chip's frame, so the
    /// panel can raise the chooser over it. Drawn there rather than here because a
    /// menu inside a card would be clipped by the card and by the scroll view.
    var chose: (CGRect, [StackRow], StackMenu.Target) -> Void = { _, _, _ in }
    /// Takes the card off the board for good. Nil on a card that cannot be
    /// dismissed — one an item stands behind, whose state is what hides it —
    /// so the affordance is absent rather than present and refusing.
    var dismiss: (() -> Void)? = nil

    @State private var isHovering = false
    @State private var isHoveringDismiss = false
    /// A dismissal is permanent, so it takes two clicks: the first arms and
    /// colours the ×, the second dismisses. Leaving the button disarms — an
    /// armed × the pointer wandered away from must not fire a week later. The
    /// reviews lane's × behaves the same way, and for the same reason.
    @State private var dismissArmed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private enum Metrics {
        static let inset: CGFloat = 8
        static let gap: CGFloat = 9
        /// The status and the links are the same height, so the second row is one
        /// strip rather than two things of different sizes sitting side by side.
        static let strip: CGFloat = 20
        /// The dismissal ×. Under the strip, so it does not read as a chip that
        /// wandered up a row, and well over the glyph it holds, so the box is
        /// what takes the click.
        static let dismiss: CGFloat = 17
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
                // The chevron rides with the title rather than sitting at the
                // far edge: it is the title's own affordance — press here and
                // this opens — and at the edge it read as belonging to the card
                // as a whole, next to a × that means something else entirely.
                // The title truncates first, so the chevron follows it wherever
                // it ends.
                HStack(spacing: 5) {
                    Text(card.title)
                        .font(Typography.title)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        // The title is the first thing truncated and the thing
                        // most worth reading, so the whole of it stays reachable.
                        .help(card.title)
                    Image(systemName: "chevron.down")
                        .font(Typography.Icon.chevron)
                        .foregroundStyle(Palette.faint)
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                        .animation(Motion.disclosure(reduceMotion: reduceMotion), value: isExpanded)
                        .frame(width: 10)
                }
                Spacer(minLength: 6)
                // Top right, and its slot is held whether or not it is showing.
                // Revealing it on hover would reflow the row at the moment the
                // pointer arrives, which moves the target while it is being
                // aimed at — so it fades in instead, in space that was always
                // its own.
                if let dismiss {
                    dismissButton(dismiss)
                        .opacity(isHovering || dismissArmed ? 1 : 0)
                        .allowsHitTesting(isHovering || dismissArmed)
                        .animation(Motion.disclosure(reduceMotion: reduceMotion),
                                   value: isHovering || dismissArmed)
                }
            }
            // The status leads the links: where the card has got to, then the places
            // to go and look at it. The pill holds the row's height on its own, so a
            // card with no links is still the same height as one with four.
            HStack(spacing: 6) {
                pill
                links
                if project != nil {
                    Spacer(minLength: 6)
                    projectChip
                }
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

    /// Quiet on purpose. The status pill is the loud thing on this row, and a
    /// second filled badge beside it would compete for the same glance. This sits
    /// at the far edge and answers "whose board is this" only when asked.
    @ViewBuilder private var projectChip: some View {
        if let project {
            Text(project)
                .font(Typography.label)
                .foregroundStyle(Palette.faint)
                .lineLimit(1)
                .padding(.horizontal, 5)
                .frame(height: Metrics.strip)
                .background(Palette.rule.opacity(0.6), in: RoundedRectangle.squircle(5))
                .help("project: \(project)")
        }
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
            Chip(help: workspaceHelp,
                 absent: isCloud ? "No cloud session" : "No workspace",
                 kind: .workspace(isCloud: isCloud),
                 url: card.workspaceUrl, open: open, copied: copied)
            // The only chip that carries text, so the only one that has to be told
            // a width — every label goes through `PRChipLabel`, including the
            // stand-in for a card with no PR at all.
            Chip(label: PRChipLabel.text(num: card.num, prUrl: card.prUrl, stackCount: stack.count),
                 labelWidth: prLabelWidth,
                 help: prHelp,
                 absent: "No pull request yet",
                 kind: .pullRequest(isDraft: card.draft, stacked: stack.count > 1),
                 url: card.prUrl, open: open, copied: copied,
                 // A stacked chip has three places to go, so pressing it asks which
                 // rather than picking one.
                 pressed: stack.count > 1 ? { chose($0, stack, .pullRequest) } : nil)
            Chip(help: card.ticketKey.map { "\(ticketNoun) \($0)" } ?? ticketNoun,
                 absent: "No \(ticketNoun.lowercased())",
                 kind: .ticket(isLinear: trackerKind == "linear"),
                 url: card.ticketUrl, open: open, copied: copied)
            // The only one whose label said nothing the icon does not. Unchanged on
            // a stacked card — a preview is a preview however many there are — but
            // it asks which one, the same way the pull-request chip does.
            // The preview refreshes on every push; while the deploy is still
            // building, the chip says so instead of sitting there looking live.
            // That matters most in the empty slot, which on its own cannot tell
            // "this project has no previews" from "the first one is seconds
            // away" — so when there is nothing to open yet, the spinner is the
            // only thing saying one is coming, and the hover has to agree.
            Chip(help: previews.count > 1 ? "\(previews.count) preview deployments — click to choose one"
                                          : previewHelp,
                 absent: absentPreviewHelp,
                 kind: .preview(pending: card.previewPending == true),
                 url: previewUrl, open: open, copied: copied,
                 pressed: previews.count > 1 ? { chose($0, previews, .preview) } : nil)
        }
    }

    /// The × that takes a card off the board. Built like the chips below it —
    /// a squircle that fills under the pointer — because it is a button, and
    /// the glyph alone was one: a 14pt mark is a 14pt target, and the operator
    /// had to hunt for it. The box is what takes the click, not the ink, which
    /// is what lets the mark itself stay small.
    private func dismissButton(_ dismiss: @escaping () -> Void) -> some View {
        Button {
            if dismissArmed {
                dismissArmed = false
                dismiss()
            } else {
                dismissArmed = true
            }
        } label: {
            Image(systemName: "xmark")
                .font(Typography.Icon.dismiss)
                .foregroundStyle(dismissArmed
                    ? Palette.foreground(.bad)
                    : (isHoveringDismiss ? Palette.ink : Palette.soft))
                .frame(width: Metrics.dismiss, height: Metrics.dismiss)
                .background(dismissBackground, in: RoundedRectangle.squircle(5))
                .overlay(RoundedRectangle.squircle(5)
                    .stroke(dismissArmed ? Palette.foreground(.bad).opacity(0.9) : .clear,
                            lineWidth: 1))
                // The whole box, not the glyph's own bounds.
                .contentShape(RoundedRectangle.squircle(5))
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            isHoveringDismiss = hovering
            if !hovering { dismissArmed = false }
        }
        .help(dismissArmed
            ? "Click again to take this card off the board"
            : "Dismiss — take this card off the board (click twice). "
                + "The work is untouched; `board undismiss` puts it back.")
    }

    /// Armed is the loud state, so it is the one that fills. Hover is the chips'
    /// own quiet lift.
    private var dismissBackground: Color {
        if dismissArmed { return Palette.background(.bad) }
        return isHoveringDismiss ? Palette.ink.opacity(0.09) : .clear
    }

    private var isCloud: Bool { host == "cloud" }

    /// A cloud session has no workspace name to show — it is named by its task on
    /// claude.ai — so the chip says what it opens instead.
    private var workspaceHelp: String {
        if isCloud { return card.workspace ?? "Cloud session on claude.ai" }
        return card.workspace ?? "Superset workspace"
    }

    /// What the ticket chip calls itself. Linear keeps "issue", which is Linear's
    /// own word for it; anything else is a "ticket", because one neutral word beats
    /// guessing at each tracker's vocabulary.
    private var ticketNoun: String {
        trackerKind == "linear" ? "Linear issue" : "\(trackerKind.capitalized) ticket"
    }

    /// The PRs in the stack that deployed something, bottom first. Empty on an
    /// ordinary card, whose one preview is on the card already.
    private var previews: [StackRow] {
        stack.count > 1 ? stack.filter { $0.previewUrl != nil } : []
    }

    /// The card's preview is the tip's, and a stack's tip need not be the member
    /// that deployed — a draft at the top of three often has no preview while the
    /// PR under it does. Falling back to the stack keeps the chip live in that case
    /// rather than showing an empty slot beside three deployments.
    private var previewUrl: String? {
        card.previewUrl ?? previews.last?.previewUrl
    }

    /// Said when the single preview is rebuilding: the chip's hover names what
    /// the spinner shows.
    private var previewHelp: String {
        card.previewPending == true ? "Preview deployment — rebuilding…" : "Preview deployment"
    }

    /// Said when there is nothing to open. "Building" rather than "rebuilding":
    /// there is no previous deployment to replace, which is exactly why the
    /// empty slot is worth explaining.
    private var absentPreviewHelp: String {
        card.previewPending == true
            ? "First preview deployment — building…"
            : "No preview deployment"
    }

    /// A stacked chip names what it stands for, in the order the PRs have to land,
    /// and says that pressing it is a choice rather than a link.
    private var prHelp: String {
        guard stack.count > 1 else {
            let noun = card.draft ? "Draft pull request" : "Open pull request"
            return prTitle.map { "\(noun) — \($0)" } ?? noun
        }
        return "\(stack.count) stacked pull requests: "
            + stack.map { "#\($0.number)" }.joined(separator: " ← ")
            + " — click to choose one"
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
        /// `isCloud` swaps the window glyph for a cloud — the chip opens a browser
        /// tab on claude.ai rather than the Superset app on this machine.
        case workspace(isCloud: Bool)
        /// `stacked` when the card stands for several PRs at once.
        case pullRequest(isDraft: Bool, stacked: Bool = false)
        /// `isLinear` picks the drawn mark over a named symbol — see `glyph`.
        case ticket(isLinear: Bool)
        /// `pending` swaps the globe for a spinner — the deployment the URL
        /// points at is being replaced right now.
        case preview(pending: Bool)

        /// `arrow.triangle.pull` is the closest thing SF Symbols has to GitHub's own
        /// `git-pull-request` glyph, and it is the same shape. Linear has no symbol
        /// at all, so it is drawn — see `glyph`.
        var icon: String? {
            switch self {
            // Linear has no SF Symbol, so it is drawn. Every other tracker takes
            // the generic tag rather than borrowing a mark that is not theirs.
            case .ticket(let isLinear): isLinear ? nil : "tag"
            case .workspace(let isCloud): isCloud ? "cloud" : "macwindow"
            // The count beside it says how many; the glyph says that there is more
            // than one at all, from across the panel and before the label is read.
            case .pullRequest(_, let stacked): stacked ? "square.stack" : "arrow.triangle.pull"
            // The spinner is drawn, not named — see `glyph`.
            case .preview(let pending): pending ? nil : "globe"
            }
        }

        /// The pull request is the only chip that carries a colour. It is the one
        /// whose colour means something — GitHub greys a draft and greens an open
        /// PR, and the board says the same thing in the same values. Giving the
        /// others their brand colours too only made the row noisier.
        var accent: Color? {
            switch self {
            case .pullRequest(let isDraft, _):
                isDraft ? Palette.Brand.gitHubDraft : Palette.Brand.gitHubOpen
            case .workspace, .ticket, .preview: nil
            }
        }

        var lifted: Color? {
            switch self {
            case .pullRequest(let isDraft, _):
                isDraft ? Palette.Brand.gitHubDraftLifted : Palette.Brand.gitHubOpenLifted
            case .workspace, .ticket, .preview: nil
            }
        }
    }

    /// Only the pull request still shows text — its number is the one identifier
    /// short enough to sit in the row. The rest are their icon and their tooltip.
    var label: String?
    /// One width for the label on every card, so the chips after it start at the
    /// same x whether it reads `PR-538`, `PR-1382` or `×3`. Nil sizes to the text.
    var labelWidth: CGFloat? = nil
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
    /// Set when a press means something other than following `url` — the stacked
    /// pull-request chip, which raises a chooser instead. It is handed the chip's
    /// frame, so whatever it raises can be put over the chip.
    var pressed: ((CGRect) -> Void)? = nil

    @State private var isHovering = false
    /// The chip's place in the panel, kept rather than read at the moment it is
    /// needed: both the confirmation and the chooser are drawn at panel level and
    /// have to be told where the chip they belong to is.
    @State private var frame: CGRect = .zero

    private var isLive: Bool { url != nil }

    var body: some View {
        if let url {
            Button { press(url) } label: { box }
                .fixedSize(horizontal: true, vertical: false)
                .buttonStyle(.plain)
                // Measured in the panel's own space, which is the space anything
                // drawn over the chip has to be placed in.
                .background {
                    GeometryReader { proxy in
                        Color.clear.onChange(
                            of: proxy.frame(in: .named(BoardPanel.coordinateSpace)),
                            initial: true
                        ) { _, rect in frame = rect }
                    }
                }
                .overlay {
                    RightClickCatcher {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(url, forType: .string)
                        copied(frame)
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

    private func press(_ url: String) {
        if let pressed { pressed(frame) } else { open(url) }
    }


    private var box: some View {
        HStack(spacing: 4) {
            glyph
            if let label {
                Text(label)
                    .font(Typography.label)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    // Centred in its column: a count is much shorter than a number,
                    // and left-aligning it would leave the chip looking half empty.
                    .frame(width: labelWidth)
            }
        }
        .foregroundStyle(foreground)
        .frame(height: 14)
        .padding(.horizontal, label == nil ? 6 : 5)
        .padding(.vertical, 3)
        .background(background, in: RoundedRectangle.squircle(5))
        .overlay(RoundedRectangle.squircle(5).stroke(border, lineWidth: 1))
    }

    /// One box for every glyph. SF Symbols do not share an advance width — a stack
    /// is narrower than a pull-request arrow — so without this the two pull-request
    /// chips came out different widths however carefully their labels were sized,
    /// and the chips after them stepped in and out down the column.
    private static let glyphWidth: CGFloat = 12

    @ViewBuilder private var glyph: some View {
        if kind == .ticket(isLinear: true) {
            // Drawn rather than named: it is a Shape, so it takes a fill instead of
            // inheriting the stack's foreground style.
            LinearMark().fill(foreground).frame(width: 11, height: 11)
                .frame(width: Self.glyphWidth)
        } else if case .preview(pending: true) = kind {
            DeploySpinner().frame(width: Self.glyphWidth)
        } else if let icon = kind.icon {
            Image(systemName: icon)
                .font(Typography.Icon.chip)
                .frame(width: Self.glyphWidth)
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

/// The deploy in flight: a dotted circle turning, doing the system spinner's job
/// inside the chip's own 12pt frame and inheriting the chip's ink. Still under
/// reduced motion — a perpetually turning element is exactly the motion being
/// declined — where the dotted circle alone carries "not finished yet".
private struct DeploySpinner: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var spinning = false

    var body: some View {
        Image(systemName: "circle.dotted")
            .font(Typography.Icon.chip)
            .rotationEffect(.degrees(spinning ? 360 : 0))
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.linear(duration: 1.4).repeatForever(autoreverses: false)) {
                    spinning = true
                }
            }
    }
}
