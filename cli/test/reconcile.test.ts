// reconcile() is the pure port of sync.sh, and these are its rules pinned one
// by one — including, as named tests, the four regressions docs/lessons.md
// records: the stale status file that moved a finished PR backwards, the guard
// against it that then hid a fresh status, the merged PR with no workspace
// left to reap, and the empty live list that nulled four items at once on
// 2026-08-03. The stdout/stderr strings are asserted verbatim because
// watch.sh seds them into events.log until P3.

import { describe, expect, test } from 'vitest';
import { reconcile } from '../src/reconcile.js';
import type { ReconcileInput, ReconcileResult } from '../src/reconcile.js';
import type { AgentStatus, BoardDoc, BoardItem, PullRequest } from '../src/types.js';

const AT = '2026-09-02T12:00:00Z';

/** tests/run.sh's live item, overridable per case. */
function item(over: Partial<BoardItem>): BoardItem {
  return {
    id: 'itm_1',
    slug: 'live-item',
    title: 'T-1 - Live item',
    state: 'dispatched',
    workspaceId: 'ws-good',
    pr: null,
    history: [{ at: '2026-08-01T00:00:00Z', from: 'proposed', to: 'dispatched' }],
    ...over,
  };
}

function board(...items: BoardItem[]): BoardDoc {
  return { version: 1, updatedAt: '2026-08-01T00:00:00Z', items };
}

/** An open-PR signal row that reads as healthy: no conflict, no asks. */
function healthyPr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 5,
    title: 'PR',
    ciState: 'green',
    unresolvedThreads: 0,
    mergeStateStatus: 'CLEAN',
    ...over,
  };
}

function run(over: Partial<ReconcileInput>): ReconcileResult {
  return reconcile({
    board: board(item({})),
    statuses: [],
    liveWorkspaces: [],
    prs: [],
    mergedNumbers: new Set<number>(),
    primaryWorkspaceIds: [],
    at: AT,
    ...over,
  });
}

function lastEntry(result: ReconcileResult, index = 0) {
  const history = result.board.items[index]!.history!;
  return history[history.length - 1]!;
}

describe('rule 1 — state follows the agent', () => {
  test('a healthy status file moves the item (the run.sh adoption case)', () => {
    // run.sh: superset stubbed to fail, so the live list is empty — the move
    // must not depend on it.
    const out = run({
      statuses: [
        { workspaceId: 'ws-good', state: 'building', updatedAt: '2026-09-02T11:59:00Z' },
      ],
    });
    expect(out.board.items[0]!.state).toBe('building');
    expect(lastEntry(out)).toEqual({
      at: AT,
      from: 'dispatched',
      to: 'building',
      by: 'sync: agent status',
    });
    expect(out.stdout).toEqual(['  live-item: sync: agent status → building']);
    expect(out.stderr).toEqual([]);
    expect(out.prunedStatusFiles).toEqual([]);
  });

  test('a terminal item never moves, whatever the agent says', () => {
    for (const state of ['closed', 'rejected', 'abandoned']) {
      const out = run({
        board: board(item({ state })),
        statuses: [{ workspaceId: 'ws-good', state: 'building' }],
      });
      expect(out.board.items[0]!.state).toBe(state);
      expect(out.board.items[0]!.history).toHaveLength(1);
      expect(out.stdout).toEqual([]);
    }
  });

  test('an agent agreeing with the board appends nothing', () => {
    const out = run({
      statuses: [{ workspaceId: 'ws-good', state: 'dispatched' }],
    });
    expect(out.board.items[0]!.history).toHaveLength(1);
    expect(out.stdout).toEqual([]);
  });

  test('quirk: a non-string agent state reads as absent, not as a move', () => {
    // status_file_valid's `//` masks `state: false` through; the jq would have
    // written the boolean onto the board and board_validate would then refuse
    // the write. The port skips instead — same net board either way.
    const out = run({
      statuses: [{ workspaceId: 'ws-good', state: false } as unknown as AgentStatus],
    });
    expect(out.board.items[0]!.state).toBe('dispatched');
    expect(out.stdout).toEqual([]);
  });

  test('lesson: a stale "fixing" status cannot drag a healthy PR backwards', () => {
    // The agent wrote fixing when a rebase started and never wrote again; the
    // PR is observably fine and newer. sync must not undo the operator's
    // correction each cycle.
    const out = run({
      board: board(item({ state: 'pr-open', pr: { number: 5, url: 'https://gh/5' } })),
      statuses: [
        { workspaceId: 'ws-good', state: 'fixing', updatedAt: '2026-09-01T09:00:00Z' },
      ],
      prs: [healthyPr({ latestActivityAt: '2026-09-01T10:00:00Z' })],
    });
    expect(out.board.items[0]!.state).toBe('pr-open');
    expect(out.board.items[0]!.history).toHaveLength(1);
    expect(out.stdout).toEqual([]);
  });

  test('…and "ready" is shielded the same way', () => {
    const out = run({
      board: board(item({ state: 'ready', pr: { number: 5, url: 'https://gh/5' } })),
      statuses: [
        { workspaceId: 'ws-good', state: 'building', updatedAt: '2026-09-01T09:00:00Z' },
      ],
      prs: [
        healthyPr({
          reviewDecision: 'APPROVED',
          latestActivityAt: '2026-09-01T10:00:00Z',
        }),
      ],
    });
    expect(out.board.items[0]!.state).toBe('ready');
    expect(out.board.items[0]!.history).toHaveLength(1);
  });

  test('an unhealthy PR does not shield: the agent still wins', () => {
    const out = run({
      board: board(item({ state: 'pr-open', pr: { number: 5, url: 'https://gh/5' } })),
      statuses: [
        { workspaceId: 'ws-good', state: 'fixing', updatedAt: '2026-09-01T09:00:00Z' },
      ],
      prs: [healthyPr({ unresolvedThreads: 1, latestActivityAt: '2026-09-01T10:00:00Z' })],
    });
    expect(out.board.items[0]!.state).toBe('fixing');
    expect(out.stdout).toEqual(['  live-item: sync: agent status → fixing (#5)']);
  });

  test('lesson: agentFresh — a status written after the last PR activity wins', () => {
    // The operator gave feedback in the workspace chat; nothing changed on
    // GitHub. The guard against stale files must not read this fresh one as
    // stale, and rule 1b must not bounce the item back each cycle.
    const out = run({
      board: board(item({ state: 'pr-open', pr: { number: 5, url: 'https://gh/5' } })),
      statuses: [
        { workspaceId: 'ws-good', state: 'fixing', updatedAt: '2026-09-01T11:00:00Z' },
      ],
      prs: [healthyPr({ latestActivityAt: '2026-09-01T10:00:00Z' })],
    });
    expect(out.board.items[0]!.state).toBe('fixing');
    expect(out.board.items[0]!.history!.filter((h) => h.at === AT)).toHaveLength(1);
    expect(out.stdout).toEqual(['  live-item: sync: agent status → fixing (#5)']);
  });
});

