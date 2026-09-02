// Where the orchestrator lives and which projects it holds. Ports lib.sh's
// layout resolution and Orchestrator.swift's `projects`, with one deliberate
// difference recorded on discoverProjects.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BoardConfigFile, OrchRoot, ProjectRef } from './types.js';

/**
 * SUPERSET_ORCH_ROOT is set by humans, and a value like "~/orch-copy" reaches
 * us unexpanded when it was quoted in the shell. The Swift app expands it
 * (expandingTildeInPath), so we must too or the two would read different roots
 * from the same environment.
 */
function expandTilde(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

/**
 * The orchestrator's root. config.json and workspaces/ hang off it directly:
 * they are global on purpose — one operator, and an agent-status inbox keyed by
 * globally unique workspace id — while everything per-project lives in p/<key>/.
 *
 * SUPERSET_ORCH_ROOT wins as it always has. Below it, the machine config's
 * `stateDir` may relocate the state directory — its default is the legacy
 * location, so a machine with no machine config moves nothing.
 */
export function loadRoot(env: NodeJS.ProcessEnv = process.env): OrchRoot {
  const override = env['SUPERSET_ORCH_ROOT'];
  let root: string;
  if (override !== undefined && override !== '') {
    root = resolve(expandTilde(override));
  } else {
    const stateDir = readObjectFile(machineConfigPath(env))?.['stateDir'];
    root =
      typeof stateDir === 'string' && stateDir !== ''
        ? resolve(expandTilde(stateDir))
        : join(homedir(), '.claude', 'superset-orchestrator');
  }
  return {
    root,
    configPath: join(root, 'config.json'),
    workspacesDir: join(root, 'workspaces'),
  };
}

/**
 * Every project the CLI should look at, in a stable order.
 *
 * Explicit selection wins: SUPERSET_ORCH_DIR points at one board directory (a
 * one-off board, same as lib.sh), and SUPERSET_ORCH_PROJECT names one key under
 * p/. Then the legacy single-board layout — board.json at the root, from before
 * p/<key>/ existed — reads as the one project with an empty key.
 *
 * With more than one configured project and no selection, lib.sh's project_key
 * dies ("N projects configured — set SUPERSET_ORCH_PROJECT"). That is right for
 * a mutating script, which must not guess which board to write, but wrong for a
 * renderer: the board answers "what is every agent doing", and one project out
 * of two is a wrong answer, not a partial one. So discovery returns them all
 * and render walks all — the CLI's improvement over lib.sh, and the same call
 * Orchestrator.swift already made.
 */
export function discoverProjects(
  orch: OrchRoot,
  env: NodeJS.ProcessEnv = process.env,
): ProjectRef[] {
  const dirOverride = env['SUPERSET_ORCH_DIR'];
  if (dirOverride && dirOverride !== '') {
    // A one-off board. The key still honours SUPERSET_ORCH_PROJECT when both
    // are set, the way lib.sh computes PROJECT_KEY independently of BOARD_DIR.
    return [{ key: env['SUPERSET_ORCH_PROJECT'] ?? '', root: resolve(expandTilde(dirOverride)) }];
  }

  const container = join(orch.root, 'p');
  const key = env['SUPERSET_ORCH_PROJECT'];
  if (key && key !== '') {
    return [{ key, root: join(container, key) }];
  }

  // The single-project layout, from before p/<key>/ existed.
  if (existsSync(join(orch.root, 'board.json'))) {
    return [{ key: '', root: orch.root }];
  }

  let keys: string[];
  try {
    keys = readdirSync(container);
  } catch {
    return [];
  }
  return (
    keys
      .sort()
      .map((k) => ({ key: k, root: join(container, k) }))
      // A directory with no board is a project that never polled. Skipping it
      // keeps an empty p/<key>/ from showing as a project with no work.
      .filter((p) => existsSync(join(p.root, 'board.json')))
  );
}

/**
 * The operator's effective config. Missing, unreadable or unparseable all read
 * as an empty config — lib.sh's cfg falls back silently in every one of those
 * cases, and a board must render for an operator who has no config at all.
 *
 * Every op reads config through this one call, so it is the seam where the
 * split layout (below) joins: with the legacy file present nothing changes,
 * and without it the machine + project merge is what "the config" means.
 */
export function readConfig(orch: OrchRoot): BoardConfigFile {
  return loadConfig(orch).config;
}

// ── The config split ──────────────────────────────────────────────────────────
// Two additive files above the legacy one. MACHINE config —
// $XDG_CONFIG_HOME/superset-board/config.json, ~/.config when XDG is unset —
// holds what is true of this machine and its operator: stateDir, the operator
// block, each repo's localPath and supersetProjectId, cloud, limits, cadence,
// gates, answers. PROJECT config — .superset-board.json committed in each
// configured repo, found via the machine entry's localPath — holds what a
// team shares: the repo name, defaultBase, reviewers, shortName, key, checks,
// and the top-level tracker and preview blocks. The LEGACY file
// $SUPERSET_ORCH_ROOT/config.json keeps working unchanged and WINS when
// present: it is the operator's live setup, and half-reading it would quietly
// change a working board. `board init --migrate` retires it.

/** The machine config file, $XDG_CONFIG_HOME honoured (~/.config without it). */
export function machineConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env['XDG_CONFIG_HOME'];
  const base =
    xdg !== undefined && xdg !== '' ? resolve(expandTilde(xdg)) : join(homedir(), '.config');
  return join(base, 'superset-board', 'config.json');
}

