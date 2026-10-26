// The pure heart of sync.sh: fold what the agents and GitHub know back into
// board.json. Three things drift constantly — item.state (agents move on and
// the board does not hear about it), item.pr (an agent opens a PR and records
// it only in its own status file), and item.workspaceId (a workspace deleted,
// or its branch switched) — and every rule here exists because reconciling one
// of them by hand went wrong once. docs/lessons.md names the incident behind
// each guard; read it before loosening any of them.
//
// Pure by contract: no IO, no subprocess, no clock. The caller does every read
// (statuses arrive pre-filtered the way collect_status filters), takes the
// board lock, deletes the inbox files named in prunedStatusFiles — printing
// bash's "  pruned orphan status file <8-char>" line as it does — writes the
// board, and emits stdout/stderr verbatim. The line shapes are a contract:
// until P3, watch.sh seds "  <slug>: <by> → <state>", "  stray:" and
// "  drift:" lines into events.log, so a changed byte breaks the event feed.
//
// Rule order is also a contract, ported as-is: adoption of an agent's PR
// (rule 2) runs AFTER the merged-PR close (rule 1c), and the workspace-gone
// null (rule 3) runs after both — so some corrections take two cycles, exactly
// as they did in bash. Each rule reads the values the jq read: $it (the item
// as the pipeline found it) for the agent/PR lookups and rule 1, the current
// item for everything downstream.
//
// Rule 3b is the one addition beyond the bash port: a card whose worktree the
// operator deleted, and which has no PR to stand on, is retired to `abandoned`
// so it leaves the board instead of ghosting forever. It keys on $it's
// workspace (null coming IN), so like the rest it lands one cycle after the
// disappearance — never on the cycle rule 3 first nulls the link.

import { TERMINAL } from './statemachine.js';
import type {
  AgentInboxFile,
  AgentStatus,
  BoardDoc,
  BoardItem,
  GitObservation,
  HistoryEntry,
  PRRef,
  PullRequest,
  WorkspaceRef,
} from './types.js';

/** Everything sync.sh gathered before its one big jq; the caller does the IO. */
export interface ReconcileInput {
  board: BoardDoc;
  /**
   * The agent-status inbox, already filtered the way collect_status filters:
   * malformed files skipped (the caller warns by name, as sync.sh did) and
   * entries whose workspaceId is null dropped.
   */
  statuses: AgentStatus[];
  /**
   * Every `*.json` in the shared inbox by FILENAME, malformed files included —
   * sync.sh's prune walked the directory glob and judged `basename "$f" .json`
   * with no validity filter, so a corrupt status file for a claimed, dead
   * workspace gets pruned (ending its every-cycle warning) instead of living
   * forever. Entries whose `status` object also appears in `statuses` tie the
   * file to its vote; absent (older callers, most tests), nothing is pruned.
   */
  inbox?: readonly AgentInboxFile[];
  /**
   * Live Superset workspaces, already scoped to this board's projects — the
   * same filter poll.sh uses. MUST be [] on an auth or CLI failure: the empty
   * list is the signal that disarms both the prune and rule 3, and a caller
   * that fabricates entries on failure re-creates the 2026-08-03 incident.
   */
  liveWorkspaces: WorkspaceRef[];
  /** Open-PR rows from signals/github.json — live facts a stale file cannot outvote. */
  prs: PullRequest[];
  /** PR numbers poll.sh recorded as merged. */
  mergedNumbers: ReadonlySet<number>;
  /**
   * Workspace ids whose worktree is the primary checkout (git-dir equals
   * git-common-dir). reap.sh refuses those by design, so a stray warning about
   * one is advice that cannot be followed, every single cycle.
   */
  primaryWorkspaceIds: readonly string[];
  /** lib.sh's now(): ISO-8601 UTC seconds. Stamped on the board and history. */
  at: string;
}

export interface ReconcileResult {
  board: BoardDoc;
  /** The per-item change lines, byte-for-byte as sync.sh printed them. */
  stdout: string[];
  /** The stray-workspace warnings, then the drift lines — sync.sh's stderr. */
  stderr: string[];
  /**
   * Inbox FILE ids (basenames sans .json) whose file should be deleted: named
   * by an item of THIS board and absent from a NON-EMPTY live list. Returned,
   * never deleted here — the caller owns the filesystem, and must unlink by
   * this same basename. The inbox is shared by every project on this host, so
   * "not in MY live list" alone is somebody else's running agent, not garbage.
   */
  prunedStatusFiles: string[];
}

