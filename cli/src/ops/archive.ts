// `board archive` — skills/superset-orchestrator/scripts/archive.sh, ported
// eligibility rule for eligibility rule: move items terminal (closed /
// rejected / abandoned) for longer than limits.recentlyClosedDays into
// archive.json beside board.json.
//
// A separate verb rather than part of sync on purpose: sync reconciles facts
// and must stay safe to run by hand mid-debugging without rows moving
// underneath you, and removal deserves its own --dry-run. Nothing is deleted:
// terminal states stay for the log, and archive.json is where they stay.
//
// The op works over the RAW parse, not the tolerant item decode — the eligible
// items are copied into archive.json verbatim (plus archivedAt), and decoding
// them first would rewrite an archived item into the decoder's normalized
// shape. Where the shell's jq died on a malformed shape, this throws with the
// file named; where its `|| echo '[]'` swallowed an error, so does this.

import { join } from 'node:path';
import { cfg, loadRoot, readConfig } from '../config.js';
import { appendLog, atomicWriteJson, nowIso, readBoardRaw, writeBoard } from '../store.js';
import { TERMINAL } from '../statemachine.js';
import { resolveBoardDir } from './item.js';

type Obj = Record<string, unknown>;

/** jq's `type == "object"`: arrays are their own type, and null is not one. */
function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** jq's `//`: null AND false fall through; "" and 0 are kept. */
function jqAlt(value: unknown): unknown {
  return value === undefined || value === null || value === false ? undefined : value;
}

/** jq's `"\(x)"`: a string as-is, anything else its compact JSON. */
function jqInterp(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? 'null';
}

/** jq's tostring — what INDEX(.id) keys by. */
function jqTostring(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? 'null';
}

/**
 * jq's `$when < $cutoff` where $cutoff is a string: values sort null < false <
 * true < numbers < strings < arrays < objects, so any scalar non-string is
 * "older than" every cutoff and any array/object never is. ISO-8601 UTC
 * strings compare as times via plain string compare — the whole design leans
 * on that.
 */
function jqLessThanString(when: unknown, cutoff: string): boolean {
  if (typeof when === 'string') return when < cutoff;
  return !Array.isArray(when) && !isObj(when);
}

/**
 * The last poll's live workspace ids: `[.workspaces[]?.id]`, with the shell's
 * `|| echo '[]'` fallback ported faithfully — ONE malformed entry failed the
 * whole jq and the list read as empty, which errs towards archiving, the same
 * blindness poll has when offline.
 */
function liveWorkspaceIds(boardDir: string): unknown[] {
  const read = readBoardRaw(join(boardDir, 'signals', 'workspaces.json'));
  if (read.missing || read.error !== undefined) return [];
  if (!isObj(read.json)) return [];
  const workspaces = read.json['workspaces'];
  // `[]?` swallowed the cannot-iterate error on a non-array; missing → empty.
  if (!Array.isArray(workspaces)) return [];
  const ids: unknown[] = [];
  for (const entry of workspaces) {
    if (entry === null) {
      ids.push(null); // null.id indexes cleanly to null in jq
      continue;
    }
    if (!isObj(entry)) return []; // `.id` on a scalar killed the jq → []
    ids.push(entry['id'] ?? null);
  }
  return ids;
}

/**
 * When the item went terminal: the last history entry that took it there, then
 * the last entry of any kind, then "" — an item with no usable history cannot
 * be dated, so it archives now rather than sitting on the board forever
 * (archive.json keeps it either way).
 */
