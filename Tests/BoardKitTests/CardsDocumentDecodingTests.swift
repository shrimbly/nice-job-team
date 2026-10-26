import Foundation
import Testing
@testable import BoardKit

/// The app is a thin client of the CLI now: it reads cards.json and draws it,
/// building no cards of its own. These tests decode a fixture the CLI itself
/// generated, so the contract under test is the producer's actual output, not a
/// hand-written imitation of it.
///
/// To regenerate `Fixtures/cards-v2.json` after a CLI change (from the repo
/// root; `cd cli && npm run build` first if dist/ is stale):
///
///     R=$(mktemp -d)
///     F=Tests/BoardKitTests/Fixtures
///     mkdir -p "$R/p/platform/signals" "$R/p/synth/signals" "$R/workspaces"
///     cp "$F/board.json"                        "$R/p/platform/board.json"
///     cp "$F/github.json"                       "$R/p/platform/signals/github.json"
///     cp "$F/workspaces-signal.json"            "$R/p/platform/signals/workspaces.json"
///     cp "$F/synthetic/board.json"              "$R/p/synth/board.json"
///     cp "$F/synthetic/github.json"             "$R/p/synth/signals/github.json"
///     cp "$F/synthetic/workspaces-signal.json"  "$R/p/synth/signals/workspaces.json"
///     cp "$F"/workspaces/*.json "$F"/synthetic/workspaces/*.json "$R/workspaces/"
///     echo '{"repos":[{"name":"acme/platform","key":"platform","shortName":"platform"},
///           {"name":"o/r","key":"synth","shortName":"synth"}],
///           "operator":{"linearWorkspace":"acme"}}' > "$R/config.json"
///     SUPERSET_ORCH_ROOT="$R" node cli/dist/main.js dump > "$F/cards-v2.json"
struct CardsDocumentDecodingTests {

    private func document() throws -> CardsDocument {
        try JSONDecoder().decode(CardsDocument.self, from: try Fixtures.data("cards-v2.json"))
    }

    @Test("the CLI's own document decodes whole")
    func decodesTheFixture() throws {
        let doc = try document()
        #expect(doc.version == 2)
        #expect(doc.note == nil)
        #expect(doc.projects.map(\.key) == ["platform", "synth"])
        #expect(doc.projects.map(\.shortName) == ["platform", "synth"])
        #expect(doc.projects.allSatisfy { $0.trackerKind == "linear" })
        #expect(doc.generatedAtDate != nil)
    }

    @Test("every card carries the model the panel draws from")
    func cardsSurvive() throws {
        let doc = try document()
        let cards = doc.cards
        let total = doc.projects.map(\.cards.count).reduce(0, +)
        #expect(cards.count == total)
        #expect(cards.count > 20)
        // The fixture reaches every tone, so a tone that stopped decoding would
        // drop cards here rather than pass unnoticed.
        #expect(Set(cards.map(\.card.pill.tone)) == Set(Tone.allCases))
        // Ids are project-qualified, so itm_4 on two boards stays two rows.
        #expect(Set(cards.map(\.id)).count == cards.count)
        #expect(cards.allSatisfy { $0.host == "local" })
    }

    @Test("the flattened board is ordered by urgency across projects")
    func flattenedOrder() throws {
        let cards = try document().cards
        let ranks = cards.map(\.card.pill.tone.sortRank)
        #expect(ranks == ranks.sorted())
        // Within one tone the newest PR leads, exactly the assembler's key.
        for (left, right) in zip(cards, cards.dropFirst())
        where left.card.pill.tone == right.card.pill.tone {
            #expect((left.card.num ?? 0) >= (right.card.num ?? 0))
        }
    }

    @Test("previewPending decodes true, false, and absent as not-set")
    func previewPendingDecodes() throws {
        // A minimal card document, with the key present either way and absent —
        // absent is what a document from a CLI that predates the field reads as.
        func card(_ pending: Bool?) throws -> Card {
            var json: [String: Any] = [
                "id": "c", "num": 1, "title": "t", "branch": "b",
                "boardState": "pr-open", "ci": "green", "threads": 0, "draft": false,
                "needsOperator": false, "whatItIs": "w",
                "pill": ["label": "Working", "tone": "agent"],
            ]
            if let pending { json["previewPending"] = pending }
            return try JSONDecoder().decode(
                Card.self, from: try JSONSerialization.data(withJSONObject: json))
        }
        #expect(try card(nil).previewPending == nil)
        #expect(try card(false).previewPending == false)
        #expect(try card(true).previewPending == true)
    }

