// ops/tasks.ts against tasks.sh, the script it replaces. The unit tests pin
// the awk's exact frontmatter limits and the sort; the goldens then run the
// REAL tasks.sh (from git history, with its lib.sh) over the same fixture and
// diff the two implementations byte for byte — the one intended difference
// being the TASKS.md marker comment, which now names the board verb. The
// script was deleted from the working tree when the port landed, so the
// goldens read it from the last commit that carried it; on a checkout whose
// history lacks the script entirely (a shallow clone), they skip rather than
// fabricate a golden.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import {
  collectOpenTasks,
  readTrackerTasks,
  renderTasksIndex,
  resolveTrackerPaths,
  writeTasksIndex,
} from '../src/ops/tasks.js';
import type { TrackerPaths } from '../src/ops/tasks.js';
import type { BoardConfigFile } from '../src/types.js';

const repoRootDir = fileURLToPath(new URL('../../', import.meta.url));

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-tasks-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** A repo with a .tasks directory, plus the paths our reader resolves for it. */
function world(): { repoRoot: string; tasksDir: string; paths: TrackerPaths; config: BoardConfigFile } {
  const repoRoot = tempDir();
  const tasksDir = join(repoRoot, '.tasks');
  mkdirSync(tasksDir);
  const config: BoardConfigFile = { repos: [{ name: 'o/r', key: 'test', localPath: repoRoot }] };
  const paths = resolveTrackerPaths(config, '/cfg', {});
  return { repoRoot, tasksDir, paths, config };
}

function task(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}

// ── Resolution ────────────────────────────────────────────────────────────────

describe('resolveTrackerPaths', () => {
  test('repos[0] by default, SUPERSET_ORCH_REPO overriding', () => {
    const config: BoardConfigFile = {
      repos: [
        { name: 'o/first', localPath: '/first' },
        { name: 'o/second', localPath: '/second' },
      ],
    };
    expect(resolveTrackerPaths(config, '/cfg', {}).repoRoot).toBe('/first');
    expect(
      resolveTrackerPaths(config, '/cfg', { SUPERSET_ORCH_REPO: 'o/second' }).repoRoot,
    ).toBe('/second');
    // The shell's `[ -n ]` guard: an empty override does not select "".
    expect(resolveTrackerPaths(config, '/cfg', { SUPERSET_ORCH_REPO: '' }).repoRoot).toBe('/first');
  });

  test('tracker.path defaults to .tasks and moves with the config', () => {
    const config: BoardConfigFile = { repos: [{ name: 'o/r', localPath: '/repo' }] };
    const paths = resolveTrackerPaths(config, '/cfg', {});
    expect(paths.tasksRel).toBe('.tasks');
    expect(paths.tasksDir).toBe('/repo/.tasks');
    expect(paths.indexFile).toBe('/repo/TASKS.md');
    const moved = resolveTrackerPaths({ ...config, tracker: { path: 'docs/tasks' } }, '/cfg', {});
    expect(moved.tasksDir).toBe('/repo/docs/tasks');
  });

  test('no localPath dies with tasks.sh:s message, verb-spelled', () => {
    expect(() => resolveTrackerPaths({ repos: [{ name: 'o/r' }] }, '/cfg', {})).toThrow(
      'no localPath for o/r in /cfg — run board init',
    );
    // No repos at all: the name interpolates as the empty string it read as.
    expect(() => resolveTrackerPaths({}, '/cfg', {})).toThrow(
      'no localPath for  in /cfg — run board init',
    );
  });
});

// ── Frontmatter limits ────────────────────────────────────────────────────────

