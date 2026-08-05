import Foundation

public enum RelativeTime {
    /// The dashboard's own wording: "just now", "7m ago", "3h ago".
    public static func short(_ date: Date?, now: Date = Date()) -> String {
        guard let date else { return "never" }
        let minutes = max(0, Int((now.timeIntervalSince(date) / 60).rounded()))
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes)m ago" }
        return "\(Int((Double(minutes) / 60).rounded()))h ago"
    }
}
