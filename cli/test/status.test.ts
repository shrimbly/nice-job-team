// `board status` over stubbed superset io and REAL temp git repos: id
// resolution's three tiers, every verb's field effects, the missing-file hard
// error, diffstat's range fallbacks (binary "-" rows included), and the state
// validation refusal. Nothing here touches the live superset CLI, ~/.superset
// or ~/.claude — the orchestrator root is a temp directory via
// SUPERSET_ORCH_ROOT, exactly how status.sh honoured it.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { statusOp } from '../src/ops/status.js';
import type { StatusIo } from '../src/ops/status.js';
import type { ExecResult } from '../src/types.js';

const NOW_ISO = '2026-09-02T12:00:00Z';
const LATER_ISO = '2026-09-02T13:30:00Z';

// ── temp roots ────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-status-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

// ── real git fixtures ─────────────────────────────────────────────────────────

/** Hermetic git: no user/system config, a pinned identity, no gpg surprises. */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function run(cmd: string, args: string[]): string {
  const result = spawnSync(cmd, args, { encoding: 'utf8', env: GIT_ENV });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/** git init -b main plus one committed README; no remote. */
function makeLocalRepo(base: string, name = 'repo'): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  run('git', ['init', '-b', 'main', dir]);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  run('git', ['-C', dir, 'add', '.']);
  run('git', ['-C', dir, 'commit', '-m', 'init']);
  return dir;
}

/** A bare origin and a clone with main pushed and origin/HEAD recorded. */
function makeCloneRepo(base: string): { origin: string; clone: string } {
  const origin = join(base, 'origin.git');
  run('git', ['init', '--bare', '-b', 'main', origin]);
  const clone = join(base, 'clone');
  run('git', ['clone', origin, clone]);
  writeFileSync(join(clone, 'README.md'), 'hello\n');
  run('git', ['-C', clone, 'add', '.']);
  run('git', ['-C', clone, 'commit', '-m', 'init']);
  run('git', ['-C', clone, 'push', '-u', 'origin', 'main']);
  // origin/HEAD, which init's base detection resolves through symbolic-ref.
  run('git', ['-C', clone, 'remote', 'set-head', 'origin', 'main']);
  return { origin, clone };
}

/** What `git rev-parse --show-toplevel` itself says — symlinks resolved. */
function toplevel(dir: string): string {
  return run('git', ['-C', dir, 'rev-parse', '--show-toplevel']).trim();
}

// ── io stub: superset faked, git passed through for real in a pinned cwd ──────

interface Layout {
  base: string;
  home: string;
  orchRoot: string;
  wsDir: string;
}

function makeLayout(): Layout {
  const base = tempDir();
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const orchRoot = join(base, 'orch');
  return { base, home, orchRoot, wsDir: join(orchRoot, 'workspaces') };
}

interface Call {
  cmd: string;
  args: string[];
}

interface IoOpts {
  cwd: string;
  layout: Layout;
  env?: Record<string, string>;
  /** Rows for `workspaces list --local --json`; absent means no superset CLI. */
  supersetRows?: unknown;
}

