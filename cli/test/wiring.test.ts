// The wiring suite — tests/run.sh's surviving checks, hermetic by
// construction: every case spawns the REAL built CLI (node dist/main.js)
// against a throwaway SUPERSET_ORCH_ROOT with stub `superset` and `gh`
// binaries, so nothing here touches the network or the real orchestrator
// root. board_bin resolution died with the bash; what remains to prove is the
// offline `board cycle` walk (step-failure naming, render-always, the FAILED
// summary), the malformed-status-file tolerance end to end, that bin/board
// runs from a built dist, and that the P4 verbs are wired at all.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';

const cliRoot = fileURLToPath(new URL('../', import.meta.url));
const mainJs = join(cliRoot, 'dist', 'main.js');
const binBoard = join(cliRoot, 'bin', 'board');

// The suite needs cli/dist, and it should be THIS checkout's sources — a
// stale build would test yesterday's wiring — so tsc runs first. When tsc
// fails but a dist already exists, the suite runs against that dist instead
// of dying: during development a NEIGHBOURING file can be mid-edit (this tree
// is worked by concurrent agents), and its syntax error is not this suite's
// finding. dist/ is gitignored, so a fresh checkout has no dist to fall back
// to and a real build break still fails loudly. The help probe guards the
// fallback against a dist too old to know the verbs under test.
beforeAll(() => {
  const built = spawnSync(
    process.execPath,
    [join(cliRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', cliRoot],
    { encoding: 'utf8', cwd: cliRoot },
  );
  if (built.status !== 0) {
    if (!existsSync(mainJs)) {
      throw new Error(`tsc failed and no dist exists:\n${built.stdout}\n${built.stderr}`);
    }
    console.warn(`wiring: tsc failed, running against the existing dist\n${built.stdout}`);
  }
  const help = spawnSync(process.execPath, [mainJs, 'help'], { encoding: 'utf8' });
  expect(help.status).toBe(0);
  expect(help.stdout).toContain('board tasks');
  expect(help.stdout).toContain('board cycle');
}, 180_000);

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-wiring-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

interface World {
  root: string;
  boardFile: string;
  env: NodeJS.ProcessEnv;
}

/**
 * run.sh's setup(): a fresh root — config, an empty inbox, a two-item board
 * (one live, one closed long ago) — plus stub superset and gh on PATH via a
 * temp bin dir. "Not logged in" keeps every verb offline and disarms the
 * prune; the failing gh (pinned via BOARD_GH_PATH, the CLI's first candidate)
 * makes every PR list read as empty rather than live. HOME points at the root
 * so the CLI's $HOME/.superset/bin probe finds the stub, never the operator's
 * real CLI.
 */
function setup(): World {
  const root = tempDir();
  mkdirSync(join(root, 'p', 'test'), { recursive: true });
  mkdirSync(join(root, 'workspaces'));
  mkdirSync(join(root, 'bin'));

  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      repos: [{ name: 'o/r', key: 'test' }],
      limits: { recentlyClosedDays: 7 },
    }),
  );

  const boardFile = join(root, 'p', 'test', 'board.json');
  writeFileSync(
    boardFile,
    JSON.stringify({
      version: 1,
      updatedAt: '2026-08-01T00:00:00Z',
      items: [
        {
          id: 'itm_1',
          slug: 'live-item',
          title: 'T-1 - Live item',
          state: 'dispatched',
          workspaceId: 'ws-good',
          pr: null,
          history: [{ at: '2026-08-01T00:00:00Z', from: 'proposed', to: 'dispatched' }],
        },
        {
          id: 'itm_2',
          slug: 'old-closed',
          title: 'T-2 - Old closed',
          state: 'closed',
          pr: { number: 41, url: 'https://gh/41' },
          history: [{ at: '2026-08-01T00:00:00Z', from: 'merged', to: 'closed' }],
        },
      ],
    }),
  );

  for (const stub of ['superset', 'gh']) {
    writeFileSync(join(root, 'bin', stub), '#!/bin/sh\nexit 1\n');
    chmodSync(join(root, 'bin', stub), 0o755);
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['SUPERSET_ORCH_DIR'];
  delete env['SUPERSET_ORCH_REPO'];
  env['SUPERSET_ORCH_ROOT'] = root;
  env['SUPERSET_ORCH_PROJECT'] = 'test';
  env['HOME'] = root;
  env['BOARD_GH_PATH'] = join(root, 'bin', 'gh');
  env['PATH'] = `${join(root, 'bin')}${delimiter}${process.env['PATH'] ?? ''}`;
  return { root, boardFile, env };
}