/**
 * The states rule 3b retires from when the workspace is gone and no PR carries
 * the item: the WORK states, where an agent was building something in a
 * workspace and nothing durable outlived it. Deliberately not "everything but
 * proposed/dispatched" — pr-open/ready/merged are PR-anchored (a missing PR
 * there is a human's data problem, not a deleted worktree), and an unknown
 * state is never assumed to have held a workspace.
 */
const RETIRABLE_WHEN_WORKSPACELESS: ReadonlySet<string> = new Set([
  'building',
  'awaiting-approval',
  'fixing',
  'blocked',
  'orphaned',
]);

/**
 * jq's `//`: null and false fall through to the alternative, "" and 0 are
 * values and stay. Undefined joins null because jq has no undefined — a
 * missing key indexes to null.
 */
function orNull<T>(value: T | null | undefined): NonNullable<T> | null {
  if (value === null || value === undefined) return null;
  if ((value as unknown) === false) return null;
  return value as NonNullable<T>;
}

/** jq string interpolation: `\(null)` prints "null". */
function jqText(value: string | null | undefined): string {
  return value === null || value === undefined ? 'null' : value;
}

/**
 * jq's `>` for the agentFresh compare. Both sides are ISO-8601 UTC strings in
 * practice, where lexicographic IS chronological; anything else falls back to
 * jq's type order (null < false < true < number < string) so a malformed
 * timestamp sorts the way the jq sorted it instead of NaN-coercing.
 */
