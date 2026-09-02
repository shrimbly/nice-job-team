// The write-path tests: tests/run.sh's board_validate and atomic_json cases,
// ported assertion for assertion (same fixture board, same verbatim problem
// strings), plus the lock suite the shell never had — including interop cases
// against lock files written the way shlock writes them, because until P3 the
// bash scripts and this module take the same lock on the same file.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  appendLog,
  atomicWriteJson,
  lockBoard,
  readBoardDoc,
  readBoardRaw,
  unlockBoard,
  validateBoard,
  writeBoard,
} from '../src/store.js';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-store-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/** A deep copy with one jq-style edit applied, like run.sh's `jq ... > bad`. */
function boardWith(edit: (board: typeof FIXTURE_BOARD) => void): typeof FIXTURE_BOARD {
  const copy = structuredClone(FIXTURE_BOARD);
  edit(copy);
  return copy;
}

/** A board directory holding the fixture, like run.sh's setup(). */
function boardDir(doc: unknown = FIXTURE_BOARD): { dir: string; file: string } {
  const dir = tempDir();
  const file = join(dir, 'board.json');
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  return { dir, file };
}

// ── board_validate ────────────────────────────────────────────────────────────

describe('validateBoard', () => {
  test('accepts a well-formed board', () => {
    expect(validateBoard(FIXTURE_BOARD)).toEqual([]);
  });

  test('rejects a bare-number pr, naming the item and the shape', () => {
    // The malformed shape from 1 Sep: `"pr": 938` where {number, url?} belongs.
    const bad = boardWith((b) => {
      (b.items[0] as Record<string, unknown>)['pr'] = 938;
    });
    const problems = validateBoard(bad);
    expect(problems).toEqual(['live-item: pr is a number — must be null or {number, url?}']);
  });

  test('rejects a stateless item, saying which field', () => {
    const bad = boardWith((b) => {
      delete (b.items[0] as Record<string, unknown>)['state'];
    });
    expect(validateBoard(bad)).toEqual(['live-item: state must be a non-empty string']);
  });

  test('rejects a numeric id — strings only', () => {
    const bad = boardWith((b) => {
      (b.items[0] as Record<string, unknown>)['id'] = 42;
    });
    expect(validateBoard(bad)).toEqual(['live-item: id must be a non-empty string']);
  });

  test('rejects a history entry without at/to', () => {
    const bad = boardWith((b) => {
      (b.items[0] as Record<string, unknown>)['history'] = [{ from: 'a' }];
    });
    expect(validateBoard(bad)).toEqual(['live-item: history[0] is missing at/to']);
  });

  test('rejects a non-number pr.number with the jq type name', () => {
    const bad = boardWith((b) => {
      (b.items[1] as Record<string, unknown>)['pr'] = { number: '41' };
    });
    expect(validateBoard(bad)).toEqual(['old-closed: pr.number is string — must be a number']);
  });

  test('a non-object item and a non-array items fail by position', () => {
    expect(validateBoard({ items: 'nope' })).toEqual(['.items is not an array']);
    expect(validateBoard({ items: [42] })).toEqual(['items[0] is not an object']);
  });

  test('the jq // quirk: "pr": false reads as absent and passes', () => {
    const odd = boardWith((b) => {
      (b.items[0] as Record<string, unknown>)['pr'] = false;
    });
    expect(validateBoard(odd)).toEqual([]);
  });

  test('an item with no slug fails the slug check — all four fields are required', () => {
    const bad = boardWith((b) => {
      delete (b.items[0] as Record<string, unknown>)['slug'];
    });
    // With slug gone, `$it.slug // $it.id` names the item by its id.
    expect(validateBoard(bad)).toEqual(['itm_1: slug must be a non-empty string']);
  });

  test('the .items? quirk: a non-object root yields no problems, a null root one', () => {
    // jq's `?` swallowed the index error on `.items?`, so the program printed
    // nothing and the file "passed" — ported, because both sides must agree.
    expect(validateBoard([1, 2])).toEqual([]);
    expect(validateBoard(42)).toEqual([]);
    expect(validateBoard(null)).toEqual(['.items is not an array']);
    expect(validateBoard({})).toEqual(['.items is not an array']);
  });
});

// ── the lock ──────────────────────────────────────────────────────────────────

