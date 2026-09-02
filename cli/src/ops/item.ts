// The `board item` verbs — the orchestrator's write path for its own board
// fields. `set` ports skills/superset-orchestrator/scripts/board-set.sh flag
// for flag and refusal for refusal; `add` is a NEW surface (the orchestrator
// has no scripted create today and resorted to inline python — one of those
// one-liners wrote the bare-number pr that board_validate now exists to
// refuse); `list` and `show` are the read conveniences that make the other two
// usable without jq.
//
// The ops throw Error carrying the text the bash die()d with (minus the
// "BLOCKED: " prefix, which the argv entrypoints add); runItem is the argv
// surface, resolving the board directory exactly the way lib.sh does.

import { join } from 'node:path';
import { resolveBoardDir } from '../config.js';
import { readBoardItems } from '../read.js';
import { appendLog, nowIso, readBoardRaw, writeBoard } from '../store.js';
import { applyItemPatch, KNOWN_STATES } from '../statemachine.js';

type Obj = Record<string, unknown>;

/** jq's `type == "object"`: arrays are their own type, and null is not one. */
function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** jq's `//`: null AND false fall through; "" and 0 are kept. */
function jqAlt(value: unknown): unknown {
  return value === undefined || value === null || value === false ? undefined : value;
}

/** jq truthiness, which several summary conditionals use: only null/false lie. */
function jqTruthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

/** jq's `"\(x)"` (and `jq -r` of a scalar): a string as-is, anything else JSON. */
function jqInterp(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? 'null';
}

// ── Board directory resolution (lib.sh's layout block) ───────────────────────

// The single definition lives in config.ts beside loadRoot; re-exported here
// because every op imports it from item.ts since P1, and the import path is
// not worth a churn across the tree.
export { resolveBoardDir };

// ── Shared bits of the write path ─────────────────────────────────────────────

/**
 * The item list a board mutation walks. The bash's `.items[]` died on a null
 * or scalar `.items`; the same write is refused here, before mutate builds a
 * board validateBoard would refuse anyway.
 */
function itemsArray(board: Obj, boardFile: string): unknown[] {
  const items = board['items'];
  if (!Array.isArray(items)) {
    throw new Error(`edit of ${boardFile} failed — .items is not an array, file left unchanged`);
  }
  return items;
}

// ── board item set (board-set.sh) ─────────────────────────────────────────────

/**
 * The flags as board-set.sh took them. Empty string means "not given", because
 * that is the sentinel the shell used; workspaceId is presence-tested instead
 * (`--workspace-id ""` and `--workspace-id null` both mean "clear it").
 */
export interface ItemSetOptions {
  item: string;
  state?: string;
  /** Present (even as null or '') means --workspace-id was given. */
  workspaceId?: string | null;
  pr?: string | number;
  prUrl?: string;
  outcome?: string;
  note?: string;
  /** What a lock timeout blames — lib.sh names $PROJECT_KEY. */
  label?: string;
}

/**
 * board-set.sh: validate, then up to three locked writes — the flat patch with
 * its history-on-state-change (lib.sh's board_set), the pr {number, url} merge
 * against the item's CURRENT pr inside the lock, and the standing-still
 * history entry a note earns — then log_event and the closing summary line(s).
 * Returns the lines the script printed to stdout.
 */
