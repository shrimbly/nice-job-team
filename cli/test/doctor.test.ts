// board doctor over stubbed superset/gh/git io and temp orchestrator roots:
// first-run seeding, the broken-board quarantine, per-repo checks, and the
// NOTE/BLOCKED/READY verdict lines — byte for byte, because the orchestrator
// skill and the operator pattern-match on them. Nothing here touches the live
// CLIs, ~/.superset or ~/.claude.

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
import { doctor, packagedConfigExample } from '../src/doctor.js';
import type { DoctorDeps } from '../src/doctor.js';
import type { ExecResult, OrchRoot, PollIo } from '../src/types.js';

const NOW_ISO = '2026-09-02T12:00:00Z';

// ── temp roots ────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-doctor-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

interface Layout {
  base: string;
  home: string;
  orch: OrchRoot;
  boardDir: string;
}

/** A fresh orchestrator layout — nothing pre-created; the doctor's job. */
function makeLayout(): Layout {
  const base = tempDir();
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const orchRoot = join(base, 'orch');
  return {
    base,
    home,
    orch: {
      root: orchRoot,
      configPath: join(orchRoot, 'config.json'),
      workspacesDir: join(orchRoot, 'workspaces'),
    },
    boardDir: join(orchRoot, 'p', 'proj'),
  };
}

// ── io stub ───────────────────────────────────────────────────────────────────

function ok(stdout: string): ExecResult {
  return { status: 0, stdout, stderr: '' };
}
const FAIL: ExecResult = { status: 1, stdout: '', stderr: 'stubbed failure' };
/** realPollIo's spawn-failure shape — how "not on PATH" reaches the doctor. */
const NOT_FOUND: ExecResult = { status: 127, stdout: '', stderr: 'spawn cmd ENOENT' };

interface World {
  gitMissing?: boolean;
  supersetMissing?: boolean;
  authed?: boolean;
  running?: boolean;
  ghMissing?: boolean;
  ghAuthed?: boolean;
}

function makeIo(world: World, home: string): { io: PollIo; warnings: string[] } {
  const warnings: string[] = [];
  const io: PollIo = {
    exec(cmd, args) {
      const line = args.join(' ');
      if (cmd === 'git') {
        return world.gitMissing === true ? NOT_FOUND : ok('git version 2.44.0\n');
      }
      if (cmd === 'superset' || cmd.endsWith('/superset')) {
        if (world.supersetMissing === true) return NOT_FOUND;
        if (line === '--version') return ok('superset 9.9.9\n');
        if (line === 'auth whoami --json') {
          return world.authed === false
            ? FAIL
            : ok('{"email":"op@example.com","organizationName":"Acme"}');
        }
        if (line === 'status --json') {
          return world.running === false
            ? ok('{"running":false}')
            : ok('{"running":true,"pid":321,"port":4141}');
        }
        return FAIL;
      }
      if (cmd === 'gh') {
        if (world.ghMissing === true) return NOT_FOUND;
        if (line === 'auth status') return world.ghAuthed === false ? FAIL : ok('');
        if (line === 'api user --jq .login') return ok('shrimbly\n');
        return FAIL;
      }
      return NOT_FOUND;
    },
    now: () => NOW_ISO,
    nowMs: () => Date.parse(NOW_ISO),
    homeDir: () => home,
    // Isolated: the doctor consults the split machine config through io.env,
    // and a real ~/.config/superset-board on the dev machine must not bleed in.
    env: { XDG_CONFIG_HOME: join(home, '.config') },
    warn: (message) => warnings.push(message),
  };
  return { io, warnings };
}

function makeDeps(layout: Layout, world: World = {}, nodeVersion?: string): DoctorDeps {
  const deps: DoctorDeps = {
    io: makeIo(world, layout.home).io,
    orch: layout.orch,
    boardDir: layout.boardDir,
  };
  if (nodeVersion !== undefined) deps.nodeVersion = nodeVersion;
  return deps;
}

// ── fixtures ──────────────────────────────────────────────────────────────────

/** A clone-shaped directory (only `.git`'s existence is ever checked). */
function makeClone(layout: Layout): string {
  const clone = join(layout.base, 'clone');
  mkdirSync(join(clone, '.git'), { recursive: true });
  return clone;
}

