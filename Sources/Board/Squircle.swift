import SwiftUI

extension RoundedRectangle {
    /// Every rounded corner in the app is a squircle — continuous curvature, the way
    /// macOS rounds its own windows and controls, rather than the quarter-circle a
    /// bare `cornerRadius` gives. Going through one factory keeps a new corner from
    /// quietly being the circular kind.
    static func squircle(_ radius: CGFloat) -> RoundedRectangle {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
    }
}