export async function itemSet(boardDir: string, opts: ItemSetOptions): Promise<string[]> {
  const boardFile = join(boardDir, 'board.json');
  const item = opts.item ?? '';
  const state = opts.state ?? '';
  const pr = opts.pr === undefined ? '' : String(opts.pr);
  const prUrl = opts.prUrl ?? '';
  const outcome = opts.outcome ?? '';
  const note = opts.note ?? '';
  const wsidSet = opts.workspaceId !== undefined;
  const wsid = opts.workspaceId ?? '';

  if (item === '') throw new Error('need --item <id>');

  // board_item: the pre-lock read, for cur_state and the pr-number guard. A
  // missing board and a missing item die identically, as they did through the
  // shell's empty command substitution.
  const raw = readBoardRaw(boardFile);
  if (raw.error !== undefined) {
    throw new Error(`board at ${boardFile} is not parseable JSON: ${raw.error}`);
  }
  const rootItems =
    !raw.missing && isObj(raw.json) && Array.isArray(raw.json['items']) ? raw.json['items'] : [];
  const obj = rootItems.find((it): it is Obj => isObj(it) && it['id'] === item);
  if (obj === undefined) throw new Error(`no board item ${item} on ${boardFile}`);
  // `jq -r '.state'` rendered a missing state as the string "null".
  const curStateRaw = obj['state'];
  const curState = typeof curStateRaw === 'string' ? curStateRaw : jqInterp(curStateRaw ?? null);

  if (state !== '' && !(KNOWN_STATES as readonly string[]).includes(state)) {
    throw new Error(`unknown state '${state}' — known states: ${KNOWN_STATES.join(' ')}`);
  }

  if (pr !== '' && !/^[0-9]+$/.test(pr)) {
    throw new Error(`--pr takes the PR number, got '${pr}'`);
  }

  // url without a number is exactly the malformed shape board_validate
  // refuses. The shell read `.pr.number // empty`; on a non-object pr the jq
  // errored and the substitution read as empty — the same refusal either way.
  if (prUrl !== '' && pr === '') {
    const currentPr = obj['pr'];
    const currentNumber = isObj(currentPr) ? jqAlt(currentPr['number']) : undefined;
    if (currentNumber === undefined) {
      throw new Error('--pr-url needs a PR number — pass --pr too (pr must be {number, url?})');
    }
  }

  if (state === '' && outcome === '' && note === '' && pr === '' && prUrl === '' && !wsidSet) {
    throw new Error('nothing to set');
  }

  const patch: Obj = {};
  if (state !== '') patch['state'] = state;
  if (outcome !== '') patch['outcome'] = outcome;
  if (wsidSet) patch['workspaceId'] = wsid === '' || wsid === 'null' ? null : wsid;

  const by = note !== '' ? `board-set: ${note}` : 'board-set';

  if (Object.keys(patch).length > 0) {
    const at = nowIso();
    await writeBoard(
      boardDir,
      (board) => {
        board['updatedAt'] = at;
        board['items'] = itemsArray(board, boardFile).map((it) =>
          isObj(it) && it['id'] === item ? applyItemPatch(it, patch, by, at) : it,
        );
        return board;
      },
      opts.label,
    );
  }

  // The pr fields merge with the item's CURRENT pr object, inside the locked
  // write — merging a copy read before the lock would silently drop whatever a
  // concurrent write put there. The url-without-number guard above is best
  // effort; validateBoard backstops it under the lock either way.
  if (pr !== '' || prUrl !== '') {
    const prpatch: Obj = {};
    if (pr !== '') prpatch['number'] = Number(pr);
    if (prUrl !== '') prpatch['url'] = prUrl;
    const at = nowIso();
    await writeBoard(
      boardDir,
      (board) => {
        board['updatedAt'] = at;
        board['items'] = itemsArray(board, boardFile).map((it) => {
          if (!isObj(it) || it['id'] !== item) return it;
          // `(.pr // {}) + $prpatch` — null and false read as {}; on any other
          // non-object the jq's `+` errored and the write died, file unchanged.
          const existing = jqAlt(it['pr']) ?? {};
          if (!isObj(existing)) {
            throw new Error(`edit of ${boardFile} failed — pr is not an object, file left unchanged`);
          }
          return { ...it, pr: { ...existing, ...prpatch } };
        });
        return board;
      },
      opts.label,
    );
  }

  // A note is worth a history line even when the state stands still —
  // board_set only appends on a state change, so add the standing-still entry
  // here (judged against the state read before the writes, as the shell did).
  if (note !== '' && (state === '' || state === curState)) {
    const at = nowIso();
    await writeBoard(
      boardDir,
      (board) => {
        board['updatedAt'] = at;
        board['items'] = itemsArray(board, boardFile).map((it) => {
          if (!isObj(it) || it['id'] !== item) return it;
          const history = jqAlt(it['history']) ?? [];
          if (!Array.isArray(history)) {
            throw new Error(
              `edit of ${boardFile} failed — history is not an array, file left unchanged`,
            );
          }
          const now = it['state'] ?? null;
          return { ...it, history: [...history, { at, from: now, to: now, by }] };
        });
        return board;
      },
      opts.label,
    );
  }

  const kv: Record<string, string> = {};
  if (state !== '') kv['state'] = state;
  if (pr !== '') kv['pr'] = pr;
  if (note !== '') kv['note'] = note;
  appendLog(boardDir, 'board-set', item, kv);

  // The closing summary, from the final board — every matching item, the way
  // the script's `jq -r` printed one line per match.
  const finalRead = readBoardRaw(boardFile);
  const lines: string[] = [];
  if (isObj(finalRead.json) && Array.isArray(finalRead.json['items'])) {
    for (const it of finalRead.json['items']) {
      if (!isObj(it) || it['id'] !== item) continue;
      lines.push(summaryLine(it));
    }
  }
  return lines;
}

