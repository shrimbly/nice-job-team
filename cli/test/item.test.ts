// tests/run.sh's board-set.sh cases, ported assertion for assertion (same
// fixture board, same verbatim refusal texts), plus the `item add`, `list` and
// `show` surfaces the shell never had. Everything drives the exported ops
// against a temp orchestrator root shaped like run.sh's setup(): board.json
// under <root>/p/test/.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { itemAdd, itemList, itemSet, itemShow, resolveBoardDir } from '../src/ops/item.js';

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

/** tests/run.sh's setup() board: one live item, one closed long ago. */
const FIXTURE_BOARD = {
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
  ],
};

type Obj = Record<string, unknown>;

/** A temp orch root laid out like run.sh's setup(): the board in p/test/. */
function orchRoot(doc: unknown = FIXTURE_BOARD): { root: string; boardDir: string; boardFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'board-item-'));
  tempRoots.push(root);
  const boardDir = join(root, 'p', 'test');
  mkdirSync(boardDir, { recursive: true });
  const boardFile = join(boardDir, 'board.json');
  writeFileSync(boardFile, JSON.stringify(doc, null, 2) + '\n');
  return { root, boardDir, boardFile };
}

function readBoard(boardFile: string): Obj {
  return JSON.parse(readFileSync(boardFile, 'utf8')) as Obj;
}

function firstItem(boardFile: string): Obj {
  return (readBoard(boardFile)['items'] as Obj[])[0]!;
}

function lastHistory(item: Obj): Obj {
  const history = item['history'] as Obj[];
  return history[history.length - 1]!;
}