function writeHealthyConfig(layout: Layout, repoOverrides: Record<string, unknown> = {}): string {
  const clone = makeClone(layout);
  mkdirSync(layout.orch.root, { recursive: true });
  writeFileSync(
    layout.orch.configPath,
    JSON.stringify({
      operator: { githubLogin: 'shrimbly' },
      repos: [
        {
          name: 'o/r',
          key: 'proj',
          localPath: clone,
          supersetProjectId: 'proj-1',
          reviewers: ['bob'],
          ...repoOverrides,
        },
      ],
    }) + '\n',
  );
  return clone;
}

function writeBoardFile(layout: Layout, items: unknown[]): void {
  mkdirSync(layout.boardDir, { recursive: true });
  writeFileSync(
    join(layout.boardDir, 'board.json'),
    JSON.stringify({ version: 1, updatedAt: NOW_ISO, items }) + '\n',
  );
}

// ── the packaged example ──────────────────────────────────────────────────────

describe('the packaged config example', () => {
  test('is byte-identical to the skill reference copy', () => {
    const packaged = readFileSync(
      new URL('../src/assets/config.example.json', import.meta.url),
      'utf8',
    );
    const reference = readFileSync(
      new URL(
        '../../skills/superset-orchestrator/reference/config.example.json',
        import.meta.url,
      ),
      'utf8',
    );
    expect(packaged).toBe(reference);
    // And the seeding helper serves those exact bytes.
    expect(packagedConfigExample()).toBe(reference);
  });
});

// ── seeding ───────────────────────────────────────────────────────────────────

describe('board doctor seeding', () => {
  test('first run creates the layout and writes the example BESIDE the config, not as it', () => {
    const layout = makeLayout();
    const result = doctor(makeDeps(layout));

    expect(existsSync(join(layout.boardDir, 'briefs'))).toBe(true);
    expect(existsSync(join(layout.boardDir, 'signals'))).toBe(true);
    // The inbox is global at the root — where lib.sh actually reads it.
    expect(existsSync(layout.orch.workspacesDir)).toBe(true);

    // NO config.json is seeded: the example's placeholder repo (acme/platform)
    // would ride into the config `board init --apply` merges into — two
    // projects configured, every verb refusing, the placeholder blocking the
    // doctor forever. The example lands beside it as a reference instead.
    const examplePath = join(layout.orch.root, 'config.example.json');
    expect(existsSync(layout.orch.configPath)).toBe(false);
    expect(readFileSync(examplePath, 'utf8')).toBe(packagedConfigExample());
    // And no board.json is invented for the phantom p/default project before
    // any repo exists to key one — an empty board there would show as a
    // project in the root cards.json forever.
    expect(existsSync(join(layout.boardDir, 'board.json'))).toBe(false);

    expect(result.lines).toContain(
      `NOTE: no config yet — wrote a reference ${examplePath}; run board init (the superset-setup skill drives it) to configure a repo`,
    );
    // No placeholder repo, so nothing about acme/platform anywhere.
    expect(result.lines.filter((l) => l.includes('acme/platform'))).toEqual([]);
    // The environment itself is healthy in this world, so the verdict is
    // READY: init is the next step, and a false BLOCKED would say "fix your
    // machine" about a machine with nothing wrong.
    expect(result.ready).toBe(true);
  });

  test('a second run re-seeds nothing and a real config takes over cleanly', () => {
    const layout = makeLayout();
    doctor(makeDeps(layout));
    const result = doctor(makeDeps(layout));
    expect(result.lines.filter((l) => l.startsWith('NOTE: seeded'))).toEqual([]);
    expect(result.lines.filter((l) => l.startsWith('NOTE: created'))).toEqual([]);
    // Still unconfigured, so the pointer at board init remains.
    expect(result.lines.some((l) => l.startsWith('NOTE: no config yet'))).toBe(true);

    // Once init has written the real config, the board is seeded and the
    // "no config" note is gone — the first-run example file changes nothing.
    writeHealthyConfig(layout);
    const configured = doctor(makeDeps(layout));
    expect(configured.lines.some((l) => l.startsWith('NOTE: no config yet'))).toBe(false);
    expect(configured.lines).toContain(
      `NOTE: created an empty board at ${join(layout.boardDir, 'board.json')}`,
    );
    expect(configured.ready).toBe(true);
  });

  test('a split-only setup is never re-seeded with a legacy config that would win', () => {
    const layout = makeLayout();
    // A migrated setup: machine config exists, legacy config.json does not.
    const clone = makeClone(layout);
    const machineDir = join(layout.home, '.config', 'superset-board');
    mkdirSync(machineDir, { recursive: true });
    writeFileSync(
      join(machineDir, 'config.json'),
      JSON.stringify({
        operator: { githubLogin: 'shrimbly' },
        repos: [{ name: 'o/r', key: 'proj', localPath: clone, supersetProjectId: 'proj-1' }],
      }) + '\n',
    );
    writeFileSync(
      join(clone, '.superset-board.json'),
      JSON.stringify({ name: 'o/r', key: 'proj', reviewers: ['rev'] }) + '\n',
    );
    const result = doctor(makeDeps(layout));

    // No legacy file appears — it would shadow the split pair.
    expect(existsSync(layout.orch.configPath)).toBe(false);
    expect(result.lines.filter((l) => l.startsWith('NOTE: seeded'))).toEqual([]);
    expect(result.lines).not.toContain(
      "BLOCKED: config.json is not valid JSON — fix it by hand, it holds the operator's settings",
    );
    // The repos are still checked, through the effective merged config.
    expect(result.lines).toContain('repo:       o/r  clone ok  project proj-1');
    expect(result.ready).toBe(true);
  });
});

