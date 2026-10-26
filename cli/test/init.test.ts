// board init over stubbed gh/git/superset/npx io and temp roots: the --detect
// JSON shape (a contract the superset-setup skill reads), --apply's merge
// semantics (existing key wins, a second repo joins without clobbering, only
// non-empty incoming values win), the backup, the refusals, and the scout /
// bundled-skills installs. Nothing here touches the live CLIs, ~/.superset or
// ~/.claude — the skill and agents directories are temp dirs named by env.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  initApply,
  initDetect,
  initShow,
  installSkills,
  linearSlug,
  parseApplyFlags,
  repoKey,
} from '../src/init.js';
import type { InitDeps } from '../src/init.js';
import type { ExecResult, OrchRoot, PollIo } from '../src/types.js';

const NOW_ISO = '2026-09-02T12:00:00Z';

// ── temp roots ────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-init-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

interface Layout {
  base: string;
  home: string;
  clone: string;
  orch: OrchRoot;
}

function makeLayout(): Layout {
  const base = tempDir();
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const clone = join(base, 'clone');
  mkdirSync(clone, { recursive: true });
  const orchRoot = join(base, 'orch');
  return {
    base,
    home,
    clone,
    orch: {
      root: orchRoot,
      configPath: join(orchRoot, 'config.json'),
      workspacesDir: join(orchRoot, 'workspaces'),
    },
  };
}

// ── io stub ───────────────────────────────────────────────────────────────────

function ok(stdout: string): ExecResult {
  return { status: 0, stdout, stderr: '' };
}
const FAIL: ExecResult = { status: 1, stdout: '', stderr: 'stubbed failure' };
const NOT_FOUND: ExecResult = { status: 127, stdout: '', stderr: 'spawn cmd ENOENT' };

interface World {
  /** gh repo view nameWithOwner; '' fails the call (detect comes back empty). */
  repo?: string;
  base?: string;
  login?: string;
  /** git rev-parse --show-toplevel; '' fails the call. */
  toplevel?: string;
  gitDir?: string;
  gitCommonDir?: string;
  supersetMissing?: boolean;
  /** rows for `superset projects list --local --json`. */
  projects?: unknown[];
  npxMissing?: boolean;
  /** package specs whose `npx skills add` fails. */
  npxFails?: string[];
  ghAuthed?: boolean;
}

interface Call {
  cmd: string;
  args: string[];
}

function makeIo(
  world: World,
  layout: Layout,
  env: NodeJS.ProcessEnv = {},
): { io: PollIo; calls: Call[] } {
  // Isolated by default: init consults the split machine config through
  // io.env, and a real ~/.config/superset-board on the dev machine must not
  // bleed in. A test that sets XDG_CONFIG_HOME itself keeps its own value.
  env = { XDG_CONFIG_HOME: join(layout.home, '.config'), ...env };
  const calls: Call[] = [];
  const io: PollIo = {
    exec(cmd, args) {
      calls.push({ cmd, args });
      const line = args.join(' ');
      if (cmd === 'git') {
        if (line === '--version') return ok('git version 2.44.0\n');
        if (line === 'rev-parse --show-toplevel') {
          const top = world.toplevel ?? layout.clone;
          return top === '' ? FAIL : ok(`${top}\n`);
        }
        if (line === 'rev-parse --git-dir') {
          return ok(`${world.gitDir ?? join(layout.clone, '.git')}\n`);
        }
        if (line === 'rev-parse --git-common-dir') {
          return ok(`${world.gitCommonDir ?? join(layout.clone, '.git')}\n`);
        }
        return FAIL;
      }
      if (cmd === 'gh') {
        if (line === '--version') return ok('gh version 2.62.0\n');
        if (line === 'auth status') return world.ghAuthed === false ? FAIL : ok('');
        if (line === 'repo view --json nameWithOwner -q .nameWithOwner') {
          const repo = world.repo ?? 'o/r';
          return repo === '' ? FAIL : ok(`${repo}\n`);
        }
        if (line === 'repo view --json defaultBranchRef -q .defaultBranchRef.name') {
          const base = world.base ?? 'main';
          return base === '' ? FAIL : ok(`${base}\n`);
        }
        if (line === 'api user -q .login') return ok(`${world.login ?? 'shrimbly'}\n`);
        return FAIL;
      }
      if (cmd === 'superset' || cmd.endsWith('/superset')) {
        if (world.supersetMissing === true) return NOT_FOUND;
        if (line === '--version') return ok('superset 9.9.9\n');
        if (line === 'auth whoami --json') return ok('{"email":"op@example.com"}');
        if (line === 'projects list --local --json') {
          return ok(JSON.stringify(world.projects ?? [{ repoPath: layout.clone, id: 'proj-9' }]));
        }
        return FAIL;
      }
      if (cmd === 'npx') {
        if (world.npxMissing === true) return NOT_FOUND;
        if (line === '--version') return ok('10.9.2\n');
        if (args[0] === '-y' && args[1] === 'skills' && args[2] === 'add') {
          return (world.npxFails ?? []).includes(args[3]!) ? FAIL : ok('');
        }
        return FAIL;
      }
      return NOT_FOUND;
    },
    now: () => NOW_ISO,
    nowMs: () => Date.parse(NOW_ISO),
    homeDir: () => layout.home,
    env,
    warn: () => {},
  };
  return { io, calls };
}