function logLines(boardDir: string): Obj[] {
  return readFileSync(join(boardDir, 'log.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Obj);
}

// ── board-set ports ───────────────────────────────────────────────────────────

describe('itemSet', () => {
  test('moves the state, records the workspace, appends the history entry itself', async () => {
    const { boardDir, boardFile } = orchRoot();
    const out = await itemSet(boardDir, { item: 'itm_1', state: 'building', workspaceId: 'ws-new' });

    const item = firstItem(boardFile);
    expect(item['state']).toBe('building');
    expect(item['workspaceId']).toBe('ws-new');
    const entry = lastHistory(item);
    expect(entry['to']).toBe('building');
    expect(entry['from']).toBe('dispatched');
    expect(entry['by']).toBe('board-set');
    // …and stamps updatedAt (run.sh: != the fixture's stamp), bumping version.
    expect(readBoard(boardFile)['updatedAt']).not.toBe('2026-08-01T00:00:00Z');
    expect(readBoard(boardFile)['version']).toBe(2);
    // The closing summary line: "<slug>: <state> ws=<8>" — no pr yet.
    expect(out).toEqual(['live-item: building ws=ws-new']);
  });

  test('refuses an unknown state, listing the known ones, without touching the board', async () => {
    const { boardDir, boardFile } = orchRoot();
    await expect(itemSet(boardDir, { item: 'itm_1', state: 'totally-made-up' })).rejects.toThrow(
      "unknown state 'totally-made-up' — known states: proposed dispatched building " +
        'awaiting-approval pr-open fixing blocked ready merged orphaned rejected closed abandoned',
    );
    expect(firstItem(boardFile)['state']).toBe('dispatched');
    expect(readBoard(boardFile)['updatedAt']).toBe('2026-08-01T00:00:00Z');
    expect(readBoard(boardFile)['version']).toBe(1);
  });

  test('refuses a pr url with no pr number anywhere', async () => {
    const { boardDir } = orchRoot();
    // itm_1's pr is null and no --pr came along: exactly the malformed shape
    // board_validate exists to refuse.
    await expect(itemSet(boardDir, { item: 'itm_1', prUrl: 'https://gh/77' })).rejects.toThrow(
      '--pr-url needs a PR number — pass --pr too (pr must be {number, url?})',
    );
  });

  test('accepts a pr url alone when the item already has a number', async () => {
    const { boardDir, boardFile } = orchRoot();
    await itemSet(boardDir, { item: 'itm_2', prUrl: 'https://gh/41-moved' });
    const items = readBoard(boardFile)['items'] as Obj[];
    expect(items[1]!['pr']).toEqual({ number: 41, url: 'https://gh/41-moved' });
  });

  test('keeps pr in {number, url} shape, merging not replacing', async () => {
    const { boardDir, boardFile } = orchRoot();
    await itemSet(boardDir, { item: 'itm_1', pr: '77', prUrl: 'https://gh/77' });
    const out = await itemSet(boardDir, { item: 'itm_1', pr: '78' });
    // run.sh compares `jq -c` output — key order included.
    expect(JSON.stringify(firstItem(boardFile)['pr'])).toBe('{"number":78,"url":"https://gh/77"}');
    expect(out).toEqual(['live-item: dispatched ws=ws-good pr=#78']);
  });

  test('refuses a non-numeric --pr', async () => {
    const { boardDir } = orchRoot();
    await expect(itemSet(boardDir, { item: 'itm_1', pr: '78x' })).rejects.toThrow(
      "--pr takes the PR number, got '78x'",
    );
  });

  test('a note without a state change still lands in history — as exactly one entry', async () => {
    const { boardDir, boardFile } = orchRoot();
    const before = (firstItem(boardFile)['history'] as Obj[]).length;
    await itemSet(boardDir, { item: 'itm_1', note: 'chased the reviewer' });
    const item = firstItem(boardFile);
    expect((item['history'] as Obj[]).length).toBe(before + 1);
    const entry = lastHistory(item);
    expect(entry['by']).toBe('board-set: chased the reviewer');
    // The standing-still entry: from and to are both the current state.
    expect(entry['from']).toBe('dispatched');
    expect(entry['to']).toBe('dispatched');
  });

  test('a note WITH a state change rides the transition entry — not a second one', async () => {
    const { boardDir, boardFile } = orchRoot();
    const before = (firstItem(boardFile)['history'] as Obj[]).length;
    await itemSet(boardDir, { item: 'itm_1', state: 'building', note: 'kick' });
    const item = firstItem(boardFile);
    expect((item['history'] as Obj[]).length).toBe(before + 1);
    const entry = lastHistory(item);
    expect(entry).toMatchObject({ from: 'dispatched', to: 'building', by: 'board-set: kick' });
  });

  test('a note with an explicit unchanged state still earns the standing-still entry', async () => {
    const { boardDir, boardFile } = orchRoot();
    const before = (firstItem(boardFile)['history'] as Obj[]).length;
    await itemSet(boardDir, { item: 'itm_1', state: 'dispatched', note: 'still here' });
    expect((firstItem(boardFile)['history'] as Obj[]).length).toBe(before + 1);
    expect(lastHistory(firstItem(boardFile))['by']).toBe('board-set: still here');
  });

  test('refuses an unknown item', async () => {
    const { boardDir } = orchRoot();
    await expect(itemSet(boardDir, { item: 'itm_nope', state: 'building' })).rejects.toThrow(
      /no board item itm_nope/,
    );
  });

  test('refuses an empty patch: nothing to set', async () => {
    const { boardDir } = orchRoot();
    await expect(itemSet(boardDir, { item: 'itm_1' })).rejects.toThrow('nothing to set');
  });

  test('clears the workspace on --workspace-id null (and on empty)', async () => {
    const { boardDir, boardFile } = orchRoot();
    const out = await itemSet(boardDir, { item: 'itm_1', workspaceId: 'null' });
    expect(firstItem(boardFile)['workspaceId']).toBeNull();
    // A cleared workspace drops the ws= chunk from the summary.
    expect(out).toEqual(['live-item: dispatched']);
    await itemSet(boardDir, { item: 'itm_1', workspaceId: '' });
    expect(firstItem(boardFile)['workspaceId']).toBeNull();
  });

  test('logs the board-set event with the kv the shell passed', async () => {
    const { boardDir } = orchRoot();
    await itemSet(boardDir, { item: 'itm_1', state: 'building', pr: '77', note: 'x' });
    const last = logLines(boardDir)[logLines(boardDir).length - 1]!;
    expect(last['event']).toBe('board-set');
    expect(last['itemId']).toBe('itm_1');
    expect(last['state']).toBe('building');
    expect(last['pr']).toBe('77');
    expect(last['note']).toBe('x');
    expect(typeof last['at']).toBe('string');
  });
});

// ── board item add ────────────────────────────────────────────────────────────

describe('itemAdd', () => {
  test('creates a proposed item with the next itm_<n> id and the history seed', async () => {
    const { boardDir, boardFile } = orchRoot();
    const out = await itemAdd(boardDir, { slug: 'new-thing', title: 'T-9 - New thing' });
    expect(out).toEqual(['itm_3 new-thing: proposed']);

    const board = readBoard(boardFile);
    const items = board['items'] as Obj[];
    expect(items.length).toBe(3);
    const added = items[2]!;
    expect(added['id']).toBe('itm_3');
    expect(added['slug']).toBe('new-thing');
    expect(added['title']).toBe('T-9 - New thing');
    expect(added['state']).toBe('proposed');
    expect(typeof added['createdAt']).toBe('string');
    const history = added['history'] as Obj[];
    expect(history.length).toBe(1);
    expect(history[0]!['to']).toBe('proposed');
    expect(history[0]!['by']).toBe('item add');
    expect(typeof history[0]!['at']).toBe('string');
    // No `from` before a first state — history entries need at/to only.
    expect('from' in history[0]!).toBe(false);
    expect(board['updatedAt']).not.toBe('2026-08-01T00:00:00Z');
    expect(board['version']).toBe(2);
    // A validated write logs like any other.
    const last = logLines(boardDir)[logLines(boardDir).length - 1]!;
    expect(last).toMatchObject({ event: 'item-add', itemId: 'itm_3', slug: 'new-thing' });
  });

  test('records every optional field under its board.json name', async () => {
    const { boardDir, boardFile } = orchRoot();
    await itemAdd(boardDir, {
      slug: 'full-item',
      title: 'T-10 - Full item',
      repo: 'o/r',
      branch: 'dev/full-item',
      base: 'main',
      sourceKind: 'linear',
      sourceId: 'ENG-142',
      outcome: 'The thing is done.',
      priority: 'high',
      domain: 'board',
    });
    const items = readBoard(boardFile)['items'] as Obj[];
    const added = items[items.length - 1]!;
    expect(added).toMatchObject({
      repo: 'o/r',
      branch: 'dev/full-item',
      baseBranch: 'main',
      source: { kind: 'linear', externalId: 'ENG-142' },
      outcome: 'The thing is done.',
      priority: 'high',
      domain: 'board',
    });
  });

  test('refuses a duplicate slug, leaving the board untouched', async () => {
    const { boardDir, boardFile } = orchRoot();
    await expect(itemAdd(boardDir, { slug: 'live-item', title: 'again' })).rejects.toThrow(
      "board already has an item with slug 'live-item' (itm_1)",
    );
    expect((readBoard(boardFile)['items'] as Obj[]).length).toBe(2);
    expect(readBoard(boardFile)['version']).toBe(1);
  });

  test('derives the id from the slug on a board with no numbered items', async () => {
    const { boardDir, boardFile } = orchRoot({ version: 1, items: [] });
    const out = await itemAdd(boardDir, { slug: 'first-ever', title: 'T-0' });
    expect(out).toEqual(['itm_first-ever first-ever: proposed']);
    expect((readBoard(boardFile)['items'] as Obj[])[0]!['id']).toBe('itm_first-ever');
  });

  test('numbering continues past archived items, never reusing their ids', async () => {
    const { boardDir, boardFile } = orchRoot({ version: 1, items: [] });
    writeFileSync(
      join(boardDir, 'archive.json'),
      JSON.stringify({ items: [{ id: 'itm_9', slug: 'gone', state: 'closed' }] }) + '\n',
    );
    await itemAdd(boardDir, { slug: 'after-archive', title: 'T-11' });
    // Reusing itm_9 would let the next archive's INDEX(.id) clobber its record.
    expect((readBoard(boardFile)['items'] as Obj[])[0]!['id']).toBe('itm_10');
  });

  test('needs slug and title', async () => {
    const { boardDir } = orchRoot();
    await expect(itemAdd(boardDir, { slug: '', title: 'x' })).rejects.toThrow('need --slug and --title');
    await expect(itemAdd(boardDir, { slug: 'x', title: '' })).rejects.toThrow('need --slug and --title');
  });
});

// ── board item list / show ────────────────────────────────────────────────────

describe('itemList', () => {
  test('prints one line per item: id state slug pr ws', () => {
    const { boardDir } = orchRoot();
    const { lines, warnings } = itemList(boardDir);
    expect(warnings).toEqual([]);
    expect(lines).toEqual([
      'itm_1  dispatched  live-item  -  ws-good',
      'itm_2  closed  old-closed  #41  -',
    ]);
  });

  test('filters by --state', () => {
    const { boardDir } = orchRoot();
    expect(itemList(boardDir, { state: 'closed' }).lines).toEqual([
      'itm_2  closed  old-closed  #41  -',
    ]);
    expect(itemList(boardDir, { state: 'merged' }).lines).toEqual([]);
  });

  test('one malformed item costs a warning, never the list', () => {
    const board = structuredClone(FIXTURE_BOARD) as unknown as Obj;
    (board['items'] as unknown[]).push({ id: 'itm_bad', title: 5, state: 'closed' });
    const { boardDir } = orchRoot(board);
    const { lines, warnings } = itemList(boardDir);
    expect(lines.length).toBe(2);
    expect(warnings.length).toBe(1);
  });
});

describe('itemShow', () => {
  test('prints the raw item as pretty JSON', () => {
    const { boardDir } = orchRoot();
    const out = itemShow(boardDir, 'itm_2');
    expect(out.length).toBe(1);
    expect(JSON.parse(out[0]!)).toEqual(FIXTURE_BOARD.items[1]);
    // Pretty, not compact: the point of show is a readable item.
    expect(out[0]).toContain('\n');
  });

  test('refuses an unknown item', () => {
    const { boardDir } = orchRoot();
    expect(() => itemShow(boardDir, 'itm_nope')).toThrow(/no board item itm_nope/);
  });
});

// ── resolveBoardDir (lib.sh's layout block) ───────────────────────────────────

describe('resolveBoardDir', () => {
  test('SUPERSET_ORCH_PROJECT picks the project directory under p/', () => {
    const { root, boardDir } = orchRoot();
    const resolved = resolveBoardDir({ SUPERSET_ORCH_ROOT: root, SUPERSET_ORCH_PROJECT: 'test' });
    expect(resolved.boardDir).toBe(boardDir);
    expect(resolved.projectKey).toBe('test');
  });

  test('SUPERSET_ORCH_DIR overrides everything, for a one-off board', () => {
    const { root, boardDir } = orchRoot();
    const resolved = resolveBoardDir({
      SUPERSET_ORCH_ROOT: root,
      SUPERSET_ORCH_PROJECT: 'test',
      SUPERSET_ORCH_DIR: boardDir,
    });
    expect(resolved.boardDir).toBe(boardDir);
  });

  test('a single configured project is assumed, key falling back to the name slug', () => {
    const { root } = orchRoot();
    writeFileSync(join(root, 'config.json'), JSON.stringify({ repos: [{ name: 'Acme Website' }] }));
    const resolved = resolveBoardDir({ SUPERSET_ORCH_ROOT: root });
    expect(resolved.projectKey).toBe('acme-website');
    expect(resolved.boardDir).toBe(join(root, 'p', 'acme-website'));
  });

  test('no config at all means the default project, like lib.sh', () => {
    const { root } = orchRoot();
    const resolved = resolveBoardDir({ SUPERSET_ORCH_ROOT: root });
    expect(resolved.projectKey).toBe('default');
  });

  test('two projects and no selection refuses, naming the keys', () => {
    const { root } = orchRoot();
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ repos: [{ name: 'o/r', key: 'test' }, { name: 'o/other' }] }),
    );
    expect(() => resolveBoardDir({ SUPERSET_ORCH_ROOT: root })).toThrow(
      /2 projects configured — set SUPERSET_ORCH_PROJECT.*test, o-other/s,
    );
  });
});
