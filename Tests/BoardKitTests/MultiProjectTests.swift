import Foundation
import Testing
@testable import BoardKit

/// The app used to show one project, chosen by whichever board was written last.
/// A project that polls often always writes last, so a second project could never
/// win — and nothing on screen said a board was missing. These cover the rule that
/// replaced it: show every project, ordered by urgency across all of them.
struct MultiProjectTests {

    private func ref(_ key: String) -> ProjectRef {
        ProjectRef(key: key, root: URL(fileURLWithPath: "/tmp/\(key)"))
    }

    private func snapshot(_ items: [BoardItem]) -> OrchestratorSnapshot {
        OrchestratorSnapshot(items: items, agents: [], workspaces: [],
                             mergedPRNumbers: [], isPresent: true)
    }

    private func item(_ id: String, _ state: String, pr: Int? = nil) -> BoardItem {
        BoardItem(id: id, title: "\(id) title", state: state,
                  pr: pr.map { BoardItem.PRRef(number: $0, url: nil) })
    }

    private let config = BoardConfig(
        repos: ["acme/platform", "acme/desktop"],
        linearWorkspace: "acme",
        shortNames: ["platform": "platform", "desktop": "desktop"])

    @Test("every project contributes cards, not just the newest board")
    func showsEveryProject() {
        let cards = BoardAssembler.cards(
            projects: [
                (ref("platform"), snapshot([item("itm_1", "building")])),
                (ref("desktop"), snapshot([item("itm_9", "building")])),
            ],
            pullRequests: [], config: config)

        #expect(cards.count == 2)
        #expect(Set(cards.map(\.project.key)) == ["platform", "desktop"])
    }

    @Test("an id repeated across projects still gives two distinct rows")
    func idsDoNotCollide() {
        // Two orchestrators number their items independently, so this is not a
        // contrived case. SwiftUI reuses a row for a repeated id, so one card
        // would have been drawn twice and the other never.
        let cards = BoardAssembler.cards(
            projects: [
                (ref("platform"), snapshot([item("itm_4", "building")])),
                (ref("desktop"), snapshot([item("itm_4", "building")])),
            ],
            pullRequests: [], config: config)

        #expect(cards.count == 2)
        #expect(Set(cards.map(\.id)).count == 2)
        #expect(cards.map(\.id).sorted() == ["desktop:itm_4", "platform:itm_4"])
    }

    @Test("urgency wins over project, so a card needing you is never buried")
    func sortsByUrgencyAcrossProjects() {
        // The reason the board is not grouped by project: grouping would put this
        // draft above the blocked card, purely because of its heading.
        let blocked = item("itm_b", "blocked")
        let draft = item("itm_d", "building")

        let cards = BoardAssembler.cards(
            projects: [
                (ref("platform"), snapshot([draft])),
                (ref("desktop"), snapshot([blocked])),
            ],
            pullRequests: [], config: config)

        let ranks = cards.map(\.card.pill.tone.sortRank)
        #expect(ranks == ranks.sorted(), "cards must be ordered by tone across projects")
    }

    @Test("the order does not change between two identical reads")
    func orderIsStable() {
        let projects = [
            (ref("platform"), snapshot([item("itm_1", "building"), item("itm_2", "building")])),
            (ref("desktop"), snapshot([item("itm_3", "building"), item("itm_4", "building")])),
        ]
        let first = BoardAssembler.cards(projects: projects, pullRequests: [], config: config)
        let again = BoardAssembler.cards(projects: projects, pullRequests: [], config: config)
        #expect(first.map(\.id) == again.map(\.id))
    }

    private func pr(_ number: Int, repo: String, title: String) -> PullRequest {
        var request = PullRequest(number: number, title: title, ciState: "", unresolvedThreads: 0)
        request.repo = repo
        return request
    }

    private var twoRepos: BoardConfig {
        var config = self.config
        config.repoNames = ["platform": "acme/platform", "desktop": "acme/desktop"]
        return config
    }

