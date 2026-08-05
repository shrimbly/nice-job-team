import Observation
import SwiftUI

/// The app's motion tokens, so curves and durations are named once rather than
/// hand-typed at each call site.
///
/// The curve is a strong ease-out — `cubic-bezier(0.23, 1, 0.32, 1)`. Anything
/// entering or leaving the screen uses it: it starts fast, so the moment the
/// operator is actually watching is not spent waiting. The built-in curves are too
/// weak to read as deliberate.
enum Motion {
    private static func easeOut(_ seconds: Double) -> Animation {
        .timingCurve(0.23, 1, 0.32, 1, duration: seconds)
    }

    /// The confirmation is the one thing here that springs. It is the system
    /// answering, and a small overshoot at the top of the rise reads as the thing
    /// having been thrown rather than driven. Bounce is kept at the top of the
    /// subtle band — past about 0.3 a confirmation starts to look pleased with
    /// itself. It leaves on a plain curve: an exit that bounces is an exit that is
    /// still asking for attention.
    static func copiedIn(reduceMotion: Bool) -> Animation {
        reduceMotion ? easeOut(0.12) : .spring(duration: 0.34, bounce: 0.3)
    }
    static func copiedOut(reduceMotion: Bool) -> Animation { easeOut(0.12) }

    /// Long enough to read one word, short enough not to sit in the way.
    static let copiedDwell = Duration.milliseconds(1100)

    /// Opening a card. The chevron, the card's height, the cards below it that have
    /// to move down and the window that has to grow are all one gesture and take one
    /// curve, or they arrive at different times and read as several things happening
    /// at once. Under reduced motion the height still has to change — there is no
    /// version of this that does not — so it changes quickly instead.
    static func disclosure(reduceMotion: Bool) -> Animation { easeOut(reduceMotion ? 0.1 : 0.18) }

    /// The panel is opened many times a day, so its reveal stays inside a dropdown's
    /// 150–250ms budget however far it travels.
    static func panelReveal(reduceMotion: Bool) -> Animation { easeOut(reduceMotion ? 0.12 : 0.22) }

    /// It grows from the menu bar item it was clicked from, which is what the top
    /// anchor is for. Three quarters is a long way for something opened this often —
    /// the usual advice is 0.9–0.97 — so the duration stays at the top of the budget
    /// rather than being stretched to cover the distance.
    static let panelScale: CGFloat = 0.75

    /// The exit does not retrace the entrance. By the time the panel is closing the
    /// operator has already decided to be somewhere else, so it barely moves and it
    /// is gone in half the time.
    static let panelDismissScale: CGFloat = 0.97
    static func panelDismiss(reduceMotion: Bool) -> Animation { easeOut(reduceMotion ? 0.09 : 0.12) }
    /// How long the window stays on screen after the dismissal starts. Matched to
    /// `panelDismiss` — shorter and the panel is cut off mid-fade.
    static let panelDismissDuration = Duration.milliseconds(120)

    /// The cards resolve out of a blur a beat apart, every one of them. The step is
    /// under the usual 30–80ms band because it has to carry a whole screen of cards
    /// and still be gone inside a reveal's budget: at 20ms the eighth card — the
    /// last one a full panel shows — is finished 270ms in.
    ///
    /// The ceiling is reached twenty cards down, further than the panel can show.
    /// The stack below that point is built but scrolled past, and nothing down there
    /// should still be waiting its turn by the time the operator reaches it.
    static func cardReveal(index: Int, reduceMotion: Bool) -> Animation {
        guard !reduceMotion else { return easeOut(0.1) }
        return easeOut(0.13).delay(min(Double(index) * 0.02, 0.4))
    }

    /// Well under the 20px where a transition-time blur starts costing frames.
    static func cardBlur(reduceMotion: Bool) -> CGFloat { reduceMotion ? 0 : 5 }

    /// The confirmation comes off the chip tilted and unwinds as it settles.
    /// Positive is clockwise, which hangs the right-hand end low, so the right
    /// corner still has swinging to do once the left has arrived. The spring
    /// overshoots this past level and back, which is most of what the bounce is.
    static let toastTilt: Double = 8

    /// The letters resolve a beat apart. The step is far below the 30–80ms that
    /// separates items in a list, because these are not items — at 10ms across six
    /// letters the word arrives as a word, and any slower it arrives as six things.
    /// The word waits for the rise to be underway before it starts resolving, so the
    /// two read as one thing arriving and then settling rather than as two things
    /// starting together. The whole word is still through by 300ms, which is well
    /// inside the spring.
    static func toastLetter(index: Int, reduceMotion: Bool) -> Animation {
        guard !reduceMotion else { return easeOut(0.1) }
        return easeOut(0.14).delay(0.09 + Double(index) * 0.01)
    }

    static func toastLetterBlur(reduceMotion: Bool) -> CGFloat { reduceMotion ? 0 : 3 }
}

/// The confirmation's entrance: straight up out of the chip it came from, unwinding
/// a tilt on the way. Written as a modifier because none of the built-in transitions
/// rotate, and a transition is the only place a view can be told where it came
/// *from*.
///

/// Where the panel is in its showing. The hosting view outlives any one showing, so
/// `onAppear` fires once and cannot drive the reveal — this can.
@MainActor
@Observable
final class PanelPresentation {
    /// `dismissing` is its own phase rather than a return to `hidden` because the
    /// exit is not the entrance run backwards.
    enum Phase { case hidden, open, dismissing }