function board(w: World, ...args: string[]): { status: number; out: string; stdout: string } {
  const result = spawnSync(process.execPath, [mainJs, ...args], {
    encoding: 'utf8',
    env: w.env,
  });
  expect(result.error).toBeUndefined();
  return {
    status: result.status ?? -1,
    out: `${result.stdout}${result.stderr}`,
    stdout: result.stdout,
  };
}

function boardJson(w: World): { version: number; items: { state: string }[] } {
  return JSON.parse(readFileSync(w.boardFile, 'utf8'));
}

// ── board cycle: the whole maintenance loop through one verb ─────────────────

describe('board cycle, offline', () => {
  test('--dry-run completes with stubbed superset and gh', () => {
    const w = setup();
    const r = board(w, 'cycle', '--dry-run');
    expect(r.status).toBe(0);
    expect(r.out).not.toMatch(/cycle:.*failed/);
    // poll wrote both signal files…
    expect(statSync(join(w.root, 'p', 'test', 'signals', 'github.json')).size).toBeGreaterThan(0);
    expect(statSync(join(w.root, 'p', 'test', 'signals', 'workspaces.json')).size).toBeGreaterThan(0);
    // …render wrote the board files…
    expect(statSync(join(w.root, 'p', 'test', 'board.md')).size).toBeGreaterThan(0);
    // …dry-run moved nothing off the board, and reconcile bumped the version
    // under the lock.
    const doc = boardJson(w);
    expect(doc.items).toHaveLength(2);
    expect(doc.version).toBe(2);
  }, 60_000);

  test('a failing step is named, and the render still runs', () => {
    const w = setup();
    rmSync(join(w.root, 'config.json')); // poll's hard stop; every other step tolerates it
    const r = board(w, 'cycle', '--dry-run');
    expect(r.status).not.toBe(0);
    // cycle.sh's run_step voice, byte for byte — the operator and the
    // orchestrator skill pattern-match these lines.
    expect(r.out).toContain('cycle: poll failed (exit 1) — continuing');
    expect(r.out).toContain(
      'cycle: FAILED steps: poll — board rendered from what did complete',
    );
    expect(statSync(join(w.root, 'p', 'test', 'board.md')).size).toBeGreaterThan(0);
  }, 60_000);
});

// ── The CLI vs a malformed status file, end to end ───────────────────────────

describe('malformed status file', () => {
  function corruptInbox(w: World): void {
    writeFileSync(
      join(w.root, 'workspaces', 'ws-good.json'),
      JSON.stringify({
        workspaceId: 'ws-good',
        state: 'building',
        updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      }),
    );
    // The exact corruption observed on 1 Sep: a bare number where
    // {number, url} belongs.
    writeFileSync(
      join(w.root, 'workspaces', 'ws-bad.json'),
      JSON.stringify({ workspaceId: 'ws-bad', state: 'fixing', pr: 938 }),
    );
  }

  test('reconcile survives it, warns by name, and folds the healthy one in', () => {
    const w = setup();
    corruptInbox(w);
    const r = board(w, 'reconcile');
    expect(r.status).toBe(0);
    expect(r.out).toContain('ws-bad');
    expect(boardJson(w).items[0]!.state).toBe('building');
  }, 60_000);

  test('render slurps the same inbox and survives it too', () => {
    const w = setup();
    corruptInbox(w);
    expect(board(w, 'reconcile').status).toBe(0);
    const r = board(w, 'render');
    expect(r.status).toBe(0);
    expect(statSync(join(w.root, 'p', 'test', 'board.md')).size).toBeGreaterThan(0);
  }, 60_000);
});

