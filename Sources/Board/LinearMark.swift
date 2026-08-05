import SwiftUI

/// Linear's own mark, so the chip that opens a Linear issue looks like Linear.
///
/// SF Symbols has nothing for it and macOS cannot decode SVG, so the official
/// 24×24 path is transcribed to a `Path` — arcs converted to cubics — and
/// normalised to a unit square, which is why it stays crisp at any size.
///
/// Source: the Linear mark from Simple Icons (CC0). Regenerate with
/// `scratchpad/linear_path.swift`'s producing script if the mark ever changes.
struct LinearMark: Shape {
    func path(in rect: CGRect) -> Path {
        // The mark is square; centre it in whatever it is given.
        let side = min(rect.width, rect.height)
        let originX = rect.minX + (rect.width - side) / 2
        let originY = rect.minY + (rect.height - side) / 2
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: originX + x * side, y: originY + y * side)
        }
        var path = Path()
        path.move(to: p(0.1203, 0.1742))
        path.addCurve(to: p(0.4996, 0.0000), control1: p(0.2152, 0.0635), control2: p(0.3538, -0.0001))
        path.addCurve(to: p(1.0000, 0.5004), control1: p(0.7760, 0.0000), control2: p(1.0000, 0.2240))
        path.addCurve(to: p(0.8258, 0.8798), control1: p(1.0000, 0.6520), control2: p(0.9325, 0.7880))
        path.addLine(to: p(0.1203, 0.1742))
        path.closeSubpath()
        path.move(to: p(0.0757, 0.2344))
        path.addLine(to: p(0.7655, 0.9243))
        path.addCurve(to: p(0.6968, 0.9603), control1: p(0.7437, 0.9380), control2: p(0.7208, 0.9501))
        path.addLine(to: p(0.0396, 0.3032))
        path.addCurve(to: p(0.0757, 0.2345), control1: p(0.0499, 0.2792), control2: p(0.0620, 0.2563))
        path.closeSubpath()
        path.move(to: p(0.0134, 0.3818))
        path.addLine(to: p(0.6182, 0.9866))
        path.addCurve(to: p(0.5267, 1.0000), control1: p(0.5886, 0.9938), control2: p(0.5581, 0.9983))
        path.addLine(to: p(0.0000, 0.4733))
        path.addCurve(to: p(0.0134, 0.3818), control1: p(0.0016, 0.4424), control2: p(0.0061, 0.4118))
        path.closeSubpath()
        path.move(to: p(0.0063, 0.5844))
        path.addLine(to: p(0.4156, 0.9937))
        path.addCurve(to: p(0.0063, 0.5844), control1: p(0.2062, 0.9579), control2: p(0.0421, 0.7938))
        path.closeSubpath()
        return path
    }
}
