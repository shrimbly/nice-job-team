import Foundation

/// A PR as the board needs it: the `gh pr list` fields plus the three things that
/// take an extra query — the check rollup as one word, the unresolved-thread count,
/// and the Vercel preview URL.
public struct PullRequest: Sendable, Equatable {
    public var number: Int
    public var title: String
    public var headRefName: String?
    public var baseRefName: String?
    public var url: String?
    public var isDraft: Bool?
    public var reviewDecision: String?
    public var updatedAt: String?
    public var mergeStateStatus: String?
    public var repo: String?
    public var ciState: String
    public var unresolvedThreads: Int
    public var previewUrl: String?

    public init(
        number: Int, title: String = "", headRefName: String? = nil,
        baseRefName: String? = nil, url: String? = nil, isDraft: Bool? = nil,
        reviewDecision: String? = nil, updatedAt: String? = nil,
        mergeStateStatus: String? = nil, repo: String? = nil,
        ciState: String = "unknown", unresolvedThreads: Int = 0,
        previewUrl: String? = nil
    ) {
        self.number = number
        self.title = title
        self.headRefName = headRefName
        self.baseRefName = baseRefName
        self.url = url
        self.isDraft = isDraft
        self.reviewDecision = reviewDecision
        self.updatedAt = updatedAt
        self.mergeStateStatus = mergeStateStatus
        self.repo = repo
        self.ciState = ciState
        self.unresolvedThreads = unresolvedThreads
        self.previewUrl = previewUrl
    }
}

// MARK: - Check rollup

public enum CIState {
    /// One entry of `statusCheckRollup`. A CheckRun carries `conclusion` (empty
    /// while it runs); a StatusContext carries `state` and no `conclusion` at all.
    public struct Entry: Sendable, Decodable {
        public var conclusion: String?
        public var state: String?

        public init(conclusion: String? = nil, state: String? = nil) {
            self.conclusion = conclusion
            self.state = state
        }

        /// jq's `.conclusion // .state // ""`: an empty conclusion is still a value,
        /// so a running check reads as "" rather than falling through to `.state`.
        var value: String { conclusion ?? state ?? "" }
    }

    static let failed: Set<String> = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"]
    static let pending: Set<String> = ["PENDING", "IN_PROGRESS", "QUEUED", ""]

    public static func rollup(_ entries: [Entry]) -> String {
        let values = entries.map(\.value)
        if values.contains(where: failed.contains) { return "red" }
        if values.contains(where: pending.contains) { return "running" }
        if values.isEmpty { return "none" }
        return "green"
    }
}

// MARK: - Preview URL

public enum PreviewURL {
    // Deliberately the same pattern poll.sh greps for. The preview link lives only
    // in the Vercel bot's comment — the Vercel check's targetUrl points at the
    // dashboard inspector, not the deployed site.
    private static let pattern = try! NSRegularExpression(
        pattern: #"https://[a-z0-9._-]*vercel\.app[^ )"]*"#)

    public static func firstMatch(inComments bodies: [String]) -> String? {
        let joined = bodies.joined(separator: "\n")
        let range = NSRange(joined.startIndex..., in: joined)
        guard let match = pattern.firstMatch(in: joined, range: range),
              let found = Range(match.range, in: joined) else { return nil }
        return String(joined[found])
    }
}

// MARK: - Decoding

public enum GitHubDecoder {
    /// The `gh pr list --json …` shape. Rolls checks up on the way in.
    public static func pullRequests(fromList data: Data, repo: String) throws -> [PullRequest] {
        struct Row: Decodable {
            var number: Int
            var title: String?
            var headRefName: String?
            var baseRefName: String?
            var url: String?
            var isDraft: Bool?
            var reviewDecision: String?
            var updatedAt: String?
            var mergeStateStatus: String?
            var statusCheckRollup: [CIState.Entry]?
        }
        return try JSONDecoder().decode([Row].self, from: data).map { row in
            PullRequest(
                number: row.number, title: row.title ?? "", headRefName: row.headRefName,
                baseRefName: row.baseRefName, url: row.url, isDraft: row.isDraft,
                reviewDecision: row.reviewDecision, updatedAt: row.updatedAt,
                mergeStateStatus: row.mergeStateStatus, repo: repo,
                ciState: CIState.rollup(row.statusCheckRollup ?? []))
        }
    }

