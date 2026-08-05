import AppKit

/// The panel's window. Borderless and transparent, so the only thing on screen is
/// what SwiftUI draws — which is what lets the panel scale open. `NSPopover` sizes
/// and draws its own bubble before SwiftUI is given a frame, so under a popover the
/// surface can only ever appear whole and let its contents grow inside it.
///
/// What the popover did for free and this has to be told: closing on a click
/// outside, on Escape, and on the app going away. `StatusItemController` owns that.
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
        contentView = content
    }
}
