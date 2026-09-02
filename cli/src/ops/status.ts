// `board status` — the implementation agent's status file, replacing
// skills/superset-implementer/scripts/status.sh verb for verb. The status file
// is the agent's only channel back to the orchestrator, so every write here is
// atomic and merges into the existing file; safe to call often, because
// silence reads as a stall.
//
// Message texts are contracts: "gated for approval…" and "blocked, and the
// orchestrator has been told…" are pattern-matched by the implementer skill
// and the operator, so they are verbatim from status.sh. The one sanctioned
// change is the script's own name inside a message — "status.sh init" becomes
// "board status init", and die's "status.sh: " prefix becomes "board status: ".
//
// Everything outside the process goes through the injected io — git and the
// superset CLI alike — so the tests run every verb against temp repositories
// and a stubbed superset, with no live CLI and no network.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { loadRoot } from '../config.js';
import { supersetCommand } from '../facts/superset.js';
import { atomicWriteJson } from '../store.js';
import type { ExecResult, PollIo } from '../types.js';
import { realPollIo } from './poll.js';

type Obj = Record<string, unknown>;

/** jq's `type == "object"`: arrays are their own type, and null is not one. */
function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** jq's `//`: null AND false fall through; "" and 0 are kept. */
function jqAlt(value: unknown): unknown {
  return value === undefined || value === null || value === false ? undefined : value;
}

/** jq's type names, for error texts. */
function jqType(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value === 'object' ? 'object' : typeof value;
}

/** `jq -r` of a scalar: a string as-is, anything else its JSON rendering. */
function jqInterp(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? 'null';
}

/**
 * The states an agent may claim, status.sh's `case` arms in order. The same
 * six strings as statemachine.ts's AGENT_STATES, but that set answers a board
 * question ("does a workspace exist for this item state") and this one is the
 * agent's own vocabulary — a coincidence of membership, not a shared concept,
 * so changing one must never silently change the other.
 */
export const STATUS_FILE_STATES = [
  'building',
  'awaiting-approval',
  'pr-open',
  'fixing',
  'blocked',
  'merged',
] as const;

// ── IO ────────────────────────────────────────────────────────────────────────

/**
 * PollIo plus the working directory: status.sh runs inside the agent's
 * worktree and leans on `pwd` twice (worktree path, id fallback), so the seam
 * must carry cwd or the tests would leak the runner's own directory in.
 */
export interface StatusIo extends PollIo {
  cwd(): string;
}

/** The live io: PollIo's real runners, in this process's working directory. */
export function realStatusIo(): StatusIo {
  return { ...realPollIo(), cwd: () => process.cwd() };
}

/** `$(git …)`: trailing newlines stripped; the fallback on any failure. */
function gitOr(io: StatusIo, args: string[], fallback: string): string {
  const result: ExecResult = io.exec('git', args);
  return result.status === 0 ? result.stdout.replace(/\n+$/, '') : fallback;
}

// ── Which workspace am I? ─────────────────────────────────────────────────────

/**
 * status.sh's resolve_id, three tiers: $SUPERSET_WORKSPACE_ID; else the
 * superset CLI's local workspace whose worktreePath is this repo's toplevel;
 * else a branch-keyed id the orchestrator can reconcile by branch, announced
 * on stderr. The note is returned instead of printed so the argv surface can
 * emit it before the verb runs — resolve_id printed it even when the verb
 * then died, and that ordering is worth keeping (the note explains why the
 * file the verb wanted was never there).
 */
function resolveWorkspaceId(io: StatusIo): { id: string; note: string | null } {
  const envId = io.env['SUPERSET_WORKSPACE_ID'];
  if (envId !== undefined && envId !== '') return { id: envId, note: null };

  const root = gitOr(io, ['rev-parse', '--show-toplevel'], io.cwd());
  const listed = supersetListId(io, root);
  if (listed !== '') return { id: listed, note: null };

  // Last resort: a branch-keyed file the orchestrator can reconcile by branch.
  const branch = gitOr(io, ['rev-parse', '--abbrev-ref', 'HEAD'], 'unknown');
  const id = `branch--${branch.replace(/[/ ]/g, '-')}`;
  return { id, note: `board status: no workspace id; keying by branch (${id})` };
}

