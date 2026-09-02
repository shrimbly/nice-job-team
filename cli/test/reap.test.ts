// reap and autoreap over stubbed superset/gh io and REAL temp git repos. The
// git worktrees are built fresh per test (a bare origin, a clone, a linked
// worktree), so the dirty/unpushed/primary-checkout guards run against the
// exact commands reap ships — nothing here ever touches the live superset CLI,
// gh, ~/.superset or ~/.claude, and a --dry-run must never spawn a delete.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { autoreap, reap } from '../src/ops/reap.js';
import type { ReapDeps } from '../src/ops/reap.js';
import type { BoardConfigFile, ExecResult, OrchRoot, PollIo } from '../src/types.js';

const NOW_ISO = '2026-09-02T12:00:00Z';
const NOW_MS = Date.parse(NOW_ISO);

// ── temp roots ────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-reap-'));
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

interface Layout {
  base: string;
  home: string;
  orch: OrchRoot;
  boardDir: string;
}

/** The orchestrator layout alone — for tests that never reach a worktree. */
function makeLayout(): Layout {
  const base = tempDir();
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const orchRoot = join(base, 'orch');
  const orch: OrchRoot = {
    root: orchRoot,
    configPath: join(orchRoot, 'config.json'),
    workspacesDir: join(orchRoot, 'workspaces'),
  };
  mkdirSync(orch.workspacesDir, { recursive: true });
  const boardDir = join(orchRoot, 'p', 'proj');
  mkdirSync(boardDir, { recursive: true });
  return { base, home, orch, boardDir };
}

interface Repo {
  origin: string;
  clone: string;
  /** A linked worktree on branch dev/feature, nested the way superset nests. */
  wt: string;
}

/** A bare origin, a clone with one pushed commit on main, a linked worktree. */
function makeRepo(layout: Layout, opts: { withUpstream?: boolean } = {}): Repo {
  const origin = join(layout.base, 'origin.git');
  const clone = join(layout.base, 'clone');
  run('git', ['init', '--bare', '-b', 'main', origin]);
  run('git', ['clone', origin, clone]);
  writeFileSync(join(clone, 'README.md'), 'hello\n');
  run('git', ['-C', clone, 'add', 'README.md']);
  run('git', ['-C', clone, 'commit', '-m', 'init']);
  run('git', ['-C', clone, 'push', '-u', 'origin', 'main']);
  // origin/HEAD, which the abandon-mode local-only check compares against.
  run('git', ['-C', clone, 'remote', 'set-head', 'origin', 'main']);
  const wt = join(layout.home, '.superset', 'worktrees', 'proj', 'dev', 'feature');
  mkdirSync(dirname(wt), { recursive: true });
  run('git', ['-C', clone, 'worktree', 'add', wt, '-b', 'dev/feature']);
  if (opts.withUpstream === true) {
    run('git', ['-C', wt, 'push', '-u', 'origin', 'dev/feature']);
  }
  return { origin, clone, wt };
}

// ── io stub: superset and gh faked, git passed through for real ───────────────

function ok(stdout: string): ExecResult {
  return { status: 0, stdout, stderr: '' };
}
const FAIL: ExecResult = { status: 1, stdout: '', stderr: 'stubbed failure' };

interface World {
  authed?: boolean;
  /** workspace id → the `workspaces get` record; absent id fails the call. */
  workspaces?: Record<string, unknown>;
  deleted?: string[];
  /** The real teardown removes the worktree; the stub mimics that. */
  onDelete?: () => void;
  /** PR number (as the argv string) → `gh pr view` payload. */
  prViews?: Record<string, unknown>;
  /** head branch → rows for `gh pr list --head <head>`. */
  listByHead?: Record<string, unknown[]>;
}

interface Call {
  cmd: string;
  args: string[];
}

