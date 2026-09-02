// poll.sh, whole: the free tier of SENSE. GitHub PR state, CI, unresolved
// review threads, live Superset workspaces, agent status files, session
// liveness — written to the three signals files (this poll's docs also become
// the *.prev.json delta baseline, unless keepBaseline) and summarised for a
// human. No model tokens.
//
// OUTPUT-FORMAT PARITY IS A CONTRACT: watch.sh seds this summary into
// events.log by section header and line shape, so every header and line here
// is byte-for-byte what poll.sh printed — trailing spaces included.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cfg } from '../config.js';
import { collectAgentStatus } from '../facts/agents.js';
import { collectGithub, collectReviewRequests, locateGh } from '../facts/github.js';
import {
  SUPERSET_NOT_LOGGED_IN_WARNING,
  authed,
  configuredProjectIds,
  filterToConfiguredProjects,
  listLocalWorkspaces,
} from '../facts/superset.js';
import { atomicWriteJson, nowIso, readBoardRaw } from '../store.js';
import { GITHUB_ISSUES_KIND, collectGithubIssuesTasks } from '../tracker/github-issues.js';
import { collectOpenTasks } from './tasks.js';
import type {
  BoardConfigFile,
  ExecOptions,
  ExecResult,
  GithubSignalsDoc,
  OrchRoot,
  PollIo,
  ReviewsSignalsDoc,
  TasksSignalsDoc,
  WorkspacesSignalsDoc,
} from '../types.js';

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** jq's `//`: null AND false fall through; "" and 0 are kept. */
function jqAlt<T>(value: unknown, fallback: T): unknown | T {
  return value === undefined || value === null || value === false ? fallback : value;
}

/** jq's truthiness: everything but false and null. */
function jqTruthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

/** jq's `\(x)` interpolation: strings as-is, everything else its JSON. */
function interp(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'null';
  return JSON.stringify(value) ?? 'null';
}

/** jq's string slice `[0:n]` — by codepoint; null slices to null. */
function jqSlice(value: unknown, n: number): unknown {
  if (typeof value === 'string') return [...value].slice(0, n).join('');
  return value === undefined ? null : value;
}

/** jq's `length` over the shapes the summary meets. */
function jqLength(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'string') return [...value].length;
  if (isObj(value)) return Object.keys(value).length;
  return 0;
}

// ── The default IO ────────────────────────────────────────────────────────────

/** Everything runPoll touches outside the process, live. Tests hand a stub. */
export function realPollIo(): PollIo {
  return {
    exec(cmd: string, args: string[], options?: ExecOptions): ExecResult {
      const result = spawnSync(cmd, args, {
        encoding: 'utf8',
        env: options?.env ?? process.env,
        // A check rollup or a comment scrape comfortably exceeds the default.
        maxBuffer: 64 * 1024 * 1024,
      });
      if (result.error !== undefined) {
        return { status: 127, stdout: '', stderr: String(result.error) };
      }
      // Killed by a signal reports no status; any death is a nonzero here.
      return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    },
    now: nowIso,
    nowMs: () => Date.now(),
    homeDir: () => homedir(),
    env: process.env,
    warn: (message: string) => process.stderr.write(`warn: ${message}\n`),
  };
}

// ── Section headers ───────────────────────────────────────────────────────────
// Verbatim from poll.sh. watch.sh's seds anchor on these exact strings.

const HEADER_PRS =
  '── PRs ──────────────────────────────────────────────────────────────';
const HEADER_AGENTS =
  '── Agents ───────────────────────────────────────────────────────────';
const HEADER_NO_STATUS =
  '── Workspaces without a status file ─────────────────────────────────';
const HEADER_DELTAS =
  '── Deltas since last poll ───────────────────────────────────────────';

/**
 * The Backlog header names the tracker that filled the section. The markdown
 * spelling is byte-for-byte poll.sh's — the parity tests pin it — and every
 * other kind pads to the same 69 columns so the section keeps its shape.
 * (watch.ts's events.log extraction anchors on the Deltas and Agents headers,
 * never on this one, so the kind may vary without breaking the seds' port.)
 */
function backlogHeader(kind: string): string {
  return `── Backlog (${kind} tracker, not yet on the board) `.padEnd(69, '─');
}

// ── Sections ──────────────────────────────────────────────────────────────────

