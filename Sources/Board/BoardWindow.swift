import AppKit

/// The panel's window. Borderless and transparent, so the only thing on screen is
/// what SwiftUI draws — which is what lets the panel scale open. `NSPopover` sizes
/// and draws its own bubble before SwiftUI is given a frame, so under a popover the
/// surface can only ever appear whole and let its contents grow inside it.
///
/// What the popover did for free and this has to be told: closing on a click
/// outside, on Escape, and on the app going away. `StatusItemController` owns that.
/// Passes a click in the shadow margin through to whatever is behind.
///
/// The window is bigger than the panel on every side by `shadowMargin`, so the
/// panel has room to draw its shadow and to scale open. That margin is invisible
/// but it is still part of the window, and the window sits at `.popUpMenu` — above
/// the menu bar. The top margin therefore covered 24pt of a 33pt menu bar across
/// the panel's whole width and swallowed every click that landed there: other
/// applications' status items, and the board's own, which made clicking the icon
/// to close the panel do nothing at all.
///
/// Hit testing, not `ignoresMouseEvents`: that is per window, and the panel itself
/// has to keep taking clicks.
final class PanelContentView: NSView {
    private let margin: CGFloat
    private let content: NSView

    init(content: NSView, margin: CGFloat) {
        self.margin = margin
        self.content = content
        super.init(frame: content.frame)
        addSubview(content)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Pinned rather than autoresized. An autoresizing mask preserves whatever
    /// margins the subview started with, so any difference between the hosting
    /// view's initial frame and the window's content rect survives every resize
    /// as an offset — which showed up as the panel sitting low.
    override func layout() {
        super.layout()
        content.frame = bounds
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        // `point` arrives in the superview's coordinates, as AppKit hit tests down.
        let local = convert(point, from: superview)
        guard bounds.insetBy(dx: margin, dy: margin).contains(local) else { return nil }
        return super.hitTest(point)
    }
}

final class BoardWindow: NSPanel {
    /// Borderless windows refuse key by default, which would leave the footer
    /// buttons dead and nothing selectable.
    override var canBecomeKey: Bool { true }

    /// Keep the frame that was asked for.
    ///
    /// AppKit constrains a window to the screen's *visible* frame, which excludes
    /// the menu bar — but only below `.popUpMenu`. This window is deliberately
    /// taller than the panel by `shadowMargin`, so its top intrudes behind the
    /// menu bar by design, and the constraint pushed the whole panel down by that
    /// margin: a 28pt gap under the menu bar instead of hugging it.
    ///
    /// The intrusion is only the shadow band, and the menu bar draws over it.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        frameRect
    }

    convenience init(content: NSView) {
        self.init(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
                  styleMask: [.borderless, .nonactivatingPanel],
                  backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        // The panel draws its own, so it can scale and fade with the surface. A
        // window shadow is computed from the window and would sit there at full
        // size through the whole reveal.
        hasShadow = false
        // Below the menu bar, above everything else.
        //
        // The window is taller than the panel by `shadowMargin`, so its top edge
        // reaches 24pt into a 33pt menu bar, the width of the whole panel. At
        // `.popUpMenu` that band sits *above* the menu bar and takes every click
        // in it — other applications' status items, and this app's own, so
        // clicking the icon to close the panel did nothing.
        //
        // Hit testing does not fix that. A view declining a point only means no
        // view handles it; the window has already taken the event. A click falls
        // through a non-opaque window where the pixels are fully clear, and these
        // are not clear — that band is where the shadow is drawn.
        //
        // One below `.mainMenu` puts the menu bar back on top, so the overlap is
        // covered by the menu bar and clicked through to it, while the panel still
        // floats over ordinary and floating windows in every application.
        level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue - 1)
        // Whatever AppKit would do on order-in is not what the reveal does.
        animationBehavior = .none
        isMovable = false
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        contentView = PanelContentView(content: content, margin: BoardPanel.shadowMargin)
    }
}