function terminalAt(item: Obj, boardFile: string): unknown {
  const rawHistory = jqAlt(item['history']) ?? [];
  if (!Array.isArray(rawHistory)) {
    // The jq mapped over a truthy non-array and died, board untouched.
    throw new Error(`board at ${boardFile} is malformed — history is not an array`);
  }
  const entries: (Obj | null)[] = rawHistory.map((entry) => {
    if (entry === null) return null;
    if (!isObj(entry)) {
      throw new Error(`board at ${boardFile} is malformed — history entry is not an object`);
    }
    return entry;
  });
  const terminalEntries = entries.filter((entry) => {
    if (entry === null) return false; // null.to // "" → "" → not terminal
    const to = jqAlt(entry['to']) ?? '';
    return typeof to === 'string' && TERMINAL.has(to);
  });
  const lastTerminal = terminalEntries[terminalEntries.length - 1];
  const dated = lastTerminal === undefined || lastTerminal === null
    ? undefined
    : jqAlt(lastTerminal['at']);
  if (dated !== undefined) return dated;
  const last = entries[entries.length - 1];
  const fallback = last === undefined || last === null ? undefined : jqAlt(last['at']);
  return fallback ?? '';
}

export interface ArchiveOptions {
  /** Say what would move, move nothing. */
  dryRun?: boolean;
  /**
   * limits.recentlyClosedDays as cfg hands it over — the shell passed the
   * config's string through --argjson, so this is Number-coerced here and a
   * non-numeric value refuses to run (the shell's jq died the same way).
   * Default 7.
   */
  days?: unknown;
  /** What a lock timeout blames — lib.sh names $PROJECT_KEY. */
  label?: string;
}

/**
 * archive.sh: judge eligibility on an unlocked read, append to archive.json
 * (INDEX(.id) last-wins, so a crash between the two writes re-archives cleanly
 * on the next run), then delete from the board inside the locked write —
 * re-checking terminal state there, because something may have reactivated the
 * item in between. Returns the lines the script printed to stdout.
 */