function makeIo(opts: IoOpts): { io: StatusIo; calls: Call[]; clock: { value: string } } {
  const calls: Call[] = [];
  const clock = { value: NOW_ISO };
  const io: StatusIo = {
    exec(cmd, args): ExecResult {
      calls.push({ cmd, args });
      if (cmd === 'git') {
        const result = spawnSync('git', args, { cwd: opts.cwd, encoding: 'utf8', env: GIT_ENV });
        return {
          status: result.status ?? 1,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
        };
      }
      if (
        (cmd === 'superset' || cmd.endsWith('/superset')) &&
        args.join(' ') === 'workspaces list --local --json'
      ) {
        if (opts.supersetRows === undefined) {
          return { status: 127, stdout: '', stderr: 'command not found' };
        }
        return { status: 0, stdout: JSON.stringify(opts.supersetRows), stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'stubbed failure' };
    },
    now: () => clock.value,
    nowMs: () => Date.parse(clock.value),
    homeDir: () => opts.layout.home,
    cwd: () => opts.cwd,
    env: { SUPERSET_ORCH_ROOT: opts.layout.orchRoot, ...opts.env },
    warn: () => {},
  };
  return { io, calls, clock };
}

function readStatus(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/** A layout + repo with env-pinned id, initialised — the patch-verb baseline. */
function initialised(opts: { base?: string } = {}): {
  io: StatusIo;
  clock: { value: string };
  file: string;
  layout: Layout;
  repo: string;
} {
  const layout = makeLayout();
  const repo = makeLocalRepo(layout.base);
  const { io, clock } = makeIo({
    cwd: repo,
    layout,
    env: { SUPERSET_WORKSPACE_ID: 'ws-test' },
  });
  const argv = ['init', '--item', 'itm_1', '--slug', 'feat'];
  if (opts.base !== undefined) argv.push('--base', opts.base);
  statusOp(io, argv);
  return { io, clock, file: join(layout.wsDir, 'ws-test.json'), layout, repo };
}

// ── workspace id resolution ───────────────────────────────────────────────────

describe('workspace id resolution', () => {
  test('tier 1: SUPERSET_WORKSPACE_ID wins and nothing external runs', () => {
    const layout = makeLayout();
    const { io, calls } = makeIo({
      cwd: layout.base,
      layout,
      env: { SUPERSET_WORKSPACE_ID: 'ws-env-1' },
    });
    const result = statusOp(io, ['path']);
    expect(result.stdout).toEqual([join(layout.wsDir, 'ws-env-1.json')]);
    expect(result.stderr).toEqual([]);
    expect(calls).toEqual([]);
    // status.sh mkdir -p'd the inbox before dispatching any verb.
    expect(existsSync(layout.wsDir)).toBe(true);
  });

  test('tier 2: the workspace whose worktreePath is this repo toplevel', () => {
    const layout = makeLayout();
    const repo = makeLocalRepo(layout.base);
    const { io } = makeIo({
      cwd: repo,
      layout,
      supersetRows: [
        { id: 'ws-other', worktreePath: '/somewhere/else' },
        { id: 'ws-live', worktreePath: toplevel(repo) },
      ],
    });
    const result = statusOp(io, ['path']);
    expect(result.stdout).toEqual([join(layout.wsDir, 'ws-live.json')]);
    expect(result.stderr).toEqual([]);
  });

  test('tier 2 keeps only the first match, like head -1', () => {
    const layout = makeLayout();
    const repo = makeLocalRepo(layout.base);
    const top = toplevel(repo);
    const { io } = makeIo({
      cwd: repo,
      layout,
      supersetRows: [
        { id: 'ws-first', worktreePath: top },
        { id: 'ws-second', worktreePath: top },
      ],
    });
    expect(statusOp(io, ['path']).stdout).toEqual([join(layout.wsDir, 'ws-first.json')]);
  });

  test('tier 2 aborts at a non-object row, losing the match after it', () => {
    // jq errored mid-stream on the scalar and printed nothing, so resolution
    // fell to the branch key even though a matching row followed.
    const layout = makeLayout();
    const repo = makeLocalRepo(layout.base);
    const { io } = makeIo({
      cwd: repo,
      layout,
      supersetRows: ['garbage', { id: 'ws-live', worktreePath: toplevel(repo) }],
    });
    const result = statusOp(io, ['path']);
    expect(result.stdout).toEqual([join(layout.wsDir, 'branch--main.json')]);
    expect(result.stderr).toEqual(['board status: no workspace id; keying by branch (branch--main)']);
  });

  test('tier 3: branch key with slashes mapped to dashes, note on stderr', () => {
    const layout = makeLayout();
    const repo = makeLocalRepo(layout.base);
    run('git', ['-C', repo, 'checkout', '-b', 'dev/foo']);
    const { io } = makeIo({ cwd: repo, layout });
    const result = statusOp(io, ['path']);
    expect(result.stdout).toEqual([join(layout.wsDir, 'branch--dev-foo.json')]);
    expect(result.stderr).toEqual([
      'board status: no workspace id; keying by branch (branch--dev-foo)',
    ]);
  });

  test('tier 3 outside a repository keys by the unknown branch', () => {
    const layout = makeLayout();
    const bare = join(layout.base, 'not-a-repo');
    mkdirSync(bare, { recursive: true });
    const { io } = makeIo({ cwd: bare, layout });
    const result = statusOp(io, ['path']);
    expect(result.stdout).toEqual([join(layout.wsDir, 'branch--unknown.json')]);
    expect(result.stderr).toEqual([
      'board status: no workspace id; keying by branch (branch--unknown)',
    ]);
  });
});

// ── init ──────────────────────────────────────────────────────────────────────

describe('init', () => {
  test('writes the exact field set, in order, compact, newline-terminated', () => {
    const layout = makeLayout();
    const { clone } = makeCloneRepo(layout.base);
    run('git', ['-C', clone, 'checkout', '-b', 'dev/feat']);
    const { io } = makeIo({ cwd: clone, layout, env: { SUPERSET_WORKSPACE_ID: 'ws-9' } });

    const file = join(layout.wsDir, 'ws-9.json');
    const result = statusOp(io, ['init', '--item', 'itm_7', '--slug', 'eng-142-data-table']);
    expect(result.stdout).toEqual([`initialised ${file}`]);

    const doc = readStatus(file);
    expect(doc).toEqual({
      version: 1,
      workspaceId: 'ws-9',
      itemId: 'itm_7',
      slug: 'eng-142-data-table',
      branch: 'dev/feat',
      baseBranch: 'main', // origin/HEAD, stripped of origin/
      worktreePath: toplevel(clone),
      state: 'building',
      phase: 'orienting',
      updatedAt: NOW_ISO,
      summary: null,
      verification: {},
      diffstat: null,
      risks: [],
      questions: [],
      blockedReason: null,
      pr: { number: null, url: null },
      needsOperator: false,
    });
    // jq -nc's construction order and rendering: compact, one trailing newline.
    expect(Object.keys(doc)).toEqual([
      'version',
      'workspaceId',
      'itemId',
      'slug',
      'branch',
      'baseBranch',
      'worktreePath',
      'state',
      'phase',
      'updatedAt',
      'summary',
      'verification',
      'diffstat',
      'risks',
      'questions',
      'blockedReason',
      'pr',
      'needsOperator',
    ]);
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(doc) + '\n');
  });

  test('--base overrides origin/HEAD detection', () => {
    const layout = makeLayout();
    const { clone } = makeCloneRepo(layout.base);
    const { io } = makeIo({ cwd: clone, layout, env: { SUPERSET_WORKSPACE_ID: 'ws-b' } });
    statusOp(io, ['init', '--base', 'release/2.0']);
    expect(readStatus(join(layout.wsDir, 'ws-b.json'))['baseBranch']).toBe('release/2.0');
  });

  test('outside a repository: unknown branch, cwd worktree, main base, null ids', () => {
    const layout = makeLayout();
    const bare = join(layout.base, 'plain');
    mkdirSync(bare, { recursive: true });
    const { io } = makeIo({ cwd: bare, layout, env: { SUPERSET_WORKSPACE_ID: 'ws-p' } });
    statusOp(io, ['init']);
    const doc = readStatus(join(layout.wsDir, 'ws-p.json'));
    expect(doc['itemId']).toBeNull();
    expect(doc['slug']).toBeNull();
    expect(doc['branch']).toBe('unknown');
    expect(doc['baseBranch']).toBe('main');
    expect(doc['worktreePath']).toBe(bare);
  });

  test('refuses an unknown argument', () => {
    const layout = makeLayout();
    const { io } = makeIo({ cwd: layout.base, layout, env: { SUPERSET_WORKSPACE_ID: 'w' } });
    expect(() => statusOp(io, ['init', '--bogus', 'x'])).toThrow('unknown argument: --bogus');
  });
});

// ── patch verbs ───────────────────────────────────────────────────────────────

describe('patch verbs', () => {
  test('every patch verb hard-errors without a status file', () => {
    const layout = makeLayout();
    const { io } = makeIo({ cwd: layout.base, layout, env: { SUPERSET_WORKSPACE_ID: 'ws-n' } });
    const verbs: string[][] = [
      ['phase', 'working'],
      ['state', 'building'],
      ['verify', 'unit=pass'],
      ['risk', 'r'],
      ['ask', 'q?'],
      ['gate', 'done'],
      ['pr', '1', 'https://x/1'],
      ['clear-questions'],
      ['set', '{}'],
    ];
    for (const argv of verbs) {
      expect(() => statusOp(io, argv)).toThrow(
        'no status file yet — run: board status init --item <id> --slug <slug>',
      );
    }
  });

  test('phase rewrites phase and stamps updatedAt; pretty after the patch', () => {
    const { io, clock, file } = initialised();
    clock.value = LATER_ISO;
    statusOp(io, ['phase', 'implementing the sticky header']);
    const doc = readStatus(file);
    expect(doc['phase']).toBe('implementing the sticky header');
    expect(doc['updatedAt']).toBe(LATER_ISO);
    // patch wrote through jq's default rendering: two-space pretty + newline.
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(doc, null, 2) + '\n');
  });

  test('phase needs text', () => {
    const { io } = initialised();
    expect(() => statusOp(io, ['phase'])).toThrow('phase needs text');
  });

  test('state validates, derives needsOperator, and takes an optional note', () => {
    const { io, file } = initialised();
    const expected: Array<[string, boolean]> = [
      ['building', false],
      ['awaiting-approval', true],
      ['pr-open', false],
      ['fixing', false],
      ['blocked', true],
      ['merged', false],
    ];
    for (const [state, needsOperator] of expected) {
      statusOp(io, ['state', state]);
      const doc = readStatus(file);
      expect(doc['state']).toBe(state);
      expect(doc['needsOperator']).toBe(needsOperator);
    }
    statusOp(io, ['state', 'fixing', 'rebased past #355, force-pushed, CI green']);
    expect(readStatus(file)['phase']).toBe('rebased past #355, force-pushed, CI green');
  });

  test('unknown state is refused with the file untouched', () => {
    const { io, clock, file } = initialised();
    const before = readFileSync(file, 'utf8');
    clock.value = LATER_ISO;
    expect(() => statusOp(io, ['state', 'shipping'])).toThrow('unknown state: shipping');
    expect(() => statusOp(io, ['state'])).toThrow('state needs a value');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  test('verify splits at the first = and keeps a bare word whole', () => {
    const { io, file } = initialised();
    statusOp(io, ['verify', 'unit=pass — 3 tests', 'typecheck=a=b', 'smoke']);
    expect(readStatus(file)['verification']).toEqual({
      unit: 'pass — 3 tests',
      typecheck: 'a=b',
      smoke: 'smoke',
    });
    expect(() => statusOp(io, ['verify'])).toThrow('verify needs key=value pairs');
  });

  test('risk appends in order', () => {
    const { io, file } = initialised();
    statusOp(io, ['risk', 'sticky offsets measured against the content box']);
    statusOp(io, ['risk', 'check Safari']);
    expect(readStatus(file)['risks']).toEqual([
      'sticky offsets measured against the content box',
      'check Safari',
    ]);
    expect(() => statusOp(io, ['risk'])).toThrow('risk needs text');
  });

  test('ask blocks, records the question, and prints the contract line', () => {
    const { io, file } = initialised();
    const result = statusOp(io, ['ask', 'which asset set replaces the placeholders?']);
    expect(result.stdout).toEqual([
      'blocked, and the orchestrator has been told. Stop working and wait.',
    ]);
    const doc = readStatus(file);
    expect(doc['questions']).toEqual(['which asset set replaces the placeholders?']);
    expect(doc['state']).toBe('blocked');
    expect(doc['blockedReason']).toBe('which asset set replaces the placeholders?');
    expect(doc['needsOperator']).toBe(true);
    expect(() => statusOp(io, ['ask'])).toThrow('ask needs a question');
  });

  test('clear-questions resets the ask fields but not the state', () => {
    const { io, file } = initialised();
    statusOp(io, ['ask', 'q?']);
    statusOp(io, ['clear-questions']);
    const doc = readStatus(file);
    expect(doc['questions']).toEqual([]);
    expect(doc['blockedReason']).toBeNull();
    expect(doc['needsOperator']).toBe(false);
    // The answer arrives via clear-questions; leaving blocked is state's job.
    expect(doc['state']).toBe('blocked');
  });

  test('gate sets the approval fields and prints the contract line', () => {
    const { io, file } = initialised();
    const result = statusOp(io, ['gate', 'Denser rows + per-row timing; 6 files, tests added.']);
    expect(result.stdout).toEqual([
      'gated for approval. Do not push and do not open a PR until told to.',
    ]);
    const doc = readStatus(file);
    expect(doc['state']).toBe('awaiting-approval');
    expect(doc['summary']).toBe('Denser rows + per-row timing; 6 files, tests added.');
    expect(doc['phase']).toBe('self-review complete');
    expect(doc['needsOperator']).toBe(true);
    // A clean just-initialised branch: the stat exists and is all zeroes.
    expect(doc['diffstat']).toEqual({ files: 0, insertions: 0, deletions: 0 });
    expect(() => statusOp(io, ['gate'])).toThrow('gate needs a one-or-two-line summary');
  });

  test('pr opens: number+url, needsOperator off, awaiting review', () => {
    const { io, file } = initialised();
    statusOp(io, ['pr', '441', 'https://github.com/acme/website/pull/441']);
    const doc = readStatus(file);
    expect(doc['state']).toBe('pr-open');
    expect(doc['pr']).toEqual({ number: 441, url: 'https://github.com/acme/website/pull/441' });
    expect(doc['needsOperator']).toBe(false);
    expect(doc['phase']).toBe('awaiting review');
    expect(doc['diffstat']).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });

  test('pr refuses a non-number and missing arguments, file untouched', () => {
    const { io, file } = initialised();
    const before = readFileSync(file, 'utf8');
    expect(() => statusOp(io, ['pr', 'abc', 'https://x/1'])).toThrow(
      "cannot parse 'abc' as a number",
    );
    expect(() => statusOp(io, ['pr', '441'])).toThrow('pr needs <number> <url>');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  test('set merges raw JSON shallowly and the stamp wins over its updatedAt', () => {
    const { io, clock, file } = initialised();
    clock.value = LATER_ISO;
    statusOp(io, ['set', '{"lastAgentSessionId":"sess-1","phase":"pushed","updatedAt":"1999"}']);
    const doc = readStatus(file);
    expect(doc['lastAgentSessionId']).toBe('sess-1');
    expect(doc['phase']).toBe('pushed');
    // `($filter) | .updatedAt = $_at` stamped after the merge, so it wins.
    expect(doc['updatedAt']).toBe(LATER_ISO);
  });

  test('set null is a stamped no-op; non-objects and non-JSON are refused', () => {
    const { io, clock, file } = initialised();
    clock.value = LATER_ISO;
    statusOp(io, ['set', 'null']); // jq's `. + null` is the object itself
    expect(readStatus(file)['updatedAt']).toBe(LATER_ISO);
    expect(() => statusOp(io, ['set', '[1]'])).toThrow('set needs a JSON object, not array');
    expect(() => statusOp(io, ['set', 'not json'])).toThrow('invalid JSON passed to set');
    expect(() => statusOp(io, ['set'])).toThrow('set needs a JSON object');
  });
});

// ── show / path / dispatch ────────────────────────────────────────────────────

describe('show, path and dispatch', () => {
  test('show pretty-prints the file, and is the default verb', () => {
    const { io, file } = initialised();
    const doc = readStatus(file);
    expect(statusOp(io, ['show']).stdout).toEqual([JSON.stringify(doc, null, 2)]);
    expect(statusOp(io, []).stdout).toEqual([JSON.stringify(doc, null, 2)]);
  });

  test('show without a file reports the path instead of dying', () => {
    const layout = makeLayout();
    const { io } = makeIo({ cwd: layout.base, layout, env: { SUPERSET_WORKSPACE_ID: 'ws-s' } });
    expect(statusOp(io, ['show']).stdout).toEqual([
      `no status file at ${join(layout.wsDir, 'ws-s.json')}`,
    ]);
  });

  test('unknown command is refused', () => {
    const layout = makeLayout();
    const { io } = makeIo({ cwd: layout.base, layout, env: { SUPERSET_WORKSPACE_ID: 'w' } });
    expect(() => statusOp(io, ['frobnicate'])).toThrow('unknown command: frobnicate');
  });
});

// ── diffstat ──────────────────────────────────────────────────────────────────

describe('diffstat', () => {
  test('prefers origin/<base> over a drifted local base', () => {
    const layout = makeLayout();
    const { clone } = makeCloneRepo(layout.base);
    run('git', ['-C', clone, 'checkout', '-b', 'feature']);
    writeFileSync(join(clone, 'table.ts'), 'one\ntwo\nthree\n');
    run('git', ['-C', clone, 'add', '.']);
    run('git', ['-C', clone, 'commit', '-m', 'add table']);
    // Local main absorbs the feature (someone merged); origin/main has not.
    // Measured against local main the change vanishes — against origin/main,
    // the truth: one file, three insertions.
    run('git', ['-C', clone, 'branch', '-f', 'main', 'feature']);
    const { io } = makeIo({ cwd: clone, layout, env: { SUPERSET_WORKSPACE_ID: 'ws-d1' } });
    statusOp(io, ['init', '--item', 'itm_1', '--slug', 'feat']);
    statusOp(io, ['gate', 'summary']);
    expect(readStatus(join(layout.wsDir, 'ws-d1.json'))['diffstat']).toEqual({
      files: 1,
      insertions: 3,
      deletions: 0,
    });
  });

  test('falls back to the local base when origin/<base> is missing', () => {
    const layout = makeLayout();
    const repo = makeLocalRepo(layout.base);
    run('git', ['-C', repo, 'checkout', '-b', 'feature']);
    writeFileSync(join(repo, 'two-lines.ts'), 'a\nb\n');
    run('git', ['-C', repo, 'add', '.']);
    run('git', ['-C', repo, 'commit', '-m', 'add file']);
    const { io } = makeIo({ cwd: repo, layout, env: { SUPERSET_WORKSPACE_ID: 'ws-d2' } });
    statusOp(io, ['init', '--base', 'main']);
    statusOp(io, ['pr', '12', 'https://x/12']);
    expect(readStatus(join(layout.wsDir, 'ws-d2.json'))['diffstat']).toEqual({
      files: 1,
      insertions: 2,
      deletions: 0,
    });
  });

  test('falls back to bare HEAD when the base verifies nowhere', () => {
    const layout = makeLayout();
    const repo = makeLocalRepo(layout.base);
    const { io } = makeIo({ cwd: repo, layout, env: { SUPERSET_WORKSPACE_ID: 'ws-d3' } });
    statusOp(io, ['init', '--base', 'ghost']);
    // `git diff --numstat HEAD` sees the uncommitted modification.
    writeFileSync(join(repo, 'README.md'), 'hello\nmore\nlines\n');
    statusOp(io, ['gate', 'summary']);
    expect(readStatus(join(layout.wsDir, 'ws-d3.json'))['diffstat']).toEqual({
      files: 1,
      insertions: 2,
      deletions: 0,
    });
  });

  test('binary "-" rows count as files and never NaN the sums', () => {
    const layout = makeLayout();
    const repo = makeLocalRepo(layout.base);
    run('git', ['-C', repo, 'checkout', '-b', 'feature']);
    writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    writeFileSync(join(repo, 'text.ts'), 'a\nb\nc\n');
    run('git', ['-C', repo, 'add', '.']);
    run('git', ['-C', repo, 'commit', '-m', 'binary + text']);
    const { io } = makeIo({ cwd: repo, layout, env: { SUPERSET_WORKSPACE_ID: 'ws-d4' } });
    statusOp(io, ['init', '--base', 'main']);
    statusOp(io, ['gate', 'summary']);
    const ds = readStatus(join(layout.wsDir, 'ws-d4.json'))['diffstat'] as Record<string, number>;
    expect(ds).toEqual({ files: 2, insertions: 3, deletions: 0 });
    for (const key of ['files', 'insertions', 'deletions']) {
      expect(Number.isInteger(ds[key])).toBe(true);
    }
  });
});

// ── observe ───────────────────────────────────────────────────────────────────

describe('stdin text (-)', () => {
  // The EDR hazard: a ~1KB argv element gets a node process SIGKILLed on at
  // least one real machine. "-" reads the text from stdin instead; the pipe is
  // invisible to argv heuristics. The long value itself flows through the same
  // seam here; the fd-0 read is exercised end-to-end by a real spawn below.
  test('a 2000-char gate summary lands intact', () => {
    const { io, file } = initialised({});
    const long = 'y'.repeat(2000);
    const result = statusOp(io, ['gate', long]);
    expect(result.stdout[0]).toContain('gated for approval');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    expect(doc.summary).toBe(long);
    expect(doc.state).toBe('awaiting-approval');
  });

  test('gate - reads the summary from stdin through a real spawn', () => {
    const { file, layout, repo } = initialised({});
    const spawned = spawnSync('node', [join(process.cwd(), 'dist', 'main.js'), 'status', 'gate', '-'], {
      cwd: repo,
      env: { ...process.env, SUPERSET_ORCH_ROOT: layout.orchRoot, SUPERSET_WORKSPACE_ID: 'ws-test' },
      input: 'stdin summary line',
      encoding: 'utf8',
    });
    expect(spawned.status).toBe(0);
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    expect(doc.summary).toBe('stdin summary line');
  });
});

describe('observe', () => {
  /** io whose git always fails, over an otherwise normal stub. */
  function withoutGit(io: StatusIo): StatusIo {
    return {
      ...io,
      exec: (cmd, args, options) =>
        cmd === 'git'
          ? { status: 128, stdout: '', stderr: 'git: not found' }
          : io.exec(cmd, args, options),
    };
  }

  test('adds observedAt + git to a fresh init and leaves updatedAt byte-identical', () => {
    const { io, clock, file, repo } = initialised();
    const before = readStatus(file);
    clock.value = LATER_ISO;

    const result = statusOp(io, ['observe']);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual(['observed ws-test']); // id under 8 chars, whole

    const doc = readStatus(file);
    // The ONLY additions are observedAt and git; every model-written field —
    // updatedAt above all — is byte-identical. A bumped updatedAt would make a
    // stale "fixing" permanently win reconcile's agentFresh rule.
    const { observedAt, git, ...rest } = doc;
    expect(rest).toEqual(before);
    expect(doc['updatedAt']).toBe(NOW_ISO);
    expect(observedAt).toBe(LATER_ISO);

    const headSha = run('git', ['-C', repo, 'rev-parse', '--short', 'HEAD']).trim();
    const committedAt = new Date(run('git', ['-C', repo, 'log', '-1', '--format=%cI']).trim())
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
    expect(git).toEqual({
      branch: 'main',
      dirty: 0,
      ahead: null, // no upstream: unknowable, not zero
      head: headSha,
      headCommittedAt: committedAt,
    });
  });

  test('counts dirty files and reports ahead against a real upstream', () => {
    const layout = makeLayout();
    const { clone } = makeCloneRepo(layout.base);
    // One commit past origin/main, plus two uncommitted files (one untracked).
    writeFileSync(join(clone, 'feature.ts'), 'a\n');
    run('git', ['-C', clone, 'add', '.']);
    run('git', ['-C', clone, 'commit', '-m', 'feature']);
    writeFileSync(join(clone, 'README.md'), 'hello\nedited\n');
    writeFileSync(join(clone, 'scratch.txt'), 'wip\n');
    const { io } = makeIo({ cwd: clone, layout, env: { SUPERSET_WORKSPACE_ID: 'ws-observe-1' } });
    statusOp(io, ['init', '--item', 'itm_1', '--slug', 'feat']);
    statusOp(io, ['observe', '--quiet']);

    const git = readStatus(join(layout.wsDir, 'ws-observe-1.json'))['git'] as Record<
      string,
      unknown
    >;
    expect(git['branch']).toBe('main');
    expect(git['dirty']).toBe(2);
    expect(git['ahead']).toBe(1);
    expect(typeof git['head']).toBe('string');
  });

  test('--quiet suppresses the observed note', () => {
    const { io } = initialised();
    const result = statusOp(io, ['observe', '--quiet']);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([]);
  });

  test('no status file: silent success, nothing written', () => {
    const layout = makeLayout();
    const repo = makeLocalRepo(layout.base);
    const { io } = makeIo({ cwd: repo, layout, env: { SUPERSET_WORKSPACE_ID: 'ws-none' } });
    const result = statusOp(io, ['observe']);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([]);
    expect(existsSync(join(layout.wsDir, 'ws-none.json'))).toBe(false);
  });

  test('git absent: every git field null, observedAt still written', () => {
    const { io, clock, file } = initialised();
    clock.value = LATER_ISO;
    const result = statusOp(withoutGit(io), ['observe']);
    expect(result.stderr).toEqual(['observed ws-test']);
    const doc = readStatus(file);
    expect(doc['observedAt']).toBe(LATER_ISO);
    expect(doc['git']).toEqual({
      branch: null,
      dirty: null,
      ahead: null,
      head: null,
      headCommittedAt: null,
    });
    expect(doc['updatedAt']).toBe(NOW_ISO);
  });

  test('a later phase write preserves the observed block', () => {
    const { io, clock, file } = initialised();
    statusOp(io, ['observe', '--quiet']);
    const observed = readStatus(file);
    clock.value = LATER_ISO;
    statusOp(io, ['phase', 'pushing']);
    const doc = readStatus(file);
    expect(doc['phase']).toBe('pushing');
    expect(doc['updatedAt']).toBe(LATER_ISO);
    expect(doc['observedAt']).toBe(observed['observedAt']);
    expect(doc['git']).toEqual(observed['git']);
  });

  test('wrong branch: the observation is dropped, not recorded', () => {
    // The agent checked out another branch to compare and the turn ended. An
    // observation of the wrong branch is worse than none: reconcile would
    // read main's clean-and-pushed as proof the item's work landed.
    const { io, clock, file, repo } = initialised();
    run('git', ['-C', repo, 'checkout', '-b', 'elsewhere']);
    clock.value = LATER_ISO;
    const result = statusOp(io, ['observe']);
    expect(result.stderr).toEqual([]); // no "observed" trace: nothing was written
    const doc = readStatus(file);
    expect(doc['observedAt']).toBeUndefined();
    expect(doc['git']).toBeUndefined();
  });

  test('wrong worktree: a nested session in another repo writes nothing', () => {
    // SUPERSET_WORKSPACE_ID is inherited by every process started inside the
    // workspace, so a session launched in a DIFFERENT repo passes guards 1
    // and 2 — its git facts must never land in this workspace's file.
    const { io, file, layout } = initialised();
    const other = makeLocalRepo(layout.base, 'other-repo');
    const nested = { ...io, cwd: () => other, exec: makeIo({ cwd: other, layout, env: { SUPERSET_WORKSPACE_ID: 'ws-test' } }).io.exec };
    const result = statusOp(nested, ['observe']);
    expect(result.stderr).toEqual([]);
    const doc = readStatus(file);
    expect(doc['observedAt']).toBeUndefined();
    expect(doc['git']).toBeUndefined();
  });

  test('a held lock drops the observation instead of racing the writer', () => {
    const { io, file } = initialised();
    writeFileSync(`${file}.lock`, '');
    try {
      const result = statusOp(io, ['observe']);
      expect(result.stderr).toEqual([]);
      expect(readStatus(file)['observedAt']).toBeUndefined();
    } finally {
      rmSync(`${file}.lock`, { force: true });
    }
  });

  test('a held lock never drops a model write — patch waits, then proceeds', () => {
    // The inverse discipline: an observation is safe to skip, a stall signal
    // is not. A lock nobody releases costs the patch a bounded wait, never
    // the write.
    const { io, file } = initialised();
    writeFileSync(`${file}.lock`, '');
    try {
      statusOp(io, ['state', 'blocked']);
      expect(readStatus(file)['state']).toBe('blocked');
    } finally {
      rmSync(`${file}.lock`, { force: true });
    }
  });
});
