// The config split: the legacy $SUPERSET_ORCH_ROOT/config.json keeps working
// unchanged and wins when present; machine config (XDG) + committed
// .superset-board.json project files are the additive layout underneath it.
// Everything here runs over temp roots — no test touches ~/.claude, ~/.config
// or ~/.superset.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  loadConfig,
  loadRoot,
  machineConfigPath,
  projectConfigPath,
  readConfig,
} from '../src/config.js';
import { InitError, initMigrate, parseApplyFlags, writeSplitConfig } from '../src/init.js';
import type { Incoming, InitDeps } from '../src/init.js';
import type { ExecResult, OrchRoot, PollIo, RepoConfig } from '../src/types.js';

const NOW_ISO = '2026-09-02T12:00:00Z';

// ── temp roots ────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-config-split-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

interface World {
  base: string;
  orch: OrchRoot;
  env: NodeJS.ProcessEnv;
  xdg: string;
  machinePath: string;
  clone: string;
}

function makeWorld(): World {
  const base = tempDir();
  const orchRoot = join(base, 'orch');
  mkdirSync(orchRoot, { recursive: true });
  const xdg = join(base, 'xdg');
  const clone = join(base, 'clone');
  mkdirSync(clone, { recursive: true });
  return {
    base,
    orch: {
      root: orchRoot,
      configPath: join(orchRoot, 'config.json'),
      workspacesDir: join(orchRoot, 'workspaces'),
    },
    env: { XDG_CONFIG_HOME: xdg, SUPERSET_ORCH_ROOT: orchRoot },
    xdg,
    machinePath: join(xdg, 'superset-board', 'config.json'),
    clone,
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function stubIo(env: NodeJS.ProcessEnv): PollIo {
  return {
    exec: (): ExecResult => ({ status: 127, stdout: '', stderr: 'no exec in this test' }),
    now: () => NOW_ISO,
    nowMs: () => Date.parse(NOW_ISO),
    homeDir: () => join(tmpdir(), 'no-home-in-this-test'),
    env,
    warn: () => {},
  };
}

function deps(world: World): InitDeps {
  return { io: stubIo(world.env), orch: world.orch };
}

/** A full legacy config: every block, plus unknowns that must not be lost. */
function legacyFixture(clone: string): Record<string, unknown> {
  return {
    operator: {
      githubLogin: 'shrimbly',
      githubLogins: ['shrimbly'],
      linearWorkspace: 'acme',
      timezone: 'Australia/Sydney',
    },
    tracker: {
      kind: 'markdown',
      issueUrl: 'https://github.com/acme/app/blob/main/.tasks/{key}.md',
      path: '.tasks',
    },
    preview: { patterns: ['https://preview-{n}.example.com'] },
    repos: [
      {
        name: 'acme/app',
        key: 'acme-app',
        shortName: 'app',
        localPath: clone,
        defaultBase: 'main',
        reviewers: ['bob'],
        supersetProjectId: 'sp-1',
        checks: { lint: 'npm run lint' },
        prTemplate: 'template body',
        linearTeams: ['APP'],
        customRepoField: true,
      },
      // No localPath: nowhere to commit a project file, stays machine-side.
      { name: 'acme/tools', key: 'acme-tools' },
    ],
    cloud: { enabled: true, fireUrl: 'https://example.com/fire' },
    limits: { maxActiveWorkspaces: 4, recentlyClosedDays: 7 },
    cadence: { watchSeconds: 120 },
    gates: { approveBeforeDispatch: true },
    answers: { 'q-1': 'yes' },
    customTopLevel: 'kept',
  };
}

// ── the loader ────────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  test('legacy only: the effective config is the file, byte for byte, no note', () => {
    const world = makeWorld();
    const legacy = legacyFixture(world.clone);
    writeJson(world.orch.configPath, legacy);

    const loaded = loadConfig(world.orch, world.env);
    expect(JSON.stringify(loaded.config, null, 2) + '\n').toBe(
      readFileSync(world.orch.configPath, 'utf8'),
    );
    expect(loaded.sources).toEqual([world.orch.configPath]);
    expect(loaded.deprecationNote).toBeUndefined();
  });

  test('no config anywhere: empty config, empty sources, no note', () => {
    const world = makeWorld();
    const loaded = loadConfig(world.orch, world.env);
    expect(loaded.config).toEqual({});
    expect(loaded.sources).toEqual([]);
    expect(loaded.deprecationNote).toBeUndefined();
  });

  test('split only: project file wins team fields, machine file wins machine fields', () => {
    const world = makeWorld();
    writeJson(world.machinePath, {
      stateDir: world.orch.root,
      operator: { githubLogin: 'shrimbly', linearWorkspace: 'acme' },
      repos: [
        {
          key: 'acme-app',
          localPath: world.clone,
          supersetProjectId: 'sp-1',
          // Stale machine-side copies of team fields: the project file wins.
          name: 'stale/name',
          defaultBase: 'stale-base',
        },
      ],
      cloud: { enabled: true },
      limits: { maxActiveWorkspaces: 2 },
      cadence: { watchSeconds: 60 },
      gates: { approveBeforeDispatch: true },
      answers: { 'q-1': 'yes' },
    });
    writeJson(projectConfigPath(world.clone), {
      name: 'acme/app',
      defaultBase: 'main',
      reviewers: ['bob'],
      shortName: 'app',
      key: 'acme-app',
      checks: { lint: 'npm run lint' },
      // Machine fields in a project file must NOT reach the effective config:
      // a committed file must not steer another machine's paths or projects.
      localPath: '/somewhere/else',
      supersetProjectId: 'evil',
      tracker: { kind: 'markdown', issueUrl: 'https://example.com/{key}' },
      preview: { patterns: ['https://p.example.com'] },
    });

    const loaded = loadConfig(world.orch, world.env);
    const repo = (loaded.config.repos as RepoConfig[])[0]!;
    expect(repo.name).toBe('acme/app');
    expect(repo.defaultBase).toBe('main');
    expect(repo.reviewers).toEqual(['bob']);
    expect(repo.shortName).toBe('app');
    expect(repo.checks).toEqual({ lint: 'npm run lint' });
    expect(repo.localPath).toBe(world.clone);
    expect(repo.supersetProjectId).toBe('sp-1');
    expect(loaded.config.tracker).toEqual({
      kind: 'markdown',
      issueUrl: 'https://example.com/{key}',
    });
    expect(loaded.config.preview).toEqual({ patterns: ['https://p.example.com'] });
    expect(loaded.config.operator?.githubLogin).toBe('shrimbly');
    expect(loaded.config.limits?.maxActiveWorkspaces).toBe(2);
    expect(loaded.config).not.toHaveProperty('stateDir');
    expect(loaded.sources).toEqual([world.machinePath, projectConfigPath(world.clone)]);
    expect(loaded.deprecationNote).toBeUndefined();
  });

  test('split only: a machine entry whose project file is missing stands alone', () => {
    const world = makeWorld();
    writeJson(world.machinePath, {
      repos: [{ name: 'acme/app', key: 'acme-app', localPath: world.clone }],
    });
    const loaded = loadConfig(world.orch, world.env);
    expect((loaded.config.repos as RepoConfig[])[0]).toEqual({
      name: 'acme/app',
      key: 'acme-app',
      localPath: world.clone,
    });
    expect(loaded.sources).toEqual([world.machinePath]);
  });

  test('both layouts: legacy wins whole, and the note names the migration', () => {
    const world = makeWorld();
    const legacy = legacyFixture(world.clone);
    writeJson(world.orch.configPath, legacy);
    writeJson(world.machinePath, {
      operator: { githubLogin: 'somebody-else' },
      repos: [{ name: 'other/repo', localPath: world.clone }],
    });

    const loaded = loadConfig(world.orch, world.env);
    expect(loaded.config).toEqual(legacy);
    expect(loaded.sources).toEqual([world.orch.configPath]);
    expect(loaded.deprecationNote).toContain(world.orch.configPath);
    expect(loaded.deprecationNote).toContain(world.machinePath);
    expect(loaded.deprecationNote).toContain('board init --migrate');
  });

  test('readConfig is the seam: every op sees the merged view', () => {
    const world = makeWorld();
    writeJson(world.machinePath, {
      repos: [{ key: 'acme-app', localPath: world.clone, supersetProjectId: 'sp-1' }],
    });
    writeJson(projectConfigPath(world.clone), { name: 'acme/app', defaultBase: 'main' });
    // readConfig reads the machine path from process.env, as live ops do.
    const saved = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = world.xdg;
    try {
      const config = readConfig(world.orch);
      expect((config.repos as RepoConfig[])[0]?.name).toBe('acme/app');
      expect((config.repos as RepoConfig[])[0]?.supersetProjectId).toBe('sp-1');
    } finally {
      if (saved === undefined) delete process.env['XDG_CONFIG_HOME'];
      else process.env['XDG_CONFIG_HOME'] = saved;
    }
  });
});

