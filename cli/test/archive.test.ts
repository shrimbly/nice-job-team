// tests/run.sh's archive.sh cases, ported assertion for assertion: the
// dry-run that names only the old terminal item, the move into archive.json
// with archivedAt, the recent item that stays for "Recently closed",
// idempotence, and the live-workspace guard. Plus the dating fallbacks and
// INDEX(.id) last-wins behaviour the shell relied on but never tested.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { archive } from '../src/ops/archive.js';
import { nowIso } from '../src/store.js';

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

type Obj = Record<string, unknown>;

/**
 * run.sh's archive fixture: the setup() board — itm_1 live, itm_2 closed on
 * 2026-08-01, far outside the 7-day window — plus a just-abandoned item whose
 * history dates it to now.
 */
function fixtureBoard(): Obj {
  return {
    version: 1,
    updatedAt: '2026-08-01T00:00:00Z',
    items: [
      {
        id: 'itm_1',
        slug: 'live-item',
        title: 'T-1 - Live item',
        state: 'dispatched',
        workspaceId: 'ws-good',
        pr: null,
        history: [{ at: '2026-08-01T00:00:00Z', from: 'proposed', to: 'dispatched' }],
      },
      {
        id: 'itm_2',
        slug: 'old-closed',
        title: 'T-2 - Old closed',
        state: 'closed',
        pr: { number: 41, url: 'https://gh/41' },
        history: [{ at: '2026-08-01T00:00:00Z', from: 'merged', to: 'closed' }],
      },
      {
        id: 'itm_3',
        slug: 'just-abandoned',
        title: 'T-3 - Just abandoned',
        state: 'abandoned',
        pr: null,
        history: [{ at: nowIso(), from: 'dispatched', to: 'abandoned' }],
      },
    ],
  };
}

function orchRoot(doc: Obj = fixtureBoard()): { root: string; boardDir: string; boardFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'board-archive-'));
  tempRoots.push(root);
  const boardDir = join(root, 'p', 'test');
  mkdirSync(boardDir, { recursive: true });
  const boardFile = join(boardDir, 'board.json');
  writeFileSync(boardFile, JSON.stringify(doc, null, 2) + '\n');
  return { root, boardDir, boardFile };
}

function readJson(file: string): Obj {
  return JSON.parse(readFileSync(file, 'utf8')) as Obj;
}

function boardIds(boardFile: string): unknown[] {
  return (readJson(boardFile)['items'] as Obj[]).map((it) => it['id']);
}

describe('archive --dry-run', () => {
  test('names the old terminal item — and only that one — and moves nothing', async () => {
    const { boardDir, boardFile } = orchRoot();
    const out = await archive(boardDir, { dryRun: true, days: 7 });
    expect(out).toEqual(['would archive old-closed — closed for over 7 days']);
    expect(boardIds(boardFile)).toEqual(['itm_1', 'itm_2', 'itm_3']);
    expect(existsSync(join(boardDir, 'archive.json'))).toBe(false);
    // Nothing moved, so nothing was stamped or bumped either.
    expect(readJson(boardFile)['version']).toBe(1);
  });

  test('says so when nothing is eligible, quoting the window', async () => {
    const board = fixtureBoard();
    (board['items'] as Obj[]).splice(1, 1); // drop old-closed; only the recent terminal stays
    const { boardDir } = orchRoot(board);
    const out = await archive(boardDir, { dryRun: true, days: 7 });
    expect(out).toEqual(['nothing to archive (terminal for < 7 days stays on the board)']);
  });

  test('interpolates the days value as the config wrote it', async () => {
    const { boardDir } = orchRoot();
    // cfg hands the shell a string; --argjson coerced it. Same here.
    const out = await archive(boardDir, { dryRun: true, days: '14' });
    expect(out).toEqual(['would archive old-closed — closed for over 14 days']);
  });

  test('refuses a non-numeric recentlyClosedDays, like the shell died', async () => {
    const { boardDir } = orchRoot();
    await expect(archive(boardDir, { dryRun: true, days: 'weekly' })).rejects.toThrow(
      /recentlyClosedDays/,
    );
  });
});