/** The 3-day window for CLOSED-UNMERGED lines: poll.sh's `now - 259200`. */
const CLOSED_WINDOW_SECONDS = 259200;

function prSection(doc: GithubSignalsDoc, io: PollIo): string[] {
  const lines = [HEADER_PRS];
  for (const block of doc.repos) {
    const r = block.repo;
    for (const row of block.open) {
      // Two lines from one jq string with an embedded newline.
      lines.push(`  ${interp(r)}#${interp(row['number'])} ${interp(jqSlice(row['title'], 52))}`);
      const awaitingValue = jqAlt(row['threadsAwaitingReviewer'], 0);
      const awaiting =
        typeof awaitingValue === 'number' && awaitingValue > 0
          ? ` awaiting-rereview=${interp(row['threadsAwaitingReviewer'])}`
          : '';
      const draft = jqTruthy(row['isDraft']) ? 'draft ' : '';
      lines.push(
        `      review=${interp(jqAlt(row['reviewDecision'], 'none'))} ci=${interp(row['ciState'])}` +
          ` asks=${interp(row['unresolvedThreads'])}${awaiting} ${draft}` +
          `merge=${interp(jqAlt(row['mergeStateStatus'], '?'))} last=${interp(jqAlt(row['latestActivityAt'], '-'))}`,
      );
    }
    for (const raw of block.merged) {
      if (!isObj(raw)) continue;
      lines.push(
        `  MERGED ${interp(r)}#${interp(raw['number'])} ${interp(jqSlice(raw['title'], 52))} at ${interp(raw['mergedAt'])}`,
      );
    }
    for (const raw of block.closed) {
      if (!isObj(raw)) continue;
      // `select((.closedAt | fromdateiso8601) > (now - 259200))`. A closedAt
      // that does not parse killed the shell's whole jq mid-stream; skipping
      // just the row is the recoverable reading of the same verdict.
      const closedAt = raw['closedAt'];
      if (typeof closedAt !== 'string') continue;
      const epoch = Date.parse(closedAt);
      if (!Number.isFinite(epoch)) continue;
      if (epoch / 1000 <= io.nowMs() / 1000 - CLOSED_WINDOW_SECONDS) continue;
      lines.push(
        `  CLOSED-UNMERGED ${interp(r)}#${interp(raw['number'])} ${interp(jqSlice(raw['title'], 52))} at ${interp(closedAt)}`,
      );
    }
  }
  return lines;
}

function agentsSection(doc: WorkspacesSignalsDoc): string[] {
  const lines = [HEADER_AGENTS];
  for (const s of doc.agentStatus) {
    let line =
      `  ${interp(jqAlt(s['slug'], jqSlice(s['workspaceId'], 8)))}` +
      ` state=${interp(s['state'])} session=${interp(s['sessionLiveness'])} ` +
      `dirty=${interp(s['dirtyFiles'])} unpushed=${interp(s['unpushedCommits'])} `;
    if (jqTruthy(s['needsOperator'])) line += 'NEEDS-OPERATOR ';
    if (jqLength(jqAlt(s['questions'], [])) > 0) line += `questions=${jqLength(s['questions'])} `;
    if (jqTruthy(s['blockedReason'])) line += `blocked=${interp(jqSlice(s['blockedReason'], 60))}`;
    lines.push(line);
  }
  return lines;
}

function noStatusSection(doc: WorkspacesSignalsDoc, config: BoardConfigFile): string[] {
  const lines = [HEADER_NO_STATUS];
  // Only the projects this orchestrator is configured for. A busy host
  // carries dozens of unrelated workspaces, and listing them all buries the
  // two that matter.
  const projects = configuredProjectIds(config.repos);
  // `[.agentStatus[]?.workspaceId]` — nulls included, exactly as jq built it.
  const statusIds = doc.agentStatus.map((s) => s['workspaceId'] ?? null);
  for (const raw of filterToConfiguredProjects(doc.workspaces, projects)) {
    if (!isObj(raw)) continue;
    if (statusIds.includes(raw['id'] ?? null)) continue;
    lines.push(`  ${interp(raw['name'])} [${interp(raw['branch'])}] ${interp(raw['id'])}`);
  }
  return lines;
}

