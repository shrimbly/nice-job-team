// `board refresh` — the verb the menu-bar app (and any thin client) calls to
// make the board current: poll signals for every discovered project, THEN
// render (per-project files plus the root-level merged cards.json).
//
// Refresh deliberately excludes reconcile, archive and reap: those mutate
// board.json, and the split of duties is the point — the daemon (cycle/watch)
// owns reconciliation; the app owns freshness. A read-only client must be able
// to call refresh as often as it likes without becoming a board writer, so the
// only files this verb touches are the signals (poll's own output) and the
// rendered artifacts.
//
// This module also hosts the project-loading helpers `board render` and
// `board dump` share — moved here from main.ts, which runs its verb dispatch
// on import and therefore can export nothing.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assemble, assemblerConfig, derivedKey } from '../cards/assemble.js';
import type { ProjectSnapshot } from '../cards/assemble.js';
import { buildPayload } from '../cards/build.js';
import type { BuildInputs } from '../cards/build.js';
import { cfg, discoverProjects, loadConfig, loadRoot } from '../config.js';
import { collectGithub, collectReviewRequests, locateGh } from '../facts/github.js';
import {
  decodeOpenRow,
  readAgentStatuses,
  readBoardItems,
  readGithubSignals,
  readWorkspacesSignal,
} from '../read.js';
import { renderCardsJson } from '../render/cardsjson.js';
import { renderHtml } from '../render/html.js';
import { renderMarkdown, summaryLine } from '../render/markdown.js';
import { nowIso } from '../store.js';
import { realPollIo, runPoll } from './poll.js';
import { effectiveQueue } from './review.js';
import type {
  AgentStatus,
  BoardConfigFile,
  BoardItem,
  CardsPayload,
  OrchRoot,
  PollIo,
  ProjectRef,
  PullRequest,
  RepoSignalBlock,
  WorkspaceRef,
} from '../types.js';

// ── Loading one project ───────────────────────────────────────────────────────

/** Everything one board directory contributes, read tolerantly. */
export interface ProjectData {
  items: BoardItem[];
  prs: PullRequest[];
  mergedNumbers: Set<number>;
  /** The raw inbox files — what the reference jq slurped, and nothing more. */
  agents: AgentStatus[];
  /** The inbox merged with poll.sh's signal enrichment — what the app reads. */
  appAgents: AgentStatus[];
  workspaces: WorkspaceRef[];
  warnings: string[];
}

/**
 * Orchestrator.swift's enrichment merge: the agent's own inbox file is the
 * source of truth for state/phase/summary, and signals/workspaces.json's
 * agentStatus block adds the liveness and dirt that only poll.sh can see —
 * poll.sh writes those three fields into the signal file alone, never into
 * workspaces/*.json. Indexed by workspaceId, last entry winning, as Swift's
 * `uniquingKeysWith { _, last in last }` does; the three fields are copied even
 * when the signal holds null for them, exactly as the Swift assignment does.
 *
 * App mode only. The reference jq read the raw inbox and nothing else, so its
 * liveness/dirty/unpushed were null whenever poll.sh's were not — merging into
 * the reference payload would break byte parity to show data the jq never did.
 */
function mergeSignalEnrichment(agents: AgentStatus[], enrichment: AgentStatus[]): AgentStatus[] {
  const byWorkspace = new Map<string, AgentStatus>();
  for (const extra of enrichment) {
    if (typeof extra.workspaceId === 'string') byWorkspace.set(extra.workspaceId, extra);
  }
  return agents.map((agent) => {
    const extra =
      typeof agent.workspaceId === 'string' ? byWorkspace.get(agent.workspaceId) : undefined;
    if (extra === undefined) return agent;
    return {
      ...agent,
      sessionLiveness: extra.sessionLiveness ?? null,
      dirtyFiles: extra.dirtyFiles ?? null,
      unpushedCommits: extra.unpushedCommits ?? null,
    };
  });
}

