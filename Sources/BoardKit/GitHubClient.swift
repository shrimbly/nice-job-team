import Foundation

/// Reads open PRs through `gh`, which already carries the operator's credentials —
/// there is no token for this app to store, and nothing it could leak.
///
/// Two calls per refresh regardless of how many PRs are on screen: one `gh pr list`
/// per repo, then a single GraphQL query that batches every PR's review threads and
/// comments behind generated aliases. With the one repo the orchestrator configures
/// that is two calls a minute — about 120 of the 5,000-per-hour budget.
public struct GitHubClient: Sendable {
    public struct Fetch: Sendable {
        public var pullRequests: [PullRequest]
        public var quotaRemaining: Int?
        public var calls: Int
    }

    public let executable: URL
    public let listLimit: Int

    public init(executable: URL, listLimit: Int = 50) {
        self.executable = executable
        self.listLimit = listLimit
    }

    /// Nil when `gh` is not installed anywhere the app can find it.
    public static func locate(listLimit: Int = 50) -> GitHubClient? {
        Shell.locate("gh", overrideEnvironment: "BOARD_GH_PATH")
            .map { GitHubClient(executable: $0, listLimit: listLimit) }
    }

    public func fetch(repos: [String]) async throws -> Fetch {
        var pullRequests: [PullRequest] = []
        var calls = 0
        var firstFailure: Error?

        for repo in repos {
            do {
                pullRequests += try await openPullRequests(repo: repo)
            } catch {
                // One unreachable repo must not blank the whole board.
                if firstFailure == nil { firstFailure = error }
            }
            calls += 1
        }
        if pullRequests.isEmpty, let firstFailure { throw firstFailure }

        guard !pullRequests.isEmpty else { return Fetch(pullRequests: [], quotaRemaining: nil, calls: calls) }

        let (details, quota) = try await self.details(for: pullRequests)
        calls += 1
        for index in pullRequests.indices {
            guard let extra = details[pullRequests[index].number] else { continue }
            pullRequests[index].unresolvedThreads = extra.unresolvedThreads
            pullRequests[index].previewUrl = extra.previewUrl
        }
        return Fetch(pullRequests: pullRequests, quotaRemaining: quota, calls: calls)
    }

    // MARK: -

    private func openPullRequests(repo: String) async throws -> [PullRequest] {
        let output = try await Shell.run(executable, [
            "pr", "list", "--repo", repo, "--author", "@me", "--state", "open",
            "--limit", String(listLimit), "--json",
            "number,title,headRefName,baseRefName,url,isDraft,reviewDecision,updatedAt,mergeStateStatus,statusCheckRollup",
        ])
        return try GitHubDecoder.pullRequests(fromList: output.stdout, repo: repo)
    }

    private func details(
        for pullRequests: [PullRequest]
    ) async throws -> ([Int: GitHubDecoder.Details], Int?) {
        let query = Self.detailsQuery(for: pullRequests)
        // A thread or comment page that errors comes back null beside the ones that
        // did resolve, so partial data is still worth decoding.
        let output = try? await Shell.run(executable, ["api", "graphql", "-f", "query=\(query)"])
        guard let output else { return ([:], nil) }
        return try GitHubDecoder.details(fromGraphQL: output.stdout)
    }

    /// One query, one alias per repo and per PR. Sorted so the same board always
    /// produces the same query text.
    static func detailsQuery(for pullRequests: [PullRequest]) -> String {
        let byRepo = Dictionary(grouping: pullRequests) { $0.repo ?? "" }
        var blocks: [String] = []
        for (repoIndex, repo) in byRepo.keys.sorted().enumerated() {
            let parts = repo.split(separator: "/", maxSplits: 1)
            guard parts.count == 2 else { continue }
            let numbers = (byRepo[repo] ?? []).map(\.number).sorted()
            let fields = numbers.map { "      p\($0): pullRequest(number: \($0)) { ...prDetails }" }
            blocks.append("""
                  r\(repoIndex): repository(owner: "\(parts[0])", name: "\(parts[1])") {
                \(fields.joined(separator: "\n"))
                  }
                """)
        }
        return """
            query {
              rateLimit { remaining }
            \(blocks.joined(separator: "\n"))
            }
            fragment prDetails on PullRequest {
              number
              reviewThreads(first: 100) { nodes { isResolved } }
              comments(first: 100) { nodes { body } }
            }
            """
    }
}