// ── the machine path and the root ─────────────────────────────────────────────

describe('machineConfigPath and loadRoot', () => {
  test('XDG_CONFIG_HOME is honoured; ~/.config is the fallback', () => {
    expect(machineConfigPath({ XDG_CONFIG_HOME: '/x' })).toBe(
      join('/x', 'superset-board', 'config.json'),
    );
    expect(machineConfigPath({})).toBe(join(homedir(), '.config', 'superset-board', 'config.json'));
  });

  test('stateDir moves the root; SUPERSET_ORCH_ROOT still wins; default unchanged', () => {
    const world = makeWorld();
    const moved = join(world.base, 'moved-orch');
    writeJson(world.machinePath, { stateDir: moved });

    const envNoRoot: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: world.xdg };
    expect(loadRoot(envNoRoot).root).toBe(moved);
    expect(loadRoot(envNoRoot).configPath).toBe(join(moved, 'config.json'));
    expect(loadRoot(envNoRoot).workspacesDir).toBe(join(moved, 'workspaces'));

    expect(loadRoot(world.env).root).toBe(world.orch.root);

    // No machine config at all: the default the legacy layout always had.
    const emptyXdg = join(world.base, 'empty-xdg');
    expect(loadRoot({ XDG_CONFIG_HOME: emptyXdg }).root).toBe(
      join(homedir(), '.claude', 'superset-orchestrator'),
    );
  });
});

