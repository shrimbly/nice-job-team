import Foundation

/// The port of render-board.sh's jq: board items + PR rows + agent status become
/// cards, in the order the operator should read them.
///
/// This is a transcription, not a redesign — the pill chain, the `whereItsAt` chain
/// and the sort are the reference implementation's, branch for branch, including
/// its quirks. Change them there first, not here.
///
/// The deliberate exceptions are enumerated in `Divergence`, and the golden tests
/// apply them to the reference's own output by name — so each one is declared, and a
/// disagreement that is not on the list fails the build.
public enum CardBuilder {
    public static let defaultLinearWorkspace = "acme"

    /// Every place this knowingly disagrees with render-board.sh. Both exceptions
    /// are about the same thing: the reference calls a PR ready when it is not.
    public enum Divergence: String, CaseIterable, Sendable {
        /// The reference only lets a red check reach the pill once a PR is APPROVED,
        /// so a failing PR reads "In review" or "No reviewer" — both of which say it
        /// is fine and waiting on a person, when it cannot merge and the wait is on
        /// nobody.
        ///
        /// Still loses to CHANGES_REQUESTED, which names something a human asked for
        /// and which nothing else on a collapsed row would show, and to every agent
        /// state, which is about who holds the work rather than what the PR needs.
        case redCIOutranksReviewState

        /// The reference calls an approved PR "Mergeable" while its checks are still
        /// running. It is not mergeable yet — the branch protection will refuse it.
        case runningCIIsNotMergeable

        public var pill: Pill {
            switch self {
            case .redCIOutranksReviewState: Pill(label: "CI red", tone: .bad)
            // Waiting on a machine, so it takes the same tone as waiting on a
            // person — and sorts below the PRs that really can be merged now.
            case .runningCIIsNotMergeable: Pill(label: "CI running", tone: .review)
            }
        }

        public var line: String {
            switch self {
            case .redCIOutranksReviewState: "A check is failing — it cannot merge until that is green."
            case .runningCIIsNotMergeable: "Approved. Waiting on the checks to finish."
            }
        }

        /// The reference labels this rule rewrites. Each already implies the rest of
        /// the reference's chain — "Mergeable" means approved, clean and not red;
        /// "In review" means not draft and not changes-requested — so the check
        /// needs nothing but the label and the CI state.
        public var overriddenLabels: Set<String> {
            switch self {
            case .redCIOutranksReviewState: ["In review", "No reviewer"]
            case .runningCIIsNotMergeable: ["Mergeable"]
            }
        }

        var ciState: String {
            switch self {
            case .redCIOutranksReviewState: "red"
            case .runningCIIsNotMergeable: "running"
            }
        }

        /// True when this rule rewrites a card the reference built.
        public func applies(ci: String, referenceLabel: String) -> Bool {
            ci == ciState && overriddenLabels.contains(referenceLabel)
        }

        public static func applying(ci: String, referenceLabel: String) -> Divergence? {
            allCases.first { $0.applies(ci: ci, referenceLabel: referenceLabel) }
        }
    }