describe('rule 1b — a healthy PR on a work-in-progress item has landed', () => {
  test('lesson: stale-fixing is overridden by the healthy PR', () => {
    // Both halves of the incident: the status file agrees with the board (so
    // rule 1 is a no-op) but is older than the PR's last activity.
    const out = run({
      board: board(item({ state: 'fixing', pr: { number: 5, url: 'https://gh/5' } })),
      statuses: [
        { workspaceId: 'ws-good', state: 'fixing', updatedAt: '2026-09-01T09:00:00Z' },
      ],
      prs: [healthyPr({ latestActivityAt: '2026-09-01T10:00:00Z' })],
    });
    expect(out.board.items[0]!.state).toBe('pr-open');
    expect(lastEntry(out)).toEqual({
      at: AT,
      from: 'fixing',
      to: 'pr-open',
      by: 'sync: PR healthy, status file stale',
    });
    expect(out.stdout).toEqual([
      '  live-item: sync: PR healthy, status file stale → pr-open (#5)',
    ]);
  });

  test('with no status file at all, building lands the same way', () => {
    const out = run({
      board: board(item({ state: 'building', pr: { number: 5, url: 'https://gh/5' } })),
      prs: [healthyPr()],
    });
    expect(out.board.items[0]!.state).toBe('pr-open');
  });

  test('a conflicting PR is not healthy', () => {
    for (const mergeStateStatus of ['DIRTY', 'CONFLICTING']) {
      const out = run({
        board: board(item({ state: 'fixing', pr: { number: 5, url: 'https://gh/5' } })),
        prs: [healthyPr({ mergeStateStatus })],
      });
      expect(out.board.items[0]!.state).toBe('fixing');
      expect(out.stdout).toEqual([]);
    }
  });
});

describe('rule 1c — a merged PR with no workspace left to reap', () => {
  test('lesson: merged-PR-no-workspace closes the item', () => {
    const out = run({
      board: board(
        item({ state: 'pr-open', workspaceId: null, pr: { number: 41, url: 'https://gh/41' } }),
      ),
      mergedNumbers: new Set([41]),
    });
    expect(out.board.items[0]!.state).toBe('closed');
    expect(lastEntry(out)).toEqual({
      at: AT,
      from: 'pr-open',
      to: 'closed',
      by: 'sync: PR merged, no workspace to reap',
    });
    expect(out.stdout).toEqual([
      '  live-item: sync: PR merged, no workspace to reap → closed (#41)',
    ]);
  });

  test('an item that still holds a workspace is left for reap.sh', () => {
    const out = run({
      board: board(item({ state: 'pr-open', pr: { number: 41, url: 'https://gh/41' } })),
      mergedNumbers: new Set([41]),
    });
    expect(out.board.items[0]!.state).toBe('pr-open');
    expect(out.stdout).toEqual([]);
  });

  test('workspace-gone and the close take two cycles, in the ported rule order', () => {
    // Rule 3 nulls the workspaceId AFTER rule 1c already ran, so the close
    // waits for the next reconcile — exactly the bash sequencing.
    const input = {
      mergedNumbers: new Set([88]),
      liveWorkspaces: [{ id: 'ws-other', branch: 'other' }],
    };
    const first = run({
      ...input,
      board: board(
        item({ state: 'pr-open', workspaceId: 'ws-dead', branch: 'feat-z', pr: { number: 88 } }),
      ),
    });
    expect(first.board.items[0]!.workspaceId).toBeNull();
    expect(first.board.items[0]!.state).toBe('pr-open');
    expect(first.stdout).toEqual(['  live-item: sync: workspace gone → pr-open (#88)']);

    const second = run({ ...input, board: first.board });
    expect(second.board.items[0]!.state).toBe('closed');
    expect(second.stdout).toEqual([
      '  live-item: sync: PR merged, no workspace to reap → closed (#88)',
    ]);
  });
});