/**
 * The same four reads render-board.sh does: the project's board.json and
 * signals, and the GLOBAL workspaces/ inbox — agent status files are keyed by
 * workspace UUID and shared across projects on purpose, so the inbox lives at
 * the root and every project reads all of it.
 */
export function loadProject(orch: OrchRoot, project: ProjectRef): ProjectData {
  const board = readBoardItems(join(project.root, 'board.json'));
  const github = readGithubSignals(join(project.root, 'signals', 'github.json'));
  const agents = readAgentStatuses(orch.workspacesDir);
  const signal = readWorkspacesSignal(join(project.root, 'signals', 'workspaces.json'));
  return {
    items: board.value,
    prs: github.value.prs,
    mergedNumbers: github.value.mergedNumbers,
    agents: agents.value,
    appAgents: mergeSignalEnrichment(agents.value, signal.value.agentStatus),
    workspaces: signal.value.workspaces,
    warnings: [...board.warnings, ...github.warnings, ...agents.warnings, ...signal.warnings],
  };
}

export function toSnapshot(project: ProjectRef, data: ProjectData): ProjectSnapshot {
  return {
    project,
    snapshot: {
      items: data.items,
      // The enriched list: the snapshot is the app model's input, and the app
      // (Orchestrator.swift's read) merges before anything sees the agents.
      agents: data.appAgents,
      workspaces: data.workspaces,
      mergedPRNumbers: data.mergedNumbers,
      isPresent: existsSync(project.root),
    },
  };
}