/** The committed project file's basename. */
export const PROJECT_CONFIG_BASENAME = '.superset-board.json';

/** Where a repo's committed project config lives, given its clone path. */
export function projectConfigPath(localPath: string): string {
  return join(resolve(expandTilde(localPath)), PROJECT_CONFIG_BASENAME);
}

/**
 * The per-repo fields a team shares — the project file's half of a repo entry.
 * The machine entry may carry any of them as a fallback (a repo whose clone —
 * or project file — is missing still needs a name), but the project file wins.
 */
export const TEAM_REPO_FIELDS = [
  'name',
  'defaultBase',
  'reviewers',
  'shortName',
  'key',
  'checks',
] as const;

export interface LoadedConfig {
  /** The effective merged config — exactly the legacy file when it exists. */
  config: BoardConfigFile;
  /** The config files that exist and were consulted, in read order. */
  sources: string[];
  /** Set only when both layouts exist: the legacy file won, and how to move on. */
  deprecationNote?: string;
}

/** Tolerant object read: undefined for missing, unreadable, or non-object. */
function readObjectFile(path: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return undefined;
}

function isObjValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The effective config and where it came from. Legacy beats the split: when
 * $SUPERSET_ORCH_ROOT/config.json exists it is returned untouched (that is
 * today's normal, so only the coexistence of BOTH layouts earns a note).
 * Otherwise the machine config is the base and each repo entry that names a
 * localPath merges with that clone's committed .superset-board.json — the
 * project file wins the team fields, the machine file wins the rest — and the
 * first project file defining tracker or preview supplies the top-level block.
 * `stateDir` is loadRoot's input, not part of the board's config, so the
 * effective config never carries it.
 */
export function loadConfig(orch: OrchRoot, env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const machinePath = machineConfigPath(env);
  if (existsSync(orch.configPath)) {
    const loaded: LoadedConfig = {
      config: (readObjectFile(orch.configPath) as BoardConfigFile | undefined) ?? {},
      sources: [orch.configPath],
    };
    if (existsSync(machinePath)) {
      loaded.deprecationNote =
        `legacy ${orch.configPath} wins over ${machinePath} — ` +
        `run \`board init --migrate\` to move to the split layout`;
    }
    return loaded;
  }
  if (!existsSync(machinePath)) return { config: {}, sources: [] };

  const machine = readObjectFile(machinePath) ?? {};
  const sources = [machinePath];
  const effective: Record<string, unknown> = { ...machine };
  delete effective['stateDir'];

  let projectTracker: Record<string, unknown> | undefined;
  let projectPreview: Record<string, unknown> | undefined;
  const reposRaw = machine['repos'];
  if (Array.isArray(reposRaw)) {
    effective['repos'] = reposRaw.map((entry) => {
      if (!isObjValue(entry)) return entry;
      const localPath = entry['localPath'];
      if (typeof localPath !== 'string' || localPath === '') return entry;
      const path = projectConfigPath(localPath);
      // A missing project file costs nothing but its fields: the machine
      // entry stands alone, exactly as a legacy entry would. A present but
      // unparseable one reads as empty, the same shrug readConfig gives.
      if (!existsSync(path)) return entry;
      sources.push(path);
      const project = readObjectFile(path) ?? {};
      const merged: Record<string, unknown> = { ...entry };
      for (const field of TEAM_REPO_FIELDS) {
        if (project[field] !== undefined) merged[field] = project[field];
      }
      if (projectTracker === undefined && isObjValue(project['tracker'])) {
        projectTracker = project['tracker'];
      }
      if (projectPreview === undefined && isObjValue(project['preview'])) {
        projectPreview = project['preview'];
      }
      return merged;
    });
  }
  if (projectTracker !== undefined) effective['tracker'] = projectTracker;
  if (projectPreview !== undefined) effective['preview'] = projectPreview;
  return { config: effective as BoardConfigFile, sources };
}

// ── Board directory resolution (lib.sh's layout block) ───────────────────────

type Obj = Record<string, unknown>;

/** jq's `//`: null AND false fall through; "" and 0 are kept. */
function jqAlt(value: unknown): unknown {
  return value === undefined || value === null || value === false ? undefined : value;
}

/** jq's `"\(x)"` (and `jq -r` of a scalar): a string as-is, anything else JSON. */
function jqInterp(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? 'null';
}

/** jq's `ascii_downcase | gsub("[^a-z0-9]+"; "-")` — ASCII letters only. */
function keySlug(name: string): string {
  return name.replace(/[A-Z]/g, (c) => c.toLowerCase()).replace(/[^a-z0-9]+/g, '-');
}

/**
 * lib.sh's project_key: explicit wins, a single configured project is assumed,
 * anything else dies naming the keys — a mutating verb must not guess which
 * board to write (discoverProjects records why a renderer may).
 */
function resolveProjectKey(orch: OrchRoot, env: NodeJS.ProcessEnv): string {
  const envKey = env['SUPERSET_ORCH_PROJECT'];
  if (envKey !== undefined && envKey !== '') return envKey;
  // "No config file at all" keeps meaning 'default', whichever layout —
  // sources is empty exactly when neither the legacy nor the machine file
  // exists, which is the existsSync this check was before the split.
  const loaded = loadConfig(orch, env);
  if (loaded.sources.length === 0) return 'default';
  const config = loaded.config;
  const repos = Array.isArray(config.repos) ? config.repos : [];
  if (repos.length === 1) {
    const repo = repos[0] as Obj;
    const key = jqAlt(repo['key']);
    if (key !== undefined) return jqInterp(key);
    const name = repo['name'];
    if (typeof name === 'string') return keySlug(name);
    // The shell's jq errored here (ascii_downcase on null) and the source
    // aborted; same refusal, with the fix in the message.
    throw new Error(`cannot derive a project key from ${orch.configPath} — set SUPERSET_ORCH_PROJECT`);
  }
  const keys = repos
    .map((repo) => {
      const key = jqAlt((repo as Obj)['key']);
      if (key !== undefined) return jqInterp(key);
      const name = (repo as Obj)['name'];
      return typeof name === 'string' ? keySlug(name) : '';
    })
    .join(', ');
  throw new Error(
    `${repos.length} projects configured — set SUPERSET_ORCH_PROJECT to the one you mean.\n     keys: ${keys}`,
  );
}

/**
 * lib.sh's BOARD_DIR: SUPERSET_ORCH_DIR overrides everything (a one-off
 * board), otherwise $ORCH_ROOT/p/$PROJECT_KEY. The project key is resolved
 * even under the override — lib.sh computes PROJECT_KEY unconditionally at
 * source time, so a two-project config with no selection dies either way —
 * and doubles as the lock error's blame label, the way lib.sh names
 * $PROJECT_KEY there.
 */
export function resolveBoardDir(env: NodeJS.ProcessEnv = process.env): {
  boardDir: string;
  projectKey: string;
} {
  const orch = loadRoot(env);
  const projectKey = resolveProjectKey(orch, env);
  const dirOverride = env['SUPERSET_ORCH_DIR'];
  const boardDir =
    dirOverride !== undefined && dirOverride !== ''
      ? resolve(expandTilde(dirOverride))
      : join(orch.root, 'p', projectKey);
  return { boardDir, projectKey };
}

/**
 * lib.sh's `cfg '.limits.recentlyClosedDays' 7`, over an already-loaded config.
 *
 * The shell version pipes through `jq -r "$filter // empty"` and then tests the
 * output with `[ -n ... ]`, which makes THREE things fall back to the default,
 * and all three are ported: a missing/null value (jq's `//`), an explicit
 * `false` (jq's `//` swallows false too, so a gate set to false reads as its
 * default — the defaults are chosen so that quirk is harmless), and an empty
 * string (jq keeps it, but the shell's -n test cannot see it). `0` survives:
 * jq -r prints "0", which is non-empty.
 *
 * Unlike the shell we hand back the JSON value rather than its string
 * rendering, so numeric limits arrive as numbers.
 */
export function cfg<T>(config: BoardConfigFile, path: string, fallback: T): T {
  const segments = (path.startsWith('.') ? path.slice(1) : path)
    .split('.')
    .filter((s) => s !== '');
  let current: unknown = config;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return fallback;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined || current === null || current === false || current === '') {
    return fallback;
  }
  return current as T;
}
