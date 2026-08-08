import Foundation

/// One project's state directory, and the key that names it.
///
/// The key is the directory under `p/`, which is also `repos[].key` in the
/// orchestrator's config. An empty key is the pre-`p/` layout, where the board
/// sat at the root and there was only ever one.
public struct ProjectRef: Sendable, Equatable, Hashable {
    public let key: String
    public let root: URL

    public init(key: String, root: URL) {
        self.key = key
        self.root = root
    }
}

/// A card, and which project it came from.
///
/// The project is deliberately *outside* `Card`. `Card.encode(to:)` mirrors
/// render-board.sh's jq output field for field, and `CardBuilderGoldenTests`
/// compares the two with no allowance for extra keys. A project field on `Card`
/// would either break that test or force it to loosen — and the test's whole
/// value is that it cannot be loosened. Wrapping keeps the port honest and adds
/// what only the app needs.
public struct ProjectCard: Sendable, Identifiable {
    public let project: ProjectRef
    /// The label on the chip. The repository name by default, or `shortName`.
    public let shortName: String
    public let card: Card

    /// Unique across projects. Two orchestrators number their items
    /// independently, so `itm_4` can exist on both boards and SwiftUI would then
    /// reuse one row for two cards.
    public var id: String { "\(project.key):\(card.id)" }

    public init(project: ProjectRef, shortName: String, card: Card) {
        self.project = project
        self.shortName = shortName
        self.card = card
    }
}
