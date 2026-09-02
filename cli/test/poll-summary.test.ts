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

function poll(
  root: OrchRoot,
  projectDir: string,
  io: PollIo,
  options: { keepBaseline?: boolean } = {},
  config: BoardConfigFile = CONFIG,
): string {
  return runPoll(root, projectDir, config, io, { ghPath: '/stub/gh', ...options });
}

describe('operator.includeReviewRequests', () => {
  // The reviews-lane query carries `-author:` in the same search string; the
  // board-merge query is the bare `review-requested:<login>`. The flag governs
  // only the merge — the lane collects either way.
  const mergeSearches = (calls: { cmd: string; args: string[] }[]) =>
    calls.filter((c) =>
      c.args.some((a) => String(a).startsWith('review-requested:') && !String(a).includes('-author:')),
    );

  test('false drops the review-requested query from the poll', () => {
    const { root, projectDir, home } = layout();
    const { io, calls } = makeIo({}, home);
    poll(root, projectDir, io, {}, {
      operator: { githubLogin: 'dev', githubLogins: ['dev'], includeReviewRequests: false },
      repos: [{ name: 'o/r', supersetProjectId: 'proj-1' }],
    });
    expect(mergeSearches(calls)).toHaveLength(0);
  });

  test('absent keeps the historical merge', () => {
    const { root, projectDir, home } = layout();
    const { io, calls } = makeIo({}, home);
    poll(root, projectDir, io);
    expect(mergeSearches(calls)).toHaveLength(1);
  });

  test('the reviews lane is collected even with the merge off', () => {
    const { root, projectDir, home } = layout();
    const { io, calls } = makeIo(
      { review: [{ number: 7, title: 'T', url: 'u', headRefName: 'b', baseRefName: 'main', isDraft: false, updatedAt: '2026-09-01T00:00:00Z', author: { login: 'alice' } }] },
      home,
    );
    poll(root, projectDir, io, {}, {
      operator: { githubLogin: 'dev', githubLogins: ['dev'], includeReviewRequests: false },
      repos: [{ name: 'o/r', supersetProjectId: 'proj-1' }],
    });
    const lane = calls.filter((c) =>
      c.args.some((a) => String(a) === 'review-requested:dev -author:dev'),
    );
    expect(lane).toHaveLength(1);
    const doc = JSON.parse(readFileSync(join(projectDir, 'signals', 'reviews.json'), 'utf8'));
    expect(doc.reviews).toHaveLength(1);
    expect(doc.reviews[0]).toMatchObject({ repo: 'o/r', number: 7, author: 'alice', headRefName: 'b' });
  });
});

// ── First poll ────────────────────────────────────────────────────────────────