function makeIo(
  world: World,
  home: string,
  env: NodeJS.ProcessEnv = {},
): { io: PollIo; calls: Call[]; warnings: string[] } {
  const calls: Call[] = [];
  const warnings: string[] = [];
  const io: PollIo = {
    exec(cmd, args) {
      calls.push({ cmd, args });
      if (cmd === 'git') {
        const result = spawnSync('git', args, { encoding: 'utf8', env: GIT_ENV });
        return {
          status: result.status ?? 1,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
        };
      }
      if (cmd === 'superset' || cmd.endsWith('/superset')) {
        if (args.join(' ') === 'auth whoami --json') {
          return world.authed === false ? FAIL : ok('{"user":"w"}');
        }
        if (args[0] === 'workspaces' && args[1] === 'get') {
          const record = world.workspaces?.[args[2]!];
          return record === undefined ? FAIL : ok(JSON.stringify(record));
        }
        if (args[0] === 'workspaces' && args[1] === 'delete') {
          (world.deleted ??= []).push(args[2]!);
          world.onDelete?.();
          return ok('{}');
        }
        return FAIL;
      }
      if (cmd === 'gh') {
        if (args[0] === 'pr' && args[1] === 'view') {
          const payload = world.prViews?.[args[2]!];
          return payload === undefined ? FAIL : ok(JSON.stringify(payload));
        }
        if (args[0] === 'pr' && args[1] === 'list') {
          const head = args[args.indexOf('--head') + 1]!;
          return ok(JSON.stringify(world.listByHead?.[head] ?? []));
        }
        return FAIL;
      }
      return FAIL;
    },
    now: () => NOW_ISO,
    nowMs: () => NOW_MS,
    homeDir: () => home,
    env,
    warn: (message) => warnings.push(message),
  };
  return { io, calls, warnings };
}

// ── board fixtures ────────────────────────────────────────────────────────────

function writeBoardFile(boardDir: string, items: unknown[]): void {
  writeFileSync(
    join(boardDir, 'board.json'),
    JSON.stringify({ version: 1, updatedAt: NOW_ISO, items }, null, 2) + '\n',
  );
}

function readBoard(boardDir: string): { items: Record<string, unknown>[] } {
  return JSON.parse(readFileSync(join(boardDir, 'board.json'), 'utf8')) as {
    items: Record<string, unknown>[];
  };
}

function itemFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'itm_1',
    slug: 'feat',
    title: 'Feature',
    state: 'merged',
    workspaceId: 'ws-1',
    repo: 'o/r',
    branch: 'dev/feature',
    pr: { number: 12, url: 'https://x/12' },
    ...overrides,
  };
}

const BLOCKED_ITEM = {
  id: 'itm_9',
  slug: 'next',
  title: 'Next',
  state: 'proposed',
  blockedBy: 'itm_1',
};

function makeDeps(
  layout: Layout,
  world: World,
  config: BoardConfigFile,
  env: NodeJS.ProcessEnv = {},
): { deps: ReapDeps; calls: Call[] } {
  const { io, calls } = makeIo(world, layout.home, env);
  return {
    deps: { io, orch: layout.orch, boardDir: layout.boardDir, config, label: 'proj' },
    calls,
  };
}

function mergedWorld(repo: Repo): World {
  return {
    workspaces: { 'ws-1': { id: 'ws-1', worktreePath: repo.wt, branch: 'dev/feature' } },
    prViews: {
      '12': {
        state: 'MERGED',
        mergedAt: '2026-09-01T00:00:00Z',
        url: 'https://x/12',
        headRefName: 'dev/feature',
      },
    },
    deleted: [],
    onDelete: () => rmSync(repo.wt, { recursive: true, force: true }),
  };
}

function cloneConfig(repo: Repo): BoardConfigFile {
  return { repos: [{ name: 'o/r', localPath: repo.clone }] };
}

const deleteCalls = (calls: Call[]): Call[] =>
  calls.filter((c) => c.args[0] === 'workspaces' && c.args[1] === 'delete');

