import AppKit
import BoardKit
import Observation
import SwiftUI

/// The app's own banners, in place of the system's: the events `BoardNotifier`
/// diffs out of the board drop in under the menu-bar item the app lives behind,
/// drawn by the app, attributed to the app, and clicked through to their link —
/// which the osascript route could give neither, delivering banners owned by
/// the automation host and inert to a click.
///
/// One borderless panel hosts the whole stack, sized and placed the way the
/// board panel is: the window follows the SwiftUI content, the top edge held at
/// the underside of the menu-bar item. Suppression while the board panel is up
/// is the caller's to decide — it knows when the operator is already looking.
@MainActor
@Observable
final class ToastCenter {
    private(set) var rows: [Toast] = []

    /// Where a window of this size goes — the status item's underside, from the
    /// controller that owns that geometry.
    private let place: (CGSize) -> NSPoint
    /// How a banner's link opens: the panel's own route, default browser or
    /// Superset app.
    private let open: (String) -> Void

    private var panel: NSPanel!
    private var hosting: NSHostingView<ToastStackView>!
    /// The window outlives the exit animation by the animation's own length.
    private var hideTask: Task<Void, Never>?

    private var reduceMotion: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }

    init(
        place: @escaping (CGSize) -> NSPoint,
        open: @escaping (String) -> Void,
        appearance: NSAppearance? = nil
    ) {
        self.place = place
        self.open = open
        hosting = NSHostingView(rootView: ToastStackView(center: self))
        panel = ToastPanel(
            contentRect: NSRect(x: 0, y: 0, width: ToastStackView.width, height: 1),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        // The window is exactly the stack plus the slide band above it — no
        // shadow margin to draw inside — so the system shadow does the one
        // thing the panel could not let it.
        panel.hasShadow = true
        panel.animationBehavior = .none
        panel.isMovable = false
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        // The same band the board panel sits in: below the menu bar, so the
        // banners can never cover it or its items, above everything else.
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue - 1)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.appearance = appearance
        panel.contentView = hosting
    }

    // MARK: - Posting

    /// One event becomes one banner, and stays until dismissed. The sound is
    /// the audible half of the app's whole job while the panel is shut, as the
    /// status item's count and tint are the visible half.
    func post(_ event: BoardNotification) {
        withAnimation(Motion.bannerIn(reduceMotion: reduceMotion)) {
            rows = BoardToasts.pushing(event, onto: rows)
        }
        hideTask?.cancel()
        hideTask = nil
        NSSound(named: NSSound.Name("Glass"))?.play()
        show()
    }

    /// The board panel is up: it is the surface for the same news now, and a
    /// banner over it would be noise.
    func clear() {
        hideTask?.cancel()
        hideTask = nil
        rows = []
        exiting = []
        frozen = [:]
        panel.orderOut(nil)
    }

    /// The banner was clicked: follow its link — the PR for a merge, the
    /// preview for a preview — and put the banner away, whether or not the link
    /// went anywhere.
    func opened(_ toast: Toast) {
        exit(id: toast.id)
        if let url = toast.event.url { open(url) }
    }

    /// The banner's ✕ was pressed: put it away without following the link.
    func dismiss(_ toast: Toast) {
        exit(id: toast.id)
    }

    /// Banners playing their exit: still drawn, no longer part of the stack.
    private(set) var exiting: Set<UUID> = []

    /// Where a banner stood when it was dismissed — sonner's
    /// `offsetBeforeRemove`. It plays its exit from there, held at that depth
    /// while the stack re-forms past it.
    private(set) var frozen: [UUID: Int] = [:]

    /// The dismissal, and sonner's: one gesture, not two. The banner is out of
    /// the stack's arithmetic the instant it is dismissed, so the banners
    /// behind it start closing over its place immediately and the one queued
    /// out of sight starts fading in — all on the one curve, all at once, while
    /// the dismissed banner goes back up the way it came. Sonner drops a
    /// dismissed toast's height from its list in the same breath for the same
    /// reason: waiting for the exit to finish first reads as a stall and then a
    /// jump.
    ///
    /// Removing the row afterwards moves nothing — the stack closed over its
    /// place four hundred milliseconds ago — but it does hand SwiftUI a
    /// removal to play. The banner keeps its `exiting` flag through that, so
    /// the phantom is drawn at nothing and the flag is dropped only once the
    /// phantom is gone; letting it go any earlier draws the card's border
    /// again, which is the ghost the operator saw.
    private func exit(id: UUID) {
        guard !exiting.contains(id) else { return }
        // Its depth at the moment of dismissal: the banners newer than it that
        // are themselves still in the stack.
        frozen[id] = rows.reversed()
            .prefix { $0.id != id }
            .filter { !exiting.contains($0.id) }
            .count
        withAnimation(Motion.bannerOut(reduceMotion: reduceMotion)) {
            _ = exiting.insert(id)
        }
        Task { [weak self] in
            try? await Task.sleep(for: Motion.bannerOutDuration)
            guard let self, !Task.isCancelled else { return }
            self.rows.removeAll { $0.id == id }
            if self.rows.isEmpty { self.hideWhenSettled() }
            try? await Task.sleep(for: Motion.bannerOutDuration)
            guard !Task.isCancelled else { return }
            self.exiting.remove(id)
            self.frozen[id] = nil
        }
    }

    private func hideWhenSettled() {
        hideTask?.cancel()
        hideTask = Task { [weak self] in
            try? await Task.sleep(for: Motion.bannerOutDuration)
            guard let self, !Task.isCancelled, self.rows.isEmpty else { return }
            self.panel.orderOut(nil)
        }
    }

    // MARK: - The window

    /// The band of clear window above the stack that the slide travels through.
    /// It equals the controller's `toastGap`, so the window's top edge — the
    /// mask the banner slides behind — reaches exactly the menu bar's
    /// underside, and the banner appears to emerge from behind the bar itself
    /// rather than from a line in open air. Idle, the band is fully clear, so
    /// clicks there fall through it at the window server, the way they fall
    /// through any transparent pixel of a non-opaque window.
    static let topInset: CGFloat = 12

    /// The first frame is where it lands: sized and placed before it is ordered
    /// in, as the board panel is.
    private func show() {
        guard !panel.isVisible else { return }
        let fitted = hosting.fittingSize
        let size = fitted.width > 1 && fitted.height > 1 ? fitted : panel.frame.size
        panel.setFrame(NSRect(origin: place(size), size: size), display: false)
        panel.orderFrontRegardless()
    }

    /// The stack's height follows its rows; the window follows the stack, its
    /// top edge held at the menu bar's underside, growing and shrinking
    /// downward the way the board panel does. `size` is the rows' own size —
    /// the measure idiom reports the stack, not the band above it — so the
    /// window's height and the placed origin both have the band added back.
    func resized(to size: CGSize) {
        guard size.width > 1, size.height > 1 else { return }
        let target = NSSize(width: size.width, height: size.height + Self.topInset)
        guard panel.frame.size != target else { return }
        // One frame change and not two. `setContentSize` holds the origin,
        // which is the bottom-left corner, so it takes the height off the top
        // edge — and the origin that puts the top edge back is a second
        // mutation the window server is entitled to draw between. The whole
        // point of the placement is that the top edge never moves.
        panel.setFrame(NSRect(origin: place(target), size: target), display: true)
    }
}