describe('rule 1d — ready, and back out of it', () => {
  test('approved, green, mergeable promotes to ready', () => {
    for (const mergeStateStatus of ['CLEAN', 'HAS_HOOKS']) {
      const out = run({
        board: board(item({ state: 'pr-open', pr: { number: 5, url: 'https://gh/5' } })),
        prs: [healthyPr({ reviewDecision: 'APPROVED', mergeStateStatus })],
      });
      expect(out.board.items[0]!.state).toBe('ready');
      expect(lastEntry(out)).toEqual({
        at: AT,
        from: 'pr-open',
        to: 'ready',
        by: 'sync: approved, green, mergeable',
      });
      expect(out.stdout).toEqual([
        '  live-item: sync: approved, green, mergeable → ready (#5)',
      ]);
    }
  });

  test('anything short of the full gate stays pr-open', () => {
    const blockers: Partial<PullRequest>[] = [
      { reviewDecision: 'APPROVED', isDraft: true },
      { reviewDecision: 'APPROVED', mergeStateStatus: undefined }, // `// ""` — not CLEAN
      { reviewDecision: 'APPROVED', ciState: 'running' },
      { reviewDecision: '' }, // "" survives jq's `//` but is not APPROVED
      { reviewDecision: 'APPROVED', unresolvedThreads: 2 },
    ];
    for (const blocker of blockers) {
      const out = run({
        board: board(item({ state: 'pr-open', pr: { number: 5, url: 'https://gh/5' } })),
        prs: [healthyPr(blocker)],
      });
      expect(out.board.items[0]!.state).toBe('pr-open');
    }
  });

  test('a stale fixing item can cross 1b and 1d in one pass, printed once as final', () => {
    const out = run({
      board: board(item({ state: 'fixing', pr: { number: 5, url: 'https://gh/5' } })),
      prs: [healthyPr({ reviewDecision: 'APPROVED' })],
    });
    const stamped = out.board.items[0]!.history!.filter((h) => h.at === AT);
    expect(stamped.map((h) => h.by)).toEqual([
      'sync: PR healthy, status file stale',
      'sync: approved, green, mergeable',
    ]);
    expect(out.stdout).toEqual(['  live-item: sync: approved, green, mergeable → ready (#5)']);
  });

  test('ready demotes when the gate stops holding', () => {
    const out = run({
      board: board(item({ state: 'ready', pr: { number: 5, url: 'https://gh/5' } })),
      prs: [healthyPr({ reviewDecision: 'CHANGES_REQUESTED' })],
    });
    expect(out.board.items[0]!.state).toBe('pr-open');
    expect(lastEntry(out)).toEqual({
      at: AT,
      from: 'ready',
      to: 'pr-open',
      by: 'sync: no longer ready',
    });
    expect(out.stdout).toEqual(['  live-item: sync: no longer ready → pr-open (#5)']);
  });

  test('ready with no live PR row stays ready — absence is not demotion', () => {
    const out = run({
      board: board(item({ state: 'ready', pr: { number: 5, url: 'https://gh/5' } })),
    });
    expect(out.board.items[0]!.state).toBe('ready');
    expect(out.stdout).toEqual([]);
  });
});

describe('rule 2 — a PR only the agent knows', () => {
  test('lands on the item as {number, url}, silently', () => {
    const out = run({
      statuses: [
        {
          workspaceId: 'ws-good',
          state: 'dispatched', // agrees with the board, so rule 1 stays out
          pr: { number: 7, url: 'https://gh/7' },
        },
      ],
    });
    expect(out.board.items[0]!.pr).toEqual({ number: 7, url: 'https://gh/7' });
    expect(out.board.items[0]!.history).toHaveLength(1);
    expect(out.stdout).toEqual([]);
  });

  test('the board keeps its own PR number', () => {
    const out = run({
      board: board(item({ pr: { number: 9, url: 'https://gh/9' } })),
      statuses: [
        { workspaceId: 'ws-good', state: 'dispatched', pr: { number: 7, url: 'https://gh/7' } },
      ],
    });
    expect(out.board.items[0]!.pr).toEqual({ number: 9, url: 'https://gh/9' });
  });

  test('adoption merges into an existing pr object rather than replacing it', () => {
    const out = run({
      board: board(item({ pr: { url: 'https://old' } as BoardItem['pr'] })),
      statuses: [
        { workspaceId: 'ws-good', state: 'dispatched', pr: { number: 7, url: 'https://gh/7' } },
      ],
    });
    expect(out.board.items[0]!.pr).toEqual({ number: 7, url: 'https://gh/7' });
  });

  test('quirk: pr false in a status file adopts nothing (the jq crashed here)', () => {
    // status_file_valid's `//` masks pr:false through as valid; the jq then
    // died indexing the boolean and the whole sync ran dry.
    const out = run({
      statuses: [
        { workspaceId: 'ws-good', state: 'dispatched', pr: false } as unknown as AgentStatus,
      ],
    });
    expect(out.board.items[0]!.pr).toBeNull();
  });
});

describe('rule 3a — re-link a workspace by branch', () => {
  test('the first live workspace on the branch is adopted, and drift is stamped clear', () => {
    const out = run({
      board: board(item({ state: 'pr-open', workspaceId: null, branch: 'feat-x' })),
      liveWorkspaces: [
        { id: 'ws-aaaaaaaaaaaa', branch: 'feat-y' },
        { id: 'ws-bbbbbbbbbbbb', branch: 'feat-x' },
        { id: 'ws-cccccccccccc', branch: 'feat-x' },
      ],
    });
    expect(out.board.items[0]!.workspaceId).toBe('ws-bbbbbbbbbbbb');
    expect(lastEntry(out)).toEqual({
      at: AT,
      from: 'pr-open',
      to: 'pr-open',
      by: 'sync: re-linked workspace by branch',
    });
    // Rule 3 then sees the adopted workspace live on the right branch.
    expect(out.board.items[0]!.workspaceDrift).toBeNull();
    expect(out.stdout).toEqual(['  live-item: sync: re-linked workspace by branch → pr-open']);
  });

  test('never for a cloud item — no workspace is its normal state', () => {
    const out = run({
      board: board(
        item({ state: 'pr-open', workspaceId: null, branch: 'feat-x', host: 'cloud' }),
      ),
      liveWorkspaces: [{ id: 'ws-bbbbbbbbbbbb', branch: 'feat-x' }],
    });
    expect(out.board.items[0]!.workspaceId).toBeNull();
    expect(out.board.items[0]!.history).toHaveLength(1);
    expect(out.stdout).toEqual([]);
  });
});