function backlogSection(tasksDoc: TasksSignalsDoc, boardFile: string, trackerKind: string): string[] {
  // `jq '.tasks | length' != "0"` gates the whole section, header included.
  if (jqLength(tasksDoc.tasks) === 0) return [];
  const lines = [backlogHeader(trackerKind)];

  // Only what has no item yet. A task already dispatched is on the board, and
  // listing it here again would read as two pieces of work. An item claims a
  // task by carrying the ACTIVE tracker's kind and the task's id — for
  // github-issues that is source {kind: "github-issues", externalId: "42"},
  // never the synthesized-card kind "github" (see tracker/github-issues.ts).
  const onBoard: unknown[] = [];
  const board = readBoardRaw(boardFile);
  if (isObj(board.json) && Array.isArray(board.json['items'])) {
    for (const item of board.json['items']) {
      if (!isObj(item)) continue;
      const source = item['source'];
      if (!isObj(source) || source['kind'] !== trackerKind) continue;
      onBoard.push(source['externalId'] ?? null);
    }
  }

  // `.tasks[]?` iterates an object's values too; anything else yields nothing.
  const tasks = Array.isArray(tasksDoc.tasks)
    ? tasksDoc.tasks
    : isObj(tasksDoc.tasks)
      ? Object.values(tasksDoc.tasks)
      : [];
  for (const raw of tasks) {
    if (!isObj(raw)) continue;
    if (onBoard.includes(raw['id'] ?? null)) continue;
    lines.push(
      `  ${interp(raw['status'])}/${interp(raw['priority'])}  ${interp(raw['id'])}  ${interp(jqSlice(raw['title'], 52))}`,
    );
  }
  return lines;
}

/** The delta pass's `def ready` — approved, green, mergeable, nothing asked. */
function ready(row: Obj | null): boolean {
  if (row === null) return false;
  const mergeState = jqAlt(row['mergeStateStatus'], '');
  return (
    row['reviewDecision'] === 'APPROVED' &&
    row['ciState'] === 'green' &&
    (mergeState === 'CLEAN' || mergeState === 'HAS_HOOKS') &&
    jqAlt(row['unresolvedThreads'], 0) === 0 &&
    jqAlt(row['isDraft'], false) === false
  );
}

/** The previous poll's open row for (repo, number), or null. */
function previousOpen(oldRepos: unknown[], repo: unknown, number: unknown): Obj | null {
  for (const block of oldRepos) {
    if (!isObj(block) || block['repo'] !== repo) continue;
    const open = block['open'];
    if (!Array.isArray(open)) continue;
    for (const row of open) {
      if (isObj(row) && row['number'] === number) return row;
    }
  }
  return null;
}

function deltasSection(doc: GithubSignalsDoc, prevFile: string): string[] {
  const lines = [HEADER_DELTAS];
  if (!existsSync(prevFile)) {
    lines.push('  (first poll — no baseline)');
    return lines;
  }
  let previous: unknown;
  try {
    previous = JSON.parse(readFileSync(prevFile, 'utf8'));
  } catch {
    // The shell's `2>/dev/null || true`: a bad baseline yields no lines.
    return lines;
  }
  const oldRepos =
    isObj(previous) && Array.isArray(previous['repos']) ? previous['repos'] : [];

  // Pass 1: every open PR whose activity, review decision or CI changed.
  for (const block of doc.repos) {
    const r = block.repo;
    for (const row of block.open) {
      const was = previousOpen(oldRepos, r, row['number']);
      const changed =
        was === null ||
        (was['latestActivityAt'] ?? null) !== (row['latestActivityAt'] ?? null) ||
        (was['reviewDecision'] ?? null) !== (row['reviewDecision'] ?? null) ||
        (was['ciState'] ?? null) !== (row['ciState'] ?? null);
      if (!changed) continue;
      if (ready(row) && !ready(was)) {
        lines.push(
          `  ★ READY TO MERGE  ${interp(r)}#${interp(row['number'])} ${interp(jqSlice(row['title'], 56))} — approved, green, no conflicts`,
        );
      } else {
        lines.push(
          `  ${interp(r)}#${interp(row['number'])}: review ${interp(jqAlt(was?.['reviewDecision'], '-'))}→${interp(jqAlt(row['reviewDecision'], '-'))} ` +
            `ci ${interp(jqAlt(was?.['ciState'], '-'))}→${interp(row['ciState'])} ` +
            `threads ${interp(jqAlt(was?.['unresolvedThreads'], '-'))}→${interp(row['unresolvedThreads'])}`,
        );
      }
    }
  }

  // Pass 2: the pass above only walks .open in the NEW file, so a PR that
  // LEAVES the open list produces no delta at all. Catch open → closed-unmerged.
  for (const block of doc.repos) {
    for (const raw of block.closed) {
      if (!isObj(raw)) continue;
      const wasOpen = previousOpen(oldRepos, block.repo, raw['number']);
      if (wasOpen === null) continue;
      lines.push(
        `  ✖ CLOSED UNMERGED  ${interp(block.repo)}#${interp(raw['number'])} ${interp(jqSlice(raw['title'], 56))} at ${interp(raw['closedAt'])} — branch ${interp(raw['headRefName'])}`,
      );
    }
  }
  return lines;
}