/**
 * `superset workspaces list --local --json | jq -r '(. // [])[] |
 * select(.worktreePath==$p) | .id' | head -1 || true` — every failure is "",
 * which sends resolution to the branch key. Quirks ported from that pipeline:
 * jq iterates an object root's values; it ABORTS at the first non-object row,
 * losing any match after it; and only the FIRST match's id counts (head -1),
 * rendered the way jq -r renders it — a null id prints as the string "null".
 */
function supersetListId(io: StatusIo, root: string): string {
  const { cmd, env } = supersetCommand(io);
  const result = io.exec(cmd, ['workspaces', 'list', '--local', '--json'], { env });
  if (result.status !== 0) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return '';
  }
  const kept = jqAlt(parsed) ?? [];
  const rows = Array.isArray(kept) ? kept : isObj(kept) ? Object.values(kept) : [];
  for (const row of rows) {
    // jq: `null | .worktreePath` is null — no match, no error.
    if (row === null) continue;
    if (!isObj(row)) return '';
    if (row['worktreePath'] === root) {
      const id = jqInterp(jqAlt(row['id']) ?? null);
      return id.split('\n')[0]!;
    }
  }
  return '';
}

// ── The file ──────────────────────────────────────────────────────────────────

export interface StatusContext {
  /** The resolved workspace id — also the file's basename. */
  id: string;
  /** The global inbox directory the file lives in. */
  dir: string;
  file: string;
  /** The tier-3 branch-key note for stderr, or null when an id resolved. */
  note: string | null;
}

/**
 * Resolve the id and the file, and create the inbox directory — status.sh did
 * all three before dispatching any verb, so even `board status path` leaves
 * the directory behind.
 *
 * The status inbox is deliberately global: it is keyed by workspace UUID, so
 * this verb needs no knowledge of projects. It therefore hangs off the ROOT,
 * not off SUPERSET_ORCH_DIR — that names one project's board directory
 * (p/<key>), and writing there put the status file somewhere the orchestrator
 * never looks. loadRoot is the CLI's one definition of that root, so agent
 * writes and orchestrator reads resolve the same directory from the same
 * environment.
 */
export function resolveStatusContext(io: StatusIo): StatusContext {
  const dir = loadRoot(io.env).workspacesDir;
  const { id, note } = resolveWorkspaceId(io);
  mkdirSync(dir, { recursive: true });
  return { id, dir, file: join(dir, `${id}.json`), note };
}

// ── the status-file lock ──────────────────────────────────────────────────────
// The read-modify-write here is racy on both sides without it: the Stop hook's
// observe can interleave with a model write running in a background command
// (background commands keep running across Stop), or with a second session in
// the same workspace — the atomic renames prevent torn files, not lost
// updates, and the loser's rename silently reverts the winner. An O_EXCL
// `<file>.lock` serialises them. The two sides yield differently: observe
// DROPS its observation on contention (an observation is the one write always
// safe to skip), while a model write waits briefly and, if the lock never
// frees, proceeds without it — a stall signal like `state blocked` must never
// be dropped, so the worst case degrades to the pre-lock behaviour instead.

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 500;
const LOCK_POLL_MS = 25;

/** Synchronous sleep with no subprocess — Atomics.wait on a throwaway buffer. */
function sleepMs(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* last-resort busy wait */
    }
  }
}

/**
 * One O_EXCL attempt on `<file>.lock`. A holder that died mid-write would
 * otherwise wedge the file forever, so a lock older than LOCK_STALE_MS is
 * stolen — every guarded section is milliseconds long.
 */
function tryLock(file: string): boolean {
  const lock = `${file}.lock`;
  try {
    closeSync(openSync(lock, 'wx'));
    return true;
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
        unlinkSync(lock);
        closeSync(openSync(lock, 'wx'));
        return true;
      }
    } catch {
      // raced the holder's own unlink, or an unreadable dir — treat as held
    }
    return false;
  }
}

