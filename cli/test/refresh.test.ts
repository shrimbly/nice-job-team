// `board refresh` end to end, in-process, with every external command stubbed:
// the poll-then-render walk over a two-project root, the --render-only fast
// path's exec-free guarantee, the github-only mode's zero-disk-writes
// guarantee, the note's degradation report, and --stdout's print-AND-write
// convergence contract.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { runRefresh } from '../src/ops/refresh.js';
import type { ExecResult, PollIo } from '../src/types.js';

// ── Temp roots ────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-refresh-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

// ── The two-project fixture root ──────────────────────────────────────────────
// alpha's board claims PR o/beta#9 — the cross-project case: only the
// multi-project assembly knows beta must not synthesize it.

function twoProjectRoot(): string {
  const root = tempDir();
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      operator: { githubLogin: 'dev', githubLogins: ['dev'] },
      repos: [
        { name: 'o/alpha', key: 'alpha' },
        { name: 'o/beta', key: 'beta' },
      ],
    }),
  );
  mkdirSync(join(root, 'workspaces'));
  mkdirSync(join(root, 'p', 'alpha'), { recursive: true });
  mkdirSync(join(root, 'p', 'beta'), { recursive: true });
  writeFileSync(
    join(root, 'p', 'alpha', 'board.json'),
    JSON.stringify({
      version: 1,
      items: [
        {
          id: 'itm_1',
          slug: 'claims-beta-pr',
          title: 'Item that owns the beta PR',
          state: 'review',
          pr: { number: 9, url: 'https://gh/o/beta/pull/9' },
        },
      ],
    }),
  );
  writeFileSync(join(root, 'p', 'beta', 'board.json'), JSON.stringify({ version: 1, items: [] }));
  return root;
}

/** A signals file for the --render-only tests, bypassing the poll entirely. */
function seedAlphaSignals(root: string): string {
  const dir = join(root, 'p', 'alpha', 'signals');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'github.json');
  writeFileSync(
    file,
    JSON.stringify({
      collectedAt: '2026-09-01T00:00:00Z',
      repos: [
        {
          repo: 'o/alpha',
          open: [
            {
              number: 12,
              title: 'Seeded from the last poll',
              headRefName: 'feat/seeded',
              url: 'https://gh/o/alpha/pull/12',
              isDraft: false,
              reviewDecision: '',
              ciState: 'green',
              unresolvedThreads: 0,
            },
          ],
          merged: [],
          closed: [],
        },
      ],
    }),
  );
  return file;
}

// ── The io stub ───────────────────────────────────────────────────────────────

function ok(stdout: string): ExecResult {
  return { status: 0, stdout, stderr: '' };
}
const FAIL: ExecResult = { status: 1, stdout: '', stderr: 'stubbed failure' };

interface World {
  /** repo → its `gh pr list --state open` rows. */
  open?: Record<string, unknown[]>;
  /** Every gh call fails, poll.sh-degrade style. */
  ghFails?: boolean;
}

function openRow(number: number, repo: string): Record<string, unknown> {
  return {
    number,
    title: `PR ${number}`,
    headRefName: `feat/${number}`,
    baseRefName: 'main',
    url: `https://gh/${repo}/pull/${number}`,
    isDraft: false,
    reviewDecision: '',
    updatedAt: '2026-09-01T10:00:00Z',
    mergeStateStatus: 'CLEAN',
    reviewRequests: [],
    statusCheckRollup: [],
  };
}

function makeIo(env: NodeJS.ProcessEnv, world: World = {}) {
  const calls: { cmd: string; args: string[] }[] = [];
  const warnings: string[] = [];
  const io: PollIo = {
    exec(cmd, args) {
      calls.push({ cmd, args });
      if (cmd === '/stub/gh') {
        if (world.ghFails === true) return FAIL;
        if (args[0] === 'pr' && args[1] === 'list') {
          if (args.includes('--search')) return ok('[]');
          const repo = args[args.indexOf('--repo') + 1]!;
          const state = args[args.indexOf('--state') + 1]!;
          if (state === 'open') return ok(JSON.stringify(world.open?.[repo] ?? []));
          return ok('[]');
        }
        if (args[0] === 'api' && args[1] === 'graphql') return ok(JSON.stringify({ data: {} }));
        if (args[0] === 'pr' && args[1] === 'view') return ok(JSON.stringify({ comments: [] }));
        return FAIL;
      }
      // superset, and anything else: not logged in / not installed. The poll
      // warns and degrades, exactly the offline case.
      return FAIL;
    },
    now: () => '2026-09-02T12:00:00Z',
    nowMs: () => Date.parse('2026-09-02T12:00:00Z'),
    homeDir: () => tempDir(),
    env,
    warn: (message) => warnings.push(message),
  };
  return { io, calls, warnings };
}