describe('archive', () => {
  test('moves the old terminal item into archive.json, stamped with archivedAt', async () => {
    const { boardDir, boardFile } = orchRoot();
    const archiveFile = join(boardDir, 'archive.json');
    const out = await archive(boardDir, { days: 7 });
    expect(out).toEqual([`archived 1 item(s) to ${archiveFile}`]);

    // run.sh: `[.items[].id]` == ["itm_1","itm_3"] — order preserved.
    expect(boardIds(boardFile)).toEqual(['itm_1', 'itm_3']);
    const archived = readJson(archiveFile);
    const rows = archived['items'] as Obj[];
    expect(rows.length).toBe(1);
    expect(rows[0]!['id']).toBe('itm_2');
    expect(typeof rows[0]!['archivedAt']).toBe('string');
    expect(typeof archived['updatedAt']).toBe('string');

    // a recent terminal item stays for Recently closed
    const itm3 = (readJson(boardFile)['items'] as Obj[]).find((it) => it['id'] === 'itm_3')!;
    expect(itm3['state']).toBe('abandoned');

    // The locked delete stamps and bumps the board like any write.
    const board = readJson(boardFile);
    expect(board['updatedAt']).not.toBe('2026-08-01T00:00:00Z');
    expect(board['version']).toBe(2);

    // …and each move is logged.
    const log = readFileSync(join(boardDir, 'log.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(log[log.length - 1]!)).toMatchObject({ event: 'archived', itemId: 'itm_2' });
  });

  test('is idempotent', async () => {
    const { boardDir, boardFile } = orchRoot();
    await archive(boardDir, { days: 7 });
    const out = await archive(boardDir, { days: 7 });
    // The second pass finds nothing and — outside --dry-run — says nothing.
    expect(out).toEqual([]);
    expect((readJson(join(boardDir, 'archive.json'))['items'] as Obj[]).length).toBe(1);
    expect(boardIds(boardFile)).toEqual(['itm_1', 'itm_3']);
  });

  test('a terminal item with a live workspace stays on the board', async () => {
    const board = fixtureBoard();
    ((board['items'] as Obj[])[1] as Obj)['workspaceId'] = 'ws-live';
    const { boardDir, boardFile } = orchRoot(board);
    mkdirSync(join(boardDir, 'signals'), { recursive: true });
    writeFileSync(
      join(boardDir, 'signals', 'workspaces.json'),
      '{"workspaces":[{"id":"ws-live"}]}',
    );
    const out = await archive(boardDir, { days: 7 });
    // Archiving it would silence sync's stray-workspace nag while the worktree
    // leaks.
    expect(boardIds(boardFile)).toContain('itm_2');
    expect(out).toEqual([]);
    expect(existsSync(join(boardDir, 'archive.json'))).toBe(false);
  });

  test('one malformed workspace entry blanks the live list — erring towards archiving', async () => {
    const board = fixtureBoard();
    ((board['items'] as Obj[])[1] as Obj)['workspaceId'] = 'ws-live';
    const { boardDir, boardFile } = orchRoot(board);
    mkdirSync(join(boardDir, 'signals'), { recursive: true });
    // The shell's `jq '[.workspaces[]?.id]' || echo '[]'`: the scalar entry
    // killed the whole jq and the guard read as empty. Ported as-is.
    writeFileSync(
      join(boardDir, 'signals', 'workspaces.json'),
      '{"workspaces":[{"id":"ws-live"}, 5]}',
    );
    await archive(boardDir, { days: 7 });
    expect(boardIds(boardFile)).toEqual(['itm_1', 'itm_3']);
  });

  test('an undatable terminal item archives now rather than sitting forever', async () => {
    const board = fixtureBoard();
    (board['items'] as Obj[]).push({
      id: 'itm_4',
      slug: 'no-history',
      title: 'T-4 - No history',
      state: 'rejected',
      pr: null,
    });
    const { boardDir } = orchRoot(board);
    const out = await archive(boardDir, { dryRun: true, days: 7 });
    expect(out).toContain('would archive no-history — rejected for over 7 days');
  });

  test('dates from the last history entry when no entry records the terminal move', async () => {
    const board = fixtureBoard();
    // Terminal state, but history never mentions it: the fallback dates from
    // the last entry of any kind. A recent one keeps the item on the board.
    (board['items'] as Obj[]).push({
      id: 'itm_5',
      slug: 'quietly-closed',
      title: 'T-5 - Quietly closed',
      state: 'closed',
      pr: null,
      history: [{ at: nowIso(), from: 'proposed', to: 'building' }],
    });
    const { boardDir } = orchRoot(board);
    const out = await archive(boardDir, { dryRun: true, days: 7 });
    expect(out).toEqual(['would archive old-closed — closed for over 7 days']);
  });

  test('INDEX(.id) keeps the later copy when an id shows up twice', async () => {
    const { boardDir } = orchRoot();
    const archiveFile = join(boardDir, 'archive.json');
    // A crash between the archive append and the board delete leaves a stale
    // copy behind; the next run must overwrite it, not duplicate it.
    writeFileSync(
      archiveFile,
      JSON.stringify({ items: [{ id: 'itm_2', note: 'stale copy' }] }) + '\n',
    );
    await archive(boardDir, { days: 7 });
    const rows = readJson(archiveFile)['items'] as Obj[];
    expect(rows.length).toBe(1);
    expect(rows[0]!['id']).toBe('itm_2');
    expect(rows[0]!['note']).toBeUndefined();
    expect(rows[0]!['slug']).toBe('old-closed');
    expect(typeof rows[0]!['archivedAt']).toBe('string');
  });

  test('appends to an existing archive without disturbing other rows', async () => {
    const { boardDir } = orchRoot();
    const archiveFile = join(boardDir, 'archive.json');
    writeFileSync(
      archiveFile,
      JSON.stringify({ updatedAt: 'X', items: [{ id: 'itm_0', slug: 'ancient' }] }) + '\n',
    );
    await archive(boardDir, { days: 7 });
    const rows = readJson(archiveFile)['items'] as Obj[];
    expect(rows.map((r) => r['id'])).toEqual(['itm_0', 'itm_2']);
  });

  test('dies without a board', async () => {
    const root = mkdtempSync(join(tmpdir(), 'board-archive-'));
    tempRoots.push(root);
    const boardDir = join(root, 'p', 'test');
    mkdirSync(boardDir, { recursive: true });
    await expect(archive(boardDir, { days: 7 })).rejects.toThrow(/no board at /);
  });

  test('defaults the window to 7 days', async () => {
    const { boardDir } = orchRoot();
    const out = await archive(boardDir, { dryRun: true });
    expect(out).toEqual(['would archive old-closed — closed for over 7 days']);
  });
});
