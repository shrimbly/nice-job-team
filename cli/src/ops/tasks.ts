// tasks.sh, whole: the markdown tracker's read side. One file per task,
// committed to the repository it belongs to — a backlog that needs no account,
// works offline, and is reviewed in the same pull requests as the code.
//
//   board tasks --list     every task as JSON, for the orchestrator
//   board tasks --open     ...only the ones not done or dropped
//   board tasks --index    (re)write TASKS.md, the human-readable view
//
// THIS MODULE NEVER WRITES A TASK'S STATUS, and there is deliberately no flag
// that does. The status field is the operator's intent — todo, doing, done —
// and it lives on a branch like every other committed file. An agent that
// wrote "done" into it would be writing to its own branch, so the change would
// land only when the PR merged, and every parallel agent would conflict on the
// same lines. Live state belongs to board.json and the PR; this file says what
// a person wants.
//
// `--index` reads board.json to annotate each task with what actually happened,
// so a task still marked `todo` beside a merged PR is visible without either
// side writing to the other. Display-only: the note is derived every time and
// written into the generated TASKS.md alone, never back into a task file.

import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cfg, loadRoot, readConfig, resolveBoardDir } from '../config.js';
import type { BoardConfigFile, TrackerTask } from '../types.js';

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** jq's `\(x)` interpolation: strings as-is, everything else its JSON. */
function interp(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'null';
  return JSON.stringify(value) ?? 'null';
}

// ── Where the tasks live ──────────────────────────────────────────────────────
// Inside the repository, not in the orchestrator's state directory. The whole
// point is that they are versioned with the code and travel with a clone.
//
// Hidden by default so the directory does not collide with a `tasks/` that the
// project already uses for something else. TASKS.md at the root is the visible
// surface, and it is generated.

export interface TrackerPaths {
  repoRoot: string;
  /** tracker.path — the directory RELATIVE to the repo root, default ".tasks". */
  tasksRel: string;
  tasksDir: string;
  indexFile: string;
}

/**
 * tasks.sh's preamble: the repo is $SUPERSET_ORCH_REPO or repos[0].name, and
 * its localPath anchors everything. Throws tasks.sh's exact die when there is
 * no localPath — the one hard stop this verb has.
 */
export function resolveTrackerPaths(
  config: BoardConfigFile,
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): TrackerPaths {
  const repos = Array.isArray(config.repos) ? config.repos : [];
  // cfg '.repos[0].name' '' — a missing or non-string name reads as "".
  const first = repos[0];
  let repoName = isObj(first) && typeof first['name'] === 'string' ? first['name'] : '';
  const override = env['SUPERSET_ORCH_REPO'];
  // `[ -n "$SUPERSET_ORCH_REPO" ]` — only a non-empty override wins.
  if (override !== undefined && override !== '') repoName = override;

  // repo_cfg "$repo_name" '.localPath': first configured repo with that name.
  let repoRoot = '';
  for (const repo of repos) {
    if (!isObj(repo) || repo['name'] !== repoName) continue;
    const localPath = repo['localPath'];
    if (typeof localPath === 'string' && localPath !== '') repoRoot = localPath;
    break;
  }
  if (repoRoot === '') {
    throw new Error(`no localPath for ${repoName} in ${configPath} — run board init`);
  }

  // cfg '.tracker.path' '.tasks' — cfg's fallbacks (missing, null, false and
  // "" all mean the default) live in config.ts; String() is jq -r's rendering.
  const tasksRel = String(cfg<string>(config, '.tracker.path', '.tasks'));

  return {
    repoRoot,
    tasksRel,
    tasksDir: join(repoRoot, tasksRel),
    indexFile: join(repoRoot, 'TASKS.md'),
  };
}

// ── Frontmatter ───────────────────────────────────────────────────────────────
// Deliberately not a YAML parser — a straight port of the awk in tasks.sh. The
// format is `key: value` scalars between two `---` lines and nothing else,
// because a backlog that needs a YAML library to read is not the simple thing
// this is for. Anything more elaborate is ignored rather than guessed at: a
// list item has no top-level key so it parses to nothing, and a nested block's
// scalar lines surface only under keys nobody asks for. Limits kept exactly:
// the opening `---` must be line 1, the first occurrence of a key wins, keys
// and values are whitespace-trimmed, and one leading plus one trailing double
// quote are stripped (gsub of an anchored pattern touches at most one each).

interface ParsedTaskFile {
  fm: Map<string, string>;
  body: string;
  lines: string[];
}