/** `"<slug // id>: <state>" + " ws=<8>"? + " pr=#<n>"?` — jq truthiness gates. */
function summaryLine(it: Obj): string {
  const name = jqAlt(it['slug']) ?? jqAlt(it['id']) ?? null;
  let line = `${jqInterp(name)}: ${jqInterp(it['state'] ?? null)}`;
  const ws = it['workspaceId'];
  if (jqTruthy(ws)) {
    line += ` ws=${(typeof ws === 'string' ? ws : jqInterp(ws)).slice(0, 8)}`;
  }
  const prRef = it['pr'];
  const num = isObj(prRef) ? prRef['number'] : undefined;
  if (jqTruthy(num)) line += ` pr=#${jqInterp(num)}`;
  return line;
}

// ── board item add ────────────────────────────────────────────────────────────

export interface ItemAddOptions {
  slug: string;
  title: string;
  repo?: string;
  branch?: string;
  /** The PR base — lands as the item's baseBranch. */
  base?: string;
  sourceKind?: string;
  sourceId?: string;
  outcome?: string;
  priority?: string;
  domain?: string;
  label?: string;
}

/**
 * Create one item, state `proposed`, validated and locked like any write. The
 * id continues the board's itm_<n> numbering (max + 1, counting archive.json
 * too — reusing an archived number would make the next archive's INDEX(.id)
 * clobber the old item's record) and falls back to itm_<slug> on a board with
 * no numbered items. The history seed carries at/to/by only: there is no
 * `from` before a first state, and history entries need only at/to.
 */