describe('frontmatter parsing, the awk:s exact limits', () => {
  test('a file with no frontmatter still becomes a task — and has an empty body', () => {
    const { tasksDir, paths } = world();
    task(tasksDir, 'plain-note.md', '# A heading\n\nSome text that is NOT the body field.\n');
    const [t] = readTrackerTasks(paths);
    expect(t).toEqual({
      id: 'plain-note',
      title: 'A heading',
      status: 'todo',
      priority: 'medium',
      path: join(tasksDir, 'plain-note.md'),
      relPath: '.tasks/plain-note.md',
      // The awk prints body lines only AFTER a closing `---`: no frontmatter,
      // no body. tasks.sh behaved identically.
      body: '',
    });
  });

  test('no heading either: the filename is id and title both', () => {
    const { tasksDir, paths } = world();
    task(tasksDir, 'bare.md', 'just text\n');
    expect(readTrackerTasks(paths)[0]).toMatchObject({ id: 'bare', title: 'bare' });
  });

  test('quotes stripped, whitespace trimmed, first occurrence of a key wins', () => {
    const { tasksDir, paths } = world();
    task(
      tasksDir,
      'quoted.md',
      '---\nid: "q-1"\n  title :   "Quoted title"  \nstatus: "doing"\nstatus: dropped\npriority: urgent\n---\nbody\n',
    );
    const [t] = readTrackerTasks(paths);
    expect(t).toMatchObject({
      id: 'q-1',
      title: 'Quoted title',
      status: 'doing', // fm_value printed the first match and exited
      priority: 'urgent',
      body: 'body',
    });
  });

  test('anything richer than key: value scalars is ignored, not guessed at', () => {
    const { tasksDir, paths } = world();
    task(
      tasksDir,
      'rich.md',
      '---\nid: rich\ntags:\n- not-a-scalar\n- status: sneaky\ntitle: Rich\n---\n',
    );
    const [t] = readTrackerTasks(paths);
    // `- not-a-scalar` has no colon (skipped); `- status: sneaky` parses to a
    // key named "- status" nobody asks for. Neither invents a status.
    expect(t).toMatchObject({ id: 'rich', title: 'Rich', status: 'todo' });
  });

  test('the opening --- must be line 1, and an unclosed block still yields keys', () => {
    const { tasksDir, paths } = world();
    task(tasksDir, 'late.md', '\n---\nid: nope\n---\n# Late\n');
    task(tasksDir, 'unclosed.md', '---\nid: open-ended\nstatus: doing\n# Head\n');
    const byFile = Object.fromEntries(readTrackerTasks(paths).map((t) => [t.relPath, t]));
    // Not line 1: no frontmatter at all — id from filename, title from grep.
    expect(byFile['.tasks/late.md']).toMatchObject({ id: 'late', title: 'Late', body: '' });
    // Unclosed: the awk reads keys to EOF but never starts the body.
    expect(byFile['.tasks/unclosed.md']).toMatchObject({
      id: 'open-ended',
      status: 'doing',
      title: 'Head', // grep -m1 '^# ' scans the whole file, frontmatter included
      body: '',
    });
  });

  test('the body keeps its leading blank line and loses trailing newlines', () => {
    const { tasksDir, paths } = world();
    task(tasksDir, 'b.md', '---\nid: b\n---\n\n## Done when\n\n- [ ] a thing\n\n\n');
    expect(readTrackerTasks(paths)[0]!.body).toBe('\n## Done when\n\n- [ ] a thing');
  });
});

// ── Vocabularies, sorting, filtering ──────────────────────────────────────────

function spread(tasksDir: string): void {
  task(tasksDir, 'a-doing-low.md', '---\nid: a-doing-low\nstatus: doing\npriority: low\n---\n');
  task(tasksDir, 'b-doing-high.md', '---\nid: b-doing-high\nstatus: doing\npriority: high\n---\n');
  task(tasksDir, 'c-todo-urgent.md', '---\nid: c-todo-urgent\npriority: urgent\n---\n');
  task(tasksDir, 'd-todo.md', '---\nid: d-todo\n---\n');
  task(tasksDir, 'e-done.md', '---\nid: e-done\nstatus: done\n---\n');
  task(tasksDir, 'f-dropped.md', '---\nid: f-dropped\nstatus: dropped\n---\n');
  // Unknown words rank as todo/medium — jq's `// 1` and `// 2` defaults.
  task(tasksDir, 'g-weird.md', '---\nid: g-weird\nstatus: someday\npriority: whenever\n---\n');
  task(tasksDir, 'tie-2.md', '---\nid: tie-2\n---\n');
  task(tasksDir, 'tie-1.md', '---\nid: tie-1\n---\n');
}

