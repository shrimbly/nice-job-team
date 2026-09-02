// `board doctor` — skills/superset-orchestrator/scripts/preflight.sh as a
// verb: verify everything the orchestrator depends on, seed the board
// directory, and print a READY / BLOCKED verdict. Safe to run every session;
// makes no changes beyond creating directories, writing config.example.json
// and seeding board.json on first run (and quarantining a board that no
// longer parses).
//
// Every NOTE/BLOCKED/line text is verbatim from preflight.sh — the
// orchestrator skill and the operator pattern-match on them. Ported
// differences, all deliberate:
//   - `need_cmd jq` is gone: this CLI is the jq.
//   - preflight.sh seeded config.json itself from the skill's
//     reference/config.example.json; the doctor writes the packaged copy
//     (src/assets/, a test pins the two byte-identical) BESIDE the config as
//     config.example.json instead. Seeding it AS the config planted the
//     example's placeholder repo, and the operator's first `board init
//     --apply` merged the real repo next to it — two projects configured,
//     every verb refusing, and a placeholder localPath blocking the doctor.
//   - the workspaces/ inbox is created at the ROOT (where lib.sh actually
//     reads it), not under $BOARD_DIR — preflight.sh's mkdir put a never-read
//     workspaces/ inside the project directory.
//   - new: a Node >= 20 check. NOTE, not BLOCKED — the CLI is already running,
//     so refusing would be theater.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { loadConfig, loadRoot, resolveBoardDir } from './config.js';
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

/** @tsv's cell rendering: null empty, strings as-is, other scalars as JSON. */
function tsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? '';
}

/** `[ -d ... ]`. */
function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The packaged config.example.json, byte-for-byte (a test pins it to the
 * skill's). Read off disk, NOT `import ... with { type: 'json' }`: the
 * import-attribute syntax only parses from Node 20.10, so on 20.0–20.9 every
 * verb would die loading this module (bin/board misreporting it as a missing
 * build), and through Node 21.x the JSON-module import prints an
 * ExperimentalWarning on every invocation — stderr the implementer skill
 * reads. `import.meta.url` finds the asset next to this file in src (tests)
 * and dist alike; the build copies it into dist verbatim, so the bytes are
 * the reference file's in both.
 */
export function packagedConfigExample(): string {
  return readFileSync(new URL('./assets/config.example.json', import.meta.url), 'utf8');
}

/**
 * atomic_write for a text payload: write-then-rename, refusing emptiness. The
 * tmp name carries the pid so two concurrent doctors lose a race instead of
 * interleaving.
 */
function atomicWriteText(target: string, content: string): void {
  if (content === '') throw new Error(`refusing to write an empty ${target}`);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, target);
}

/** The seed board, exactly as `jq -nc '{version:1, updatedAt:$at, items:[]}'` printed it. */
function emptyBoardText(at: string): string {
  return JSON.stringify({ version: 1, updatedAt: at, items: [] }) + '\n';
}

/**
 * `jq -e .` on a file: exit 0 only when it parses AND the value is neither
 * null nor false. Returns undefined on "invalid" so callers can keep the
 * parsed value when it is valid.
 */
function jqE(file: string): { valid: boolean; json?: unknown } {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { valid: false };
  }
  try {
    const json: unknown = JSON.parse(raw);
    if (json === null || json === false) return { valid: false };
    return { valid: true, json };
  } catch {
    return { valid: false };
  }
}

/**
 * `command -v X` approximated through the seam: spawn-failure comes back as
 * status 127 from realPollIo (a real tool exiting 127 is conflated, which no
 * CLI here does). The probe runs `--version` where command -v only looked —
 * the price of keeping every external touch behind io.exec.
 */
function missing(result: ExecResult): boolean {
  return result.status === 127;
}

// ── The op ────────────────────────────────────────────────────────────────────

export interface DoctorDeps {
  io: PollIo;
  orch: OrchRoot;
  boardDir: string;
  /** Defaults to the running process's — injectable so a test can age it. */
  nodeVersion?: string;
}

export interface DoctorResult {
  /** Everything preflight.sh printed to stdout, verdict included, in order. */
  lines: string[];
  /** false is exit 1 — at least one BLOCKED. */
  ready: boolean;
}

