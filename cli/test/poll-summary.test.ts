// runPoll end to end over a temp orchestrator layout, with every external
// command stubbed. The assertions pin the summary's exact section headers and
// line shapes: watch.sh seds this text into events.log until P3, so a changed
// byte here is a broken heartbeat, not a cosmetic diff.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { runPoll } from '../src/ops/poll.js';
import type { BoardConfigFile, ExecResult, OrchRoot, PollIo } from '../src/types.js';

// ── The headers watch.sh anchors on, verbatim from poll.sh ────────────────────

const HEADER_PRS =
  '── PRs ──────────────────────────────────────────────────────────────';
const HEADER_AGENTS =
  '── Agents ───────────────────────────────────────────────────────────';
const HEADER_NO_STATUS =
  '── Workspaces without a status file ─────────────────────────────────';
const HEADER_BACKLOG =
  '── Backlog (markdown tracker, not yet on the board) ─────────────────';
const HEADER_DELTAS =
  '── Deltas since last poll ───────────────────────────────────────────';

// ── Layout + io stubs ─────────────────────────────────────────────────────────

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-poll-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function layout(): { root: OrchRoot; projectDir: string; home: string } {
  const base = tempDir();
  const root: OrchRoot = {
    root: base,
    configPath: join(base, 'config.json'),
    workspacesDir: join(base, 'workspaces'),
  };
  mkdirSync(root.workspacesDir, { recursive: true });
  const projectDir = join(base, 'p', 'proj');
  mkdirSync(projectDir, { recursive: true });
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  return { root, projectDir, home };
}

function ok(stdout: string): ExecResult {
  return { status: 0, stdout, stderr: '' };
}
const FAIL: ExecResult = { status: 1, stdout: '', stderr: 'stubbed failure' };

interface GhWorld {
  open?: unknown[];
  review?: unknown[];
  merged?: unknown[];
  closed?: unknown[];
  graphql?: unknown;
  /** PR number (as string) → comments payload for `gh pr view`. */
  comments?: Record<string, unknown[]>;
  workspaces?: unknown[];
  authed?: boolean;
}

function makeIo(world: GhWorld, home: string, env: NodeJS.ProcessEnv = {}) {
  const calls: { cmd: string; args: string[] }[] = [];
  const warnings: string[] = [];
  const io: PollIo = {
    exec(cmd, args) {
      calls.push({ cmd, args });
      if (cmd === '/stub/gh') {
        if (args[0] === 'pr' && args[1] === 'list') {
          if (args.includes('--search')) return ok(JSON.stringify(world.review ?? []));
          if (args.includes('open')) return ok(JSON.stringify(world.open ?? []));
          if (args.includes('merged')) return ok(JSON.stringify(world.merged ?? []));
          if (args.includes('closed')) return ok(JSON.stringify(world.closed ?? []));
        }
        if (args[0] === 'api' && args[1] === 'graphql') {
          const query = args.find((a) => a.startsWith('query=')) ?? '';
          // The reviews lane is now ONE cross-repo GraphQL search; the details
          // query is the aliased r<i>/p<n> one. Tell them apart by the search's
          // distinctive qualifier and serve world.review as search nodes.
          if (query.includes('review-requested:')) {
            const nodes = (world.review ?? []).map((r) => {
              const o = r as Record<string, unknown>;
              return { ...o, repository: { nameWithOwner: (o['repo'] as string) ?? 'o/r' } };
            });
            return ok(JSON.stringify({ data: { search: { nodes } } }));
          }
          return world.graphql === undefined ? FAIL : ok(JSON.stringify(world.graphql));
        }
        if (args[0] === 'pr' && args[1] === 'view') {
          return ok(JSON.stringify({ comments: world.comments?.[args[2]!] ?? [] }));
        }
        return FAIL;
      }
      if (cmd === 'superset' || cmd.endsWith('/superset')) {
        if (args.join(' ') === 'auth whoami --json') {
          return world.authed === false ? FAIL : ok('{"user":"w"}');
        }
        if (args.join(' ') === 'workspaces list --local --json') {
          return ok(JSON.stringify(world.workspaces ?? []));
        }
        return FAIL;
      }
      return FAIL;
    },
    now: () => '2026-09-02T12:00:00Z',
    nowMs: () => Date.parse('2026-09-02T12:00:00Z'),
    homeDir: () => home,
    env,
    warn: (message) => warnings.push(message),
  };
  return { io, calls, warnings };
}

const CONFIG: BoardConfigFile = {
  operator: { githubLogin: 'dev', githubLogins: ['dev'] },
  repos: [{ name: 'o/r', supersetProjectId: 'proj-1' }],
};