// ── the healthy path ──────────────────────────────────────────────────────────

describe('board doctor READY', () => {
  test('prints the exact line sequence and READY', () => {
    const layout = makeLayout();
    writeHealthyConfig(layout);
    writeBoardFile(layout, [
      { id: 'itm_1', slug: 'a', title: 'A', state: 'building' },
      { id: 'itm_2', slug: 'b', title: 'B', state: 'closed' },
    ]);
    mkdirSync(layout.orch.workspacesDir, { recursive: true });
    writeFileSync(join(layout.orch.workspacesDir, 'ws-1.json'), '{}');
    writeFileSync(join(layout.orch.workspacesDir, 'ws-2.json'), '{}');
    writeFileSync(join(layout.orch.workspacesDir, 'notes.txt'), 'not a status file');

    const clone = join(layout.base, 'clone');
    const result = doctor(makeDeps(layout));
    expect(result.ready).toBe(true);
    expect(result.lines).toEqual([
      'superset:   superset 9.9.9',
      'account:    op@example.com (org Acme)',
      'host:       running (pid 321, port 4141)',
      'github:     shrimbly',
      'repo:       o/r  clone ok  project proj-1',
      'board:      2 items (1 active)',
      'status files: 2',
      '',
      'READY',
    ]);
    expect(clone).toBeTruthy();
  });
});

// ── quarantine ────────────────────────────────────────────────────────────────

describe('board doctor broken-board quarantine', () => {
  test('moves an unparseable board aside, reseeds, and says so', () => {
    const layout = makeLayout();
    writeHealthyConfig(layout);
    mkdirSync(layout.boardDir, { recursive: true });
    writeFileSync(join(layout.boardDir, 'board.json'), 'not json at all');

    const result = doctor(makeDeps(layout));
    const bak = join(layout.boardDir, 'board.json.broken.20260902T120000Z');
    expect(readFileSync(bak, 'utf8')).toBe('not json at all');
    expect(readFileSync(join(layout.boardDir, 'board.json'), 'utf8')).toBe(
      `{"version":1,"updatedAt":"${NOW_ISO}","items":[]}\n`,
    );
    expect(result.lines).toContain(
      `NOTE: board.json was empty or invalid — moved to ${bak} and started a clean board; re-run SENSE to rebuild it, and reconcile against live workspaces before dispatching`,
    );
    // A quarantine is a NOTE, never a block.
    expect(result.ready).toBe(true);
  });

  test('an empty board file counts as invalid too', () => {
    const layout = makeLayout();
    writeHealthyConfig(layout);
    mkdirSync(layout.boardDir, { recursive: true });
    writeFileSync(join(layout.boardDir, 'board.json'), '');
    const result = doctor(makeDeps(layout));
    expect(result.lines.some((l) => l.startsWith('NOTE: board.json was empty or invalid'))).toBe(
      true,
    );
    expect(existsSync(join(layout.boardDir, 'board.json.broken.20260902T120000Z'))).toBe(true);
  });
});

