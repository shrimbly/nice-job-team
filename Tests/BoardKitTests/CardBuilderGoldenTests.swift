import Foundation
import Testing
@testable import BoardKit

/// The card model is a port of render-board.sh. These compare the Swift output
/// field-for-field against JSON produced by that script's own jq over the same
/// frozen inputs, so drift in either direction shows up as a diff rather than as a
/// board that quietly disagrees with the dashboard.
///
/// To regenerate after an intentional change to render-board.sh, from this directory:
///
///     R=~/.claude/skills/superset-orchestrator/scripts/render-board.sh
///     sed -n '48,132p' $R | sed "\$s/')\"\$//" > /tmp/board.jq
///     for d in Fixtures Fixtures/synthetic; do
///       jq -n --slurpfile board $d/board.json --argjson gh "$(cat $d/github.json)" \
///          --argjson status "$(jq -s . $d/workspaces/*.json)" \
///          --argjson ws "$(jq -c .workspaces $d/workspaces-signal.json)" \
///          --arg linearWs acme --arg generatedAt X -f /tmp/board.jq > $d/expected-cards.json
///     done
struct CardBuilderGoldenTests {

    @Test("matches the reference dashboard on a live board snapshot")
    func liveSnapshot() throws {
        _ = try compareWithReference(fixture: ".", expectedDivergences: 0)
    }

