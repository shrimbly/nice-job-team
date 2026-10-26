import Foundation

/// One thing worth telling the operator about — computed by diffing two board
/// snapshots, so a notification fires on the EDGE (the poll where a PR first
/// became mergeable, or a preview deployment landed), never every poll it stays
/// that way.
public struct BoardNotification: Sendable, Equatable {
    public enum Kind: String, Sendable {
        /// The PR can be merged now: approved, green, no conflicts, nothing asked.
        case mergeable
        /// A preview deployment finished and is serving the change. Not the
        /// push that started it, and not the URL turning up — see the diff.
        case preview
    }

    public let kind: Kind
    public let cardId: String
    /// The card's own title, which is the item's — short, written for a person,
    /// and the same words the operator will look for on the board when the
    /// banner sends them there. Deliberately not the PR title: that one is
    /// written for a commit log, carries a conventional-commit prefix and often
    /// a trail of ticket ids, and a banner is one line under the menu bar.
    /// A card synthesized from an unclaimed PR is titled from the PR anyway.
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

/// What the board last knew about a card's preview deployment.
public struct PreviewSignal: Sendable, Equatable {
    /// Where the deployment is served. The host gives a branch one URL and
    /// keeps it across pushes, which is why the URL's arrival cannot be the
    /// thing that notifies — it arrives once and then never changes again.
    public let url: String
    /// The deploy host's own check was still running when the board looked, so
    /// the URL is still serving the previous push.
    public let pending: Bool

    public init(url: String, pending: Bool) {
        self.url = url
        self.pending = pending
    }

    /// Serving this change rather than building it.
    public var isLive: Bool { !pending }
}

/// The two facts a notification watches, per card. Kept as its own value so the
/// store can hold last poll's set and diff the next against it.
public struct CardSignal: Sendable, Equatable {
    public let mergeable: Bool
    /// Nil until a preview has been seen at all, and sticky once it has — see
    /// `BoardNotifier.signal(_:carrying:)`.
    public let preview: PreviewSignal?

    public init(mergeable: Bool, preview: PreviewSignal?) {
        self.mergeable = mergeable
        self.preview = preview
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
    static func preview(_ card: Card) -> PreviewSignal? {
        guard let url = card.previewUrl, !url.isEmpty else { return nil }
        return PreviewSignal(url: url, pending: card.previewPending == true)
    }

    /// This poll's signal for a card, carrying forward what the last poll knew.
    ///
    /// The preview is sticky, and that is the whole of the fix for a board that
    /// announced every preview the operator already had. A poll can come back
    /// without a preview URL for reasons that have nothing to do with the
    /// deployment: the URL is read out of the host's comment on the PR, which
    /// costs a second query, and that query gets skipped, rate-limited or
    /// partially returned. Recording the absence would make the URL's return
    /// look like a deployment landing — for every card at once, since one
    /// failed query loses them all together.
    ///
    /// So absence is treated as ignorance rather than as news. A preview that
    /// has genuinely gone leaves with its card, and a card that leaves the
    /// board leaves the snapshot.
    public static func signal(_ card: Card, carrying previous: CardSignal? = nil) -> CardSignal {
        CardSignal(mergeable: isMergeable(card), preview: preview(card) ?? previous?.preview)
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
    /// mergeable PR. Only a card carried over from the last poll notifies, and
    /// only on the poll its signal crosses. A card that drops out of the board
    /// drops out of the snapshot, so if it comes back it is seeded afresh rather
    /// than re-firing on stale memory.
    ///
    /// Silent seeding is also why a brand-new PR whose preview is already live
    /// the first time the board sees it says nothing: there is no baseline to
    /// cross. In practice the board sees the PR the moment it opens and the
    /// deploy takes a minute, so the first poll catches it building and the
    /// landing notifies — and the alternative, treating an unseen card as news,
    /// would fire for every card on the board the first poll after any failure
    /// that emptied it.
    public static func diff(
        previous: [String: CardSignal],
        current: [ProjectCard]
    ) -> (events: [BoardNotification], snapshot: [String: CardSignal]) {
        var events: [BoardNotification] = []
        var snapshot: [String: CardSignal] = [:]
        for entry in current {
            let card = entry.card
            let was = previous[card.id]
            let now = signal(card, carrying: was)
            snapshot[card.id] = now
            guard let was else { continue }
            let name = card.title
            if now.mergeable && !was.mergeable {
                events.append(BoardNotification(
                    kind: .mergeable, cardId: card.id, title: name,
                    project: entry.shortName, url: card.prUrl))
            }
            // A preview is news when its deployment goes live — not when its
            // URL turns up, and emphatically not when the push that starts the
            // deployment does. The host keeps one URL per branch, so the URL
            // arrives once and says nothing thereafter; what happens on every
            // push is that the deploy starts, the URL goes on serving the
            // previous change for a minute, and then the new one lands. That
            // landing is `pending` falling, and it is the only edge worth a
            // banner: it is the moment there is something new to look at.
            //
            // A live preview at an address the board has not served before
            // counts too, for the rare case of a project moving hosts.
            if let live = now.preview, live.isLive,
               was.preview?.isLive != true || was.preview?.url != live.url {
                events.append(BoardNotification(
                    kind: .preview, cardId: card.id, title: name,
                    project: entry.shortName, url: live.url))
            }
        }
        return (events, snapshot)
    }
}