describe('listing', () => {
  test('sorts by status rank, then priority rank, then id — deterministically', () => {
    const { tasksDir, paths } = world();
    spread(tasksDir);
    const ids = readTrackerTasks(paths).map((t) => t.id);
    expect(ids).toEqual([
      'b-doing-high',
      'a-doing-low',
      'c-todo-urgent',
      'd-todo',
      'g-weird',
      'tie-1',
      'tie-2',
      'e-done',
      'f-dropped',
    ]);
    // Two reads of an unchanged directory cannot disagree.
    expect(readTrackerTasks(paths).map((t) => t.id)).toEqual(ids);
  });

  test('--open excludes done and dropped, and ONLY those', () => {
    const { tasksDir, paths } = world();
    spread(tasksDir);
    const ids = readTrackerTasks(paths, true).map((t) => t.id);
    expect(ids).not.toContain('e-done');
    expect(ids).not.toContain('f-dropped');
    expect(ids).toContain('g-weird'); // unknown status is open, not done
    expect(ids).toHaveLength(7);
  });

  test('a missing tasks directory is an empty backlog, not an error', () => {
    const config: BoardConfigFile = { repos: [{ name: 'o/r', localPath: join(tempDir(), 'gone') }] };
    expect(readTrackerTasks(resolveTrackerPaths(config, '/cfg', {}))).toEqual([]);
  });

  test('dotfiles and directories named *.md are not tasks', () => {
    const { tasksDir, paths } = world();
    task(tasksDir, '.hidden.md', '---\nid: hidden\n---\n');
    mkdirSync(join(tasksDir, 'dir.md'));
    task(tasksDir, 'real.md', '---\nid: real\n---\n');
    expect(readTrackerTasks(paths).map((t) => t.id)).toEqual(['real']);
  });

  test('collectOpenTasks is [] on an unresolvable config, silently', () => {
    expect(collectOpenTasks({}, {})).toEqual([]);
    const { tasksDir, config } = world();
    task(tasksDir, 't.md', '---\nid: t\nstatus: done\n---\n');
    task(tasksDir, 'u.md', '---\nid: u\n---\n');
    expect(collectOpenTasks(config, {}).map((t) => t.id)).toEqual(['u']);
  });
});

// ── The index and its board notes ─────────────────────────────────────────────

