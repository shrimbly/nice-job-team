// Tolerant readers for the orchestrator's files. Every reader returns
// { value, warnings } and never throws on malformed input: these files are
// written by agents, by pollers, and sometimes by hand, and one bad byte must
// cost one item and a warning, never the board.
//
// The leniency is ported, not invented — each reader names the Swift decoder or
// lib.sh guard whose behaviour it reproduces, quirks included.

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  AgentInboxFile,
  AgentStatus,
  BoardItem,
  BoardItemSource,
  GithubSignals,
  HistoryEntry,
  PRRef,
  PullRequest,
  ReadResult,
  SessionRef,
  WorkspaceRef,
  WorkspacesSignal,
} from './types.js';

type Obj = Record<string, unknown>;

/** jq's `type == "object"`: arrays are their own type, and null is not one. */
function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads and parses one JSON file. `missing` and `error` are separate outcomes
 * because absence is normal for half these files and warns about nothing, while
 * a file that exists and does not parse is worth one warning.
 */
function readJsonFile(file: string): { json?: unknown; missing?: true; error?: string } {
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

// ── board.json ────────────────────────────────────────────────────────────────

/**
 * Signals that one item failed to decode. Internal to this module: the readers
 * catch it and turn it into a skip plus a warning.
 */
class ItemDecodeError extends Error {}

/**
 * Swift's decodeIfPresent(String): absent and null read as undefined, any other
 * type is a decode error — which, under the lossy wrapper, costs the item.
 */
function optString(obj: Obj, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ItemDecodeError(`${key} is not a string`);
  return value;
}

function requiredString(obj: Obj, key: string): string {
  const value = optString(obj, key);
  if (value === undefined) throw new ItemDecodeError(`${key} is missing`);
  return value;
}

/** Swift's Int: a fractional JSON number is a decode error, not a truncation. */
function optInt(obj: Obj, key: string): number | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ItemDecodeError(`${key} is not an integer`);
  }
  return value;
}

function optBool(obj: Obj, key: string): boolean | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new ItemDecodeError(`${key} is not a boolean`);
  return value;
}

/**
 * Port of Orchestrator.swift's PRRef.init(from:). Hand-written board edits have
 * put a bare number where the object belongs; the scripts refuse to write that
 * shape now, but a board predating them — or edited around them — must not cost
 * the item its title, so a bare number reads as the number.
 */
function decodePRRef(value: unknown): PRRef | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isInteger(value)) return { number: value };
  if (!isObj(value)) throw new ItemDecodeError('pr is neither a number nor an object');
  return {
    number: optInt(value, 'number') ?? null,
    url: optString(value, 'url') ?? null,
    reviewDecision: optString(value, 'reviewDecision') ?? null,
    ciState: optString(value, 'ciState') ?? null,
    isDraft: optBool(value, 'isDraft') ?? null,
    mergeStateStatus: optString(value, 'mergeStateStatus') ?? null,
  };
}

function decodeSource(value: unknown): BoardItemSource | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isObj(value)) throw new ItemDecodeError('source is not an object');
  return { kind: optString(value, 'kind') ?? null, externalId: optString(value, 'externalId') ?? null };
}

function decodeSession(value: unknown): SessionRef | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isObj(value)) throw new ItemDecodeError('session is not an object');
  return { id: optString(value, 'id') ?? null, url: optString(value, 'url') ?? null };
}

/**
 * One item, decoded with exactly BoardKit's strictness: id/title/state must be
 * strings and every field the Swift model declares must carry its declared type
 * or the whole item is lost — that is what the synthesized Swift decoder does,
 * and the two implementations must skip the same items.
 *
 * This is a RECORDED DIVERGENCE from the jq, which decoded nothing: it rendered
 * an item with `outcome: 5` (whatItIs 5) or `pr: {number: 37.5}` (num 37.5),
 * where this decoder skips the item with a warning — and it hard-crashed on
 * other constructible shapes, e.g. `pr: 7`, where this decoder renders. Swift
 * wins here because a card carrying a number where the model says string would
 * poison every consumer of cards.json; the byte-parity contract holds over
 * every item both masters accept. See README's "deliberate divergences".
 *
 * The fields BoardKit does NOT declare (slug, history, createdByOrchestrator,
 * baseBranch, briefPath) are read leniently — a wrong type there is ignored
 * rather than fatal, because the Swift decoder never saw those keys and a bad
 * value in them must not start costing items the app keeps.
 */