/// The banner window's panel. Like the board panel, it holds its frame against
/// the visible-frame constraint: the slide band reaches the menu bar's
/// underside by design, and the constraint would push the whole stack down by
/// exactly that band.
private final class ToastPanel: NSPanel {
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        frameRect
    }
}

/// The stack as drawn, piled the way sonner piles: collapsed, the newest
/// banner sits in front and the older ones peek beneath it — one gap further
/// down and 5% smaller each, their content hidden — and hovering the pile fans
/// it out, every banner at its own place with its content shown, until the
/// pointer leaves and it falls back into the pile.
struct ToastStackView: View {
    let center: ToastCenter
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Hover on the pile — sonner's `data-expanded`.
    @State private var expanded = false
    /// One row's height, measured off the rows themselves; the fanned-out
    /// offsets are multiples of it.
    @State private var rowHeight: CGFloat = 0

    /// A board card's exact width, and stated as one: a banner is a card, so it
    /// is as wide as the cards on the panel are — the panel's own width less
    /// its card insets.
    static let width: CGFloat = BoardPanel.width - BoardPanel.cardSpacing * 2

    /// The pile's gap — sonner's `--gap`, at the board's card spacing.
    private static let gap: CGFloat = 8
    /// Sonner's scale step per banner behind the front.
    private static let scaleStep: CGFloat = 0.05

