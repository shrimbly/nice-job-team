// The fact collectors, tested the way GitHubDecodingTests tests the Swift
// side: the frozen fixtures under Tests/BoardKitTests/Fixtures were produced
// by poll.sh's own jq and grep over one capture, so the port is compared on
// identical input. Everything external rides the injectable io — no gh, no
// superset, no network.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { collectAgentStatus, transcriptSlug } from '../src/facts/agents.js';
import {
  CLOSED_FIELDS,
  MERGED_FIELDS,
  OPEN_FIELDS,
  ciRollup,
  deriveOpenRow,
  detailsQuery,
  enrichPRs,
  fetchRepoPRs,
  indexDetails,
  previewFromPrevious,
  uniqueByNumber,
} from '../src/facts/github.js';
import {
  SUPERSET_NOT_LOGGED_IN_WARNING,
  authed,
  configuredProjectIds,
  filterToConfiguredProjects,
  getWorkspace,
  listLocalWorkspaces,
} from '../src/facts/superset.js';
import type { ExecResult, PollIo } from '../src/types.js';

const fixturesDir = fileURLToPath(new URL('../../Tests/BoardKitTests/Fixtures/', import.meta.url));

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}
function fixture(name: string): unknown {
  return JSON.parse(readFixture(name));
}

// ── io stub ───────────────────────────────────────────────────────────────────

interface Call {
  cmd: string;
  args: string[];
}

type Handler = (cmd: string, args: string[]) => ExecResult | undefined;

function makeIo(
  handler: Handler = () => undefined,
  overrides: Partial<PollIo> = {},
): { io: PollIo; calls: Call[]; warnings: string[] } {
  const calls: Call[] = [];
  const warnings: string[] = [];
  const io: PollIo = {
    exec(cmd, args) {
      calls.push({ cmd, args });
      return handler(cmd, args) ?? { status: 1, stdout: '', stderr: 'stubbed: no handler' };
    },
    now: () => '2026-09-02T12:00:00Z',
    nowMs: () => Date.parse('2026-09-02T12:00:00Z'),
    homeDir: () => '/nonexistent-home',
    env: {},
    warn: (message) => warnings.push(message),
    ...overrides,
  };
  return { io, calls, warnings };
}

function ok(stdout: string): ExecResult {
  return { status: 0, stdout, stderr: '' };
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-facts-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

// ── CI rollup ─────────────────────────────────────────────────────────────────

describe('ciRollup', () => {
  test('matches poll.sh over the frozen gh pr list capture', () => {
    const rows = fixture('gh-pr-list.json') as Record<string, unknown>[];
    const golden = fixture('expected-gh.json') as Record<string, { ciState: string }>;
    expect(rows.length).toBe(5);
    for (const row of rows) {
      const want = golden[String(row['number'])];
      expect(want, `no golden for #${String(row['number'])}`).toBeDefined();
      expect(ciRollup(row['statusCheckRollup']), `#${String(row['number'])} ciState`).toBe(
        want!.ciState,
      );
    }
  });

  test('a failing check outranks a running one', () => {
    expect(ciRollup([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }, { conclusion: '' }])).toBe('red');
  });

  test('an empty conclusion is a running CheckRun, not a fall-through to state', () => {
    // jq's `.conclusion // .state // ""` keeps "" — it is a value.
    expect(ciRollup([{ conclusion: '', state: 'SUCCESS' }])).toBe('running');
    expect(ciRollup([{ conclusion: 'SUCCESS' }, { conclusion: 'IN_PROGRESS' }])).toBe('running');
  });

  test('a StatusContext has no conclusion at all, so its state is used', () => {
    expect(ciRollup([{ state: 'SUCCESS' }])).toBe('green');
    expect(ciRollup([{ state: 'FAILURE' }])).toBe('red');
    expect(ciRollup([{ state: 'PENDING' }])).toBe('running');
  });

  test('no checks at all is none, not green', () => {
    expect(ciRollup([])).toBe('none');
    expect(ciRollup(null)).toBe('none');
  });

  test('SKIPPED and NEUTRAL do not make a PR red', () => {
    expect(ciRollup([{ conclusion: 'SKIPPED' }, { conclusion: 'SUCCESS' }])).toBe('green');
    expect(ciRollup([{ conclusion: 'NEUTRAL' }])).toBe('green');
  });
});

// ── unique_by(.number) ────────────────────────────────────────────────────────