    /// A live snapshot only ever exercises a handful of states; this fixture is
    /// built to reach every branch of both chains.
    @Test("matches the reference dashboard on every pill branch")
    func everyBranch() throws {
        let cards = try compareWithReference(fixture: "synthetic", expectedDivergences: 3)

        // Guard the fixture itself: were it to stop covering the chains, the
        // comparison above would still pass while proving much less.
        #expect(Set(cards.map(\.pill.tone)) == Set(Tone.allCases))
        // "Dispatched" is gone: the reference stopped labelling a `fixing` item that
        // way, because it named a state the item was not in.
        #expect(Set(cards.map(\.pill.label)) == [
            "Blocked", "★ Ready to merge", "Needs you", "Working", "Fixing", "Draft",
            "CI red", "CI running", "Conflicts", "Mergeable", "Changes req",
            "In review", "No reviewer", "Merged — reap", "PR Gone",
            "Starting", "queued",
        ])
    }

    @Test("drops closed and rejected items, as the reference does")
    func excludesClosed() throws {
        let dir = Fixtures.root.appendingPathComponent("synthetic")
        let items = try Fixtures.boardItems(in: dir)
        let cards = CardBuilder.build(
            items: items, pullRequests: [], agents: [], workspaces: [])

        #expect(items.count == 29)
        #expect(cards.count == 27)
        #expect(!cards.contains { $0.id == "i-closed" || $0.id == "i-rejected" })
    }

    // MARK: - The deliberate divergences

    @Test("an approved PR whose checks are still running is not yet mergeable")
    func runningCIIsNotMergeable() throws {
        let cards = try build(fixture: "synthetic")

        // The reference calls this "Mergeable"; branch protection would refuse it.
        #expect(cards["i-mergeable-running"]?.pill == Pill(label: "CI running", tone: .review))
        #expect(cards["i-mergeable-running"]?.whereItsAt == "Approved. Waiting on the checks to finish.")

        // It sorts below the PRs that really can be merged now.
        #expect(cards["i-mergeable"]?.pill.tone.sortRank ?? 9
                < cards["i-mergeable-running"]?.pill.tone.sortRank ?? 0)

        // ...and the cards it must leave alone.
        #expect(cards["i-mergeable"]?.pill == Pill(label: "Mergeable", tone: .good),
                "a green approved PR is still mergeable")
        #expect(cards["i-conflicts-running"]?.pill == Pill(label: "Conflicts", tone: .bad),
                "a conflicting branch is the more actionable problem than a running check")
        #expect(cards["i-in-review"]?.pill == Pill(label: "In review", tone: .review),
                "running checks do not override an unapproved PR's review state")
    }

    @Test("a red check outranks In review and No reviewer, which the reference lets win")
    func redCIOutranksReviewState() throws {
        let cards = try build(fixture: "synthetic")

        // What the reference would have said is pinned in the golden; these are the
        // cards where this app knowingly says something else.
        #expect(cards["i-in-review-red"]?.pill == Pill(label: "CI red", tone: .bad))
        #expect(cards["i-no-reviewer-red"]?.pill == Pill(label: "CI red", tone: .bad))
        #expect(cards["i-in-review-red"]?.whereItsAt
                == "A check is failing — it cannot merge until that is green.")
        #expect(cards["i-no-reviewer-red"]?.whereItsAt
                == "A check is failing — it cannot merge until that is green.")

        // ...and the cards it must leave alone.
        #expect(cards["i-changes-red"]?.pill == Pill(label: "Changes req", tone: .bad),
                "a reviewer's request still outranks a red check")
        #expect(cards["i-draft-red"]?.pill == Pill(label: "Draft", tone: .mute),
                "a draft is still a draft")
        #expect(cards["i-ci-red"]?.pill == Pill(label: "CI red", tone: .bad))
        #expect(cards["i-ci-red"]?.whereItsAt == "Approved. Only the failing check is holding it.",
                "an approved PR keeps the reference's more specific line")
        #expect(cards["i-in-review"]?.pill == Pill(label: "In review", tone: .review),
                "a green PR in review is untouched")
        #expect(cards["i-no-reviewer"]?.pill == Pill(label: "No reviewer", tone: .you))
        #expect(cards["i-blocked"]?.pill == Pill(label: "Blocked", tone: .you),
                "agent state still comes first")
    }

    // MARK: -

    private func build(fixture: String) throws -> [String: Card] {
        let dir = Fixtures.root.appendingPathComponent(fixture)
        let cards = CardBuilder.build(
            items: try Fixtures.boardItems(in: dir),
            pullRequests: try GitHubDecoder.pullRequests(
                fromSignals: try Data(contentsOf: dir.appendingPathComponent("github.json"))),
            agents: try Fixtures.agents(in: dir),
            workspaces: try Fixtures.workspaces(in: dir))
        return Dictionary(cards.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    }

    private func compareWithReference(
        fixture: String, expectedDivergences: Int,
        sourceLocation: SourceLocation = #_sourceLocation
    ) throws -> [Card] {
        let dir = Fixtures.root.appendingPathComponent(fixture)
        let cards = CardBuilder.build(
            items: try Fixtures.boardItems(in: dir),
            pullRequests: try GitHubDecoder.pullRequests(
                fromSignals: try Data(contentsOf: dir.appendingPathComponent("github.json"))),
            agents: try Fixtures.agents(in: dir),
            workspaces: try Fixtures.workspaces(in: dir))

        let golden = try Fixtures.json(at: dir.appendingPathComponent("expected-cards.json"))
        let reference = try #require(golden["cards"] as? [[String: Any]], sourceLocation: sourceLocation)
        let (expected, diverged) = Self.applyDivergence(to: reference)
        let actual = try Fixtures.encodeToJSONObjects(cards)

        #expect(actual.count == expected.count, "card count", sourceLocation: sourceLocation)
        #expect(diverged == expectedDivergences, "cards where the app disagrees with the reference",
                sourceLocation: sourceLocation)

        for (index, pair) in zip(actual, expected).enumerated() {
            let (got, want) = pair
            let id = want["id"] as? String ?? "?"
            #expect(Fixtures.describe(got["id"]) == Fixtures.describe(want["id"]),
                    "card \(index) is out of order", sourceLocation: sourceLocation)
            for key in Set(want.keys).union(got.keys).sorted() {
                #expect(Fixtures.describe(got[key]) == Fixtures.describe(want[key]),
                        "card \(index) [\(id)].\(key)", sourceLocation: sourceLocation)
            }
        }
        return cards
    }

    /// Rewrites the reference's answer wherever the app knowingly disagrees, and
    /// re-sorts, because the rule changes a card's tone and tone is the sort key.
    /// Everything else must then match exactly, so the divergence stays this one
    /// rule and cannot quietly grow.
    /// Wording the app says more briefly. Same branch, same meaning, same tone, so
    /// the card keeps its place in the order — these are reconciled here rather than
    /// counted as divergences, which are for rules that change what the board says
    /// about a PR. Anything not in these tables still has to match the reference word
    /// for word.
    private static let rewordedLines = [
        "Open as a draft — reviewers skip drafts until it is marked ready.": "PR is open as draft",
    ]
    private static let rewordedLabels = [
        "Gone from open": "PR Gone",
    ]

    private static func applyDivergence(
        to reference: [[String: Any]]
    ) -> (cards: [[String: Any]], count: Int) {
        var diverged = 0
        let rewritten = reference.map { card -> [String: Any] in
            var card = card
            // Kept from before the rewording, because a divergence rule is matched on
            // the label the reference chose.
            let referenceLabel = (card["pill"] as? [String: Any])?["label"] as? String ?? ""
            if let line = card["whereItsAt"] as? String, let short = rewordedLines[line] {
                card["whereItsAt"] = short
            }
            if var pill = card["pill"] as? [String: Any], let short = rewordedLabels[referenceLabel] {
                pill["label"] = short
                card["pill"] = pill
            }
            guard let rule = CardBuilder.Divergence.applying(
                ci: card["ci"] as? String ?? "",
                referenceLabel: referenceLabel)
            else { return card }

            diverged += 1
            card["pill"] = ["label": rule.pill.label, "tone": rule.pill.tone.rawValue]
            card["whereItsAt"] = rule.line
            return card
        }
        return (sortLikeReference(rewritten), diverged)
    }

    /// render-board.sh's `sort_by(<tone rank>, 0 - (.num // 0))`, transcribed here
    /// rather than borrowed from CardBuilder so the sort is still checked against an
    /// independent copy. The input is already in reference order, so the enumerated
    /// index supplies jq's stability.
    private static func sortLikeReference(_ cards: [[String: Any]]) -> [[String: Any]] {
        func rank(_ card: [String: Any]) -> Int {
            switch (card["pill"] as? [String: Any])?["tone"] as? String {
            case "you": 0
            case "bad": 1
            case "agent": 2
            case "good": 3
            case "review": 4
            default: 5
            }
        }
        return cards.enumerated()
            .sorted { (rank($0.element), -($0.element["num"] as? Int ?? 0), $0.offset)
                    < (rank($1.element), -($1.element["num"] as? Int ?? 0), $1.offset) }
            .map(\.element)
    }
}