export async function archive(boardDir: string, opts: ArchiveOptions = {}): Promise<string[]> {
  const boardFile = join(boardDir, 'board.json');
  const archiveFile = join(boardDir, 'archive.json');

  const daysRaw = opts.days ?? 7;
  const days = Number(daysRaw);
  if (!Number.isFinite(days)) {
    throw new Error(`limits.recentlyClosedDays is not a number: ${String(daysRaw)}`);
  }
  // Messages interpolate the value as cfg printed it, not the coerced number.
  const daysLabel = typeof daysRaw === 'string' ? daysRaw : jqInterp(daysRaw);

  const board = readBoardRaw(boardFile);
  if (board.missing) throw new Error(`no board at ${boardFile}`);
  if (board.error !== undefined) {
    throw new Error(`board at ${boardFile} is not parseable JSON: ${board.error}`);
  }

  // jq's strftime truncates toward zero the same way dropping the millis does.
  const cutoff = new Date(Date.now() - days * 86400 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

  const live = liveWorkspaceIds(boardDir);
  // `.items[]?` — a root or items of the wrong shape yields nothing, silently.
  const rawItems = isObj(board.json) ? board.json['items'] : undefined;
  const items = Array.isArray(rawItems) ? rawItems : [];

  const eligible: Obj[] = [];
  for (const raw of items) {
    if (raw === null) continue; // null.state → null → not terminal
    if (!isObj(raw)) {
      // `.state` on a scalar killed the shell's jq before anything moved.
      throw new Error(`board at ${boardFile} is malformed — items[] holds a non-object`);
    }
    const state = raw['state'];
    if (typeof state !== 'string' || !TERMINAL.has(state)) continue;
    // A terminal item whose workspace still exists stays on the board: sync
    // nags about that stray every cycle, and archiving the item would silence
    // the nag while the worktree leaks.
    const wsid = raw['workspaceId'] ?? null;
    if (wsid !== null && live.some((id) => id === wsid)) continue;
    const when = terminalAt(raw, boardFile);
    if (when === '' || jqLessThanString(when, cutoff)) eligible.push(raw);
  }

  if (eligible.length === 0) {
    return opts.dryRun === true
      ? [`nothing to archive (terminal for < ${daysLabel} days stays on the board)`]
      : [];
  }

  if (opts.dryRun === true) {
    return eligible.map((it) => {
      const name = jqAlt(it['slug']) ?? jqAlt(it['id']) ?? null;
      return `would archive ${jqInterp(name)} — ${jqInterp(it['state'])} for over ${daysLabel} days`;
    });
  }

  const at = nowIso();

  // The archive append. Unlocked, like the shell's atomic_write — the board
  // lock guards the board, and a duplicate id here resolves by INDEX last-wins
  // on the next run. Written pretty rather than the shell's `jq -c` one-liner:
  // a cosmetic divergence, the file is only ever read back as JSON.
  const existing = readBoardRaw(archiveFile);
  if (existing.error !== undefined) {
    // The shell's jq failed and atomic_write refused its empty pipe.
    throw new Error(`archive at ${archiveFile} is not parseable JSON: ${existing.error}`);
  }
  let base: unknown[] = [];
  if (!existing.missing && existing.json !== null && existing.json !== undefined) {
    if (!isObj(existing.json)) {
      throw new Error(`archive at ${archiveFile} is malformed — root is not an object`);
    }
    const baseItems = jqAlt(existing.json['items']);
    if (baseItems !== undefined && !Array.isArray(baseItems)) {
      throw new Error(`archive at ${archiveFile} is malformed — .items is not an array`);
    }
    base = baseItems ?? [];
  }
  // INDEX(.id): keyed by tostring, LAST copy wins, first occurrence keeps the
  // position — a Map reproduces all three.
  const indexed = new Map<string, unknown>();
  for (const row of [...base, ...eligible.map((it) => ({ ...it, archivedAt: at }))]) {
    if (!isObj(row)) {
      throw new Error(`archive at ${archiveFile} is malformed — items[] holds a non-object`);
    }
    indexed.set(jqTostring(row['id'] ?? null), row);
  }
  atomicWriteJson(archiveFile, { updatedAt: at, items: [...indexed.values()] });

  // Eligibility was judged on an unlocked read, so re-check the state inside
  // the locked write: an item something reactivated in between stays on the
  // board (its stale copy in archive.json is overwritten on the next real
  // archive).
  const ids = eligible.map((it) => it['id'] ?? null);
  await writeBoard(
    boardDir,
    (doc) => {
      doc['updatedAt'] = at;
      const current = doc['items'];
      if (!Array.isArray(current)) {
        throw new Error(`edit of ${boardFile} failed — .items is not an array, file left unchanged`);
      }
      doc['items'] = current.filter((it) => {
        if (!isObj(it)) {
          throw new Error(`board at ${boardFile} is malformed — items[] holds a non-object`);
        }
        const inIds = ids.some((id) => id === (it['id'] ?? null));
        const state = it['state'];
        const terminal = typeof state === 'string' && TERMINAL.has(state);
        return !inIds || !terminal;
      });
      return doc;
    },
    opts.label,
  );

  for (const it of eligible) {
    const id = it['id'];
    // `jq -r '.[].id'` printed a missing id as "null" and log_event kept it.
    appendLog(boardDir, 'archived', typeof id === 'string' ? id : jqInterp(id ?? null));
  }
  return [`archived ${eligible.length} item(s) to ${archiveFile}`];
}

// ── argv surface ──────────────────────────────────────────────────────────────

function die(message: string): never {
  process.stderr.write(`BLOCKED: ${message}\n`);
  process.exit(1);
}

/**
 * `board archive [--dry-run]`. Dies the way archive.sh dies — "BLOCKED: ..."
 * on stderr, exit 1 — so wiring it into main.ts's verb switch is one call.
 */
export async function runArchive(argv: string[]): Promise<void> {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else die(`unknown argument: ${arg}`);
  }
  try {
    const { boardDir, projectKey } = resolveBoardDir();
    const config = readConfig(loadRoot());
    const days = cfg<unknown>(config, '.limits.recentlyClosedDays', 7);
    for (const line of await archive(boardDir, { dryRun, days, label: projectKey })) {
      console.log(line);
    }
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
}