// ── reap ──────────────────────────────────────────────────────────────────────

describe('reap', () => {
  test('--discard-changes without --abandon is refused before anything runs', async () => {
    const layout = makeLayout();
    const { deps, calls } = makeDeps(layout, {}, {});
    await expect(reap(deps, { item: 'itm_1', discardChanges: true })).rejects.toThrow(
      '--discard-changes only makes sense with --abandon',
    );
    expect(calls).toEqual([]);
  });

  test('a missing item and a missing workspace die with the script texts', async () => {
    const layout = makeLayout();
    writeBoardFile(layout.boardDir, [itemFixture()]);
    const { deps } = makeDeps(layout, { workspaces: {} }, {});
    await expect(reap(deps, { item: 'itm_404' })).rejects.toThrow('no board item itm_404');
    await expect(reap(deps, { item: 'itm_1' })).rejects.toThrow(
      'workspace ws-1 not found on this host',
    );
    await expect(reap(deps, { workspace: 'ws-2' })).rejects.toThrow(
      'need --repo (or an item that records one)',
    );
    await expect(reap(deps, {})).rejects.toThrow('need --item or --workspace');
  });

  test('refuses when superset is not logged in', async () => {
    const layout = makeLayout();
    const { deps } = makeDeps(layout, { authed: false }, {});
    await expect(reap(deps, { workspace: 'ws-1', repo: 'o/r' })).rejects.toThrow(
      'not logged in — superset auth login',
    );
  });

  test('guard 0: refuses the primary checkout, verbatim', async () => {
    const layout = makeLayout();
    const repo = makeRepo(layout);
    writeBoardFile(layout.boardDir, [itemFixture()]);
    const world = mergedWorld(repo);
    // The workspace record points at the CLONE, where git-dir == git-common-dir.
    world.workspaces = { 'ws-1': { id: 'ws-1', worktreePath: repo.clone, branch: 'main' } };
    const { deps, calls } = makeDeps(layout, world, cloneConfig(repo));
    await expect(reap(deps, { item: 'itm_1' })).rejects.toThrow(
      `workspace ws-1 is the PRIMARY CHECKOUT at ${repo.clone}, not a linked worktree — deleting it would take the clone with it. Reap only linked worktrees.`,
    );
    expect(deleteCalls(calls)).toEqual([]);
  });

  test('guard 0: refuses to reap the workspace this session runs in', async () => {
    const layout = makeLayout();
    const repo = makeRepo(layout, { withUpstream: true });
    writeBoardFile(layout.boardDir, [itemFixture()]);
    const { deps } = makeDeps(layout, mergedWorld(repo), cloneConfig(repo), {
      SUPERSET_WORKSPACE_ID: 'ws-1',
    });
    await expect(reap(deps, { item: 'itm_1' })).rejects.toThrow(
      'workspace ws-1 is the one this session is running in — refusing to delete the ground under our feet',
    );
  });

  test('guard 1: an unmerged PR is refused with its state and url', async () => {
    const layout = makeLayout();
    const repo = makeRepo(layout, { withUpstream: true });
    writeBoardFile(layout.boardDir, [itemFixture()]);
    const world = mergedWorld(repo);
    world.prViews = { '12': { state: 'OPEN', url: 'https://x/12' } };
    const { deps, calls } = makeDeps(layout, world, cloneConfig(repo));
    await expect(reap(deps, { item: 'itm_1' })).rejects.toThrow(
      'PR #12 is OPEN, not MERGED — https://x/12',
    );
    expect(deleteCalls(calls)).toEqual([]);
  });

  test('guard 1: falls back to the branch lookup, and dies when nothing landed', async () => {
    const layout = makeLayout();
    const repo = makeRepo(layout, { withUpstream: true });
    writeBoardFile(layout.boardDir, [itemFixture({ pr: null })]);
    const world = mergedWorld(repo);
    world.listByHead = { 'dev/feature': [] };
    const { deps } = makeDeps(layout, world, cloneConfig(repo));
    await expect(reap(deps, { item: 'itm_1' })).rejects.toThrow(
      "no PR found for branch 'dev/feature' in o/r — nothing has landed, so nothing to reap. If the task was cancelled, use --abandon.",
    );

    // With a PR on the branch, the lookup feeds guard 1 and the dry-run passes.
    world.listByHead = { 'dev/feature': [{ number: 12 }] };
    const result = await reap(deps, { item: 'itm_1', dryRun: true });
    expect(result.stdout).toEqual([
      'would delete workspace ws-1 (dev/feature) — PR #12 merged, worktree clean',
    ]);
  });

  test('guard 2: a dirty worktree refuses', async () => {
    const layout = makeLayout();
    const repo = makeRepo(layout, { withUpstream: true });
    writeFileSync(join(repo.wt, 'junk.txt'), 'x\n');
    writeBoardFile(layout.boardDir, [itemFixture()]);
    const { deps, calls } = makeDeps(layout, mergedWorld(repo), cloneConfig(repo));
    await expect(reap(deps, { item: 'itm_1' })).rejects.toThrow(
      `1 uncommitted change(s) in ${repo.wt} — deleting the workspace would destroy them. Add --discard-changes if that is intended.`,
    );
    expect(deleteCalls(calls)).toEqual([]);
  });

  test('--abandon --discard-changes lists exactly what it drops, and a dry run deletes nothing', async () => {
    const layout = makeLayout();
    const repo = makeRepo(layout, { withUpstream: true });
    writeFileSync(join(repo.wt, 'junk.txt'), 'x\n');
    writeBoardFile(layout.boardDir, [itemFixture()]);
    const { deps, calls } = makeDeps(layout, mergedWorld(repo), cloneConfig(repo));
    const result = await reap(deps, {
      item: 'itm_1',
      abandon: true,
      discardChanges: true,
      dryRun: true,
    });
    expect(result.stderr).toEqual([
      'warn: --abandon: skipping the merged-PR check. This is cancelled work, not landed work.',
      `warn: --discard-changes: throwing away 1 uncommitted change(s) in ${repo.wt}:`,
      '         ?? junk.txt',
    ]);
    expect(result.stdout).toEqual([
      'would abandon workspace ws-1 (dev/feature) — cancelled work, DISCARDING 1 change(s)',
    ]);
    expect(deleteCalls(calls)).toEqual([]);
    expect(existsSync(repo.wt)).toBe(true);
    expect(readBoard(layout.boardDir).items[0]!['state']).toBe('merged');
  });

  test('guard 2: unpushed commits refuse', async () => {
    const layout = makeLayout();
    const repo = makeRepo(layout, { withUpstream: true });
    writeFileSync(join(repo.wt, 'new.txt'), 'x\n');
    run('git', ['-C', repo.wt, 'add', 'new.txt']);
    run('git', ['-C', repo.wt, 'commit', '-m', 'extra']);
    writeBoardFile(layout.boardDir, [itemFixture()]);
    const { deps, calls } = makeDeps(layout, mergedWorld(repo), cloneConfig(repo));
    await expect(reap(deps, { item: 'itm_1' })).rejects.toThrow(
      `1 unpushed commit(s) in ${repo.wt} — add --discard-changes if that is intended`,
    );
    expect(deleteCalls(calls)).toEqual([]);
  });

  test('guard 2: --abandon without an upstream refuses on local-only commits', async () => {
    const layout = makeLayout();
    const repo = makeRepo(layout); // no upstream — the branch was never pushed
    writeFileSync(join(repo.wt, 'new.txt'), 'x\n');
    run('git', ['-C', repo.wt, 'add', 'new.txt']);
    run('git', ['-C', repo.wt, 'commit', '-m', 'extra']);
    writeBoardFile(layout.boardDir, [itemFixture()]);
    const { deps, calls } = makeDeps(layout, mergedWorld(repo), cloneConfig(repo));
    await expect(reap(deps, { item: 'itm_1', abandon: true })).rejects.toThrow(
      `1 local commit(s) were never pushed and exist only in ${repo.wt} — add --discard-changes if losing them is intended`,
    );
    expect(deleteCalls(calls)).toEqual([]);
  });

  test('--abandon --discard-changes drops local-only commits, names them, keeps the unmerged branch', async () => {
    const layout = makeLayout();
    const repo = makeRepo(layout);
    writeFileSync(join(repo.wt, 'new.txt'), 'x\n');
    run('git', ['-C', repo.wt, 'add', 'new.txt']);
    run('git', ['-C', repo.wt, 'commit', '-m', 'extra']);
    writeBoardFile(layout.boardDir, [itemFixture({ pr: null }), BLOCKED_ITEM]);
    const { deps, calls } = makeDeps(layout, mergedWorld(repo), cloneConfig(repo));
    const result = await reap(deps, { item: 'itm_1', abandon: true, discardChanges: true });

    expect(result.stderr[0]).toBe(
      'warn: --abandon: skipping the merged-PR check. This is cancelled work, not landed work.',
    );
    expect(result.stderr[1]).toBe(
      `warn: --discard-changes: 1 local commit(s) exist nowhere else and will be lost:`,
    );
    expect(result.stderr[2]).toMatch(/^ {9}[0-9a-f]+ extra$/);
    expect(result.stderr[3]).toBe(
      'warn: kept local branch dev/feature (git says it is not fully merged — check by hand)',
    );
    expect(result.stdout).toEqual([
      'unblocked: itm_9 ',
      'abandoned itm_1 — cancelled work, workspace deleted, branch tidied',
    ]);
    expect(deleteCalls(calls).length).toBe(1);
    // The unmerged branch survives — its commit exists nowhere else now.
    expect(run('git', ['-C', repo.clone, 'branch', '--list', 'dev/feature'])).not.toBe('');
    const item = readBoard(layout.boardDir).items[0]!;
    expect(item['state']).toBe('abandoned');
    const history = item['history'] as Record<string, unknown>[];
    expect(history[history.length - 1]).toMatchObject({
      from: 'merged',
      to: 'abandoned',
      by: 'reap: --abandon',
    });
  });

  test('a stash warns and never blocks', async () => {
    const layout = makeLayout();
    const repo = makeRepo(layout, { withUpstream: true });
    writeFileSync(join(repo.wt, 'README.md'), 'stash me\n');
    run('git', ['-C', repo.wt, 'stash', 'push']);
    writeBoardFile(layout.boardDir, [itemFixture()]);
    const { deps } = makeDeps(layout, mergedWorld(repo), cloneConfig(repo));
    const result = await reap(deps, { item: 'itm_1' });
    expect(result.stderr[0]).toBe(
      'warn: 1 stash entr(ies) visible from this worktree — shared with the whole repo, and untouched by this delete:',
    );
    expect(result.stderr[1]).toMatch(/^ {9}stash@\{0\}:/);
    expect(result.stdout[result.stdout.length - 1]).toBe(
      'reaped itm_1 — PR #12 merged, workspace deleted, branch tidied',
    );
  });

  test('a merged dry-run reports and never spawns a delete', async () => {
    const layout = makeLayout();
    const repo = makeRepo(layout, { withUpstream: true });
    writeBoardFile(layout.boardDir, [itemFixture()]);
    const { deps, calls } = makeDeps(layout, mergedWorld(repo), cloneConfig(repo));
    const result = await reap(deps, { item: 'itm_1', dryRun: true });
    expect(result.stdout).toEqual([
      'would delete workspace ws-1 (dev/feature) — PR #12 merged, worktree clean',
    ]);
    expect(deleteCalls(calls)).toEqual([]);
    expect(existsSync(repo.wt)).toBe(true);
    expect(readBoard(layout.boardDir).items[0]!['state']).toBe('merged');
  });

  test('a clean merged reap deletes, prunes, tidies, closes, and unblocks', async () => {
    const layout = makeLayout();
    const repo = makeRepo(layout, { withUpstream: true });
    writeBoardFile(layout.boardDir, [itemFixture(), BLOCKED_ITEM]);
    writeFileSync(join(layout.orch.workspacesDir, 'ws-1.json'), '{"workspaceId":"ws-1"}\n');
    const world = mergedWorld(repo);
    const { deps } = makeDeps(layout, world, cloneConfig(repo));
    const result = await reap(deps, { item: 'itm_1' });

    expect(result.stdout).toEqual([
      'unblocked: itm_9 ',
      'reaped itm_1 — PR #12 merged, workspace deleted, branch tidied',
    ]);
    expect(result.stderr).toEqual([]);
    expect(world.deleted).toEqual(['ws-1']);
    // The empty parents a slashed branch leaves behind are pruned, bounded to
    // the worktrees root — which itself survives.
    const worktrees = join(layout.home, '.superset', 'worktrees');
    expect(existsSync(join(worktrees, 'proj'))).toBe(false);
    expect(existsSync(worktrees)).toBe(true);
    // The local branch is gone from the clone.
    expect(run('git', ['-C', repo.clone, 'branch', '--list', 'dev/feature'])).toBe('');
    // The item closed with reap's history line; the status file is gone.
    const item = readBoard(layout.boardDir).items[0]!;
    expect(item['state']).toBe('closed');
    const history = item['history'] as Record<string, unknown>[];
    expect(history[history.length - 1]).toMatchObject({ from: 'merged', to: 'closed', by: 'reap' });
    expect(existsSync(join(layout.orch.workspacesDir, 'ws-1.json'))).toBe(false);
    // log_event reaped, with the string-valued kv the shell wrote.
    const log = readFileSync(join(layout.boardDir, 'log.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(log[log.length - 1]!)).toMatchObject({
      event: 'reaped',
      itemId: 'itm_1',
      workspaceId: 'ws-1',
      branch: 'dev/feature',
      pr: '12',
      repo: 'o/r',
    });
  });

  test('a workspace with no worktree on disk warns and abandons dry with nothing to lose', async () => {
    const layout = makeLayout();
    const { deps } = makeDeps(
      layout,
      { workspaces: { 'ws-1': { id: 'ws-1', branch: 'b' } } },
      {},
    );
    const result = await reap(deps, {
      workspace: 'ws-1',
      repo: 'o/r',
      abandon: true,
      dryRun: true,
    });
    expect(result.stderr).toEqual([
      'warn: --abandon: skipping the merged-PR check. This is cancelled work, not landed work.',
      'warn: worktree path not on disk — skipping the dirty/unpushed checks',
    ]);
    expect(result.stdout).toEqual([
      'would abandon workspace ws-1 (b) — cancelled work, nothing to lose',
    ]);
  });
});