interface CapturedRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function refresh(
  argv: string[],
  io: PollIo,
  ghPath: string | null = '/stub/gh',
): Promise<CapturedRun> {
  let stdout = '';
  let stderr = '';
  const code = await runRefresh(argv, {
    io,
    ghPath,
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

interface DocProject {
  key: string;
  cards: { id: string; num: number | null }[];
}
interface Doc {
  version: number;
  generatedAt: string;
  note: string | null;
  projects: DocProject[];
}

function readDoc(file: string): Doc {
  return JSON.parse(readFileSync(file, 'utf8')) as Doc;
}

// ── Full refresh: poll then render, root + per-project ────────────────────────

describe('board refresh over a two-project root', () => {
  test('writes root and per-project cards.json with the cross-project assembly', async () => {
    const root = twoProjectRoot();
    const { io } = makeIo(
      { SUPERSET_ORCH_ROOT: root },
      { open: { 'o/alpha': [openRow(7, 'o/alpha'), openRow(5, 'o/alpha')], 'o/beta': [openRow(9, 'o/beta')] } },
    );
    const run = await refresh([], io);
    expect(run.code).toBe(0);

    // The poll ran: each project carries its own signals.
    expect(existsSync(join(root, 'p', 'alpha', 'signals', 'github.json'))).toBe(true);
    expect(existsSync(join(root, 'p', 'beta', 'signals', 'github.json'))).toBe(true);

    // The render ran: per-project artifacts plus the root document.
    for (const key of ['alpha', 'beta']) {
      expect(existsSync(join(root, 'p', key, 'board.html'))).toBe(true);
      expect(existsSync(join(root, 'p', key, 'board.md'))).toBe(true);
      expect(existsSync(join(root, 'p', key, 'cards.json'))).toBe(true);
    }
    const rootDoc = readDoc(join(root, 'cards.json'));
    expect(rootDoc.version).toBe(2);
    expect(rootDoc.note).toBeNull();
    expect(rootDoc.projects.map((p) => p.key)).toEqual(['alpha', 'beta']);

    // Cross-project claim resolution — the multi-project assembly, not a
    // concatenation of per-project ones: alpha's item owns o/beta#9, so beta
    // synthesizes nothing in the merged document…
    const [alpha, beta] = rootDoc.projects;
    expect(beta!.cards).toEqual([]);
    expect(alpha!.cards.map((c) => c.num)).toContain(9);
    expect(alpha!.cards.find((c) => c.num === 9)!.id).toBe('itm_1');
    // …and the synthesized pair keeps the assembled order (same tone → num desc).
    const nums = alpha!.cards.map((c) => c.num);
    expect(nums.indexOf(7)).toBeGreaterThan(-1);
    expect(nums.indexOf(7)).toBeLessThan(nums.indexOf(5));

    // beta's OWN file assembles beta alone against its signals, where nothing
    // claims #9 — the proof the root document took the other path.
    const betaDoc = readDoc(join(root, 'p', 'beta', 'cards.json'));
    expect(betaDoc.projects[0]!.cards.map((c) => c.id)).toContain('pr:o/beta#9');

    // One generatedAt for the whole run.
    const alphaDoc = readDoc(join(root, 'p', 'alpha', 'cards.json'));
    expect(alphaDoc.generatedAt).toBe(rootDoc.generatedAt);
    expect(betaDoc.generatedAt).toBe(rootDoc.generatedAt);
  });

  test('SUPERSET_ORCH_PROJECT narrows the poll and render, never the root document', async () => {
    const root = twoProjectRoot();
    // The daemon's world: the installed watch service bakes the project key
    // into its env, and cycle requires it on any multi-repo config.
    const { io } = makeIo(
      { SUPERSET_ORCH_ROOT: root, SUPERSET_ORCH_PROJECT: 'alpha' },
      { open: { 'o/alpha': [openRow(7, 'o/alpha')], 'o/beta': [openRow(9, 'o/beta')] } },
    );
    const run = await refresh([], io);
    expect(run.code).toBe(0);

    // Only the selected project was polled and rendered…
    expect(existsSync(join(root, 'p', 'alpha', 'signals', 'github.json'))).toBe(true);
    expect(existsSync(join(root, 'p', 'beta', 'signals'))).toBe(false);
    expect(existsSync(join(root, 'p', 'alpha', 'board.html'))).toBe(true);
    expect(existsSync(join(root, 'p', 'beta', 'board.html'))).toBe(false);

    // …but the root document still holds EVERY discovered project: a
    // per-project daemon must not rewrite the thin clients' whole-world view
    // down to its one project, or the app flip-flops between boards.
    const rootDoc = readDoc(join(root, 'cards.json'));
    expect(rootDoc.projects.map((p) => p.key)).toEqual(['alpha', 'beta']);
  });

  test('a thrown poll still renders, and the note names it', async () => {
    const root = twoProjectRoot();
    // board.json's directory made read-only would be invasive; instead throw
    // from the io seam itself: exec exploding is a spawn-layer failure the
    // catch must contain per project.
    const { io } = makeIo({ SUPERSET_ORCH_ROOT: root });
    const exploding: PollIo = {
      ...io,
      exec: () => {
        throw new Error('spawn EPERM');
      },
    };
    const run = await refresh([], exploding);
    expect(run.code).toBe(0);
    const rootDoc = readDoc(join(root, 'cards.json'));
    expect(rootDoc.note).toContain('poll failed for alpha');
    expect(rootDoc.note).toContain('spawn EPERM');
  });
});

// ── --render-only: the FS-change fast path ────────────────────────────────────

describe('--render-only', () => {
  test('touches no signals, runs no commands, still renders everything', async () => {
    const root = twoProjectRoot();
    const signalsFile = seedAlphaSignals(root);
    const before = readFileSync(signalsFile, 'utf8');
    const { io, calls } = makeIo({ SUPERSET_ORCH_ROOT: root });

    const run = await refresh(['--render-only'], io, null);
    expect(run.code).toBe(0);

    // No exec at all — not gh, not superset, not a login shell for locating gh.
    expect(calls).toEqual([]);
    // The seeded signals are byte-identical, and no poll by-products appeared.
    expect(readFileSync(signalsFile, 'utf8')).toBe(before);
    expect(existsSync(join(root, 'p', 'alpha', 'signals', 'github.prev.json'))).toBe(false);
    expect(existsSync(join(root, 'p', 'alpha', 'signals', 'workspaces.json'))).toBe(false);
    expect(existsSync(join(root, 'p', 'beta', 'signals'))).toBe(false);

    // Rendered from the last signals: the seeded PR is on the root document,
    // with no note — skipping the poll on request is not a degradation.
    const rootDoc = readDoc(join(root, 'cards.json'));
    expect(rootDoc.note).toBeNull();
    const alpha = rootDoc.projects.find((p) => p.key === 'alpha')!;
    expect(alpha.cards.map((c) => c.id)).toContain('pr:o/alpha#12');
  });

  test('--stdout prints the root document AND writes it, identically', async () => {
    const root = twoProjectRoot();
    seedAlphaSignals(root);
    const { io } = makeIo({ SUPERSET_ORCH_ROOT: root });

    const run = await refresh(['--render-only', '--stdout'], io, null);
    expect(run.code).toBe(0);

    const printed = JSON.parse(run.stdout) as Doc;
    expect(printed.version).toBe(2);
    expect(run.stdout).toBe(readFileSync(join(root, 'cards.json'), 'utf8'));
  });
});

// ── --repos: github-only mode ─────────────────────────────────────────────────

describe('--repos (github-only mode)', () => {
  test('produces the v2 document from gh alone, with zero disk writes', async () => {
    const base = tempDir();
    const missingRoot = join(base, 'never-created');
    const { io } = makeIo(
      { SUPERSET_ORCH_ROOT: missingRoot },
      { open: { 'o/alpha': [openRow(7, 'o/alpha')], 'o/beta': [openRow(9, 'o/beta')] } },
    );

    const run = await refresh(['--repos', 'o/alpha,o/beta'], io);
    expect(run.code).toBe(0);

    const doc = JSON.parse(run.stdout) as Doc;
    expect(doc.version).toBe(2);
    expect(doc.note).toBeNull();
    expect(doc.projects.map((p) => p.key)).toEqual(['o-alpha', 'o-beta']);
    expect(doc.projects[0]!.cards.map((c) => c.id)).toEqual(['pr:o/alpha#7']);
    expect(doc.projects[1]!.cards.map((c) => c.id)).toEqual(['pr:o/beta#9']);

    // No orchestrator root was needed, consulted, or invented.
    expect(existsSync(missingRoot)).toBe(false);
    expect(readdirSync(base)).toEqual([]);
  });

  test('a gh failure degrades to an empty document whose note names it', async () => {
    const base = tempDir();
    const { io } = makeIo({ SUPERSET_ORCH_ROOT: join(base, 'nope') }, { ghFails: true });

    const run = await refresh(['--repos', 'o/alpha'], io);
    expect(run.code).toBe(0);

    const doc = JSON.parse(run.stdout) as Doc;
    expect(doc.projects).toHaveLength(1);
    expect(doc.projects[0]!.cards).toEqual([]);
    expect(doc.note).toContain('gh pr list for o/alpha failed');
    expect(existsSync(join(base, 'nope'))).toBe(false);
  });

  test('no gh anywhere still produces a document, note included', async () => {
    const base = tempDir();
    const { io, calls } = makeIo({ SUPERSET_ORCH_ROOT: join(base, 'nope') });

    const run = await refresh(['--repos', 'o/alpha'], io, null);
    expect(run.code).toBe(0);
    expect(calls).toEqual([]);
    const doc = JSON.parse(run.stdout) as Doc;
    expect(doc.projects[0]!.cards).toEqual([]);
    expect(doc.note).toContain('gh not found');
  });

  test('BOARD_REPOS is the flagless spelling, but orchestrator flags win', async () => {
    // Bare refresh with BOARD_REPOS: github-only mode.
    const base = tempDir();
    const bare = makeIo(
      { SUPERSET_ORCH_ROOT: join(base, 'nope'), BOARD_REPOS: 'o/alpha' },
      { open: { 'o/alpha': [openRow(7, 'o/alpha')] } },
    );
    const run = await refresh([], bare.io);
    expect(run.code).toBe(0);
    expect((JSON.parse(run.stdout) as Doc).projects.map((p) => p.key)).toEqual(['o-alpha']);

    // --render-only with the same env: the orchestrator root, not github-only —
    // an exported BOARD_REPOS must not hijack an operator's explicit flags.
    const root = twoProjectRoot();
    const scoped = makeIo({ SUPERSET_ORCH_ROOT: root, BOARD_REPOS: 'o/alpha' });
    const scopedRun = await refresh(['--render-only'], scoped.io, null);
    expect(scopedRun.code).toBe(0);
    expect(scopedRun.stdout).toBe('');
    expect(existsSync(join(root, 'cards.json'))).toBe(true);
  });

  test('the orchestrator flags are refused with --repos, loudly', async () => {
    const { io } = makeIo({});
    const withProject = await refresh(['--repos', 'o/r', '--project', 'x'], io);
    expect(withProject.code).toBe(1);
    expect(withProject.stderr).toContain('BLOCKED: --project has no meaning with --repos');
    const withRenderOnly = await refresh(['--repos', 'o/r', '--render-only'], io);
    expect(withRenderOnly.code).toBe(1);
    expect(withRenderOnly.stderr).toContain('BLOCKED: --render-only has no meaning with --repos');
  });
});

// ── argv hygiene ──────────────────────────────────────────────────────────────

test('an unknown argument dies BLOCKED instead of rendering the wrong board', async () => {
  const { io } = makeIo({});
  const run = await refresh(['--frobnicate'], io);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain('BLOCKED: unknown argument: --frobnicate');
});