// ── init --apply --split ──────────────────────────────────────────────────────

describe('writeSplitConfig', () => {
  const incoming = (world: World): Incoming => ({
    operator: {
      githubLogin: 'shrimbly',
      linearName: '',
      linearWorkspace: 'acme',
      timezone: 'Australia/Sydney',
    },
    tracker: { kind: 'markdown', issueUrl: 'https://example.com/{key}' },
    repo: {
      name: 'acme/app',
      defaultBase: 'main',
      localPath: world.clone,
      shortName: 'app',
      reviewers: ['bob'],
      supersetProjectId: 'sp-1',
    },
  });

  test('writes machine and project files, and says exactly what went where', () => {
    const world = makeWorld();
    const lines = writeSplitConfig(deps(world), incoming(world));
    const projectPath = projectConfigPath(world.clone);

    const joined = lines.join('\n');
    expect(joined).toContain(`wrote ${world.machinePath}`);
    expect(joined).toContain(`wrote ${projectPath}`);
    expect(joined).toContain('machine fields:');
    expect(joined).toContain('team fields:');
    expect(joined).not.toContain('still exists and wins');

    const machine = JSON.parse(readFileSync(world.machinePath, 'utf8')) as Record<string, unknown>;
    expect(machine['stateDir']).toBe(world.orch.root);
    expect((machine['operator'] as Record<string, unknown>)['githubLogin']).toBe('shrimbly');
    // Identity fields (name/key/defaultBase) live in BOTH files: the machine
    // entry is loadConfig's documented fallback when the clone — and so the
    // project file — is missing, and without a name the poll silently drops
    // the repo. The project file still wins them whenever it is present.
    expect(machine['repos']).toEqual([
      {
        name: 'acme/app',
        key: 'acme-app',
        defaultBase: 'main',
        localPath: world.clone,
        supersetProjectId: 'sp-1',
      },
    ]);
    expect(machine['limits']).toEqual({ maxActiveWorkspaces: 4 });
    expect(machine['cadence']).toEqual({ watchSeconds: 120 });
    expect(machine['tracker']).toBeUndefined();

    const project = JSON.parse(readFileSync(projectPath, 'utf8')) as Record<string, unknown>;
    expect(project['name']).toBe('acme/app');
    expect(project['defaultBase']).toBe('main');
    expect(project['reviewers']).toEqual(['bob']);
    expect(project['shortName']).toBe('app');
    expect(project['key']).toBe('acme-app');
    expect(project['tracker']).toEqual({ kind: 'markdown', issueUrl: 'https://example.com/{key}' });
    expect(project['localPath']).toBeUndefined();
    expect(project['supersetProjectId']).toBeUndefined();

    // The state directories are still seeded, same as the legacy write.
    expect(existsSync(join(world.orch.root, 'workspaces'))).toBe(true);
    expect(existsSync(join(world.orch.root, 'p', 'acme-app'))).toBe(true);

    // No legacy file was created, and the loader reads the pair back merged.
    expect(existsSync(world.orch.configPath)).toBe(false);
    const loaded = loadConfig(world.orch, world.env);
    expect((loaded.config.repos as RepoConfig[])[0]?.name).toBe('acme/app');
    expect((loaded.config.repos as RepoConfig[])[0]?.localPath).toBe(world.clone);
    expect(loaded.deprecationNote).toBeUndefined();
  });

  test('a lingering legacy config earns the "still wins" note', () => {
    const world = makeWorld();
    writeJson(world.orch.configPath, legacyFixture(world.clone));
    const lines = writeSplitConfig(deps(world), incoming(world));
    expect(lines.join('\n')).toContain('still exists and wins');
  });

  test('parseApplyFlags knows --split, and it defaults off', () => {
    expect(parseApplyFlags(['--repo', 'a/b', '--split']).split).toBe(true);
    expect(parseApplyFlags(['--repo', 'a/b']).split).toBeUndefined();
  });
});

