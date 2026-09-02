import Foundation

/// One PR awaiting the operator's review, as cards.json carries it. Reviews are
/// a queue beside the board, not board items: no card, no state machine — a
/// row, three links and a dismissal. The CLI writes the queue already deduped,
/// ledger-subtracted and ordered newest-activity-first; the app draws it.
public struct Review: Sendable, Equatable, Decodable {
    public let repo: String
    public let number: Int
    public let title: String
    public let url: String?
    public let author: String
    public let isDraft: Bool
    public let updatedAt: String?
    public let previewUrl: String?

    private enum CodingKeys: String, CodingKey {
        case repo, number, title, url, author, isDraft, updatedAt, previewUrl
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        repo = try container.decode(String.self, forKey: .repo)
        number = try container.decode(Int.self, forKey: .number)
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? ""
        url = try container.decodeIfPresent(String.self, forKey: .url)
        author = try container.decodeIfPresent(String.self, forKey: .author) ?? "?"
        isDraft = try container.decodeIfPresent(Bool.self, forKey: .isDraft) ?? false
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)
        previewUrl = try container.decodeIfPresent(String.self, forKey: .previewUrl)
    }

    public init(
        repo: String, number: Int, title: String = "", url: String? = nil,
        author: String = "?", isDraft: Bool = false, updatedAt: String? = nil,
        previewUrl: String? = nil
    ) {
        self.repo = repo
        self.number = number
        self.title = title
        self.url = url
        self.author = author
        self.isDraft = isDraft
        self.updatedAt = updatedAt
        self.previewUrl = previewUrl
    }

    /// "owner/name#123" — the spelling every `board review` verb takes.
    public var ref: String { "\(repo)#\(number)" }

    public var updatedAtDate: Date? {
        guard let updatedAt else { return nil }
        return try? Date(updatedAt, strategy: .iso8601)
    }
}

/// A review joined with the project block it came from, for the row's project
/// chip — the same pairing ProjectCard makes for cards.
public struct ProjectReview: Sendable, Equatable {
    public let projectKey: String
    public let shortName: String
    public let review: Review

    public init(projectKey: String, shortName: String, review: Review) {
        self.projectKey = projectKey
        self.shortName = shortName
        self.review = review
    }
}