function parseTaskFile(content: string): ParsedTaskFile {
  const lines = content.split('\n');
  const fm = new Map<string, string>();
  const bodyLines: string[] = [];
  let inside = false;
  let body = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (i === 0 && line === '---') {
      inside = true;
      continue;
    }
    if (inside && line === '---') {
      inside = false;
      body = true;
      continue;
    }
    if (inside) {
      const colon = line.indexOf(':');
      if (colon === -1) continue; // awk: no colon, no scalar — skipped, not guessed
      const key = line.slice(0, colon).replace(/^[ \t]+|[ \t]+$/g, '');
      let val = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, '');
      val = val.replace(/^"/, '').replace(/"$/, '');
      if (!fm.has(key)) fm.set(key, val); // fm_value prints the first and exits
      continue;
    }
    if (body) bodyLines.push(line);
  }
  // `body="$(fm_body ...)"` — command substitution strips trailing newlines.
  // A file with no frontmatter (or an unclosed one) has an EMPTY body: the awk
  // only starts printing after the CLOSING `---`.
  return { fm, body: bodyLines.join('\n').replace(/\n+$/, ''), lines };
}

/** The shell's `[ -n ... ]` fallback chain: empty reads the same as absent. */
function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/**
 * One task from one file. A file with no frontmatter still becomes a task —
 * the filename is the id and the first heading the title — so a plain note
 * dropped into the directory is not silently ignored.
 */