    var body: some View {
        // All rows share the front's frame and are transformed from there, as
        // sonner's absolutely-positioned toasts are — a flow layout cannot pile.
        // Oldest first, so later children draw over earlier ones and the front
        // (last) is on top; zIndex keeps that order against the animations.
        ZStack(alignment: .top) {
            ForEach(Array(placed.enumerated()), id: \.element.id) { index, row in
                ToastRow(
                    toast: row.toast,
                    showsContent: row.drawn && (expanded || row.depth == 0),
                    open: { center.opened(row.toast) },
                    dismiss: { center.dismiss(row.toast) })
                    // The exit is played here, on the row's own modifiers,
                    // while its frame is still live: back the way it came, up
                    // under the menu bar it dropped from, fading as it goes —
                    // sonner's `translateY(-100%)` for a toast at the top. It
                    // is composed with the row's own place in the pile, so a
                    // banner dismissed from the middle of a fan leaves from
                    // where it stands rather than from the front.
                    .offset(y: row.leaving ? -rowHeight : 0)
                    // Nothing is drawn past what the pile shows: a banner
                    // queued behind it waits at nothing, and fades up into the
                    // pile when a dismissal makes room — sonner's
                    // `data-visible`, which is opacity and not a mount, so the
                    // arrival is a fade and not a second slide from the top.
                    .opacity(row.leaving || !row.drawn ? 0 : 1)
                    .scaleEffect(scale(for: row.depth), anchor: .center)
                    .offset(y: offset(for: row.depth))
                    .allowsHitTesting(row.drawn && !row.leaving && (expanded || row.depth == 0))
                    .transition(banner)
                    // Newest on top: the front banner must cover the pile
                    // behind it, oldest lowest.
                    .zIndex(Double(index + 1))
                    .background(measureRow)
            }
        }
        .frame(width: Self.width, alignment: .top)
        .animation(Motion.bannerIn(reduceMotion: reduceMotion), value: expanded)
        .animation(Motion.bannerIn(reduceMotion: reduceMotion), value: center.rows)
        // The pointer region, and sonner's: the pile collapsed, the whole fan
        // expanded, in both cases that region and no more — the clear space
        // below a collapsed pile cannot fan it out by accident. Sonner's
        // toaster does this by listening on the list and letting each toast's
        // own hover bubble up to it, which is why moving between toasts never
        // closes the stack; this is the same region, drawn rather than derived.
        .background(alignment: .top) {
            HoverRegion(bridging: expanded) { hovering in
                // Nothing to fan out with one banner, as sonner also insists.
                expanded = hovering && drawnCount > 1
            }
            .frame(height: hoverHeight)
            .padding(.top, -hoverBridge)
        }
        // The window is sized for the fan whether or not it is fanned, so
        // hovering never resizes the window and the front banner — pinned to
        // the top edge — never moves. The space below a collapsed pile is
        // fully clear, so clicks there fall through it at the window server.
        .padding(.bottom, fanRoom)
        .background(measure)
        // The slide band above the stack. Outside the measure, so the window's
        // arithmetic is told the rows' size and adds the band itself.
        .padding(.top, ToastCenter.topInset)
        // Held at the top of whatever the window currently is. The window is
        // told its new size from in here, so for the frame between the stack
        // giving a row back and the window being resized to match, the content
        // is shorter than the view holding it — and a hosting view centres a
        // root view it has spare room for, which drops the whole stack by half
        // the difference and lifts it back the moment the window catches up.
        // That is the pop after a dismissal, and it is a mismatch that will
        // recur whenever the window follows the content rather than the other
        // way about; pinning the top makes any such mismatch invisible.
        .frame(maxHeight: .infinity, alignment: .top)
    }