export function doctor(deps: DoctorDeps): DoctorResult {
  const { io, orch, boardDir } = deps;
  const configPath = orch.configPath;
  const boardFile = join(boardDir, 'board.json');
  const lines: string[] = [];
  const problems: string[] = [];
  const notes: string[] = [];

  // need_cmd git — jq's need_cmd is gone (this CLI is the jq). Dies before any
  // output, as lib.sh's die did.
  if (missing(io.exec('git', ['--version']))) throw new Error('missing command: git');

  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const nodeMajor = Number.parseInt(nodeVersion.split('.')[0] ?? '', 10);
  if (Number.isFinite(nodeMajor) && nodeMajor < 20) {
    notes.push(`running on Node ${nodeVersion} — this CLI needs Node >= 20`);
  }

  // ── board directory ─────────────────────────────────────────────────────────
  mkdirSync(join(boardDir, 'briefs'), { recursive: true });
  mkdirSync(join(boardDir, 'signals'), { recursive: true });
  mkdirSync(orch.workspacesDir, { recursive: true });
  // The split layout: when the machine + project files ARE the config (a
  // migrated setup has no legacy file), seeding a legacy config.json here
  // would create a file that WINS over them and silently change a working
  // board.
  const loaded = loadConfig(orch, io.env);
  const splitOnly = !existsSync(configPath) && loaded.sources.length > 0;
  if (splitOnly) {
    notes.push(`reading the split config (${loaded.sources.join(', ')}) — no legacy config.json seeded`);
  }
  const configured = existsSync(configPath) || splitOnly;
  if (!configured) {
    // No config in either layout. Seeding config.json from the example here
    // used to plant its placeholder repo (acme/platform), which the first
    // `board init --apply` then MERGED the real repo next to — every verb
    // after that refused ("2 projects configured"), the placeholder blocked
    // the doctor forever, and its issues fed the backlog. The example lands
    // BESIDE the config as a reference instead, so init's entry is the only
    // repo — and no board.json is invented for the phantom p/default project
    // before a repo exists to key one.
    const examplePath = join(orch.root, 'config.example.json');
    if (!existsSync(examplePath)) atomicWriteText(examplePath, packagedConfigExample());
    notes.push(
      `no config yet — wrote a reference ${examplePath}; run board init (the superset-setup skill drives it) to configure a repo`,
    );
  }
  if (configured && !existsSync(boardFile)) {
    atomicWriteText(boardFile, emptyBoardText(io.now()));
    notes.push(`created an empty board at ${boardFile}`);
  }
  if (existsSync(configPath) && !jqE(configPath).valid) {
    problems.push("config.json is not valid JSON — fix it by hand, it holds the operator's settings");
  }
  // An unreadable board is recoverable: keep the corpse, start a clean one, and
  // say so loudly. Items can be re-sensed; a stuck orchestrator cannot do
  // anything at all.
  if (existsSync(boardFile) && !jqE(boardFile).valid) {
    // date -u +%Y%m%dT%H%M%SZ, derived from io.now() so tests can pin it.
    const stamp = io.now().replace(/[-:]/g, '');
    const bak = `${boardFile}.broken.${stamp}`;
    renameSync(boardFile, bak);
    atomicWriteText(boardFile, emptyBoardText(io.now()));
    notes.push(
      `board.json was empty or invalid — moved to ${bak} and started a clean board; re-run SENSE to rebuild it, and reconcile against live workspaces before dispatching`,
    );
  }

  // ── superset cli ────────────────────────────────────────────────────────────
  const { cmd: supersetCmd, env: supersetEnv } = supersetCommand(io);
  const version = io.exec(supersetCmd, ['--version'], { env: supersetEnv });
  if (!missing(version)) {
    // `superset --version 2>&1 | head -1` — stdout first, stderr as fallback.
    const merged = version.stdout !== '' ? version.stdout : version.stderr;
    lines.push(`superset:   ${merged.split('\n')[0] ?? ''}`);
    // One whoami where the shell ran two (superset_authed, then $who) — same
    // answer unless the login raced the poll, which nothing depends on.
    const whoResult = io.exec(supersetCmd, ['auth', 'whoami', '--json'], { env: supersetEnv });
    if (whoResult.status === 0) {
      // The shell piped $who through `jq -r '.email // "?"'`: an object
      // indexes, a null falls to "?", and anything else made jq error and the
      // substitution come back empty. Ported shape for shape.
      let email = '';
      let org = '';
      try {
        const parsed: unknown = JSON.parse(whoResult.stdout);
        if (isObj(parsed)) {
          email = jqInterp(jqAlt(parsed['email']) ?? '?');
          org = jqInterp(
            jqAlt(parsed['organizationName']) ?? jqAlt(parsed['organizationId']) ?? '?',
          );
        } else if (parsed === null) {
          email = '?';
          org = '?';
        }
      } catch {
        // unparseable whoami: both substitutions printed nothing
      }
      lines.push(`account:    ${email} (org ${org})`);
      const stResult = io.exec(supersetCmd, ['status', '--json'], { env: supersetEnv });
      let st: Obj = {};
      if (stResult.status === 0) {
        try {
          const parsed: unknown = JSON.parse(stResult.stdout);
          if (isObj(parsed)) st = parsed;
        } catch {
          // `jq -r '.running // false'` over garbage printed nothing ≠ "true"
        }
      }
      if (jqInterp(jqAlt(st['running']) ?? false) === 'true') {
        const pid = jqInterp(jqAlt(st['pid']) ?? '?');
        const port = jqInterp(jqAlt(st['port']) ?? '?');
        lines.push(`host:       running (pid ${pid}, port ${port})`);
      } else {
        notes.push("host service is not running — 'superset start --daemon' before dispatching");
      }
    } else {
      problems.push(
        "not logged in — the operator must run: superset auth login  (browser OAuth; the desktop app's session does not count)",
      );
    }
  } else {
    problems.push('superset CLI not found (expected ~/.superset/bin/superset)');
  }

  // ── github ──────────────────────────────────────────────────────────────────
  const ghAuth = io.exec('gh', ['auth', 'status']);
  if (missing(ghAuth)) {
    problems.push('gh CLI not found');
  } else if (ghAuth.status === 0) {
    const login = io.exec('gh', ['api', 'user', '--jq', '.login']);
    lines.push(
      `github:     ${login.status === 0 ? login.stdout.replace(/\n+$/, '') : '?'}`,
    );
  } else {
    problems.push('gh is not authenticated — run: gh auth login');
  }

  // ── repos in config ─────────────────────────────────────────────────────────
  // The legacy file when it exists (it wins, and its quirks are the shell's);
  // otherwise the split loader's effective merge, so a migrated setup still
  // gets its repos checked.
  const legacy = jqE(configPath);
  const config: { valid: boolean; json?: unknown } = legacy.valid
    ? legacy
    : splitOnly
      ? { valid: true, json: loaded.config }
      : legacy;
  for (const row of repoRows(config.valid ? config.json : undefined)) {
    if (row.name === '') continue;
    let line = `repo:       ${row.name}`;
    if (row.path !== '' && isDir(join(row.path, '.git'))) {
      line += '  clone ok';
    } else {
      problems.push(`repo ${row.name}: localPath '${row.path}' is not a git clone`);
    }
    if (row.proj !== '') {
      line += `  project ${row.proj}`;
    } else {
      notes.push(
        `repo ${row.name} has no supersetProjectId — get it from: superset projects list --local --json`,
      );
    }
    if (firstReviewer(config.json, row.name) === '') {
      notes.push(`repo ${row.name} has no default reviewer configured — PRs will open unassigned`);
    }
    lines.push(line);
  }

  // ── board summary ───────────────────────────────────────────────────────────
  if (existsSync(boardFile)) {
    const counts = boardSummaryCounts(boardFile);
    lines.push(`board:      ${counts.total} items (${counts.active} active)`);
  }
  lines.push(`status files: ${statusFileCount(orch.workspacesDir)}`);

  // ── verdict ─────────────────────────────────────────────────────────────────
  lines.push('');
  for (const n of notes) lines.push(`NOTE: ${n}`);
  if (problems.length > 0) {
    for (const p of problems) lines.push(`BLOCKED: ${p}`);
    return { lines, ready: false };
  }
  lines.push('READY');
  return { lines, ready: true };
}

