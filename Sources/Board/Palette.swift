import AppKit
import BoardKit
import SwiftUI

/// The dashboard's palette, as dynamic colours so the panel follows the system
/// appearance without the app knowing which one is current.
///
/// The dark half is built in OKLCH rather than picked by eye. Every neutral holds
/// hue 250 at chroma 0.005 — charcoal, not the blue-tinted grey it used to be,
/// whose chroma wandered 0.008–0.021 and peaked in the middle of the ramp. Every
/// accent sits on a lightness tier chosen by how much it wants to be noticed, and
/// carries an absolute chroma rather than a share of its hue's maximum: green's
/// gamut is roughly twice blue's, so equal shares are not equal colourfulness and
/// the greens came out neon.
///
/// The light half is built the same way and inverted: one hue and one chroma for
/// the neutrals, accents on lightness tiers, absolute chroma. It had the same
/// faults plus two live failures — `mute` at 3.91:1 on white and `you` at 4.53:1,
/// both under the floor.
///
/// Everything here clears 4.5:1 against the surface it is drawn on, foregrounds
/// against the card and pill labels against their own fill.
enum Palette {
    static let ink = dynamic(light: 0x141618, dark: 0xE7EAED)
    static let soft = dynamic(light: 0x5A5C5F, dark: 0xAAADAF)
    // 4.7:1 and 5.5:1 against the card. The previous pair (8A939E / 6F7A85) came
    // out at 3.1:1 and 3.9:1 — under the 4.5:1 floor for body text, and it is
    // carrying the facts strip and the footer status, not just decoration.
    static let faint = dynamic(light: 0x6E7073, dark: 0x8E9194)
    static let rule = dynamic(light: 0xE0E3E6, dark: 0x26282A)
    static let rule2 = dynamic(light: 0xCDD0D2, dark: 0x353739)
    static let card = dynamic(light: 0xFFFFFF, dark: 0x181A1C)
    static let bg = dynamic(light: 0xF1F4F7, dark: 0x0D0F10)

    /// Dark lightness runs 0.82 for the tone that wants you to act, down to 0.655
    /// for the one that does not.
    static func foreground(_ tone: Tone) -> Color {
        switch tone {
        case .you: dynamic(light: 0x885A00, dark: 0xF5B75B)
        case .agent: dynamic(light: 0x356391, dark: 0x85B6E9)
        case .bad: dynamic(light: 0xA83634, dark: 0xF78D85)
        case .good: dynamic(light: 0x007742, dark: 0x6AD895)
        // Review and draft are the two greys — neither is asking anything of you,
        // and keeping them uncoloured leaves the coloured pills meaning something.
        // Review is the lighter of the pair — it has come further than a draft, so
        // its chip lifts off the card more. In the light palette that same "more
        // presence" reads as a deeper fill, not a lighter one.
        case .review: dynamic(light: 0x4F5154, dark: 0xBBBEC1)
        case .mute: dynamic(light: 0x63666B, dark: 0x8D9195)
        }
    }

    /// `foreground`, lifted for hover: brighter against a dark card, deeper against
    /// a light one. The base tones are pitched to sit quietly on the card, which is
    /// exactly what makes them illegible as a hover state.
    static func lifted(_ tone: Tone) -> Color {
        switch tone {
        case .agent: dynamic(light: 0x214F7C, dark: 0xA8D2FF)
        case .good: dynamic(light: 0x006035, dark: 0x81EFAB)
        default: foreground(tone)
        }
    }

    /// Every dark fill sits at lightness 0.275 — one step above the card, so a pill
    /// reads as raised whatever its tone. They used to range 0.15 to 0.20, which
    /// made some pills look sunk into the card and others glued on top.
    static func background(_ tone: Tone) -> Color {
        switch tone {
        case .you: dynamic(light: 0xFFE9CC, dark: 0x332510)
        case .agent: dynamic(light: 0xE0EFFF, dark: 0x1A2938)
        case .bad: dynamic(light: 0xFFE6E4, dark: 0x39201E)
        case .good: dynamic(light: 0xD6F6E0, dark: 0x162D1F)
        case .review: dynamic(light: 0xDBDEE1, dark: 0x353739)
        case .mute: dynamic(light: 0xEAEDF1, dark: 0x25282B)
        }
    }

    /// Colours borrowed from the services the links point at, so a chip is
    /// recognisable before it is read. GitHub's are Primer's own `open` and `draft`
    /// pull-request values — the same pairing its own PR list uses.
    enum Brand {
        // Brighter than GitHub's own dark green, which sits at lightness 0.695 —
        // this is 0.76 and still carries chroma 0.19, because the PR's state is the
        // one colour on a card that has to be readable at a glance.
        static let gitHubOpen = dynamic(light: 0x097F23, dark: 0x52CF5E)
        static let gitHubOpenLifted = dynamic(light: 0x006517, dark: 0x6FEA77)
        static let gitHubDraft = dynamic(light: 0x63666B, dark: 0x909499)
        static let gitHubDraftLifted = dynamic(light: 0x52565A, dark: 0xB2B6BB)
    }

    /// The one colour that also has to work in the menu bar, where SwiftUI is not
    /// involved and NSColor does the resolving.
    static let alertNSColor = NSColor(name: nil) { appearance in
        appearance.isDark ? NSColor(hex: 0xF5B75B) : NSColor(hex: 0x885A00)
    }

    private static func dynamic(light: Int, dark: Int) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.isDark ? NSColor(hex: dark) : NSColor(hex: light)
        })
    }
}

private extension NSAppearance {
    var isDark: Bool {
        bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    }
}

private extension NSColor {
    convenience init(hex: Int) {
        self.init(srgbRed: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255,
                  alpha: 1)
    }
}