describe('rule 3 — workspace gone, or on the wrong branch', () => {
  test('lesson: an empty live list nulls nothing', () => {
    // 2026-08-03: one bad reading nulled every workspaceId, and rule 1c then
    // closed each item whose PR had merged, orphaning live worktrees.
    const out = run({
      board: board(
        item({ id: 'itm_1', slug: 'a', state: 'pr-open', workspaceId: 'ws-1', pr: { number: 11 } }),
        item({ id: 'itm_2', slug: 'b', state: 'building', workspaceId: 'ws-2' }),
      ),
      statuses: [{ workspaceId: 'ws-1', state: 'pr-open' }],
      mergedNumbers: new Set([11]),
      liveWorkspaces: [],
    });
    expect(out.board.items[0]!.workspaceId).toBe('ws-1');
    expect(out.board.items[0]!.state).toBe('pr-open'); // 1c did not cascade
    expect(out.board.items[1]!.workspaceId).toBe('ws-2');
    expect(out.board.items[0]!).not.toHaveProperty('workspaceDrift');
    expect(out.prunedStatusFiles).toEqual([]);
    expect(out.stdout).toEqual([]);
    expect(out.stderr).toEqual([]);
  });

  test('a drifted workspace is recorded and warned about, state untouched', () => {
    const out = run({
      board: board(item({ state: 'building', branch: 'feat-a' })),
      liveWorkspaces: [{ id: 'ws-good', branch: 'feat-b' }],
    });
    expect(out.board.items[0]!.workspaceDrift).toBe('feat-b');
    expect(out.board.items[0]!.state).toBe('building');
    expect(out.stdout).toEqual([]);
    expect(out.stderr).toEqual([
      '  drift: live-item expects feat-a but its workspace is on feat-b',
    ]);
  });

  test('drift clears — explicitly to null — once the branches agree again', () => {
    const out = run({
      board: board(item({ state: 'building', branch: 'feat-a', workspaceDrift: 'feat-b' })),
      liveWorkspaces: [{ id: 'ws-good', branch: 'feat-a' }],
    });
    expect(out.board.items[0]!.workspaceDrift).toBeNull();
    expect(out.stderr).toEqual([]);
  });
});

describe('the prune decision', () => {
  test('a status file claimed by this board whose workspace died is condemned, and stops voting', () => {
    const dead: AgentStatus = { workspaceId: 'ws-dead', state: 'building' }; // ours, workspace gone
    const foreign: AgentStatus = { workspaceId: 'ws-foreign', state: 'building' }; // another project's agent
    const alive: AgentStatus = { workspaceId: 'ws-live', state: 'building' }; // ours, alive
    const out = run({
      board: board(
        item({ id: 'itm_1', slug: 'dead', state: 'dispatched', workspaceId: 'ws-dead' }),
        item({ id: 'itm_2', slug: 'alive', state: 'dispatched', workspaceId: 'ws-live' }),
      ),
      statuses: [dead, foreign, alive],
      inbox: [
        { id: 'ws-dead', status: dead },
        { id: 'ws-foreign', status: foreign },
        { id: 'ws-live', status: alive },
      ],
      liveWorkspaces: [{ id: 'ws-live', branch: 'x' }],
    });
    // Only the claimed-and-dead file; the foreign one belongs to somebody else.
    expect(out.prunedStatusFiles).toEqual(['ws-dead']);
    // The pruned file's vote is gone this very cycle: itm_1 keeps its state
    // and rule 3 detaches the dead workspace instead.
    expect(out.board.items[0]!.state).toBe('dispatched');
    expect(out.board.items[0]!.workspaceId).toBeNull();
    expect(out.board.items[1]!.state).toBe('building');
    expect(out.stdout).toEqual([
      '  dead: sync: workspace gone → dispatched',
      '  alive: sync: agent status → building',
    ]);
  });

  test('an empty live list condemns nothing — a transient auth failure must not', () => {
    const status: AgentStatus = { workspaceId: 'ws-dead', state: 'dispatched' };
    const out = run({
      board: board(item({ workspaceId: 'ws-dead' })),
      statuses: [status],
      inbox: [{ id: 'ws-dead', status }],
      liveWorkspaces: [],
    });
    expect(out.prunedStatusFiles).toEqual([]);
  });

  test('a MALFORMED file is pruned by its filename — sync.sh judged the glob, not the votes', () => {
    // The file cast no vote (collect_status skipped it), but its name matches
    // a claimed workspace that left a non-empty live list: bash rm -f'd it on
    // the first cycle, ending the every-cycle malformed warning. An inbox
    // entry with no status is exactly that file.
    const out = run({
      board: board(item({ id: 'itm_1', slug: 'dead', state: 'dispatched', workspaceId: 'ws-dead' })),
      statuses: [],
      inbox: [{ id: 'ws-dead' }],
      liveWorkspaces: [{ id: 'ws-live', branch: 'x' }],
    });
    expect(out.prunedStatusFiles).toEqual(['ws-dead']);
  });

  test('filename and content disagree: judged, deleted, and silenced by the FILENAME', () => {
    // ws-dead.json claims workspaceId ws-other inside. sync.sh deleted
    // ws-dead.json (the basename) and its re-collect dropped the vote that
    // file cast — whatever identity the content voted under.
    const mismatch: AgentStatus = { workspaceId: 'ws-other', state: 'building' };
    const out = run({
      board: board(
        item({ id: 'itm_1', slug: 'dead', state: 'dispatched', workspaceId: 'ws-dead' }),
        item({ id: 'itm_2', slug: 'other', state: 'dispatched', workspaceId: 'ws-other' }),
      ),
      statuses: [mismatch],
      inbox: [{ id: 'ws-dead', status: mismatch }],
      liveWorkspaces: [{ id: 'ws-other', branch: 'x' }],
    });
    expect(out.prunedStatusFiles).toEqual(['ws-dead']);
    // The dead file's vote is gone, so itm_2 (whose workspace IS alive) does
    // not move on the pruned file's say-so.
    expect(out.board.items[1]!.state).toBe('dispatched');
  });

  test('no inbox listing, no pruning — the decision needs the directory, not the votes', () => {
    const status: AgentStatus = { workspaceId: 'ws-dead', state: 'building' };
    const out = run({
      board: board(item({ workspaceId: 'ws-dead' })),
      statuses: [status],
      liveWorkspaces: [{ id: 'ws-live', branch: 'x' }],
    });
    expect(out.prunedStatusFiles).toEqual([]);
  });
});