    /// `signals/github.json`, which poll.sh has already normalised. Used to render a
    /// board from the orchestrator's last poll when `gh` itself is unavailable.
    public static func pullRequests(fromSignals data: Data) throws -> [PullRequest] {
        struct File: Decodable {
            struct Repo: Decodable {
                var repo: String?
                var open: [Row]?
            }
            struct Row: Decodable {
                var number: Int
                var title: String?
                var headRefName: String?
                var baseRefName: String?
                var url: String?
                var isDraft: Bool?
                var reviewDecision: String?
                var updatedAt: String?
                var mergeStateStatus: String?
                var repo: String?
                var ciState: String?
                var unresolvedThreads: Int?
                var previewUrl: String?
            }
            var repos: [Repo]?
        }
        let file = try JSONDecoder().decode(File.self, from: data)
        return (file.repos ?? []).flatMap { repo in
            (repo.open ?? []).map { row in
                PullRequest(
                    number: row.number, title: row.title ?? "", headRefName: row.headRefName,
                    baseRefName: row.baseRefName, url: row.url, isDraft: row.isDraft,
                    reviewDecision: row.reviewDecision, updatedAt: row.updatedAt,
                    mergeStateStatus: row.mergeStateStatus, repo: row.repo ?? repo.repo,
                    ciState: row.ciState ?? "unknown",
                    unresolvedThreads: row.unresolvedThreads ?? 0,
                    previewUrl: row.previewUrl)
            }
        }
    }

    /// The PRs poll.sh recorded as merged. It writes them beside the open ones and
    /// render-board.sh never looks at them.
    public static func mergedNumbers(fromSignals data: Data) throws -> Set<Int> {
        struct File: Decodable {
            struct Repo: Decodable {
                struct Row: Decodable { var number: Int }
                var merged: [Row]?
            }
            var repos: [Repo]?
        }
        let file = try JSONDecoder().decode(File.self, from: data)
        return Set((file.repos ?? []).flatMap { ($0.merged ?? []).map(\.number) })
    }

    /// The batched thread/comment query's response. Aliases are ignored — each PR
    /// node carries its own number.
    public struct Details: Sendable, Equatable {
        public var unresolvedThreads: Int
        public var previewUrl: String?
    }

    public static func details(fromGraphQL data: Data) throws -> (byNumber: [Int: Details], quotaRemaining: Int?) {
        let envelope = try JSONDecoder().decode(Envelope.self, from: data)
        var byNumber: [Int: Details] = [:]
        for node in envelope.nodes {
            let unresolved = (node.reviewThreads?.nodes ?? []).filter { $0.isResolved == false }
            let bodies = (node.comments?.nodes ?? []).compactMap(\.body)
            byNumber[node.number] = Details(
                unresolvedThreads: unresolved.count,
                previewUrl: PreviewURL.firstMatch(inComments: bodies))
        }
        return (byNumber, envelope.quotaRemaining)
    }

    private struct DynamicKey: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(_ value: String) { stringValue = value }
        init?(stringValue value: String) { stringValue = value }
        init?(intValue: Int) { nil }
    }

    private struct PRNode: Decodable {
        struct Threads: Decodable {
            struct Thread: Decodable { var isResolved: Bool? }
            var nodes: [Thread]?
        }
        struct Comments: Decodable {
            struct Comment: Decodable { var body: String? }
            var nodes: [Comment]?
        }
        var number: Int
        var reviewThreads: Threads?
        var comments: Comments?
    }

    /// The aliases are generated, so the response is walked by shape rather than by
    /// name: everything under `data` except `rateLimit` is a repository whose own
    /// keys are pull requests. A PR that errored comes back null and is skipped.
    private struct Envelope: Decodable {
        var nodes: [PRNode] = []
        var quotaRemaining: Int?

        init(from decoder: Decoder) throws {
            struct Limit: Decodable { var remaining: Int? }
            let root = try decoder.container(keyedBy: DynamicKey.self)
            guard let block = try? root.nestedContainer(
                keyedBy: DynamicKey.self, forKey: DynamicKey("data")) else { return }

            for key in block.allKeys {
                if key.stringValue == "rateLimit" {
                    quotaRemaining = (try? block.decode(Limit.self, forKey: key))?.remaining
                    continue
                }
                guard let repo = try? block.nestedContainer(keyedBy: DynamicKey.self, forKey: key)
                else { continue }
                for prKey in repo.allKeys {
                    if let node = try? repo.decode(PRNode.self, forKey: prKey) { nodes.append(node) }
                }
            }
        }
    }
}