// ── autoreap ──────────────────────────────────────────────────────────────────

const GATED: BoardConfigFile = { gates: { autoReapOwnWorkspaces: true } };

function autoreapConfig(repo: Repo): BoardConfigFile {
  return { ...GATED, repos: [{ name: 'o/r', localPath: repo.clone }] };
}

describe('autoreap', () => {
  test('the gate defaults off, loudly — and silently under --quiet', async () => {
    const layout = makeLayout();
    writeBoardFile(layout.boardDir, [itemFixture()]);
    const { deps } = makeDeps(layout, {}, {});
    expect((await autoreap(deps, {})).stdout).toEqual([
      'auto-reap is off (gates.autoReapOwnWorkspaces)',
    ]);
    expect((await autoreap(deps, { quiet: true })).stdout).toEqual([]);
  });

  test('a missing board is fatal', async () => {
    const layout = makeLayout();
    const { deps } = makeDeps(layout, {}, GATED);
    await expect(autoreap(deps, {})).rejects.toThrow(
      `no board at ${join(layout.boardDir, 'board.json')}`,
    );
  });

  test('only orchestrator-created, workspace-holding, PR-carrying, non-terminal items are candidates', async () => {
    const layout = makeLayout();
    writeBoardFile(layout.boardDir, [
      itemFixture({ id: 'itm_1', slug: 'a' }), // not createdByOrchestrator
      itemFixture({ id: 'itm_2', slug: 'b', createdByOrchestrator: true, workspaceId: null }),
      itemFixture({ id: 'itm_3', slug: 'c', createdByOrchestrator: true, pr: null }),
      itemFixture({ id: 'itm_4', slug: 'd', createdByOrchestrator: true, state: 'abandoned' }),
    ]);
    const { deps, calls } = makeDeps(layout, {}, GATED);
    const result = await autoreap(deps, {});
    expect(result.stdout).toEqual(['auto-reap: 0 workspace(s) reaped']);
    expect(result.stderr).toEqual([]);
    expect(calls.filter((c) => c.cmd === 'gh')).toEqual([]);
  });

  test('an unparseable closedAt never reads as old', async () => {
    const layout = makeLayout();
    writeBoardFile(layout.boardDir, [itemFixture({ createdByOrchestrator: true, pr: { number: 7 } })]);
    const { deps, calls } = makeDeps(
      layout,
      {
        prViews: {
          '7': { state: 'CLOSED', closedAt: '2026-09-02 09:46:40', headRefName: 'dev/feature' },
        },
      },
      GATED,
    );
    const result = await autoreap(deps, {});
    expect(result.stdout).toEqual(['auto-reap: 0 workspace(s) reaped']);
    expect(result.stderr).toEqual([]);
    // The candidate never settled, so reap never ran — no superset traffic.
    expect(calls.filter((c) => c.cmd !== 'gh')).toEqual([]);
  });

  test('a closed PR inside the grace window waits', async () => {
    const layout = makeLayout();
    writeBoardFile(layout.boardDir, [itemFixture({ createdByOrchestrator: true, pr: { number: 7 } })]);
    const { deps, calls } = makeDeps(
      layout,
      {
        prViews: {
          '7': { state: 'CLOSED', closedAt: '2026-09-02T11:00:00Z', headRefName: 'dev/feature' },
        },
      },
      GATED,
    );
    const result = await autoreap(deps, {});
    expect(result.stdout).toEqual(['auto-reap: 0 workspace(s) reaped']);
    expect(calls.filter((c) => c.cmd !== 'gh')).toEqual([]);
  });

  test('a replacement PR on the same head skips the reap', async () => {
    const layout = makeLayout();
    writeBoardFile(layout.boardDir, [itemFixture({ createdByOrchestrator: true, pr: { number: 7 } })]);
    const { deps, calls } = makeDeps(
      layout,
      {
        prViews: {
          '7': { state: 'CLOSED', closedAt: '2026-09-02T09:46:40Z', headRefName: 'dev/feature' },
        },
        listByHead: { 'dev/feature': [{ number: 99 }] },
      },
      GATED,
    );
    const result = await autoreap(deps, {});
    expect(result.stdout).toEqual(['auto-reap: 0 workspace(s) reaped']);
    const replacementLookup = calls.find((c) => c.cmd === 'gh' && c.args.includes('--head'));
    expect(replacementLookup?.args).toContain('dev/feature');
    expect(replacementLookup?.args).toContain('open');
    expect(calls.filter((c) => c.cmd !== 'gh')).toEqual([]);
  });

  test('a settled closed PR reaps --abandon and records abandoned', async () => {
    const layout = makeLayout();
    const repo = makeRepo(layout); // no upstream: cancelled work, never pushed
    writeBoardFile(layout.boardDir, [
      itemFixture({ createdByOrchestrator: true, pr: { number: 7 } }),
      BLOCKED_ITEM,
    ]);
    const world = mergedWorld(repo);
    world.prViews = {
      '7': { state: 'CLOSED', closedAt: '2026-09-02T09:46:40Z', headRefName: 'dev/feature' },
    };
    world.listByHead = { 'dev/feature': [] };
    const { deps } = makeDeps(layout, world, autoreapConfig(repo));
    const result = await autoreap(deps, {});
    expect(result.stdout).toEqual([
      'auto-reaped itm_1 (feat) — PR #7 closed unmerged 2h ago, no replacement PR on dev/feature',
      'unblocked: itm_9 ',
      'auto-reap: 1 workspace(s) reaped',
    ]);
    expect(result.stderr).toEqual([]);
    expect(readBoard(layout.boardDir).items[0]!['state']).toBe('abandoned');
  });

  test('a merged candidate auto-reaps and surfaces the unblocked items', async () => {
    const layout = makeLayout();
    const repo = makeRepo(layout, { withUpstream: true });
    writeBoardFile(layout.boardDir, [
      itemFixture({ createdByOrchestrator: true }),
      BLOCKED_ITEM,
    ]);
    const world = mergedWorld(repo);
    const { deps } = makeDeps(layout, world, autoreapConfig(repo));
    const result = await autoreap(deps, {});
    expect(result.stdout).toEqual([
      'auto-reaped itm_1 (feat) — PR #12 merged',
      'unblocked: itm_9 ',
      'auto-reap: 1 workspace(s) reaped',
    ]);
    expect(readBoard(layout.boardDir).items[0]!['state']).toBe('closed');
  });

  test('a refusal is swallowed per item as a skipped line, and the loop exits clean', async () => {
    const layout = makeLayout();
    const repo = makeRepo(layout, { withUpstream: true });
    writeFileSync(join(repo.wt, 'junk.txt'), 'x\n');
    writeBoardFile(layout.boardDir, [itemFixture({ createdByOrchestrator: true })]);
    const world = mergedWorld(repo);
    const { deps, calls } = makeDeps(layout, world, autoreapConfig(repo));
    const result = await autoreap(deps, {});
    expect(result.stderr).toEqual([
      `skipped itm_1 (feat): BLOCKED: 1 uncommitted change(s) in ${repo.wt} — deleting the workspace would destroy them. Add --discard-changes if that is intended.`,
    ]);
    expect(result.stdout).toEqual(['auto-reap: 0 workspace(s) reaped']);
    expect(deleteCalls(calls)).toEqual([]);
    expect(existsSync(repo.wt)).toBe(true);
  });

  test('--dry-run says what it would reap, prints no summary, and touches nothing', async () => {
    const layout = makeLayout();
    const repo = makeRepo(layout, { withUpstream: true });
    writeBoardFile(layout.boardDir, [itemFixture({ createdByOrchestrator: true })]);
    const world = mergedWorld(repo);
    const { deps, calls } = makeDeps(layout, world, autoreapConfig(repo));
    const result = await autoreap(deps, { dryRun: true });
    expect(result.stdout).toEqual(['would reap itm_1 (feat) — PR #12 merged']);
    expect(deleteCalls(calls)).toEqual([]);
    expect(calls.filter((c) => c.cmd === 'superset')).toEqual([]);
    expect(existsSync(repo.wt)).toBe(true);
    expect(readBoard(layout.boardDir).items[0]!['state']).toBe('merged');
  });

  test('--quiet with nothing reaped says nothing at all', async () => {
    const layout = makeLayout();
    writeBoardFile(layout.boardDir, [itemFixture()]); // not a candidate
    const { deps } = makeDeps(layout, {}, GATED);
    const result = await autoreap(deps, { quiet: true });
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([]);
  });
});