describe('renderTasksIndex', () => {
  test('sections in work order, empty ones skipped, notes display-only', () => {
    const { repoRoot, tasksDir, paths } = world();
    task(tasksDir, 'ship.md', '---\nid: ship\ntitle: Ship it\nstatus: doing\npriority: high\n---\n');
    task(tasksDir, 'later.md', '---\nid: later\ntitle: Later\n---\n');
    task(tasksDir, 'landed.md', '---\nid: landed\ntitle: Landed\nstatus: done\npriority: low\n---\n');
    const boardFile = join(repoRoot, 'board.json');
    writeFileSync(
      boardFile,
      JSON.stringify({
        items: [
          {
            id: 'itm_1',
            state: 'merged',
            source: { kind: 'markdown', externalId: 'landed' },
            pr: { number: 41 },
          },
          { id: 'itm_2', state: 'building', source: { kind: 'markdown', externalId: 'ship' }, pr: null },
          // A non-markdown source never annotates, whatever its externalId.
          { id: 'itm_3', state: 'closed', source: { kind: 'linear', externalId: 'later' } },
        ],
      }),
    );
    const out = renderTasksIndex(readTrackerTasks(paths), '.tasks', boardFile);
    expect(out).toBe(
      [
        '# Tasks',
        '',
        '<!-- Generated by board tasks --index. Edit the files in `.tasks/`, not this. -->',
        '',
        '## In progress',
        '',
        '- [Ship it](.tasks/ship.md) — high · building',
        '',
        '## To do',
        '',
        '- [Later](.tasks/later.md) — medium',
        '',
        '## Done',
        '',
        '- [Landed](.tasks/landed.md) — low · merged · PR #41',
        '',
        '', // every section closes with a blank line, the last included
      ].join('\n'),
    );
    // Reading the board never writes it: display-only reconciliation.
    expect(readFileSync(boardFile, 'utf8')).toContain('"state":"merged"');
  });

  test('a missing or unreadable board means no notes, not no index', () => {
    const { tasksDir, paths } = world();
    task(tasksDir, 't.md', '---\nid: t\ntitle: T\n---\n');
    const tasks = readTrackerTasks(paths);
    expect(renderTasksIndex(tasks, '.tasks', '/nowhere/board.json')).toContain(
      '- [T](.tasks/t.md) — medium\n',
    );
    const garbled = join(tempDir(), 'board.json');
    writeFileSync(garbled, 'not json');
    expect(renderTasksIndex(tasks, '.tasks', garbled)).toContain('- [T](.tasks/t.md) — medium\n');
  });

  test('a bare-number pr silences that task:s note alone — jq died only there', () => {
    const { repoRoot, tasksDir, paths } = world();
    task(tasksDir, 'bad.md', '---\nid: bad\ntitle: Bad\n---\n');
    task(tasksDir, 'good.md', '---\nid: good\ntitle: Good\n---\n');
    const boardFile = join(repoRoot, 'board.json');
    writeFileSync(
      boardFile,
      JSON.stringify({
        items: [
          { id: 'itm_1', state: 'fixing', source: { kind: 'markdown', externalId: 'bad' }, pr: 938 },
          { id: 'itm_2', state: 'building', source: { kind: 'markdown', externalId: 'good' }, pr: null },
        ],
      }),
    );
    const out = renderTasksIndex(readTrackerTasks(paths), '.tasks', boardFile);
    expect(out).toContain('- [Bad](.tasks/bad.md) — medium\n'); // note suppressed
    expect(out).toContain('- [Good](.tasks/good.md) — medium · building\n');
  });

  test('the index write never touches a task file', () => {
    const { repoRoot, tasksDir, paths } = world();
    task(tasksDir, 't.md', '---\nid: t\nstatus: todo\n---\nbody\n');
    const before = readFileSync(join(tasksDir, 't.md'), 'utf8');
    writeTasksIndex(paths, join(repoRoot, 'board.json'));
    expect(readFileSync(join(tasksDir, 't.md'), 'utf8')).toBe(before);
  });
});

// ── Goldens against tasks.sh itself ───────────────────────────────────────────
// `git show HEAD:` hands us the exact script this module ports; running it
// (bash and jq are still on this machine) over the same fixture makes the
// golden, so the two implementations answer to the same bytes with no frozen
// file to go stale.

interface ShellWorld {
  paths: TrackerPaths;
  boardFile: string;
  run(flag: string): { status: number; stdout: string; stderr: string };
}

/**
 * The script's bytes from git: HEAD while it still existed, else the parent of
 * the commit that deleted it. Null only when history does not reach that far.
 */
function shellSource(name: string): string | null {
  const path = `skills/superset-orchestrator/scripts/${name}`;
  const show = (rev: string) =>
    spawnSync('git', ['-C', repoRootDir, 'show', `${rev}:${path}`], { encoding: 'utf8' });
  let shown = show('HEAD');
  if (shown.status !== 0) {
    const last = spawnSync('git', ['-C', repoRootDir, 'rev-list', '-1', 'HEAD', '--', path], {
      encoding: 'utf8',
    });
    const deleter = last.stdout.trim();
    if (last.status !== 0 || deleter === '') return null;
    shown = show(`${deleter}^`);
    if (shown.status !== 0) return null;
  }
  return shown.stdout;
}

const shellScriptsAvailable = shellSource('tasks.sh') !== null && shellSource('lib.sh') !== null;

