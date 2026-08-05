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

/// One row on the board. Field-for-field the object render-board.sh builds, so the
/// two can be diffed against the same input.
public struct Card: Identifiable, Equatable, Sendable, Encodable {
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

extension Card {
    enum CodingKeys: String, CodingKey {
        case id, num, title, branch, workspace, workspaceId, workspaceUrl, boardState
        case prUrl, ticketKey, ticketUrl, previewUrl, review, ci, threads, draft
        case mergeState, needsOperator, agentState, agentPhase, agentSummary
        case liveness, dirty, unpushed, whatItIs, pill, whereItsAt
    }

    /// Absent optionals are written as explicit nulls, the way jq writes them, so
    /// `--dump-cards` output diffs against the dashboard's payload without either
    /// side having to be normalised first.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(num, forKey: .num)
        try container.encode(title, forKey: .title)
        try container.encode(branch, forKey: .branch)
        try container.encode(workspace, forKey: .workspace)
        try container.encode(workspaceId, forKey: .workspaceId)
        try container.encode(workspaceUrl, forKey: .workspaceUrl)
        try container.encode(boardState, forKey: .boardState)
        try container.encode(prUrl, forKey: .prUrl)
        try container.encode(ticketKey, forKey: .ticketKey)
        try container.encode(ticketUrl, forKey: .ticketUrl)
        try container.encode(previewUrl, forKey: .previewUrl)
        try container.encode(review, forKey: .review)
        try container.encode(ci, forKey: .ci)
        try container.encode(threads, forKey: .threads)
        try container.encode(draft, forKey: .draft)
        try container.encode(mergeState, forKey: .mergeState)
        try container.encode(needsOperator, forKey: .needsOperator)
        try container.encode(agentState, forKey: .agentState)
        try container.encode(agentPhase, forKey: .agentPhase)
        try container.encode(agentSummary, forKey: .agentSummary)
        try container.encode(liveness, forKey: .liveness)
        try container.encode(dirty, forKey: .dirty)
        try container.encode(unpushed, forKey: .unpushed)
        try container.encode(whatItIs, forKey: .whatItIs)
        try container.encode(pill, forKey: .pill)
        try container.encode(whereItsAt, forKey: .whereItsAt)
    }
}
