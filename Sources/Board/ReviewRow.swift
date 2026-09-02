import AppKit
import BoardKit
import SwiftUI

/// One PR awaiting the operator's review. Two fixed rows like a card — the
/// title, then who is asking and where to go — but nothing expands: a review
/// is somebody else's work, and everything the operator does with it happens
/// on GitHub or in the review workspace, not here.
struct ReviewRow: View {
    let review: Review
    /// Which project this review came from, or nil when only one is running.
    var project: String? = nil
    /// One width for every author pill on the queue — see `PillColumn`.
    let pillWidth: CGFloat
    /// Whether the CLI-backed actions (start a review workspace, dismiss) are
    /// offered — false in github-only mode, where there is no root to record
    /// either in.
    var actionsEnabled: Bool = true
    /// True while `board review start` is running for this row.
    var isStarting: Bool = false
    let open: (String) -> Void
    let copied: (CGRect) -> Void
    /// Starts the review workspace — async work the store owns.
    let start: () -> Void
    /// Dismisses the review for good.
    let dismiss: () -> Void

    @State private var isHoveringDismiss = false
    /// A dismissal is permanent, so it takes two clicks: the first arms and
    /// colours the ×, the second dismisses. Leaving the button disarms — an
    /// armed × the pointer wandered away from must not fire a week later.
    @State private var dismissArmed = false

    private enum Metrics {
        static let inset: CGFloat = 8
        static let gap: CGFloat = 9
        static let strip: CGFloat = 20
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: Metrics.gap) {
                Text(review.title)
                    .font(Typography.title)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(review.title)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if actionsEnabled {
                    // In the slot the chevron holds on a card, because a review
                    // row's one "put this away" affordance and a card's one
                    // disclosure affordance should sit in the same place.
                    Button {
                        if dismissArmed {
                            dismissArmed = false
                            dismiss()
                        } else {
                            dismissArmed = true
                        }
                    } label: {
                        Image(systemName: "xmark")
                            .font(dismissArmed ? Typography.Icon.confirmation : Typography.Icon.chevron)
                            .foregroundStyle(dismissArmed
                                ? Palette.foreground(.bad)
                                : (isHoveringDismiss ? Palette.ink : Palette.faint))
                            .frame(width: 14)
                    }
                    .buttonStyle(.plain)
                    .onHover { hovering in
                        isHoveringDismiss = hovering
                        if !hovering { dismissArmed = false }
                    }
                    .help(dismissArmed
                        ? "Click again to dismiss for good"
                        : "Dismiss — never show this pull request on the board again (click twice)")
                }
            }
            HStack(spacing: 6) {
                authorPill
                HStack(spacing: 4) {
                    if actionsEnabled { reviewChip }
                    ReviewChip(
                        label: "#\(review.number)",
                        help: prHelp,
                        icon: "arrow.triangle.pull",
                        accent: review.isDraft ? Palette.Brand.gitHubDraft : Palette.Brand.gitHubOpen,
                        lifted: review.isDraft ? Palette.Brand.gitHubDraftLifted : Palette.Brand.gitHubOpenLifted,
                        url: review.url, open: open, copied: copied)
                    ReviewChip(
                        help: "Preview deployment",
                        absent: "No preview deployment",
                        icon: "globe",
                        url: review.previewUrl, open: open, copied: copied)
                }
                Spacer(minLength: 6)
                if let project { projectChip(project) }
                if let age {
                    Text(age)
                        .font(Typography.meta)
                        .foregroundStyle(Palette.faint)
                        .monospacedDigit()
                        .help(review.updatedAt ?? "")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(Metrics.inset)
        .background(Palette.card)
        .clipShape(RoundedRectangle.squircle(8))
        .overlay(RoundedRectangle.squircle(8).stroke(Palette.rule, lineWidth: 1))
        .geometryGroup()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Review requested by \(review.author). \(review.title)")
    }

    /// Who is asking, in the pill slot. Every review row is in the same state,
    /// so a REVIEW pill on each would say nothing — the author is the scannable
    /// dimension. Drafts go grey, like everywhere else on the board.
    private var authorPill: some View {
        // Names are normalised to ten characters and every pill takes the same
        // measured width, so the chips beside them start at the same x on every
        // row — the full login stays on the hover.
        Text(PillColumn.normalisedAuthor(review.author))
            .font(Typography.pill)
            .tracking(Typography.uppercaseTracking)
            .foregroundStyle(Palette.foreground(review.isDraft ? .mute : .review))
            .lineLimit(1)
            .frame(width: pillWidth, height: Metrics.strip)
            .background(
                Palette.background(review.isDraft ? .mute : .review),
                in: RoundedRectangle.squircle(5))
            .help(review.isDraft
                ? "Draft — opened by \(review.author)"
                : "Opened by \(review.author)")
    }

    /// The one filled action chip on the board: it runs something (a review
    /// workspace with an agent in it) rather than opening a link, and the fill
    /// is what says so.
    private var reviewChip: some View {
        Button(action: start) {
            HStack(spacing: 4) {
                if isStarting {
                    ProgressView()
                        .controlSize(.mini)
                        .frame(width: 12, height: 12)
                } else {
                    Image(systemName: "macwindow")
                        .font(Typography.Icon.chip)
                        .frame(width: 12)
                }
                Text(isStarting ? "Starting…" : "Review")
                    .font(Typography.label)
            }
            .foregroundStyle(Palette.foreground(.agent))
            .padding(.horizontal, 7)
            .frame(height: Metrics.strip)
            .background(Palette.background(.agent), in: RoundedRectangle.squircle(5))
        }
        .buttonStyle(.plain)
        .disabled(isStarting)
        .help("Open a review workspace — a Superset workspace on the PR's branch, with an agent reading the diff")
    }

    private func projectChip(_ project: String) -> some View {
        Text(project)
            .font(Typography.label)
            .foregroundStyle(Palette.faint)
            .lineLimit(1)
            .padding(.horizontal, 5)
            .frame(height: Metrics.strip)
            .background(Palette.rule.opacity(0.6), in: RoundedRectangle.squircle(5))
            .help("project: \(project)")
    }

    private var prHelp: String {
        let noun = review.isDraft ? "Draft pull request" : "Open pull request"
        return "\(noun) by \(review.author)"
    }

    private var age: String? {
        guard let date = review.updatedAtDate else { return nil }
        return RelativeTime.short(date, now: Date())
    }
}

/// A link chip in a review row — the card `Chip`'s look (glyph, optional label,
/// hover accent, right-click copy, absent slot) without its stack plumbing.
private struct ReviewChip: View {
    var label: String? = nil
    let help: String
    var absent: String = ""
    let icon: String
    var accent: Color? = nil
    var lifted: Color? = nil
    let url: String?
    let open: (String) -> Void
    let copied: (CGRect) -> Void