describe('lockBoard', () => {
  test('writes the shlock format: our pid and a trailing newline', async () => {
    const dir = tempDir();
    await lockBoard(dir);
    expect(readFileSync(join(dir, 'board.lock'), 'utf8')).toBe(`${process.pid}\n`);
    unlockBoard(dir);
    expect(existsSync(join(dir, 'board.lock'))).toBe(false);
  });

  test('a second locker blocks, then acquires on release', async () => {
    const dir = tempDir();
    await lockBoard(dir);
    let acquired = false;
    const second = lockBoard(dir).then(() => {
      acquired = true;
    });
    await sleep(450); // more than two poll intervals
    expect(acquired).toBe(false);
    unlockBoard(dir);
    await second;
    expect(acquired).toBe(true);
    expect(readFileSync(join(dir, 'board.lock'), 'utf8')).toBe(`${process.pid}\n`);
    unlockBoard(dir);
  });

  test('a lock whose pid is dead is cleared and claimed', async () => {
    const dir = tempDir();
    // A real pid that is certainly dead: a child that already exited.
    const child = spawnSync(process.execPath, ['-e', '0']);
    writeFileSync(join(dir, 'board.lock'), `${child.pid}\n`);
    const before = Date.now();
    await lockBoard(dir);
    expect(Date.now() - before).toBeLessThan(2000); // cleared, not waited out
    expect(readFileSync(join(dir, 'board.lock'), 'utf8')).toBe(`${process.pid}\n`);
    unlockBoard(dir);
  });

  test('garbage lock content is treated as stale, as shlock treats it', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'board.lock'), 'not-a-pid\n');
    await lockBoard(dir);
    expect(readFileSync(join(dir, 'board.lock'), 'utf8')).toBe(`${process.pid}\n`);
    unlockBoard(dir);
  });

  test('breaking a stale lock leaves no .break guard behind', async () => {
    // Breakers serialize on an O_EXCL board.lock.break guard so two of them
    // cannot both "clear" a stale lock and then sweep each other's freshly
    // acquired one; the guard must be gone once the lock is held.
    const dir = tempDir();
    const child = spawnSync(process.execPath, ['-e', '0']);
    writeFileSync(join(dir, 'board.lock'), `${child.pid}\n`);
    await lockBoard(dir);
    expect(existsSync(join(dir, 'board.lock.break'))).toBe(false);
    expect(readFileSync(join(dir, 'board.lock'), 'utf8')).toBe(`${process.pid}\n`);
    unlockBoard(dir);
  });

  test('a crashed breaker\'s guard is itself stale, and costs a round, not the 10s timeout', async () => {
    const dir = tempDir();
    const child = spawnSync(process.execPath, ['-e', '0']);
    writeFileSync(join(dir, 'board.lock'), `${child.pid}\n`);
    writeFileSync(join(dir, 'board.lock.break'), `${child.pid}\n`); // left by a crash
    const before = Date.now();
    await lockBoard(dir);
    expect(Date.now() - before).toBeLessThan(2000);
    expect(existsSync(join(dir, 'board.lock.break'))).toBe(false);
    expect(readFileSync(join(dir, 'board.lock'), 'utf8')).toBe(`${process.pid}\n`);
    unlockBoard(dir);
  });

  test('interop: an externally written lock with a live pid blocks until removed', async () => {
    const dir = tempDir();
    // pid 1 is always alive and never ours — kill(1, 0) is EPERM, which means
    // "exists". This is the bash side's lock as shlock would leave it.
    writeFileSync(join(dir, 'board.lock'), '1\n');
    let acquired = false;
    const attempt = lockBoard(dir).then(() => {
      acquired = true;
    });
    await sleep(450);
    expect(acquired).toBe(false);
    unlinkSync(join(dir, 'board.lock')); // the bash side's board_unlock
    await attempt;
    expect(acquired).toBe(true);
    expect(readFileSync(join(dir, 'board.lock'), 'utf8')).toBe(`${process.pid}\n`);
    unlockBoard(dir);
  });

  test(
    'after 10s of a held lock, dies naming the holder pid — lib.sh verbatim',
    { timeout: 15_000 },
    async () => {
      const dir = tempDir();
      writeFileSync(join(dir, 'board.lock'), '1\n');
      await expect(lockBoard(dir)).rejects.toThrow(
        `board is locked by pid 1 after 10s — another orchestrator is writing to ${dir}`,
      );
    },
  );
});

// ── writeBoard ────────────────────────────────────────────────────────────────

