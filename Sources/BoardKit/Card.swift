import Foundation

/// The six tones render-board.sh assigns, in the order it sorts them.
public enum Tone: String, Codable, Sendable, CaseIterable {
    case you, agent, bad, good, review, mute

    public var sortRank: Int {
        switch self {
        case .you: 0
        case .bad: 1
        case .agent: 2
        case .good: 3
        case .review: 4
        case .mute: 5
        }
    }

    /// The tone that means "the operator has to do something".
    public var needsOperator: Bool { self == .you }
}

public struct Pill: Equatable, Sendable, Codable {
    public let label: String
    public let tone: Tone

    public init(label: String, tone: Tone) {
        self.label = label
        self.tone = tone
    }
}

/// One row on the board. Field-for-field the 27-key object the CLI's card chain
/// builds into cards.json — the app decodes these and draws them, and builds
/// none of its own.
public struct Card: Identifiable, Equatable, Sendable, Decodable {
    public let id: String
    public let num: Int?
    public let title: String
    public let branch: String
    public let workspace: String?
    public let workspaceId: String?
    public let workspaceUrl: String?
    public let boardState: String
    public let prUrl: String?
    public let ticketKey: String?
    public let ticketUrl: String?
    public let previewUrl: String?
    public let review: String?
    public let ci: String
    public let threads: Int
    public let draft: Bool
    public let mergeState: String?
    public let needsOperator: Bool
    public let agentState: String?
    public let agentPhase: String?
    public let agentSummary: String?
    public let liveness: String?
    public let dirty: String?
    public let unpushed: String?
    public let whatItIs: String
    public let pill: Pill
    /// Null only in the one case jq produces null: an empty summary at the gate.
    public let whereItsAt: String?
}
