import AppKit
import BoardKit
import SwiftUI

struct BoardPanel: View {
    let store: BoardStore
    let presentation: PanelPresentation
    let openLink: (String) -> Void
    /// The window is sized from here rather than the other way round: the panel's
    /// height follows the board and whichever cards are open, and nothing outside
    /// SwiftUI knows what that comes to.
    let onResize: (CGSize) -> Void

    /// Which cards are open, kept across refreshes and across launches — the same
    /// thing the dashboard keeps in localStorage.
    ///
    /// What is drawn comes from `liveExpanded`, not from here. A write to
    /// `@AppStorage` goes out to UserDefaults and arrives back as a change
    /// notification on a later turn of the run loop, by which time the
    /// `withAnimation` that made it is long gone and the card just snaps open. The
    /// stored copy is for the next launch; this one is for this frame.
    @AppStorage("expandedCards") private var expandedRaw = ""
    @State private var liveExpanded: Set<String>?
    @State private var now = Date()
    @State private var copied: CopiedAt?
    @State private var dismissCopied: Task<Void, Never>?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The panel is the frame of reference for the copy confirmation, so a chip
    /// anywhere in the scroll view can be pointed at.
    static let coordinateSpace = "board-panel"

    /// Transparent room around the panel for its shadow to fall into. The window
    /// is this much bigger than the panel on every side, and the controller has to
    /// know by how much to put the panel's visible edge under the menu bar item.
    static let shadowMargin: CGFloat = 28

    /// The window is borderless, so the panel draws its own corners. A system
    /// popover's radius, which is what this still is.
    private static let corner: CGFloat = 12

    /// A refresh costs one point of the 5,000-per-hour GraphQL budget, so Board
    /// spends about 60 an hour. Below this, something else is eating the token and
    /// that is worth saying; above it the number is just a number.
    private static let lowQuota = 1000

    /// The margin around the cards and the gap between them are one number, so the
    /// stack reads as evenly spaced rather than as cards inset inside a frame.
    private static let cardSpacing: CGFloat = 8

    /// The rule and the footer under the cards. Taken off the room on screen so the
    /// cap below is the room the *cards* have, not the room the panel has.
    private static let chrome: CGFloat = 32

    /// Enough for two cards with one of them open. Below this the cap is doing more
    /// harm than the scrolling it avoids — on a short screen, or against a menu bar
    /// item that is somehow near the bottom, the board should still be usable.
    private static let minCardsHeight: CGFloat = 260

    /// The cards take the screen they have rather than a number chosen in advance.
    /// A card opening grows the panel until this is reached, and scrolls after it.
    private var maxCardsHeight: CGFloat {
        max(Self.minCardsHeight, presentation.availableHeight - Self.chrome)
    }

    private struct CopiedAt: Equatable {
        let id = UUID()
        let rect: CGRect
    }

    private let tick = Timer.publish(every: 15, on: .main, in: .common).autoconnect()

    var body: some View {
        panel
            .clipShape(RoundedRectangle.squircle(Self.corner))
            // A hairline, because a shadow alone leaves the edge undefined against a
            // light desktop.
            .overlay(RoundedRectangle.squircle(Self.corner).strokeBorder(Palette.rule, lineWidth: 1))
            // Drawn here rather than by the window, so it scales and fades with the
            // panel instead of arriving whole underneath it.
            .shadow(color: .black.opacity(0.32), radius: 14, y: 6)
            .opacity(presentation.isOpen ? 1 : 0)
            // Anchored to the top, which is the edge the menu bar item is on, so it
            // grows out of the thing that was clicked rather than out of its middle.
            .scaleEffect(revealScale, anchor: .top)
            .padding(Self.shadowMargin)
            .background(measure)
    }

    private var revealScale: CGFloat {
        reduceMotion ? 1 : presentation.scale
    }

    /// Reports the panel's laid-out size, shadow room included, since that is the
    /// size the window has to be.
    private var measure: some View {
        GeometryReader { proxy in
            Color.clear.onChange(of: proxy.size, initial: true) { _, size in onResize(size) }
        }
    }

