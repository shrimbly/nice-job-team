// The board lane's dismissal ledger: what `board dismiss` writes, what the
// assembler reads back, and what it refuses.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { canonicalCardId, dismissedCardKeys, prCardId, readDismissedCards, runDismiss } from '../src/ops/dismiss.js';
import type { OrchRoot } from '../src/types.js';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-dismiss-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function orchAt(base: string): OrchRoot {
  return { root: base, configPath: join(base, 'config.json'), workspacesDir: join(base, 'workspaces') };
}

function run(orch: OrchRoot, verb: 'dismiss' | 'undismiss', argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runDismiss(verb, argv, {
    orch,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    now: () => '2026-09-05T00:00:00Z',
    titleFor: (id) => `title of ${id}`,
  });
  return { code, out: out.join(''), err: err.join('') };
}

describe('the dismissal ledger', () => {
  test('a dismissal round-trips, and the keys are what the assembler subtracts', () => {
    const orch = orchAt(tempDir());
    expect(dismissedCardKeys(orch).size, 'no ledger reads as nothing dismissed').toBe(0);

    const first = run(orch, 'dismiss', ['o/r#12', 'o/r#13']);
    expect(first.code).toBe(0);
    expect(first.out).toContain('dismissed pr:o/r#12');
    expect([...dismissedCardKeys(orch)].sort()).toEqual(['pr:o/r#12', 'pr:o/r#13']);

    // The title is kept so the ledger reads without going back to GitHub.
    expect(readDismissedCards(orch)[0]?.title).toBe('title of pr:o/r#12');
    expect(readDismissedCards(orch)[0]?.dismissedAt).toBe('2026-09-05T00:00:00Z');
  });

  test('undismiss puts one back and leaves the rest', () => {
    const orch = orchAt(tempDir());
    run(orch, 'dismiss', ['o/r#12', 'o/r#13']);
    const undo = run(orch, 'undismiss', ['o/r#12']);
    expect(undo.out).toContain('undismissed pr:o/r#12');
    expect([...dismissedCardKeys(orch)]).toEqual(['pr:o/r#13']);
  });

  test('dismissing twice is not an error and does not duplicate the row', () => {
    const orch = orchAt(tempDir());
    run(orch, 'dismiss', ['o/r#12']);
    const again = run(orch, 'dismiss', ['o/r#12']);
    expect(again.code).toBe(0);
    expect(again.out).toContain('already dismissed');
    expect(readDismissedCards(orch)).toHaveLength(1);
  });

  test('undismissing something that was never dismissed says so, and writes nothing', () => {
    const orch = orchAt(tempDir());
    const undo = run(orch, 'undismiss', ['o/r#99']);
    expect(undo.code).toBe(0);
    expect(undo.out).toContain('was not dismissed');
    expect(dismissedCardKeys(orch).size).toBe(0);
  });

  test('a malformed ref is refused before anything is written', () => {
    const orch = orchAt(tempDir());
    const bad = run(orch, 'dismiss', ['has a space']);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('expected a card id');
    expect(dismissedCardKeys(orch).size).toBe(0);
  });

  test('--list reads the ledger back', () => {
    const orch = orchAt(tempDir());
    expect(run(orch, 'dismiss', ['--list']).out).toBe('no dismissed cards\n');
    run(orch, 'dismiss', ['o/r#12']);
    expect(run(orch, 'dismiss', ['--list']).out).toContain('pr:o/r#12  title of pr:o/r#12');
  });

  /// The ledger is hand-editable, like every other file at the root, so a
  /// broken one must cost the dismissals and not the board.
  test('an unreadable ledger reads as empty rather than throwing', () => {
    const base = tempDir();
    const orch = orchAt(base);
    require('node:fs').writeFileSync(join(base, 'cards-dismissed.json'), '{not json');
    expect(dismissedCardKeys(orch).size).toBe(0);
    // And a write over it recovers.
    run(orch, 'dismiss', ['o/r#12']);
    expect([...dismissedCardKeys(orch)]).toEqual(['pr:o/r#12']);
    expect(JSON.parse(readFileSync(join(base, 'cards-dismissed.json'), 'utf8')).version).toBe(1);
  });

  test('a PR reference canonicalises to the card id the board gave it', () => {
    expect(canonicalCardId('o/r#12')).toBe('pr:o/r#12');
    expect(prCardId('o/r', 12)).toBe('pr:o/r#12');
    // An item id is already a card id and is left exactly as it is.
    expect(canonicalCardId('itm_438')).toBe('itm_438');
    expect(canonicalCardId('pr:o/r#12'), 'idempotent').toBe('pr:o/r#12');
  });

  // The point of the rekey: a card with no pull request at all can be dismissed.
  test('an item-backed card is dismissed by its item id', () => {
    const orch = orchAt(tempDir());
    const done = run(orch, 'dismiss', ['itm_438']);
    expect(done.code).toBe(0);
    expect([...dismissedCardKeys(orch)]).toEqual(['itm_438']);
  });

  // The ledger predates ids by a day; a row that names the PR still counts.
  test('a ledger row written before ids still resolves to a card id', () => {
    const base = tempDir();
    const orch = orchAt(base);
    require('node:fs').writeFileSync(
      join(base, 'cards-dismissed.json'),
      JSON.stringify({ version: 1, dismissed: [{ repo: 'o/r', number: 12, title: 't', dismissedAt: 'X' }] }),
    );
    expect([...dismissedCardKeys(orch)]).toEqual(['pr:o/r#12']);
  });
});
