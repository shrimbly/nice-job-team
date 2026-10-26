// poll.sh, whole: the free tier of SENSE. GitHub PR state, CI, unresolved
// review threads, live Superset workspaces, agent status files, session
// liveness — written to the three signals files (this poll's docs also become
// the *.prev.json delta baseline, unless keepBaseline) and summarised for a
// human. No model tokens.
//
// OUTPUT-FORMAT PARITY IS A CONTRACT: watch.sh seds this summary into
// events.log by section header and line shape, so every header and line here
// is byte-for-byte what poll.sh printed — trailing spaces included.

import { spawn, spawnSync } from 'node:child_process';
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
    execAsync(cmd: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
      return new Promise<ExecResult>((resolve) => {
        const child = spawn(cmd, args, { env: options?.env ?? process.env });
        let stdout = '';
        let stderr = '';
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.on('data', (chunk: string) => {
          stderr += chunk;
        });
        // spawn never throws for a missing binary — it emits 'error'; mirror the
        // sync path's status 127 there, and a signal death (null code) as 1.
        child.on('error', (err) => resolve({ status: 127, stdout: '', stderr: String(err) }));
        child.on('close', (code) => resolve({ status: code ?? 1, stdout, stderr }));
      });
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
  /**
   * Somewhere to keep the GitHub pass for the rest of one refresh.
   *
   * The GitHub queries are global: the repos come from `config.repos`, not
   * from the project, so every project polled asks GitHub the same questions
   * and gets the same answers, which it then writes into its own signals
   * directory. Three configured projects meant three identical passes — the
   * same forty-five `gh` calls run three times, a minute of wall clock spent
   * asking twice for what was already answered, and, at a sixty-second poll,
   * enough traffic on its own to exhaust the hour's API budget and leave the
   * board showing a degradation note instead of a board.
   *
   * Pass one object across the projects of a single refresh and the pass
   * happens once. Each project still writes its own copy, so nothing about
   * what a board shows changes; they now agree on `collectedAt` as well,
   * having genuinely been collected at one moment.
   */
  shared?: SharedGithubPass;
  /**
   * Consult (and fill) the orch-root poll cache — the DISK counterpart to
   * `shared`, which only spans one process's refresh. `shared` cannot help the
   * separate per-project watcher processes, or the app's next refresh: those
   * re-fetched the identical global PR set every time. With this set, a poll
   * within cadence.pollCacheSeconds of the last one reuses its result instead
   * of hitting GitHub. Off by default (and always off with --repo): a bare
   * `board poll` stays a genuine live poll, the daemon (cycle) and the app
   * (refresh) opt in.
   */
  pollCache?: boolean;
}

/** Filled in by the first project of a refresh, read by the rest. */
export interface SharedGithubPass {
  github?: GithubSignalsDoc;
  reviews?: ReviewsSignalsDoc;
}

// ── The orch-root poll cache ────────────────────────────────────────────────────
// The disk counterpart to SharedGithubPass. Every per-project watcher runs in
// its own process on its own interval, and the app refreshes on its own; each
// re-fetched the identical GLOBAL PR set (repos come from config, not the
// project). This caches one poll's github/reviews result at the orch root,
// keyed on the repo set, so any caller within the TTL reuses it. `collectedAt`
// is compared against the injected clock, so a fresh temp-rooted test poll (its
// clock stamped far in the past) never reads a stale cache written under real
// time — and, more importantly, the cache is opt-in, so only the daemon and the
// app touch it at all.

interface PollCacheEntry {
  /** The moment the cached pass was collected — the doc's own collectedAt. */
  collectedAt: string;
  /** The repo set the pass covered; a config change invalidates the cache. */
  repoNames: string[];
  /** The signals doc to write into a project's own signals directory. */
  payload: unknown;
}

function pollCachePath(root: OrchRoot, kind: 'github' | 'reviews'): string {
  return join(root.root, 'signals-cache', `${kind}.json`);
}

function sameRepoSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((name) => set.has(name));
}

/**
 * The cached pass for this repo set, if one was collected within `ttlSeconds`
 * of `nowIso`. Undefined on a miss for any reason — no file, unparseable, a
 * different repo set, too old, or a collectedAt in the future (a clock skew we
 * refuse to trust). `nowIso` is the caller's clock so the age is measured the
 * same way collectedAt was stamped.
 */
