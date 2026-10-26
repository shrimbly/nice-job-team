import Foundation

/// One event drawn as a banner in the app's own stack — a `BoardNotification`
/// that has been posted. Banners do not age out: they stay until dismissed
/// (clicked, closed, or cleared by the board panel opening), so there is no
/// arrival time to remember.
public struct Toast: Sendable, Equatable, Identifiable {
    public let id: UUID
    public let event: BoardNotification

    public init(event: BoardNotification) {
        self.id = UUID()
        self.event = event
    }
}

/// The rules of the app's banner stack, in BoardKit so a test owns them rather
/// than the AppKit code that draws the result — the same arrangement as
/// `BoardNotifier`, whose diff this consumes.
public enum BoardToasts {
    /// Banners the pile draws at once — sonner's `visibleToasts`. A stack that
    /// outgrew the corner it drops into would stop being glanceable, which is
    /// the whole job.
    public static let visible = 3

    /// Appends `event` as the newest banner. Nothing is evicted: past `visible`
    /// the older banners are still held, drawn at nothing behind the pile, and
    /// dismissing one brings the next of them back — sonner's own arrangement.
    /// Banners here do not age out, so a queue that dropped its tail would drop
    /// news nobody had read yet; the board panel opening is what empties it.
    public static func pushing(_ event: BoardNotification, onto rows: [Toast]) -> [Toast] {
        rows + [Toast(event: event)]
    }
}

extension BoardNotification {
    /// The banner's eyebrow — what kind of news this is, above the title that
    /// names the PR.
    public var headline: String {
        switch kind {
        case .mergeable: "Ready to merge"
        case .preview: "Preview ready"
        }
    }
}