    /// A banner and the place the pile draws it at.
    private struct Placed: Identifiable {
        let toast: Toast
        /// Zero is the front.
        let depth: Int
        /// Playing its exit: drawn, but out of the stack's arithmetic.
        let leaving: Bool
        /// Inside what the pile shows at once, rather than queued behind it.
        let drawn: Bool
        var id: UUID { toast.id }
    }

    /// Every banner with its place. A banner counts for the depths behind it
    /// only while it is in the stack, so dismissing one closes the pile over
    /// its place at once — the dismissed banner keeps the depth it had and
    /// plays its exit from there, which is sonner's `offsetBeforeRemove`.
    ///
    /// Depth is capped one step behind the last banner the pile shows, so a
    /// queue of any length is drawn as one banner's worth of stack and the
    /// arithmetic below cannot run away with it.
    private var placed: [Placed] {
        var depth = 0
        var out: [Placed] = []
        for toast in center.rows.reversed() {
            let leaving = center.exiting.contains(toast.id)
            let at = min(leaving ? center.frozen[toast.id] ?? depth : depth, BoardToasts.visible)
            out.append(Placed(toast: toast, depth: at, leaving: leaving,
                              drawn: at < BoardToasts.visible))
            if !leaving { depth += 1 }
        }
        return out.reversed()
    }

    private func scale(for depth: Int) -> CGFloat {
        expanded ? 1 : 1 - Self.scaleStep * CGFloat(depth)
    }

    private func offset(for depth: Int) -> CGFloat {
        (expanded ? rowHeight + Self.gap : Self.gap) * CGFloat(depth)
    }

    /// Sonner's `::after` strip — a gap and a hair of pointer region above each
    /// toast, and so above the front one — which it grows only while fanned.
    /// It is what keeps the stack open when the pointer approaches from the
    /// menu bar rather than from below.
    private var hoverBridge: CGFloat { expanded ? Self.gap + 1 : 0 }

    /// The pointer region under that strip: the pile collapsed, the whole fan
    /// expanded, measured exactly the way the offsets are, so every banner sits
    /// inside it and the gaps between them are inside it too.
    private var hoverHeight: CGFloat {
        rowHeight + hoverBridge
            + (expanded ? rowHeight + Self.gap : Self.gap)
            * CGFloat(drawnCount - 1)
    }

    /// Room for the whole fan below the front banner, fanned or not.
    private var fanRoom: CGFloat {
        let behind = drawnCount - 1
        guard behind > 0 else { return 0 }
        return (rowHeight + Self.gap) * CGFloat(behind)
    }

    /// How many banners the pile has room for, and so how tall the window is.
    /// A dismissal is counted for the whole of its length — while its banner is
    /// still in the stack playing its exit, and then while the removal that
    /// follows settles. The window is what clips the stack, and giving the row
    /// back at the instant the banners left finish rising would take the last
    /// pixels of that rise with it. It is given back once nothing is moving,
    /// when the space below is empty and losing it cannot be seen.
    private var drawnCount: Int {
        let settling = center.exiting.filter { id in
            !center.rows.contains { $0.id == id }
        }.count
        return min(center.rows.count + settling, BoardToasts.visible)
    }

    private var measureRow: some View {
        GeometryReader { proxy in
            Color.clear.onChange(of: proxy.size.height, initial: true) { _, height in
                if height > 1 { rowHeight = height }
            }
        }
    }