function unlock(file: string): void {
  try {
    unlinkSync(`${file}.lock`);
  } catch {
    // already gone (a staleness steal) — nothing to release
  }
}

/** The model-write side: wait up to LOCK_WAIT_MS, then proceed lockless. */
function lockForPatch(file: string): boolean {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (tryLock(file)) return true;
    if (Date.now() >= deadline) return false;
    sleepMs(LOCK_POLL_MS);
  }
}

/**
 * status.sh's patch(): refuse without a file, merge via the edit, always stamp
 * updatedAt (after the edit, so a `set` carrying its own updatedAt loses to
 * the stamp), write atomically. An edit that throws leaves the file untouched,
 * the way a failed jq left the mv never running.
 */
function patchStatus(io: StatusIo, file: string, edit: (doc: Obj) => void): void {
  const locked = lockForPatch(file);
  try {
    patchStatusLocked(io, file, edit);
  } finally {
    if (locked) unlock(file);
  }
}

function patchStatusLocked(io: StatusIo, file: string, edit: (doc: Obj) => void): void {
  if (!existsSync(file)) {
    throw new Error('no status file yet — run: board status init --item <id> --slug <slug>');
  }
  const raw = readFileSync(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `status file at ${file} is not parseable JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // jq assigns paths INTO a null root and produces an object; any other
  // non-object root made the filter error and the write die, file untouched.
  let doc: Obj;
  if (parsed === null) doc = {};
  else if (isObj(parsed)) doc = parsed;
  else throw new Error(`status file at ${file} is not a JSON object — file left unchanged`);
  edit(doc);
  doc['updatedAt'] = io.now();
  // jq's default rendering — two-space indent, trailing newline — which
  // atomicWriteJson already speaks; same tmp-then-rename dance as mktemp+mv.
  atomicWriteJson(file, doc);
}

// ── diffstat ──────────────────────────────────────────────────────────────────

/**
 * status.sh's diffstat(): against the recorded base; zeroes when git cannot
 * answer. Prefer origin/<base>: the local ref drifts behind whenever someone
 * else merges, and a diffstat measured against a stale base reports a change
 * far bigger than it is. An agent quoting that number at its gate is quoting
 * fiction.
 *
 * --numstat, not --shortstat (the prose form needed GNU sed), summed the way
 * the awk summed it: every row counts a file, and a binary file's "-" columns
 * coerce to 0 — never to NaN.
 */
export function diffstat(
  io: StatusIo,
  file: string,
): { files: number; insertions: number; deletions: number } {
  // `jq -r '.baseBranch // "main"' "$FILE" || echo main` — a missing or
  // unparseable file and a null/false/absent field all read as main; an empty
  // string is kept (jq's `//` keeps ""), and then no ref verifies.
  let base = 'main';
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isObj(parsed)) {
      const kept = jqAlt(parsed['baseBranch']);
      if (kept !== undefined) base = jqInterp(kept);
    }
  } catch {
    // fall through to main
  }

  let range: string;
  if (io.exec('git', ['rev-parse', '--verify', '--quiet', `origin/${base}`]).status === 0) {
    range = `origin/${base}...HEAD`;
  } else if (io.exec('git', ['rev-parse', '--verify', '--quiet', base]).status === 0) {
    range = `${base}...HEAD`;
  } else {
    range = 'HEAD';
  }

  // The pipe fed awk whatever stdout git produced, failure or not; awk's END
  // printed zeroes over empty input either way.
  const text = io.exec('git', ['diff', '--numstat', range]).stdout;
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const fields = line.replace(/^[\t ]+/, '').split(/[\t ]+/);
    insertions += awkNum(fields[0] ?? '');
    deletions += awkNum(fields[1] ?? '');
    files += 1;
  }
  return { files, insertions, deletions };
}

