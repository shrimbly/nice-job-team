import Foundation
import Testing
@testable import BoardKit

/// `expected-gh.json` is produced by poll.sh's own rollup jq and its own grep, run
/// over the very same `gh-pr-list.json` and `graphql-details.json` captures the
/// Swift decoders read here — so the two implementations are compared on identical
/// input rather than on two different moments of a live repo.
struct GitHubDecodingTests {

    @Test("gh pr list decodes and rolls checks up the way poll.sh does")
    func listMatchesReference() throws {
        let prs = try GitHubDecoder.pullRequests(
            fromList: try Fixtures.data("gh-pr-list.json"), repo: "acme/platform")
        let golden = try Fixtures.json(at: Fixtures.root.appendingPathComponent("expected-gh.json"))

        #expect(prs.count == 5)
        for pr in prs {
            let want = try #require(golden[String(pr.number)] as? [String: Any],
                                    "no golden for #\(pr.number)")
            #expect(pr.ciState == want["ciState"] as? String, "#\(pr.number) ciState")
            #expect(pr.repo == "acme/platform")
        }
    }

    @Test("the batched GraphQL response yields threads and preview URLs per PR")
    func graphQLMatchesReference() throws {
        let (details, quota) = try GitHubDecoder.details(
            fromGraphQL: try Fixtures.data("graphql-details.json"))
        let golden = try Fixtures.json(at: Fixtures.root.appendingPathComponent("expected-gh.json"))

        #expect(details.count == 5)
        #expect(quota == 4865)
        for (number, detail) in details {
            let want = try #require(golden[String(number)] as? [String: Any])
            #expect(detail.previewUrl == want["previewUrl"] as? String, "#\(number) previewUrl")
            #expect(detail.unresolvedThreads == want["unresolvedThreads"] as? Int, "#\(number) threads")
        }
    }

    @Test("gh's empty reviewDecision survives as empty, not as APPROVED or nil")
    func emptyReviewDecision() throws {
        // #444 has nobody assigned; gh emits "" rather than null, and the pill chain
        // depends on that landing on "No reviewer".
        let prs = try GitHubDecoder.pullRequests(
            fromList: try Fixtures.data("gh-pr-list.json"), repo: "r")
        let pr = try #require(prs.first { $0.number == 444 })
        #expect(pr.reviewDecision == "")

        let item = BoardItem(id: "i", title: "t", state: "pr-open",
                             pr: .init(number: 444))
        #expect(CardBuilder.pill(item: item, pr: pr, agent: nil, needsOperator: false)
                == Pill(label: "No reviewer", tone: .you))
    }

    // MARK: - Check rollup

    @Test("a failing check outranks a running one")
    func rollupPrecedence() {
        #expect(CIState.rollup([.init(conclusion: "SUCCESS"), .init(conclusion: "FAILURE"),
                                .init(conclusion: "")]) == "red")
    }

    @Test("a CheckRun still running reports an empty conclusion, not a state")
    func rollupRunning() {
        // The jq is `.conclusion // .state // ""`, and "" is a value in jq — a
        // pending run must read as running rather than falling through to .state.
        #expect(CIState.rollup([.init(conclusion: "", state: "SUCCESS")]) == "running")
        #expect(CIState.rollup([.init(conclusion: "SUCCESS"), .init(conclusion: "IN_PROGRESS")]) == "running")
    }

    @Test("a StatusContext has no conclusion at all, so its state is used")
    func rollupStatusContext() {
        #expect(CIState.rollup([.init(state: "SUCCESS")]) == "green")
        #expect(CIState.rollup([.init(state: "FAILURE")]) == "red")
        #expect(CIState.rollup([.init(state: "PENDING")]) == "running")
    }

    @Test("no checks at all is none, not green")
    func rollupEmpty() {
        #expect(CIState.rollup([]) == "none")
    }

    @Test("SKIPPED and NEUTRAL do not make a PR red")
    func rollupSkipped() {
        #expect(CIState.rollup([.init(conclusion: "SKIPPED"), .init(conclusion: "SUCCESS")]) == "green")
        #expect(CIState.rollup([.init(conclusion: "NEUTRAL")]) == "green")
    }

    // MARK: - Preview URL

    @Test("the preview URL is the first vercel link in the comments")
    func previewFirstMatch() {
        let bodies = [
            "no link here",
            "Preview: https://website-git-branch-acme.vercel.app and more",
            "https://other-acme.vercel.app",
        ]
        #expect(PreviewURL.firstMatch(inComments: bodies)
                == "https://website-git-branch-acme.vercel.app")
    }

    @Test("markdown punctuation is not swallowed into the URL")
    func previewStopsAtDelimiters() {
        #expect(PreviewURL.firstMatch(inComments: ["[Visit](https://a-acme.vercel.app)"])
                == "https://a-acme.vercel.app")
        #expect(PreviewURL.firstMatch(inComments: ["\"https://b-acme.vercel.app/path\""])
                == "https://b-acme.vercel.app/path")
    }

    @Test("a PR with no bot comment has no preview")
    func previewAbsent() {
        #expect(PreviewURL.firstMatch(inComments: ["LGTM", "https://github.com/x"]) == nil)
    }

    // MARK: - Robustness

    @Test("missing and null fields decode rather than throw")
    func lenientDecoding() throws {
        let json = Data("""
            [{"number": 1},
             {"number": 2, "title": null, "isDraft": null, "reviewDecision": null,
              "statusCheckRollup": []}]
            """.utf8)
        let prs = try GitHubDecoder.pullRequests(fromList: json, repo: "r")
        #expect(prs.count == 2)
        #expect(prs[0].title == "")
        #expect(prs[0].ciState == "none")
        #expect(prs[1].isDraft == nil)
    }

    @Test("a GraphQL response with errors and null nodes yields what did resolve")
    func partialGraphQL() throws {
        let json = Data("""
            {"data": {"rateLimit": {"remaining": 4999},
                      "r0": {"p1": null,
                             "p2": {"number": 2,
                                    "reviewThreads": {"nodes": [{"isResolved": false},
                                                                {"isResolved": true}]},
                                    "comments": {"nodes": [{"body": "x"}]}}}},
             "errors": [{"message": "boom"}]}
            """.utf8)
        let (details, quota) = try GitHubDecoder.details(fromGraphQL: json)
        #expect(quota == 4999)
        #expect(details.count == 1)
        #expect(details[2]?.unresolvedThreads == 1)
    }

    // MARK: - Query shape

    @Test("the details query batches every PR into one call")
    func queryIsBatched() {
        let query = GitHubClient.detailsQuery(for: [
            PullRequest(number: 12, repo: "o/r"),
            PullRequest(number: 3, repo: "o/r"),
            PullRequest(number: 7, repo: "other/repo"),
        ])
        #expect(query.contains(#"r0: repository(owner: "o", name: "r")"#))
        #expect(query.contains(#"r1: repository(owner: "other", name: "repo")"#))
        // Sorted, so the same board always produces the same query text.
        #expect(query.range(of: "p3:")!.lowerBound < query.range(of: "p12:")!.lowerBound)
        #expect(query.contains("rateLimit { remaining }"))
        #expect(query.components(separatedBy: "pullRequest(number:").count - 1 == 3)
    }
}