    /// The entrance is sonner's: the row slides its full height out from under
    /// the menu bar, fading as it comes. The exit is not a transition at all —
    /// it is played on the row's own modifiers while its layout frame is still
    /// alive (see the stack's body), so the banner leaves from where it stands
    /// rather than from wherever a transition would have put it. What is left
    /// here for the removal is a fade the phantom plays at nothing. Under
    /// reduced motion, the fade alone.
    private var banner: AnyTransition {
        guard !reduceMotion else { return .opacity }
        return .asymmetric(
            insertion: .move(edge: .top).combined(with: .opacity),
            removal: .opacity)
    }

    /// The same reporting idiom the board panel uses — the window is sized from
    /// inside SwiftUI, because only SwiftUI knows what the rows come to.
    private var measure: some View {
        GeometryReader { proxy in
            Color.clear.onChange(of: proxy.size, initial: true) { _, size in
                center.resized(to: size)
            }
        }
    }
}

/// The stack's pointer region, as an AppKit tracking area rather than
/// SwiftUI's `onHover`, for two reasons the web does not have to think about.
///
/// SwiftUI answers `onHover` by hit-testing, so a catcher behind the banners
/// reads as un-hovered the moment the pointer is over one: the pile could be
/// fanned out only from the sliver of itself no banner covered, and fell shut
/// again as soon as the pointer reached a banner — which is the whole of the
/// twitch. A tracking area is geometric. It reports its own rectangle whatever
/// is drawn over it, the way sonner's list reports a hover its toasts bubbled
/// up, and `hitTest` returning nil leaves every click to the banners in front.
///
/// `bridging` is the second reason. The panel is transparent, so the window
/// server routes the pointer by drawn alpha, and the clear gaps between fanned
/// banners belong to whatever is behind the panel rather than to it — crossing
/// one reads as leaving the stack, and the fan would fall shut under a pointer
/// on its way to the next banner. Fanned, the region paints itself at one part
/// in two hundred: a single level of an eight-bit channel, behind the banners
/// besides, which the window server counts as the panel's and no eye can see.
/// Collapsed it paints nothing, so the clear space around the pile keeps
/// falling through to whatever is under it.
private struct HoverRegion: NSViewRepresentable {
    /// The stack is fanned, so the gaps between banners have to hold the
    /// pointer.
    let bridging: Bool
    let changed: (Bool) -> Void

    func makeNSView(context: Context) -> Region {
        let view = Region()
        view.changed = changed
        view.bridging = bridging
        return view
    }

    func updateNSView(_ view: Region, context: Context) {
        view.changed = changed
        view.bridging = bridging
    }

    final class Region: NSView {
        /// How long a departure is held before it counts. The bridge covers the
        /// gaps the pointer would otherwise be lost in; this covers the frame
        /// or two either side of one, and is short enough to vanish inside the
        /// collapse it delays.
        private static let grace = Duration.milliseconds(120)
        private static let bridge = NSColor.black.withAlphaComponent(0.005).cgColor

        var changed: (Bool) -> Void = { _ in }

        var bridging = false {
            didSet {
                guard bridging != oldValue else { return }
                layer?.backgroundColor = bridging ? Self.bridge : NSColor.clear.cgColor
            }
        }

        private var leaving: Task<Void, Never>?

        init() {
            super.init(frame: .zero)
            wantsLayer = true
            layer?.backgroundColor = NSColor.clear.cgColor
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError("not from a nib") }

        deinit { leaving?.cancel() }

        /// Clicks pass straight through: the region is the pointer's business
        /// only, and the banners drawn in front of it take every press.
        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        /// `inVisibleRect` keeps the area the view's own bounds, which change
        /// under it every time the stack fans out or falls shut.
        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            trackingAreas.forEach(removeTrackingArea)
            addTrackingArea(NSTrackingArea(
                rect: .zero,
                options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                owner: self))
        }

        override func mouseEntered(with event: NSEvent) {
            leaving?.cancel()
            leaving = nil
            changed(true)
        }