// ── verdict lines ─────────────────────────────────────────────────────────────

describe('board doctor verdicts', () => {
  test('an invalid config is BLOCKED with the exact message', () => {
    const layout = makeLayout();
    mkdirSync(layout.orch.root, { recursive: true });
    writeFileSync(layout.orch.configPath, '{broken');
    const result = doctor(makeDeps(layout));
    expect(result.ready).toBe(false);
    expect(result.lines).toContain(
      "BLOCKED: config.json is not valid JSON — fix it by hand, it holds the operator's settings",
    );
    // A config jq cannot read yields no repo rows.
    expect(result.lines.filter((l) => l.startsWith('repo:'))).toEqual([]);
  });

  test('not logged in to superset is BLOCKED; version line still prints', () => {
    const layout = makeLayout();
    writeHealthyConfig(layout);
    writeBoardFile(layout, []);
    const result = doctor(makeDeps(layout, { authed: false }));
    expect(result.lines).toContain('superset:   superset 9.9.9');
    expect(result.lines).toContain(
      "BLOCKED: not logged in — the operator must run: superset auth login  (browser OAuth; the desktop app's session does not count)",
    );
    expect(result.ready).toBe(false);
  });

  test('a stopped host is only a NOTE', () => {
    const layout = makeLayout();
    writeHealthyConfig(layout);
    writeBoardFile(layout, []);
    const result = doctor(makeDeps(layout, { running: false }));
    expect(result.lines).toContain(
      "NOTE: host service is not running — 'superset start --daemon' before dispatching",
    );
    expect(result.ready).toBe(true);
  });

  test('a missing superset CLI is BLOCKED', () => {
    const layout = makeLayout();
    writeHealthyConfig(layout);
    writeBoardFile(layout, []);
    const result = doctor(makeDeps(layout, { supersetMissing: true }));
    expect(result.lines).toContain(
      'BLOCKED: superset CLI not found (expected ~/.superset/bin/superset)',
    );
    expect(result.lines.some((l) => l.startsWith('superset:'))).toBe(false);
  });

  test('gh missing and gh unauthenticated block with their own messages', () => {
    const layout = makeLayout();
    writeHealthyConfig(layout);
    writeBoardFile(layout, []);
    expect(doctor(makeDeps(layout, { ghMissing: true })).lines).toContain(
      'BLOCKED: gh CLI not found',
    );
    expect(doctor(makeDeps(layout, { ghAuthed: false })).lines).toContain(
      'BLOCKED: gh is not authenticated — run: gh auth login',
    );
  });

  test('a missing supersetProjectId is a NOTE with the fix in it', () => {
    const layout = makeLayout();
    writeHealthyConfig(layout, { supersetProjectId: null });
    writeBoardFile(layout, []);
    const result = doctor(makeDeps(layout));
    expect(result.lines).toContain('repo:       o/r  clone ok');
    expect(result.lines).toContain(
      'NOTE: repo o/r has no supersetProjectId — get it from: superset projects list --local --json',
    );
    expect(result.ready).toBe(true);
  });

  test('an old Node is a NOTE, never BLOCKED', () => {
    const layout = makeLayout();
    writeHealthyConfig(layout);
    writeBoardFile(layout, []);
    const result = doctor(makeDeps(layout, {}, '18.19.0'));
    expect(result.lines).toContain('NOTE: running on Node 18.19.0 — this CLI needs Node >= 20');
    expect(result.ready).toBe(true);
    // The current runtime passes the check silently.
    const current = doctor(makeDeps(layout, {}));
    expect(current.lines.some((l) => l.includes('needs Node >= 20'))).toBe(false);
  });

  test('a missing git dies lib.sh-style before any output', () => {
    const layout = makeLayout();
    expect(() => doctor(makeDeps(layout, { gitMissing: true }))).toThrow('missing command: git');
    // Dying before the mkdirs, like need_cmd at the top of the script.
    expect(existsSync(layout.boardDir)).toBe(false);
  });
});