describe('uniqueByNumber', () => {
  test('keeps the open-list row over its review-requested duplicate, sorted ascending', () => {
    const merged = uniqueByNumber([
      { number: 9, from: 'open' },
      { number: 4, from: 'open' },
      { number: 9, from: 'review' },
      { number: 7, from: 'review' },
    ]);
    expect(merged.map((r) => r['number'])).toEqual([4, 7, 9]);
    expect(merged.find((r) => r['number'] === 9)?.['from']).toBe('open');
  });
});

// ── gh pr list plumbing ───────────────────────────────────────────────────────

describe('fetchRepoPRs', () => {
  test("makes poll.sh's four calls with its field lists and limits", () => {
    const { io, calls } = makeIo((cmd, args) => {
      if (cmd !== '/stub/gh') return undefined;
      return ok('[]');
    });
    fetchRepoPRs(io, '/stub/gh', 'o/r', 'dev', 'dev');
    expect(calls.map((c) => c.args)).toEqual([
      ['pr', 'list', '--repo', 'o/r', '--author', 'dev', '--state', 'open', '--limit', '50', '--json', OPEN_FIELDS],
      ['pr', 'list', '--repo', 'o/r', '--search', 'review-requested:dev', '--state', 'open', '--limit', '30', '--json', OPEN_FIELDS],
      ['pr', 'list', '--repo', 'o/r', '--author', 'dev', '--state', 'merged', '--limit', '20', '--json', MERGED_FIELDS],
      ['pr', 'list', '--repo', 'o/r', '--author', 'dev', '--state', 'closed', '--limit', '10', '--json', CLOSED_FIELDS],
    ]);
  });

  test('a null author filter omits --author entirely', () => {
    // gh treats `--author ""` as an author named nothing and returns no PRs.
    const { io, calls } = makeIo(() => ok('[]'));
    fetchRepoPRs(io, '/stub/gh', 'o/r', null, '@me');
    for (const call of calls) expect(call.args).not.toContain('--author');
    expect(calls[1]!.args).toContain('review-requested:@me');
  });

  test('a null review login skips the review-requested query entirely', () => {
    // operator.includeReviewRequests: false — the board holds authored work
    // only, so the search call must not even be made.
    const { io, calls } = makeIo((cmd, args) => {
      if (args.includes('--search')) throw new Error('review-requested query must not run');
      if (args.includes('open')) return ok(JSON.stringify([{ number: 5, title: 'mine' }]));
      return ok('[]');
    });
    const prs = fetchRepoPRs(io, '/stub/gh', 'o/r', 'dev', null);
    expect(prs.open.map((r) => r['number'])).toEqual([5]);
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.args).not.toContain('--search');
  });

  test('review-requested PRs merge into open; closed keeps only unmerged', () => {
    const { io } = makeIo((cmd, args) => {
      if (args.includes('--search')) return ok(JSON.stringify([{ number: 7 }, { number: 5 }]));
      if (args.includes('open')) return ok(JSON.stringify([{ number: 5, title: 'mine' }]));
      if (args.includes('merged')) return ok(JSON.stringify([{ number: 3, mergedAt: 'T' }]));
      if (args.includes('closed')) {
        return ok(
          JSON.stringify([
            { number: 2, mergedAt: '2026-01-01T00:00:00Z' },
            { number: 1, mergedAt: null },
          ]),
        );
      }
      return undefined;
    });
    const prs = fetchRepoPRs(io, '/stub/gh', 'o/r', null, '@me');
    expect(prs.open.map((r) => r['number'])).toEqual([5, 7]);
    expect(prs.open[0]!['title']).toBe('mine');
    expect(prs.merged).toEqual([{ number: 3, mergedAt: 'T' }]);
    expect(prs.closed).toEqual([{ number: 1, mergedAt: null }]);
  });

  test('every failure degrades to empty lists, silently, like the shell', () => {
    const { io, warnings } = makeIo(() => ({ status: 4, stdout: '', stderr: 'boom' }));
    const prs = fetchRepoPRs(io, '/stub/gh', 'o/r', null, '@me');
    expect(prs).toEqual({ repo: 'o/r', open: [], merged: [], closed: [] });
    expect(warnings).toEqual([]);
  });
});

// ── The batched details query ─────────────────────────────────────────────────