function decodeBoardItem(raw: unknown): BoardItem {
  if (!isObj(raw)) throw new ItemDecodeError('item is not an object');
  const item: BoardItem = {
    id: requiredString(raw, 'id'),
    title: requiredString(raw, 'title'),
    state: requiredString(raw, 'state'),
    branch: optString(raw, 'branch') ?? null,
    repo: optString(raw, 'repo') ?? null,
    workspaceId: optString(raw, 'workspaceId') ?? null,
    outcome: optString(raw, 'outcome') ?? null,
    source: decodeSource(raw['source']) ?? null,
    pr: decodePRRef(raw['pr']) ?? null,
    host: optString(raw, 'host') ?? null,
    session: decodeSession(raw['session']) ?? null,
  };
  if (typeof raw['slug'] === 'string') item.slug = raw['slug'];
  if (typeof raw['baseBranch'] === 'string') item.baseBranch = raw['baseBranch'];
  if (typeof raw['briefPath'] === 'string') item.briefPath = raw['briefPath'];
  if (typeof raw['createdByOrchestrator'] === 'boolean') {
    item.createdByOrchestrator = raw['createdByOrchestrator'];
  }
  if (Array.isArray(raw['history'])) {
    item.history = raw['history'].filter(isObj) as HistoryEntry[];
  }
  return item;
}

/**
 * board.json's items, one corrupt item costing that item and never the file.
 *
 * Ports Orchestrator.swift's BoardItemsFile.Lossy: a strict array decode threw
 * on the first bad element and the whole file read as empty, so the app fell
 * back to GitHub-only cards — every card titled from its PR. Decoding gives way
 * one item at a time instead.
 */
export function readBoardItems(file: string): ReadResult<BoardItem[]> {
  const warnings: string[] = [];
  const { json, missing, error } = readJsonFile(file);
  if (missing) return { value: [], warnings };
  if (error !== undefined) {
    warnings.push(`${basename(file)} is not parseable JSON: ${error}`);
    return { value: [], warnings };
  }
  if (!isObj(json)) {
    warnings.push(`${basename(file)} is not a JSON object`);
    return { value: [], warnings };
  }
  const items = json['items'];
  if (items === undefined || items === null) return { value: [], warnings };
  if (!Array.isArray(items)) {
    warnings.push(`${basename(file)}: .items is not an array`);
    return { value: [], warnings };
  }

  const value: BoardItem[] = [];
  items.forEach((raw, index) => {
    try {
      value.push(decodeBoardItem(raw));
    } catch (err) {
      const reason = err instanceof ItemDecodeError ? err.message : String(err);
      warnings.push(`${basename(file)}: skipped items[${index}] — ${reason}`);
    }
  });
  return { value, warnings };
}

// ── workspaces/*.json ─────────────────────────────────────────────────────────

/**
 * Port of lib.sh's status_file_valid, quirk included. The guard reads each
 * field through jq's `.x // null`, and `//` swallows false as well as null — so
 * a file with `"pr": false` passes exactly as if pr were absent. Kept, because
 * the shell scripts and this CLI must skip the same files or the two boards
 * disagree about which agents exist.
 *
 * Deliberately NOT extended to the Stop-hook observation fields (`observedAt`,
 * `git`): they ride through unvalidated, whatever shape they carry, and every
 * consumer guards each field at the point of use (reconcile's rule 1b). A
 * malformed observation must cost the inference it feeds, never the file — a
 * file valid before the hook existed stays valid beside it.
 */
function statusShapeValid(json: unknown): boolean {
  if (!isObj(json)) return false;
  const masked = (v: unknown) => (v === undefined || v === null || v === false ? null : v);
  const pr = masked(json['pr']);
  if (pr !== null && !isObj(pr)) return false;
  const workspaceId = masked(json['workspaceId']);
  if (workspaceId !== null && typeof workspaceId !== 'string') return false;
  const state = masked(json['state']);
  if (state !== null && typeof state !== 'string') return false;
  return true;
}

/**
 * The whole inbox by FILENAME: one entry per `*.json`, in sorted name order,
 * with `status` filled only for files that parse and pass the shape guard.
 * Exists because sync.sh's prune walked `$WORKSPACES_DIR/*.json` and judged
 * `basename "$f" .json` with NO validity filter — a malformed file for a dead
 * claimed workspace was pruned, not warned about forever — so the prune's
 * caller needs the filenames collect_status skipped, not just the survivors.
 */
export function readAgentInbox(dir: string): ReadResult<AgentInboxFile[]> {
  const warnings: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { value: [], warnings };
  }
  const value: AgentInboxFile[] = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const id = name.slice(0, -'.json'.length);
    const { json, missing, error } = readJsonFile(join(dir, name));
    if (missing) {
      // Vanished between readdir and read — bash's glob raced the same way;
      // the name still existed, so it still counts for the prune walk.
      value.push({ id });
      continue;
    }
    if (error !== undefined || !statusShapeValid(json)) {
      warnings.push(`skipped malformed agent status file: ${name}`);
      value.push({ id });
      continue;
    }
    value.push({ id, status: json as AgentStatus });
  }
  return { value, warnings };
}

