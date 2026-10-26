// `board dismiss` — the board lane's dismissal ledger.
//
// An open PR the orchestrator does not know about is synthesized into a card,
// which is right for work in flight and wrong for a backlog: adding a
// repository to the orchestrator hands the board every stale open PR the
// operator ever left in it, all at once. Those are not board work and never
// will be, but they cannot be hidden by a state — they have no item to hold
// one, and inventing terminal items to hold one would put fiction on the board
// to keep fact off it.
//
// So: a ledger, exactly as the reviews lane has. Dismissing is about the PR,
// so the file sits at the orchestrator root rather than in a project, and it
// subtracts at render rather than at poll — the signals still hold every PR,
// which is what makes `undismiss` take effect on the next render rather than
// on the next poll.
//
// Any card can be dismissed, and the ledger is keyed by the card's own id
// rather than by a pull request so that a card with no PR — a proposed item, an
// agent still working — can go too.
//
// Dismissing an item-backed card hides it and nothing more: the item stays in
// board.json, the state machine still moves it, agents still work it, reconcile
// still reasons about it. This is a view, not a close. `board item set ... 
// --state abandoned` is how you end the work itself.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadRoot } from '../config.js';
import { atomicWriteJson } from '../store.js';
import { nowIso } from '../store.js';
import type { DismissedCard, DismissedCardsDoc, OrchRoot } from '../types.js';

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function dismissedCardsFile(orch: OrchRoot): string {
  return join(orch.root, 'cards-dismissed.json');
}

/** The id of the card the board invented for one pull request. */
export function prCardId(repo: string | null | undefined, number: number): string {
  return `pr:${repo ?? '?'}#${number}`;
}

/**
 * What the operator typed, as a card id. `owner/name#N` is how a person refers
 * to a pull request; the board's own id for the card it invented is that with
 * a `pr:` in front, and every other card is named by its item id already.
 */
export function canonicalCardId(token: string): string {
  // Already a card id — including one this function produced, so it is safe to
  // apply twice.
  if (token.startsWith('pr:')) return token;
  return /^[^\s/:]+\/[^\s#]+#\d+$/.test(token) ? `pr:${token}` : token;
}

/** The ledger, read tolerantly: an empty ledger on any failure. */
export function readDismissedCards(orch: OrchRoot): DismissedCard[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(dismissedCardsFile(orch), 'utf8'));
  } catch {
    return [];
  }
  if (!isObj(parsed) || !Array.isArray(parsed['dismissed'])) return [];
  const rows: DismissedCard[] = [];
  for (const raw of parsed['dismissed']) {
    if (!isObj(raw)) continue;
    // A ledger written before ids named the PR directly; derive the card id it
    // was always standing for rather than dropping the row.
    let id = typeof raw['id'] === 'string' ? raw['id'] : '';
    if (id === '' && typeof raw['repo'] === 'string' && typeof raw['number'] === 'number') {
      id = prCardId(raw['repo'], raw['number']);
    }
    if (id === '') continue;
    rows.push({
      id,
      title: typeof raw['title'] === 'string' ? raw['title'] : '',
      dismissedAt: typeof raw['dismissedAt'] === 'string' ? raw['dismissedAt'] : '',
    });
  }
  return rows;
}

/** What the assembler subtracts: the keys alone. */
export function dismissedCardKeys(orch: OrchRoot): Set<string> {
  return new Set(readDismissedCards(orch).map((row) => row.id));
}

function writeDismissedCards(orch: OrchRoot, dismissed: DismissedCard[]): void {
  const doc: DismissedCardsDoc = { version: 1, dismissed };
  atomicWriteJson(dismissedCardsFile(orch), doc);
}

/**
 * The PR's title as the last poll saw it, from whichever project's signals
 * carry it. The ledger keeps the title so `--list` reads without going back to
 * GitHub — and this is best-effort by design: a dismissal must not need the
 * network, so a title nobody can find is simply blank.
 */