    public static func build(
        items: [BoardItem],
        pullRequests: [PullRequest],
        agents: [AgentStatus],
        workspaces: [WorkspaceRef],
        linearWorkspace: String = defaultLinearWorkspace
    ) -> [Card] {
        // Indexed by number across every repo, exactly as the reference does. Two
        // repos sharing a PR number would collide; the orchestrator only ever
        // configures one.
        let prByNumber = Dictionary(pullRequests.map { ($0.number, $0) }, uniquingKeysWith: { first, _ in first })
        let agentByWorkspace = Dictionary(agents.map { ($0.workspaceId, $0) }, uniquingKeysWith: { first, _ in first })
        let nameByWorkspace = Dictionary(
            workspaces.compactMap { ref in ref.name.map { (ref.id, $0) } },
            uniquingKeysWith: { first, _ in first })

        let cards = items.filter(\.isVisible).map { item -> Card in
            let pr = item.pr?.number.flatMap { prByNumber[$0] }
            let agent = item.workspaceId.flatMap { agentByWorkspace[$0] }
            let needsOperator = agent?.needsOperator ?? false

            return Card(
                id: item.id,
                num: item.pr?.number,
                title: item.title,
                branch: item.branch ?? pr?.headRefName ?? "",
                workspace: item.workspaceId.flatMap { nameByWorkspace[$0] },
                workspaceId: item.workspaceId,
                workspaceUrl: item.workspaceId.map { "superset://v2-workspace/" + $0 },
                boardState: item.state,
                prUrl: item.pr?.url ?? pr?.url,
                ticketKey: ticketKey(item),
                ticketUrl: ticketKey(item).map { "https://linear.app/\(linearWorkspace)/issue/\($0)" },
                previewUrl: pr?.previewUrl,
                review: pr?.reviewDecision ?? item.pr?.reviewDecision,
                ci: pr?.ciState ?? item.pr?.ciState ?? "unknown",
                threads: pr?.unresolvedThreads ?? 0,
                // jq's `//` skips `false` as well as null, so a board item that
                // remembers a draft keeps that memory even when GitHub says otherwise.
                draft: firstTrue(pr?.isDraft, item.pr?.isDraft),
                mergeState: pr?.mergeStateStatus ?? item.pr?.mergeStateStatus,
                needsOperator: needsOperator,
                agentState: agent?.state,
                agentPhase: agent?.phase,
                agentSummary: agent?.summary,
                liveness: agent?.sessionLiveness,
                dirty: agent?.dirtyFiles,
                unpushed: agent?.unpushedCommits,
                whatItIs: item.outcome.flatMap { $0.isEmpty ? nil : $0 } ?? item.title,
                pill: pill(item: item, pr: pr, agent: agent, needsOperator: needsOperator),
                whereItsAt: whereItsAt(item: item, pr: pr, agent: agent))
        }

        // jq's sort_by is stable; the index keeps that property here.
        return cards.enumerated()
            .sorted { lhs, rhs in
                let l = (lhs.element.pill.tone.sortRank, -(lhs.element.num ?? 0), lhs.offset)
                let r = (rhs.element.pill.tone.sortRank, -(rhs.element.num ?? 0), rhs.offset)
                return l < r
            }
            .map(\.element)
    }

    // MARK: - The chains

    static func pill(item: BoardItem, pr: PullRequest?, agent: AgentStatus?, needsOperator: Bool) -> Pill {
        if needsOperator, agent?.state == "blocked" { return Pill(label: "Blocked", tone: .you) }
        // Ready outranks everything except a blocked agent: it is the only row where
        // the next move is yours and takes one click.
        if item.state == "ready" { return Pill(label: "★ Ready to merge", tone: .good) }
        if needsOperator { return Pill(label: "Needs you", tone: .you) }
        // The ITEM state, never the agent's status file. sync.sh has already
        // reconciled that file against the live PR — an agent writes "fixing" when it
        // starts and routinely never writes again, so reading the agent here brings
        // back the staleness sync exists to remove: a rebased, green, review-ready PR
        // rendered as "Fixing".
        if item.state == "building" { return Pill(label: "Working", tone: .agent) }
        // Was "Dispatched", which is a different state entirely — a PR in its second
        // round of review read as though it had never been started.
        if item.state == "fixing" { return Pill(label: "Fixing", tone: .agent) }
        if pr?.isDraft == true { return Pill(label: "Draft", tone: .mute) }
        // A reviewer's explicit request outranks a red check: the agent is going to
        // push again anyway, and nothing else on a collapsed row would say a human
        // has asked for something.
        if pr?.reviewDecision == "CHANGES_REQUESTED" { return Pill(label: "Changes req", tone: .bad) }
        // Deliberately ahead of the remaining review states, which render-board.sh
        // lets win — see Divergence.redCIOutranksReviewState.
        if pr?.ciState == "red" { return Divergence.redCIOutranksReviewState.pill }
        if pr?.reviewDecision == "APPROVED", pr?.mergeStateStatus == "DIRTY" { return Pill(label: "Conflicts", tone: .bad) }
        // Conflicts first: a branch that needs a rebase is the more actionable
        // problem, and the checks will run again after it.
        if pr?.reviewDecision == "APPROVED", pr?.ciState == "running" { return Divergence.runningCIIsNotMergeable.pill }
        if pr?.reviewDecision == "APPROVED" { return Pill(label: "Mergeable", tone: .good) }
        if pr?.reviewDecision == "REVIEW_REQUIRED" { return Pill(label: "In review", tone: .review) }
        if pr != nil { return Pill(label: "No reviewer", tone: .you) }
        // No live PR row: either it landed, or there is no PR at all yet.
        if item.state == "merged" { return Pill(label: "Merged — reap", tone: .good) }
        if item.pr?.number != nil { return Pill(label: "PR Gone", tone: .mute) }
        if item.state == "dispatched" { return Pill(label: "Starting", tone: .agent) }
        // Unreachable — the branch above catches every building item. Kept because
        // the reference keeps it, so the two chains stay line-for-line comparable.
        if item.state == "building" { return Pill(label: "Working", tone: .agent) }
        return Pill(label: shortened(item.state), tone: .mute)
    }