async function poll(
  root: OrchRoot,
  projectDir: string,
  io: PollIo,
  options: { keepBaseline?: boolean } = {},
  config: BoardConfigFile = CONFIG,
): Promise<string> {
  return await runPoll(root, projectDir, config, io, { ghPath: '/stub/gh', ...options });
}

describe('operator.includeReviewRequests', () => {
  // The reviews-lane query carries `-author:` in the same search string; the
  // board-merge query is the bare `review-requested:<login>`. The flag governs
  // only the merge — the lane collects either way.
  const mergeSearches = (calls: { cmd: string; args: string[] }[]) =>
    calls.filter((c) =>
      c.args.some((a) => String(a).startsWith('review-requested:') && !String(a).includes('-author:')),
    );

  test('false drops the review-requested query from the poll', async () => {
    const { root, projectDir, home } = layout();
    const { io, calls } = makeIo({}, home);
    await poll(root, projectDir, io, {}, {
      operator: { githubLogin: 'dev', githubLogins: ['dev'], includeReviewRequests: false },
      repos: [{ name: 'o/r', supersetProjectId: 'proj-1' }],
    });
    expect(mergeSearches(calls)).toHaveLength(0);
  });

  test('absent keeps the historical merge', async () => {
    const { root, projectDir, home } = layout();
    const { io, calls } = makeIo({}, home);
    await poll(root, projectDir, io);
    expect(mergeSearches(calls)).toHaveLength(1);
  });

  test('the reviews lane is collected even with the merge off', async () => {
    const { root, projectDir, home } = layout();
    const { io, calls } = makeIo(
      { review: [{ number: 7, title: 'T', url: 'u', headRefName: 'b', baseRefName: 'main', isDraft: false, updatedAt: '2026-09-01T00:00:00Z', author: { login: 'alice' } }] },
      home,
    );
    await poll(root, projectDir, io, {}, {
      operator: { githubLogin: 'dev', githubLogins: ['dev'], includeReviewRequests: false },
      repos: [{ name: 'o/r', supersetProjectId: 'proj-1' }],
    });
    const lane = calls.filter((c) =>
      c.args.some((a) => String(a).includes('review-requested:dev -author:dev')),
    );
    expect(lane).toHaveLength(1);
    const doc = JSON.parse(readFileSync(join(projectDir, 'signals', 'reviews.json'), 'utf8'));
    expect(doc.reviews).toHaveLength(1);
    expect(doc.reviews[0]).toMatchObject({ repo: 'o/r', number: 7, author: 'alice', headRefName: 'b' });
  });
});

// ── First poll ────────────────────────────────────────────────────────────────

// The GitHub queries are global — the repos come from config, not from the
// project — so polling every configured project asked GitHub the same questions
// again and wrote the same answers into another directory. Three projects meant
// three identical passes, which at a sixty-second poll was enough traffic on its
// own to exhaust the hour's API budget and leave the board showing a
// degradation note instead of a board.
describe('one GitHub pass per refresh', () => {
  test('a shared pass polls gh once and still writes every project its own signals', async () => {
    const a = layout();
    const b = layout();
    const { io, calls } = makeIo(
      {
        open: [
          {
            number: 42,
            title: 'A short title',
            headRefName: 'b42',
            isDraft: false,
            reviewDecision: '',
            mergeStateStatus: 'CLEAN',
            statusCheckRollup: [{ conclusion: 'SUCCESS' }],
          },
        ],
        merged: [],
        closed: [],
        graphql: {
          data: { rateLimit: { remaining: 5000 }, r0: { p42: { number: 42, reviewThreads: { nodes: [] }, reviews: { nodes: [] } } } },
        },
      },
      a.home,
    );

    const shared = {};
    await runPoll(a.root, a.projectDir, CONFIG, io, { ghPath: '/stub/gh', shared });
    const afterFirst = calls.filter((c) => c.cmd === '/stub/gh').length;
    await runPoll(b.root, b.projectDir, CONFIG, io, { ghPath: '/stub/gh', shared });
    const afterSecond = calls.filter((c) => c.cmd === '/stub/gh').length;

    expect(afterFirst).toBeGreaterThan(0);
    expect(afterSecond).toBe(afterFirst);

    // Each project still has its own file, and they agree — including on the
    // moment of collection, having genuinely been collected at one.
    const read = (dir: string): string => readFileSync(join(dir, 'signals', 'github.json'), 'utf8');
    expect(read(b.projectDir)).toBe(read(a.projectDir));
    const reviews = (dir: string): string => readFileSync(join(dir, 'signals', 'reviews.json'), 'utf8');
    expect(reviews(b.projectDir)).toBe(reviews(a.projectDir));
  });

  test('without a shared pass each poll queries gh for itself', async () => {
    const a = layout();
    const b = layout();
    const { io, calls } = makeIo({ open: [], merged: [], closed: [] }, a.home);
    await runPoll(a.root, a.projectDir, CONFIG, io, { ghPath: '/stub/gh' });
    const afterFirst = calls.filter((c) => c.cmd === '/stub/gh').length;
    await runPoll(b.root, b.projectDir, CONFIG, io, { ghPath: '/stub/gh' });
    expect(calls.filter((c) => c.cmd === '/stub/gh').length).toBe(afterFirst * 2);
  });
});

