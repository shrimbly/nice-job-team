// The board's write path, ported from lib.sh: the shlock-compatible lock, the
// board_validate shape checks, atomic_json's validate-then-rename write, and
// log_event. Until P3 retires the bash scripts, BOTH sides write board.json —
// reap.sh and dispatch.sh through lib.sh's board_lock/shlock, this module
// through lockBoard — so the lock file's format and semantics here must match
// shlock byte for byte or the two writers stop excluding each other.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { BoardDoc, ReadResult } from './types.js';
import { readBoardItems } from './read.js';

type Obj = Record<string, unknown>;

/** jq's `type == "object"`: arrays are their own type, and null is not one. */
function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** lib.sh's now(): `date -u +%Y-%m-%dT%H:%M:%SZ` — ISO seconds, no millis. */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ── Board lock ────────────────────────────────────────────────────────────────
// lib.sh's board_lock, which wraps macOS shlock: the lock is $BOARD_DIR/
// board.lock holding the owner's pid and a trailing newline; a lock whose pid
// is no longer running is cleared and claimed; a held lock is polled every
// 200ms, and after 50 waits (10s) the caller dies naming the holder. The bash
// side reads our pid with shlock and we read shlock's with kill(pid, 0), which
// is how the two implementations mutually exclude.

const LOCK_POLL_MS = 200;
/** lib.sh dies when its wait counter passes 50 — 50 sleeps of 0.2s = 10s. */
const LOCK_MAX_WAITS = 50;