// ── The poll ──────────────────────────────────────────────────────────────────

export interface PollOptions {
  /** poll.sh's `--repo owner/name`: limit the GitHub pass to one repo. */
  onlyRepo?: string;
  /** Bypass locateGh — tests pin a stub path; null means "no gh anywhere". */
  ghPath?: string | null;
  /**
   * This caller does not own the delta baseline: the *.prev.json files are
   * left exactly as they are. `board refresh` (the app's loop) sets this so
   * its polls cannot absorb the transitions the cycle/watch daemon reports —
   * the ★ READY TO MERGE and ✖ CLOSED UNMERGED lines in events.log are diffs
   * against the baseline, and only the poll that reads those diffs may
   * advance it.
   */
  keepBaseline?: boolean;
}

/**
 * Whose pull requests land on the board. `@me` is the authenticated user,
 * which is right for a single operator and wrong for a team. "*"/"all" mean
 * every PR in the repo; the review-requested query keeps its own spelling —
 * there is no PR awaiting review from everybody, so it falls back to @me
 * rather than matching nothing.
 */
function resolveAuthor(config: BoardConfigFile): {
  authorFilter: string | null;
  reviewLogin: string | null;
} {
  // Read the flag directly: cfg() ports jq's `//`, which treats false as
  // absent and would silently flip an explicit false back to the default.
  const includeReviews = config.operator?.includeReviewRequests !== false;
  const author = String(cfg<string>(config, '.operator.githubLogin', '@me'));
  if (author === '' || author === '*' || author === 'all') {
    return { authorFilter: null, reviewLogin: includeReviews ? '@me' : null };
  }
  return { authorFilter: author, reviewLogin: includeReviews ? author : null };
}

/**
 * One poll over one project directory: collect, write the three signals files
 * (and, when this caller owns the delta baseline, the *.prev.json pair — see
 * PollOptions.keepBaseline), and hand back the summary EXACTLY as poll.sh
 * printed it — the four sections plus the deltas. Warnings go through io.warn
 * as they happen, the way the shell's went to stderr mid-run.
 */