function titleFromSignals(orch: OrchRoot): (id: string) => string {
  let index: Map<string, string> | undefined;
  return (id) => {
    if (index === undefined) {
      index = new Map();
      let projects: string[] = [];
      try {
        projects = readdirSync(join(orch.root, 'p'), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        projects = [];
      }
      for (const key of projects) {
        let doc: unknown;
        try {
          doc = JSON.parse(readFileSync(join(orch.root, 'p', key, 'signals', 'github.json'), 'utf8'));
        } catch {
          continue;
        }
        if (!isObj(doc) || !Array.isArray(doc['repos'])) continue;
        for (const block of doc['repos']) {
          if (!isObj(block) || typeof block['repo'] !== 'string') continue;
          if (!Array.isArray(block['open'])) continue;
          for (const row of block['open']) {
            if (!isObj(row) || typeof row['number'] !== 'number') continue;
            if (typeof row['title'] !== 'string') continue;
            index.set(prCardId(block['repo'], row['number']), row['title']);
          }
        }
      }
    }
    return index.get(id) ?? '';
  };
}

/**
 * A card id as the operator may type it. Anything without whitespace is a
 * candidate — item ids are the orchestrator's to shape and this must not
 * second-guess them — but it has to be something a shell argument can safely
 * be, so an empty token or one that would read as a flag is refused.
 */
function parseCardId(value: string | undefined): string {
  const token = (value ?? '').trim();
  if (token === '' || /\s/.test(token) || token.startsWith('-')) {
    throw new Error(`expected a card id or owner/name#number, got '${value ?? ''}'`);
  }
  return canonicalCardId(token);
}

export interface DismissDeps {
  orch?: OrchRoot;
  out?: (text: string) => void;
  err?: (text: string) => void;
  now?: () => string;
  /** Titles for the cards being dismissed, so the ledger reads without GitHub. */
  titleFor?: (id: string) => string;
}

/**
 * `board dismiss <owner/name#N>...`, `board undismiss <owner/name#N>...`, and
 * `board dismiss --list`.
 */
export function runDismiss(verb: 'dismiss' | 'undismiss', argv: string[], deps: DismissDeps = {}): number {
  const out = deps.out ?? ((text: string): void => void process.stdout.write(text));
  const err = deps.err ?? ((text: string): void => void process.stderr.write(text));
  const orch = deps.orch ?? loadRoot();
  const now = deps.now ?? nowIso;

  const existing = readDismissedCards(orch);

  if (verb === 'dismiss' && (argv.includes('--list') || argv.length === 0)) {
    if (existing.length === 0) {
      out('no dismissed cards\n');
      return 0;
    }
    for (const row of existing) {
      out(`${row.id}  ${row.title}\n`);
    }
    return 0;
  }

  const ids: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) continue;
    try {
      ids.push(parseCardId(arg));
    } catch (e) {
      err(`BLOCKED: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }
  if (ids.length === 0) {
    err(`BLOCKED: ${verb} needs at least one card id or owner/name#number\n`);
    return 1;
  }

  const titleFor = deps.titleFor ?? titleFromSignals(orch);
  const keyed = new Map(existing.map((row) => [row.id, row]));
  const at = now();
  let changed = 0;

  for (const id of ids) {
    if (verb === 'dismiss') {
      if (keyed.has(id)) {
        out(`${id} already dismissed\n`);
        continue;
      }
      keyed.set(id, { id, title: titleFor(id), dismissedAt: at });
      out(`dismissed ${id}\n`);
      changed++;
    } else {
      if (!keyed.delete(id)) {
        out(`${id} was not dismissed\n`);
        continue;
      }
      out(`undismissed ${id}\n`);
      changed++;
    }
  }

  if (changed > 0) writeDismissedCards(orch, [...keyed.values()]);
  // The ledger subtracts at render, so nothing on disk has moved yet.
  if (changed > 0) out('run `board refresh` to redraw the board\n');
  return 0;
}