describe('the stray-workspace nag', () => {
  test('a terminal item holding a live workspace is said out loud, 8-char id and all', () => {
    const out = run({
      board: board(
        item({ id: 'itm_2', slug: 'old-closed', state: 'closed', workspaceId: 'ws-0123456789abc' }),
      ),
      liveWorkspaces: [{ id: 'ws-0123456789abc', branch: 'x' }],
    });
    expect(out.stderr).toEqual([
      '  stray: old-closed is closed but workspace ws-01234 is still alive — board reap --item itm_2, or --abandon if it was cancelled',
    ]);
    expect(out.stdout).toEqual([]);
  });

  test('the primary checkout is never nagged about — reap.sh refuses it by design', () => {
    const out = run({
      board: board(
        item({ id: 'itm_3', slug: 'primary-work', state: 'closed', workspaceId: 'ws-primary' }),
      ),
      liveWorkspaces: [{ id: 'ws-primary', branch: 'main' }],
      primaryWorkspaceIds: ['ws-primary'],
    });
    expect(out.stderr).toEqual([]);
  });
});

describe('plumbing', () => {
  test('updatedAt is stamped even when nothing moved, and extra keys survive', () => {
    const doc = {
      version: 1,
      updatedAt: '2026-08-01T00:00:00Z',
      items: [{ ...item({}), reviewNotes: ['keep me'] } as BoardItem],
      note: 'kept',
    } as BoardDoc & { note: string };
    const out = run({ board: doc });
    expect(out.board.updatedAt).toBe(AT);
    expect(out.board.version).toBe(1);
    expect((out.board as unknown as { note: string }).note).toBe('kept');
    expect((out.board.items[0] as unknown as { reviewNotes: string[] }).reviewNotes).toEqual([
      'keep me',
    ]);
    expect(out.stdout).toEqual([]);
  });

  test('reconcile is pure: the input board is untouched', () => {
    const doc = board(item({ state: 'pr-open', pr: { number: 5, url: 'https://gh/5' } }));
    const snapshot = structuredClone(doc);
    run({
      board: doc,
      statuses: [{ workspaceId: 'ws-good', state: 'fixing', updatedAt: '2026-09-02T11:00:00Z' }],
      prs: [healthyPr()],
      liveWorkspaces: [{ id: 'ws-good', branch: 'feat-a' }],
    });
    expect(doc).toEqual(snapshot);
  });

  test('the change line falls back to the id when there is no slug', () => {
    const out = run({
      board: board(item({ slug: null })),
      statuses: [{ workspaceId: 'ws-good', state: 'building' }],
    });
    expect(out.stdout).toEqual(['  itm_1: sync: agent status → building']);
  });
});

// ── the armed agentFresh compare, end to end (P3) ─────────────────────────────
//
// sync.sh's open-row projection dropped latestActivityAt, so the lessons.md
// timestamp rule never ran in bash — and until P3 collectPrSignals ported that
// hole verbatim. These run reconcileVerb over a real temp layout to prove the
// field now survives the signals read: the compare above only fires when the
// PIPELINE hands it a $pat.