function makeDeps(world: World, layout: Layout, env: NodeJS.ProcessEnv = {}): InitDeps {
  return {
    io: makeIo(world, layout, env).io,
    orch: layout.orch,
    readlink: () => '/var/db/timezone/zoneinfo/Australia/Sydney\n',
  };
}

function readConfigFile(layout: Layout): Record<string, unknown> {
  return JSON.parse(readFileSync(layout.orch.configPath, 'utf8')) as Record<string, unknown>;
}

function apply(deps: InitDeps, flags: string[]): string[] {
  return initApply(deps, parseApplyFlags(flags)).stdout;
}

// ── helpers under test ────────────────────────────────────────────────────────

describe('slug helpers', () => {
  test('repoKey lowercases and collapses non-alphanumerics', () => {
    expect(repoKey('Acme-Org/Acme-Desktop')).toBe('acme-org-acme-desktop');
  });
  test('linearSlug takes the workspace out of any Linear URL and passes slugs through', () => {
    expect(linearSlug('https://linear.app/acme/issue/ENG-1')).toBe('acme');
    expect(linearSlug('acme')).toBe('acme');
  });
});

// ── --detect ──────────────────────────────────────────────────────────────────

describe('board init --detect', () => {
  test('prints the exact JSON shape with everything detected', () => {
    const layout = makeLayout();
    const result = initDetect(makeDeps({}, layout));
    expect(JSON.parse(result.stdout[0]!)).toEqual({
      detected: {
        repo: 'o/r',
        localPath: layout.clone,
        defaultBase: 'main',
        githubLogin: 'shrimbly',
        timezone: 'Australia/Sydney',
        supersetProjectId: 'proj-9',
      },
      needed: ['linearWorkspace', 'reviewer'],
      supersetOnPath: true,
      configPath: layout.orch.configPath,
      configLayout: 'none',
      existing: null,
    });
  });

  test('what cannot be found lands in needed, and no superset means no project id', () => {
    const layout = makeLayout();
    const result = initDetect(makeDeps({ repo: '', toplevel: '', supersetMissing: true }, layout));
    const parsed = JSON.parse(result.stdout[0]!) as Record<string, unknown>;
    expect(parsed['needed']).toEqual(['repo', 'localPath', 'linearWorkspace', 'reviewer']);
    expect(parsed['supersetOnPath']).toBe(false);
    expect((parsed['detected'] as Record<string, unknown>)['repo']).toBe('');
    expect((parsed['detected'] as Record<string, unknown>)['supersetProjectId']).toBe('');
  });

  test('a linked worktree resolves to the main clone via the common dir parent', () => {
    const layout = makeLayout();
    const deps = makeDeps(
      {
        toplevel: join(layout.home, '.superset', 'worktrees', 'proj', 'feature'),
        gitDir: join(layout.clone, '.git', 'worktrees', 'feature'),
        gitCommonDir: join(layout.clone, '.git'),
      },
      layout,
    );
    const parsed = JSON.parse(initDetect(deps).stdout[0]!) as {
      detected: { localPath: string };
    };
    expect(parsed.detected.localPath).toBe(layout.clone);
  });

  test('an existing config surfaces its operator and the matching repo', () => {
    const layout = makeLayout();
    mkdirSync(layout.orch.root, { recursive: true });
    writeFileSync(
      layout.orch.configPath,
      JSON.stringify({
        operator: { githubLogin: 'old' },
        repos: [{ name: 'o/r', key: 'o-r' }, { name: 'x/y' }],
      }),
    );
    const parsed = JSON.parse(initDetect(makeDeps({}, layout)).stdout[0]!) as {
      existing: unknown;
    };
    expect(parsed.existing).toEqual({
      operator: { githubLogin: 'old' },
      repo: { name: 'o/r', key: 'o-r' },
    });
  });

  test('refuses when gh is not logged in', () => {
    const layout = makeLayout();
    expect(() => initDetect(makeDeps({ ghAuthed: false }, layout))).toThrow(
      'gh is not logged in — run: gh auth login',
    );
  });

  test('a migrated (split-only) setup is existing config, not a fresh machine', () => {
    const layout = makeLayout();
    writeSplitOnly(layout);
    const parsed = JSON.parse(initDetect(makeDeps({}, layout)).stdout[0]!) as {
      configLayout: string;
      existing: { operator: unknown; repo: { name?: string; key?: string } | null };
    };
    // The setup skill pattern-matches `existing`: null here sent it back to a
    // full re-interview and a plain --apply that would resurrect a winning
    // legacy file. configLayout tells it to pass --split on the re-apply.
    expect(parsed.configLayout).toBe('split');
    expect(parsed.existing).toEqual({
      operator: { githubLogin: 'old' },
      repo: { name: 'o/r', key: 'o-r', localPath: layout.clone, reviewers: ['rev'] },
    });
  });
});