function shellWorld(): ShellWorld {
  const scripts = join(tempDir(), 'scripts');
  mkdirSync(scripts);
  for (const name of ['tasks.sh', 'lib.sh']) {
    const source = shellSource(name);
    expect(source).not.toBeNull();
    writeFileSync(join(scripts, name), source!);
    chmodSync(join(scripts, name), 0o755);
  }

  const repoRoot = tempDir();
  const tasksDir = join(repoRoot, '.tasks');
  mkdirSync(tasksDir);
  task(tasksDir, 'b-doing.md', '---\nid: b-doing\ntitle: In flight\nstatus: doing\npriority: high\n---\n\nHalf done.\n');
  task(tasksDir, 'quoted.md', '---\nid: quoted\ntitle: "Say \\"hi\\" loudly"\nstatus: todo\npriority: urgent\n---\n');
  task(tasksDir, 'plain-note.md', '# Just a note\n\nDropped into the directory.\n');
  task(tasksDir, 'done-task.md', '---\nid: done-task\ntitle: Landed already\nstatus: done\npriority: low\n---\n\n## Done when\n\n- [x] it landed\n');
  task(tasksDir, 'dropped-task.md', '---\nid: dropped-task\ntitle: Not doing this\nstatus: dropped\n---\n');
  task(tasksDir, 'weird.md', '---\nid: weird\ntitle: Vocabulary tourist\nstatus: someday\npriority: whenever\n---\n');
  task(tasksDir, 'tie-2.md', '---\nid: tie-2\ntitle: Tie two\n---\n');
  task(tasksDir, 'tie-1.md', '---\nid: tie-1\ntitle: Tie one\n---\n');

  const orchRoot = tempDir();
  mkdirSync(join(orchRoot, 'p', 'test'), { recursive: true });
  const config: BoardConfigFile = { repos: [{ name: 'o/r', key: 'test', localPath: repoRoot }] };
  writeFileSync(join(orchRoot, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  const boardFile = join(orchRoot, 'p', 'test', 'board.json');
  writeFileSync(
    boardFile,
    JSON.stringify({
      version: 1,
      items: [
        {
          id: 'itm_1',
          slug: 's1',
          title: 'T1',
          state: 'merged',
          source: { kind: 'markdown', externalId: 'done-task' },
          pr: { number: 41, url: 'https://gh/41' },
        },
        {
          id: 'itm_2',
          slug: 's2',
          title: 'T2',
          state: 'building',
          source: { kind: 'markdown', externalId: 'b-doing' },
          pr: null,
        },
      ],
    }),
  );

  const home = tempDir();
  const run = (flag: string) =>
    spawnSync('bash', [join(scripts, 'tasks.sh'), flag], {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: home,
        SUPERSET_ORCH_ROOT: orchRoot,
        SUPERSET_ORCH_PROJECT: 'test',
      },
    });

  return { paths: resolveTrackerPaths(config, '/cfg', {}), boardFile, run };
}

describe.skipIf(!shellScriptsAvailable)('goldens against tasks.sh (git history)', () => {
  test('--list and --open are byte-identical to the shell', () => {
    const w = shellWorld();
    for (const [flag, openOnly] of [
      ['--list', false],
      ['--open', true],
    ] as const) {
      const shell = w.run(flag);
      expect(shell.status).toBe(0);
      expect(shell.stdout).toBe(JSON.stringify(readTrackerTasks(w.paths, openOnly)) + '\n');
    }
  });

  test('TASKS.md matches the shell:s, marker comment aside', () => {
    const w = shellWorld();
    const shell = w.run('--index');
    expect(shell.status).toBe(0);
    expect(shell.stdout).toBe(w.paths.indexFile + '\n');
    const golden = readFileSync(w.paths.indexFile, 'utf8');

    const written = writeTasksIndex(w.paths, w.boardFile);
    expect(written).toBe(w.paths.indexFile);
    const ours = readFileSync(w.paths.indexFile, 'utf8');
    // The single intended divergence: the generator names the verb that now
    // writes the file. Everything else — sections, rows, notes — is the
    // shell's bytes.
    expect(ours).toBe(
      golden.replace('Generated by tasks.sh --index', 'Generated by board tasks --index'),
    );
    expect(ours).toContain('· merged · PR #41');
    expect(ours).toContain('· building');
  });
});
