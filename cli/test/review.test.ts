// The reviews lane: collection (facts/github's queue query), the dismissal
// ledger, the effective queue, the cards.json contract, and `review start`.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { assemblerConfig } from '../src/cards/assemble.js';
import { REVIEW_FIELDS, collectReviewRequests } from '../src/facts/github.js';
import {
  DEFAULT_REVIEW_PROMPT,
  dismissedFile,
  effectiveQueue,
  fillPrompt,
  readDismissed,
  readReviewsSignals,
  startReview,
} from '../src/ops/review.js';
import { renderCardsJson } from '../src/render/cardsjson.js';
import type {
  CloudIo,
  ExecResult,
  OrchRoot,
  PollIo,
  ProjectRef,
  ReviewRow,
} from '../src/types.js';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-review-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function ok(stdout: string): ExecResult {
  return { status: 0, stdout, stderr: '' };
}
const FAIL: ExecResult = { status: 1, stdout: '', stderr: 'stubbed failure' };

function makeIo(handler: (cmd: string, args: string[]) => ExecResult | undefined) {
  const calls: { cmd: string; args: string[] }[] = [];
  const io: PollIo & CloudIo = {
    exec(cmd: string, args: string[]) {
      calls.push({ cmd, args });
      return handler(cmd, args) ?? FAIL;
    },
    now: () => '2026-09-02T12:00:00Z',
    nowMs: () => Date.parse('2026-09-02T12:00:00Z'),
    homeDir: () => '/nonexistent-home',
    env: {},
    warn: () => {},
    fetch: () => {
      throw new Error('no fetch in these tests');
    },
  } as PollIo & CloudIo;
  return { io, calls };
}

function row(over: Partial<ReviewRow> = {}): ReviewRow {
  return {
    repo: 'o/r',
    number: 7,
    title: 'fix: something',
    url: 'https://github.com/o/r/pull/7',
    author: 'alice',
    headRefName: 'alice/fix',
    baseRefName: 'main',
    isDraft: false,
    updatedAt: '2026-09-01T00:00:00Z',
    previewUrl: null,
    ...over,
  };
}

function orchAt(base: string): OrchRoot {
  return { root: base, configPath: join(base, 'config.json'), workspacesDir: join(base, 'workspaces') };
}

function project(base: string, key: string, reviews: unknown): ProjectRef {
  const root = join(base, 'p', key);
  mkdirSync(join(root, 'signals'), { recursive: true });
  if (reviews !== undefined) {
    writeFileSync(join(root, 'signals', 'reviews.json'), JSON.stringify({ collectedAt: 'X', reviews }));
  }
  return { key, root };
}

// ── Collection ────────────────────────────────────────────────────────────────