/** A migrated setup: machine + project files, NO legacy config.json. */
function writeSplitOnly(layout: Layout): void {
  const machineDir = join(layout.home, '.config', 'superset-board');
  mkdirSync(machineDir, { recursive: true });
  writeFileSync(
    join(machineDir, 'config.json'),
    JSON.stringify({
      operator: { githubLogin: 'old' },
      repos: [{ name: 'o/r', key: 'o-r', localPath: layout.clone }],
    }) + '\n',
  );
  writeFileSync(
    join(layout.clone, '.superset-board.json'),
    JSON.stringify({ name: 'o/r', key: 'o-r', reviewers: ['rev'], tracker: { kind: 'linear' } }) +
      '\n',
  );
}

// ── --apply ───────────────────────────────────────────────────────────────────

describe('board init --apply', () => {
  test('first apply writes the full config, defaults included, in setup.sh key order', () => {
    const layout = makeLayout();
    const stdout = apply(makeDeps({}, layout), [
      '--repo', 'Acme-Org/Acme-Desktop',
      '--path', layout.clone,
      '--base', 'main',
      '--operator', 'shrimbly',
      '--name', 'dev',
      '--linear', 'https://linear.app/acme/board',
      '--timezone', 'Australia/Sydney',
      '--reviewer', 'bob',
      '--superset-project', 'proj-9',
      '--tracker', 'markdown',
      '--no-scout', '--no-skills',
    ]);
    expect(stdout).toEqual([`wrote ${layout.orch.configPath}`]);
    const config = readConfigFile(layout);
    expect(config).toEqual({
      operator: {
        githubLogin: 'shrimbly',
        linearName: 'dev',
        linearWorkspace: 'acme',
        timezone: 'Australia/Sydney',
      },
      repos: [
        {
          name: 'Acme-Org/Acme-Desktop',
          defaultBase: 'main',
          localPath: layout.clone,
          shortName: 'Acme-Desktop',
          reviewers: ['bob'],
          supersetProjectId: 'proj-9',
          key: 'acme-org-acme-desktop',
        },
      ],
      limits: { maxActiveWorkspaces: 4 },
      cadence: { watchSeconds: 120 },
      tracker: {
        kind: 'markdown',
        issueUrl: 'https://github.com/Acme-Org/Acme-Desktop/blob/main/.tasks/{key}.md',
      },
    });
    // jq's assignment order is the file's key order.
    expect(Object.keys(config)).toEqual(['operator', 'repos', 'limits', 'cadence', 'tracker']);
    expect(existsSync(join(layout.orch.root, 'workspaces'))).toBe(true);
    expect(existsSync(join(layout.orch.root, 'p', 'acme-org-acme-desktop'))).toBe(true);
  });

  test('a fresh apply with no --tracker defaults to GitHub Issues, URL derived from the repo', () => {
    const layout = makeLayout();
    apply(makeDeps({}, layout), ['--repo', 'o/r', '--no-scout', '--no-skills']);
    expect(readConfigFile(layout)['tracker']).toEqual({
      kind: 'github-issues',
      issueUrl: 'https://github.com/o/r/issues/{key}',
    });
  });

  test('re-apply never touches an existing tracker — a block stays, and no block stays absent', () => {
    // An explicit block survives a re-apply that names no tracker.
    const layout = makeLayout();
    apply(makeDeps({}, layout), [
      '--repo', 'o/r', '--tracker', 'markdown', '--no-scout', '--no-skills',
    ]);
    const written = readConfigFile(layout)['tracker'];
    expect(written).toEqual({
      kind: 'markdown',
      issueUrl: 'https://github.com/o/r/blob/main/.tasks/{key}.md',
    });
    apply(makeDeps({}, layout), ['--repo', 'o/r', '--no-scout', '--no-skills']);
    expect(readConfigFile(layout)['tracker']).toEqual(written);

    // A pre-block config means Linear, and the github-issues default must not
    // overwrite that meaning: absent stays absent on re-apply.
    const legacy = makeLayout();
    mkdirSync(legacy.orch.root, { recursive: true });
    writeFileSync(
      legacy.orch.configPath,
      JSON.stringify({ operator: { linearWorkspace: 'acme' }, repos: [{ name: 'o/r' }] }),
    );
    apply(makeDeps({}, legacy), ['--repo', 'o/r', '--no-scout', '--no-skills']);
    expect('tracker' in readConfigFile(legacy)).toBe(false);
  });

  test('--tracker linear and github-issues are accepted, templates derived', () => {
    const linear = makeLayout();
    apply(makeDeps({}, linear), [
      '--repo', 'o/r', '--linear', 'acme', '--tracker', 'linear', '--no-scout', '--no-skills',
    ]);
    expect(readConfigFile(linear)['tracker']).toEqual({
      kind: 'linear',
      issueUrl: 'https://linear.app/acme/issue/{key}',
    });

    const issues = makeLayout();
    apply(makeDeps({}, issues), [
      '--repo', 'o/r', '--tracker', 'github-issues',
      '--tracker-url', 'https://github.com/o/r/issues/{key}?ref=board',
      '--no-scout', '--no-skills',
    ]);
    // An explicit --tracker-url wins over the derivation.
    expect(readConfigFile(issues)['tracker']).toEqual({
      kind: 'github-issues',
      issueUrl: 'https://github.com/o/r/issues/{key}?ref=board',
    });
  });

  test('an existing key wins over the derivation, and empty incoming values cannot blank fields', () => {
    const layout = makeLayout();
    mkdirSync(layout.orch.root, { recursive: true });
    const before = {
      operator: { githubLogin: 'old-login', timezone: 'Etc/UTC' },
      repos: [
        {
          name: 'Acme-Org/Acme-Desktop',
          key: 'acme-org-desktop',
          localPath: '/old/clone',
          defaultBase: 'main',
          reviewers: ['alice'],
        },
      ],
      limits: { maxActiveWorkspaces: 9 },
    };
    writeFileSync(layout.orch.configPath, JSON.stringify(before) + '\n');

    // Detection finds nothing, so every unset flag stays empty and live()
    // drops it — the merge must keep what is already there.
    const deps = makeDeps({ repo: '', base: '', toplevel: '', supersetMissing: true }, layout);
    const noTz: InitDeps = { ...deps, readlink: () => { throw new Error('no localtime'); } };
    const stdout = apply(noTz, [
      '--repo', 'Acme-Org/Acme-Desktop',
      '--operator', 'new-login',
      '--no-scout', '--no-skills',
    ]);

    const config = readConfigFile(layout);
    const repo = (config['repos'] as Record<string, unknown>[])[0]!;
    expect(repo['key']).toBe('acme-org-desktop'); // never re-derived
    expect(repo['localPath']).toBe('/old/clone');
    expect(repo['reviewers']).toEqual(['alice']); // [] incoming was dropped
    expect(repo['shortName']).toBe('Acme-Desktop'); // non-empty incoming wins
    expect(config['operator']).toEqual({ githubLogin: 'new-login', timezone: 'Etc/UTC' });
    expect(config['limits']).toEqual({ maxActiveWorkspaces: 9 });

    // The old config was backed up first, bytes intact.
    const backups = readdirSync(layout.orch.root).filter((f) => f.endsWith('.bak'));
    expect(backups).toEqual(['config.json.20260902120000.bak']);
    expect(stdout[0]).toBe(
      `previous config saved to ${join(layout.orch.root, 'config.json.20260902120000.bak')}`,
    );
    expect(stdout[1]).toBe(`wrote ${layout.orch.configPath}`);
    expect(
      JSON.parse(readFileSync(join(layout.orch.root, backups[0]!), 'utf8')),
    ).toEqual(before);
    // The existing key names the project directory that gets created.
    expect(existsSync(join(layout.orch.root, 'p', 'acme-org-desktop'))).toBe(true);
  });

  test('a second repo joins without clobbering the first', () => {
    const layout = makeLayout();
    apply(makeDeps({}, layout), [
      '--repo', 'o/r', '--path', layout.clone, '--reviewer', 'bob',
      '--no-scout', '--no-skills',
    ]);
    const first = (readConfigFile(layout)['repos'] as unknown[])[0];
    apply(makeDeps({ repo: 'other/thing', projects: [] }, layout), [
      '--repo', 'other/thing', '--path', '/elsewhere/thing',
      '--no-scout', '--no-skills',
    ]);
    const config = readConfigFile(layout);
    const repos = config['repos'] as Record<string, unknown>[];
    expect(repos).toHaveLength(2);
    expect(repos[0]).toEqual(first);
    expect(repos[1]!['name']).toBe('other/thing');
    expect(repos[1]!['key']).toBe('other-thing');
  });

  test('refusals: invalid existing JSON, and a missing --repo', () => {
    const layout = makeLayout();
    mkdirSync(layout.orch.root, { recursive: true });
    writeFileSync(layout.orch.configPath, '{nope');
    expect(() =>
      apply(makeDeps({}, layout), ['--repo', 'o/r', '--no-scout', '--no-skills']),
    ).toThrow('refusing to write invalid JSON.');
    // The refusal still backed the broken file up first, as the shell did.
    expect(readdirSync(layout.orch.root).some((f) => f.endsWith('.bak'))).toBe(true);

    expect(() => apply(makeDeps({}, layout), ['--no-scout'])).toThrow(
      '--apply needs --repo owner/name',
    );
    expect(() => apply(makeDeps({}, layout), ['--wat'])).toThrow('unknown flag: --wat');
    expect(() => apply(makeDeps({}, layout), ['--repo'])).toThrow('--repo needs a value');
  });

  test('installs the scout from the skill dir, and re-runs say already current', () => {
    const layout = makeLayout();
    const skillDir = join(layout.base, 'skill');
    const agentsDir = join(layout.base, 'agents');
    mkdirSync(join(skillDir, 'agents'), { recursive: true });
    writeFileSync(join(skillDir, 'agents', 'superset-scout.md'), 'scout body\n');
    const env = {
      SUPERSET_ORCH_SKILL_DIR: skillDir,
      SUPERSET_ORCH_AGENTS_DIR: agentsDir,
    };
    const deps = makeDeps({}, layout, env);
    const stdout = apply(deps, ['--repo', 'o/r', '--no-skills']);
    expect(readFileSync(join(agentsDir, 'superset-scout.md'), 'utf8')).toBe('scout body\n');
    expect(stdout).toContain(`installed the scout to ${join(agentsDir, 'superset-scout.md')}`);

    const again = apply(makeDeps({}, layout, env), ['--repo', 'o/r', '--no-skills']);
    expect(again).toContain(`scout already current at ${join(agentsDir, 'superset-scout.md')}`);

    // No scout in the skill dir: a note, never a failure.
    const bare = join(layout.base, 'bare-skill');
    mkdirSync(bare, { recursive: true });
    const noScout = apply(
      makeDeps({}, layout, { ...env, SUPERSET_ORCH_SKILL_DIR: bare }),
      ['--repo', 'o/r', '--no-skills'],
    );
    expect(noScout).toContain(
      `note: no scout at ${join(bare, 'agents', 'superset-scout.md')} — skipping.`,
    );
  });

  test('the plugin copy of the scout wins over the legacy skill dir, and falls back', () => {
    const layout = makeLayout();
    const skillDir = join(layout.base, 'skill');
    const pluginRoot = join(layout.base, 'plugin');
    const agentsDir = join(layout.base, 'agents');
    mkdirSync(join(skillDir, 'agents'), { recursive: true });
    writeFileSync(join(skillDir, 'agents', 'superset-scout.md'), 'legacy scout\n');
    mkdirSync(join(pluginRoot, 'agents'), { recursive: true });
    writeFileSync(join(pluginRoot, 'agents', 'superset-scout.md'), 'plugin scout\n');
    const env = {
      SUPERSET_ORCH_SKILL_DIR: skillDir,
      SUPERSET_ORCH_AGENTS_DIR: agentsDir,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    };
    apply(makeDeps({}, layout, env), ['--repo', 'o/r', '--no-skills']);
    expect(readFileSync(join(agentsDir, 'superset-scout.md'), 'utf8')).toBe('plugin scout\n');

    // No scout under the plugin root: the legacy skill-dir copy still installs.
    const bareRoot = join(layout.base, 'bare-plugin');
    mkdirSync(bareRoot, { recursive: true });
    apply(makeDeps({}, layout, { ...env, CLAUDE_PLUGIN_ROOT: bareRoot }), [
      '--repo', 'o/r', '--no-skills',
    ]);
    expect(readFileSync(join(agentsDir, 'superset-scout.md'), 'utf8')).toBe('legacy scout\n');

    // Neither copy exists: the note names the preferred (plugin) path.
    const bareSkill = join(layout.base, 'bare-skill');
    mkdirSync(bareSkill, { recursive: true });
    const none = apply(
      makeDeps({}, layout, {
        ...env,
        CLAUDE_PLUGIN_ROOT: bareRoot,
        SUPERSET_ORCH_SKILL_DIR: bareSkill,
      }),
      ['--repo', 'o/r', '--no-skills'],
    );
    expect(none).toContain(
      `note: no scout at ${join(bareRoot, 'agents', 'superset-scout.md')} — skipping.`,
    );
  });

  test('bundled skills: link-or-warn, never fatal, and --no-skills means no npx at all', () => {
    const layout = makeLayout();
    const { io, calls } = makeIo({ npxFails: ['coderabbitai/skills@code-review'] }, layout);
    const deps: InitDeps = { io, orch: layout.orch, readlink: () => 'x' };
    const lines = installSkills(deps);
    expect(lines).toEqual([
      'installed aminblg/simpleenglish@simple-english',
      'note: could not install coderabbitai/skills@code-review — add it later with:',
      '      npx skills add coderabbitai/skills@code-review -g -y -a claude-code',
      'installed jackjin1997/clawforge@clean-code',
    ]);
    const adds = calls.filter((c) => c.cmd === 'npx' && c.args[2] === 'add');
    expect(adds).toHaveLength(3);
    expect(adds[0]!.args).toEqual([
      '-y', 'skills', 'add', 'aminblg/simpleenglish@simple-english',
      '--global', '--yes', '--agent', 'claude-code',
    ]);

    // npx missing: the manual commands, verbatim.
    const missing = installSkills({
      io: makeIo({ npxMissing: true }, layout).io,
      orch: layout.orch,
    });
    expect(missing).toEqual([
      'note: npx not found — skipping the bundled skills. Install them with:',
      '      npx skills add aminblg/simpleenglish@simple-english -g -y -a claude-code',
      '      npx skills add coderabbitai/skills@code-review -g -y -a claude-code',
      '      npx skills add jackjin1997/clawforge@clean-code -g -y -a claude-code',
    ]);

    // --no-skills: not one npx call.
    const quiet = makeIo({}, layout);
    apply(
      { io: quiet.io, orch: layout.orch, readlink: () => 'x' },
      ['--repo', 'o/r', '--no-scout', '--no-skills'],
    );
    expect(quiet.calls.filter((c) => c.cmd === 'npx')).toEqual([]);
  });
});