    /// The last branch shows the item's own state, for a state this chain does not
    /// name. Those are machine words, and `awaiting-approval` is half again as wide
    /// as any label here — every pill in the column is sized to the widest one, so
    /// one of these on the board indents the chips on all of them.
    ///
    /// The tone is left alone. Reading it as `you` would say more than the reference
    /// does and move the card to the top of the board, which is a change to what the
    /// board claims rather than to how it reads.
    private static func shortened(_ state: String) -> String {
        switch state {
        case "awaiting-approval": "At gate"
        default: state
        }
    }

    /// Note two inherited quirks: CHANGES_REQUESTED has no line of its own and falls
    /// through to the "nobody has been asked to review it" text, and an agent at the
    /// gate with an empty summary yields nothing at all.
    static func whereItsAt(item: BoardItem, pr: PullRequest?, agent: AgentStatus?) -> String? {
        // At the gate the phase ("self-review complete") says nothing useful, so
        // prefer the first line of the summary the agent wrote.
        if agent?.state == "awaiting-approval", let summary = agent?.summary {
            // jq's `"" | split("\n")[0]` is null, not "" — an empty summary at the
            // gate leaves the line blank rather than falling through to the phase.
            guard !summary.isEmpty else { return nil }
            return String(summary.split(separator: "\n", omittingEmptySubsequences: false)[0])
        }
        // When the agent's own state disagrees with the reconciled item state, its
        // phase is describing work that has already finished — "rebasing #477…"
        // beside a green, review-ready PR. Say so rather than let it read as live.
        if let agentState = agent?.state, agentState != item.state, let phase = agent?.phase {
            return "last agent update: \(phase)"
        }
        if let phase = agent?.phase { return phase }
        if let summary = agent?.summary { return summary }
        if pr?.isDraft == true { return "PR is open as draft" }
        if pr?.reviewDecision == "APPROVED", pr?.ciState == "red" { return "Approved. Only the failing check is holding it." }
        // Follows the pill: saying "waiting on a reviewer" beside a CI-red pill, or
        // calling a failing PR "green", would be worse than the quirk it replaces.
        if pr?.ciState == "red", pr?.reviewDecision != "CHANGES_REQUESTED" {
            return Divergence.redCIOutranksReviewState.line
        }
        if pr?.reviewDecision == "APPROVED", pr?.mergeStateStatus == "DIRTY" { return "Approved, but the branch conflicts with main." }
        if pr?.reviewDecision == "APPROVED", pr?.ciState == "running" { return Divergence.runningCIIsNotMergeable.line }
        if pr?.reviewDecision == "APPROVED" { return "Approved and clean — ready for you to merge." }
        if pr?.reviewDecision == "REVIEW_REQUIRED" { return "Waiting on a reviewer." }
        if pr != nil { return "Open, green, and nobody has been asked to review it." }
        return "No PR data in the last poll."
    }

    // MARK: -

    private static func ticketKey(_ item: BoardItem) -> String? {
        item.source?.kind == "linear" ? item.source?.externalId : nil
    }

    private static func firstTrue(_ values: Bool?...) -> Bool {
        values.contains { $0 == true }
    }
}

// MARK: - GitHub-only cards

extension BoardItem {
    /// An open PR the orchestrator does not know about — because it is not running,
    /// or because it has not grouped that PR into an item yet. Built so the pill
    /// chain treats it exactly like a board item whose agent is absent.
    public static func synthesized(from pr: PullRequest) -> BoardItem {
        BoardItem(
            id: "pr:\(pr.repo ?? "?")#\(pr.number)",
            title: pr.title,
            state: "pr-open",
            branch: pr.headRefName,
            source: Source(kind: "github", externalId: "#\(pr.number)"),
            pr: PRRef(number: pr.number, url: pr.url))
    }
}