function taskFromFile(paths: TrackerPaths, name: string, content: string): TrackerTask {
  const parsed = parseTaskFile(content);
  const id = nonEmpty(parsed.fm.get('id')) ?? name.replace(/\.md$/, '');
  // grep -m1 '^# ' over the WHOLE file, frontmatter included, then sed strips
  // the one leading "# ".
  const heading = parsed.lines.find((line) => line.startsWith('# '))?.replace(/^# /, '');
  const title = nonEmpty(parsed.fm.get('title')) ?? nonEmpty(heading) ?? id;
  const status = nonEmpty(parsed.fm.get('status')) ?? 'todo';
  const priority = nonEmpty(parsed.fm.get('priority')) ?? 'medium';
  return {
    id,
    title,
    status,
    priority,
    path: join(paths.tasksDir, name),
    relPath: `${paths.tasksRel}/${name}`,
    body: parsed.body,
  };
}

// ── Listing ───────────────────────────────────────────────────────────────────

/** The status vocabulary, in the order a person would work: doing first. */
const STATUS_RANK: Record<string, number> = { doing: 0, todo: 1, done: 2, dropped: 3 };
/** The priority vocabulary. Unknown words rank as medium, like jq's `// 2`. */
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/**
 * Every task in the directory, sorted the way tasks.sh's jq sorted: status
 * rank, then priority rank, then id — ties keep id order so two reads of an
 * unchanged directory cannot disagree. A missing directory is an empty
 * backlog, not an error.
 */
export function readTrackerTasks(paths: TrackerPaths, openOnly = false): TrackerTask[] {
  let entries;
  try {
    entries = readdirSync(paths.tasksDir, { withFileTypes: true });
  } catch {
    return []; // `[ -d "$TASKS_DIR" ] || printf '[]'`
  }
  const tasks: TrackerTask[] = [];
  // The shell globbed "$TASKS_DIR"/*.md: sorted names, dotfiles excluded. A
  // DIRECTORY named *.md matched the glob and killed the script when awk read
  // it; skipping it is the recoverable reading of the same verdict.
  const names = entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
  for (const name of names) {
    let content: string;
    try {
      content = readFileSync(join(paths.tasksDir, name), 'utf8');
    } catch {
      continue; // `[ -e "$f" ] || continue` — gone between glob and read
    }
    const task = taskFromFile(paths, name, content);
    if (openOnly && (task.status === 'done' || task.status === 'dropped')) continue;
    tasks.push(task);
  }
  // Array.prototype.sort is stable (Node >= 11), like jq's sort_by.
  tasks.sort((a, b) => {
    const s = (STATUS_RANK[a.status] ?? 1) - (STATUS_RANK[b.status] ?? 1);
    if (s !== 0) return s;
    const p = (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2);
    if (p !== 0) return p;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return tasks;
}

/**
 * poll's tracker pass, in-process — what the tasks.sh --open shell-out fed
 * signals/tasks.json. Every failure is an empty backlog with no warning,
 * because that is exactly what the poll saw when the shell-out exited nonzero:
 * tasks stayed [] and the summary simply had no backlog section.
 */
export function collectOpenTasks(
  config: BoardConfigFile,
  env: NodeJS.ProcessEnv = process.env,
): TrackerTask[] {
  try {
    return readTrackerTasks(resolveTrackerPaths(config, '', env), true);
  } catch {
    return [];
  }
}

// ── The index ─────────────────────────────────────────────────────────────────

const SECTIONS: ReadonlyArray<[status: string, label: string]> = [
  ['doing', 'In progress'],
  ['todo', 'To do'],
  ['done', 'Done'],
  ['dropped', 'Dropped'],
];

/**
 * What the board knows about each task, read-only — board_note. A task the
 * operator still has at `todo` beside a merged PR is the drift this surfaces:
 * neither file writes to the other, so somebody has to be able to see it.
 *
 * Returns a note-per-id lookup over one parse of board.json. The shell re-ran
 * jq per task over the same bytes; one read is the same answer. Its error
 * mask (`2>/dev/null || true`) is ported by granularity: an unreadable board
 * or a malformed item disables every note, while a matched item whose pr is a
 * bare number (the corruption board_validate exists for) silences only that
 * task's note — jq only met the bad pr after `first` had already selected it.
 */
function boardNoteLookup(boardFile: string): (id: string) => string | undefined {
  const none = (): undefined => undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(boardFile, 'utf8'));
  } catch {
    return none; // missing board: `[ -f "$BOARD" ] || return 0`; garbage: jq died
  }
  if (!isObj(doc)) return none;
  const items = Array.isArray(doc['items']) ? doc['items'] : []; // `.items[]?`
  const matches: Obj[] = [];
  for (const item of items) {
    // A non-object item, or a source jq cannot index (a string, a number),
    // errored the whole filter — every note for this board comes back empty.
    if (!isObj(item)) return none;
    const source = item['source'];
    if (source !== undefined && source !== null && !isObj(source)) return none;
    if (isObj(source) && source['kind'] === 'markdown') matches.push(item);
  }
  return (id: string): string | undefined => {
    const item = matches.find(
      (candidate) => (candidate['source'] as Obj)['externalId'] === id,
    );
    if (item === undefined) return undefined; // `first` of nothing → empty
    const pr = item['pr'];
    let suffix = '';
    if (pr !== undefined && pr !== null) {
      if (!isObj(pr)) return undefined; // `.pr.number` on a bare number: jq died
      const number = pr['number'];
      // jq truthiness: only false and null are falsy — 0 would print "PR #0".
      if (number !== undefined && number !== null && number !== false) {
        suffix = ` · PR #${interp(number)}`;
      }
    }
    return `${interp(item['state'])}${suffix}`;
  };
}

/** The generated TASKS.md, byte-for-byte tasks.sh's writer — one exception:
 * the marker comment names `board tasks --index`, the verb that now writes it. */
export function renderTasksIndex(tasks: TrackerTask[], tasksRel: string, boardFile: string): string {
  const note = boardNoteLookup(boardFile);
  let out = '# Tasks\n\n';
  out += `<!-- Generated by board tasks --index. Edit the files in \`${tasksRel}/\`, not this. -->\n\n`;
  for (const [status, label] of SECTIONS) {
    const rows = tasks.filter((task) => task.status === status);
    // Skip a heading with nothing under it rather than print an empty section.
    if (rows.length === 0) continue;
    out += `## ${label}\n\n`;
    for (const task of rows) {
      // Linked by ID, not by filename: a frontmatter id that disagrees with
      // its filename writes a dead link. tasks.sh did the same; kept so the
      // two generators disagree nowhere the fix wouldn't also change.
      let line = `- [${task.title}](${tasksRel}/${task.id}.md) — ${task.priority}`;
      const annotation = note(task.id);
      if (annotation !== undefined && annotation !== '') line += ` · ${annotation}`;
      out += line + '\n';
    }
    out += '\n';
  }
  return out;
}

/**
 * atomic_write, for a file a person may have open: write-then-rename, so no
 * reader sees a half index. Never empty — the header alone survives an empty
 * backlog — so atomic_write's empty-payload refusal has nothing to refuse.
 */
export function writeTasksIndex(paths: TrackerPaths, boardFile: string): string {
  const content = renderTasksIndex(readTrackerTasks(paths), paths.tasksRel, boardFile);
  const tmp = `${paths.indexFile}.tmp.${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, paths.indexFile);
  return paths.indexFile;
}

// ── The verb ──────────────────────────────────────────────────────────────────

function die(message: string): never {
  process.stderr.write(`BLOCKED: ${message}\n`);
  process.exit(1);
}

/**
 * `board tasks [--open|--list|--index]` — tasks.sh's argv surface, minus the
 * scaffolding flags (--new, --path) that stayed with the operator's shell.
 * Like the script (`case "${1---list}"`), only the first argument speaks:
 * no flag means --list, and anything after the first is ignored.
 */
export async function runTasks(argv: string[]): Promise<void> {
  let boardDir: string;
  try {
    // lib.sh resolved the project at source time, before the case statement,
    // so even --list dies on a two-project config with no selection.
    boardDir = resolveBoardDir().boardDir;
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
  const orch = loadRoot();
  const config = readConfig(orch);
  let paths: TrackerPaths;
  try {
    paths = resolveTrackerPaths(config, orch.configPath);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }

  const flag = argv[0] ?? '--list';
  switch (flag) {
    case '--list':
      // jq -c's shape exactly; the shell's missing-directory case dropped the
      // trailing newline, which nothing parsed by — normalised to one line.
      process.stdout.write(JSON.stringify(readTrackerTasks(paths)) + '\n');
      break;
    case '--open':
      process.stdout.write(JSON.stringify(readTrackerTasks(paths, true)) + '\n');
      break;
    case '--index':
      process.stdout.write(writeTasksIndex(paths, join(boardDir, 'board.json')) + '\n');
      break;
    default:
      die(`unknown argument: ${flag}  (try: --list, --open, --index)`);
  }
}