describe('detailsQuery', () => {
  test('batches every PR of every repo behind sorted aliases', () => {
    const { query, aliasToRepo } = detailsQuery([
      { repo: 'o/r', number: 12 },
      { repo: 'o/r', number: 3 },
      { repo: 'a/b', number: 7 },
    ]);
    // Sorted repo names: a/b first.
    expect(aliasToRepo.get('r0')).toBe('a/b');
    expect(aliasToRepo.get('r1')).toBe('o/r');
    expect(query).toContain('r0: repository(owner: "a", name: "b")');
    expect(query).toContain('r1: repository(owner: "o", name: "r")');
    expect(query.indexOf('p3:')).toBeLessThan(query.indexOf('p12:'));
    expect(query.split('pullRequest(number:').length - 1).toBe(3);
    // poll.sh's rich fragment, not the Swift app's poor one.
    expect(query).toContain('lastComment: comments(last: 1)');
    expect(query).toContain('reviews(last: 20)');
    expect(query).toContain('isResolved isOutdated path');
  });

  test('a response with null nodes yields what did resolve', () => {
    const { aliasToRepo } = detailsQuery([
      { repo: 'o/r', number: 1 },
      { repo: 'o/r', number: 2 },
    ]);
    const index = indexDetails(
      { data: { rateLimit: { remaining: 4999 }, r0: { p1: null, p2: { number: 2 } } } },
      aliasToRepo,
    );
    expect(index.size).toBe(1);
    expect(index.get('o/r#2')).toEqual({ number: 2 });
  });
});

// ── Field derivation ──────────────────────────────────────────────────────────