// ── repo rows ─────────────────────────────────────────────────────────────────

interface RepoRow {
  name: string;
  path: string;
  proj: string;
}

/**
 * `jq -r '.repos[]? | [.name, .localPath, .supersetProjectId] | @tsv'` fed a
 * while-read loop through process substitution: rows streamed, so a scalar
 * element killed jq mid-stream and the loop kept only the rows already
 * printed. A null element rendered three empty cells and got skipped by the
 * `[ -z "$name" ]` guard.
 */
function repoRows(root: unknown): RepoRow[] {
  if (!isObj(root)) return []; // `.repos` on a scalar root errored: no rows
  const repos = root['repos'];
  const iter = Array.isArray(repos) ? repos : isObj(repos) ? Object.values(repos) : [];
  const rows: RepoRow[] = [];
  for (const el of iter) {
    if (el === null || el === undefined) {
      rows.push({ name: '', path: '', proj: '' });
      continue;
    }
    if (!isObj(el)) break; // `.name` on a scalar: jq died here
    rows.push({
      name: tsvCell(el['name']),
      path: tsvCell(el['localPath']),
      proj: tsvCell(el['supersetProjectId']),
    });
  }
  return rows;
}

/** repo_cfg's `.reviewers[0] // empty` for one repo name — "" when unset. */
function firstReviewer(root: unknown, name: string): string {
  if (!isObj(root)) return '';
  const repos = root['repos'];
  const iter = Array.isArray(repos) ? repos : isObj(repos) ? Object.values(repos) : [];
  for (const el of iter) {
    if (!isObj(el) || el['name'] !== name) continue;
    const reviewers = el['reviewers'];
    const first = Array.isArray(reviewers) ? jqAlt(reviewers[0]) : undefined;
    if (first !== undefined) return jqInterp(first);
  }
  return '';
}