    @Test("a null generatedAt-shaped stamp reads as no date, not a crash")
    func badGeneratedAt() throws {
        let doc = CardsDocument(version: 2, generatedAt: "yesterday-ish", note: nil, projects: [])
        #expect(doc.generatedAtDate == nil)
    }

    // MARK: - The reviews lane

    @Test("a document without the reviews key reads as unavailable, not clear")
    func reviewsAbsent() throws {
        // Inline rather than the fixture: the current CLI writes the reviews key
        // on every document, so the absent case is the backward-compat one, and
        // depending on fixture staleness to cover it stops covering it the
        // moment the fixture is regenerated.
        let json = """
        {"version": 2, "generatedAt": "2026-09-03T00:00:00Z", "note": null,
         "projects": [
           {"key": "a", "shortName": "A", "trackerKind": "linear", "cards": []}]}
        """
        let doc = try JSONDecoder().decode(CardsDocument.self, from: Data(json.utf8))
        #expect(!doc.reviewsAvailable)
        #expect(doc.reviews.isEmpty)
        #expect(!doc.reviewsCountAsNeedsYou)
        #expect(doc.projects.allSatisfy { $0.reviews == nil })
    }

    @Test("reviews decode, flatten across projects, and sort newest first")
    func reviewsDecode() throws {
        let json = """
        {"version": 2, "generatedAt": "2026-09-03T00:00:00Z", "note": null,
         "reviewsCountAsNeedsYou": true,
         "projects": [
           {"key": "a", "shortName": "A", "trackerKind": "linear", "cards": [],
            "reviews": [
              {"repo": "o/r", "number": 7, "title": "old", "url": "u7",
               "author": "alice", "isDraft": true,
               "updatedAt": "2026-08-01T00:00:00Z", "previewUrl": null}]},
           {"key": "b", "shortName": "B", "trackerKind": "linear", "cards": [],
            "reviews": [
              {"repo": "o/s", "number": 9, "title": "new", "url": "u9",
               "author": "bob", "isDraft": false,
               "updatedAt": "2026-09-01T00:00:00Z", "previewUrl": "p9"}]}]}
        """
        let doc = try JSONDecoder().decode(CardsDocument.self, from: Data(json.utf8))
        #expect(doc.reviewsAvailable)
        #expect(doc.reviewsCountAsNeedsYou)
        let reviews = doc.reviews
        #expect(reviews.map(\.review.number) == [9, 7])
        #expect(reviews.map(\.shortName) == ["B", "A"])
        #expect(reviews[0].review.ref == "o/s#9")
        #expect(reviews[1].review.isDraft)
        #expect(reviews[1].review.updatedAtDate != nil)
    }

    @Test("a sparse review row decodes with defaults rather than failing")
    func sparseReview() throws {
        let json = """
        {"version": 2, "generatedAt": "x", "note": null, "projects": [
           {"key": "a", "shortName": "A", "trackerKind": "linear", "cards": [],
            "reviews": [{"repo": "o/r", "number": 1}]}]}
        """
        let doc = try JSONDecoder().decode(CardsDocument.self, from: Data(json.utf8))
        let review = try #require(doc.reviews.first?.review)
        #expect(review.title.isEmpty)
        #expect(review.author == "?")
        #expect(!review.isDraft)
        #expect(review.url == nil)
        #expect(review.updatedAtDate == nil)
        // An empty (not absent) queue still reads as available.
        let empty = """
        {"version": 2, "generatedAt": "x", "note": null, "projects": [
           {"key": "a", "shortName": "A", "trackerKind": "linear", "cards": [], "reviews": []}]}
        """
        let clear = try JSONDecoder().decode(CardsDocument.self, from: Data(empty.utf8))
        #expect(clear.reviewsAvailable)
        #expect(clear.reviews.isEmpty)
    }