describe('writeBoard', () => {
  test('applies the mutate, bumps version, writes jq-shaped JSON', async () => {
    const { dir, file } = boardDir();
    const result = await writeBoard(dir, (board) => {
      const items = board['items'] as Array<Record<string, unknown>>;
      items[0]!['state'] = 'building';
      return board;
    });
    expect(result['version']).toBe(2);
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as {
      version: number;
      items: Array<{ state: string }>;
    };
    expect(onDisk.version).toBe(2);
    expect(onDisk.items[0]?.state).toBe('building');
    // Two-space indent and trailing newline, like jq's output.
    expect(readFileSync(file, 'utf8')).toMatch(/^\{\n {2}"version": 2,/);
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
    // The lock came off.
    expect(existsSync(join(dir, 'board.lock'))).toBe(false);
  });

  test('a missing version bumps to 1 — jq’s (.version // 0) + 1', async () => {
    const { dir } = boardDir(boardWith((b) => delete (b as Record<string, unknown>)['version']));
    const result = await writeBoard(dir, (board) => board);
    expect(result['version']).toBe(1);
  });

  test('refuses a write that would corrupt the board, leaving it untouched', async () => {
    const { dir, file } = boardDir();
    const before = readFileSync(file, 'utf8');
    await expect(
      writeBoard(dir, (board) => {
        // run.sh's case: `.items[0].pr = 938`.
        (board['items'] as Array<Record<string, unknown>>)[0]!['pr'] = 938;
        return board;
      }),
    ).rejects.toThrow(`edit would corrupt ${file} — refused, file left unchanged`);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(existsSync(join(dir, 'board.lock'))).toBe(false); // unlocked on failure
  });

  test('names pre-existing damage instead of blaming the write', async () => {
    const { dir, file } = boardDir(
      boardWith((b) => {
        (b.items[0] as Record<string, unknown>)['pr'] = 938; // invalid BEFORE the write
      }),
    );
    const before = readFileSync(file, 'utf8');
    await expect(writeBoard(dir, (board) => board)).rejects.toThrow(
      `board at ${file} was already invalid BEFORE this write — fix it by hand, then retry`,
    );
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(existsSync(join(dir, 'board.lock'))).toBe(false);
  });

  test('a write that FIXES an invalid board goes through, like the bash', async () => {
    const { dir, file } = boardDir(
      boardWith((b) => {
        (b.items[0] as Record<string, unknown>)['pr'] = 938;
      }),
    );
    await writeBoard(dir, (board) => {
      (board['items'] as Array<Record<string, unknown>>)[0]!['pr'] = { number: 938 };
      return board;
    });
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as {
      items: Array<{ pr: { number: number } }>;
    };
    expect(onDisk.items[0]?.pr).toEqual({ number: 938 });
  });

  test('an in-place mutate cannot fool the already-invalid check', async () => {
    // mutate gets a clone: corrupting the object it was handed must not make
    // the on-disk original look pre-damaged.
    const { dir, file } = boardDir();
    await expect(
      writeBoard(dir, (board) => {
        (board['items'] as Array<Record<string, unknown>>)[0]!['state'] = '';
        return board;
      }),
    ).rejects.toThrow(`edit would corrupt ${file} — refused, file left unchanged`);
  });

  test('no board is an error, not a creation', async () => {
    const dir = tempDir();
    await expect(writeBoard(dir, (board) => board)).rejects.toThrow(
      `no such file: ${join(dir, 'board.json')}`,
    );
  });
});

// ── readBoardDoc / readBoardRaw ───────────────────────────────────────────────

describe('readBoardDoc', () => {
  test('hands back version, updatedAt and the lossily-decoded items', () => {
    const { file } = boardDir();
    const { value, warnings } = readBoardDoc(file);
    expect(value.version).toBe(1);
    expect(value.updatedAt).toBe('2026-08-01T00:00:00Z');
    expect(value.items.map((item) => item.id)).toEqual(['itm_1', 'itm_2']);
    expect(warnings).toEqual([]);
  });

  test('a corrupt item costs the item; the raw read still sees it', () => {
    const doc = boardWith((b) => {
      (b.items as unknown[]).push({ id: 42, title: true });
    });
    const { file } = boardDir(doc);
    const { value, warnings } = readBoardDoc(file);
    expect(value.items).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    // The summary counts come off the raw parse, malformed items included.
    const raw = readBoardRaw(file);
    expect(((raw.json as Record<string, unknown>)['items'] as unknown[]).length).toBe(3);
  });

  test('missing and unparseable are separate raw outcomes', () => {
    const dir = tempDir();
    expect(readBoardRaw(join(dir, 'board.json')).missing).toBe(true);
    writeFileSync(join(dir, 'torn.json'), '{"items":');
    expect(readBoardRaw(join(dir, 'torn.json')).error).toBeDefined();
  });
});

// ── atomicWriteJson / appendLog ───────────────────────────────────────────────

describe('atomicWriteJson', () => {
  test('writes pretty JSON with a trailing newline', () => {
    const dir = tempDir();
    const file = join(dir, 'github.json');
    atomicWriteJson(file, { repos: [] });
    expect(readFileSync(file, 'utf8')).toBe('{\n  "repos": []\n}\n');
  });

  test('refuses an empty payload, leaving the target alone', () => {
    const dir = tempDir();
    const file = join(dir, 'github.json');
    writeFileSync(file, '{"repos":[]}');
    expect(() => atomicWriteJson(file, undefined)).toThrow(`refusing to write an empty ${file}`);
    expect(readFileSync(file, 'utf8')).toBe('{"repos":[]}');
  });
});

describe('appendLog', () => {
  test('appends lib.sh-shaped lines: {at, event, itemId, ...kv}, compact', () => {
    const dir = join(tempDir(), 'p', 'test'); // mkdir -p, like log_event
    appendLog(dir, 'dispatch', 'itm_1', { state: 'dispatched' });
    appendLog(dir, 'cycle', '-');
    const lines = readFileSync(join(dir, 'log.jsonl'), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(Object.keys(first)).toEqual(['at', 'event', 'itemId', 'state']);
    expect(first['event']).toBe('dispatch');
    expect(first['itemId']).toBe('itm_1');
    expect(first['state']).toBe('dispatched');
    expect(first['at']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // Compact, no spaces — jq -c's rendering.
    expect(lines[0]).not.toContain(': ');

    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(second['itemId']).toBeNull(); // "-" is the shell's spelling of null
  });
});