describe('collectReviewRequests', () => {
  test('one search per repo, author excluded in the search itself', () => {
    const { io, calls } = makeIo((cmd, args) => {
      if (cmd === '/gh' && args[1] === 'list') return ok('[]');
      return undefined;
    });
    collectReviewRequests(io, '/gh', ['o/r', 'o/s'], 'dev');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toEqual([
      'pr', 'list', '--repo', 'o/r',
      '--search', 'review-requested:dev -author:dev',
      '--state', 'open', '--limit', '30', '--json', REVIEW_FIELDS,
    ]);
  });

  test('maps rows, sorts the whole queue newest-updated first across repos', () => {
    const { io } = makeIo((cmd, args) => {
      if (cmd !== '/gh') return undefined;
      const repo = args[args.indexOf('--repo') + 1];
      if (repo === 'o/r') {
        return ok(JSON.stringify([
          { number: 1, title: 'old', url: 'u1', headRefName: 'b1', baseRefName: 'main', isDraft: true, updatedAt: '2026-08-01T00:00:00Z', author: { login: 'alice' } },
        ]));
      }
      return ok(JSON.stringify([
        { number: 2, title: 'new', url: 'u2', headRefName: 'b2', baseRefName: 'dev', isDraft: false, updatedAt: '2026-09-01T00:00:00Z', author: { login: 'bob' } },
      ]));
    });
    const rows = collectReviewRequests(io, '/gh', ['o/r', 'o/s'], '@me');
    expect(rows.map((r) => r.number)).toEqual([2, 1]);
    expect(rows[1]).toMatchObject({ repo: 'o/r', author: 'alice', isDraft: true, headRefName: 'b1' });
  });

  test('reuses the previous previewUrl and scrapes only when there is none', () => {
    const { io, calls } = makeIo((cmd, args) => {
      if (cmd !== '/gh') return undefined;
      if (args[1] === 'list') {
        return ok(JSON.stringify([
          { number: 1, title: 'a', updatedAt: '2026-08-02T00:00:00Z', author: { login: 'a' } },
          { number: 2, title: 'b', updatedAt: '2026-08-01T00:00:00Z', author: { login: 'b' } },
        ]));
      }
      if (args[1] === 'view') {
        return ok(JSON.stringify({ comments: [{ body: 'deployed: https://x-abc.vercel.app' }] }));
      }
      return undefined;
    });
    const previous = { reviews: [{ repo: 'o/r', number: 1, previewUrl: 'https://kept.example' }] };
    const rows = collectReviewRequests(io, '/gh', ['o/r'], '@me', { previousSignals: previous });
    expect(rows.find((r) => r.number === 1)!.previewUrl).toBe('https://kept.example');
    expect(rows.find((r) => r.number === 2)!.previewUrl).toBe('https://x-abc.vercel.app');
    // Only #2 was scraped.
    expect(calls.filter((c) => c.args[1] === 'view')).toHaveLength(1);
  });

  test('no gh means an empty queue, silently — the shell contract', () => {
    const { io, calls } = makeIo(() => undefined);
    expect(collectReviewRequests(io, null, ['o/r'], '@me')).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('a failed list degrades that repo to nothing, not the queue', () => {
    const { io } = makeIo((cmd, args) => {
      if (cmd !== '/gh') return undefined;
      const repo = args[args.indexOf('--repo') + 1];
      if (repo === 'o/bad') return FAIL;
      if (args[1] === 'list') {
        return ok(JSON.stringify([{ number: 3, title: 't', updatedAt: 'x', author: { login: 'c' } }]));
      }
      return ok('{"comments":[]}');
    });
    const rows = collectReviewRequests(io, '/gh', ['o/bad', 'o/r'], '@me');
    expect(rows.map((r) => r.number)).toEqual([3]);
  });
});

// ── The ledger and the effective queue ────────────────────────────────────────

describe('effectiveQueue', () => {
  test('joins projects, dedupes by (repo, number), subtracts the ledger', () => {
    const base = tempDir();
    const orch = orchAt(base);
    const a = project(base, 'a', [row({ number: 1 }), row({ number: 2, updatedAt: '2026-09-03T00:00:00Z' })]);
    const b = project(base, 'b', [row({ number: 1 }), row({ number: 3, updatedAt: '2026-08-01T00:00:00Z' })]);
    writeFileSync(
      dismissedFile(orch),
      JSON.stringify({ version: 1, dismissed: [{ repo: 'o/r', number: 3, title: '', dismissedAt: 'X' }] }),
    );
    const { rows, signalsPresent } = effectiveQueue(orch, [a, b]);
    expect(signalsPresent).toBe(true);
    expect(rows.map((r) => r.number)).toEqual([2, 1]);
  });

  test('no signals anywhere reads as absent, not as an empty queue', () => {
    const base = tempDir();
    const a = project(base, 'a', undefined);
    const { rows, signalsPresent } = effectiveQueue(orchAt(base), [a]);
    expect(rows).toEqual([]);
    expect(signalsPresent).toBe(false);
  });

  test('a garbled signals file or ledger costs nothing but its rows', () => {
    const base = tempDir();
    const orch = orchAt(base);
    const a = project(base, 'a', 'not-an-array' as unknown);
    writeFileSync(join(a.root, 'signals', 'reviews.json'), '{nope');
    writeFileSync(dismissedFile(orch), '{nope');
    expect(readReviewsSignals(a.root)).toEqual([]);
    expect(readDismissed(orch)).toEqual([]);
    expect(effectiveQueue(orch, [a]).rows).toEqual([]);
  });
});

// ── The cards.json contract ───────────────────────────────────────────────────

describe('cards.json reviews', () => {
  const config = assemblerConfig({
    repos: [
      { name: 'o/r', key: 'proj-r' },
      { name: 'o/s', key: 'proj-s' },
    ],
  });
  const projects: ProjectRef[] = [
    { key: 'proj-r', root: '' },
    { key: 'proj-s', root: '' },
  ];

  test('rows land under the project that orchestrates their repo', () => {
    const doc = JSON.parse(
      renderCardsJson(projects, [], config, 'X', null, [
        row({ repo: 'o/r', number: 1 }),
        row({ repo: 'o/s', number: 2 }),
        row({ repo: 'o/unmapped', number: 3 }),
      ]),
    );
    expect(doc.projects[0].reviews.map((r: { number: number }) => r.number)).toEqual([1]);
    expect(doc.projects[1].reviews.map((r: { number: number }) => r.number)).toEqual([2]);
    // The unmapped repo drops out, exactly as its cards would.
    expect(JSON.stringify(doc)).not.toContain('o/unmapped');
  });

  test('the key is present even when the queue is empty, and the flag rides the doc', () => {
    const doc = JSON.parse(renderCardsJson(projects, [], config, 'X', null, [], true));
    expect(doc.projects[0].reviews).toEqual([]);
    expect(doc.reviewsCountAsNeedsYou).toBe(true);
    const defaulted = JSON.parse(renderCardsJson(projects, [], config, 'X'));
    expect(defaulted.reviewsCountAsNeedsYou).toBe(false);
  });

  test('a review entry carries the row minus the branch names', () => {
    const doc = JSON.parse(renderCardsJson(projects, [], config, 'X', null, [row({ repo: 'o/r' })]));
    expect(doc.projects[0].reviews[0]).toEqual({
      repo: 'o/r',
      number: 7,
      title: 'fix: something',
      url: 'https://github.com/o/r/pull/7',
      author: 'alice',
      isDraft: false,
      updatedAt: '2026-09-01T00:00:00Z',
      previewUrl: null,
    });
  });
});

// ── fillPrompt ────────────────────────────────────────────────────────────────

describe('fillPrompt', () => {
  test('substitutes every placeholder, every occurrence', () => {
    const filled = fillPrompt('{repo}#{number} {title} by {author} on {branch} into {base}: {url} ({repo})', row(), 'main');
    expect(filled).toBe(
      'o/r#7 fix: something by alice on alice/fix into main: https://github.com/o/r/pull/7 (o/r)',
    );
  });

  test('the default prompt carries the guardrails: approve allowed, blocking is not', () => {
    const filled = fillPrompt(DEFAULT_REVIEW_PROMPT, row(), 'main');
    expect(filled).toContain('approve it (gh pr review --approve)');
    expect(filled).toContain('NEVER use --request-changes');
    expect(filled).toContain('Never push to this branch and never merge');
    expect(filled).toContain('alice/fix');
  });
});

// ── startReview ───────────────────────────────────────────────────────────────

const START_CONFIG = {
  repos: [{ name: 'o/r', supersetProjectId: 'proj-uuid', defaultBase: 'dev' }],
};

describe('startReview', () => {
  test('dry-run prints the create command and execs nothing mutating', () => {
    const { io, calls } = makeIo(() => undefined);
    const result = startReview(orchAt(tempDir()), START_CONFIG, row(), io, { dryRun: true });
    expect(result.json).toBeNull();
    expect(result.lines[0]).toContain('superset workspaces create --local --project proj-uuid');
    expect(result.lines[0]).toContain('--branch alice/fix');
    expect(result.lines[0]).toContain('--base-branch main');
    expect(calls).toHaveLength(0);
  });

  test('creates the workspace and returns the superset URL', () => {
    const { io, calls } = makeIo((cmd, args) => {
      if (!cmd.endsWith('superset') && cmd !== 'superset') return undefined;
      if (args.join(' ') === 'auth whoami --json') return ok('{"user":"w"}');
      if (args.join(' ') === 'workspaces list --local --json') return ok('[]');
      if (args[0] === 'workspaces' && args[1] === 'create') {
        return ok(JSON.stringify({ workspace: { id: 'ws-123' }, agents: [{ ok: true }] }));
      }
      return undefined;
    });
    const result = startReview(orchAt(tempDir()), START_CONFIG, row(), io);
    expect(result.json).toMatchObject({
      workspaceId: 'ws-123',
      workspaceUrl: 'superset://v2-workspace/ws-123',
      repo: 'o/r',
      number: 7,
    });
    const create = calls.find((c) => c.args[0] === 'workspaces' && c.args[1] === 'create')!;
    expect(create.args).toContain('--prompt');
    const prompt = create.args[create.args.indexOf('--prompt') + 1]!;
    expect(prompt).toContain('https://github.com/o/r/pull/7');
    expect(prompt).toContain('by alice');
    expect(create.args[create.args.indexOf('--name') + 1]).toBe('review-7');
  });

  test('refuses a branch that already has a workspace', () => {
    const { io } = makeIo((cmd, args) => {
      if (args.join(' ') === 'auth whoami --json') return ok('{"user":"w"}');
      if (args.join(' ') === 'workspaces list --local --json') {
        return ok(JSON.stringify([{ id: 'ws-9', branch: 'alice/fix' }]));
      }
      return undefined;
    });
    expect(() => startReview(orchAt(tempDir()), START_CONFIG, row(), io)).toThrow(
      /ws-9 is already on branch alice\/fix/,
    );
  });

  test('a config prompt template replaces the default', () => {
    const { io, calls } = makeIo((cmd, args) => {
      if (args.join(' ') === 'auth whoami --json') return ok('{"user":"w"}');
      if (args.join(' ') === 'workspaces list --local --json') return ok('[]');
      if (args[1] === 'create') return ok(JSON.stringify({ workspace: { id: 'ws-1' } }));
      return undefined;
    });
    startReview(
      orchAt(tempDir()),
      { ...START_CONFIG, review: { prompt: 'Please review {url} carefully.' } },
      row(),
      io,
    );
    const create = calls.find((c) => c.args[1] === 'create')!;
    expect(create.args[create.args.indexOf('--prompt') + 1]).toBe(
      'Please review https://github.com/o/r/pull/7 carefully.',
    );
  });

  test('missing supersetProjectId and missing branch both refuse', () => {
    const { io } = makeIo(() => undefined);
    expect(() => startReview(orchAt(tempDir()), { repos: [] }, row(), io)).toThrow(
      /no supersetProjectId for o\/r/,
    );
    expect(() =>
      startReview(orchAt(tempDir()), START_CONFIG, row({ headRefName: null }), io),
    ).toThrow(/no branch recorded/);
  });

  test('a row with no baseRefName falls back to the repo defaultBase', () => {
    const { io } = makeIo(() => undefined);
    const result = startReview(orchAt(tempDir()), START_CONFIG, row({ baseRefName: null }), io, {
      dryRun: true,
    });
    expect(result.lines[0]).toContain('--base-branch dev');
  });
});