// ── --show ────────────────────────────────────────────────────────────────────

describe('board init --show', () => {
  test('prints the trimmed view of a written config', () => {
    const layout = makeLayout();
    apply(makeDeps({}, layout), [
      '--repo', 'o/r', '--path', layout.clone, '--reviewer', 'bob',
      '--no-scout', '--no-skills',
    ]);
    const shown = JSON.parse(initShow(makeDeps({}, layout)).stdout[0]!) as Record<string, unknown>;
    expect(shown['repos']).toEqual([
      {
        name: 'o/r',
        key: 'o-r',
        shortName: 'r',
        localPath: layout.clone,
        defaultBase: 'main',
        supersetProjectId: 'proj-9',
      },
    ]);
    expect(shown['limits']).toEqual({ maxActiveWorkspaces: 4 });
    // reviewers are deliberately not part of the --show projection.
    expect(JSON.stringify(shown)).not.toContain('bob');
  });

  test('dies when there is no config, naming the board verb', () => {
    const layout = makeLayout();
    expect(() => initShow(makeDeps({}, layout))).toThrow(
      `no config at ${layout.orch.configPath} — run board init to write one.`,
    );
  });

  test('a migrated (split-only) setup shows the effective merge, not "no config"', () => {
    const layout = makeLayout();
    writeSplitOnly(layout);
    const shown = JSON.parse(initShow(makeDeps({}, layout)).stdout[0]!) as Record<string, unknown>;
    expect(shown['repos']).toEqual([
      {
        name: 'o/r',
        key: 'o-r',
        shortName: null,
        localPath: layout.clone,
        defaultBase: null,
        supersetProjectId: null,
      },
    ]);
  });
});

