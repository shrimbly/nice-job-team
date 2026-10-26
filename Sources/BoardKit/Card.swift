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
/// none of its own — plus the one app-mode key, `previewPending`, which older
/// documents simply lack and which decodes as nil, read as false.
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
    /// True while the preview host's own deploy check is still running — the
    /// preview URL serves the previous push until it lands. Nil on a document
    /// from a CLI that predates the field.
    public let previewPending: Bool?

    enum CodingKeys: String, CodingKey {
        case id, num, title, branch, workspace, workspaceId, workspaceUrl, boardState
        case prUrl, ticketKey, ticketUrl, previewUrl, review, ci, threads, draft
        case mergeState, needsOperator, agentState, agentPhase, agentSummary, liveness
        case dirty, unpushed, whatItIs, pill, whereItsAt, previewPending
    }

    public init(
        id: String, num: Int?, title: String, branch: String, workspace: String?,
        workspaceId: String?, workspaceUrl: String?, boardState: String, prUrl: String?,
        ticketKey: String?, ticketUrl: String?, previewUrl: String?, review: String?,
        ci: String, threads: Int, draft: Bool, mergeState: String?, needsOperator: Bool,
        agentState: String?, agentPhase: String?, agentSummary: String?, liveness: String?,
        dirty: String?, unpushed: String?, whatItIs: String, pill: Pill, whereItsAt: String?,
        previewPending: Bool? = nil
    ) {
        self.id = id
        self.num = num
        self.title = title
        self.branch = branch
        self.workspace = workspace
        self.workspaceId = workspaceId
        self.workspaceUrl = workspaceUrl
        self.boardState = boardState
        self.prUrl = prUrl
        self.ticketKey = ticketKey
        self.ticketUrl = ticketUrl
        self.previewUrl = previewUrl
        self.review = review
        self.ci = ci
        self.threads = threads
        self.draft = draft
        self.mergeState = mergeState
        self.needsOperator = needsOperator
        self.agentState = agentState
        self.agentPhase = agentPhase
        self.agentSummary = agentSummary
        self.liveness = liveness
        self.dirty = dirty
        self.unpushed = unpushed
        self.whatItIs = whatItIs
        self.pill = pill
        self.whereItsAt = whereItsAt
        self.previewPending = previewPending
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        num = try container.decodeIfPresent(Int.self, forKey: .num)
        title = try container.decode(String.self, forKey: .title)
        branch = try container.decode(String.self, forKey: .branch)
        workspace = try container.decodeIfPresent(String.self, forKey: .workspace)
        workspaceId = try container.decodeIfPresent(String.self, forKey: .workspaceId)
        workspaceUrl = try container.decodeIfPresent(String.self, forKey: .workspaceUrl)
        boardState = try container.decode(String.self, forKey: .boardState)
        prUrl = try container.decodeIfPresent(String.self, forKey: .prUrl)
        ticketKey = try container.decodeIfPresent(String.self, forKey: .ticketKey)
        ticketUrl = try container.decodeIfPresent(String.self, forKey: .ticketUrl)
        previewUrl = try container.decodeIfPresent(String.self, forKey: .previewUrl)
        review = try container.decodeIfPresent(String.self, forKey: .review)
        ci = try container.decode(String.self, forKey: .ci)
        threads = try container.decode(Int.self, forKey: .threads)
        draft = try container.decode(Bool.self, forKey: .draft)
        mergeState = try container.decodeIfPresent(String.self, forKey: .mergeState)
        needsOperator = try container.decode(Bool.self, forKey: .needsOperator)
        agentState = try container.decodeIfPresent(String.self, forKey: .agentState)
        agentPhase = try container.decodeIfPresent(String.self, forKey: .agentPhase)
        agentSummary = try container.decodeIfPresent(String.self, forKey: .agentSummary)
        liveness = try container.decodeIfPresent(String.self, forKey: .liveness)
        dirty = try container.decodeIfPresent(String.self, forKey: .dirty)
        unpushed = try container.decodeIfPresent(String.self, forKey: .unpushed)
        whatItIs = try container.decode(String.self, forKey: .whatItIs)
        pill = try container.decode(Pill.self, forKey: .pill)
        whereItsAt = try container.decodeIfPresent(String.self, forKey: .whereItsAt)
        previewPending = try container.decodeIfPresent(Bool.self, forKey: .previewPending)
    }
}

extension Card {
    /// The token `board dismiss` takes for this card, or nil when the id could
    /// not safely be one.
    ///
    /// Every card can be dismissed — one the board invented for an unclaimed
    /// pull request and one an item stands behind alike — and the card's own id
    /// is what the ledger keys on, so this is mostly `id` itself. What it adds
    /// is the guard: the value is handed to the CLI as an argument, so an id
    /// carrying whitespace, or one that would be read as a flag, must not
    /// become a command. Ids are the orchestrator's to shape and this does not
    /// second-guess them beyond that.
    public var dismissalRef: String? {
        let token = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty,
              token == id,
              !token.hasPrefix("-"),
              !token.contains(where: \.isWhitespace) else { return nil }
        return token
    }
}