export function selectProjects(
  orch: OrchRoot,
  projectKey: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ProjectRef[] {
  const projects = discoverProjects(orch, env);
  if (projectKey === undefined) return projects;
  const chosen = projects.filter((project) => project.key === projectKey);
  if (chosen.length === 0) {
    // The key may name a project whose directory discovery skipped (no
    // board.json yet). Rendering it produces an empty board, which is the
    // honest answer — the same one SUPERSET_ORCH_PROJECT gets.
    return [{ key: projectKey, root: join(orch.root, 'p', projectKey) }];
  }
  return chosen;
}

/**
 * Every project's snapshots and one joined PR list, for the multi-project
 * assembly. Every project's poll.sh writes the same globally-configured repo
 * set into its own signals file, so a plain concatenation holds each PR once
 * per project — and the assembler, handed a list, would synthesize each
 * unclaimed one that many times. The app never sees this because it polls
 * once; joining the files must collapse them back to one row per
 * (repo, number). First project wins, which is deterministic because
 * discovery sorts keys.
 */
export function gatherProjects(
  projects: ProjectRef[],
  dataFor: (project: ProjectRef) => ProjectData,
): { snapshots: ProjectSnapshot[]; prs: PullRequest[] } {
  const snapshots: ProjectSnapshot[] = [];
  const prs: PullRequest[] = [];
  const seen = new Set<string>();
  for (const project of projects) {
    const data = dataFor(project);
    snapshots.push(toSnapshot(project, data));
    for (const pr of data.prs) {
      const key = JSON.stringify([pr.repo ?? null, pr.number]);
      if (seen.has(key)) continue;
      seen.add(key);
      prs.push(pr);
    }
  }
  return { snapshots, prs };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/** lib.sh's now() shape for the recently-closed cutoff — see main.ts's twin. */
function recentCutoff(days: number): string {
  return new Date(Date.now() - days * 86400 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Write-then-rename, like lib.sh's atomic_write: board.html is re-read by an
 * open browser tab every 90 seconds, and a half-written file renders as a
 * blank board. The tmp name carries the pid so two concurrent renders lose a
 * race instead of interleaving.
 */
function atomicWrite(target: string, content: string): void {
  const tmp = `${target}.tmp.${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, target);
}

const TERMINAL_STATES = new Set(['closed', 'rejected', 'abandoned']);

/**
 * The closing printf's counts, taken from the raw file the way the script's
 * final jq takes them — over every item in board.json, not just the ones the
 * tolerant reader kept, so the printed numbers match the shell's byte for
 * byte even over a board with a malformed item.
 */
function boardCounts(boardFile: string): { open: number; terminal: number } {
  let items: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(boardFile, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const raw = (parsed as Record<string, unknown>)['items'];
      if (Array.isArray(raw)) items = raw;
    }
  } catch {
    // Missing or unreadable board: the render above already produced an empty
    // board, and 0/0 is the truthful count of it.
  }
  let terminal = 0;
  for (const item of items) {
    const state =
      item !== null && typeof item === 'object'
        ? (item as Record<string, unknown>)['state']
        : undefined;
    if (typeof state === 'string' && TERMINAL_STATES.has(state)) terminal += 1;
  }
  return { open: items.length - terminal, terminal };
}

function referencePayload(
  data: ProjectData,
  linearWorkspace: string,
  cutoff: string,
  generatedAt: string,
): CardsPayload {
  const inputs: BuildInputs = {
    items: data.items,
    prs: data.prs,
    agents: data.agents,
    workspaces: data.workspaces,
    linearWorkspace,
    recentCutoff: cutoff,
    generatedAt,
  };
  return buildPayload(inputs, 'reference');
}

export interface RenderBoardsOptions {
  orch: OrchRoot;
  config: BoardConfigFile;
  /** The projects whose per-project files get written. */
  selected: ProjectRef[];
  /** Per-project summary lines — `board render` sends them to stdout. */
  log: (line: string) => void;
  /** Reader warnings, WITHOUT the "warn: " prefix (the printer adds it). */
  warn: (message: string) => void;
  /** The root document's degradation annotation; null on a clean render. */
  note: string | null;
  env?: NodeJS.ProcessEnv;
}

/**
 * The whole render: board.html, board.md and cards.json into each selected
 * project directory, PLUS one merged v2 document at $SUPERSET_ORCH_ROOT/
 * cards.json holding EVERY discovered project — assembled together through
 * assemble()'s multi-project path, so cross-project claims and stacks resolve
 * (and order) exactly as the app resolves them, never re-sorted by hand.
 * generatedAt is stamped once and shared by every document of the run.
 *
 * Returns the root document, whether or not it was written: under
 * SUPERSET_ORCH_DIR the board is a one-off outside the root's world, and
 * writing its merged view over the real root's cards.json would hand every
 * thin client the wrong board.
 */
export function renderBoards(options: RenderBoardsOptions): string {
  const { orch, config } = options;
  const env = options.env ?? process.env;
  const linearWorkspace = cfg(config, '.operator.linearWorkspace', 'acme');
  // cfg hands back whatever JSON the operator wrote, so the type is a hope: a
  // hand-set `"recentlyClosedDays": "weekly"` made new Date(NaN) throw and the
  // render exited having written nothing. The shell degraded (its --argjson
  // failed and the cutoff read as ""), and one bad byte in an operator-owned
  // file must never cost the board — so a non-numeric value means the default.
  const days = Number(cfg(config, '.limits.recentlyClosedDays', 7));
  const cutoff = recentCutoff(Number.isFinite(days) ? days : 7);
  const appConfig = assemblerConfig(config);
  const generatedAt = nowIso();

  // Discovery for the root document runs WITHOUT SUPERSET_ORCH_PROJECT — see
  // the root-document comment below — and the review queue shares it: the
  // queue is the whole world's, whichever board this render was narrowed to.
  const dirOverride = env['SUPERSET_ORCH_DIR'];
  let rootEnv = env;
  if (
    (dirOverride === undefined || dirOverride === '') &&
    env['SUPERSET_ORCH_PROJECT'] !== undefined
  ) {
    rootEnv = { ...env };
    delete rootEnv['SUPERSET_ORCH_PROJECT'];
  }
  const discovered = discoverProjects(orch, rootEnv);
  const reviews = effectiveQueue(orch, discovered).rows;
  const reviewsCountAsNeedsYou = config.review?.countsAsNeedsYou === true;

  // Each project is loaded once — the selected ones for their own files, every
  // discovered one for the root document — and warned about once.
  const cache = new Map<string, ProjectData>();
  const dataFor = (project: ProjectRef): ProjectData => {
    const hit = cache.get(project.key);
    if (hit !== undefined) return hit;
    const data = loadProject(orch, project);
    for (const warning of data.warnings) options.warn(warning);
    cache.set(project.key, data);
    return data;
  };

  for (const project of options.selected) {
    const data = dataFor(project);
    const payload = referencePayload(data, linearWorkspace, cutoff, generatedAt);
    const htmlPath = join(project.root, 'board.html');
    atomicWrite(htmlPath, renderHtml(payload));
    atomicWrite(join(project.root, 'board.md'), renderMarkdown(payload));

    // cards.json rides the same write cycle but carries the app model: this
    // project alone in its projects array, assembled — synthesized PRs,
    // stacks, divergences — because the file is for consumers of the model,
    // not for diffing against the jq.
    const cards = assemble([toSnapshot(project, data)], data.prs, appConfig);
    atomicWrite(
      join(project.root, 'cards.json'),
      renderCardsJson([project], cards, appConfig, generatedAt, null, reviews, reviewsCountAsNeedsYou),
    );

    const counts = boardCounts(join(project.root, 'board.json'));
    options.log(summaryLine(htmlPath, counts.open, counts.terminal));
  }

  // The root document. In the legacy single-board layout the one project's
  // root IS orch.root, so this write lands on the same path as the per-project
  // one above — same shape, merged view wins, and no consumer can tell.
  //
  // Discovery for it runs WITHOUT SUPERSET_ORCH_PROJECT: that variable narrows
  // a mutating verb to one board (and the installed watch service bakes it in,
  // since cycle requires it on any multi-repo config), but the root file is
  // the thin clients' whole-world view. Honouring the selection here made
  // every daemon cycle rewrite the root down to its one project, and the
  // menu-bar app flip-flopped between the full board (its own refresh) and a
  // one-project board (the daemon's render). The SUPERSET_ORCH_DIR one-off
  // board keeps its selection — its document never lands on the root anyway.
  const gathered = gatherProjects(discovered, dataFor);
  const cards = assemble(gathered.snapshots, gathered.prs, appConfig);
  const doc = renderCardsJson(
    discovered, cards, appConfig, generatedAt, options.note, reviews, reviewsCountAsNeedsYou,
  );
  if (dirOverride === undefined || dirOverride === '') {
    mkdirSync(orch.root, { recursive: true });
    atomicWrite(join(orch.root, 'cards.json'), doc);
  }
  return doc;
}

// ── The refresh verb ──────────────────────────────────────────────────────────

/** The seams a test pins; every one defaults to the live thing. */
export interface RefreshDeps {
  io?: PollIo;
  /** A pinned gh path; null means "no gh anywhere"; undefined locates. */
  ghPath?: string | null;
  /** Where the --stdout / github-only document goes. */
  out?: (text: string) => void;
  /** Where BLOCKED lines, warnings and summary lines go. */
  err?: (text: string) => void;
}

interface RefreshArgs {
  project?: string;
  renderOnly: boolean;
  stdout: boolean;
  repos?: string[];
}

function splitRepos(value: string): string[] {
  const names: string[] = [];
  for (const part of value.split(',')) {
    const name = part.trim();
    if (name !== '' && !names.includes(name)) names.push(name);
  }
  return names;
}

/** The argv surface; a string return is the BLOCKED message. */
function parseRefreshArgs(argv: string[], env: NodeJS.ProcessEnv): RefreshArgs | string {
  const args: RefreshArgs = { renderOnly: false, stdout: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--project' && argv[i + 1] !== undefined) {
      args.project = argv[i + 1]!;
      i += 1;
    } else if (arg === '--render-only') {
      args.renderOnly = true;
    } else if (arg === '--stdout') {
      args.stdout = true;
    } else if (arg === '--repos' && argv[i + 1] !== undefined) {
      args.repos = splitRepos(argv[i + 1]!);
      i += 1;
    } else {
      return `unknown argument: ${arg}`;
    }
  }
  if (args.repos !== undefined) {
    // Explicitly asked-for github-only mode admits no orchestrator flags: a
    // misspelled combination silently ignored is a render of the wrong board.
    if (args.project !== undefined) return '--project has no meaning with --repos';
    if (args.renderOnly) return '--render-only has no meaning with --repos (there are no signals to reuse)';
  } else if (args.project === undefined && !args.renderOnly) {
    // BOARD_REPOS is the thin client's standing configuration, not a mode
    // switch: an operator with it exported who asks for --project or
    // --render-only means the orchestrator root, so only a bare refresh
    // falls through to it.
    const envRepos = env['BOARD_REPOS'];
    if (envRepos !== undefined && envRepos !== '') args.repos = splitRepos(envRepos);
  }
  return args;
}

/**
 * Wraps the io so every failed gh invocation lands in `failures` — the raw
 * material of the document's note. Only gh: the superset CLI failing is the
 * normal not-logged-in case and already warns through io.warn.
 */
function recordGhFailures(io: PollIo, gh: string | null, failures: Set<string>): PollIo {
  if (gh === null) return io;
  return {
    ...io,
    exec(cmd, args, execOptions) {
      const result = io.exec(cmd, args, execOptions);
      if (cmd === gh && result.status !== 0) {
        const what = args.slice(0, 2).join(' ');
        const repoIndex = args.indexOf('--repo');
        const repo =
          repoIndex >= 0 && args[repoIndex + 1] !== undefined ? ` for ${args[repoIndex + 1]}` : '';
        failures.add(`gh ${what}${repo} failed (exit ${result.status})`);
      }
      return result;
    },
  };
}

function noteFrom(failures: Set<string>): string | null {
  return failures.size > 0 ? [...failures].join('; ') : null;
}

/**
 * The enriched open rows, typed for the assembler. These rows were built by
 * facts/github.ts in THIS process, in exactly the shape signals/github.json
 * carries — so read.ts's decodeOpenRow (defaults included) runs over rows
 * that never touched disk, and the two paths cannot drift.
 */
function openRowsAsPRs(blocks: RepoSignalBlock[]): PullRequest[] {
  const prs: PullRequest[] = [];
  for (const block of blocks) {
    for (const row of block.open) {
      const number = row['number'];
      if (typeof number !== 'number' || !Number.isInteger(number)) continue;
      prs.push(decodeOpenRow(row, number, block.repo));
    }
  }
  return prs;
}

/**
 * GITHUB-ONLY MODE: no orchestrator root required, and none consulted. The
 * named repos' PRs are polled in-memory through facts/github.ts, assembled
 * with an absent snapshot per repo — synthesized-only cards — and the v2
 * document goes to stdout. Nothing is written to disk anywhere: there is no
 * state dir to write into, and inventing one would silently turn a stateless
 * client into a board it later trips over.
 */
function refreshGithubOnly(
  repoNames: string[],
  io: PollIo,
  gh: string | null,
  failures: Set<string>,
  out: (text: string) => void,
): number {
  if (gh === null) failures.add('gh not found — no PR data available');
  // '@me' on both sides is poll.sh's default operator: the client's own PRs
  // plus the ones awaiting their review, same board semantics as a configured
  // orchestrator with no .operator.githubLogin.
  const blocks = collectGithub(io, gh, repoNames, '@me', '@me', {
    ourLogins: [],
    previewPatterns: null,
  });
  // One absent snapshot per repo: assemblerConfig over a synthesized
  // repos-only config derives the same keys and short names setup.sh would,
  // so a client that later gains a real root sees the same project keys.
  const config = assemblerConfig({ repos: repoNames.map((name) => ({ name })) });
  const projects: ProjectRef[] = repoNames.map((name) => ({ key: derivedKey(name), root: '' }));
  const snapshots: ProjectSnapshot[] = projects.map((project) => ({
    project,
    snapshot: {
      items: [],
      agents: [],
      workspaces: [],
      mergedPRNumbers: new Set<number>(),
      isPresent: false,
    },
  }));
  const cards = assemble(snapshots, openRowsAsPRs(blocks), config);
  // The review queue, live like everything else in this mode: no signals to
  // reuse previews from, no ledger to subtract (there is no state dir to keep
  // one in).
  const reviews = collectReviewRequests(io, gh, repoNames, '@me', { previewPatterns: null });
  out(renderCardsJson(projects, cards, config, nowIso(), noteFrom(failures), reviews));
  return 0;
}

/**
 * `board refresh [--project <key>] [--render-only] [--stdout]`, or
 * `board refresh --repos owner/name[,owner/name]` (BOARD_REPOS as the
 * flagless spelling). Returns the exit code: 0 whenever a document was
 * produced — degraded counts, the note says how — and 1 when nothing could be.
 *
 * --render-only skips the poll entirely: the FS-change fast path for a client
 * that watched a signals or board.json write land and only needs the rendered
 * artifacts to catch up.
 *
 * --stdout prints the root document AND still writes it: two clients
 * refreshing concurrently must converge on the same file, and a print-only
 * mode would let the faster one read a document the slower one never wrote.
 */
export async function runRefresh(argv: string[], deps: RefreshDeps = {}): Promise<number> {
  const io = deps.io ?? realPollIo();
  const out = deps.out ?? ((text: string): void => void process.stdout.write(text));
  const err = deps.err ?? ((text: string): void => void process.stderr.write(text));

  const parsed = parseRefreshArgs(argv, io.env);
  if (typeof parsed === 'string') {
    err(`BLOCKED: ${parsed}\n`);
    return 1;
  }

  const failures = new Set<string>();
  // gh is located only when something will call it — the render-only fast
  // path must stay exec-free.
  const needsGh = parsed.repos !== undefined || !parsed.renderOnly;
  const gh = needsGh ? (deps.ghPath !== undefined ? deps.ghPath : locateGh(io)) : null;
  const recording = recordGhFailures(io, gh, failures);

  if (parsed.repos !== undefined) {
    return refreshGithubOnly(parsed.repos, recording, gh, failures, out);
  }

  const orch = loadRoot(io.env);
  // The split-aware loader, same as render's: a machine config shadowed by a
  // legacy config.json is worth one informational line, not a warning.
  const loaded = loadConfig(orch, io.env);
  if (loaded.deprecationNote !== undefined) err(`note: ${loaded.deprecationNote}\n`);
  const config = loaded.config;
  const selected = selectProjects(orch, parsed.project, io.env);

  if (!parsed.renderOnly) {
    if (gh === null) failures.add('gh not found — PR signals not refreshed');
    for (const project of selected) {
      try {
        // The summary is poll's human surface and `board poll` still prints
        // it; refresh's caller reads cards.json, so it is dropped here — and
        // because it is dropped, this poll must not advance the *.prev.json
        // delta baseline the cycle/watch daemon diffs its events.log lines
        // against (keepBaseline: the daemon's transitions would be silently
        // absorbed by a caller that reports none of them).
        runPoll(orch, project.root, config, recording, { ghPath: gh, keepBaseline: true });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        failures.add(`poll failed for ${project.key === '' ? project.root : project.key}: ${reason}`);
      }
    }
  }

  try {
    // A poll failure above still lands here: the signals on disk are the last
    // ones poll wrote (its own degrade), the render reads whatever they say,
    // and the note carries what failed.
    const doc = renderBoards({
      orch,
      config,
      selected,
      log: (line) => err(`${line}\n`),
      warn: (message) => err(`warn: ${message}\n`),
      note: noteFrom(failures),
      env: io.env,
    });
    if (parsed.stdout) out(doc);
    return 0;
  } catch (e) {
    err(`BLOCKED: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