describe('deriveOpenRow', () => {
  const opts = { ourLogins: ['dev'], preview: '' };

  test('splits unresolved threads by who spoke last', () => {
    const node = {
      number: 8,
      reviewThreads: {
        nodes: [
          {
            isResolved: false,
            path: 'src/a.ts',
            comments: { nodes: [{ author: { login: 'reviewer' }, body: 'x'.repeat(250), createdAt: '2026-01-03T00:00:00Z' }] },
            lastComment: { nodes: [{ author: { login: 'reviewer' }, createdAt: '2026-01-03T00:00:00Z' }] },
          },
          {
            isResolved: false,
            path: 'src/b.ts',
            comments: { nodes: [{ author: { login: 'reviewer' }, body: 'answered', createdAt: '2026-01-01T00:00:00Z' }] },
            lastComment: { nodes: [{ author: { login: 'dev' }, createdAt: '2026-01-02T00:00:00Z' }] },
          },
          { isResolved: true, comments: { nodes: [] }, lastComment: { nodes: [] } },
        ],
      },
      reviews: { nodes: [] },
    };
    const row = deriveOpenRow({ number: 8 }, node, 'o/r', opts);
    // The reviewer spoke last on a.ts — that one is our ask. Our own reply on
    // b.ts waits on a re-review, not on us.
    expect(row['unresolvedThreads']).toBe(1);
    expect(row['threadsAwaitingReviewer']).toBe(1);
    const sample = row['unresolvedSample'] as Record<string, unknown>[];
    expect(sample).toHaveLength(1);
    expect(sample[0]!['path']).toBe('src/a.ts');
    expect(sample[0]!['author']).toBe('reviewer');
    expect((sample[0]!['body'] as string).length).toBe(200);
  });

  test('a thread with no last comment reads as awaiting us ("?" is not ours)', () => {
    const node = {
      reviewThreads: {
        nodes: [{ isResolved: false, comments: { nodes: [] }, lastComment: { nodes: [] } }],
      },
    };
    const row = deriveOpenRow({ number: 1 }, node, 'o/r', opts);
    expect(row['unresolvedThreads']).toBe(1);
    expect(row['threadsAwaitingReviewer']).toBe(0);
    const sample = row['unresolvedSample'] as Record<string, unknown>[];
    expect(sample[0]).toEqual({ path: null, author: '?', body: '' });
  });

  test('latestActivityAt is the max of review and thread timestamps', () => {
    const node = {
      reviewThreads: {
        nodes: [
          {
            isResolved: true,
            comments: { nodes: [{ author: { login: 'r' }, body: 'b', createdAt: '2026-01-05T00:00:00Z' }] },
            lastComment: { nodes: [] },
          },
        ],
      },
      reviews: {
        nodes: [
          { author: { login: 'rev' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-01-01T00:00:00Z' },
          { author: { login: 'rev' }, state: 'APPROVED', submittedAt: '2026-01-04T00:00:00Z' },
        ],
      },
    };
    const row = deriveOpenRow({ number: 1 }, node, 'o/r', opts);
    // Resolved threads still count toward activity — poll.sh reads ALL of them.
    expect(row['latestActivityAt']).toBe('2026-01-05T00:00:00Z');
    // Last review per login wins, jq's object-add semantics.
    expect(row['reviewStates']).toEqual({ rev: 'APPROVED' });
  });

  test('no enrichment at all still derives, with nulls and zeroes', () => {
    const row = deriveOpenRow({ number: 5, title: 't', statusCheckRollup: [] }, null, 'o/r', opts);
    expect(row).toEqual({
      number: 5,
      title: 't',
      repo: 'o/r',
      previewUrl: null,
      ciState: 'none',
      unresolvedThreads: 0,
      threadsAwaitingReviewer: 0,
      unresolvedSample: [],
      latestActivityAt: null,
      reviewStates: {},
    });
  });
});

// ── enrichPRs over the frozen fixtures ────────────────────────────────────────

describe('enrichPRs', () => {
  /** Serves the graphql fixture and per-PR comments cut from it. */
  function fixtureGh(): Handler {
    const details = fixture('graphql-details.json') as {
      data: Record<string, Record<string, { comments?: { nodes?: { body?: string }[] } } | null>>;
    };
    return (cmd, args) => {
      if (cmd !== '/stub/gh') return undefined;
      if (args[0] === 'api' && args[1] === 'graphql') return ok(readFixture('graphql-details.json'));
      if (args[0] === 'pr' && args[1] === 'view') {
        const node = details.data['r0']?.[`p${args[2]}`];
        return ok(JSON.stringify({ comments: node?.comments?.nodes ?? [] }));
      }
      return undefined;
    };
  }

  test('derives ciState, threads and preview matching expected-gh.json', () => {
    const rows = fixture('gh-pr-list.json') as Record<string, unknown>[];
    const golden = fixture('expected-gh.json') as Record<
      string,
      { ciState: string; previewUrl: string; unresolvedThreads: number }
    >;
    const { io, calls } = makeIo(fixtureGh());
    const [block] = enrichPRs(
      io,
      '/stub/gh',
      [{ repo: 'acme/platform', open: rows, merged: [], closed: [] }],
      { ourLogins: ['shrimbly'] },
    );
    expect(block!.open).toHaveLength(5);
    for (const row of block!.open) {
      const want = golden[String(row['number'])]!;
      expect(row['ciState'], `#${String(row['number'])} ciState`).toBe(want.ciState);
      expect(row['previewUrl'], `#${String(row['number'])} previewUrl`).toBe(want.previewUrl);
      expect(row['unresolvedThreads'], `#${String(row['number'])} threads`).toBe(want.unresolvedThreads);
      expect(row['repo']).toBe('acme/platform');
      // The rollup is derived and then dropped, exactly like the jq's del().
      expect(row).not.toHaveProperty('statusCheckRollup');
    }
    // ONE GraphQL call for all five PRs — the batching poll.sh never had.
    expect(calls.filter((c) => c.args[0] === 'api' && c.args[1] === 'graphql')).toHaveLength(1);
  });

  test('a preview already in the previous signals is reused, not re-scraped', () => {
    const rows = fixture('gh-pr-list.json') as Record<string, unknown>[];
    const { io, calls } = makeIo(fixtureGh());
    const previous = {
      repos: [
        {
          repo: 'acme/platform',
          open: [
            { number: 438, previewUrl: 'https://cached-acme.vercel.app' },
            { number: 442, previewUrl: null },
          ],
        },
      ],
    };
    const [block] = enrichPRs(
      io,
      '/stub/gh',
      [{ repo: 'acme/platform', open: rows, merged: [], closed: [] }],
      { ourLogins: [], previousSignals: previous },
    );
    const by = new Map(block!.open.map((r) => [r['number'], r]));
    expect(by.get(438)!['previewUrl']).toBe('https://cached-acme.vercel.app');
    const scraped = calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'view').map((c) => c.args[2]);
    expect(scraped).not.toContain('438');
    // `.previewUrl // empty`: a recorded null is NOT a found preview.
    expect(scraped).toContain('442');
    expect(by.get(442)!['previewUrl']).toBe(
      'https://acme-git-tidy-reports.vercel.app',
    );
  });

  test('previewFromPrevious keeps "" falling through to a scrape', () => {
    expect(
      previewFromPrevious({ repos: [{ repo: 'o/r', open: [{ number: 1, previewUrl: '' }] }] }, 'o/r', 1),
    ).toBe('');
  });

  test('a failed GraphQL call degrades to unenriched rows, lists intact', () => {
    const { io } = makeIo((cmd, args) => {
      if (args[0] === 'api') return { status: 1, stdout: '', stderr: 'rate limited' };
      if (args[0] === 'pr' && args[1] === 'view') return ok('{"comments":[]}');
      return undefined;
    });
    const [block] = enrichPRs(
      io,
      '/stub/gh',
      [{ repo: 'o/r', open: [{ number: 9, title: 't', statusCheckRollup: [{ conclusion: 'SUCCESS' }] }], merged: [], closed: [] }],
      { ourLogins: [] },
    );
    expect(block!.open[0]!['ciState']).toBe('green');
    expect(block!.open[0]!['unresolvedThreads']).toBe(0);
    expect(block!.open[0]!['latestActivityAt']).toBeNull();
  });
});

// ── superset ──────────────────────────────────────────────────────────────────

describe('superset facts', () => {
  test('authed follows `superset auth whoami --json` exit status', () => {
    const yes = makeIo((cmd, args) =>
      args.join(' ') === 'auth whoami --json' ? ok('{"user":"w"}') : undefined,
    );
    expect(authed(yes.io)).toBe(true);
    const no = makeIo(() => ({ status: 1, stdout: '', stderr: 'not logged in' }));
    expect(authed(no.io)).toBe(false);
  });

  test('listLocalWorkspaces normalises null to [] and asks with --json last', () => {
    const { io, calls } = makeIo((cmd, args) =>
      args.join(' ') === 'workspaces list --local --json' ? ok('null') : undefined,
    );
    expect(listLocalWorkspaces(io)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test('a workspace list passes through verbatim; failures are []', () => {
    const rows = [{ id: 'ws-1', extraField: { deep: true } }];
    const good = makeIo(() => ok(JSON.stringify(rows)));
    expect(listLocalWorkspaces(good.io)).toEqual(rows);
    const bad = makeIo(() => ok('not json'));
    expect(listLocalWorkspaces(bad.io)).toEqual([]);
    const failed = makeIo(() => ({ status: 3, stdout: '[]', stderr: '' }));
    expect(listLocalWorkspaces(failed.io)).toEqual([]);
  });

  test('getWorkspace yields the object or null', () => {
    const { io } = makeIo((cmd, args) =>
      args.join(' ') === 'workspaces get ws-9 --json' ? ok('{"id":"ws-9","worktreePath":"/x"}') : undefined,
    );
    expect(getWorkspace(io, 'ws-9')).toEqual({ id: 'ws-9', worktreePath: '/x' });
    const failed = makeIo(() => ({ status: 1, stdout: '', stderr: '' }));
    expect(getWorkspace(failed.io, 'ws-9')).toBeNull();
  });

  test('the shared project filter scopes to configured ids, or passes all', () => {
    const ws = [
      { id: 'a', projectId: 'p1' },
      { id: 'b', projectId: 'p2' },
      { id: 'c', projectId: null },
      { id: 'd' },
    ];
    expect(filterToConfiguredProjects(ws, [])).toEqual(ws);
    expect(filterToConfiguredProjects(ws, ['p1'])).toEqual([{ id: 'a', projectId: 'p1' }]);
    // `(.projectId // "")`: null/absent match only a configured empty string.
    expect(filterToConfiguredProjects(ws, [''])).toEqual([
      { id: 'c', projectId: null },
      { id: 'd' },
    ]);
  });

  test('configuredProjectIds drops null and false like `// empty`', () => {
    expect(
      configuredProjectIds([
        { supersetProjectId: 'p1' },
        { supersetProjectId: null },
        { supersetProjectId: false },
        {},
        'junk',
      ]),
    ).toEqual(['p1']);
  });

  test('the not-logged-in warning is the verbatim poll.sh text', () => {
    expect(SUPERSET_NOT_LOGGED_IN_WARNING).toBe(
      'superset not logged in — workspace list skipped; status files still read',
    );
  });
});

// ── agents ────────────────────────────────────────────────────────────────────

describe('collectAgentStatus', () => {
  test('transcriptSlug maps / and . to dashes', () => {
    expect(transcriptSlug('/Users/w/.superset/worktrees/x.y')).toBe(
      '-Users-w--superset-worktrees-x-y',
    );
  });

  test('enriches each status file with liveness, dirt and unpushed state', () => {
    const home = tempDir();
    const inbox = tempDir();
    const worktree = join(tempDir(), 'wt');
    mkdirSync(worktree, { recursive: true });

    // ws-a: live workspace, idle transcript (mtime older than the stall),
    // two dirty files, no upstream.
    writeFileSync(join(inbox, 'ws-a.json'), JSON.stringify({ workspaceId: 'ws-a', slug: 'a', state: 'building' }));
    const transcripts = join(home, '.claude', 'projects', transcriptSlug(worktree));
    mkdirSync(transcripts, { recursive: true });
    const jsonl = join(transcripts, 'session.jsonl');
    writeFileSync(jsonl, '{}\n');
    const nowMs = Date.parse('2026-09-02T12:00:00Z');
    const old = new Date(nowMs - 60 * 60 * 1000); // 60 min ago > stall 45
    utimesSync(jsonl, old, old);

    // ws-b: no workspace row at all — everything stays unknown.
    writeFileSync(join(inbox, 'ws-b.json'), JSON.stringify({ workspaceId: 'ws-b', slug: 'b' }));
    // Unparseable and non-object files cost one warning each, never the poll.
    writeFileSync(join(inbox, 'broken.json'), '{nope');
    writeFileSync(join(inbox, 'scalar.json'), '42');
    // Not part of the inbox contract at all.
    writeFileSync(join(inbox, 'notes.txt'), 'ignored');

    const { io } = makeIo(
      (cmd, args) => {
        if (cmd !== 'git') return undefined;
        if (args[2] === 'status') return ok(' M a.ts\n M b.ts\n');
        if (args[2] === 'rev-list') return { status: 128, stdout: '', stderr: 'no upstream' };
        return undefined;
      },
      { homeDir: () => home, nowMs: () => nowMs },
    );

    const facts = collectAgentStatus(
      inbox,
      [{ id: 'ws-a', worktreePath: worktree }],
      45,
      io,
    );

    expect(facts.warnings).toEqual([
      `unparseable status file: ${join(inbox, 'broken.json')}`,
      `unparseable status file: ${join(inbox, 'scalar.json')}`,
    ]);
    expect(facts.agentStatus).toHaveLength(2);

    const a = facts.agentStatus[0]!;
    expect(a['slug']).toBe('a');
    expect(a['state']).toBe('building');
    expect(a['sessionLiveness']).toBe('idle');
    expect(a['lastSessionActivityAt']).toBe('2026-09-02T11:00:00Z');
    expect(a['worktreePath']).toBe(worktree);
    expect(a['dirtyFiles']).toBe('2');
    expect(a['unpushedCommits']).toBe('no-upstream');

    const b = facts.agentStatus[1]!;
    expect(b['sessionLiveness']).toBe('unknown');
    // "" through --arg, not null — render-board's readers depend on the shape.
    expect(b['lastSessionActivityAt']).toBe('');
    expect(b['worktreePath']).toBe('');
    expect(b['dirtyFiles']).toBe('?');
    expect(b['unpushedCommits']).toBe('?');
  });

  test('a transcript newer than stallMinutes reads active, with a count of unpushed', () => {
    const home = tempDir();
    const inbox = tempDir();
    const worktree = join(tempDir(), 'wt');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(inbox, 'ws-live.json'), JSON.stringify({ workspaceId: 'ws-live' }));
    const transcripts = join(home, '.claude', 'projects', transcriptSlug(worktree));
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(join(transcripts, 'fresh.jsonl'), '{}\n');

    const { io } = makeIo(
      (cmd, args) => {
        if (cmd !== 'git') return undefined;
        if (args[2] === 'status') return ok('');
        if (args[2] === 'rev-list') return ok('3\n');
        return undefined;
      },
      { homeDir: () => home },
    );
    // nowMs is the default stub clock; the file was just written, so it is
    // within any positive stall window.
    const facts = collectAgentStatus(inbox, [{ id: 'ws-live', worktreePath: worktree }], 45, {
      ...io,
      nowMs: () => Date.now(),
    });
    const row = facts.agentStatus[0]!;
    expect(row['sessionLiveness']).toBe('active');
    expect(row['dirtyFiles']).toBe('0');
    expect(row['unpushedCommits']).toBe('3');
  });

  test('a missing inbox directory is empty, with no warning', () => {
    const { io } = makeIo();
    expect(collectAgentStatus('/nonexistent-inbox', [], 45, io)).toEqual({
      agentStatus: [],
      warnings: [],
    });
  });
});