describe('runPoll, first poll', () => {
  test('prints the four sections and the no-baseline line, in order', () => {
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
        comments: { '42': [{ body: 'Preview: https://b42-acme.vercel.app ready' }] },
        workspaces: [
          { id: 'ws-nostatus', name: 'W', branch: 'br', projectId: 'proj-1' },
          { id: 'ws-other', name: 'Other', branch: 'x', projectId: 'unrelated' },
          { id: 'ws-agent', name: 'Agent WS', branch: 'b42', projectId: 'proj-1' },
        ],
      },
      home,
    );

    const summary = poll(root, projectDir, io);
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
    expect(Object.keys(github)).toEqual(['collectedAt', 'repos']);
    expect(github.repos).toHaveLength(1);
    expect(Object.keys(github.repos[0])).toEqual(['repo', 'open', 'merged', 'closed']);
    expect(github.repos[0].open[0].previewUrl).toBe('https://b42-acme.vercel.app');
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

  test('a draft with asks and a re-review pending prints every pill of the line', () => {
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
    const summary = poll(root, projectDir, io);
    expect(summary).toContain('  o/r#7 T7');
    expect(summary).toContain(
      '      review=CHANGES_REQUESTED ci=red asks=1 awaiting-rereview=1 draft merge=BLOCKED last=2026-09-01T09:00:00Z',
    );
  });

  test('not logged in warns verbatim and still reads status files', () => {
    const { root, projectDir, home } = layout();
    writeFileSync(join(root.workspacesDir, 'ws-1.json'), JSON.stringify({ workspaceId: 'ws-1', slug: 's1', state: 'fixing' }));
    const { io, warnings } = makeIo({ authed: false }, home);
    const summary = poll(root, projectDir, io);
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
  test('reports ready-to-merge, closed-unmerged and plain changes with exact prefixes', () => {
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
    const firstSummary = poll(root, projectDir, first.io);
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
    const summary = poll(root, projectDir, second.io);
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

  test('keepBaseline polls never touch the *.prev.json pair', () => {
    const { root, projectDir, home } = layout();
    // Poll 1 (baseline-owning) sets the baseline.
    const world: GhWorld = {
      open: [{ number: 5, title: 'T5', statusCheckRollup: [{ conclusion: 'SUCCESS' }] }],
      graphql: { data: { r0: { p5: { number: 5, reviewThreads: { nodes: [] }, reviews: { nodes: [] } } } } },
    };
    poll(root, projectDir, makeIo(world, home).io);
    const baseline = readFileSync(join(projectDir, 'signals', 'github.prev.json'), 'utf8');
    const wsBaseline = readFileSync(join(projectDir, 'signals', 'workspaces.prev.json'), 'utf8');

    // A refresh-style poll sees #5 go red — new signals, untouched baseline.
    const changed: GhWorld = {
      open: [{ number: 5, title: 'T5', statusCheckRollup: [{ conclusion: 'FAILURE' }] }],
      graphql: world.graphql,
    };
    poll(root, projectDir, makeIo(changed, home).io, { keepBaseline: true });
    expect(readFileSync(join(projectDir, 'signals', 'github.prev.json'), 'utf8')).toBe(baseline);
    expect(readFileSync(join(projectDir, 'signals', 'workspaces.prev.json'), 'utf8')).toBe(
      wsBaseline,
    );
    // The fresh signals themselves DID land — that is refresh's whole job.
    expect(readFileSync(join(projectDir, 'signals', 'github.json'), 'utf8')).not.toBe(baseline);

    // The next baseline-owning poll still reports the transition the refresh
    // saw first — the delta the daemon's events.log lines are made of.
    const summary = poll(root, projectDir, makeIo(changed, home).io);
    const lines = summary.split('\n');
    expect(lines.slice(lines.indexOf(HEADER_DELTAS) + 1)).toEqual([
      '  o/r#5: review -→- ci green→red threads 0→0',
    ]);
  });

  test('an unchanged PR produces no delta line at all', () => {
    const { root, projectDir, home } = layout();
    const world: GhWorld = {
      open: [{ number: 5, title: 'T5', statusCheckRollup: [{ conclusion: 'SUCCESS' }] }],
      graphql: { data: { r0: { p5: { number: 5, reviewThreads: { nodes: [] }, reviews: { nodes: [] } } } } },
    };
    poll(root, projectDir, makeIo(world, home).io);
    const summary = poll(root, projectDir, makeIo(world, home).io);
    const lines = summary.split('\n');
    expect(lines[lines.length - 1]).toBe(HEADER_DELTAS);
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

  test('lists only tasks with no board item, in poll.sh line shape', () => {
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
    const summary = runPoll(root, projectDir, config, io, { ghPath: '/stub/gh' });
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

  test('no open tasks means no Backlog section at all, header included', () => {
    const { root, projectDir, home } = layout();
    const { repoRoot, config } = repoWithTasks();
    rmSync(join(repoRoot, '.tasks'), { recursive: true });
    const { io } = makeIo({}, home);
    const summary = runPoll(root, projectDir, config, io, { ghPath: '/stub/gh' });
    expect(summary).not.toContain(HEADER_BACKLOG);
  });

  test('a non-markdown tracker reads no task files', () => {
    const { root, projectDir, home } = layout();
    const { config } = repoWithTasks();
    const { io } = makeIo({}, home);
    const noTracker: BoardConfigFile = { ...config, tracker: undefined };
    runPoll(root, projectDir, noTracker, io, { ghPath: '/stub/gh' });
    const doc = JSON.parse(readFileSync(join(projectDir, 'signals', 'tasks.json'), 'utf8'));
    expect(doc.tasks).toEqual([]);
  });
});

// ── watch.sh interop ──────────────────────────────────────────────────────────

describe('the summary contract watch.sh depends on', () => {
  test('sections appear exactly once, in poll.sh order, deltas last', () => {
    const { root, projectDir, home } = layout();
    const { io } = makeIo({}, home);
    const summary = poll(root, projectDir, io);
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

  test("agent lines keep the trailing space watch.sh's greps ride on", () => {
    const { root, projectDir, home } = layout();
    writeFileSync(join(root.workspacesDir, 'ws-q.json'), JSON.stringify({ workspaceId: 'ws-q', slug: 'quiet', state: 'building' }));
    const { io } = makeIo({}, home);
    const summary = poll(root, projectDir, io);
    expect(summary.split('\n')).toContain('  quiet state=building session=unknown dirty=? unpushed=? ');
  });

  test('titles truncate at 52 in the sections and 56 in the deltas', () => {
    const { root, projectDir, home } = layout();
    const title = 'x'.repeat(80);
    const world: GhWorld = {
      open: [{ number: 9, title, reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [] }],
      graphql: { data: { r0: { p9: { number: 9, reviewThreads: { nodes: [] }, reviews: { nodes: [] } } } } },
    };
    poll(root, projectDir, makeIo(world, home).io);
    const changed: GhWorld = {
      ...world,
      open: [{ number: 9, title, reviewDecision: 'APPROVED', statusCheckRollup: [] }],
    };
    const summary = poll(root, projectDir, makeIo(changed, home).io);
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
    const readySummary = poll(root, projectDir, makeIo(ready, home).io);
    expect(readySummary).toContain(
      `  ★ READY TO MERGE  o/r#9 ${'x'.repeat(56)} — approved, green, no conflicts`,
    );
  });
});