// ── the split-only compat contract ────────────────────────────────────────────
// A migrated setup has no legacy config.json, and loadConfig makes any legacy
// file WIN — so a plain --apply must never create one there: the minimal new
// file would silently shadow every split setting, and its fresh-install
// tracker default would flip the team's tracker to github-issues.

describe('board init --apply on a migrated (split-only) setup', () => {
  test('refuses without --split, touching nothing, naming the fix', () => {
    const layout = makeLayout();
    writeSplitOnly(layout);
    expect(() =>
      apply(makeDeps({}, layout), ['--repo', 'o/r', '--no-scout', '--no-skills']),
    ).toThrow(/re-run with --apply --split/);
    expect(existsSync(layout.orch.configPath)).toBe(false);
  });

  test('--apply --split re-applies without re-defaulting the tracker', () => {
    const layout = makeLayout();
    writeSplitOnly(layout);
    apply(makeDeps({}, layout), ['--repo', 'o/r', '--split', '--no-scout', '--no-skills']);
    // No legacy file appeared, and the team's tracker survived the re-apply.
    expect(existsSync(layout.orch.configPath)).toBe(false);
    const project = JSON.parse(
      readFileSync(join(layout.clone, '.superset-board.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(project['tracker']).toEqual({ kind: 'linear' });
  });
});