function readPollCache(
  root: OrchRoot,
  kind: 'github' | 'reviews',
  repoNames: string[],
  nowIso: string,
  ttlSeconds: number,
): unknown | undefined {
  let entry: PollCacheEntry;
  try {
    entry = JSON.parse(readFileSync(pollCachePath(root, kind), 'utf8')) as PollCacheEntry;
  } catch {
    return undefined;
  }
  if (entry === null || typeof entry !== 'object') return undefined;
  if (typeof entry.collectedAt !== 'string' || !Array.isArray(entry.repoNames)) return undefined;
  const ageSeconds = (Date.parse(nowIso) - Date.parse(entry.collectedAt)) / 1000;
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0 || ageSeconds >= ttlSeconds) return undefined;
  if (!sameRepoSet(entry.repoNames, repoNames)) return undefined;
  return entry.payload;
}

function writePollCache(
  root: OrchRoot,
  kind: 'github' | 'reviews',
  repoNames: string[],
  collectedAt: string,
  payload: unknown,
): void {
  try {
    mkdirSync(join(root.root, 'signals-cache'), { recursive: true });
    const entry: PollCacheEntry = { collectedAt, repoNames, payload };
    atomicWriteJson(pollCachePath(root, kind), entry);
  } catch {
    // The cache is an optimisation; a failure to write it must never fail the
    // poll — the project's own signals were already written from the same doc.
  }
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
export async function runPoll(
  root: OrchRoot,
  projectDir: string,
  config: BoardConfigFile,
  io: PollIo,
  options: PollOptions = {},
): Promise<string> {
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

  // `--repo` narrows the repo set, so a pass collected without it is not the
  // pass this call is asking for. No caller does both today; this is here so
  // that adding one cannot silently write another repo set's answers. The
  // disk cache stands on the same guard, for the same reason.
  const shared = options.onlyRepo === undefined ? options.shared : undefined;
  const cacheOn = options.pollCache === true && options.onlyRepo === undefined;
  // Default the TTL to three-quarters of the watch interval: the owning watcher
  // still re-fetches every cycle (its own cache has aged past the TTL by then),
  // while siblings and the app, polling inside the window, reuse it.
  const watchSecondsRaw = Number(cfg<number>(config, '.cadence.watchSeconds', 120));
  const watchSeconds = Number.isFinite(watchSecondsRaw) && watchSecondsRaw > 0 ? watchSecondsRaw : 120;
  const cacheTtlRaw = Number(
    cfg<number>(config, '.cadence.pollCacheSeconds', Math.max(30, Math.round(watchSeconds * 0.75))),
  );
  const cacheTtl = Number.isFinite(cacheTtlRaw) ? cacheTtlRaw : 0;

  // ── Throttle state, read from the previous github doc ──
  // The previous poll recorded how much GraphQL budget was left, how many PRs
  // it enriched, and when it last fetched merged/closed. Those drive three
  // cheap economies: fetch the rarely-changing merged/closed lists only every
  // so often, widen the cache when the board is idle, and back off hard as the
  // hourly budget drains so the board never starves the agents.
  const prevDoc = isObj(previousSignals) ? (previousSignals as Record<string, unknown>) : undefined;
  const prevRate = typeof prevDoc?.['rateRemaining'] === 'number' ? (prevDoc['rateRemaining'] as number) : null;
  const prevEnriched =
    typeof prevDoc?.['enrichedCount'] === 'number' ? (prevDoc['enrichedCount'] as number) : null;
  const prevMergedClosedAt =
    typeof prevDoc?.['mergedClosedAt'] === 'string' ? (prevDoc['mergedClosedAt'] as string) : null;

  const num = (path: string, dflt: number): number => {
    const v = Number(cfg<number>(config, path, dflt));
    return Number.isFinite(v) ? v : dflt;
  };
  const softFloor = num('.limits.rateLimitSoftFloor', 1000);
  const hardFloor = num('.limits.rateLimitHardFloor', 200);
  const belowSoft = prevRate !== null && prevRate < softFloor;
  const belowHard = prevRate !== null && prevRate < hardFloor;

  // merged/closed: fetch only every mergedClosedEverySeconds; a low budget also
  // forces reuse. Between fetches collectGithub reuses the previous lists.
  const mcEvery = num('.cadence.mergedClosedEverySeconds', 600);
  const mcAgeSeconds =
    prevMergedClosedAt === null
      ? Infinity
      : (Date.parse(io.now()) - Date.parse(prevMergedClosedAt)) / 1000;
  const wantMergedClosed = !belowSoft && (!Number.isFinite(mcAgeSeconds) || mcAgeSeconds >= mcEvery);

  // Effective disk-cache TTL: longer when the last poll found the board idle
  // (nothing to enrich), longer again when the budget is low.
  const idleTtl = num('.cadence.pollCacheIdleSeconds', 0);
  let effectiveTtl = cacheTtl;
  if (prevEnriched === 0 && idleTtl > effectiveTtl) effectiveTtl = idleTtl;
  if (belowSoft) effectiveTtl = Math.max(effectiveTtl, cacheTtl * 3);

  const hasPrevGithub = isObj(previousSignals) && Array.isArray(prevDoc?.['repos']);
  // Last resort: budget critically low and we hold a previous fetch — serve it
  // and make no GitHub calls at all this poll.
  const serveCacheOnly = belowHard && hasPrevGithub;

  let githubDoc = shared?.github;
  if (githubDoc === undefined && cacheOn && effectiveTtl > 0) {
    githubDoc = readPollCache(root, 'github', repoNames, io.now(), effectiveTtl) as
      | GithubSignalsDoc
      | undefined;
  }
  if (githubDoc === undefined && serveCacheOnly) {
    githubDoc = previousSignals as GithubSignalsDoc;
  }
  if (githubDoc === undefined) {
    let stats: { rateRemaining: number | null; enriched: number } = { rateRemaining: null, enriched: 0 };
    const repos = await collectGithub(
      io,
      gh,
      repoNames,
      authorFilter,
      reviewLogin,
      { ourLogins, previousSignals, previewPatterns, onStats: (s) => { stats = s; } },
      wantMergedClosed,
    );
    const collectedAt = io.now();
    githubDoc = {
      collectedAt,
      repos,
      // Stamp the merged/closed fetch time so the next poll knows when they are
      // due again; carry the previous stamp forward on a poll that reused them.
      mergedClosedAt: wantMergedClosed ? collectedAt : (prevMergedClosedAt ?? collectedAt),
      // A poll that enriched nothing makes no details call and learns no new
      // remaining — carry the previous reading so backoff state persists.
      rateRemaining: stats.rateRemaining ?? prevRate,
      enrichedCount: stats.enriched,
    };
    if (cacheOn && effectiveTtl > 0) {
      writePollCache(root, 'github', repoNames, githubDoc.collectedAt, githubDoc);
    }
  }
  // Share in-process too, whether the doc came from the cache or a fresh fetch,
  // so the rest of one refresh's projects never re-read the file.
  if (shared !== undefined) shared.github = githubDoc;
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
  let reviewsDoc = shared?.reviews;
  if (reviewsDoc === undefined && cacheOn && effectiveTtl > 0) {
    reviewsDoc = readPollCache(root, 'reviews', repoNames, io.now(), effectiveTtl) as
      | ReviewsSignalsDoc
      | undefined;
  }
  // Under the critical-budget serve-cache path, reuse the previous reviews too
  // rather than spend the one search call.
  if (
    reviewsDoc === undefined &&
    serveCacheOnly &&
    isObj(previousReviews) &&
    Array.isArray(previousReviews['reviews'])
  ) {
    reviewsDoc = previousReviews as unknown as ReviewsSignalsDoc;
  }
  if (reviewsDoc === undefined) {
    reviewsDoc = {
      collectedAt: io.now(),
      reviews: collectReviewRequests(io, gh, repoNames, authorFilter ?? '@me', {
        previousSignals: previousReviews,
        previewPatterns,
      }),
    };
    if (cacheOn && effectiveTtl > 0) {
      writePollCache(root, 'reviews', repoNames, reviewsDoc.collectedAt, reviewsDoc);
    }
  }
  if (shared !== undefined) shared.reviews = reviewsDoc;
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