function jqGreater(a: unknown, b: unknown): boolean {
  const rank = (v: unknown): number => {
    if (v === null || v === undefined) return 0;
    if (v === false) return 1;
    if (v === true) return 2;
    if (typeof v === 'number') return 3;
    return 4;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra > rb;
  if (typeof a === 'number' && typeof b === 'number') return a > b;
  if (typeof a === 'string' && typeof b === 'string') return a > b;
  return false;
}

function isPrObject(value: unknown): value is PRRef {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `.pr.number // null`, over the shapes a board can actually hold. A bare
 * number where the object belongs made the jq DIE ("Cannot index number") —
 * the malformed shape from 1 Sep, which board_validate now refuses to write.
 * Reading it as the number here matches read.ts's decodePRRef, so the two
 * sides agree instead of one crashing; a recorded divergence, not a quirk.
 */
function prNumberOf(pr: unknown): number | null {
  if (typeof pr === 'number') return pr;
  if (isPrObject(pr)) {
    const n = pr.number;
    return typeof n === 'number' ? n : null;
  }
  return null;
}

/** `($livepr.unresolvedThreads // 0)` — null and false read as no threads. */
function threadsOf(pr: PullRequest): number {
  return orNull(pr.unresolvedThreads) ?? 0;
}

/** `(.history // []) + [entry]`, always a fresh array so aliasing never leaks. */
function appended(item: BoardItem, entry: HistoryEntry): HistoryEntry[] {
  const base = Array.isArray(item.history) ? item.history : [];
  return [...base, entry];
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const { board, liveWorkspaces, prs, mergedNumbers, at } = input;

  const liveById = new Map<string, WorkspaceRef>();
  for (const ws of liveWorkspaces) liveById.set(ws.id, ws);

  // ── The prune decision ─────────────────────────────────────────────────────
  // Status files are read every cycle and keep voting on state long after the
  // agent that wrote them is gone. Guarded on a non-empty live list — a
  // transient auth failure must not condemn all of them — and on the board
  // CLAIMING the workspace, because the shared inbox also holds every other
  // project's running agents. `ours` is read from the board BEFORE any rule
  // runs, exactly where sync.sh computed it.
  //
  // Keyed on the FILENAME, as sync.sh's `basename "$f" .json` was, over every
  // *.json in the inbox — validity never entered it. That is the documented
  // mechanism for getting rid of a malformed status file ("until the file is
  // fixed or pruned"): a corrupt file for a claimed, dead workspace is
  // condemned here even though it cast no vote, and a valid file whose content
  // claims a different workspaceId is judged (and deleted) by its name, never
  // by what it says.
  const claimed = new Set<string>();
  for (const item of board.items) {
    if (typeof item.workspaceId === 'string') claimed.add(item.workspaceId);
  }
  const prunedStatusFiles: string[] = [];
  const prunedFiles = new Set<string>();
  if (liveWorkspaces.length > 0) {
    for (const file of input.inbox ?? []) {
      if (prunedFiles.has(file.id)) continue;
      if (claimed.has(file.id) && !liveById.has(file.id)) {
        prunedFiles.add(file.id);
        prunedStatusFiles.push(file.id);
      }
    }
  }
  // sync.sh re-collects the inbox after the rm: a status read from a pruned
  // FILE stops voting in the very cycle that condemns it — matched by which
  // file it came from, not by the workspaceId its content claims.
  const deadVotes = new Set<AgentStatus>();
  for (const file of input.inbox ?? []) {
    if (file.status !== undefined && prunedFiles.has(file.id)) deadVotes.add(file.status);
  }
  const statuses = input.statuses.filter((s) => !deadVotes.has(s));

  // INDEX() semantics: keys by tostring, last entry wins on a duplicate.
  const agentByWorkspace = new Map<string, AgentStatus>();
  for (const s of statuses) {
    if (typeof s.workspaceId === 'string') agentByWorkspace.set(s.workspaceId, s);
  }
  const prByNumber = new Map<string, PullRequest>();
  for (const pr of prs) prByNumber.set(String(pr.number), pr);

  const items = board.items.map((it) => {
    // $a and $livepr bind from $it — the item as the pipeline found it — so a
    // workspace adopted in 3a or a PR adopted in rule 2 feeds nothing until
    // the next cycle. Ported, not fixed.
    const agent = agentByWorkspace.get(it.workspaceId ?? '') ?? null;
    const livepr = prByNumber.get(String(prNumberOf(it.pr) ?? -1)) ?? null;

    // An agent writes its status when work STARTS and often never again, so
    // "fixing" outlives the fix. If the PR is open, not conflicting, and
    // nobody is waiting on us, the work is done whatever the file says.
    const prHealthy =
      livepr !== null &&
      livepr.mergeStateStatus !== 'DIRTY' &&
      livepr.mergeStateStatus !== 'CONFLICTING' &&
      threadsOf(livepr) === 0;

    // …but that reasoning only holds while the status file is the OLDER fact.
    // An agent that wrote after the last PR activity is telling us something
    // GitHub cannot see (feedback given in the workspace chat, say). Both
    // timestamps are ISO-8601 UTC, so a string compare is a time compare.
    const aat = orNull(agent?.updatedAt);
    const pat = livepr === null ? null : orNull(livepr.latestActivityAt);
    const agentFresh = aat !== null && (pat === null || jqGreater(aat, pat));

    // …unless the file's own OBSERVATION outdates its claim. The Stop hook
    // stamps observedAt and the worktree's git facts after the model last
    // spoke; an observation newer than the status write, proving nothing
    // uncommitted and nothing unpushed, means the "fixing" claim is stale even
    // though the file is newer than PR activity — clean+pushed git alongside a
    // healthy PR strengthens the work-is-done inference. Every field is
    // guarded hard: a pre-hook file (no observedAt, no git), a null, a count
    // that is not the NUMBER 0, or an observation taken on a DIFFERENT branch
    // than the item's (an agent mid-bisect on main is clean by coincidence,
    // not done) leaves this false and the behaviour exactly as it was. Read
    // for rule 1's shield and rule 1b ONLY — the observation feeds no other
    // rule.
    const rawGit: unknown = agent?.git;
    const git: GitObservation | null =
      typeof rawGit === 'object' && rawGit !== null && !Array.isArray(rawGit)
        ? (rawGit as GitObservation)
        : null;
    const observedClean =
      agentFresh &&
      typeof agent?.observedAt === 'string' &&
      jqGreater(agent.observedAt, aat) &&
      git !== null &&
      git.dirty === 0 &&
      git.ahead === 0 &&
      typeof git.branch === 'string' &&
      git.branch === (it.branch ?? null);

    let cur: BoardItem = it;

    // 1. State follows the agent, except for terminal board states and except
    //    when it would drag a healthy PR backwards into work-in-progress.
    //    A non-string agent state reads as absent: status_file_valid's `//`
    //    masks `state: false` through, and the jq would have written the
    //    boolean onto the board (board_validate then refuses the write) —
    //    skipping is the one behaviour both sides can share.
    const aState = typeof agent?.state === 'string' ? agent.state : null;
    if (
      agent !== null &&
      aState !== null &&
      aState !== it.state &&
      !TERMINAL.has(it.state) &&
      //  The shield holds against a STALE claim (!agentFresh), and equally
      //  against a fresh claim the file's own observation proves stale
      //  (observedClean) — without the second arm, an observed-clean "fixing"
      //  would land here and rule 1b would bounce it straight back, two
      //  history entries and a change line EVERY quiet cycle, forever.
      !(
        (it.state === 'pr-open' || it.state === 'ready') &&
        (aState === 'fixing' || aState === 'building') &&
        prHealthy &&
        (!agentFresh || observedClean)
      )
    ) {
      cur = {
        ...cur,
        state: aState,
        history: appended(cur, { at, from: it.state, to: aState, by: 'sync: agent status' }),
      };
    }

    // 1b. The same rule forwards: a healthy PR on an item the board still
    //     thinks is being worked on has landed, whatever the status file says.
    //     A fresh file (agentFresh) normally holds the override off — unless
    //     its own observation proves the claim stale (observedClean above), in
    //     which case the override fires under its own history string.
    //     observedClean requires agentFresh, so the two arms never race — and
    //     because rule 1's shield also honours observedClean, this arm fires
    //     only when the BOARD genuinely sat at fixing, exactly once. The
    //     observation arm covers "fixing" alone: a just-dispatched workspace
    //     is clean-and-pushed BY CONSTRUCTION (init writes "building" before
    //     any work exists), so clean+pushed proves nothing about a "building"
    //     claim — only a claimed-then-abandoned fix is overridden.
    if ((cur.state === 'fixing' || cur.state === 'building') && prHealthy && !agentFresh) {
      cur = {
        ...cur,
        state: 'pr-open',
        history: appended(cur, {
          at,
          from: cur.state,
          to: 'pr-open',
          by: 'sync: PR healthy, status file stale',
        }),
      };
    } else if (cur.state === 'fixing' && prHealthy && observedClean) {
      cur = {
        ...cur,
        state: 'pr-open',
        history: appended(cur, {
          at,
          from: cur.state,
          to: 'pr-open',
          by: 'sync: PR healthy, observed clean',
        }),
      };
    }

    // 1c. A merged PR with no workspace left to reap. autoreap.sh only walks
    //     items that still have a workspace, so an item whose workspace was
    //     removed by hand sits at pr-open forever — poll only fetches OPEN
    //     PRs, so it renders as "gone from open".
    const prnum = prNumberOf(cur.pr);
    if (
      !TERMINAL.has(cur.state) &&
      prnum !== null &&
      mergedNumbers.has(prnum) &&
      (cur.workspaceId ?? null) === null
    ) {
      cur = {
        ...cur,
        state: 'closed',
        history: appended(cur, {
          at,
          from: cur.state,
          to: 'closed',
          by: 'sync: PR merged, no workspace to reap',
        }),
      };
    }

    // 1d. Approved, green, no conflicts, nothing unresolved: the only thing
    //     left is a human pressing merge, and that is worth its own state.
    if (
      (cur.state === 'pr-open' || cur.state === 'fixing') &&
      livepr !== null &&
      livepr.reviewDecision === 'APPROVED' &&
      livepr.ciState === 'green' &&
      ['CLEAN', 'HAS_HOOKS'].includes(orNull(livepr.mergeStateStatus) ?? '') &&
      threadsOf(livepr) === 0 &&
      orNull(livepr.isDraft) === null
    ) {
      cur = {
        ...cur,
        state: 'ready',
        history: appended(cur, {
          at,
          from: cur.state,
          to: 'ready',
          by: 'sync: approved, green, mergeable',
        }),
      };
    }

    // …and back out again if it stops being true (a new push, a fresh
    // conflict). Ported condition exactly: mergeStateStatus and isDraft are
    // NOT re-checked on the way down, only review, CI and threads.
    if (
      cur.state === 'ready' &&
      livepr !== null &&
      (livepr.reviewDecision !== 'APPROVED' ||
        livepr.ciState !== 'green' ||
        threadsOf(livepr) > 0)
    ) {
      cur = {
        ...cur,
        state: 'pr-open',
        history: appended(cur, { at, from: 'ready', to: 'pr-open', by: 'sync: no longer ready' }),
      };
    }

    // 2. A PR the agent opened, which the board has never seen. No history
    //    entry and no printed line — the jq only stamped state moves.
    //    status_file_valid lets `pr: false` through (its `//` masks false);
    //    the jq then died indexing the boolean, which is exactly the class of
    //    crash this port exists to remove — a non-object pr adopts nothing.
    const agentPr = agent !== null && isPrObject(agent.pr) ? agent.pr : null;
    const agentPrNumber = agentPr === null ? null : orNull(agentPr.number);
    if (agent !== null && agentPrNumber !== null && prNumberOf(cur.pr) === null) {
      const base = isPrObject(cur.pr) ? cur.pr : {};
      cur = { ...cur, pr: { ...base, number: agentPrNumber, url: agentPr?.url ?? null } };
    }

    // 3a. An open item with no workspace, but a live workspace on its branch:
    //     adopt it. One workspace is one branch, so the branch is a reliable
    //     key, and a bad reading that nulled workspaceId heals on the next
    //     good cycle. NOT for a cloud item — its workspaceId is null
    //     permanently and by design, and without the exclusion it adopts
    //     whatever local workspace shares the branch and the board shows one
    //     job being done twice.
    if (
      (cur.workspaceId ?? null) === null &&
      (orNull(cur.host) ?? 'local') !== 'cloud' &&
      !TERMINAL.has(cur.state) &&
      cur.branch !== null &&
      cur.branch !== undefined
    ) {
      const branch = cur.branch;
      const found = liveWorkspaces.find((ws) => (ws.branch ?? null) === branch);
      if (found !== undefined) {
        cur = {
          ...cur,
          workspaceId: found.id,
          history: appended(cur, {
            at,
            from: cur.state,
            to: cur.state,
            by: 'sync: re-linked workspace by branch',
          }),
        };
      }
    }

    // 3. A workspace that has gone, or moved to a different branch. Guarded on
    //    a non-empty live list, exactly as the prune is: an empty list means
    //    the CLI failed or the filter matched nothing, NOT that every
    //    workspace was deleted. Without the guard one bad reading nulls
    //    workspaceId on every item at once, and rule 1c then closes each one
    //    whose PR has merged — precisely what happened to four items on
    //    2026-08-03.
    if (
      (cur.workspaceId ?? null) !== null &&
      !TERMINAL.has(cur.state) &&
      liveWorkspaces.length > 0
    ) {
      const live = liveById.get(cur.workspaceId as string);
      if (live === undefined) {
        cur = {
          ...cur,
          workspaceId: null,
          history: appended(cur, {
            at,
            from: cur.state,
            to: cur.state,
            by: 'sync: workspace gone',
          }),
        };
      } else if (
        cur.branch !== null &&
        cur.branch !== undefined &&
        (live.branch ?? null) !== cur.branch
      ) {
        // The drift value is the live branch verbatim — which the jq could
        // set to null when the workspace reported none, indistinguishable
        // from "no drift". Ported as-is.
        cur = { ...cur, workspaceDrift: live.branch ?? null };
      } else {
        // The key is written explicitly, so a drift recorded last cycle is
        // cleared rather than left to lie.
        cur = { ...cur, workspaceDrift: null };
      }
    }

    // 3b. A card the operator threw away by deleting its worktree. Deleting a
    //     workspace by hand is how you abandon work, and rule 3 above already
    //     nulls the link when the workspace is gone — but the item then sits on
    //     the board in a live state forever, a ghost with nothing behind it. So
    //     once an item has no workspace and nothing else to stand on, retire it
    //     to a terminal state, which takes it off the board (the app renders no
    //     terminal card) and hands it to archive.
    //
    //     Every clause is a guard earned by a way this could go wrong:
    //      - it.workspaceId null: it came INTO this pass workspaceless, so a
    //        workspace nulled THIS cycle (rule 3) gets a full cycle of grace —
    //        a transient poll blip that nulls-then-reappears is re-linked by
    //        rule 3a next time, before this ever fires. Retiring is always one
    //        cycle behind the disappearance, matching this file's other
    //        two-cycle corrections.
    //      - cur.workspaceId still null: rule 3a did not re-link it to a live
    //        workspace on its branch, so the work really is gone.
    //      - a workspace-bearing WORK state, whitelisted rather than "anything
    //        but proposed/dispatched": these are the states an item reaches by
    //        an agent working a workspace, with no durable artifact yet — so
    //        losing the workspace loses everything. proposed/dispatched predate
    //        the workspace (a candidate never had one; a just-dispatched local
    //        item's may not have surfaced in this poll yet); pr-open/ready/
    //        merged are anchored to a PR, and a missing PR there is a data
    //        anomaly for a human, not a deleted worktree; and an UNKNOWN state
    //        (a typo, an extension) is never assumed to have held a workspace.
    //      - not cloud: a cloud item's workspaceId is null for its whole life
    //        by design; it is tracked by its status file and PR, never a local
    //        workspace, and must never be retired for lacking one.
    //      - no PR: a PR is the durable record the worktree was only scaffolding
    //        for. Keep the card while a PR carries it — rule 1c closes it once
    //        the PR merges, and an open PR still needs a human.
    //      - liveWorkspaces non-empty: the empty list is an offline poll, not an
    //        empty fleet — the same guard rule 3 and the prune stand on, so a
    //        transient failure never condemns the board.
    if (
      (it.workspaceId ?? null) === null &&
      (cur.workspaceId ?? null) === null &&
      RETIRABLE_WHEN_WORKSPACELESS.has(cur.state) &&
      (orNull(cur.host) ?? 'local') !== 'cloud' &&
      prNumberOf(cur.pr) === null &&
      liveWorkspaces.length > 0
    ) {
      cur = {
        ...cur,
        state: 'abandoned',
        history: appended(cur, {
          at,
          from: cur.state,
          to: 'abandoned',
          by: 'sync: workspace deleted',
        }),
      };
    }

    return cur;
  });

  // Top-level spread keeps whatever extra keys the document carries, the way
  // atomic_json's in-place filter did.
  const nextBoard: BoardDoc = { ...board, updatedAt: at, items };

  // ── Say only what changed, so this is quiet in a loop ──────────────────────
  // One line per item with a history entry stamped this run, naming the LAST
  // entry's by — an item that moved twice in one pass prints once, as final.
  const stdout: string[] = [];
  for (const item of items) {
    const history = Array.isArray(item.history) ? item.history : [];
    const stamped = history.filter((h) => typeof h === 'object' && h !== null && h.at === at);
    if (stamped.length === 0) continue;
    const by = orNull(stamped[stamped.length - 1]!.by) ?? 'changed';
    const label = orNull(item.slug) ?? item.id;
    const num = prNumberOf(item.pr);
    // jq truthiness gates the suffix: null and false drop it, 0 keeps it.
    stdout.push(`  ${label}: ${by} → ${item.state}${num !== null ? ` (#${num})` : ''}`);
  }

  // ── The stray-workspace nag ────────────────────────────────────────────────
  // A closed item that still holds a live workspace is invisible to every
  // automation — autoreap.sh only walks open items — and some of these hold
  // unpushed work, so it is said out loud instead of reaped. Never about the
  // primary checkout: reap.sh refuses that by design.
  const stderr: string[] = [];
  const primary = new Set(input.primaryWorkspaceIds);
  for (const item of items) {
    if (!TERMINAL.has(item.state)) continue;
    const wsid = item.workspaceId ?? null;
    if (wsid === null || !liveById.has(wsid)) continue;
    if (primary.has(wsid)) continue;
    const label = orNull(item.slug) ?? item.id;
    stderr.push(
      `  stray: ${label} is ${item.state} but workspace ${wsid.slice(0, 8)} is still alive — board reap --item ${item.id}, or --abandon if it was cancelled`,
    );
  }

  for (const item of items) {
    if ((item.workspaceDrift ?? null) === null) continue;
    const label = orNull(item.slug) ?? item.id;
    stderr.push(
      `  drift: ${label} expects ${jqText(item.branch)} but its workspace is on ${jqText(item.workspaceDrift)}`,
    );
  }

  return { board: nextBoard, stdout, stderr, prunedStatusFiles };
}