    // MARK: - Shapes the fixture does not happen to reach

    /// A hand-rolled entry with a stack, a cloud host and a note — the fields the
    /// current fixture data leaves at their defaults.
    private static let stacked = Data("""
        {
          "version": 2,
          "generatedAt": "2026-09-02T01:00:00Z",
          "note": "gh pr list for o/r failed (exit 1)",
          "projects": [{
            "key": "p", "shortName": "P", "trackerKind": "github-issues",
            "cards": [{
              "id": "itm_9", "num": 12, "title": "tip of the stack", "branch": "s/c",
              "workspace": null, "workspaceId": null, "workspaceUrl": null,
              "boardState": "pr-open", "prUrl": "https://gh/12",
              "ticketKey": null, "ticketUrl": null, "previewUrl": null,
              "review": null, "ci": "green", "threads": 0, "draft": false,
              "mergeState": null, "needsOperator": false,
              "agentState": null, "agentPhase": null, "agentSummary": null,
              "liveness": null, "dirty": null, "unpushed": null,
              "whatItIs": "PR open", "pill": {"label": "In review", "tone": "review"},
              "whereItsAt": null,
              "host": "cloud", "prTitle": "the PR's own longer title",
              "stack": [
                {"number": 10, "title": "bottom", "url": "https://gh/10",
                 "previewUrl": "https://p/10", "isDraft": false},
                {"number": 12, "title": "tip", "url": "https://gh/12",
                 "previewUrl": null, "isDraft": true}
              ]
            }]
          }]
        }
        """.utf8)

    @Test("stack rows, host and prTitle ride the entry into the view model")
    func stackedEntry() throws {
        let doc = try JSONDecoder().decode(CardsDocument.self, from: Self.stacked)
        #expect(doc.note == "gh pr list for o/r failed (exit 1)")
        let card = try #require(doc.cards.first)
        #expect(card.id == "p:itm_9")
        #expect(card.isCloud)
        #expect(card.prTitle == "the PR's own longer title")
        #expect(card.trackerKind == "github-issues")
        #expect(card.prCount == 2)
        #expect(card.stack.map(\.number) == [10, 12])
        #expect(card.stack.map(\.isDraft) == [false, true])
        #expect(card.stack.first?.previewUrl == "https://p/10")
        #expect(card.stack.last?.url == "https://gh/12")
    }

    @Test("an entry missing host/prTitle/stack still decodes, with the defaults")
    func entryDefaults() throws {
        // The 27 card keys alone — what a consumer must tolerate even though the
        // CLI always writes all three extras.
        let bare = Data("""
            {"id": "i", "num": null, "title": "t", "branch": "", "workspace": null,
             "workspaceId": null, "workspaceUrl": null, "boardState": "queued",
             "prUrl": null, "ticketKey": null, "ticketUrl": null, "previewUrl": null,
             "review": null, "ci": "none", "threads": 0, "draft": false,
             "mergeState": null, "needsOperator": false, "agentState": null,
             "agentPhase": null, "agentSummary": null, "liveness": null,
             "dirty": null, "unpushed": null, "whatItIs": "w",
             "pill": {"label": "Queued", "tone": "mute"}, "whereItsAt": null}
            """.utf8)
        let entry = try JSONDecoder().decode(CardsDocument.Entry.self, from: bare)
        #expect(entry.host == "local")
        #expect(entry.prTitle == nil)
        #expect(entry.stack.isEmpty)
        #expect(entry.card.num == nil)
        #expect(entry.card.pill.tone == .mute)
    }

    @Test("a project with no cards still appears — empty and absent must differ")
    func emptyProjectSurvives() throws {
        let data = Data("""
            {"version": 2, "generatedAt": "2026-09-02T01:00:00Z", "note": null,
             "projects": [{"key": "idle", "shortName": "idle", "trackerKind": "linear",
                           "cards": []}]}
            """.utf8)
        let doc = try JSONDecoder().decode(CardsDocument.self, from: data)
        #expect(doc.projects.count == 1)
        #expect(doc.cards.isEmpty)
    }
}