export async function itemAdd(boardDir: string, opts: ItemAddOptions): Promise<string[]> {
  const boardFile = join(boardDir, 'board.json');
  const slug = opts.slug ?? '';
  const title = opts.title ?? '';
  if (slug === '' || title === '') throw new Error('need --slug and --title');

  const at = nowIso();
  let id = '';
  await writeBoard(
    boardDir,
    (board) => {
      const items = Array.isArray(board['items']) ? (board['items'] as unknown[]) : [];
      for (const it of items) {
        if (isObj(it) && it['slug'] === slug) {
          throw new Error(
            `board already has an item with slug '${slug}' (${jqInterp(it['id'] ?? null)})`,
          );
        }
      }
      id = nextItemId(boardDir, items, slug);
      if (items.some((it) => isObj(it) && it['id'] === id)) {
        throw new Error(`board already has an item ${id}`);
      }
      const item: Obj = { id, slug, title, state: 'proposed', createdAt: at };
      if (opts.domain !== undefined && opts.domain !== '') item['domain'] = opts.domain;
      if (opts.priority !== undefined && opts.priority !== '') item['priority'] = opts.priority;
      const kind = opts.sourceKind ?? '';
      const externalId = opts.sourceId ?? '';
      if (kind !== '' || externalId !== '') {
        item['source'] = {
          kind: kind === '' ? null : kind,
          externalId: externalId === '' ? null : externalId,
        };
      }
      if (opts.outcome !== undefined && opts.outcome !== '') item['outcome'] = opts.outcome;
      if (opts.repo !== undefined && opts.repo !== '') item['repo'] = opts.repo;
      if (opts.branch !== undefined && opts.branch !== '') item['branch'] = opts.branch;
      if (opts.base !== undefined && opts.base !== '') item['baseBranch'] = opts.base;
      item['history'] = [{ at, to: 'proposed', by: 'item add' }];
      board['updatedAt'] = at;
      board['items'] = [...items, item];
      return board;
    },
    opts.label,
  );

  appendLog(boardDir, 'item-add', id, { slug });
  return [`${id} ${slug}: proposed`];
}

/** itm_<max numeric suffix + 1> across board AND archive; else itm_<slug>. */
function nextItemId(boardDir: string, items: unknown[], slug: string): string {
  let max = -1;
  const consider = (id: unknown) => {
    if (typeof id !== 'string') return;
    const m = /^itm_([0-9]+)$/.exec(id);
    if (m !== null) max = Math.max(max, Number(m[1]));
  };
  for (const it of items) if (isObj(it)) consider(it['id']);
  const archiveRead = readBoardRaw(join(boardDir, 'archive.json'));
  if (isObj(archiveRead.json) && Array.isArray(archiveRead.json['items'])) {
    for (const it of archiveRead.json['items']) if (isObj(it)) consider(it['id']);
  }
  return max >= 0 ? `itm_${max + 1}` : `itm_${slug}`;
}

// ── board item list / show ────────────────────────────────────────────────────

/**
 * One line per item: id, state, slug, pr, ws. Read through the tolerant
 * decoder on purpose — a listing exists to find the damage, so one malformed
 * item costs a warning here, never the list.
 */
export function itemList(
  boardDir: string,
  opts: { state?: string } = {},
): { lines: string[]; warnings: string[] } {
  const { value, warnings } = readBoardItems(join(boardDir, 'board.json'));
  const lines = value
    .filter((item) => opts.state === undefined || item.state === opts.state)
    .map((item) => {
      const prNum = item.pr?.number;
      const pr = prNum !== undefined && prNum !== null ? `#${prNum}` : '-';
      const ws =
        item.workspaceId !== undefined && item.workspaceId !== null && item.workspaceId !== ''
          ? item.workspaceId.slice(0, 8)
          : '-';
      return `${item.id}  ${item.state}  ${item.slug ?? item.id}  ${pr}  ${ws}`;
    });
  return { lines, warnings };
}

/** The raw item, pretty-printed — what is on disk, not the decoded shape. */
export function itemShow(boardDir: string, id: string): string[] {
  const boardFile = join(boardDir, 'board.json');
  const raw = readBoardRaw(boardFile);
  if (raw.error !== undefined) {
    throw new Error(`board at ${boardFile} is not parseable JSON: ${raw.error}`);
  }
  const items =
    !raw.missing && isObj(raw.json) && Array.isArray(raw.json['items']) ? raw.json['items'] : [];
  const found = items.find((it) => isObj(it) && it['id'] === id);
  if (found === undefined) throw new Error(`no board item ${id} on ${boardFile}`);
  return [JSON.stringify(found, null, 2)];
}

// ── argv surface ──────────────────────────────────────────────────────────────

function die(message: string): never {
  process.stderr.write(`BLOCKED: ${message}\n`);
  process.exit(1);
}