function lockPath(boardDir: string): string {
  return join(boardDir, 'board.lock');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * kill(pid, 0), shlock's liveness probe. EPERM means the process exists but
 * belongs to someone else — alive, and very much still holding the lock.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * One O_EXCL creation attempt. 'wx' is open(O_WRONLY|O_CREAT|O_EXCL): the
 * creation is the atomic part, exactly one contender wins it.
 */
function tryAcquire(lockFile: string): boolean {
  try {
    // shlock's file format: the pid in decimal, then a newline. bash's
    // board_lock `cat`s this into its error message, so the newline matters.
    writeFileSync(lockFile, `${process.pid}\n`, { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/** The lock file's content, split into "a parseable pid" and "what cat prints". */
function lockHolder(lockFile: string): { pid?: number; raw?: string; missing?: boolean } {
  let raw: string;
  try {
    raw = readFileSync(lockFile, 'utf8');
  } catch {
    return { missing: true };
  }
  const text = raw.replace(/\n+$/, '');
  // shlock treats a non-positive or non-numeric pid as an invalid lock.
  const pid = /^[0-9]+$/.test(text) && Number(text) > 0 ? Number(text) : undefined;
  return { pid, raw: text };
}

/**
 * Take the board lock, or die after 10s the way lib.sh's board_lock does.
 * `label` is what the error blames — lib.sh names $PROJECT_KEY there; callers
 * that know their project key should pass it, and the board directory is the
 * honest default for ones that don't.
 */
export async function lockBoard(boardDir: string, label?: string): Promise<void> {
  const lockFile = lockPath(boardDir);
  let waited = 0;
  for (;;) {
    if (tryAcquire(lockFile)) return;
    const holder = lockHolder(lockFile);
    if (!holder.missing && (holder.pid === undefined || !pidAlive(holder.pid))) {
      // Stale (dead pid) or garbage content: clear it and claim. This is
      // shlock's DOCUMENTED behaviour and lib.sh's stated intent ("clears a
      // lock whose process is gone") — though the shlock macOS actually ships
      // never takes this path: its someone-else-recreated-it guard compares
      // the lock's ctime against an uninitialized 0 and always trips, so the
      // bash side blocks 10s and dies on a stale lock. Clearing here is
      // strictly compatible: we only ever remove a lock whose holder is dead.
      //
      // The clearing is the dangerous part: two contenders that both read the
      // stale content and both unlinked could each pass a re-read check, and
      // the slower unlink then swept the faster one's freshly ACQUIRED lock —
      // two writers inside writeBoard at once, the exact silent lost-update
      // the lock exists to prevent. (Grabbing the file by atomic rename does
      // not close this either: a breaker acting on a stale read can capture a
      // just-acquired LIVE lock, and a fuzz run caught it doing so.) So
      // breakers serialize on an O_EXCL guard file, and only the guard holder
      // re-checks and unlinks: under the guard the recorded holder is dead (a
      // dead holder cannot release, an acquirer needs the file gone first,
      // and every other breaker is excluded), so nothing can swap the lock
      // between the guarded re-check and the unlink.
      const guard = `${lockFile}.break`;
      let guarded = false;
      try {
        writeFileSync(guard, `${process.pid}\n`, { flag: 'wx' });
        guarded = true;
      } catch {
        // Another breaker holds the guard — or a crashed one left it behind.
        // A guard whose pid is dead is itself stale and gets swept, so a
        // crash mid-break costs one extra round, never the 10s timeout.
        const g = lockHolder(guard);
        if (!g.missing && (g.pid === undefined || !pidAlive(g.pid))) {
          try {
            unlinkSync(guard);
          } catch {
            // already gone
          }
        }
      }
      if (guarded) {
        try {
          // Deadness is re-judged under the guard rather than comparing raw
          // content: what matters is that no LIVE holder's lock can be swept,
          // and one stale lock replacing another is still just stale.
          const again = lockHolder(lockFile);
          if (!again.missing && (again.pid === undefined || !pidAlive(again.pid))) {
            try {
              unlinkSync(lockFile);
            } catch {
              // already gone
            }
          }
        } finally {
          try {
            unlinkSync(guard);
          } catch {
            // already gone
          }
        }
      }
    }
    // Every failed round counts toward the 10s cap — lib.sh's board_lock died
    // naming the holder in EVERY held-lock case, so a stale path that cannot
    // make progress (an unwritable board dir, a lock endlessly re-created)
    // must wedge loudly at 10s, not spin forever. The vanished-holder case
    // lands here too: one poll interval is cheap, an unbounded loop is not.
    waited += 1;
    if (waited > LOCK_MAX_WAITS) {
      // lib.sh: `cat "$BOARD_LOCK" || echo '?'` — the content as-is at die
      // time, which may have changed hands since we started waiting.
      const now = lockHolder(lockFile);
      const pidText = now.missing ? '?' : (now.raw ?? '?');
      throw new Error(
        `board is locked by pid ${pidText} after 10s — another orchestrator is writing to ${label ?? boardDir}`,
      );
    }
    await sleep(LOCK_POLL_MS);
  }
}

/** lib.sh's board_unlock: rm -f, no ownership check — ported as-is. */
export function unlockBoard(boardDir: string): void {
  try {
    unlinkSync(lockPath(boardDir));
  } catch {
    // rm -f: a missing lock is already unlocked
  }
}

// ── board_validate ────────────────────────────────────────────────────────────

/** jq's type names, which several problem strings interpolate verbatim. */
type JqType = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';

function jqType(value: unknown): JqType {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  return Array.isArray(value) ? 'array' : 'object';
}

/** jq's tostring: a string is itself, anything else its compact JSON. */
function jqTostring(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? 'null';
}

/** jq's `//`: null AND false fall through; "" and 0 are kept. */
function jqAlt(value: unknown): unknown {
  return value === undefined || value === null || value === false ? undefined : value;
}

/**
 * lib.sh's board_validate, check for check and string for string. Exists
 * because hand-written board edits put a bare number where {number, url?}
 * belongs, and that one field crashed sync.sh's jq for every item at once.
 * Returns one problem per line the shell would have printed; empty means valid.
 */
export function validateBoard(doc: unknown): string[] {
  // `.items?` — on a root that is an array or a scalar the `?` swallows the
  // index error, the jq program yields nothing, and the board "passes". A null
  // root indexes cleanly to null and fails the array check instead. Quirk
  // ported: writeBoard never produces a non-object root, and diverging here
  // would make the two sides disagree over the same file.
  let items: unknown;
  if (doc === undefined || doc === null) items = null;
  else if (isObj(doc)) items = doc['items'] ?? null;
  else return [];

  if (jqType(items) !== 'array') return ['.items is not an array'];

  const problems: string[] = [];
  (items as unknown[]).forEach((it, i) => {
    if (jqType(it) !== 'object') {
      problems.push(`items[${i}] is not an object`);
      return;
    }
    const item = it as Obj;
    // `$it.slug // $it.id // "items[i]" | tostring` — false falls through //
    // like null, and a numeric slug names the item by its number.
    const who = jqTostring(jqAlt(item['slug']) ?? jqAlt(item['id']) ?? `items[${i}]`);

    for (const k of ['id', 'slug', 'title', 'state']) {
      const value = item[k];
      if (jqType(value) !== 'string' || value === '') {
        problems.push(`${who}: ${k} must be a non-empty string`);
      }
    }

    // `($it.pr // null) != null` — pr:false reads as absent, another // quirk.
    const pr = jqAlt(item['pr']);
    if (pr !== undefined) {
      if (jqType(pr) !== 'object') {
        problems.push(`${who}: pr is a ${jqType(pr)} — must be null or {number, url?}`);
      } else {
        const prObj = pr as Obj;
        const number = jqAlt(prObj['number']) ?? null;
        if (jqType(number) !== 'number') {
          problems.push(`${who}: pr.number is ${jqType(number)} — must be a number`);
        } else {
          const url = jqAlt(prObj['url']) ?? null;
          const urlType = jqType(url);
          if (urlType !== 'string' && urlType !== 'null') {
            problems.push(`${who}: pr.url must be a string`);
          }
        }
      }
    }

    const history = jqAlt(item['history']);
    if (history !== undefined) {
      if (jqType(history) !== 'array') {
        problems.push(`${who}: history is not an array`);
      } else {
        (history as unknown[]).forEach((entry, j) => {
          // The jq indexed `.value.at` unguarded, so a number or string entry
          // ABORTED the whole validate (surfacing as "not parseable JSON").
          // Same verdict — invalid — with a problem line instead of a crash;
          // a null entry read `.at` as null and landed here in jq too.
          const fields = isObj(entry) ? entry : {};
          const at = fields['at'];
          const to = fields['to'];
          if (jqType(at) !== 'string' || at === '' || jqType(to) !== 'string' || to === '') {
            problems.push(`${who}: history[${j}] is missing at/to`);
          }
        });
      }
    }
  });
  return problems;
}

// ── Reading the board as a document ───────────────────────────────────────────

/**
 * The raw parse, for the places that must see what the tolerant decode drops —
 * the closing summary counts every item in the file, malformed or not, so the
 * printed numbers match the shell's byte for byte.
 */
export interface RawBoardRead {
  json?: unknown;
  missing?: true;
  error?: string;
}

export function readBoardRaw(file: string): RawBoardRead {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { missing: true };
  }
  try {
    return { json: JSON.parse(raw) as unknown };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * board.json as a whole document: version and updatedAt off the raw parse,
 * items through read.ts's lossy decode — one corrupt item costs that item and
 * a warning, never the file.
 */
export function readBoardDoc(file: string): ReadResult<BoardDoc> {
  const items = readBoardItems(file);
  const doc: BoardDoc = { version: null, updatedAt: null, items: items.value };
  const raw = readBoardRaw(file);
  if (isObj(raw.json)) {
    if (typeof raw.json['version'] === 'number') doc.version = raw.json['version'];
    if (typeof raw.json['updatedAt'] === 'string') doc.updatedAt = raw.json['updatedAt'];
  }
  return { value: doc, warnings: items.warnings };
}

// ── Writing ───────────────────────────────────────────────────────────────────

/**
 * Write-then-rename with atomic_write's guard: a failed producer upstream must
 * not truncate the target, so an empty payload is refused. Signals only — the
 * board goes through writeBoard, which locks and validates.
 */
export function atomicWriteJson(file: string, value: unknown): void {
  const body = JSON.stringify(value, null, 2);
  // JSON.stringify(undefined) is undefined — the "empty payload" of a producer
  // that handed us nothing.
  if (body === undefined || body === '') throw new Error(`refusing to write an empty ${file}`);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, body + '\n');
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // never created, or already renamed
    }
    throw err;
  }
}

/**
 * lib.sh's atomic_json over $BOARD, as a function: lock → read → mutate →
 * bump version → validate → rename, and on a validation failure the original
 * is untouched and the error says whether the damage is new (refused) or
 * predates the write (fix by hand). The version bump precedes validation
 * because the bash bumped the tmp file before board_validate saw it.
 */
export async function writeBoard(
  boardDir: string,
  mutate: (board: Obj) => Obj,
  label?: string,
): Promise<Obj> {
  const file = join(boardDir, 'board.json');
  // Checked before the lock, as atomic_json checks -f before board_lock.
  if (!existsSync(file)) throw new Error(`no such file: ${file}`);
  await lockBoard(boardDir, label);
  try {
    const read = readBoardRaw(file);
    if (read.missing) throw new Error(`no such file: ${file}`);
    if (read.error !== undefined) {
      // The bash surfaced this as "jq edit of $file failed — file left
      // unchanged"; same refusal, named for what actually failed.
      throw new Error(`edit of ${file} failed — not parseable JSON: ${read.error}`);
    }
    if (!isObj(read.json)) {
      // jq died at the version bump on a non-object root; nothing valid ever
      // has one, so refuse before mutate sees it.
      throw new Error(`edit of ${file} failed — root is not an object, file left unchanged`);
    }
    const original = read.json;

    // mutate gets a clone so an in-place editor cannot alias `original` — the
    // already-invalid check below must judge what is on disk, as the bash
    // re-ran board_validate against the untouched file.
    const result = mutate(structuredClone(original));

    // `.version = ((.version // 0) + 1)` — null and false read as 0; a truthy
    // non-number made jq error out and the script die, file unchanged.
    const version = jqAlt(result['version']) ?? 0;
    if (typeof version !== 'number') {
      throw new Error(`edit of ${file} failed — .version is not a number, file left unchanged`);
    }
    result['version'] = version + 1;

    if (validateBoard(result).length > 0) {
      if (validateBoard(original).length > 0) {
        // The damage predates this write, so refusing forever helps nobody:
        // name it.
        throw new Error(
          `board at ${file} was already invalid BEFORE this write — fix it by hand, then retry`,
        );
      }
      throw new Error(`edit would corrupt ${file} — refused, file left unchanged`);
    }

    const tmp = `${file}.${process.pid}.tmp`;
    try {
      // Two-space indent plus trailing newline, jq's own rendering, so a board
      // alternately written by bash and by this module never churns in diffs.
      writeFileSync(tmp, JSON.stringify(result, null, 2) + '\n');
      renameSync(tmp, file);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // never created, or already renamed
      }
      throw err;
    }
    return result;
  } finally {
    unlockBoard(boardDir);
  }
}

// ── log.jsonl ─────────────────────────────────────────────────────────────────

/**
 * lib.sh's log_event: one compact JSON line per event, keys in construction
 * order (at, event, itemId, then each key=value). The shell spelled a null
 * itemId as "-"; both spellings are accepted here. Values are strings because
 * --arg made every one a string — keep it that way so the log stays greppable
 * with one shape.
 */
export function appendLog(
  boardDir: string,
  event: string,
  itemId: string | null,
  kv: Record<string, string> = {},
): void {
  const line: Obj = {
    at: nowIso(),
    event,
    itemId: itemId === '-' || itemId === null ? null : itemId,
    ...kv,
  };
  mkdirSync(boardDir, { recursive: true });
  appendFileSync(join(boardDir, 'log.jsonl'), JSON.stringify(line) + '\n');
}