// The disk cache is what `shared` cannot be: it spans the separate per-project
// watcher processes and the app's repeated refreshes, all of which re-fetched
// the identical global PR set. Two project dirs under ONE orch root are the real
// shape — the per-project watchers.
describe('the orch-root poll cache (pollCache)', () => {
  function sharedRoot(): { root: OrchRoot; projA: string; projB: string; home: string } {
    const base = tempDir();
    const root: OrchRoot = {
      root: base,
      configPath: join(base, 'config.json'),
      workspacesDir: join(base, 'workspaces'),
    };
    mkdirSync(root.workspacesDir, { recursive: true });
    const projA = join(base, 'p', 'a');
    const projB = join(base, 'p', 'b');
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    return { root, projA, projB, home };
  }
  const world: GhWorld = { open: [], merged: [], closed: [], graphql: { data: {} } };
  const at = (t: string) => {
    const m = makeIo(world, '/nonexistent');
    m.io.now = () => t;
    return m;
  };
  const ghCalls = (m: ReturnType<typeof makeIo>) =>
    m.calls.filter((c) => c.cmd === '/stub/gh').length;

  test('a second poll within the TTL reuses the pass — zero gh calls, own signals written', async () => {
    const { root, projA, projB } = sharedRoot();

    const a = at('2026-09-02T12:00:00Z');
    await runPoll(root, projA, CONFIG, a.io, { ghPath: '/stub/gh', pollCache: true });
    expect(ghCalls(a)).toBeGreaterThan(0);

    // 30s later, well under the 90s default TTL: the sibling project reuses it.
    const b = at('2026-09-02T12:00:30Z');
    await runPoll(root, projB, CONFIG, b.io, { ghPath: '/stub/gh', pollCache: true });
    expect(ghCalls(b)).toBe(0);
    // …and still wrote its OWN signals from the cached pass.
    expect(existsSync(join(projB, 'signals', 'github.json'))).toBe(true);
    expect(existsSync(join(projB, 'signals', 'reviews.json'))).toBe(true);

    // Past the TTL, the next poll fetches fresh again.
    const c = at('2026-09-02T12:05:00Z');
    await runPoll(root, projB, CONFIG, c.io, { ghPath: '/stub/gh', pollCache: true });
    expect(ghCalls(c)).toBeGreaterThan(0);
  });

  test('pollCache off (a bare poll) always fetches, even within the window', async () => {
    const { root, projA, projB } = sharedRoot();
    const a = at('2026-09-02T12:00:00Z');
    await runPoll(root, projA, CONFIG, a.io, { ghPath: '/stub/gh' });
    expect(ghCalls(a)).toBeGreaterThan(0);
    const b = at('2026-09-02T12:00:10Z');
    await runPoll(root, projB, CONFIG, b.io, { ghPath: '/stub/gh' });
    expect(ghCalls(b)).toBeGreaterThan(0);
  });

  test('a changed repo set is a cache miss', async () => {
    const { root, projA, projB } = sharedRoot();
    const a = at('2026-09-02T12:00:00Z');
    await runPoll(root, projA, CONFIG, a.io, { ghPath: '/stub/gh', pollCache: true });
    // A different repo set within the window must not read the other set's answers.
    const other: BoardConfigFile = { ...CONFIG, repos: [{ name: 'o/other' }] };
    const b = at('2026-09-02T12:00:20Z');
    await runPoll(root, projB, other, b.io, { ghPath: '/stub/gh', pollCache: true });
    expect(ghCalls(b)).toBeGreaterThan(0);
  });
});

