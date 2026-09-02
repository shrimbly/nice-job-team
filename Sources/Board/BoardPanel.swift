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
    /// Which tab is up, kept across launches like the expansion set. Stored as a
    /// raw string because @AppStorage is; read through `tab`.
    @AppStorage("selectedTab") private var selectedTabRaw = Tab.board.rawValue
    @State private var now = Date()
    @State private var copied: CopiedAt?
    @State private var dismissCopied: Task<Void, Never>?
    @State private var chooser: ChooserAt?
    /// What the cards come to, measured from inside the scroll view.
    ///
    /// A scroll view lays its content out against an unbounded proposal on the
    /// scroll axis, so this is the cards' own height and owes nothing to the
    /// window's. Giving the scroll view that height back is what stops it taking
    /// every point it is offered — which is what left the panel unable to grow when
    /// a card opened, or to shrink when one closed.
    @State private var cardsHeight: CGFloat = 0
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

    /// The margin around the cards and the gap between them are one number, so the
    /// stack reads as evenly spaced rather than as cards inset inside a frame.
    private static let cardSpacing: CGFloat = 8

    enum Tab: String {
        case board
        case reviews
    }

    private var tab: Tab {
        get { Tab(rawValue: selectedTabRaw) ?? .board }
        nonmutating set { selectedTabRaw = newValue.rawValue }
    }

    /// The rule and the footer under the cards, and now the tab strip above
    /// them. Taken off the room on screen so the cap below is the room the
    /// *cards* have, not the room the panel has.
    private static let chrome: CGFloat = 32 + tabsHeight
    /// The strip's own height: 7pt padding around a body-size tab, plus its rule.
    private static let tabsHeight: CGFloat = 40

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

    /// The chip that was pressed, what it stands for, and which of its links the
    /// rows lead to.
    private struct ChooserAt: Equatable {
        let rect: CGRect
        let prs: [StackRow]
        let target: StackMenu.Target
    }

    /// The width the panel is fixed to. The chooser is placed against it, so a chip
    /// near the right edge does not raise a menu that hangs off the side.
    private static let width: CGFloat = 388

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
    ///
    /// This only says anything once nothing in the panel is greedy. The hosting view
    /// lays the root out at the window's content size, so a view that takes whatever
    /// height it is offered makes this a tautology — the panel asking the window to
    /// be the size it already is, which `resize(to:)` then discards. The scroll view
    /// was that view; see `cardsHeight`.
    private var measure: some View {
        GeometryReader { proxy in
            Color.clear.onChange(of: proxy.size, initial: true) { _, size in onResize(size) }
        }
    }

    /// The same idiom, for the cards. Through `onChange` rather than written
    /// straight from the reader's body, so the assignment lands after the layout
    /// pass that produced it rather than in the middle of it.
    private var measureCards: some View {
        GeometryReader { proxy in
            Color.clear.onChange(of: proxy.size.height, initial: true) { _, height in
                cardsHeight = height
            }
        }
    }

    private var panel: some View {
        VStack(spacing: 0) {
            // The one piece of chrome above the cards: which of the two lists is
            // up, with both counts always readable. (There is still no title row —
            // the tabs say what the lists are.)
            tabs
            Divider().overlay(Palette.rule)
            if tab == .reviews {
                reviewsContent
            } else if store.cards.isEmpty {
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
                                stack: entry.stack,
                                trackerKind: entry.trackerKind,
                                host: entry.host,
                                prTitle: entry.prTitle,
                                pillWidth: pillWidth,
                                prLabelWidth: prLabelWidth,
                                isExpanded: expanded.contains(entry.id),
                                toggle: { toggle(entry.id) },
                                open: openLink,
                                copied: showCopied,
                                chose: showChooser)
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
                    .background(measureCards)
                }
                // A definite height, and deliberately not `maxHeight`. A maximum is
                // a licence to expand: the view takes everything it is offered up to
                // that bound, which is what a scroll view does anyway, and it was
                // the cap — not the scroll view — that kept the panel pinned to the
                // window's height and unable to report a size of its own.
                //
                // Nil until the cards have been measured. That is the state the
                // panel is in when `toggle()` asks for `fittingSize`, and an
                // unspecified proposal is the one proposal a scroll view answers
                // with what it holds.
                .frame(height: cardsHeight > 0 ? min(cardsHeight, maxCardsHeight) : nil,
                       alignment: .top)
            }
            Divider().overlay(Palette.rule)
            footer
        }
        .frame(width: Self.width)
        .background(Palette.bg)
        .coordinateSpace(name: Self.coordinateSpace)
        // Drawn at panel level so it is not clipped by the card or the scroll view.
        // Unlike the confirmation this one is there to be clicked, so it is also
        // laid over a catcher that takes a click anywhere else and puts it away.
        .overlay {
            if let chooser {
                Color.black.opacity(0.001)
                    .contentShape(Rectangle())
                    .onTapGesture { hideChooser() }
                StackMenu(prs: chooser.prs,
                          target: chooser.target,
                          rise: StackMenu.rise(from: chooser.rect, count: chooser.prs.count),
                          open: { url in openLink(url); hideChooser() })
                    .transition(.opacity)
                    .position(StackMenu.restingCentre(above: chooser.rect,
                                                      count: chooser.prs.count,
                                                      panelWidth: Self.width))
            }
        }
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
        // A menu left standing would be waiting over a card that is no longer there
        // when the panel is next opened.
        .onChange(of: presentation.isOpen) { _, isOpen in if !isOpen { chooser = nil } }
        .onChange(of: store.cards.map(\.id)) { _, _ in chooser = nil }
        .onDisappear { dismissCopied?.cancel() }
    }

    // MARK: - Tabs

    private var tabs: some View {
        HStack(spacing: 6) {
            tabButton(.board, label: "Board", count: "\(store.cards.count)")
            tabButton(
                .reviews, label: "Reviews",
                count: store.reviewsAvailable || !store.reviews.isEmpty
                    ? "\(store.reviews.count)" : "—")
            Spacer()
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
    }

    private func tabButton(_ target: Tab, label: String, count: String) -> some View {
        let isActive = tab == target
        return Button {
            tab = target
            chooser = nil
        } label: {
            HStack(spacing: 5) {
                // The card-title face exactly — the tabs name the lists the way
                // a title names a card, and two nearly-equal styles read as a
                // mistake rather than a hierarchy.
                Text(label)
                    .font(Typography.title)
                    .foregroundStyle(isActive ? Palette.ink : Palette.faint)
                // The count is information, not an alert: it stays in the
                // neutral ramp whatever it says, and the tab badge alone is
                // what marks the queue.
                Text(count)
                    .font(Typography.title)
                    .monospacedDigit()
                    .foregroundStyle(isActive ? Palette.soft : Palette.faint.opacity(0.8))
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(
                isActive ? Palette.rule.opacity(0.75) : .clear,
                in: RoundedRectangle.squircle(5))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Reviews

    @ViewBuilder private var reviewsContent: some View {
        if store.reviews.isEmpty {
            reviewsEmpty
        } else {
            ScrollView {
                VStack(spacing: Self.cardSpacing) {
                    ForEach(Array(store.reviews.enumerated()), id: \.element.review.ref) { index, entry in
                        ReviewRow(
                            review: entry.review,
                            project: store.showsProjects ? entry.shortName : nil,
                            pillWidth: reviewPillWidth,
                            actionsEnabled: store.orchestratorPresent,
                            isStarting: store.startingReview == entry.review.ref,
                            open: openLink,
                            copied: showCopied,
                            start: { startReview(entry.review) },
                            dismiss: { dismissReview(entry.review) })
                            .blur(radius: presentation.isOpen ? 0 : Motion.cardBlur(reduceMotion: reduceMotion))
                            .opacity(presentation.isOpen ? 1 : 0)
                            .animation(Motion.cardReveal(index: index, reduceMotion: reduceMotion),
                                       value: presentation.isOpen)
                    }
                }
                .padding(Self.cardSpacing)
                .background(measureCards)
            }
            .frame(height: cardsHeight > 0 ? min(cardsHeight, maxCardsHeight) : nil,
                   alignment: .top)
        }
    }

    /// "Queue is clear" and "this CLI predates reviews" must not read the same —
    /// the exact distinction the boardless empty state already draws.
    private var reviewsEmpty: some View {
        Text(store.reviewsAvailable
            ? "No PRs waiting on your review."
            : "This board's CLI doesn't report reviews yet.\nUpdate superset-board to see them here.")
            .font(Typography.body)
            .lineSpacing(Typography.bodyLineSpacing)
            .foregroundStyle(Palette.faint)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 20)
            .padding(.vertical, 26)
    }

    private func startReview(_ review: Review) {
        Task {
            if let url = await store.startReview(review) {
                openLink(url)
            }
        }
    }

    private func dismissReview(_ review: Review) {
        withAnimation(Motion.disclosure(reduceMotion: reduceMotion)) {
            // The store removes the row optimistically; the animation here is
            // what lets the rows below travel up rather than snap.
        }
        Task { await store.dismissReview(review) }
    }

    // MARK: -


    private var footer: some View {
        HStack(spacing: 10) {
            Text(status)
                .font(Typography.footer)
                .foregroundStyle(statusColor)
                .lineLimit(1)
                .truncationMode(.tail)
                .help(store.lastError ?? store.note ?? "")
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
        Text(emptyMessage)
            .font(Typography.body)
            .foregroundStyle(Palette.faint)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 20)
            .padding(.vertical, 26)
    }

    /// An unconfigured board says so, and says what to do about it. It used to read
    /// "Nothing on the board", which is what a quiet morning looks like — the one
    /// message that must not be shown when the truth is that nothing is watched.
    private var emptyMessage: String {
        if store.lastError != nil { return "No board — see below." }
        guard store.hasRepos else {
            return "No repository configured.\nRun board init, or set BOARD_REPOS=owner/name."
        }
        return "Nothing on the board."
    }


    /// "polled Xm ago" comes from the document's own generatedAt — when the board
    /// was actually polled — never from the local clock of the read.
    private var status: String {
        if store.isRefreshing { return "refreshing…" }
        if let error = store.lastError {
            guard let retry = store.retryingIn else { return error }
            return "\(error) · retrying in \(Int(retry.rounded()))s"
        }
        var parts = ["polled \(RelativeTime.short(store.lastUpdated, now: now))"]
        // The CLI's degradation note, verbatim: the board is standing on stale or
        // partial PR data, and the note says which call failed.
        if let note = store.note { parts.append(note) }
        if !store.orchestratorPresent { parts.append("github only") }
        if tab == .reviews && !store.reviews.isEmpty {
            parts.append("\(store.reviews.count) awaiting review")
        }
        return parts.joined(separator: " · ")
    }

    /// A degraded render is worth a glance, not an alarm: the cards still stand,
    /// on the last data the CLI had.
    private var statusColor: Color {
        if store.lastError != nil { return Palette.foreground(.bad) }
        return store.usingStalePullRequests ? Palette.foreground(.you) : Palette.faint
    }

    /// Computed here rather than in the card, because it is a property of the board
    /// as a whole — every pill has to agree on it for the column to be a column.
    private var pillWidth: CGFloat {
        PillColumn.width(for: store.cards.map(\.card))
    }

    /// The same, for the one chip that carries text.
    private var prLabelWidth: CGFloat {
        PRChipColumn.labelWidth(for: store.cards)
    }

    /// One width for every author pill on the Reviews tab, so the chips beside
    /// them start at the same x on every row.
    private var reviewPillWidth: CGFloat {
        PillColumn.width(forAuthors: store.reviews.map(\.review.author))
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

    /// The chooser comes up on the same curve the confirmation does, and goes away
    /// on the same one — a press over a chip is answered the same way whatever it
    /// raises. A second press on the same chip puts it away again.
    private func showChooser(at rect: CGRect, prs: [StackRow], target: StackMenu.Target) {
        let next = ChooserAt(rect: rect, prs: prs, target: target)
        guard chooser != next else { return hideChooser() }
        withAnimation(Motion.copiedIn(reduceMotion: reduceMotion)) { chooser = next }
    }

    private func hideChooser() {
        withAnimation(Motion.copiedOut(reduceMotion: reduceMotion)) { chooser = nil }
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