// ── the plugin packaging agrees with itself ──────────────────────────────────
// The version lives in three files and the scout in two; nothing but this
// test ties them together — `claude plugin tag` checks plugin.json against
// the marketplace entry, but the first `npm version` bump in cli/ (or a scout
// edit in one place) would otherwise drift silently. This repo's own history
// shows diverged copies are exactly how things rot here.

describe('plugin packaging drift', () => {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

  test('plugin.json, marketplace.json and cli/package.json carry one version', () => {
    const read = (rel: string): Record<string, unknown> =>
      JSON.parse(readFileSync(join(repoRoot, rel), 'utf8')) as Record<string, unknown>;
    const plugin = read('.claude-plugin/plugin.json');
    const marketplace = read('.claude-plugin/marketplace.json') as {
      plugins: { version: string }[];
    };
    const pkg = read('cli/package.json');
    expect(typeof plugin['version']).toBe('string');
    expect(marketplace.plugins[0]!.version).toBe(plugin['version']);
    expect(pkg['version']).toBe(plugin['version']);
  });

  test('the plugin scout and the skill scout are byte-identical', () => {
    // The plugin registers agents/superset-scout.md; a skills-only install
    // copies the one inside skills/superset-orchestrator/. Duplication is the
    // deliberate fix for the no-scout-source-without-the-plugin hole, and
    // this pin is what keeps the two copies from diverging.
    const pluginScout = readFileSync(join(repoRoot, 'agents', 'superset-scout.md'), 'utf8');
    const skillScout = readFileSync(
      join(repoRoot, 'skills', 'superset-orchestrator', 'agents', 'superset-scout.md'),
      'utf8',
    );
    expect(skillScout).toBe(pluginScout);
  });
});

// ── bin/board runs from a built dist ─────────────────────────────────────────
// run.sh's board_bin checks proved the BASH could find the CLI; that lookup is
// gone with the bash. What still needs proving is the launcher itself.

test('bin/board --version runs the built dist', () => {
  const w = setup();
  const result = spawnSync(process.execPath, [binBoard, '--version'], {
    encoding: 'utf8',
    env: w.env,
  });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
}, 60_000);

// ── board tasks is wired ─────────────────────────────────────────────────────

describe('board tasks, through the built CLI', () => {
  function withTracker(w: World): string {
    const repoRoot = tempDir();
    const tasksDir = join(repoRoot, '.tasks');
    mkdirSync(tasksDir);
    writeFileSync(
      join(tasksDir, 't-1.md'),
      '---\nid: t-1\ntitle: One task\nstatus: todo\npriority: high\n---\n\nDo it.\n',
    );
    writeFileSync(
      join(w.root, 'config.json'),
      JSON.stringify({
        repos: [{ name: 'o/r', key: 'test', localPath: repoRoot }],
        tracker: { kind: 'markdown' },
      }),
    );
    return repoRoot;
  }

  test('--open prints the backlog, --index writes TASKS.md and prints its path', () => {
    const w = setup();
    const repoRoot = withTracker(w);

    const open = board(w, 'tasks', '--open');
    expect(open.status).toBe(0);
    const tasks = JSON.parse(open.stdout) as { id: string; relPath: string }[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: 't-1', relPath: '.tasks/t-1.md' });

    const index = board(w, 'tasks', '--index');
    expect(index.status).toBe(0);
    expect(index.stdout).toBe(join(repoRoot, 'TASKS.md') + '\n');
    const md = readFileSync(join(repoRoot, 'TASKS.md'), 'utf8');
    expect(md).toContain('## To do');
    expect(md).toContain('- [One task](.tasks/t-1.md) — high');
    // The invariant, visible at the surface: the verb read the task file and
    // wrote none of it back.
    expect(readFileSync(join(repoRoot, '.tasks', 't-1.md'), 'utf8')).toContain('status: todo');
  }, 60_000);

  test('no status-writing flag exists — anything unknown dies BLOCKED', () => {
    const w = setup();
    withTracker(w);
    const r = board(w, 'tasks', '--set-status');
    expect(r.status).toBe(1);
    expect(r.out).toContain('BLOCKED: unknown argument: --set-status  (try: --list, --open, --index)');
  }, 60_000);
});