/** `--flag` needs its value; the shell died on the unbound $2 the same way. */
function takeValue(argv: string[], i: number): string {
  const value = argv[i + 1];
  if (value === undefined) die(`${argv[i]} needs a value`);
  return value;
}

function parseSetArgs(argv: string[]): ItemSetOptions {
  const opts: ItemSetOptions = { item: '' };
  for (let i = 0; i < argv.length; i += 2) {
    const arg = argv[i]!;
    switch (arg) {
      case '--item':
        opts.item = takeValue(argv, i);
        break;
      case '--state':
        opts.state = takeValue(argv, i);
        break;
      case '--workspace-id':
        opts.workspaceId = takeValue(argv, i);
        break;
      case '--pr':
        opts.pr = takeValue(argv, i);
        break;
      case '--pr-url':
        opts.prUrl = takeValue(argv, i);
        break;
      case '--outcome':
        opts.outcome = takeValue(argv, i);
        break;
      case '--note':
        opts.note = takeValue(argv, i);
        break;
      default:
        die(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function parseAddArgs(argv: string[]): ItemAddOptions {
  const opts: ItemAddOptions = { slug: '', title: '' };
  for (let i = 0; i < argv.length; i += 2) {
    const arg = argv[i]!;
    switch (arg) {
      case '--slug':
        opts.slug = takeValue(argv, i);
        break;
      case '--title':
        opts.title = takeValue(argv, i);
        break;
      case '--repo':
        opts.repo = takeValue(argv, i);
        break;
      case '--branch':
        opts.branch = takeValue(argv, i);
        break;
      case '--base':
        opts.base = takeValue(argv, i);
        break;
      case '--source-kind':
        opts.sourceKind = takeValue(argv, i);
        break;
      case '--source-id':
        opts.sourceId = takeValue(argv, i);
        break;
      case '--outcome':
        opts.outcome = takeValue(argv, i);
        break;
      case '--priority':
        opts.priority = takeValue(argv, i);
        break;
      case '--domain':
        opts.domain = takeValue(argv, i);
        break;
      default:
        die(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

/**
 * `board item <set|add|list|show> ...`. Dies the way the scripts die —
 * "BLOCKED: ..." on stderr, exit 1 — so wiring it into main.ts's verb switch
 * is one call with no error plumbing.
 */
export async function runItem(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  try {
    switch (sub) {
      case 'set': {
        const opts = parseSetArgs(rest);
        if (opts.item === '') die('need --item <id>');
        const { boardDir, projectKey } = resolveBoardDir();
        for (const line of await itemSet(boardDir, { ...opts, label: projectKey })) {
          console.log(line);
        }
        return;
      }
      case 'add': {
        const opts = parseAddArgs(rest);
        if (opts.slug === '' || opts.title === '') die('need --slug and --title');
        const { boardDir, projectKey } = resolveBoardDir();
        for (const line of await itemAdd(boardDir, { ...opts, label: projectKey })) {
          console.log(line);
        }
        return;
      }
      case 'list': {
        let state: string | undefined;
        for (let i = 0; i < rest.length; i += 2) {
          if (rest[i] === '--state') state = takeValue(rest, i);
          else die(`unknown argument: ${rest[i]}`);
        }
        const { boardDir } = resolveBoardDir();
        const { lines, warnings } = itemList(boardDir, { state });
        for (const warning of warnings) process.stderr.write(`warn: ${warning}\n`);
        for (const line of lines) console.log(line);
        return;
      }
      case 'show': {
        const id = rest[0];
        if (id === undefined || id.startsWith('--')) die('need an item id: board item show <id>');
        if (rest.length > 1) die(`unknown argument: ${rest[1]}`);
        const { boardDir } = resolveBoardDir();
        for (const line of itemShow(boardDir, id)) console.log(line);
        return;
      }
      default:
        die(`unknown item command: ${sub ?? ''} (try: set, add, list, show)`);
    }
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
}