/** awk's numeric coercion: the longest numeric prefix, or 0 — so "-" is 0. */
function awkNum(text: string): number {
  const match = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(text);
  return match === null ? 0 : Number(match[0]);
}

/** jq's tonumber over an --arg string; failure died with the file untouched. */
function toNumber(text: string): number {
  const num = Number(text);
  if (text.trim() === '' || !Number.isFinite(num)) {
    throw new Error(`cannot parse '${text}' as a number`);
  }
  return num;
}

// ── Verbs ─────────────────────────────────────────────────────────────────────

/**
 * One `board status <verb>` against an already-resolved context. Returns the
 * stdout lines; throws the die() text (minus the "board status: " prefix the
 * argv surface adds). No argv means `show`, as `${1:-show}` meant it.
 */
export function statusVerb(io: StatusIo, ctx: StatusContext, argv: string[]): string[] {
  const [cmd = 'show', ...args] = argv;
  // A lone "-" as the text argument reads the value from stdin. Long prose on
  // argv is a real hazard, not a convenience: at least one EDR (SentinelOne,
  // observed on the reference machine, 2026-09-02) SIGKILLs any node process
  // whose command line carries a ~1KB argument — silently, before main runs —
  // and the gate summary is exactly the argument that grows past that. stdin
  // is invisible to argv-based heuristics.
  if (args[0] === '-' && ['phase', 'gate', 'ask', 'risk', 'set'].includes(cmd)) {
    args[0] = readFileSync(0, 'utf8').replace(/\n$/, '');
  }
  const file = ctx.file;
  const out: string[] = [];

  switch (cmd) {
    case 'init': {
      let item = '';
      let slug = '';
      let base = '';
      for (let i = 0; i < args.length; i += 2) {
        const flag = args[i]!;
        if (flag !== '--item' && flag !== '--slug' && flag !== '--base') {
          throw new Error(`unknown argument: ${flag}`);
        }
        const value = args[i + 1];
        // set -u killed the script on the unbound $2; same refusal, named.
        if (value === undefined) throw new Error(`${flag} needs a value`);
        if (flag === '--item') item = value;
        else if (flag === '--slug') slug = value;
        else base = value;
      }
      if (base === '') {
        // `git symbolic-ref --short refs/remotes/origin/HEAD | sed 's|^origin/||'
        // || echo main` — pipefail turned a repo without origin/HEAD into main.
        const head = io.exec('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
        base =
          head.status === 0 ? head.stdout.replace(/\n+$/, '').replace(/^origin\//, '') : 'main';
      }
      const doc = {
        version: 1,
        workspaceId: ctx.id,
        itemId: item === '' ? null : item,
        slug: slug === '' ? null : slug,
        branch: gitOr(io, ['rev-parse', '--abbrev-ref', 'HEAD'], 'unknown'),
        baseBranch: base,
        worktreePath: gitOr(io, ['rev-parse', '--show-toplevel'], io.cwd()),
        state: 'building',
        phase: 'orienting',
        updatedAt: io.now(),
        summary: null,
        verification: {},
        diffstat: null,
        risks: [],
        questions: [],
        blockedReason: null,
        pr: { number: null, url: null },
        needsOperator: false,
      };
      // `jq -nc … > "$FILE"`: compact, newline-terminated, a plain truncating
      // write — init is the one verb that never merges, so the bash never made
      // it atomic, and the readers tolerate a torn file anyway. The key order
      // above is jq's construction order; patch preserves it forever after.
      writeFileSync(file, JSON.stringify(doc) + '\n');
      out.push(`initialised ${file}`);
      break;
    }

    case 'phase': {
      if (args.length < 1) throw new Error('phase needs text');
      patchStatus(io, file, (doc) => {
        doc['phase'] = args[0]!;
      });
      break;
    }

    case 'state': {
      if (args.length < 1) throw new Error('state needs a value');
      const state = args[0]!;
      if (!(STATUS_FILE_STATES as readonly string[]).includes(state)) {
        throw new Error(`unknown state: ${state}`);
      }
      const note = args[1] ?? '';
      patchStatus(io, file, (doc) => {
        doc['state'] = state;
        if (note !== '') doc['phase'] = note;
        doc['needsOperator'] = state === 'awaiting-approval' || state === 'blocked';
      });
      break;
    }

    case 'verify': {
      if (args.length < 1) throw new Error('verify needs key=value pairs');
      for (const kv of args) {
        // ${kv%%=*} / ${kv#*=}: split at the FIRST '='; a pair with no '=' put
        // the whole word in both halves. Each pair was its own patch() call —
        // its own read, stamp and rename — kept so a mid-loop failure leaves
        // the earlier pairs applied, exactly as the shell loop did.
        const idx = kv.indexOf('=');
        const key = idx === -1 ? kv : kv.slice(0, idx);
        const value = idx === -1 ? kv : kv.slice(idx + 1);
        patchStatus(io, file, (doc) => {
          const existing = doc['verification'];
          // jq creates an object under a null/absent field; anything else
          // non-object made `.verification[$k] =` error out, file untouched.
          if (existing === undefined || existing === null) doc['verification'] = { [key]: value };
          else if (isObj(existing)) existing[key] = value;
          else throw new Error(`verification in ${file} is not an object — file left unchanged`);
        });
      }
      break;
    }

    case 'risk': {
      if (args.length < 1) throw new Error('risk needs text');
      patchStatus(io, file, (doc) => {
        appendTo(doc, 'risks', args[0]!, file);
      });
      break;
    }

    case 'ask': {
      if (args.length < 1) throw new Error('ask needs a question');
      const question = args[0]!;
      patchStatus(io, file, (doc) => {
        appendTo(doc, 'questions', question, file);
        doc['state'] = 'blocked';
        doc['blockedReason'] = question;
        doc['needsOperator'] = true;
      });
      out.push('blocked, and the orchestrator has been told. Stop working and wait.');
      break;
    }

    case 'gate': {
      if (args.length < 1) throw new Error('gate needs a one-or-two-line summary');
      // `--argjson ds "$(diffstat)"` ran the substitution before patch did its
      // file check, so the stat is measured first here too.
      const ds = diffstat(io, file);
      patchStatus(io, file, (doc) => {
        doc['state'] = 'awaiting-approval';
        doc['summary'] = args[0]!;
        doc['phase'] = 'self-review complete';
        doc['needsOperator'] = true;
        doc['diffstat'] = ds;
      });
      out.push('gated for approval. Do not push and do not open a PR until told to.');
      break;
    }

    case 'pr': {
      if (args.length < 2) throw new Error('pr needs <number> <url>');
      const number = toNumber(args[0]!);
      const url = args[1]!;
      const ds = diffstat(io, file);
      patchStatus(io, file, (doc) => {
        doc['state'] = 'pr-open';
        doc['pr'] = { number, url };
        doc['needsOperator'] = false;
        doc['phase'] = 'awaiting review';
        doc['diffstat'] = ds;
      });
      break;
    }

    case 'clear-questions': {
      patchStatus(io, file, (doc) => {
        doc['questions'] = [];
        doc['blockedReason'] = null;
        doc['needsOperator'] = false;
      });
      break;
    }

    case 'set': {
      if (args.length < 1) throw new Error('set needs a JSON object');
      let patch: unknown;
      try {
        patch = JSON.parse(args[0]!);
      } catch (err) {
        throw new Error(
          `invalid JSON passed to set: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      patchStatus(io, file, (doc) => {
        // jq's `. + $p`: null merges as a no-op (the stamp still lands);
        // any other non-object cannot be added to an object and died.
        if (patch === null) return;
        if (!isObj(patch)) throw new Error(`set needs a JSON object, not ${jqType(patch)}`);
        Object.assign(doc, patch);
      });
      break;
    }

    case 'show': {
      // `[ -f "$FILE" ] && jq . "$FILE" || printf 'no status file at %s\n'` —
      // the || caught a failed jq as well as a missing file, so an unparseable
      // file reports as missing instead of dying. Quirk kept: exit 0 always.
      let parsed: unknown;
      let readable = false;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
        readable = true;
      } catch {
        // missing or unparseable
      }
      if (readable) out.push(JSON.stringify(parsed, null, 2));
      else out.push(`no status file at ${file}`);
      break;
    }

    case 'path': {
      out.push(file);
      break;
    }

    default:
      throw new Error(`unknown command: ${cmd}`);
  }

  return out;
}

/** `.<key> += [$v]`: null/absent grows a fresh array; a non-array died. */
function appendTo(doc: Obj, key: string, value: string, file: string): void {
  const existing = doc[key];
  if (existing === undefined || existing === null) doc[key] = [value];
  else if (Array.isArray(existing)) existing.push(value);
  else throw new Error(`${key} in ${file} is not an array — file left unchanged`);
}

// ── observe ───────────────────────────────────────────────────────────────────

/** The git facts `board status observe` records; every failed probe is null. */
export interface ObservedGit {
  branch: string | null;
  dirty: number | null;
  ahead: number | null;
  head: string | null;
  headCommittedAt: string | null;
}

/** One git probe: trailing-newline-stripped stdout, or null on any failure. */
function probe(io: StatusIo, args: string[]): string | null {
  const result = io.exec('git', args);
  return result.status === 0 ? result.stdout.replace(/\n+$/, '') : null;
}

/**
 * The observed git facts, from cwd. Each probe fails alone — a branch with no
 * upstream still reports its head and dirt with ahead null — so any single
 * git failure costs one null field, never the write.
 */
export function observeGit(io: StatusIo): ObservedGit {
  const branch = probe(io, ['rev-parse', '--abbrev-ref', 'HEAD']);

  // Dirt as a NUMBER of porcelain rows, not a boolean: the readers already
  // speak counts (poll.sh's dirtyFiles), and 0 is a fact where false is a shrug.
  const porcelain = probe(io, ['status', '--porcelain']);
  const dirty =
    porcelain === null
      ? null
      : porcelain.split('\n').filter((line) => line !== '').length;

  // No upstream makes rev-list fail, and null (unknowable) is the honest
  // answer there — 0 would claim "fully pushed" about a branch with no remote.
  const aheadText = probe(io, ['rev-list', '--count', '@{u}..HEAD'])?.trim() ?? null;
  const ahead = aheadText !== null && /^\d+$/.test(aheadText) ? Number(aheadText) : null;

  const head = probe(io, ['rev-parse', '--short', 'HEAD']);

  // %cI carries the committer's own offset; normalise to the UTC Z form every
  // other timestamp in the status file already uses.
  const committed = probe(io, ['log', '-1', '--format=%cI']);
  let headCommittedAt: string | null = null;
  if (committed !== null) {
    const ms = Date.parse(committed);
    if (Number.isFinite(ms)) {
      headCommittedAt = new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
    }
  }

  return { branch, dirty, ahead, head, headCommittedAt };
}

/**
 * `board status observe [--quiet]` — the Stop-hook verb: merge what git can
 * see, and ONLY that — {observedAt, git: {branch, dirty, ahead, head,
 * headCommittedAt}} — into the existing status file, read-modify-write.
 *
 * It must NEVER touch updatedAt, state, phase, summary, questions,
 * needsOperator or any other model-written field — bumping updatedAt would
 * make a stale "fixing" permanently win reconcile's agentFresh rule, because
 * every session Stop would re-stamp the agent's old claim as newer than the
 * PR's latest activity. observe records facts about the agent; it never
 * speaks as the agent.
 *
 * And the whole verb never exits nonzero (nor throws): it runs from the
 * plugin's Stop hook, and a hook that fails blocks the Stop. That is also why
 * a missing status file is exit 0 with no output — observe is a hook, not a
 * verb a human runs, so there is no init nagging — and why a malformed file
 * is left exactly as it lies for reconcile to warn about.
 */
export function observeOp(io: StatusIo, args: string[]): StatusResult {
  const quiet = args.includes('--quiet');
  const silent: StatusResult = { stdout: [], stderr: [] };
  try {
    const ctx = resolveStatusContext(io);
    if (!existsSync(ctx.file)) return silent;

    // Yield on contention, never wait: a model write (a background `board
    // status state blocked` outliving the Stop, a second session's patch)
    // must win, and an observation is the one write always safe to skip.
    if (!tryLock(ctx.file)) return silent;
    try {
      // Re-check under the lock: reconcile's prune or reap's rm between the
      // stat above and here would otherwise be resurrected by our rename as a
      // permanent inbox orphan no prune can condemn again.
      if (!existsSync(ctx.file)) return silent;

      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(ctx.file, 'utf8'));
      } catch {
        return silent;
      }
      if (!isObj(parsed)) return silent;

      // Only observe the tree the file describes. SUPERSET_WORKSPACE_ID is
      // inherited by every process started inside the workspace, so a nested
      // session in a DIFFERENT repo (or the agent parked on another branch to
      // compare) reaches here with git facts about the wrong tree — clean by
      // coincidence — and reconcile would read them as proof the work landed.
      // A provable mismatch skips the write; an unanswerable probe (null)
      // proves nothing and the old behaviour stands.
      const git = observeGit(io);
      const toplevel = probe(io, ['rev-parse', '--show-toplevel']);
      const recordedPath = parsed['worktreePath'];
      if (typeof recordedPath === 'string' && toplevel !== null && toplevel !== recordedPath) {
        return silent;
      }
      const recordedBranch = parsed['branch'];
      if (
        typeof recordedBranch === 'string' &&
        git.branch !== null &&
        git.branch !== recordedBranch
      ) {
        return silent;
      }

      parsed['observedAt'] = io.now();
      parsed['git'] = git;
      atomicWriteJson(ctx.file, parsed);
    } finally {
      unlock(ctx.file);
    }

    // One line of trace so a hook log shows the write happened; --quiet is
    // for the shim that wants a wholly silent Stop.
    return { stdout: [], stderr: quiet ? [] : [`observed ${ctx.id.slice(0, 8)}`] };
  } catch {
    // Whatever went wrong (unreadable root, unwritable inbox), a Stop hook
    // reporting it as an exit code would block every session on the machine.
    return silent;
  }
}

// ── One-call surface ──────────────────────────────────────────────────────────

/** stdout and stderr as status.sh emitted them; refusals throw instead. */
export interface StatusResult {
  stdout: string[];
  stderr: string[];
}

/** Resolve, then run one verb — the whole script as a function, for tests. */
export function statusOp(io: StatusIo, argv: string[]): StatusResult {
  // observe routes around statusVerb: it may not throw, and its stderr is its
  // own trace line, never the branch-key note (a hook's noise budget is zero).
  if (argv[0] === 'observe') return observeOp(io, argv.slice(1));
  const ctx = resolveStatusContext(io);
  return { stdout: statusVerb(io, ctx, argv), stderr: ctx.note === null ? [] : [ctx.note] };
}

// ── argv surface ──────────────────────────────────────────────────────────────

/**
 * `board status <verb> …`. Dies the way status.sh's die did — its own name and
 * the message on stderr, exit 1 — with the branch-key note printed before the
 * verb runs, so it still lands when the verb then refuses.
 */
export function runStatus(argv: string[]): void {
  const io = realStatusIo();
  // The Stop-hook verb bypasses the die() path: observeOp swallows every
  // failure itself, so this arm cannot reach process.exit(1) — a hook that
  // exits nonzero blocks the session Stop.
  if (argv[0] === 'observe') {
    for (const line of observeOp(io, argv.slice(1)).stderr) {
      process.stderr.write(`${line}\n`);
    }
    return;
  }
  try {
    const ctx = resolveStatusContext(io);
    if (ctx.note !== null) process.stderr.write(`${ctx.note}\n`);
    for (const line of statusVerb(io, ctx, argv)) console.log(line);
  } catch (err) {
    process.stderr.write(`board status: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
