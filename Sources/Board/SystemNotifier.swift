import AppKit
import BoardKit
import UserNotifications

/// Posts the board's edge events as macOS notifications, and opens the PR or
/// preview when one is clicked.
///
/// The app is ad-hoc signed (see the Makefile) so UNUserNotificationCenter has
/// a stable code identity to grant against; without a signature the request is
/// refused and this quietly does nothing rather than crash. Authorization is
/// asked for once, on launch — if the operator declines, `post` still runs and
/// the system simply drops it, so there is no separate "enabled" flag to keep
/// in sync with the real permission, which lives in System Settings.
@MainActor
final class SystemNotifier: NSObject, UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()
    /// A tap carries its destination here rather than in userInfo alone, so the
    /// open goes through the app's own handler (which dismisses the panel etc.).
    private let open: (String) -> Void

    init(open: @escaping (String) -> Void) {
        self.open = open
        super.init()
        center.delegate = self
    }

    /// Asked once at launch. A refusal is not an error worth surfacing — the
    /// operator can turn it on later in System Settings, and the board still
    /// works without it.
    func requestAuthorization() {
        // The async form, not the completion-handler one: a trailing closure
        // written in this @MainActor type is main-actor-isolated, but
        // UNUserNotificationCenter fires it on a background queue, and Swift's
        // executor check turns that into a SIGTRAP at launch. Awaiting hops
        // back correctly and the result is one we ignore anyway.
        Task { _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) }
    }

    func post(_ event: BoardNotification) {
        let content = UNMutableNotificationContent()
        switch event.kind {
        case .mergeable:
            content.title = "Ready to merge"
        case .preview:
            content.title = "Preview ready"
        }
        // The project only earns a line when more than one board is in play —
        // the store passes nil otherwise, the same rule the card chip follows.
        if let project = event.project {
            content.subtitle = project
        }
        content.body = event.title
        content.sound = .default
        if let url = event.url {
            content.userInfo = ["url": url]
        }
        // A stable identifier per card+kind coalesces a repeat (should the same
        // edge somehow post twice) into one banner rather than stacking them.
        let id = "\(event.kind.rawValue):\(event.cardId)"
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }

    // Show the banner even though the app is a menu-bar accessory — without this
    // a notification posted while the app is "frontmost enough" is swallowed.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    // A tap opens the PR or preview through the app's own link handler.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let url = response.notification.request.content.userInfo["url"] as? String
        completionHandler()
        if let url {
            Task { @MainActor in self.open(url) }
        }
    }
}