// ── board summary counts ──────────────────────────────────────────────────────

const ACTIVE_STATES = new Set(['dispatched', 'building', 'awaiting-approval', 'fixing', 'pr-open']);

/**
 * The closing printf's two jq substitutions, quirks intact: the board here is
 * only parse-checked (jq -e .), not shape-checked, so `[.items[]?] | length`
 * over a scalar root printed nothing, and `select(.state|...)` over a scalar
 * item killed the active count alone — "3 items ( active)".
 */
function boardSummaryCounts(file: string): { total: string; active: string } {
  let root: unknown;
  try {
    root = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { total: '', active: '' };
  }
  if (!isObj(root)) {
    if (root === null) return { total: '0', active: '0' }; // null.items → null → []? → nothing
    return { total: '', active: '' };
  }
  const items = root['items'];
  const iter = Array.isArray(items) ? items : isObj(items) ? Object.values(items) : [];
  let active = 0;
  let activeText: string | undefined;
  for (const el of iter) {
    if (el === null || el === undefined) continue; // null.state → null, not IN
    if (!isObj(el)) {
      activeText = ''; // `.state` on a scalar: that jq failed whole
      break;
    }
    const state = el['state'];
    if (typeof state === 'string' && ACTIVE_STATES.has(state)) active += 1;
  }
  return { total: String(iter.length), active: activeText ?? String(active) };
}

/** `ls -1 "$WORKSPACES_DIR"/*.json | wc -l` — 0 when the glob matched nothing. */
function statusFileCount(workspacesDir: string): number {
  try {
    return readdirSync(workspacesDir).filter((name) => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

// ── argv surface ──────────────────────────────────────────────────────────────

function die(message: string): never {
  process.stderr.write(`BLOCKED: ${message}\n`);
  process.exit(1);
}

/**
 * `board doctor` — no flags; SUPERSET_ORCH_ROOT / SUPERSET_ORCH_DIR /
 * SUPERSET_ORCH_PROJECT select the layout, exactly as they did for the shell.
 * Exit 0 on READY, 1 on BLOCKED (or on lib.sh-style die).
 */
export function runDoctor(argv: string[]): void {
  if (argv.length > 0) die(`unknown argument: ${argv[0]}`);
  try {
    const orch = loadRoot();
    // Resolved BEFORE seeding, like lib.sh sourcing before preflight ran: the
    // very first doctor on a machine lands on p/default, and the next run —
    // config now seeded — lands on the configured repo's key.
    const { boardDir } = resolveBoardDir();
    const result = doctor({ io: realPollIo(), orch, boardDir });
    for (const line of result.lines) console.log(line);
    if (!result.ready) process.exit(1);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
}
