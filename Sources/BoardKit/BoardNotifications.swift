import Foundation

/// One thing worth telling the operator about — computed by diffing two board
/// snapshots, so a notification fires on the EDGE (the poll where a PR first
/// became mergeable, or a preview first appeared), never every poll it stays
/// that way.
public struct BoardNotification: Sendable, Equatable {
    public enum Kind: String, Sendable {
        /// The PR can be merged now: approved, green, no conflicts, nothing asked.
        case mergeable
        /// A preview deployment became reachable for the change.
        case preview
    }

    public let kind: Kind
    public let cardId: String
    public let title: String
    /// The project's short name, when more than one board is in play.
    public let project: String?
    /// Where a tap should go — the PR for a merge, the preview for a preview.
    public let url: String?

    public init(kind: Kind, cardId: String, title: String, project: String?, url: String?) {
        self.kind = kind
        self.cardId = cardId
        self.title = title
        self.project = project
        self.url = url
    }
}

/// The two facts a notification watches, per card. Kept as its own value so the
/// store can hold last poll's set and diff the next against it.
public struct CardSignal: Sendable, Equatable {
    public let mergeable: Bool
    public let hasPreview: Bool

    public init(mergeable: Bool, hasPreview: Bool) {
        self.mergeable = mergeable
        self.hasPreview = hasPreview
    }
}

/// The pure diff behind the app's notifications — in BoardKit so a test owns the
/// rules, not the AppKit code that posts them.
public enum BoardNotifier {
    /// The pill labels that mean "you can merge this". `★ Ready to merge` is the
    /// reconciled `ready` state; `Mergeable` is the same PR (approved, green,
    /// clean) in the window before a daemon cycle flips its item to ready. Both
    /// are the operator's move, so both notify.
    static let mergeableLabels: Set<String> = ["★ Ready to merge", "Mergeable"]

    public static func isMergeable(_ card: Card) -> Bool {
        mergeableLabels.contains(card.pill.label)
    }

    /// A preview counts as present only when it is a real, non-empty URL — the
    /// CLI writes null when there is none, and "" would be a URL that opens
    /// nothing.
    static func hasPreview(_ card: Card) -> Bool {
        guard let url = card.previewUrl else { return false }
        return !url.isEmpty
    }

    public static func signal(_ card: Card) -> CardSignal {
        CardSignal(mergeable: isMergeable(card), hasPreview: hasPreview(card))
    }

    /// Every current card's signal, keyed by id — the store seeds this on its
    /// first publish so nothing already-true at launch fires.
    public static func snapshot(_ cards: [ProjectCard]) -> [String: CardSignal] {
        var out: [String: CardSignal] = [:]
        for entry in cards { out[entry.card.id] = signal(entry.card) }
        return out
    }

    /// The notifications to fire, and the snapshot to keep for next time.
    ///
    /// A card ABSENT from `previous` is seeded silently — its true states do not
    /// fire, because "it was already like this when we first saw it" is not news
    /// and a newly-configured project would otherwise dump a banner per
    /// mergeable PR. Only a card carried over from the last poll, whose signal
    /// went false → true, notifies. A card that drops out of the board drops out
    /// of the snapshot, so if it comes back it is seeded afresh rather than
    /// re-firing on stale memory.
    public static func diff(
        previous: [String: CardSignal],
        current: [ProjectCard]
    ) -> (events: [BoardNotification], snapshot: [String: CardSignal]) {
        var events: [BoardNotification] = []
        var snapshot: [String: CardSignal] = [:]
        for entry in current {
            let card = entry.card
            let now = signal(card)
            snapshot[card.id] = now
            guard let was = previous[card.id] else { continue }
            let name = entry.prTitle ?? card.title
            if now.mergeable && !was.mergeable {
                events.append(BoardNotification(
                    kind: .mergeable, cardId: card.id, title: name,
                    project: entry.shortName, url: card.prUrl))
            }
            if now.hasPreview && !was.hasPreview {
                events.append(BoardNotification(
                    kind: .preview, cardId: card.id, title: name,
                    project: entry.shortName, url: card.previewUrl))
            }
        }
        return (events, snapshot)
    }
}
