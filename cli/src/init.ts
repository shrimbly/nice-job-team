// `board init` — skills/superset-orchestrator/scripts/setup.sh as a verb:
// configure the orchestrator for the repository the caller is standing in.
//
//   board init --show            print what is configured now, change nothing
//   board init --detect          print what can be detected as JSON, change nothing
//   board init --apply [flags]   write without asking (the superset-setup skill
//                                calls this after collecting the answers)
//   board init --apply --split   opt-in: write the machine + project config
//                                files instead of the legacy config.json
//   board init --migrate         split an existing legacy config.json into the
//                                machine + project files, then retire it
//
// setup.sh's interactive path is NOT ported: the superset-setup skill is the
// interviewer now, and it drives --detect/--apply. Every message and the
// --detect JSON shape are verbatim from setup.sh — the skill pattern-matches
// on them — except where a script name inside one had to become the board
// verb ("run setup.sh" → "run board init").
//
// Like setup.sh, this deliberately does NOT resolve a project key on load:
// key resolution refuses when no repo is configured, which is exactly the
// state --apply runs in. Only orch root + config path are used.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  PROJECT_CONFIG_BASENAME,
  TEAM_REPO_FIELDS,
  loadConfig,
  loadRoot,
  machineConfigPath,
  projectConfigPath,
} from './config.js';
import { supersetCommand } from './facts/superset.js';
import { realPollIo } from './ops/poll.js';
import type { ExecResult, OrchRoot, PollIo } from './types.js';

type Obj = Record<string, unknown>;

/** jq's `type == "object"`: arrays are their own type, and null is not one. */
function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** jq's `//`: null AND false fall through; "" and 0 are kept. */
function jqAlt(value: unknown): unknown {
  return value === undefined || value === null || value === false ? undefined : value;
}

/** jq's `"\(x)"` (and `jq -r` of a scalar): a string as-is, anything else JSON. */
function jqInterp(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? 'null';
}

/** `jq -r 'x // empty'` into a shell variable: "" when absent/null/false. */
function orEmpty(value: unknown): string {
  const kept = jqAlt(value);
  return kept === undefined ? '' : jqInterp(kept);
}

/** setup.sh's die(): the message alone on stderr (runInit adds the leading newline). */
export class InitError extends Error {}

function die(message: string): never {
  throw new InitError(message);
}

// ── Deps ──────────────────────────────────────────────────────────────────────

export interface InitDeps {
  io: PollIo;
  orch: OrchRoot;
  /** detect_timezone's `readlink /etc/localtime`; injectable for tests. */
  readlink?: (path: string) => string;
}

export interface InitResult {
  /** say()'s lines, in order. */
  stdout: string[];
}

// ── Tool probes ───────────────────────────────────────────────────────────────

/**
 * `command -v X` approximated through the seam: spawn-failure comes back as
 * status 127. The probe runs `--version` where command -v only looked — the
 * price of keeping every external touch behind io.exec.
 */
function have(io: PollIo, tool: string): boolean {
  if (tool === 'superset') {
    const { cmd, env } = supersetCommand(io);
    return io.exec(cmd, ['--version'], { env }).status !== 127;
  }
  return io.exec(tool, ['--version']).status !== 127;
}

/** require_tools, minus jq (this CLI is the jq). */
function requireTools(io: PollIo): void {
  for (const tool of ['git', 'gh']) {
    if (!have(io, tool)) die(`${tool} is required and is not on PATH.`);
  }
  if (io.exec('gh', ['auth', 'status']).status !== 0) {
    die('gh is not logged in — run: gh auth login');
  }
}

// ── Detection ─────────────────────────────────────────────────────────────────
// Everything here is derived from the checkout the caller is standing in. A
// value that cannot be found comes back empty rather than guessed, so the
// caller can tell "not found" from "found nothing".

/** `"$(cmd ...)"` with `|| true`: stdout minus trailing newlines, "" on failure. */
function sub(result: ExecResult): string {
  return result.status === 0 ? result.stdout.replace(/\n+$/, '') : '';
}

/**
 * gh reads the remote and follows a rename. `gh pr list` does not follow one,
 * and a stale name returns an empty list rather than an error, which reads
 * exactly like "no open PRs" — so the name has to be right here.
 */
export function detectRepo(io: PollIo): string {
  return sub(io.exec('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']));
}

/**
 * The main clone, never a linked worktree: a worktree's checkout disappears
 * under reap, and the branch checks would follow it. In a linked worktree the
 * common dir points into the main clone's .git, so its parent is the clone.
 */
export function detectPath(io: PollIo): string {
  const top = sub(io.exec('git', ['rev-parse', '--show-toplevel']));
  if (top === '') return '';
  const gitDir = sub(io.exec('git', ['rev-parse', '--git-dir']));
  const commonDir = sub(io.exec('git', ['rev-parse', '--git-common-dir']));
  if (gitDir !== commonDir) {
    // The shell's `cd "$common" && pwd` resolved a relative common dir against
    // the caller's cwd; resolve() is the same walk without the chdir.
    return dirname(resolve(commonDir));
  }
  return top;
}