        override func mouseExited(with event: NSEvent) {
            leaving?.cancel()
            leaving = Task { @MainActor [weak self] in
                try? await Task.sleep(for: Self.grace)
                guard let self, !Task.isCancelled, self.window != nil else { return }
                self.leaving = nil
                self.changed(false)
            }
        }
    }
}

/// One banner. The board's own language at banner size: a status pill in the
/// card pill's construction saying what kind of news, the PR title in the
/// card-title face saying which, a project chip when more than one board is in
/// play. Banners do not age out: clicking one opens its link and puts it away,
/// and the ✕ puts it away without the link.
private struct ToastRow: View {
    let toast: Toast
    /// False on a banner buried in a collapsed pile: its card is drawn —
    /// background and border, which is all the pile shows — but its content is
    /// not, exactly as sonner hides a back toast's children.
    let showsContent: Bool
    let open: () -> Void
    let dismiss: () -> Void

    var body: some View {
        // Not a Button: the ✕ in the header is one, and a button inside a
        // button misfires. A tap gesture answers the card's open, and the ✕
        // takes precedence over it inside its own bounds.
        VStack(alignment: .leading, spacing: 5) {
            header
            Text(toast.event.title)
                .font(Typography.title)
                .foregroundStyle(Palette.ink)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .opacity(showsContent ? 1 : 0)
        .padding(8)
        .contentShape(Rectangle())
        .onTapGesture(perform: open)
        .background(Palette.card, in: RoundedRectangle.squircle(8))
        .overlay(RoundedRectangle.squircle(8).stroke(Palette.rule, lineWidth: 1))
        // The banner moves as one thing. Without this, a change to the row's
        // position — the pile re-fronting, the window growing under an arriving
        // one — reaches every child separately and each interpolates its own
        // way there, which reads as the content sliding inside the card while
        // the card moves. CardRow carries the same group for the same reason.
        .geometryGroup()
        .help(toast.event.title)
        .accessibilityElement(children: .combine)
        .accessibilityHidden(!showsContent)
        .accessibilityLabel("\(toast.event.headline). \(toast.event.title)")
        .accessibilityAddTraits(.isButton)
    }

    private var header: some View {
        HStack(spacing: 6) {
            HStack(spacing: 3) {
                Image(systemName: glyph)
                    .font(Typography.Icon.chip)
                Text(toast.event.headline.uppercased())
                    .font(Typography.pill)
                    .tracking(Typography.uppercaseTracking)
            }
            .foregroundStyle(Palette.foreground(tone))
            .lineLimit(1)
            .padding(.horizontal, 6)
            .frame(height: 14)
            .background(Palette.background(tone), in: RoundedRectangle.squircle(5))
            Spacer(minLength: 6)
            if let project = toast.event.project {
                Text(project)
                    .font(Typography.label)
                    .foregroundStyle(Palette.faint)
                    .lineLimit(1)
                    .padding(.horizontal, 5)
                    .frame(height: 14)
                    .background(Palette.rule.opacity(0.6), in: RoundedRectangle.squircle(5))
            }
            closeButton
        }
    }

    /// Puts the banner away without following its link. Always visible — a
    /// dismissal raised only on hover vanished the moment the pointer reached
    /// it (entering the button reads as leaving the card) — and built like the
    /// chip beside it, so the header reads as one strip.
    private var closeButton: some View {
        Button(action: dismiss) {
            Image(systemName: "xmark")
                .font(Typography.Icon.confirmation)
                .foregroundStyle(Palette.soft)
                .frame(width: 14, height: 14)
                .background(Palette.rule.opacity(0.6), in: RoundedRectangle.squircle(5))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Dismiss — without opening the link")
        .accessibilityLabel("Dismiss \(toast.event.headline)")
    }

    /// The pill wears what the card's own pill wears for the same news — ready
    /// is the good green, a preview the agent blue — and carries the glyph of
    /// the chip that opens the same thing: the pull-request mark, the globe.
    private var tone: Tone {
        toast.event.kind == .mergeable ? .good : .agent
    }

    private var glyph: String {
        toast.event.kind == .mergeable ? "arrow.triangle.pull" : "globe"
    }
}