export function runPoll(
  root: OrchRoot,
  projectDir: string,
  config: BoardConfigFile,
  io: PollIo,
  options: PollOptions = {},
): string {
  const signalsDir = join(projectDir, 'signals');
  mkdirSync(signalsDir, { recursive: true });

  const stallRaw = Number(cfg<number>(config, '.limits.stallMinutes', 45));
  const stallMinutes = Number.isFinite(stallRaw) ? stallRaw : 45;
  const { authorFilter, reviewLogin } = resolveAuthor(config);

  // ── GitHub ──
  const githubFile = join(signalsDir, 'github.json');
  const githubPrevFile = join(signalsDir, 'github.prev.json');
  // The previous poll's file, read BEFORE it is overwritten: preview URLs are
  // fixed for the life of a branch, and re-scraping them every cycle was the
  // single largest cost of the poll.
  let previousSignals: unknown;
  try {
    previousSignals = JSON.parse(readFileSync(githubFile, 'utf8'));
  } catch {
    previousSignals = undefined;
  }

  const gh = options.ghPath !== undefined ? options.ghPath : locateGh(io);
  const configuredRepos = Array.isArray(config.repos) ? config.repos : [];
  const repoNames = configuredRepos
    .map((repo) => (isObj(repo) ? repo['name'] : undefined))
    .filter((name): name is string => typeof name === 'string')
    .filter((name) => options.onlyRepo === undefined || name === options.onlyRepo);

  const ourLoginsRaw = config.operator?.githubLogins;
  const ourLogins = Array.isArray(ourLoginsRaw)
    ? ourLoginsRaw.filter((login): login is string => typeof login === 'string')
    : [];
  const patternsRaw = config.preview?.patterns;
  const previewPatterns = Array.isArray(patternsRaw)
    ? patternsRaw.filter((p): p is string => typeof p === 'string')
    : null;

  const repos = collectGithub(io, gh, repoNames, authorFilter, reviewLogin, {
    ourLogins,
    previousSignals,
    previewPatterns,
  });
  const githubDoc: GithubSignalsDoc = { collectedAt: io.now(), repos };
  atomicWriteJson(githubFile, githubDoc);

  // ── The review queue ──
  // Collected whatever operator.includeReviewRequests says: that flag governs
  // whether review-requested PRs join the BOARD's open list, and the reviews
  // lane exists precisely so they can live somewhere else. `@me` stands in
  // when the author filter is off ("*"/"all"/"") — there is no queue of PRs
  // awaiting review from everybody.
  const reviewsFile = join(signalsDir, 'reviews.json');
  let previousReviews: unknown;
  try {
    previousReviews = JSON.parse(readFileSync(reviewsFile, 'utf8'));
  } catch {
    previousReviews = undefined;
  }
  const reviewsDoc: ReviewsSignalsDoc = {
    collectedAt: io.now(),
    reviews: collectReviewRequests(io, gh, repoNames, authorFilter ?? '@me', {
      previousSignals: previousReviews,
      previewPatterns,
    }),
  };
  atomicWriteJson(reviewsFile, reviewsDoc);

  // ── Superset + agents ──
  let workspaces: unknown[] = [];
  if (authed(io)) {
    workspaces = listLocalWorkspaces(io);
  } else {
    io.warn(SUPERSET_NOT_LOGGED_IN_WARNING);
  }
  const agents = collectAgentStatus(root.workspacesDir, workspaces, stallMinutes, io);
  for (const warning of agents.warnings) io.warn(warning);

  const workspacesFile = join(signalsDir, 'workspaces.json');
  const workspacesDoc: WorkspacesSignalsDoc = {
    collectedAt: io.now(),
    workspaces,
    agentStatus: agents.agentStatus,
  };
  atomicWriteJson(workspacesFile, workspacesDoc);

  // ── Tracker backlog ──
  // Free, like the rest of the poll. Markdown reads task files in the repo
  // (in-process since P4 — ops/tasks.ts replaced the tasks.sh shell-out);
  // github-issues asks the gh already located above (tracker/github-issues.ts,
  // since P6). A Linear backlog needs an API session, which makes it a scout
  // job, so its poll collects nothing. Every failure inside either pass is []
  // with no warning, the same silent no-backlog the poll showed when the
  // shell-out exited nonzero.
  const trackerKind = String(cfg<string>(config, '.tracker.kind', ''));
  let tasks: unknown = [];
  if (trackerKind === 'markdown') {
    tasks = collectOpenTasks(config, io.env);
  } else if (trackerKind === GITHUB_ISSUES_KIND) {
    tasks = collectGithubIssuesTasks(io, config, gh);
  }
  const tasksDoc: TasksSignalsDoc = { collectedAt: io.now(), tasks };
  atomicWriteJson(join(signalsDir, 'tasks.json'), tasksDoc);

  // ── Summary ──
  const lines = [
    ...prSection(githubDoc, io),
    ...agentsSection(workspacesDoc),
    ...noStatusSection(workspacesDoc, config),
    ...backlogSection(tasksDoc, join(projectDir, 'board.json'), trackerKind),
    ...deltasSection(githubDoc, githubPrevFile),
  ];

  // ── The delta baseline ──
  // *.prev.json advances AFTER the deltas above were taken, and from the doc
  // THIS poll collected — not (as poll.sh did) by copying whatever
  // signals/github.json held before the write. The two are identical with one
  // writer, but `board refresh` (the app's loop) also rewrites github.json
  // between daemon cycles: rotating from disk would diff the daemon's next
  // poll against the app's minute-old snapshot and silently absorb every
  // transition the app saw first. A refresh caller sets keepBaseline and the
  // files are not touched at all, so the baseline moves only under the poll
  // whose summary is actually read for deltas (board poll / cycle / watch).
  if (options.keepBaseline !== true) {
    atomicWriteJson(githubPrevFile, githubDoc);
    atomicWriteJson(join(signalsDir, 'workspaces.prev.json'), workspacesDoc);
  }
  return lines.join('\n');
}
