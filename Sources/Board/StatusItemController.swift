import AppKit
import BoardKit
import SwiftUI

@MainActor
final class StatusItemController: NSObject, NSApplicationDelegate {
    private let store = BoardStore()
    private let presentation = PanelPresentation()
    private var statusItem: NSStatusItem!
    private var window: BoardWindow!
    private var hosting: NSHostingView<BoardPanel>!
    /// What the popover's `.transient` behaviour did on its own.
    private var monitors: [Any] = []
    /// Non-nil while the dismissal is playing and the window is still on screen.
    private var closeTask: Task<Void, Never>?
    private var redrawTask: Task<Void, Never>?

    /// The gap between the menu bar and the panel's visible top edge.
    private static let gap: CGFloat = 4
    /// How close the panel may come to the edge of the screen.
    private static let screenInset: CGFloat = 8

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.imagePosition = .imageLeading
        statusItem.button?.target = self
        statusItem.button?.action = #selector(statusItemClicked)
        statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])

        hosting = NSHostingView(
            rootView: BoardPanel(store: store, presentation: presentation,
                                 openLink: { [weak self] in self?.open($0) },
                                 onResize: { [weak self] in self?.resize(to: $0) }))
        window = BoardWindow(content: hosting)
        // The panel follows the system appearance; this pins it to one, for a look
        // at the other without changing the whole desktop.
        switch ProcessInfo.processInfo.environment["BOARD_APPEARANCE"] {
        case "dark": window.appearance = NSAppearance(named: .darkAqua)
        case "light": window.appearance = NSAppearance(named: .aqua)
        default: break
        }
        // Cmd-tabbing away, or clicking the desktop, is a dismissal like any other.
        NotificationCenter.default.addObserver(
            forName: NSApplication.didResignActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.dismiss() }
        }

        // The count and the tint are the app's whole job when the panel is shut, so
        // they are redrawn from the store rather than only on refresh completion.
        redrawTask = Task { [weak self] in
            while !Task.isCancelled {
                self?.updateStatusItem()
                try? await Task.sleep(for: .seconds(1))
            }
        }
        // Waking is the one moment the board is guaranteed to be wrong.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.store.wakeFromSleep() }
        }

        store.start()
        updateStatusItem()
    }

    func applicationWillTerminate(_ notification: Notification) {
        redrawTask?.cancel()
        closeTask?.cancel()
        stopWatchingForDismissal()
        store.stop()
    }

    // MARK: -

    private func updateStatusItem() {
        guard let button = statusItem.button else { return }
        let needs = store.needsOperatorCount
        let alert = needs > 0

        let symbol = alert ? "rectangle.stack.fill" : "rectangle.stack"
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Board")?
            .withSymbolConfiguration(.init(pointSize: 13, weight: .regular))
        // Template only when quiet: a template image is forced to the menu bar's own
        // colour, which is exactly what would erase the alert tint.
        image?.isTemplate = !alert
        if alert, let image {
            button.image = image.tinted(with: Palette.alertNSColor)
        } else {
            button.image = image
        }

        let count = alert ? "\(needs)" : "\(store.cards.count)"
        button.attributedTitle = NSAttributedString(string: " \(count)", attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: alert ? .semibold : .regular),
            .foregroundColor: alert ? Palette.alertNSColor : NSColor.labelColor,
        ])
        button.toolTip = alert
            ? "\(needs) of \(store.cards.count) need you"
            : "\(store.cards.count) open"
    }

    @objc private func statusItemClicked() {
        if NSApp.currentEvent?.type == .rightMouseUp {
            showMenu()
        } else {
            toggle()
        }
    }

    private var reduceMotion: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }

    /// Long enough to cover a click's own mouse-down and mouse-up.
    private static let reopenGuard: TimeInterval = 0.3
    private var dismissedAt: Date?

    private var dismissedJustNow: Bool {
        guard let dismissedAt else { return false }
        return Date().timeIntervalSince(dismissedAt) < Self.reopenGuard
    }

    private func toggle() {
        // Clicking the status item with the panel up shuts it — including when it is
        // already on its way out, which is the common case rather than the odd one.
        // The mouse-down half of this very click has usually dismissed the panel
        // already, either because the app resigned active or because the event did
        // not name a window this could recognise; without the second test the
        // mouse-up would then read as "it is shut, open it" and the panel would flick
        // straight back.
        if window.isVisible || dismissedJustNow {
            dismiss()
            return
        }
        closeTask?.cancel()
        closeTask = nil
        store.refreshIfStale()

        // Measured before the fit, not after: the panel caps its card area against
        // this, so a stale value would size the window for the wrong screen.
        presentation.availableHeight = roomUnderStatusItem()
        // Before the first showing SwiftUI has never laid out, so this is the only
        // chance to be the right size on the frame the window is ordered in on.
        let fitted = hosting.fittingSize
        if fitted.width > 1, fitted.height > 1 { window.setContentSize(fitted) }
        positionUnderStatusItem()
        window.ignoresMouseEvents = false
        window.orderFrontRegardless()
        // An accessory app has no active window by default, so without this the
        // panel opens unfocused and the first click only serves to focus it.
        window.makeKey()
        NSApp.activate(ignoringOtherApps: true)
        presentation.reveal(reduceMotion: reduceMotion)
        watchForDismissal()
    }

    private func dismiss() {
        guard window.isVisible, closeTask == nil else { return }
        dismissedAt = Date()
        stopWatchingForDismissal()
        // The window outlives the animation by a frame or two; it must not be
        // taking clicks meant for whatever the operator is moving on to.
        window.ignoresMouseEvents = true
        presentation.dismiss(reduceMotion: reduceMotion)
        closeTask = Task { [weak self] in
            try? await Task.sleep(for: Motion.panelDismissDuration)
            guard let self, !Task.isCancelled else { return }
            window.orderOut(nil)
            window.ignoresMouseEvents = false
            presentation.closed()
            closeTask = nil
        }
    }

    /// Under the menu bar item, clamped to the screen it is on. The window is bigger
    /// than the panel by the room left for the shadow, so every edge here is the
    /// window's and every edge the operator sees is inset from it.
    private func positionUnderStatusItem() {
        guard let button = statusItem.button, let barWindow = button.window else { return }
        let anchor = barWindow.convertToScreen(button.convert(button.bounds, to: nil))
        let size = window.frame.size
        let inset = BoardPanel.shadowMargin
        var origin = NSPoint(x: anchor.midX - size.width / 2,
                             y: anchor.minY - Self.gap - size.height + inset)
        if let screen = barWindow.screen ?? NSScreen.main {
            let limits = screen.visibleFrame
            let leftmost = limits.minX + Self.screenInset - inset
            let rightmost = limits.maxX - Self.screenInset - size.width + inset
            origin.x = min(max(origin.x, leftmost), max(leftmost, rightmost))
        }
        window.setFrameOrigin(origin)
    }

    /// The drop from the underside of the menu bar item to the bottom of the screen
    /// it sits on, less the same insets the panel is positioned by. The panel only
    /// ever grows downward, so this is all the height there is to give it.
    ///
    /// Unbounded when there is no button or screen to measure — the panel then sizes
    /// to its cards, which is what it did before there was a cap.
    private func roomUnderStatusItem() -> CGFloat {
        guard let button = statusItem.button, let barWindow = button.window,
              let screen = barWindow.screen ?? NSScreen.main else { return .greatestFiniteMagnitude }
        let anchor = barWindow.convertToScreen(button.convert(button.bounds, to: nil))
        let floor = screen.visibleFrame.minY + Self.screenInset
        return anchor.minY - Self.gap - floor
    }

    /// The panel's height follows the board and whichever cards are open, so the
    /// window is resized from underneath it. The top edge is held: it is pinned to
    /// the menu bar item, and everything grows downward from there.
    private func resize(to size: CGSize) {
        guard let window, size.width > 1, size.height > 1 else { return }
        var frame = window.frame
        guard frame.size != NSSize(width: size.width, height: size.height) else { return }
        frame.origin.y = frame.maxY - size.height
        frame.size = NSSize(width: size.width, height: size.height)
        window.setFrame(frame, display: true)
        if window.isVisible { positionUnderStatusItem() }
    }

    // MARK: - Dismissal

    private static let escapeKeyCode: UInt16 = 53

    private func watchForDismissal() {
        stopWatchingForDismissal()
        // Clicks in other applications. A global monitor never sees our own events.
        let outside = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown],
            handler: { [weak self] _ in
                MainActor.assumeIsolated { self?.dismiss() }
            })
        // Clicks in ours. A local monitor has to pass the event on, so it decides
        // and gets out of the way.
        let inside = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown],
            handler: { [weak self] event in
                MainActor.assumeIsolated { self?.dismissIfOutsideThePanel(event) }
                return event
            })
        let escape = NSEvent.addLocalMonitorForEvents(
            matching: [.keyDown],
            handler: { [weak self] event in
                let dismissed = MainActor.assumeIsolated { () -> Bool in
                    guard event.keyCode == Self.escapeKeyCode, let self else { return false }
                    self.dismiss()
                    return true
                }
                // Swallowed, so Escape does not also go on to whatever is behind.
                return dismissed ? nil : event
            })
        monitors = [outside, inside, escape].compactMap { $0 }
    }

    private func dismissIfOutsideThePanel(_ event: NSEvent) {
        guard event.window !== window else { return }
        // The status item's own action is about to toggle. Closing here would only
        // leave that toggle to reopen it.
        guard event.window !== statusItem.button?.window else { return }
        dismiss()
    }

    private func stopWatchingForDismissal() {
        monitors.forEach(NSEvent.removeMonitor)
        monitors.removeAll()
    }

    private func showMenu() {
        let menu = NSMenu()
        menu.addItem(withTitle: "Refresh now", action: #selector(refresh), keyEquivalent: "r")
            .target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Board", action: #selector(quit), keyEquivalent: "q").target = self
        // menu(_:) would make the menu permanent and swallow left clicks.
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    @objc private func refresh() { store.refreshNow() }
    @objc private func quit() { NSApplication.shared.terminate(nil) }

    private func open(_ string: String) {
        guard let url = URL(string: string) else { return }
        dismiss()
        // Always the default browser, never an embedded web view — and this is also
        // what opens superset:// back into the Superset app.
        NSWorkspace.shared.open(url)
    }
}

private extension NSImage {
    /// SF Symbols arrive as templates; drawing the tint in keeps it once the image
    /// stops being one.
    func tinted(with color: NSColor) -> NSImage {
        let copy = NSImage(size: size, flipped: false) { rect in
            color.set()
            self.draw(in: rect)
            rect.fill(using: .sourceAtop)
            return true
        }
        copy.isTemplate = false
        return copy
    }
}