    @State private var isHovering = false
    @State private var frame: CGRect = .zero

    private var isLive: Bool { url != nil }

    var body: some View {
        if let url {
            Button { open(url) } label: { box }
                .fixedSize(horizontal: true, vertical: false)
                .buttonStyle(.plain)
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
            box
                .fixedSize(horizontal: true, vertical: false)
                .help(absent)
                .accessibilityHidden(true)
        }
    }

    private var box: some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(Typography.Icon.chip)
                .frame(width: 12)
            if let label {
                Text(label)
                    .font(Typography.label)
                    .lineLimit(1)
            }
        }
        .foregroundStyle(foreground)
        .frame(height: 14)
        .padding(.horizontal, label == nil ? 6 : 5)
        .padding(.vertical, 3)
        .background(background, in: RoundedRectangle.squircle(5))
        .overlay(RoundedRectangle.squircle(5).stroke(border, lineWidth: 1))
    }

    private var foreground: Color {
        guard isLive else { return Palette.faint.opacity(0.6) }
        if let accent { return isHovering ? (lifted ?? accent) : accent }
        return isHovering ? Palette.ink : Palette.soft
    }

    private var background: Color {
        guard isLive else { return .clear }
        if let accent { return isHovering ? accent.opacity(0.22) : .clear }
        return isHovering ? Palette.ink.opacity(0.09) : .clear
    }

    private var border: Color {
        guard isLive else { return Palette.rule2.opacity(0.55) }
        if let accent { return accent.opacity(isHovering ? 0.95 : 0.4) }
        return isHovering ? Palette.soft : Palette.rule2
    }
}