// ── init --migrate ────────────────────────────────────────────────────────────

describe('initMigrate', () => {
  test('round-trip: the effective config is identical before and after', () => {
    const world = makeWorld();
    const legacy = legacyFixture(world.clone);
    writeJson(world.orch.configPath, legacy);
    const before = loadConfig(world.orch, world.env).config;

    const result = initMigrate(deps(world));

    // The legacy file is renamed, original bytes intact.
    expect(existsSync(world.orch.configPath)).toBe(false);
    const migrated = readdirSync(world.orch.root).filter((name) =>
      name.startsWith('config.json.migrated-'),
    );
    expect(migrated).toHaveLength(1);
    expect(readFileSync(join(world.orch.root, migrated[0]!), 'utf8')).toBe(
      JSON.stringify(legacy, null, 2) + '\n',
    );

    // Both new files exist, and the mapping was printed.
    const projectPath = projectConfigPath(world.clone);
    expect(existsSync(world.machinePath)).toBe(true);
    expect(existsSync(projectPath)).toBe(true);
    const joined = result.stdout.join('\n');
    expect(joined).toContain(`wrote ${world.machinePath}`);
    expect(joined).toContain(`wrote ${projectPath}`);
    expect(joined).toContain('machine fields:');
    expect(joined).toContain('team fields:');
    expect(joined).toContain('legacy config renamed to');

    // The split: team fields left the machine file, machine fields stayed.
    const machine = JSON.parse(readFileSync(world.machinePath, 'utf8')) as Record<string, unknown>;
    expect(machine['stateDir']).toBe(world.orch.root);
    expect(machine['tracker']).toBeUndefined();
    expect(machine['preview']).toBeUndefined();
    expect(machine['customTopLevel']).toBe('kept');
    const machineRepos = machine['repos'] as Record<string, unknown>[];
    // The identity fields are duplicated machine-side as the fallback for a
    // missing clone/project file; the project file wins them when present.
    expect(machineRepos[0]!['name']).toBe('acme/app');
    expect(machineRepos[0]!['key']).toBe('acme-app');
    expect(machineRepos[0]!['defaultBase']).toBe('main');
    // The rest of the team fields still left the machine file.
    expect(machineRepos[0]!['reviewers']).toBeUndefined();
    expect(machineRepos[0]!['checks']).toBeUndefined();
    expect(machineRepos[0]!['localPath']).toBe(world.clone);
    expect(machineRepos[0]!['supersetProjectId']).toBe('sp-1');
    expect(machineRepos[0]!['prTemplate']).toBe('template body');
    // The repo with no clone to commit into stays whole in the machine file.
    expect(machineRepos[1]).toEqual({ name: 'acme/tools', key: 'acme-tools' });

    const project = JSON.parse(readFileSync(projectPath, 'utf8')) as Record<string, unknown>;
    expect(project['name']).toBe('acme/app');
    expect(project['checks']).toEqual({ lint: 'npm run lint' });
    expect(project['tracker']).toEqual(legacy['tracker']);
    expect(project['preview']).toEqual(legacy['preview']);
    expect(project['localPath']).toBeUndefined();
    expect(project['supersetProjectId']).toBeUndefined();

    // The point of the exercise.
    const after = loadConfig(world.orch, world.env);
    expect(after.config).toEqual(before);
    expect(after.deprecationNote).toBeUndefined();
  });

  test('a re-run over the identical split files a crashed migrate wrote proceeds', () => {
    const world = makeWorld();
    const legacy = legacyFixture(world.clone);
    writeJson(world.orch.configPath, legacy);
    initMigrate(deps(world));
    // The crash window: both split files written, the legacy rename not yet
    // landed. Recreate that state from the rename target's preserved bytes —
    // the re-run must be the recovery, not a dead end.
    const migrated = readdirSync(world.orch.root).find((name) =>
      name.startsWith('config.json.migrated-'),
    )!;
    copyFileSync(join(world.orch.root, migrated), world.orch.configPath);

    const result = initMigrate(deps(world));
    expect(result.stdout.join('\n')).toContain('legacy config renamed to');
    expect(existsSync(world.orch.configPath)).toBe(false);
    expect(loadConfig(world.orch, world.env).config).toEqual(
      JSON.parse(readFileSync(join(world.orch.root, migrated), 'utf8')),
    );
  });

  test('refuses when the machine config already exists, touching nothing', () => {
    const world = makeWorld();
    writeJson(world.orch.configPath, legacyFixture(world.clone));
    writeJson(world.machinePath, { operator: {} });
    expect(() => initMigrate(deps(world))).toThrow(InitError);
    expect(() => initMigrate(deps(world))).toThrow(/already exists/);
    expect(existsSync(world.orch.configPath)).toBe(true);
    expect(existsSync(projectConfigPath(world.clone))).toBe(false);
  });

  test('refuses when a project file already exists, before any write lands', () => {
    const world = makeWorld();
    writeJson(world.orch.configPath, legacyFixture(world.clone));
    writeJson(projectConfigPath(world.clone), { key: 'already-here' });
    expect(() => initMigrate(deps(world))).toThrow(/already exists/);
    expect(existsSync(world.machinePath)).toBe(false);
    expect(existsSync(world.orch.configPath)).toBe(true);
  });

  test('refuses when there is nothing to migrate', () => {
    const world = makeWorld();
    expect(() => initMigrate(deps(world))).toThrow(/nothing to migrate/);
  });
});
