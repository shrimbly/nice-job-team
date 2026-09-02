import Foundation

/// A card, and which project it came from — the row the panel draws.
///
/// Decode-backed since P6: everything here comes out of the CLI's cards.json
/// (`CardsDocument`), never from an assembly of the app's own. The project's
/// key, shortName and trackerKind ride in from the enclosing project block; the
/// host, prTitle and stack from the card entry itself.
public struct ProjectCard: Sendable, Identifiable {
    /// The directory name under `p/`, which is also `repos[].key` in the
    /// orchestrator's config. Empty in the pre-`p/` single-project layout.
    public let projectKey: String
    /// The label on the chip. The repository name by default, or `shortName`.
    public let shortName: String
    public let card: Card
    /// Every PR this card stands for, bottom of the stack first. Empty on an
    /// ordinary card — the count, not the emptiness, is what the chip reads, so a
    /// card for one PR carries nothing here rather than a list of one.
    public let stack: [StackRow]
    /// Which tracker the ticket chip stands for, so it can name and draw itself.
    public let trackerKind: String
    /// `local` or `cloud`. The workspace chip needs to know which it is to name
    /// and draw itself; the URL it opens already travels in `Card.workspaceUrl`.
    public let host: String
    /// The PR's own title, when the card is titled by a board item and the two
    /// differ. The card shows the item's short title; this rides the PR chip's
    /// hover so the GitHub title stays reachable.
    public let prTitle: String?

    /// Unique across projects. Two orchestrators number their items
    /// independently, so `itm_4` can exist on both boards and SwiftUI would then
    /// reuse one row for two cards.
    public var id: String { "\(projectKey):\(card.id)" }

    /// 1 for an ordinary card, so callers do not have to know that a stack of one
    /// is stored as no stack at all.
    public var prCount: Int { max(1, stack.count) }

    /// True when the agent runs on claude.ai rather than in a local workspace.
    public var isCloud: Bool { host == "cloud" }

    public init(
        projectKey: String, shortName: String, card: Card,
        stack: [StackRow] = [], trackerKind: String = "linear",
        host: String = "local", prTitle: String? = nil
    ) {
        self.projectKey = projectKey
        self.shortName = shortName
        self.card = card
        self.stack = stack.count > 1 ? stack : []
        self.trackerKind = trackerKind
        self.host = host
        self.prTitle = prTitle
    }
}