    private var panel: some View {
        VStack(spacing: 0) {
            // No title row: the menu bar item already carries the count, and the
            // cards say what they are.
            if store.cards.isEmpty {
                empty
            } else {
                ScrollView {
                    // Not lazy. A lazy stack does not animate its own layout, so
                    // opening a card left the ones below it to cross-fade between
                    // their old and new positions rather than travel between them. A
                    // board is tens of cards, not thousands; there was nothing to be
                    // saved by building them late.
                    VStack(spacing: Self.cardSpacing) {
                        ForEach(Array(store.cards.enumerated()), id: \.element.id) { index, entry in
                            CardRow(
                                card: entry.card,
                                project: store.showsProjects ? entry.shortName : nil,
                                pillWidth: pillWidth,
                                isExpanded: expanded.contains(entry.id),
                                toggle: { toggle(entry.id) },
                                open: openLink,
                                copied: showCopied)
                                // Each card resolves out of a blur a beat after the
                                // one above it. Every card takes part now that the
                                // stack builds them all, on screen or not, which is
                                // what the ceiling in `cardReveal` is there for.
                                .blur(radius: presentation.isOpen ? 0 : Motion.cardBlur(reduceMotion: reduceMotion))
                                .opacity(presentation.isOpen ? 1 : 0)
                                .animation(Motion.cardReveal(index: index, reduceMotion: reduceMotion),
                                           value: presentation.isOpen)
                        }
                    }
                    .padding(Self.cardSpacing)
                }
                .frame(maxHeight: maxCardsHeight)
            }
            Divider().overlay(Palette.rule)
            footer
        }
        .frame(width: 388)
        .background(Palette.bg)
        .coordinateSpace(name: Self.coordinateSpace)
        // Drawn at panel level so it is not clipped by the card or the scroll view,
        // and never takes a click that was meant for what is underneath it.
        .overlay {
            if let copied {
                // The rise and the tilt belong to the toast, not to this transition —
                // see `CopiedToast`. All that is left out here is the fade, which is
                // the one part of an entrance that does not care what frame it is
                // applied to.
                CopiedToast(rise: CopiedToast.rise(from: copied.rect))
                    .transition(.opacity)
                    .position(CopiedToast.restingCentre(above: copied.rect))
                    .allowsHitTesting(false)
            }
        }
        .onReceive(tick) { now = $0 }
        .onDisappear { dismissCopied?.cancel() }
    }

    // MARK: -


    private var footer: some View {
        HStack(spacing: 10) {
            Text(status)
                .font(Typography.footer)
                .foregroundStyle(statusColor)
                .lineLimit(1)
                .truncationMode(.tail)
                .help(store.lastError ?? "")
            Spacer()
            Button("Refresh") { store.refreshNow() }
                .buttonStyle(.plain)
                .foregroundStyle(Palette.soft)
                .disabled(store.isRefreshing)
            Button("Quit") { NSApplication.shared.terminate(nil) }
                .buttonStyle(.plain)
                .foregroundStyle(Palette.soft)
        }
        .font(Typography.control)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var empty: some View {
        Text(store.lastError == nil ? "Nothing on the board." : "No board — see below.")
            .font(Typography.body)
            .foregroundStyle(Palette.faint)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 26)
    }


    private var status: String {
        if store.isRefreshing { return "refreshing…" }
        if let error = store.lastError {
            guard let retry = store.retryingIn else { return error }
            return "\(error) · retrying in \(Int(retry.rounded()))s"
        }
        var parts = ["polled \(RelativeTime.short(store.lastUpdated, now: now))"]
        if store.usingStalePullRequests { parts.append("orchestrator's last poll") }
        if !store.orchestratorPresent { parts.append("github only") }
        if isQuotaLow, let quota = store.quotaRemaining { parts.append("quota \(quota)") }
        return parts.joined(separator: " · ")
    }

    private var isQuotaLow: Bool {
        guard let quota = store.quotaRemaining else { return false }
        return quota < Self.lowQuota
    }

    /// The quota only appears when it is low, so when it does appear it should read
    /// as something to look at rather than as more footer text.
    private var statusColor: Color {
        if store.lastError != nil { return Palette.foreground(.bad) }
        return isQuotaLow ? Palette.foreground(.you) : Palette.faint
    }

    /// Computed here rather than in the card, because it is a property of the board
    /// as a whole — every pill has to agree on it for the column to be a column.
    private var pillWidth: CGFloat {
        PillColumn.width(for: store.cards.map(\.card))
    }

    /// Nothing has been opened or shut yet this launch, so what was stored still
    /// stands.
    private var expanded: Set<String> {
        liveExpanded ?? Set(expandedRaw.split(separator: "\u{1}").map(String.init))
    }

    /// Re-copying while a confirmation is up retargets it rather than queueing a
    /// second one, and the pending dismissal is replaced so it cannot cut the new
    /// one short.
    private func showCopied(at rect: CGRect) {
        dismissCopied?.cancel()
        withAnimation(Motion.copiedIn(reduceMotion: reduceMotion)) {
            copied = CopiedAt(rect: rect)
        }
        dismissCopied = Task {
            try? await Task.sleep(for: Motion.copiedDwell)
            guard !Task.isCancelled else { return }
            withAnimation(Motion.copiedOut(reduceMotion: reduceMotion)) { copied = nil }
        }
    }

    /// Animated from here rather than inside the card, because opening one card moves
    /// every card under it and resizes the window — all of which follows from this
    /// one change and should be on the same curve as the card itself.
    private func toggle(_ id: String) {
        var open = expanded
        if open.contains(id) { open.remove(id) } else { open.insert(id) }
        withAnimation(Motion.disclosure(reduceMotion: reduceMotion)) {
            liveExpanded = open
        }
        expandedRaw = open.sorted().joined(separator: "\u{1}")
    }
}