export function detectBase(io: PollIo): string {
  return sub(
    io.exec('gh', ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name']),
  );
}

export function detectLogin(io: PollIo): string {
  return sub(io.exec('gh', ['api', 'user', '-q', '.login']));
}

// `readlink /etc/localtime`, everything through ".../zoneinfo/" stripped (the
// shell's greedy sed); "" when /etc/localtime is not a symlink.
export function detectTimezone(deps: InitDeps): string {
  const readlink = deps.readlink ?? ((path: string) => readlinkSync(path, 'utf8'));
  let target: string;
  try {
    target = readlink('/etc/localtime');
  } catch {
    return '';
  }
  return target.replace(/\n+$/, '').replace(/^.*\/zoneinfo\//, '');
}

/** The Superset project whose repoPath is this clone, or "". */
export function detectSupersetProject(io: PollIo, path: string): string {
  if (!have(io, 'superset')) return '';
  const { cmd, env } = supersetCommand(io);
  if (io.exec(cmd, ['auth', 'whoami', '--json'], { env }).status !== 0) return '';
  const listed = io.exec(cmd, ['projects', 'list', '--local', '--json'], { env });
  if (listed.status !== 0) return '';
  let rows: unknown;
  try {
    rows = JSON.parse(listed.stdout);
  } catch {
    return '';
  }
  const iter = Array.isArray(rows) ? rows : isObj(rows) ? Object.values(rows) : [];
  for (const row of iter) {
    // The shell's jq errored on a scalar row and kept whatever had already
    // streamed; head -1 wanted only the first match anyway.
    if (!isObj(row)) break;
    if (row['repoPath'] !== path) continue;
    const id = jqAlt(row['id']);
    if (id !== undefined) return jqInterp(id);
  }
  return '';
}

/** `tr '[:upper:]' '[:lower:]' | sed 's#[^a-z0-9]\{1,\}#-#g'` — ASCII only. */
export function repoKey(name: string): string {
  return name.replace(/[A-Z]/g, (c) => c.toLowerCase()).replace(/[^a-z0-9]+/g, '-');
}

/** Accepts a slug or any Linear URL; a non-matching string passes through. */
export function linearSlug(value: string): string {
  return value.replace(/^https?:\/\/linear\.app\/([^/]+).*$/, '$1');
}

// ── The tracker ───────────────────────────────────────────────────────────────

/**
 * An empty object when this run collected nothing, so writeConfig leaves any
 * existing block alone — and a config with no block at all keeps meaning
 * Linear. A tracker with no URL given derives one where a canonical URL
 * exists: markdown gets a GitHub blob link built from the repo and its base
 * branch (the tasks are committed, so that URL exists, and it works for a
 * reviewer too — a file:// link only works on the machine that wrote it),
 * github-issues gets the repo's issues URL, and linear gets the workspace's
 * issue URL — an explicit {kind: "linear"} block overrides the implicit
 * default, so writing it without the template would silently drop the ticket
 * links the implicit default had.
 */
function trackerJson(
  existingTrackerPath: string,
  kind: string,
  url: string,
  repo: string,
  base: string,
  linearWorkspace: string,
): Obj {
  if (kind === '') return {};
  // The caller reads tracker.path through the split-aware loader, so a custom
  // path in either layout informs the derived URL; on a first run there is no
  // config yet, which is why the default is applied here rather than upstream.
  const dir = existingTrackerPath !== '' ? existingTrackerPath : '.tasks';
  let issueUrl = url;
  if (issueUrl === '' && kind === 'markdown' && repo !== '') {
    issueUrl = `https://github.com/${repo}/blob/${base !== '' ? base : 'main'}/${dir}/{key}.md`;
  }
  if (issueUrl === '' && kind === 'github-issues' && repo !== '') {
    issueUrl = `https://github.com/${repo}/issues/{key}`;
  }
  if (issueUrl === '' && kind === 'linear' && linearWorkspace !== '') {
    issueUrl = `https://linear.app/${linearWorkspace}/issue/{key}`;
  }
  return issueUrl === '' ? { kind } : { kind, issueUrl };
}

// ── The scout ─────────────────────────────────────────────────────────────────

/**
 * The scout gets copied to the agents directory — skills installers install
 * skills, not subagents. Since P5 the scout ships at the PLUGIN root
 * (`agents/superset-scout.md`), so when $CLAUDE_PLUGIN_ROOT is set that copy
 * is preferred; the legacy skill-dir location ($SUPERSET_ORCH_SKILL_DIR,
 * default ~/.claude/skills/superset-orchestrator, `agents/` inside it) stays
 * as the fallback for pre-plugin installs. The note names the preferred
 * candidate: that is the path a plugin user should go looking at.
 */
export function installScout(deps: InitDeps): string[] {
  const { io } = deps;
  const skillDir =
    orDefault(io.env['SUPERSET_ORCH_SKILL_DIR']) ??
    join(io.homeDir(), '.claude', 'skills', 'superset-orchestrator');
  const agentsDir =
    orDefault(io.env['SUPERSET_ORCH_AGENTS_DIR']) ?? join(io.homeDir(), '.claude', 'agents');
  const pluginRoot = orDefault(io.env['CLAUDE_PLUGIN_ROOT']);
  const candidates =
    pluginRoot !== undefined
      ? [join(pluginRoot, 'agents', 'superset-scout.md'), join(skillDir, 'agents', 'superset-scout.md')]
      : [join(skillDir, 'agents', 'superset-scout.md')];
  const src = candidates.find((path) => existsSync(path));
  if (src === undefined) return [`note: no scout at ${candidates[0]!} — skipping.`];
  mkdirSync(agentsDir, { recursive: true });
  const dest = join(agentsDir, 'superset-scout.md');
  if (existsSync(dest) && sameBytes(src, dest)) {
    return [`scout already current at ${dest}`];
  }
  copyFileSync(src, dest);
  return [`installed the scout to ${dest}`];
}

/** `${VAR:-default}` — unset and "" both take the default. */
function orDefault(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined;
}

/** cmp -s. */
function sameBytes(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

// ── Bundled skills ────────────────────────────────────────────────────────────
// Three skills the workflow leans on, installed from the registry rather than
// vendored — somebody else's work goes stale in a directory nobody checks.
// Global, not project-level: implementation agents work in linked worktrees,
// which are their own directories, so a project-level install in the main
// clone would be invisible to every agent that needs it. `claude-code` is the
// agent name the installer knows; it rejects `claude` and installs nothing.

const BUNDLED_SKILLS = [
  'aminblg/simpleenglish@simple-english',
  'coderabbitai/skills@code-review',
  'jackjin1997/clawforge@clean-code',
];

/** Never fatal: setup has to finish offline — the config is the point. */
export function installSkills(deps: InitDeps): string[] {
  const { io } = deps;
  const lines: string[] = [];
  if (!have(io, 'npx')) {
    lines.push('note: npx not found — skipping the bundled skills. Install them with:');
    for (const pkg of BUNDLED_SKILLS) {
      lines.push(`      npx skills add ${pkg} -g -y -a claude-code`);
    }
    return lines;
  }
  for (const pkg of BUNDLED_SKILLS) {
    const result = io.exec('npx', [
      '-y', 'skills', 'add', pkg, '--global', '--yes', '--agent', 'claude-code',
    ]);
    if (result.status === 0) {
      lines.push(`installed ${pkg}`);
    } else {
      lines.push(`note: could not install ${pkg} — add it later with:`);
      lines.push(`      npx skills add ${pkg} -g -y -a claude-code`);
    }
  }
  return lines;
}

// ── Writing ───────────────────────────────────────────────────────────────────
// One repo at a time, merged. An existing entry keeps any field this run does
// not set, and the other repos are not touched.

export interface Incoming {
  operator: Obj;
  tracker: Obj;
  repo: Obj;
}

/** with_entries(select(.value != null and .value != "" and .value != [])). */
function live(obj: Obj): Obj {
  const out: Obj = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

const REFUSE_INVALID = 'refusing to write invalid JSON.';

export function writeConfig(deps: InitDeps, incoming: Incoming): string[] {
  const { io, orch } = deps;
  const configPath = orch.configPath;
  const lines: string[] = [];
  const repo = jqInterp(incoming.repo['name'] ?? null);

  // An existing key wins over the derivation. The board, the briefs and the
  // log all live in p/<key>/, so re-deriving a key that was set by hand would
  // point this repo at an empty directory and show the project as having no
  // work. `Acme-Org/Acme-Desktop` derives to `acme-org-acme-desktop`, against
  // a real config that says `acme-org-desktop`.
  const raw = readIfNonEmpty(configPath); // [ -s "$CONFIG" ]
  let existingKey = '';
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isObj(parsed) && Array.isArray(parsed['repos'])) {
        for (const el of parsed['repos']) {
          if (!isObj(el) || el['name'] !== repo) continue;
          const key = jqAlt(el['key']);
          if (key !== undefined) {
            existingKey = jqInterp(key);
            break;
          }
        }
      }
    } catch {
      // jq read nothing; the merge below is where the refusal lands
    }
  }
  const key = existingKey !== '' ? existingKey : repoKey(repo);

  mkdirSync(join(orch.root, 'workspaces'), { recursive: true });
  mkdirSync(join(orch.root, 'p', key), { recursive: true });

  // Back up only a config that was already there. A first run has nothing to
  // lose. Timestamp from io.now() (UTC) where the shell used local time — the
  // format, not the zone, is what anything matches on.
  let backup: string | undefined;
  if (raw !== null) {
    backup = `${configPath}.${io.now().replace(/[^0-9]/g, '')}.bak`;
    copyFileSync(configPath, backup);
  } else {
    writeFileSync(configPath, '{}\n');
  }

  // The merge. Any shape jq's program would have errored on — an unparseable
  // file, a scalar root, operator/repos/tracker of the wrong type — left the
  // tmp file empty and hit the same refusal, so they all funnel there.
  let config: Obj;
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (!isObj(parsed)) die(REFUSE_INVALID);
    config = parsed;
  } catch (err) {
    if (err instanceof InitError) throw err;
    die(REFUSE_INVALID);
  }

  // Only non-empty incoming values win, so a re-run that skips a question
  // cannot blank a value that is already set.
  const operatorBase = jqAlt(config['operator']) ?? {};
  if (!isObj(operatorBase)) die(REFUSE_INVALID);
  config['operator'] = { ...operatorBase, ...live(incoming.operator) };

  const reposBase = jqAlt(config['repos']) ?? [];
  if (!Array.isArray(reposBase)) die(REFUSE_INVALID);
  for (const el of reposBase) {
    if (el !== null && el !== undefined && !isObj(el)) die(REFUSE_INVALID); // `.name` on a scalar
  }
  const incomingRepo = live({ ...incoming.repo, key });
  const matches = (el: unknown): el is Obj => isObj(el) && el['name'] === repo;
  config['repos'] = reposBase.some(matches)
    ? reposBase.map((el) => (matches(el) ? { ...el, ...incomingRepo } : el))
    : [...reposBase, incomingRepo];

  config['limits'] = jqAlt(config['limits']) ?? { maxActiveWorkspaces: 4 };
  config['cadence'] = jqAlt(config['cadence']) ?? { watchSeconds: 120 };

  // Only when this run collected one. A config with no tracker block means
  // Linear built from operator.linearWorkspace, which is what every config
  // written before the block existed means — so an absent tracker must stay
  // absent rather than being filled in with a guess.
  if (orEmpty(incoming.tracker['kind']) !== '') {
    const trackerBase = jqAlt(config['tracker']) ?? {};
    if (!isObj(trackerBase)) die(REFUSE_INVALID);
    config['tracker'] = { ...trackerBase, ...live(incoming.tracker) };
  }

  // `.repos | length > 0` — length of null is 0 in jq, so absent refuses too.
  const repos = config['repos'];
  const reposLength = Array.isArray(repos)
    ? repos.length
    : isObj(repos)
      ? Object.keys(repos).length
      : 0;
  if (!(reposLength > 0)) die('refusing to write a config with no repos.');

  const tmp = `${configPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  renameSync(tmp, configPath);

  if (backup !== undefined) lines.push(`previous config saved to ${backup}`);
  lines.push(`wrote ${configPath}`);
  return lines;
}

/** `[ -s file ]` and its content in one probe: null when missing or empty. */
function readIfNonEmpty(path: string): string | null {
  try {
    if (statSync(path).size === 0) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// ── Writing (split layout) ────────────────────────────────────────────────────
// `--apply --split` writes the same Incoming to the two new files instead of
// the legacy one — machine fields to the XDG machine config, team fields to
// <localPath>/.superset-board.json — and says exactly which file got what.
// Opt-in: without --split, writeConfig above runs unchanged.

/** Tolerant object read: undefined for missing, empty, or non-object. */
function readObjectAt(path: string): Obj | undefined {
  const raw = readIfNonEmpty(path);
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isObj(parsed)) return parsed;
  } catch {
    // fall through
  }
  return undefined;
}

/**
 * Deep equality via serialized JSON. JSON.parse and our own writes both keep
 * insertion order, so this recognises a file an identical run already wrote;
 * a same-content-different-order file reads as different, which only costs a
 * refusal that was previously unconditional.
 */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** writeConfig's tmp-and-rename, for a file whose directory already exists. */
function writeJsonAtomic(path: string, body: Obj): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n');
  renameSync(tmp, path);
}

export function writeSplitConfig(deps: InitDeps, incoming: Incoming): string[] {
  const { io, orch } = deps;
  const lines: string[] = [];
  const repoName = jqInterp(incoming.repo['name'] ?? null);
  const localPath = orEmpty(incoming.repo['localPath']);
  if (localPath === '') {
    die(`--split needs a local clone (--path, or run inside one) to place ${PROJECT_CONFIG_BASENAME} in.`);
  }
  const machinePath = machineConfigPath(io.env);
  const projectPath = projectConfigPath(localPath);
  if (!existsSync(dirname(projectPath))) {
    die(`no clone at ${localPath} — cannot write ${PROJECT_CONFIG_BASENAME}.`);
  }

  // An existing key wins, same rule as writeConfig, spread over the two files
  // that may already hold one: the project file's, then the machine entry's,
  // then the derivation.
  const existingProject = readObjectAt(projectPath);
  const machineRaw = readIfNonEmpty(machinePath);
  let machine: Obj = {};
  if (machineRaw !== null) {
    try {
      const parsed: unknown = JSON.parse(machineRaw);
      if (!isObj(parsed)) die(REFUSE_INVALID);
      machine = parsed;
    } catch (err) {
      if (err instanceof InitError) throw err;
      die(REFUSE_INVALID);
    }
  }
  const machineRepos = jqAlt(machine['repos']) ?? [];
  if (!Array.isArray(machineRepos)) die(REFUSE_INVALID);
  const machineMatch = machineRepos.find(
    (el): el is Obj => isObj(el) && el['localPath'] === localPath,
  );
  let key = orEmpty(existingProject?.['key']);
  if (key === '') key = orEmpty(machineMatch?.['key']);
  if (key === '') key = repoKey(repoName);

  mkdirSync(join(orch.root, 'workspaces'), { recursive: true });
  mkdirSync(join(orch.root, 'p', key), { recursive: true });

  // ── the machine file: what is true of this machine and operator ──
  let backup: string | undefined;
  if (machineRaw !== null) {
    backup = `${machinePath}.${io.now().replace(/[^0-9]/g, '')}.bak`;
    copyFileSync(machinePath, backup);
  }
  const operatorBase = jqAlt(machine['operator']) ?? {};
  if (!isObj(operatorBase)) die(REFUSE_INVALID);
  machine['operator'] = { ...operatorBase, ...live(incoming.operator) };
  // An existing stateDir is where the operator's live state already sits;
  // only a first write pins it (to the current root, so nothing moves).
  if (orEmpty(machine['stateDir']) === '') machine['stateDir'] = orch.root;
  // name/key/defaultBase stay in the machine entry too: loadConfig documents
  // the machine entry as the fallback for a missing clone or project file (a
  // re-clone before the file is committed, git clean -fdx), and without a
  // name the poll silently skips the repo and the project vanishes from the
  // board. The project file wins these fields whenever it is present.
  const machineEntry = live({
    name: repoName,
    key,
    defaultBase: incoming.repo['defaultBase'],
    localPath,
    supersetProjectId: incoming.repo['supersetProjectId'],
  });
  machine['repos'] =
    machineMatch !== undefined
      ? machineRepos.map((el) => (el === machineMatch ? { ...machineMatch, ...machineEntry } : el))
      : [...machineRepos, machineEntry];
  machine['limits'] = jqAlt(machine['limits']) ?? { maxActiveWorkspaces: 4 };
  machine['cadence'] = jqAlt(machine['cadence']) ?? { watchSeconds: 120 };

  // ── the project file: what the team shares, committed in the repo ──
  const projectBase: Obj = existingProject ?? {};
  const teamIncoming = live({
    name: repoName,
    defaultBase: incoming.repo['defaultBase'],
    shortName: incoming.repo['shortName'],
    reviewers: incoming.repo['reviewers'],
    key,
  });
  const project: Obj = { ...projectBase, ...teamIncoming };
  if (orEmpty(incoming.tracker['kind']) !== '') {
    const trackerBase = jqAlt(projectBase['tracker']) ?? {};
    if (!isObj(trackerBase)) die(REFUSE_INVALID);
    project['tracker'] = { ...trackerBase, ...live(incoming.tracker) };
  }

  mkdirSync(dirname(machinePath), { recursive: true });
  writeJsonAtomic(machinePath, machine);
  writeJsonAtomic(projectPath, project);

  if (backup !== undefined) lines.push(`previous machine config saved to ${backup}`);
  lines.push(`wrote ${machinePath}`);
  lines.push(`      machine fields: ${Object.keys(machine).join(', ')}`);
  lines.push(`wrote ${projectPath}`);
  lines.push(`      team fields: ${Object.keys(project).join(', ')} — commit this file`);
  if (readIfNonEmpty(orch.configPath) !== null) {
    // Not "run --migrate": migrate refuses over the machine file THIS run
    // just wrote (the legacy config holds settings this run did not collect,
    // so the two would need a merge only the operator can judge). Name the
    // manual step instead of a command that will dead-end.
    lines.push(
      `note: legacy ${orch.configPath} still exists and wins — fold anything it holds that the split files lack into them, then move it aside.`,
    );
  }
  return lines;
}

// ── --migrate ─────────────────────────────────────────────────────────────────
// Reads the legacy config, writes the machine + project files, and renames the
// legacy file out of the way ONLY after both writes land — a crash in the
// middle leaves the legacy file in place and still winning, and re-running is
// the recovery: a split file that already holds exactly what this migrate
// would write is tolerated (that IS the crashed run's write). Refuses when a
// split file exists with anything else in it: merging two configs is the
// operator's judgment call, not this verb's.

export function initMigrate(deps: InitDeps): InitResult {
  const { io, orch } = deps;
  const configPath = orch.configPath;
  const raw = readIfNonEmpty(configPath);
  if (raw === null) die(`no config at ${configPath} — nothing to migrate.`);
  let legacy: Obj;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObj(parsed)) die(`no usable config at ${configPath} — not a JSON object.`);
    legacy = parsed;
  } catch (err) {
    if (err instanceof InitError) throw err;
    die(`no usable config at ${configPath} — not valid JSON.`);
  }

  const machinePath = machineConfigPath(io.env);

  const reposRaw = jqAlt(legacy['repos']) ?? [];
  if (!Array.isArray(reposRaw)) die(REFUSE_INVALID);

  // Partition the top level. tracker and preview are the team's when they are
  // objects; any other shape stays in the machine file so the effective
  // config round-trips exactly.
  const machine: Obj = {};
  const teamTop: Obj = {};
  for (const [k, v] of Object.entries(legacy)) {
    if (k === 'repos') continue;
    if ((k === 'tracker' || k === 'preview') && isObj(v)) teamTop[k] = v;
    else machine[k] = v;
  }
  machine['stateDir'] = orch.root;

  // Partition each repo entry. An entry without a localPath has no clone to
  // commit a project file into, so it stays whole in the machine file — the
  // loader reads machine team fields as the fallback, and nothing is lost.
  interface ProjectWrite {
    path: string;
    body: Obj;
  }
  const projectWrites: ProjectWrite[] = [];
  const machineRepos: unknown[] = [];
  let placedTeamTop = false;
  for (const entry of reposRaw) {
    const localPath = isObj(entry) ? orEmpty(entry['localPath']) : '';
    if (!isObj(entry) || localPath === '') {
      machineRepos.push(entry);
      continue;
    }
    const target = projectConfigPath(localPath);
    if (projectWrites.some((write) => write.path === target)) {
      die(`refusing: two repos share localPath ${localPath}.`);
    }
    if (!existsSync(dirname(target))) {
      die(`no clone at ${localPath} — check out the repo (or fix repos[].localPath) and re-run.`);
    }
    const body: Obj = {};
    const keep: Obj = {};
    for (const [k, v] of Object.entries(entry)) {
      if ((TEAM_REPO_FIELDS as readonly string[]).includes(k)) body[k] = v;
      else keep[k] = v;
    }
    // Identity fields live in BOTH files: loadConfig documents the machine
    // entry as the fallback when the clone (and so the project file) is
    // missing, and a machine entry with no name makes poll skip the repo and
    // the project vanish with no warning. The project file wins these fields
    // whenever it is present, so the effective config is unchanged.
    for (const k of ['name', 'key', 'defaultBase'] as const) {
      if (entry[k] !== undefined) keep[k] = entry[k];
    }
    // The first project file carries the top-level team blocks; the loader
    // takes the first one that defines them, so the two stay in step.
    if (!placedTeamTop) {
      Object.assign(body, teamTop);
      placedTeamTop = true;
    }
    // An existing project file that already holds exactly this body is a
    // crashed previous run's write (the split files land BEFORE the legacy
    // rename), so re-running is the recovery, not a dead end. Anything else
    // is a merge only the operator can judge.
    if (existsSync(target) && !sameJson(readObjectAt(target), body)) {
      die(
        `refusing: ${target} already exists and differs from what --migrate would write — merge it by hand (or move it aside) and re-run.`,
      );
    }
    projectWrites.push({ path: target, body });
    machineRepos.push(keep);
  }
  if (!placedTeamTop) Object.assign(machine, teamTop);
  machine['repos'] = machineRepos;

  // Same recovery rule for the machine config: identical content means a
  // crashed previous run and the migrate proceeds; different content is the
  // operator's to merge — the message names the manual step because every
  // other advertised path out of the both-layouts state used to land here.
  if (existsSync(machinePath) && !sameJson(readObjectAt(machinePath), machine)) {
    die(
      `refusing: ${machinePath} already exists and differs from what --migrate would write — merge the legacy settings into the split files by hand and move ${configPath} aside, or remove ${machinePath} and re-run.`,
    );
  }

  // Both writes land before the legacy file moves.
  mkdirSync(dirname(machinePath), { recursive: true });
  writeJsonAtomic(machinePath, machine);
  for (const write of projectWrites) writeJsonAtomic(write.path, write.body);
  const renamed = `${configPath}.migrated-${io.now().replace(/[^0-9]/g, '')}`;
  renameSync(configPath, renamed);

  const stdout: string[] = [];
  stdout.push(`wrote ${machinePath}`);
  stdout.push(`      machine fields: ${Object.keys(machine).join(', ')}`);
  for (const write of projectWrites) {
    stdout.push(`wrote ${write.path}`);
    stdout.push(`      team fields: ${Object.keys(write.body).join(', ')} — commit this file`);
  }
  stdout.push(`legacy config renamed to ${renamed}`);
  return { stdout };
}

// ── --show ────────────────────────────────────────────────────────────────────

export function initShow(deps: InitDeps): InitResult {
  const configPath = deps.orch.configPath;
  let parsed: unknown;
  if (existsSync(configPath)) {
    try {
      parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      die(`no usable config at ${configPath} — not valid JSON.`);
    }
  } else {
    // A migrated setup has no legacy file; what is configured is the split
    // merge, so that is what --show reports — "no config" was a lie there,
    // and its advice (a plain re-apply) is exactly the write initApply now
    // refuses.
    const loaded = loadConfig(deps.orch, deps.io.env);
    if (loaded.sources.length === 0) {
      die(`no config at ${configPath} — run board init to write one.`);
    }
    parsed = loaded.config;
  }
  const root: Obj = isObj(parsed) ? parsed : {};
  const reposRaw = isObj(parsed) ? root['repos'] : undefined;
  // `.repos[]` — unguarded in the jq, so a config without repos made it die.
  // writeConfig refuses to produce one, which keeps this path theoretical.
  const iter = Array.isArray(reposRaw) ? reposRaw : isObj(reposRaw) ? Object.values(reposRaw) : die(`cannot iterate over .repos in ${configPath}`);
  const repos = iter.map((el) => {
    if (!isObj(el)) die(`cannot index a non-object entry in .repos of ${configPath}`);
    return {
      name: el['name'] ?? null,
      key: el['key'] ?? null,
      shortName: el['shortName'] ?? null,
      localPath: el['localPath'] ?? null,
      defaultBase: el['defaultBase'] ?? null,
      supersetProjectId: el['supersetProjectId'] ?? null,
    };
  });
  const out = {
    operator: root['operator'] ?? null,
    repos,
    limits: root['limits'] ?? null,
    cadence: root['cadence'] ?? null,
  };
  return { stdout: [JSON.stringify(out, null, 2)] };
}

// ── --detect ──────────────────────────────────────────────────────────────────
// Machine-readable, so the setup skill can ask only for what is missing. The
// JSON shape is a contract — verbatim from setup.sh's jq -n.

export function initDetect(deps: InitDeps): InitResult {
  const { io, orch } = deps;
  requireTools(io);
  const dRepo = detectRepo(io);
  const dPath = detectPath(io);
  const dSp = dPath !== '' ? detectSupersetProject(io, dPath) : '';

  // `existing` comes from whichever layout holds the config. Reading only the
  // legacy path made a migrated (split-only) setup report existing: null, and
  // the superset-setup skill — which pattern-matches this JSON — re-interviewed
  // the operator from scratch. configLayout is additive to the contract shape,
  // so the skill can pass --split on a re-apply over a split setup.
  let existing: unknown = null;
  let configLayout: 'legacy' | 'split' | 'none' = 'none';
  if (existsSync(orch.configPath)) {
    configLayout = 'legacy';
    existing = detectExisting(orch.configPath, dRepo);
  } else {
    const loaded = loadConfig(orch, io.env);
    if (loaded.sources.length > 0) {
      configLayout = 'split';
      existing = existingFrom(loaded.config, dRepo);
    }
  }

  const out = {
    detected: {
      repo: dRepo,
      localPath: dPath,
      defaultBase: detectBase(io),
      githubLogin: detectLogin(io),
      timezone: detectTimezone(deps),
      supersetProjectId: dSp,
    },
    // Nothing here can be worked out from the checkout. Ask for these.
    needed: [
      ...(dRepo === '' ? ['repo'] : []),
      ...(dPath === '' ? ['localPath'] : []),
      'linearWorkspace',
      'reviewer',
    ],
    supersetOnPath: have(io, 'superset'),
    configPath: orch.configPath,
    configLayout,
    existing,
  };
  return { stdout: [JSON.stringify(out, null, 2)] };
}

/** `{operator: (.operator // {}), repo: (repos matching $r | first)}`, or null. */
function detectExisting(configPath: string, repoName: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return null; // `|| echo null`
  }
  return existingFrom(parsed, repoName);
}

/** detectExisting over an already-parsed config — the split loader's merge. */
function existingFrom(parsed: unknown, repoName: string): unknown {
  if (!isObj(parsed)) return null; // `.operator` on a scalar killed the jq
  const reposRaw = jqAlt(parsed['repos']) ?? [];
  const iter = Array.isArray(reposRaw) ? reposRaw : isObj(reposRaw) ? Object.values(reposRaw) : [];
  let repo: unknown = null;
  for (const el of iter) {
    if (el === null || el === undefined) continue;
    if (!isObj(el)) return null; // select's `.name` on a scalar killed the jq
    if (el['name'] === repoName) {
      repo = el;
      break;
    }
  }
  return { operator: jqAlt(parsed['operator']) ?? {}, repo };
}

// ── --apply ───────────────────────────────────────────────────────────────────

export interface ApplyOptions {
  repo?: string;
  path?: string;
  base?: string;
  operator?: string;
  name?: string;
  linear?: string;
  timezone?: string;
  reviewer?: string;
  shortName?: string;
  supersetProject?: string;
  tracker?: string;
  trackerUrl?: string;
  scout?: boolean;
  skills?: boolean;
  /** Opt-in: write the machine + project files instead of the legacy one. */
  split?: boolean;
}

export function parseApplyFlags(argv: string[]): ApplyOptions {
  const opts: ApplyOptions = { scout: true, skills: true };
  const takeValue = (i: number): string => {
    const value = argv[i + 1];
    // The shell's unguarded `$2` blew up under set -u; name the flag instead.
    if (value === undefined) die(`${argv[i]} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--repo': opts.repo = takeValue(i); i += 1; break;
      case '--path': opts.path = takeValue(i); i += 1; break;
      case '--base': opts.base = takeValue(i); i += 1; break;
      case '--operator': opts.operator = takeValue(i); i += 1; break;
      case '--name': opts.name = takeValue(i); i += 1; break;
      case '--linear': opts.linear = linearSlug(takeValue(i)); i += 1; break;
      case '--timezone': opts.timezone = takeValue(i); i += 1; break;
      case '--reviewer': opts.reviewer = takeValue(i); i += 1; break;
      case '--short-name': opts.shortName = takeValue(i); i += 1; break;
      case '--superset-project': opts.supersetProject = takeValue(i); i += 1; break;
      case '--tracker': opts.tracker = takeValue(i); i += 1; break;
      case '--tracker-url': opts.trackerUrl = takeValue(i); i += 1; break;
      case '--no-scout': opts.scout = false; break;
      case '--no-skills': opts.skills = false; break;
      case '--split': opts.split = true; break;
      default: die(`unknown flag: ${argv[i]}`);
    }
  }
  return opts;
}

export function initApply(deps: InitDeps, opts: ApplyOptions): InitResult {
  const { io, orch } = deps;
  requireTools(io);
  const repo = opts.repo ?? '';
  if (repo === '') die('--apply needs --repo owner/name');

  // The effective config in whichever layout holds it, read once: the tracker
  // path below, the fresh-install probe and the split-only guard all consult
  // the same load.
  const loaded = loadConfig(orch, io.env);
  // A migrated setup has no legacy file and the split pair IS the config. A
  // plain --apply used to see the absent legacy file as a fresh install and
  // write a brand-new config.json — which loadConfig makes WIN, silently
  // shadowing every split setting this run did not collect (other repos,
  // limits, cloud, the tracker). Refuse instead of resurrecting it.
  if (opts.split !== true && !existsSync(orch.configPath) && loaded.sources.length > 0) {
    die(
      `refusing: this setup reads the split config (${loaded.sources.join(', ')}) and a new ${orch.configPath} would win over it — re-run with --apply --split (or remove the split files first).`,
    );
  }

  // Fill the blanks from the checkout rather than writing empties.
  const path = opts.path !== undefined && opts.path !== '' ? opts.path : detectPath(io);
  const base = opts.base !== undefined && opts.base !== '' ? opts.base : detectBase(io);
  const login =
    opts.operator !== undefined && opts.operator !== '' ? opts.operator : detectLogin(io);
  const tz =
    opts.timezone !== undefined && opts.timezone !== '' ? opts.timezone : detectTimezone(deps);
  let sp = opts.supersetProject ?? '';
  if (sp === '' && path !== '') sp = detectSupersetProject(io, path);

  // The fresh-install default: a first apply that names no tracker gets
  // GitHub Issues — the repo's own backlog, read with the gh this verb already
  // requires, so a new install tracks work with no extra account. FRESH ONLY:
  // an existing config's tracker is the operator's and a re-apply never
  // changes it — including a config with NO block, which means Linear, so
  // filling the block in would silently change the tracker. "Fresh" means the
  // split-aware loader found NO config file in EITHER layout (sources is
  // empty exactly when neither the legacy nor the machine file exists) — the
  // legacy-file-only probe here once let a re-apply on a migrated setup
  // re-default the tracker over whatever the split config said.
  let trackerKind = opts.tracker ?? '';
  if (trackerKind === '' && loaded.sources.length === 0) {
    // Under --split a committed project file may exist before any machine
    // config does (a fresh clone of an already-onboarded repo); its tracker
    // is the team's, so it too suppresses the default.
    const splitFresh =
      opts.split !== true || path === '' || readIfNonEmpty(projectConfigPath(path)) === null;
    if (splitFresh) trackerKind = 'github-issues';
  }

  const short = opts.shortName ?? '';
  const reviewer = opts.reviewer ?? '';
  const incoming: Incoming = {
    operator: {
      githubLogin: login,
      linearName: opts.name ?? '',
      linearWorkspace: opts.linear ?? '',
      timezone: tz,
    },
    tracker: trackerJson(
      orEmpty(loaded.config.tracker?.path),
      trackerKind,
      opts.trackerUrl ?? '',
      repo,
      base,
      opts.linear ?? '',
    ),
    repo: {
      name: repo,
      defaultBase: base,
      localPath: path,
      shortName: short === '' ? (repo.split('/').at(-1) ?? '') : short,
      reviewers: reviewer === '' ? [] : [reviewer],
      supersetProjectId: sp === '' ? null : sp,
    },
  };

  const stdout =
    opts.split === true ? writeSplitConfig(deps, incoming) : writeConfig(deps, incoming);
  if (opts.scout !== false) stdout.push(...installScout(deps));
  if (opts.skills !== false) stdout.push(...installSkills(deps));
  return { stdout };
}

// ── argv surface ──────────────────────────────────────────────────────────────

function liveDeps(): InitDeps {
  return { io: realPollIo(), orch: loadRoot() };
}

/**
 * `board init --show | --detect | --apply <flags>`. Dies the way setup.sh
 * dies: a leading blank line, the message on stderr, exit 1.
 */
export function runInit(argv: string[]): void {
  try {
    let result: InitResult;
    if (argv[0] === '--show') {
      result = initShow(liveDeps());
    } else if (argv[0] === '--detect') {
      result = initDetect(liveDeps());
    } else if (argv[0] === '--apply') {
      result = initApply(liveDeps(), parseApplyFlags(argv.slice(1)));
    } else if (argv[0] === '--migrate') {
      result = initMigrate(liveDeps());
    } else if (argv.length === 0) {
      die(
        'board init is not interactive — the superset-setup skill collects the answers.  (try --show, --detect, or --apply)',
      );
    } else {
      die(`unknown argument: ${argv[0]}  (try --show, --detect, or --apply)`);
    }
    for (const line of result.stdout) console.log(line);
  } catch (err) {
    process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