describe('agentFresh runs live through signals/github.json (P3 arming)', () => {
  const ORCH_ENV = ['SUPERSET_ORCH_ROOT', 'SUPERSET_ORCH_DIR', 'SUPERSET_ORCH_PROJECT'] as const;

  async function runVerb(statusUpdatedAt: string): Promise<BoardDoc> {
    const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { reconcileVerb } = await import('../src/ops/reconcile.js');

    const root = mkdtempSync(join(tmpdir(), 'board-agentfresh-'));
    const boardDir = join(root, 'p', 'proj');
    mkdirSync(join(boardDir, 'signals'), { recursive: true });
    mkdirSync(join(root, 'workspaces'), { recursive: true });
    writeFileSync(
      join(boardDir, 'board.json'),
      JSON.stringify(
        board(item({ state: 'fixing', workspaceId: 'ws-fresh', pr: { number: 5 } })),
      ),
    );
    // PR activity at 10:00; healthy and quiet — exactly the shape rule 1b eats.
    writeFileSync(
      join(boardDir, 'signals', 'github.json'),
      JSON.stringify({
        repos: [
          {
            repo: 'o/r',
            open: [
              {
                number: 5,
                mergeStateStatus: 'CLEAN',
                unresolvedThreads: 0,
                reviewDecision: null,
                ciState: 'green',
                isDraft: false,
                latestActivityAt: '2026-09-01T10:00:00Z',
              },
            ],
            merged: [],
          },
        ],
      }),
    );
    writeFileSync(
      join(root, 'workspaces', 'ws-fresh.json'),
      JSON.stringify({ workspaceId: 'ws-fresh', state: 'fixing', updatedAt: statusUpdatedAt }),
    );

    const saved = ORCH_ENV.map((k) => [k, process.env[k]] as const);
    process.env['SUPERSET_ORCH_ROOT'] = root;
    process.env['SUPERSET_ORCH_PROJECT'] = 'proj';
    delete process.env['SUPERSET_ORCH_DIR'];
    try {
      // Every subprocess fails: authed() reads false, so the live list is
      // empty and the prune and rule 3 stay disarmed — the compare is alone.
      await reconcileVerb({
        exec: () => ({ status: 1, stdout: '', stderr: 'stubbed: no live CLI in tests' }),
        now: () => AT,
        nowMs: () => Date.parse(AT),
        homeDir: () => root,
        env: {},
        warn: () => {},
      });
      return JSON.parse(readFileSync(join(boardDir, 'board.json'), 'utf8')) as BoardDoc;
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }

  test('lesson: a status file NEWER than the PR activity survives rules 1/1b', async () => {
    const after = await runVerb('2026-09-01T11:00:00Z');
    // agentFresh: the agent spoke after GitHub last did, so its "fixing" holds
    // even against a healthy PR — before P3 armed the field this moved.
    expect(after.items[0]!.state).toBe('fixing');
  });

  test('a status file OLDER than the PR activity still yields to the healthy PR', async () => {
    const after = await runVerb('2026-09-01T09:00:00Z');
    // The contrapositive is the proof the field flows: with latestActivityAt
    // projected away (the pre-P3 hole), $pat was null, agentFresh was true for
    // ANY dated status file, and this stayed at fixing.
    expect(after.items[0]!.state).toBe('pr-open');
    const history = after.items[0]!.history!;
    expect(history[history.length - 1]!.by).toBe('sync: PR healthy, status file stale');
  });
});

// ── rule 1b reads the observation (P5) ────────────────────────────────────────
//
// The plugin's Stop hook writes observedAt and a git block into the status
// file after the model last spoke. Rule 1b's agentFresh shield exists because
// a file newer than PR activity might carry news GitHub cannot see — but an
// observation newer than the STATUS WRITE proving the worktree clean and
// pushed removes exactly that possibility: whatever the agent last claimed,
// nothing is left uncommitted or unpushed, so alongside a healthy PR the work
// is done. The override fires only on all four conditions at once; each one
// individually absent must leave the old behaviour byte-exact.

describe('rule 1b — a clean, pushed observation overrides even a fresh file', () => {
  /** A fresh "fixing" status (newer than the PR) carrying a full observation. */
  function observedStatus(over: Partial<AgentStatus> = {}): AgentStatus {
    return {
      workspaceId: 'ws-good',
      state: 'fixing',
      updatedAt: '2026-09-01T11:00:00Z', // newer than the PR: agentFresh
      observedAt: '2026-09-01T11:30:00Z', // newer still than the write
      git: {
        branch: 'feat-x',
        dirty: 0,
        ahead: 0,
        head: 'abc1234',
        headCommittedAt: '2026-09-01T10:45:00Z',
      },
      ...over,
    };
  }

  /** The board and PR of the agentFresh lesson: fixing item, healthy PR at 10:00. */
  function observedRun(status: AgentStatus): ReconcileResult {
    return run({
      board: board(
        item({ state: 'fixing', branch: 'feat-x', pr: { number: 5, url: 'https://gh/5' } }),
      ),
      statuses: [status],
      prs: [healthyPr({ latestActivityAt: '2026-09-01T10:00:00Z' })],
    });
  }

  test('all four conditions met: the override fires under its own by string', () => {
    const out = observedRun(observedStatus());
    expect(out.board.items[0]!.state).toBe('pr-open');
    expect(lastEntry(out)).toEqual({
      at: AT,
      from: 'fixing',
      to: 'pr-open',
      by: 'sync: PR healthy, observed clean',
    });
    expect(out.stdout).toEqual([
      '  live-item: sync: PR healthy, observed clean → pr-open (#5)',
    ]);
  });

  test('no observedAt: a pre-hook file behaves exactly as before', () => {
    for (const observedAt of [undefined, null] as const) {
      const out = observedRun(observedStatus({ observedAt }));
      expect(out.board.items[0]!.state).toBe('fixing');
      expect(out.board.items[0]!.history).toHaveLength(1);
      expect(out.stdout).toEqual([]);
    }
  });

  test('an observation at or before the status write proves nothing', () => {
    // The agent wrote AFTER the hook looked: the claim post-dates the
    // evidence, so the fresh file keeps its shield. Strictly newer only.
    for (const observedAt of ['2026-09-01T11:00:00Z', '2026-09-01T10:30:00Z']) {
      const out = observedRun(observedStatus({ observedAt }));
      expect(out.board.items[0]!.state).toBe('fixing');
      expect(out.board.items[0]!.history).toHaveLength(1);
    }
  });

  test('no git block: observedAt alone changes nothing', () => {
    for (const git of [undefined, null] as const) {
      const out = observedRun(observedStatus({ git }));
      expect(out.board.items[0]!.state).toBe('fixing');
      expect(out.board.items[0]!.history).toHaveLength(1);
    }
  });

  test('dirty or unpushed: the observation supports the claim, not the override', () => {
    const blocks = [
      { dirty: 2, ahead: 0 },
      { dirty: 0, ahead: 1 },
      { dirty: 1, ahead: 3 },
    ];
    for (const git of blocks) {
      const out = observedRun(observedStatus({ git }));
      expect(out.board.items[0]!.state).toBe('fixing');
      expect(out.board.items[0]!.history).toHaveLength(1);
    }
  });

  test('guard: counts must be the NUMBER 0 — strings and absences never fire', () => {
    const blocks = [
      { dirty: '0', ahead: '0' }, // poll.sh writes its counts as strings; a hook that did too proves nothing
      { dirty: 0 }, // ahead unknown is not ahead-zero
      { ahead: 0 }, // dirty unknown is not clean
      { dirty: null, ahead: 0 },
      {},
    ];
    for (const git of blocks) {
      const out = observedRun(observedStatus({ git: git as AgentStatus['git'] }));
      expect(out.board.items[0]!.state).toBe('fixing');
      expect(out.board.items[0]!.history).toHaveLength(1);
    }
  });

  test('an unhealthy PR is never overridden toward, observation or no', () => {
    for (const bad of [
      { unresolvedThreads: 1 },
      { mergeStateStatus: 'DIRTY' },
      { mergeStateStatus: 'CONFLICTING' },
    ] as Partial<PullRequest>[]) {
      const out = run({
        board: board(item({ state: 'fixing', pr: { number: 5, url: 'https://gh/5' } })),
        statuses: [observedStatus()],
        prs: [healthyPr({ latestActivityAt: '2026-09-01T10:00:00Z', ...bad })],
      });
      expect(out.board.items[0]!.state).toBe('fixing');
      expect(out.board.items[0]!.history).toHaveLength(1);
    }
  });

  test('a STALE file still lands under the old by string — the observation arm is for fresh files', () => {
    // updatedAt older than the PR: !agentFresh, so the original override fires
    // first and the observation is never consulted — even a dirty one.
    const out = observedRun(
      observedStatus({
        updatedAt: '2026-09-01T09:00:00Z',
        observedAt: '2026-09-01T09:30:00Z',
        git: { dirty: 5, ahead: 2 },
      }),
    );
    expect(out.board.items[0]!.state).toBe('pr-open');
    expect(lastEntry(out).by).toBe('sync: PR healthy, status file stale');
  });

  test('a wrong-branch observation proves nothing — the fresh claim holds', () => {
    // The agent checked out main to bisect and the turn ended: the hook
    // recorded main, clean and pushed. Clean by coincidence is not done —
    // observedClean must never fire off another branch's facts.
    for (const branch of ['main', null, undefined] as const) {
      const out = observedRun(
        observedStatus({
          git: { branch, dirty: 0, ahead: 0, head: 'abc1234', headCommittedAt: null },
        }),
      );
      expect(out.board.items[0]!.state).toBe('fixing');
      expect(out.board.items[0]!.history).toHaveLength(1);
    }
  });

  test('a "building" claim is never overridden by the observation — clean is its construction', () => {
    // A just-dispatched workspace is clean-and-pushed BY CONSTRUCTION: init
    // writes "building" before any work exists. The observation arm covers
    // only a claimed-then-abandoned "fixing".
    const out = run({
      board: board(
        item({ state: 'building', branch: 'feat-x', pr: { number: 5, url: 'https://gh/5' } }),
      ),
      statuses: [observedStatus({ state: 'building' })],
      prs: [healthyPr({ latestActivityAt: '2026-09-01T10:00:00Z' })],
    });
    expect(out.board.items[0]!.state).toBe('building');
    expect(out.board.items[0]!.history).toHaveLength(1);
    expect(out.stdout).toEqual([]);
  });

  test('rule 1 shields pr-open against an observed-clean fresh claim — quiet cycles stay quiet', () => {
    // The steady state after the override has fired once: board pr-open,
    // status file still fresh-claiming fixing, observation still clean. Rule
    // 1 must hold the claim off entirely — landing it and letting 1b bounce
    // it back would append two history entries and print a change line EVERY
    // cycle, forever.
    const out = run({
      board: board(
        item({ state: 'pr-open', branch: 'feat-x', pr: { number: 5, url: 'https://gh/5' } }),
      ),
      statuses: [observedStatus()],
      prs: [healthyPr({ latestActivityAt: '2026-09-01T10:00:00Z' })],
    });
    expect(out.board.items[0]!.state).toBe('pr-open');
    expect(out.board.items[0]!.history).toHaveLength(1);
    expect(out.stdout).toEqual([]);
  });

  test('reconcile of its own output is a no-op: the override fires exactly once', () => {
    // Cycle 1 flips fixing → pr-open under the observation; cycle 2 runs over
    // the board cycle 1 wrote, with the SAME statuses and PRs, and must not
    // move a byte — no history, no stdout, no flap.
    const first = observedRun(observedStatus());
    expect(first.board.items[0]!.state).toBe('pr-open');
    const second = run({
      board: first.board,
      statuses: [observedStatus()],
      prs: [healthyPr({ latestActivityAt: '2026-09-01T10:00:00Z' })],
      at: '2026-09-02T12:05:00Z', // the next cycle's clock, not a re-run of the same instant
    });
    expect(second.board.items[0]!.state).toBe('pr-open');
    expect(second.board.items[0]!.history).toEqual(first.board.items[0]!.history);
    expect(second.stdout).toEqual([]);
  });

  test('the observation feeds no other rule: prune, drift and ready ignore it', () => {
    // A dirty observation rides a status whose workspace is dead (prune), one
    // whose workspace drifted branches (rule 3), and one at the ready gate
    // (1d): every outcome matches the observation-free equivalents above.
    const dirtyGit = { dirty: 9, ahead: 9 };
    const dead: AgentStatus = {
      workspaceId: 'ws-dead',
      state: 'building',
      observedAt: AT,
      git: dirtyGit,
    };
    const out = run({
      board: board(
        item({ id: 'itm_1', slug: 'dead', state: 'dispatched', workspaceId: 'ws-dead' }),
        item({
          id: 'itm_2',
          slug: 'gate',
          state: 'pr-open',
          workspaceId: 'ws-live',
          branch: 'feat-a',
          pr: { number: 5, url: 'https://gh/5' },
        }),
      ),
      statuses: [
        dead,
        { workspaceId: 'ws-live', state: 'pr-open', observedAt: AT, git: dirtyGit },
      ],
      inbox: [{ id: 'ws-dead', status: dead }],
      liveWorkspaces: [{ id: 'ws-live', branch: 'feat-b' }],
      prs: [healthyPr({ reviewDecision: 'APPROVED' })],
    });
    expect(out.prunedStatusFiles).toEqual(['ws-dead']); // prune unchanged
    expect(out.board.items[1]!.state).toBe('ready'); // 1d unchanged
    expect(out.board.items[1]!.workspaceDrift).toBe('feat-b'); // rule 3 unchanged
    expect(out.stderr).toEqual([
      '  drift: gate expects feat-a but its workspace is on feat-b',
    ]);
  });
});

// ── the P4 fixtures, byte for byte ────────────────────────────────────────────
//
// Every status file frozen in Tests/BoardKitTests/Fixtures predates the Stop
// hook: no observedAt, no git. Reconcile over them must not move by one byte —
// the golden below (stdout, stderr and prune verbatim; the board as the
// SHA-256 of its serialization) was captured from the pre-observation
// reconcile at this same `at`, so any influence the absent fields exert shows
// up here as a diff. If a DELIBERATE rule change moves these bytes, recapture
// the golden and say so in the commit.

describe('P4 fixtures — a board without observations reconciles byte-identically', () => {
  const golden = {
    live: {
      path: '.',
      stdout: [
        '  item-brisk-exports: sync: agent status → building (#444)',
        '  item-north-members: sync: workspace gone → fixing (#442)',
        '  item-brisk-members: sync: agent status → awaiting-approval (#438)',
        '  item-swift-audit: sync: agent status → building'
      ],
      stderr: [
        '  drift: item-calm-settings expects dev/eng-595-quiet-settings but its workspace is on dev/eng-584-tidy-audit'
      ],
      pruned: [
        '13078e34-7a18-4710-88a8-0a4d0461d694'
      ],
      boardBytes: 8933,
      boardSha256: '3269a196008ba9b8e89ad5731829f6e83e846c7b2a62bef9364d24112fbd8944',
    },
    synthetic: {
      path: 'synthetic',
      stdout: [
        '  i-blocked: sync: agent status → blocked (#901)',
        '  i-needs: sync: workspace gone → pr-open (#902)',
        '  i-building: sync: PR healthy, status file stale → pr-open (#903)',
        '  i-fixing-agent: sync: workspace gone → pr-open (#904)',
        '  i-fixing-item: sync: PR healthy, status file stale → pr-open (#905)',
        '  i-mergeable: sync: approved, green, mergeable → ready (#909)',
        '  i-links: sync: approved, green, mergeable → ready (#919)',
        '  i-summary-only: sync: workspace gone → pr-open (#920)',
        '  i-gate-nosummary: sync: workspace gone → pr-open (#921)'
      ],
      stderr: [],
      pruned: [
        'ws-fixing',
        'ws-gate-nosum',
        'ws-needs',
        'ws-sum'
      ],
      boardBytes: 7055,
      boardSha256: '1faaba0fc7b5a244386366419e20b8ce59391e755169271b4f940994c47a2f34',
    },
  } as const;

  for (const [name, expected] of Object.entries(golden)) {
    test(`${name} fixture reconciles to the pre-observation bytes`, async () => {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const { createHash } = await import('node:crypto');
      const { readAgentInbox, readGithubSignals, readWorkspacesSignal } = await import(
        '../src/read.js'
      );

      const dir = fileURLToPath(
        new URL(`../../Tests/BoardKitTests/Fixtures/${expected.path}/`, import.meta.url),
      );
      // The inputs are assembled the way reconcileVerb assembles them: the raw
      // parsed board (writeBoard hands reconcile the undecoded document), the
      // inbox with its workspaceId-null filter, and the signal files.
      const boardDoc = JSON.parse(readFileSync(join(dir, 'board.json'), 'utf8')) as BoardDoc;
      const inbox = readAgentInbox(join(dir, 'workspaces')).value;
      const statuses = inbox
        .map((f) => f.status)
        .filter((s): s is AgentStatus => s !== undefined)
        .filter((s) => s.workspaceId !== null && s.workspaceId !== undefined);
      const signals = readGithubSignals(join(dir, 'github.json')).value;
      const live = readWorkspacesSignal(join(dir, 'workspaces-signal.json')).value.workspaces;

      // The premise of the pin: these files really do predate the hook.
      expect(statuses.every((s) => !('observedAt' in s) && !('git' in s))).toBe(true);

      const result = reconcile({
        board: boardDoc,
        statuses,
        inbox,
        liveWorkspaces: live,
        prs: signals.prs,
        mergedNumbers: signals.mergedNumbers,
        primaryWorkspaceIds: [],
        at: AT,
      });

      expect(result.stdout).toEqual(expected.stdout);
      expect(result.stderr).toEqual(expected.stderr);
      expect(result.prunedStatusFiles).toEqual(expected.pruned);
      const serialized = JSON.stringify(result.board);
      expect(serialized.length).toBe(expected.boardBytes);
      expect(createHash('sha256').update(serialized).digest('hex')).toBe(expected.boardSha256);
    });
  }
});