    @Test("a PR one project orchestrates is not invented again by the other")
    func noDuplicateAcrossProjects() {
        // The board showed both: the item's card with its ticket title, and a
        // second card titled from the PR. Every project was handed the whole PR
        // list, and each saw the others' PRs as unclaimed.
        let cards = BoardAssembler.cards(
            projects: [
                (ref("platform"), snapshot([item("itm_663", "pr-open", pr: 538)])),
                (ref("desktop"), snapshot([item("itm_cb1", "pr-open", pr: 1382)])),
            ],
            pullRequests: [
                pr(538, repo: "acme/platform", title: "feat(distributions): build a distribution"),
                pr(1382, repo: "acme/desktop", title: "chore(comfybuilder): merge main"),
            ],
            config: twoRepos)

        #expect(cards.count == 2, "one card for each PR, not one for each project")
        #expect(cards.map(\.card.id).sorted() == ["itm_663", "itm_cb1"])
        #expect(!cards.contains { $0.card.id.hasPrefix("pr:") },
                "no synthesized card: both PRs are claimed by an item")
    }

    @Test("an unorchestrated PR is synthesized once, by the project owning the repo")
    func synthesizesOnceForTheOwningProject() {
        let cards = BoardAssembler.cards(
            projects: [
                (ref("platform"), snapshot([])),
                (ref("desktop"), snapshot([])),
            ],
            pullRequests: [pr(99, repo: "acme/desktop", title: "a PR nobody tracked")],
            config: twoRepos)

        #expect(cards.count == 1)
        #expect(cards.first?.project.key == "desktop", "attributed by repo, not by position")
        #expect(cards.first?.card.id == "pr:acme/desktop#99")
    }

    @Test("a PR whose repo matches no project still gets exactly one card")
    func unownedPRStillAppears() {
        let cards = BoardAssembler.cards(
            projects: [
                (ref("platform"), snapshot([])),
                (ref("desktop"), snapshot([])),
            ],
            pullRequests: [pr(7, repo: "acme/unconfigured", title: "from a repo nobody claims")],
            config: twoRepos)

        #expect(cards.count == 1, "must not vanish, and must not appear on every project")
    }

    @Test("the chip falls back to the key when config does not name the project")
    func chipFallsBackToKey() {
        let bare = BoardConfig(repos: [], linearWorkspace: "acme")
        let cards = BoardAssembler.cards(
            projects: [(ref("unnamed"), snapshot([item("itm_1", "building")]))],
            pullRequests: [], config: bare)

        #expect(cards.first?.shortName == "unnamed")
    }

    @Test("shortName is read from config, and defaults to the repo name")
    func shortNameFromConfig() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("cfg-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        try Data("""
        {"operator": {"linearWorkspace": "acme"},
         "repos": [{"name": "Acme-Org/platform", "key": "acme-org-platform"},
                   {"name": "Acme-Org/Desktop", "key": "acme-org-desktop", "shortName": "desk"}]}
        """.utf8).write(to: dir.appendingPathComponent("config.json"))

        let config = BoardConfig.load(from: dir)
        // No shortName: the part after the slash, not the whole "owner/name".
        #expect(config.shortName(for: "acme-org-platform") == "platform")
        #expect(config.shortName(for: "acme-org-desktop") == "desk")
    }

    @Test("the derivation mirrors setup.sh, and an explicit key still wins")
    func derivedKeyMatchesSetup() throws {
        // setup.sh: tr '[:upper:]' '[:lower:]' | sed 's#[^a-z0-9]\\{1,\\}#-#g'
        #expect(BoardConfig.derivedKey(from: "Acme-Org/platform") == "acme-org-platform")
        #expect(BoardConfig.derivedKey(from: "Acme-Org/Acme-Desktop") == "acme-org-acme-desktop")

        // A real config had `key: acme-org-desktop` against that same repo, which
        // the derivation does not produce. The directory under p/ follows the key,
        // so deriving when a key is written would look in a directory that is not
        // there and show the project as having no work.
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("cfg-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try Data("""
        {"repos": [{"name": "Acme-Org/Acme-Desktop", "key": "acme-org-desktop"}]}
        """.utf8).write(to: dir.appendingPathComponent("config.json"))

        #expect(BoardConfig.load(from: dir).shortName(for: "acme-org-desktop") == "Acme-Desktop")
    }
}