/**
 * Every agent status file in the inbox, skipping — with the same warning text
 * render-board.sh prints — any file that is unparseable or whose indexed fields
 * carry the wrong types. Files are read in sorted name order so a duplicate
 * workspaceId resolves the same way on every read (Orchestrator.swift does the
 * same).
 *
 * Files that pass the guard are passed through as-is rather than re-shaped:
 * render-board.sh's jq slurps the raw objects, and fields outside the guard are
 * whatever the agent wrote.
 */
export function readAgentStatuses(dir: string): ReadResult<AgentStatus[]> {
  const inbox = readAgentInbox(dir);
  return {
    value: inbox.value.flatMap((f) => (f.status === undefined ? [] : [f.status])),
    warnings: inbox.warnings,
  };
}

// ── signals/github.json ───────────────────────────────────────────────────────

/** A value only if it is a string; null when explicitly null; else absent. */
function looseString(obj: Obj, key: string): string | null | undefined {
  const value = obj[key];
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function looseBool(obj: Obj, key: string): boolean | null | undefined {
  const value = obj[key];
  if (value === null) return null;
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * One open-PR signal row, with GitHub.swift's fromSignals defaults: a missing
 * title is "", ciState falls back to "unknown", unresolvedThreads to 0, and the
 * row's own repo wins over the repo block's name.
 */
/**
 * One open-PR signal row, defaults applied. Exported for ops/refresh.ts's
 * github-only mode, whose rows are built by facts/github.ts in-process in
 * exactly the shape signals/github.json carries — one decoder, whether the
 * row came off disk or never touched it.
 */
export function decodeOpenRow(
  row: Obj,
  number: number,
  blockRepo: string | undefined,
): PullRequest {
  const pr: PullRequest = {
    number,
    title: typeof row['title'] === 'string' ? row['title'] : '',
    headRefName: looseString(row, 'headRefName'),
    baseRefName: looseString(row, 'baseRefName'),
    url: looseString(row, 'url'),
    isDraft: looseBool(row, 'isDraft'),
    reviewDecision: looseString(row, 'reviewDecision'),
    updatedAt: looseString(row, 'updatedAt'),
    mergeStateStatus: looseString(row, 'mergeStateStatus'),
    repo: looseString(row, 'repo') ?? blockRepo ?? null,
    ciState: typeof row['ciState'] === 'string' ? row['ciState'] : 'unknown',
    unresolvedThreads: typeof row['unresolvedThreads'] === 'number' ? row['unresolvedThreads'] : 0,
    previewUrl: looseString(row, 'previewUrl'),
    latestActivityAt: looseString(row, 'latestActivityAt'),
  };
  // Fields BoardKit never decoded but the signals carry: kept when well-typed,
  // dropped silently when not — they are enrichment, never identity.
  if (typeof row['threadsAwaitingReviewer'] === 'number') {
    pr.threadsAwaitingReviewer = row['threadsAwaitingReviewer'];
  }
  if (typeof row['previewPending'] === 'boolean') pr.previewPending = row['previewPending'];
  if (Array.isArray(row['reviewRequests'])) pr.reviewRequests = row['reviewRequests'];
  if (isObj(row['reviewStates'])) {
    const states: Record<string, string> = {};
    for (const [login, state] of Object.entries(row['reviewStates'])) {
      if (typeof state === 'string') states[login] = state;
    }
    pr.reviewStates = states;
  }
  return pr;
}

/**
 * signals/github.json — poll.sh's already-normalised GitHub snapshot, used to
 * render a board when gh itself is unavailable. Ports GitHubDecoder's
 * fromSignals/mergedNumbers leniently, and goes one step further: where the
 * Swift decode of a whole file dies on one row without an integer number, here
 * that row is skipped with a warning. A poller half-interrupted mid-write must
 * not blank every repo's PRs at once.
 */
export function readGithubSignals(file: string): ReadResult<GithubSignals> {
  const warnings: string[] = [];
  const empty: GithubSignals = { prs: [], mergedNumbers: new Set(), closedUnmerged: [] };
  const { json, missing, error } = readJsonFile(file);
  if (missing) return { value: empty, warnings };
  if (error !== undefined) {
    warnings.push(`${basename(file)} is not parseable JSON: ${error}`);
    return { value: empty, warnings };
  }
  if (!isObj(json) || (json['repos'] !== undefined && json['repos'] !== null && !Array.isArray(json['repos']))) {
    warnings.push(`${basename(file)}: unexpected shape — expected {repos: [...]}`);
    return { value: empty, warnings };
  }

  const value: GithubSignals = { prs: [], mergedNumbers: new Set(), closedUnmerged: [] };
  const repos = Array.isArray(json['repos']) ? json['repos'] : [];
  repos.forEach((block: unknown, blockIndex: number) => {
    if (!isObj(block)) {
      warnings.push(`${basename(file)}: skipped repos[${blockIndex}] — not an object`);
      return;
    }
    const blockRepo = typeof block['repo'] === 'string' ? block['repo'] : undefined;
    const where = blockRepo ?? `repos[${blockIndex}]`;

    const open = Array.isArray(block['open']) ? block['open'] : [];
    open.forEach((row: unknown, index: number) => {
      if (!isObj(row) || typeof row['number'] !== 'number' || !Number.isInteger(row['number'])) {
        warnings.push(`${basename(file)}: skipped ${where} open[${index}] — no integer number`);
        return;
      }
      value.prs.push(decodeOpenRow(row, row['number'], blockRepo));
    });

    const merged = Array.isArray(block['merged']) ? block['merged'] : [];
    merged.forEach((row: unknown, index: number) => {
      if (!isObj(row) || typeof row['number'] !== 'number' || !Number.isInteger(row['number'])) {
        warnings.push(`${basename(file)}: skipped ${where} merged[${index}] — no integer number`);
        return;
      }
      value.mergedNumbers.add(row['number']);
    });

    const closed = Array.isArray(block['closed']) ? block['closed'] : [];
    closed.forEach((row: unknown, index: number) => {
      if (!isObj(row) || typeof row['number'] !== 'number' || !Number.isInteger(row['number'])) {
        warnings.push(`${basename(file)}: skipped ${where} closed[${index}] — no integer number`);
        return;
      }
      // poll.sh already filters this list to mergedAt == null, but the filter is
      // re-applied because the field IS the meaning of the list: a merged PR
      // surfacing under closedUnmerged would transition its item wrongly.
      if (row['mergedAt'] !== undefined && row['mergedAt'] !== null) return;
      const pr = decodeOpenRow(row, row['number'], blockRepo);
      pr.closedAt = looseString(row, 'closedAt');
      pr.mergedAt = null;
      value.closedUnmerged.push(pr);
    });
  });
  return { value, warnings };
}

// ── signals/workspaces.json ───────────────────────────────────────────────────

/**
 * signals/workspaces.json: the live workspace list plus the poll.sh-enriched
 * agent statuses. Both blocks optional, each entry lossy: an entry without a
 * string id (or workspaceId) is skipped with a warning. The Swift reader
 * dropped the WHOLE file when one entry failed — liveness and dirt vanished for
 * every agent because one workspace was odd — and that is a leniency gap, not a
 * quirk worth preserving.
 */
export function readWorkspacesSignal(file: string): ReadResult<WorkspacesSignal> {
  const warnings: string[] = [];
  const empty: WorkspacesSignal = { workspaces: [], agentStatus: [] };
  const { json, missing, error } = readJsonFile(file);
  if (missing) return { value: empty, warnings };
  if (error !== undefined) {
    warnings.push(`${basename(file)} is not parseable JSON: ${error}`);
    return { value: empty, warnings };
  }
  if (!isObj(json)) {
    warnings.push(`${basename(file)} is not a JSON object`);
    return { value: empty, warnings };
  }

  const value: WorkspacesSignal = { workspaces: [], agentStatus: [] };

  const workspaces = Array.isArray(json['workspaces']) ? json['workspaces'] : [];
  workspaces.forEach((raw: unknown, index: number) => {
    if (!isObj(raw) || typeof raw['id'] !== 'string') {
      warnings.push(`${basename(file)}: skipped workspaces[${index}] — no string id`);
      return;
    }
    const ref: WorkspaceRef = { id: raw['id'] };
    if (typeof raw['name'] === 'string') ref.name = raw['name'];
    if (typeof raw['branch'] === 'string') ref.branch = raw['branch'];
    if (typeof raw['projectId'] === 'string') ref.projectId = raw['projectId'];
    if (typeof raw['worktreePath'] === 'string') ref.worktreePath = raw['worktreePath'];
    value.workspaces.push(ref);
  });

  const statuses = Array.isArray(json['agentStatus']) ? json['agentStatus'] : [];
  statuses.forEach((raw: unknown, index: number) => {
    // The enrichment is merged by workspaceId; an entry without one cannot be
    // attached to anything, so it is the one thing required here.
    if (!isObj(raw) || typeof raw['workspaceId'] !== 'string') {
      warnings.push(`${basename(file)}: skipped agentStatus[${index}] — no string workspaceId`);
      return;
    }
    value.agentStatus.push(raw as AgentStatus);
  });

  return { value, warnings };
}