    private(set) var phase: Phase = .hidden

    /// Room between the menu bar item and the bottom of the screen it is on. The
    /// panel grows downward from the item, so this is the whole of what it can ever
    /// have, and it caps the card area against it. Unbounded until the controller
    /// has measured a screen, which leaves the cards sizing to their own content —
    /// the behaviour from before there was a cap at all.
    var availableHeight: CGFloat = .greatestFiniteMagnitude

    var isOpen: Bool { phase == .open }

    var scale: CGFloat {
        switch phase {
        case .open: 1
        case .hidden: Motion.panelScale
        case .dismissing: Motion.panelDismissScale
        }
    }

    /// Called straight after the window is ordered in, so the first frame is the
    /// un-revealed state and the animation runs against a window that already exists.
    func reveal(reduceMotion: Bool) {
        phase = .hidden
        DispatchQueue.main.async {
            withAnimation(Motion.panelReveal(reduceMotion: reduceMotion)) { self.phase = .open }
        }
    }

    func dismiss(reduceMotion: Bool) {
        withAnimation(Motion.panelDismiss(reduceMotion: reduceMotion)) { phase = .dismissing }
    }

    /// The window has gone; drop straight back to the entrance's starting state so
    /// the next showing has somewhere to come from.
    func closed() { phase = .hidden }
}

/// SwiftUI has no secondary-click gesture, so a thin AppKit view claims right
/// clicks and lets every other event fall through to the button underneath.
struct RightClickCatcher: NSViewRepresentable {
    let action: () -> Void

    func makeNSView(context: Context) -> Catcher {
        let view = Catcher()
        view.action = action
        return view
    }

    func updateNSView(_ view: Catcher, context: Context) {
        view.action = action
    }

    final class Catcher: NSView {
        var action: () -> Void = {}

        override func hitTest(_ point: NSPoint) -> NSView? {
            guard let type = NSApp.currentEvent?.type,
                  type == .rightMouseDown || type == .rightMouseUp else { return nil }
            return super.hitTest(point)
        }

        override func rightMouseDown(with event: NSEvent) { action() }
    }
}

/// The bubble that confirms a copy. Inverted against the card the way a system
/// tooltip is, which lands correctly in both appearances without either being
/// named — `ink` is near-white on a dark card and near-black on a light one.
struct CopiedToast: View {
    /// Stated rather than left to the text's own metrics, because the panel places
    /// this by its centre and has to know how tall it is to rest its bottom edge a
    /// given distance above the chip. The same height as a chip.
    static let height: CGFloat = 20
    /// The gap between the bottom of the confirmation and the top of the chip.
    static let clearance: CGFloat = 4

    /// Where it rests: centred over the chip, its bottom edge `clearance` above the
    /// chip's top. `position` places a view by its centre, hence the half-height.
    static func restingCentre(above chip: CGRect) -> CGPoint {
        CGPoint(x: chip.midX, y: chip.minY - clearance - height / 2)
    }

    /// How far it travels to get there, having started centred on the chip. Derived
    /// from the same two numbers as the resting place so the pair cannot drift.
    static func rise(from chip: CGRect) -> CGFloat {
        chip.height / 2 + clearance + height / 2
    }

    /// How far below its resting place it starts — level with the chip's centre.
    let rise: CGFloat

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var settled = false

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "checkmark")
                .font(Typography.Icon.confirmation)
            word
        }
        .foregroundStyle(Palette.card)
        .padding(.horizontal, 7)
        .frame(height: Self.height)
        .background(Palette.ink, in: RoundedRectangle.squircle(5))
        .shadow(color: .black.opacity(0.28), radius: 5, y: 1)
        .fixedSize()
        // The entrance is here, on the toast's own frame, rather than in the
        // transition that inserts it. A transition's modifiers land on the whole
        // inserted subtree, and the panel places this with `position`, which returns
        // a view as large as everything it is offered. A rotation out there turns
        // about the *panel's* middle and throws the toast sideways by an amount that
        // grows with its distance from it — right for a chip above the middle, left
        // for one below, and not at all for one level with it.
        .rotationEffect(.degrees(moving ? Motion.toastTilt : 0))
        .offset(y: moving ? rise : 0)
        .animation(Motion.copiedIn(reduceMotion: reduceMotion), value: settled)
        .onAppear {
            // A frame at the unsettled state first, or there is nothing to rise from
            // and the letters have nothing to resolve from.
            DispatchQueue.main.async { settled = true }
        }
    }

    /// Still on its way in, and allowed to move.
    private var moving: Bool { !settled && !reduceMotion }

    /// A view per letter, so they can come out of the blur a beat apart. Splitting a
    /// word costs the kerning between its letters; at six characters of SF Pro this
    /// one has no pair that shows it, and the layout is fixed either way because
    /// nothing here moves — only blur and opacity.
    private var word: some View {
        HStack(spacing: 0) {
            ForEach(Array("Copied".enumerated()), id: \.offset) { index, letter in
                Text(String(letter))
                    .font(Typography.toast)
                    .blur(radius: settled ? 0 : Motion.toastLetterBlur(reduceMotion: reduceMotion))
                    .opacity(settled ? 1 : 0)
                    .animation(Motion.toastLetter(index: index, reduceMotion: reduceMotion),
                               value: settled)
            }
        }
    }
}