describe('runPoll, first poll', () => {
  test('prints the four sections and the no-baseline line, in order', async () => {
    const { root, projectDir, home } = layout();
    writeFileSync(
      join(root.workspacesDir, 'ws-agent.json'),
      JSON.stringify({
        workspaceId: 'ws-agent',
        slug: 'agent-1',
        state: 'building',
        needsOperator: true,
        questions: ['q1', 'q2'],
        blockedReason: 'waiting on X',
      }),
    );
    const { io, warnings } = makeIo(
      {
        open: [
          {
            number: 42,
            title: 'A short title',
            headRefName: 'b42',
            isDraft: false,
            reviewDecision: '',
            mergeStateStatus: 'CLEAN',
            statusCheckRollup: [{ conclusion: 'SUCCESS' }],
          },
        ],
        merged: [{ number: 40, title: 'landed', mergedAt: '2026-09-01T10:00:00Z' }],
        closed: [
          { number: 39, title: 'dropped', headRefName: 'b39', closedAt: '2026-09-01T00:00:00Z', mergedAt: null },
          // Older than the 3-day window: listed nowhere.
          { number: 12, title: 'ancient', headRefName: 'b12', closedAt: '2026-08-01T00:00:00Z', mergedAt: null },
        ],
        graphql: { data: { rateLimit: { remaining: 5000 }, r0: { p42: { number: 42, reviewThreads: { nodes: [] }, reviews: { nodes: [] } } } } },
        comments: { '42': [{ body: 'Preview: https://b42-acmeui.vercel.app ready' }] },
        workspaces: [
          { id: 'ws-nostatus', name: 'W', branch: 'br', projectId: 'proj-1' },
          { id: 'ws-other', name: 'Other', branch: 'x', projectId: 'unrelated' },
          { id: 'ws-agent', name: 'Agent WS', branch: 'b42', projectId: 'proj-1' },
        ],
      },
      home,
    );

    const summary = await poll(root, projectDir, io);
    const lines = summary.split('\n');

    expect(lines).toEqual([
      HEADER_PRS,
      '  o/r#42 A short title',
      '      review= ci=green asks=0 merge=CLEAN last=-',
      '  MERGED o/r#40 landed at 2026-09-01T10:00:00Z',
      '  CLOSED-UNMERGED o/r#39 dropped at 2026-09-01T00:00:00Z',
      HEADER_AGENTS,
      '  agent-1 state=building session=unknown dirty=? unpushed=? NEEDS-OPERATOR questions=2 blocked=waiting on X',
      HEADER_NO_STATUS,
      '  W [br] ws-nostatus',
      HEADER_DELTAS,
      '  (first poll — no baseline)',
    ]);
    expect(warnings).toEqual([]);

    // The signals files carry poll.sh's exact document shapes.
    const github = JSON.parse(readFileSync(join(projectDir, 'signals', 'github.json'), 'utf8'));
    // repos is still the shape readers consume; the throttle bookkeeping fields
    // (mergedClosedAt/rateRemaining/enrichedCount) ride alongside, additive.
    expect(Object.keys(github)).toEqual([
      'collectedAt',
      'repos',
      'mergedClosedAt',
      'rateRemaining',
      'enrichedCount',
    ]);
    expect(github.repos).toHaveLength(1);
    expect(Object.keys(github.repos[0])).toEqual(['repo', 'open', 'merged', 'closed']);
    expect(github.repos[0].open[0].previewUrl).toBe('https://b42-acmeui.vercel.app');
    expect(github.repos[0].open[0]).not.toHaveProperty('statusCheckRollup');
    expect(github.repos[0].closed).toHaveLength(2);
    // The delta baseline is this poll's own doc, written AFTER the deltas
    // above were taken (hence the no-baseline line) — never rotated from
    // whatever github.json held, which a concurrent `board refresh` may have
    // written in between.
    expect(readFileSync(join(projectDir, 'signals', 'github.prev.json'), 'utf8')).toBe(
      readFileSync(join(projectDir, 'signals', 'github.json'), 'utf8'),
    );

    const workspaces = JSON.parse(readFileSync(join(projectDir, 'signals', 'workspaces.json'), 'utf8'));
    expect(Object.keys(workspaces)).toEqual(['collectedAt', 'workspaces', 'agentStatus']);
    expect(workspaces.workspaces).toHaveLength(3); // unfiltered, verbatim
    expect(workspaces.agentStatus[0].slug).toBe('agent-1');
    expect(workspaces.agentStatus[0].sessionLiveness).toBe('unknown');

    const tasks = JSON.parse(readFileSync(join(projectDir, 'signals', 'tasks.json'), 'utf8'));
    expect(tasks).toEqual({ collectedAt: '2026-09-02T12:00:00Z', tasks: [] });
  });

  test('a draft with asks and a re-review pending prints every pill of the line', async () => {
    const { root, projectDir, home } = layout();
    const { io } = makeIo(
      {
        open: [
          {
            number: 7,
            title: 'T7',
            isDraft: true,
            reviewDecision: 'CHANGES_REQUESTED',
            mergeStateStatus: 'BLOCKED',
            statusCheckRollup: [{ conclusion: 'FAILURE' }],
          },
        ],
        graphql: {
          data: {
            r0: {
              p7: {
                number: 7,
                reviewThreads: {
                  nodes: [
                    {
                      isResolved: false,
                      path: 'a.ts',
                      comments: { nodes: [{ author: { login: 'rev' }, body: 'fix', createdAt: '2026-09-01T09:00:00Z' }] },
                      lastComment: { nodes: [{ author: { login: 'rev' }, createdAt: '2026-09-01T09:00:00Z' }] },
                    },
                    {
                      isResolved: false,
                      path: 'b.ts',
                      comments: { nodes: [{ author: { login: 'rev' }, body: 'hm', createdAt: '2026-09-01T08:00:00Z' }] },
                      lastComment: { nodes: [{ author: { login: 'dev' }, createdAt: '2026-09-01T10:00:00Z' }] },
                    },
                  ],
                },
                reviews: { nodes: [{ author: { login: 'rev' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-09-01T07:00:00Z' }] },
              },
            },
          },
        },
      },
      home,
    );
    const summary = await poll(root, projectDir, io);
    expect(summary).toContain('  o/r#7 T7');
    expect(summary).toContain(
      '      review=CHANGES_REQUESTED ci=red asks=1 awaiting-rereview=1 draft merge=BLOCKED last=2026-09-01T09:00:00Z',
    );
  });

  test('not logged in warns verbatim and still reads status files', async () => {
    const { root, projectDir, home } = layout();
    writeFileSync(join(root.workspacesDir, 'ws-1.json'), JSON.stringify({ workspaceId: 'ws-1', slug: 's1', state: 'fixing' }));
    const { io, warnings } = makeIo({ authed: false }, home);
    const summary = await poll(root, projectDir, io);
    expect(warnings).toEqual([
      'superset not logged in — workspace list skipped; status files still read',
    ]);
    expect(summary).toContain('  s1 state=fixing session=unknown dirty=? unpushed=? ');
    const doc = JSON.parse(readFileSync(join(projectDir, 'signals', 'workspaces.json'), 'utf8'));
    expect(doc.workspaces).toEqual([]);
    expect(doc.agentStatus).toHaveLength(1);
  });
});

// ── Second poll: the deltas ───────────────────────────────────────────────────

describe('runPoll, deltas', () => {
  test('reports ready-to-merge, closed-unmerged and plain changes with exact prefixes', async () => {
    const { root, projectDir, home } = layout();
    const graphqlEmpty = (numbers: number[]) => ({
      data: {
        r0: Object.fromEntries(
          numbers.map((n) => [`p${n}`, { number: n, reviewThreads: { nodes: [] }, reviews: { nodes: [] } }]),
        ),
      },
    });

    // Poll 1: #42 not ready (changes requested, red), #43 open, #44 red.
    const first = makeIo(
      {
        open: [
          { number: 42, title: 'T42', reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED', statusCheckRollup: [{ conclusion: 'FAILURE' }] },
          { number: 43, title: 'T43', headRefName: 'b43', statusCheckRollup: [] },
          { number: 44, title: 'T44', statusCheckRollup: [{ conclusion: 'FAILURE' }] },
        ],
        graphql: graphqlEmpty([42, 43, 44]),
      },
      home,
    );
    const firstSummary = await poll(root, projectDir, first.io);
    expect(firstSummary.split('\n')).toContain('  (first poll — no baseline)');
    const firstGithub = readFileSync(join(projectDir, 'signals', 'github.json'), 'utf8');

    // Poll 2: #42 approved+green+clean, #43 closed unmerged, #44 goes green.
    const second = makeIo(
      {
        open: [
          { number: 42, title: 'T42', isDraft: false, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ conclusion: 'SUCCESS' }] },
          { number: 44, title: 'T44', statusCheckRollup: [{ conclusion: 'SUCCESS' }] },
        ],
        closed: [{ number: 43, title: 'T43', headRefName: 'b43', closedAt: '2026-09-02T01:00:00Z', mergedAt: null }],
        graphql: graphqlEmpty([42, 44]),
      },
      home,
    );
    // 30 min on — past the merged/closed refetch interval — so poll 2 actually
    // re-reads the closed list and sees #43 leave the open set. Within the
    // interval it would reuse poll 1's lists (that economy has its own test).
    second.io.now = () => '2026-09-02T12:30:00Z';
    const summary = await poll(root, projectDir, second.io);
    const lines = summary.split('\n');
    const deltas = lines.slice(lines.indexOf(HEADER_DELTAS) + 1);

    expect(deltas).toEqual([
      '  ★ READY TO MERGE  o/r#42 T42 — approved, green, no conflicts',
      '  o/r#44: review -→- ci red→green threads 0→0',
      '  ✖ CLOSED UNMERGED  o/r#43 T43 at 2026-09-02T01:00:00Z — branch b43',
    ]);

    // The deltas above were diffed against poll 1's doc, and the baseline has
    // now advanced to poll 2's own doc — ready for poll 3, and immune to any
    // github.json rewrite a refresh lands in between.
    expect(firstGithub).not.toBe('');
    expect(readFileSync(join(projectDir, 'signals', 'github.prev.json'), 'utf8')).toBe(
      readFileSync(join(projectDir, 'signals', 'github.json'), 'utf8'),
    );
  });

  test('keepBaseline polls never touch the *.prev.json pair', async () => {
    const { root, projectDir, home } = layout();
    // Poll 1 (baseline-owning) sets the baseline.
    const world: GhWorld = {
      open: [{ number: 5, title: 'T5', statusCheckRollup: [{ conclusion: 'SUCCESS' }] }],
      graphql: { data: { r0: { p5: { number: 5, reviewThreads: { nodes: [] }, reviews: { nodes: [] } } } } },
    };
    await poll(root, projectDir, makeIo(world, home).io);
    const baseline = readFileSync(join(projectDir, 'signals', 'github.prev.json'), 'utf8');
    const wsBaseline = readFileSync(join(projectDir, 'signals', 'workspaces.prev.json'), 'utf8');

    // A refresh-style poll sees #5 go red — new signals, untouched baseline.
    const changed: GhWorld = {
      open: [{ number: 5, title: 'T5', statusCheckRollup: [{ conclusion: 'FAILURE' }] }],
      graphql: world.graphql,
    };
    await poll(root, projectDir, makeIo(changed, home).io, { keepBaseline: true });
    expect(readFileSync(join(projectDir, 'signals', 'github.prev.json'), 'utf8')).toBe(baseline);
    expect(readFileSync(join(projectDir, 'signals', 'workspaces.prev.json'), 'utf8')).toBe(
      wsBaseline,
    );
    // The fresh signals themselves DID land — that is refresh's whole job.
    expect(readFileSync(join(projectDir, 'signals', 'github.json'), 'utf8')).not.toBe(baseline);

    // The next baseline-owning poll still reports the transition the refresh
    // saw first — the delta the daemon's events.log lines are made of.
    const summary = await poll(root, projectDir, makeIo(changed, home).io);
    const lines = summary.split('\n');
    expect(lines.slice(lines.indexOf(HEADER_DELTAS) + 1)).toEqual([
      '  o/r#5: review -→- ci green→red threads 0→0',
    ]);
  });

  test('an unchanged PR produces no delta line at all', async () => {
    const { root, projectDir, home } = layout();
    const world: GhWorld = {
      open: [{ number: 5, title: 'T5', statusCheckRollup: [{ conclusion: 'SUCCESS' }] }],
      graphql: { data: { r0: { p5: { number: 5, reviewThreads: { nodes: [] }, reviews: { nodes: [] } } } } },
    };
    await poll(root, projectDir, makeIo(world, home).io);
    const summary = await poll(root, projectDir, makeIo(world, home).io);
    const lines = summary.split('\n');
    expect(lines[lines.length - 1]).toBe(HEADER_DELTAS);
  });
});

// ── merged/closed fetch interval ──────────────────────────────────────────────
// merged/closed change rarely and cost 2 of every repo's 3 list calls. The poll
// fetches them only every cadence.mergedClosedEverySeconds and reuses the
// previous lists in between.
describe('runPoll, merged/closed interval', () => {
  const listCalls = (m: ReturnType<typeof makeIo>) =>
    m.calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'list');

  test('fetched on the first poll, reused within the interval — no refetch', async () => {
    const { root, projectDir, home } = layout();
    const world: GhWorld = {
      open: [{ number: 1, title: 'o', statusCheckRollup: [] }],
      merged: [{ number: 40, title: 'm', mergedAt: '2026-09-01T00:00:00Z' }],
      closed: [{ number: 39, title: 'c', headRefName: 'b', closedAt: '2026-09-01T00:00:00Z', mergedAt: null }],
      graphql: { data: { r0: { p1: { number: 1, reviewThreads: { nodes: [] }, reviews: { nodes: [] } } } } },
    };
    const first = makeIo(world, home);
    await poll(root, projectDir, first.io);
    expect(listCalls(first).some((c) => c.args.includes('merged'))).toBe(true);
    expect(listCalls(first).some((c) => c.args.includes('closed'))).toBe(true);

    // Poll 2, same clock — well within the 600s default: no merged/closed calls.
    const second = makeIo(world, home);
    await poll(root, projectDir, second.io);
    expect(listCalls(second).some((c) => c.args.includes('merged'))).toBe(false);
    expect(listCalls(second).some((c) => c.args.includes('closed'))).toBe(false);
    // …yet the reused lists are still written, so nothing a reader sees changes.
    const github = JSON.parse(readFileSync(join(projectDir, 'signals', 'github.json'), 'utf8'));
    expect(github.repos[0].merged).toHaveLength(1);
    expect(github.repos[0].closed).toHaveLength(1);
  });

  test('refetched once the interval has elapsed', async () => {
    const { root, projectDir, home } = layout();
    const world: GhWorld = { open: [], merged: [{ number: 40, mergedAt: 'x' }], closed: [], graphql: { data: {} } };
    await poll(root, projectDir, makeIo(world, home).io);
    const later = makeIo(world, home);
    later.io.now = () => '2026-09-02T12:30:00Z'; // 30 min on
    await poll(root, projectDir, later.io);
    expect(listCalls(later).some((c) => c.args.includes('merged'))).toBe(true);
  });
});

// ── rate-limit backoff ────────────────────────────────────────────────────────
// The previous poll records the GraphQL budget it saw; the next reads it and
// backs off as the hour drains, so the board never spends the agents' headroom.
describe('runPoll, rate-limit backoff', () => {
  test('a budget below the hard floor serves the cached fetch with no gh calls', async () => {
    const { root, projectDir, home } = layout();
    mkdirSync(join(projectDir, 'signals'), { recursive: true });
    writeFileSync(
      join(projectDir, 'signals', 'github.json'),
      JSON.stringify({
        collectedAt: '2026-09-02T11:00:00Z',
        repos: [{ repo: 'o/r', open: [{ number: 1, title: 'kept', ciState: 'green', unresolvedThreads: 0 }], merged: [], closed: [] }],
        rateRemaining: 50,
      }),
    );
    writeFileSync(
      join(projectDir, 'signals', 'reviews.json'),
      JSON.stringify({ collectedAt: '2026-09-02T11:00:00Z', reviews: [] }),
    );
    const { io, calls } = makeIo({ open: [{ number: 2, title: 'new', statusCheckRollup: [] }], graphql: { data: {} } }, home);
    await poll(root, projectDir, io);
    // Critically low → no GitHub calls at all; the previous fetch is served.
    expect(calls.filter((c) => c.cmd === '/stub/gh')).toHaveLength(0);
    const github = JSON.parse(readFileSync(join(projectDir, 'signals', 'github.json'), 'utf8'));
    expect(github.repos[0].open[0].title).toBe('kept'); // the cached PR, not #2
  });

  test('a budget below the soft floor skips merged/closed but still refreshes open', async () => {
    const { root, projectDir, home } = layout();
    mkdirSync(join(projectDir, 'signals'), { recursive: true });
    writeFileSync(
      join(projectDir, 'signals', 'github.json'),
      JSON.stringify({
        collectedAt: '2026-09-02T11:00:00Z',
        repos: [{ repo: 'o/r', open: [], merged: [{ number: 9, mergedAt: 'x' }], closed: [] }],
        rateRemaining: 500,
      }),
    );
    const { io, calls } = makeIo(
      {
        open: [{ number: 2, title: 'new', statusCheckRollup: [] }],
        merged: [],
        closed: [],
        graphql: { data: { r0: { p2: { number: 2, reviewThreads: { nodes: [] }, reviews: { nodes: [] } } } } },
      },
      home,
    );
    await poll(root, projectDir, io);
    const listed = calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'list');
    expect(listed.some((c) => c.args.includes('open'))).toBe(true); // open refreshed
    expect(listed.some((c) => c.args.includes('merged'))).toBe(false); // merged skipped
    const github = JSON.parse(readFileSync(join(projectDir, 'signals', 'github.json'), 'utf8'));
    expect(github.repos[0].merged).toHaveLength(1); // reused from the previous poll
  });
});

// ── Backlog ───────────────────────────────────────────────────────────────────

describe('runPoll, markdown backlog', () => {
  // The tracker pass is in-process since P4 (ops/tasks.ts): the backlog is
  // real task files under repos[0].localPath, and no tasks.sh exists to shell
  // out to.
  function repoWithTasks(): { repoRoot: string; config: BoardConfigFile } {
    const repoRoot = tempDir();
    const tasksDir = join(repoRoot, '.tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(
      join(tasksDir, 'T-1.md'),
      '---\nid: T-1\ntitle: Do a thing\nstatus: todo\npriority: p2\n---\n\nbody\n',
    );
    writeFileSync(
      join(tasksDir, 'T-2.md'),
      '---\nid: T-2\ntitle: Already dispatched\nstatus: doing\npriority: p1\n---\n',
    );
    const config: BoardConfigFile = {
      ...CONFIG,
      repos: [{ name: 'o/r', supersetProjectId: 'proj-1', localPath: repoRoot }],
      tracker: { kind: 'markdown' },
    };
    return { repoRoot, config };
  }

  test('lists only tasks with no board item, in poll.sh line shape', async () => {
    const { root, projectDir, home } = layout();
    writeFileSync(
      join(projectDir, 'board.json'),
      JSON.stringify({
        items: [
          { id: 'itm_1', title: 't', state: 'building', source: { kind: 'markdown', externalId: 'T-2' } },
        ],
      }),
    );
    const { config } = repoWithTasks();
    const { io, calls } = makeIo({}, home);
    const summary = await runPoll(root, projectDir, config, io, { ghPath: '/stub/gh' });
    const lines = summary.split('\n');
    expect(lines).toContain(HEADER_BACKLOG);
    expect(lines).toContain('  todo/p2  T-1  Do a thing');
    expect(summary).not.toContain('T-2');
    const doc = JSON.parse(readFileSync(join(projectDir, 'signals', 'tasks.json'), 'utf8'));
    expect(doc.tasks).toHaveLength(2);
    // The signal rows carry tasks.sh's exact object shape, body included.
    expect(doc.tasks[1]).toEqual({
      id: 'T-1',
      title: 'Do a thing',
      status: 'todo',
      priority: 'p2',
      path: doc.tasks[1].path,
      relPath: '.tasks/T-1.md',
      body: '\nbody',
    });
    // No shell-out: the tasks.sh dependency is gone, not just unexercised.
    expect(calls.some((c) => c.cmd.endsWith('tasks.sh'))).toBe(false);
  });

  test('no open tasks means no Backlog section at all, header included', async () => {
    const { root, projectDir, home } = layout();
    const { repoRoot, config } = repoWithTasks();
    rmSync(join(repoRoot, '.tasks'), { recursive: true });
    const { io } = makeIo({}, home);
    const summary = await runPoll(root, projectDir, config, io, { ghPath: '/stub/gh' });
    expect(summary).not.toContain(HEADER_BACKLOG);
  });

  test('a non-markdown tracker reads no task files', async () => {
    const { root, projectDir, home } = layout();
    const { config } = repoWithTasks();
    const { io } = makeIo({}, home);
    const noTracker: BoardConfigFile = { ...config, tracker: undefined };
    await runPoll(root, projectDir, noTracker, io, { ghPath: '/stub/gh' });
    const doc = JSON.parse(readFileSync(join(projectDir, 'signals', 'tasks.json'), 'utf8'));
    expect(doc.tasks).toEqual([]);
  });
});

// ── watch.sh interop ──────────────────────────────────────────────────────────

describe('the summary contract watch.sh depends on', () => {
  test('sections appear exactly once, in poll.sh order, deltas last', async () => {
    const { root, projectDir, home } = layout();
    const { io } = makeIo({}, home);
    const summary = await poll(root, projectDir, io);
    const lines = summary.split('\n');
    const indexes = [HEADER_PRS, HEADER_AGENTS, HEADER_NO_STATUS, HEADER_DELTAS].map((h) => {
      expect(lines.filter((l) => l === h)).toHaveLength(1);
      return lines.indexOf(h);
    });
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
    // `sed -n '/── Deltas since last poll/,$p'` must capture only delta lines.
    expect(indexes[3]).toBe(lines.length - 2);
    expect(lines[lines.length - 1]).toBe('  (first poll — no baseline)');
  });

  test("agent lines keep the trailing space watch.sh's greps ride on", async () => {
    const { root, projectDir, home } = layout();
    writeFileSync(join(root.workspacesDir, 'ws-q.json'), JSON.stringify({ workspaceId: 'ws-q', slug: 'quiet', state: 'building' }));
    const { io } = makeIo({}, home);
    const summary = await poll(root, projectDir, io);
    expect(summary.split('\n')).toContain('  quiet state=building session=unknown dirty=? unpushed=? ');
  });

  test('titles truncate at 52 in the sections and 56 in the deltas', async () => {
    const { root, projectDir, home } = layout();
    const title = 'x'.repeat(80);
    const world: GhWorld = {
      open: [{ number: 9, title, reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [] }],
      graphql: { data: { r0: { p9: { number: 9, reviewThreads: { nodes: [] }, reviews: { nodes: [] } } } } },
    };
    await poll(root, projectDir, makeIo(world, home).io);
    const changed: GhWorld = {
      ...world,
      open: [{ number: 9, title, reviewDecision: 'APPROVED', statusCheckRollup: [] }],
    };
    const summary = await poll(root, projectDir, makeIo(changed, home).io);
    expect(summary).toContain(`  o/r#9 ${'x'.repeat(52)}\n`);
    expect(summary).toContain(`  o/r#9: review CHANGES_REQUESTED→APPROVED ci none→none threads 0→0`);
    // The ready line's 56-codepoint slice, when a delta goes ready.
    const ready: GhWorld = {
      open: [
        {
          number: 9,
          title,
          isDraft: false,
          reviewDecision: 'APPROVED',
          mergeStateStatus: 'CLEAN',
          statusCheckRollup: [{ conclusion: 'SUCCESS' }],
        },
      ],
      graphql: world.graphql,
    };
    const readySummary = await poll(root, projectDir, makeIo(ready, home).io);
    expect(readySummary).toContain(
      `  ★ READY TO MERGE  o/r#9 ${'x'.repeat(56)} — approved, green, no conflicts`,
    );
  });
});
