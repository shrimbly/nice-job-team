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

    init(content: NSView, margin: CGFloat) {
        self.margin = margin
        super.init(frame: content.frame)
        content.autoresizingMask = [.width, .height]
        addSubview(content)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

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
        level = .popUpMenu
        // Whatever AppKit would do on order-in is not what the reveal does.
        animationBehavior = .none
        isMovable = false
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        contentView = PanelContentView(content: content, margin: BoardPanel.shadowMargin)
    }
}
