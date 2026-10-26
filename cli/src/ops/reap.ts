// `board reap` — skills/superset-orchestrator/scripts/reap.sh and autoreap.sh
// as one module. reap: verify the PR merged and the worktree holds nothing
// unsaved, delete the workspace, tidy the local branch, and close the board
// item. --auto: walk the board's own dispatches and reap the ones whose PR has
// settled (merged, or closed-unmerged long enough with no replacement).
//
// Refuses on anything unmerged, dirty, or unpushed. There is no --force: if
// the checks fail, the answer is a human looking at it, not a bigger hammer.
// Every refusal and warning text is verbatim from the scripts — the
// orchestrator skill and the operator both pattern-match on them, and
// docs/lessons.md records what each guard prevented (a reap that almost
// deleted the repository; a stash that blocked every reap).
//
// Everything outside the process goes through the injected PollIo — superset,
// gh and git alike — so the tests run the whole verb with no live CLI and no
// network. The git checks are the one part a test exercises for real, against
// temp repositories it builds itself.

import { readdirSync, rmdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cfg, loadRoot, readConfig } from '../config.js';
import { authed, getWorkspace, supersetCommand } from '../facts/superset.js';
import { applyItemPatch } from '../statemachine.js';
import { appendLog, nowIso, readBoardRaw, writeBoard } from '../store.js';
import type { BoardConfigFile, ExecResult, OrchRoot, PollIo } from '../types.js';
import { resolveBoardDir } from './item.js';
import { realPollIo } from './poll.js';

type Obj = Record<string, unknown>;

/** jq's `type == "object"`: arrays are their own type, and null is not one. */
function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** jq's `//`: null AND false fall through; "" and 0 are kept. */
function jqAlt(value: unknown): unknown {
  return value === undefined || value === null || value === false ? undefined : value;
}

/** jq's `"\(x)"` (and `jq -r` of a scalar): a string as-is, anything else JSON. */
function jqInterp(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? 'null';
}

/** `jq -r 'x // empty'` into a shell variable: "" when absent/null/false. */
function orEmpty(value: unknown): string {
  const kept = jqAlt(value);
  return kept === undefined ? '' : jqInterp(kept);
}

/** `[ -d ... ]`. */
function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `wc -l`: the newline count — git terminates every row it prints. */
function countLines(text: string): number {
  return (text.match(/\n/g) ?? []).length;
}

// ── Runners over the injected io ──────────────────────────────────────────────

function git(io: PollIo, args: string[]): ExecResult {
  return io.exec('git', args);
}

/**
 * A git call the bash ran inside `"$(...)"` under pipefail: a failure aborted
 * the whole script. Here it throws — refusal, never a silently-passed guard.
 */
function mustGit(io: PollIo, args: string[]): string {
  const result = git(io, args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function superset(io: PollIo, args: string[]): ExecResult {
  const { cmd, env } = supersetCommand(io);
  return io.exec(cmd, args, { env });
}

/** `gh ... || echo '{}'` — any failure or non-object degrades to {}. */
function ghObj(io: PollIo, args: string[]): Obj {
  const result = io.exec('gh', args);
  if (result.status !== 0) return {};
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    return isObj(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * A `gh pr list --json number` whose bash form piped through `--jq
 * '.[0].number // empty' || true`: the first row's number, or "". Parsed here
 * instead of shelling the jq flag — same value, one less moving part.
 */
function ghFirstNumber(io: PollIo, args: string[]): string {
  const result = io.exec('gh', args);
  if (result.status !== 0) return '';
  let rows: unknown;
  try {
    rows = JSON.parse(result.stdout);
  } catch {
    return '';
  }
  const first = Array.isArray(rows) ? rows[0] : undefined;
  return isObj(first) ? orEmpty(first['number']) : '';
}

// ── The op's surface ──────────────────────────────────────────────────────────

/** What both verbs need from the world; tests build all of it in a temp root. */
export interface ReapDeps {
  io: PollIo;
  /** For workspacesDir — the global agent-status inbox reap prunes. */
  orch: OrchRoot;
  boardDir: string;
  config: BoardConfigFile;
  /** What a lock timeout blames — lib.sh names $PROJECT_KEY. */
  label?: string;
}

export interface ReapOptions {
  item?: string;
  workspace?: string;
  repo?: string;
  dryRun?: boolean;
  /**
   * Cancelled work, not landed work: skip the merged-PR proof. Everything else
   * — clean tree, nothing unpushed, not the primary checkout — still applies,
   * so an abandon cannot quietly destroy work someone would want back.
   */
  abandon?: boolean;
  /**
   * Only with --abandon, and only when you mean it: allow uncommitted/unpushed
   * work to be thrown away. Prints exactly what it is dropping first.
   */
  discardChanges?: boolean;
}

/**
 * stdout and stderr as reap.sh emitted them — stderr lines carry their own
 * "warn: " prefixes and sed indents, because autoreap greps and operators
 * pattern-match the exact text. Refusals throw instead (die's message, minus
 * the "BLOCKED: " prefix the argv surface adds back).
 */
export interface ReapResult {
  stdout: string[];
  stderr: string[];
}

// ── board reap ────────────────────────────────────────────────────────────────

export async function reap(deps: ReapDeps, opts: ReapOptions = {}): Promise<ReapResult> {
  const { io, orch, boardDir, config } = deps;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const warn = (message: string): void => {
    stderr.push(`warn: ${message}`);
  };
  // `sed 's/^/         /' >&2` — nine spaces, on every line of the listing.
  const indent = (text: string): void => {
    for (const line of text.replace(/\n$/, '').split('\n')) stderr.push(`         ${line}`);
  };

  const boardFile = join(boardDir, 'board.json');
  const item = opts.item ?? '';
  let wsid = opts.workspace ?? '';
  let repo = opts.repo ?? '';
  const dry = opts.dryRun === true;
  const abandon = opts.abandon === true;
  const discard = opts.discardChanges === true;

  if (discard && !abandon) throw new Error('--discard-changes only makes sense with --abandon');

  let branch = '';
  let pr = '';
  if (item !== '') {
    // board_item: a missing board reads as no item; an unparseable one killed
    // the jq and the script with it — same refusal, named like item.ts's.
    const raw = readBoardRaw(boardFile);
    if (raw.error !== undefined) {
      throw new Error(`board at ${boardFile} is not parseable JSON: ${raw.error}`);
    }
    const items =
      !raw.missing && isObj(raw.json) && Array.isArray(raw.json['items']) ? raw.json['items'] : [];
    const obj = items.find((it): it is Obj => isObj(it) && it['id'] === item);
    if (obj === undefined) throw new Error(`no board item ${item}`);
    // Gap-fill: a flag given on the command line wins over the item's record.
    if (wsid === '') wsid = orEmpty(obj['workspaceId']);
    if (repo === '') repo = orEmpty(obj['repo']);
    branch = orEmpty(obj['branch']);
    // `.pr.number // empty` — board_validate keeps pr an object or null, so
    // a scalar pr never gets here; reading it as absent keeps guard 1 armed.
    const prRef = jqAlt(obj['pr']);
    if (prRef !== undefined && isObj(prRef)) pr = orEmpty(prRef['number']);
  }
  if (wsid === '') throw new Error('need --item or --workspace');
  if (repo === '') throw new Error('need --repo (or an item that records one)');

  if (!authed(io)) throw new Error('not logged in — superset auth login');

  const ws = getWorkspace(io, wsid) ?? {};
  if (orEmpty(ws['id']) !== wsid) throw new Error(`workspace ${wsid} not found on this host`);
  const wt = orEmpty(ws['worktreePath']);
  if (branch === '') branch = orEmpty(ws['branch']);

  // ── 0. never reap the primary checkout, or the workspace we are running in ──
  // A project's main workspace points at the real clone, not a linked worktree.
  // Deleting it takes the repository with it. `git-dir == git-common-dir` is
  // the test — and two FAILING git calls compare "" = "" and refuse, the bash
  // command-substitution quirk erring in the safe direction.
  if (wt !== '' && isDir(wt)) {
    const sub = (args: string[]): string => {
      const result = git(io, args);
      return result.status === 0 ? result.stdout.replace(/\n+$/, '') : '';
    };
    const gitDir = sub(['-C', wt, 'rev-parse', '--git-dir']);
    const commonDir = sub(['-C', wt, 'rev-parse', '--git-common-dir']);
    if (gitDir === commonDir) {
      throw new Error(
        `workspace ${wsid} is the PRIMARY CHECKOUT at ${wt}, not a linked worktree — deleting it would take the clone with it. Reap only linked worktrees.`,
      );
    }
  }
  const self = io.env['SUPERSET_WORKSPACE_ID'];
  if (self !== undefined && self !== '' && wsid === self) {
    throw new Error(
      `workspace ${wsid} is the one this session is running in — refusing to delete the ground under our feet`,
    );
  }

  // ── 1. the PR really merged ─────────────────────────────────────────────────
  if (abandon) {
    warn('--abandon: skipping the merged-PR check. This is cancelled work, not landed work.');
  } else {
    if (pr === '' && branch !== '') {
      pr = ghFirstNumber(io, [
        'pr', 'list', '--repo', repo, '--head', branch,
        '--state', 'all', '--limit', '1', '--json', 'number',
      ]);
    }
    if (pr === '') {
      throw new Error(
        `no PR found for branch '${branch}' in ${repo} — nothing has landed, so nothing to reap. If the task was cancelled, use --abandon.`,
      );
    }
    const prj = ghObj(io, ['pr', 'view', pr, '--repo', repo, '--json', 'state,mergedAt,url,headRefName']);
    const state = jqInterp(jqAlt(prj['state']) ?? '?');
    if (state !== 'MERGED') {
      throw new Error(`PR #${pr} is ${state}, not MERGED — ${orEmpty(prj['url'])}`);
    }
  }

  // ── 2. nothing unsaved in the worktree ──────────────────────────────────────
  let dirty: string | undefined;
  if (wt !== '' && isDir(wt)) {
    dirty = String(countLines(mustGit(io, ['-C', wt, 'status', '--porcelain'])));
    if (dirty !== '0') {
      if (discard) {
        warn(`--discard-changes: throwing away ${dirty} uncommitted change(s) in ${wt}:`);
        indent(mustGit(io, ['-C', wt, 'status', '--short']));
      } else {
        throw new Error(
          `${dirty} uncommitted change(s) in ${wt} — deleting the workspace would destroy them. Add --discard-changes if that is intended.`,
        );
      }
    }
    if (git(io, ['-C', wt, 'rev-parse', '@{u}']).status === 0) {
      const ahead = mustGit(io, ['-C', wt, 'rev-list', '--count', '@{u}..HEAD']).trim();
      if (ahead !== '0') {
        if (discard) {
          warn(`--discard-changes: throwing away ${ahead} unpushed commit(s) in ${wt}:`);
          indent(mustGit(io, ['-C', wt, 'log', '--oneline', '@{u}..HEAD']));
        } else {
          throw new Error(`${ahead} unpushed commit(s) in ${wt} — add --discard-changes if that is intended`);
        }
      }
    } else if (abandon) {
      // No upstream on abandoned work is normal — it was never pushed. But
      // commits that exist only here vanish with the worktree, so name them
      // before they go.
      const counted = git(io, ['-C', wt, 'rev-list', '--count', 'origin/HEAD..HEAD']);
      const localOnly = counted.status === 0 ? counted.stdout.trim() : '0';
      if (localOnly !== '0' && localOnly !== '') {
        if (discard) {
          warn(`--discard-changes: ${localOnly} local commit(s) exist nowhere else and will be lost:`);
          const listing = git(io, ['-C', wt, 'log', '--oneline', 'origin/HEAD..HEAD']);
          if (listing.status === 0) indent(listing.stdout);
        } else {
          throw new Error(
            `${localOnly} local commit(s) were never pushed and exist only in ${wt} — add --discard-changes if losing them is intended`,
          );
        }
      }
    } else {
      warn(`no upstream for ${branch} in ${wt} — PR #${pr} merged, so treating as pushed`);
    }
    // Stashes are worth mentioning but never worth blocking on: `refs/stash`
    // lives in the SHARED git dir, so every worktree of the repo lists the
    // same stashes and removing a worktree does not touch any of them.
    // Blocking here meant one forgotten stash on an unrelated branch made
    // every workspace in the repo unreapable.
    const st = String(countLines(mustGit(io, ['-C', wt, 'stash', 'list'])));
    if (st !== '0') {
      warn(`${st} stash entr(ies) visible from this worktree — shared with the whole repo, and untouched by this delete:`);
      indent(mustGit(io, ['-C', wt, 'stash', 'list']));
    }
  } else {
    warn('worktree path not on disk — skipping the dirty/unpushed checks');
  }

  if (dry) {
    if (abandon) {
      const count = dirty ?? '0';
      stdout.push(
        `would abandon workspace ${wsid} (${branch}) — cancelled work, ${
          count === '0' ? 'nothing to lose' : `DISCARDING ${count} change(s)`
        }`,
      );
    } else {
      stdout.push(`would delete workspace ${wsid} (${branch}) — PR #${pr} merged, worktree clean`);
    }
    return { stdout, stderr };
  }

  // ── 3. delete the workspace (runs the project's teardown) ───────────────────
  if (superset(io, ['workspaces', 'delete', wsid, '--local', '--json']).status !== 0) {
    throw new Error('workspace delete failed');
  }

  // ── 3b. prune the empty parent a slashed branch name leaves behind ──────────
  // `dev/eng-13-swift-dashboard` becomes .../worktrees/<project>/dev/model-
  // count-copy, so deleting the leaf strands an empty `dev/`. Only ever
  // removes empty dirs, and never climbs above the worktrees root.
  if (wt !== '') {
    const root = join(io.homeDir(), '.superset', 'worktrees');
    let parent = dirname(wt);
    while (parent !== root && parent !== '/' && parent.startsWith(`${root}/`)) {
      let entries: string[];
      try {
        entries = readdirSync(parent); // `[ -d ]` and `ls -A` in one read
      } catch {
        break;
      }
      if (entries.length !== 0) break;
      try {
        rmdirSync(parent);
      } catch {
        break;
      }
      parent = dirname(parent);
    }
  }

  // ── 4. tidy the local branch in the main clone ──────────────────────────────
  const clone = repoLocalPath(config, repo);
  if (clone !== '' && isDir(join(clone, '.git')) && branch !== '') {
    git(io, ['-C', clone, 'worktree', 'prune']); // || true
    // `git branch --list "$branch" | grep -q .` — any output at all.
    if (/./.test(mustGit(io, ['-C', clone, 'branch', '--list', branch]))) {
      if (git(io, ['-C', clone, 'branch', '-d', branch]).status !== 0) {
        warn(`kept local branch ${branch} (git says it is not fully merged — check by hand)`);
      }
    }
  }

  // ── 5. close the item and log ───────────────────────────────────────────────
  // Cancelled work is `abandoned`, not `closed`: both are terminal, but the
  // board should be able to tell landed work from work that was given up on.
  if (item !== '') {
    if (!existsSync(boardFile)) throw new Error(`no board at ${boardFile} — run board doctor`);
    const at = nowIso();
    const by = abandon ? 'reap: --abandon' : 'reap';
    await writeBoard(
      boardDir,
      (board) => {
        board['updatedAt'] = at;
        const items = board['items'];
        if (!Array.isArray(items)) {
          throw new Error(`edit of ${boardFile} failed — .items is not an array, file left unchanged`);
        }
        board['items'] = items.map((it) =>
          isObj(it) && it['id'] === item
            ? applyItemPatch(it, { state: abandon ? 'abandoned' : 'closed' }, by, at)
            : it,
        );
        return board;
      },
      deps.label,
    );
    // Anything waiting on this item is now dispatchable — surface it. The
    // shell's `tr '\n' ' '` left a trailing space; kept, because autoreap and
    // the orchestrator both match `^unblocked:` lines verbatim.
    const after = readBoardRaw(boardFile);
    const unblocked: string[] = [];
    if (isObj(after.json) && Array.isArray(after.json['items'])) {
      for (const it of after.json['items']) {
        if (!isObj(it)) continue;
        if (it['blockedBy'] === item || it['stackParent'] === item) {
          unblocked.push(jqInterp(it['id'] ?? null));
        }
      }
    }
    if (unblocked.length > 0) stdout.push(`unblocked: ${unblocked.join(' ')} `);
  }
  try {
    unlinkSync(join(orch.workspacesDir, `${wsid}.json`));
  } catch {
    // rm -f: a status file already gone is already pruned
  }
  appendLog(boardDir, 'reaped', item === '' ? '-' : item, {
    workspaceId: wsid,
    branch,
    pr,
    repo,
  });

  stdout.push(
    abandon
      ? `abandoned ${item !== '' ? item : wsid} — cancelled work, workspace deleted, branch tidied`
      : `reaped ${item !== '' ? item : wsid} — PR #${pr} merged, workspace deleted, branch tidied`,
  );
  return { stdout, stderr };
}

/** lib.sh's repo_cfg <repo> '.localPath': first matching repo block, or "". */
function repoLocalPath(config: BoardConfigFile, repo: string): string {
  const repos = Array.isArray(config.repos) ? config.repos : [];
  for (const block of repos) {
    if (!isObj(block) || block['name'] !== repo) continue;
    // `(.localPath) // empty` then `[ -n ]` — null, false AND "" all fall
    // through to the empty default.
    const value = jqAlt(block['localPath']);
    if (value === undefined) continue;
    const rendered = jqInterp(value);
    if (rendered !== '') return rendered;
  }
  return '';
}

// ── board reap --auto (autoreap.sh) ───────────────────────────────────────────

export interface AutoreapOptions {
  dryRun?: boolean;
  /** Only speak when something happened. */
  quiet?: boolean;
}

/** One row of the candidates jq, post-@tsv: strings, null cells as "". */
interface Candidate {
  id: string;
  repo: string;
  pr: string;
  slug: string;
}

/** A jq projection died mid-stream; the while loop then read nothing at all. */
class JqDied extends Error {}

/** @tsv's cell rendering: null empty, strings as-is, other scalars as JSON. */
function tsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? '';
}

/** `.x[]?` — arrays iterate, objects iterate their values, all else nothing. */
function iterOpt(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isObj(value)) return Object.values(value);
  return [];
}

/**
 * autoreap.sh's candidates jq: ours (`createdByOrchestrator == true` — set by
 * dispatch at creation, never on a re-prompt, so the operator's own hand-made
 * workspaces are never auto-deleted), still holding a workspace, with a PR,
 * and not already terminal. Quirks intact: a scalar item or a scalar pr killed
 * the whole jq, and the loop then saw zero candidates.
 */
function collectCandidates(rootJson: unknown): Candidate[] {
  const items = isObj(rootJson) ? iterOpt(rootJson['items']) : [];
  const out: Candidate[] = [];
  try {
    for (const it of items) {
      if (it === null || it === undefined) continue; // null.x → null → filtered
      if (!isObj(it)) throw new JqDied(); // `.createdByOrchestrator` on a scalar
      if (it['createdByOrchestrator'] !== true) continue;
      if ((it['workspaceId'] ?? null) === null) continue; // jq `!= null`: false passes
      const pr = it['pr'] ?? null;
      let num: unknown = null;
      if (pr !== null) {
        if (!isObj(pr)) throw new JqDied(); // `.pr.number` on a scalar
        num = pr['number'] ?? null;
      }
      if (num === null) continue;
      const state = it['state'];
      if (state === 'closed' || state === 'rejected' || state === 'abandoned') continue;
      out.push({
        id: tsvCell(it['id']),
        repo: tsvCell(it['repo'] ?? null),
        pr: typeof num === 'string' ? num : (JSON.stringify(num) ?? 'null'), // `tostring`
        slug: tsvCell(jqAlt(it['slug']) ?? it['id']),
      });
    }
  } catch {
    return [];
  }
  return out;
}

/** jq's `fromdateiso8601 // echo 0`: strict `%Y-%m-%dT%H:%M:%SZ`, else 0. */
function iso8601Epoch(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/**
 * autoreap.sh: gate on gates.autoReapOwnWorkspaces, judge each candidate's PR,
 * and run reap per item — a refusal is not an error here, it just means "not
 * yet", so it lands on stderr as a skipped line and the loop keeps going.
 * Never throws for a per-item failure; only "no board" is fatal, as it was.
 */
export async function autoreap(deps: ReapDeps, opts: AutoreapOptions = {}): Promise<ReapResult> {
  const { io, boardDir, config } = deps;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const dry = opts.dryRun === true;
  const quiet = opts.quiet === true;

  // `[ "$(cfg ... false)" = "true" ]` — boolean true and the string "true"
  // both render as "true" under jq -r; anything else reads as off.
  const gate = cfg<unknown>(config, '.gates.autoReapOwnWorkspaces', false);
  if (!(gate === true || gate === 'true')) {
    if (!quiet) stdout.push('auto-reap is off (gates.autoReapOwnWorkspaces)');
    return { stdout, stderr };
  }

  const boardFile = join(boardDir, 'board.json');
  const raw = readBoardRaw(boardFile);
  if (raw.missing) throw new Error(`no board at ${boardFile}`);
  // An unparseable board killed the candidates jq, and the loop read nothing.
  const candidates = raw.error !== undefined ? [] : collectCandidates(raw.json);

  // How long a closed-unmerged PR must stay closed before its workspace is
  // reapable. A non-numeric config value failed the shell's `-ge` test on
  // every row — NaN comparisons reproduce that: no closed PR ever settles.
  const grace = Number(cfg<unknown>(config, '.limits.closedReapGraceSeconds', 7200));

  let reaped = 0;
  for (const candidate of candidates) {
    if (candidate.id === '') continue;
    const meta = ghObj(io, [
      'pr', 'view', candidate.pr, '--repo', candidate.repo,
      '--json', 'state,closedAt,headRefName',
    ]);
    const state = jqInterp(jqAlt(meta['state']) ?? '');
    let abandon = false;
    let why: string;
    if (state === 'MERGED') {
      why = `PR #${candidate.pr} merged`;
    } else if (state === 'CLOSED') {
      // A closed PR is not finished work by itself. Closing one and opening a
      // replacement from the same workspace is a normal reset, and reaping
      // inside that window destroys the branch and the live agent session with
      // it. So require the close to have settled, and require that no
      // replacement PR has appeared on the same branch.
      const closedAt = orEmpty(meta['closedAt']);
      const head = orEmpty(meta['headRefName']);
      const closedEpoch = iso8601Epoch(closedAt);
      // An unparseable timestamp must never read as "infinitely old".
      if (!(closedEpoch > 0)) continue;
      const age = Math.floor(io.nowMs() / 1000) - closedEpoch;
      if (!(age >= grace)) continue;
      if (head === '') continue;
      const replacement = ghFirstNumber(io, [
        'pr', 'list', '--repo', candidate.repo, '--head', head,
        '--state', 'open', '--limit', '1', '--json', 'number',
      ]);
      if (replacement !== '') continue;
      abandon = true;
      why = `PR #${candidate.pr} closed unmerged ${Math.floor(age / 3600)}h ago, no replacement PR on ${head}`;
    } else {
      continue;
    }

    if (dry) {
      stdout.push(`would reap ${candidate.id} (${candidate.slug}) — ${why}`);
      continue;
    }

    // reap refuses loudly on dirty/unpushed/primary-checkout; that refusal is
    // not an error here, it just means "not yet". Keep going either way.
    try {
      const result = await reap(deps, { item: candidate.id, abandon });
      stdout.push(`auto-reaped ${candidate.id} (${candidate.slug}) — ${why}`);
      for (const line of result.stdout) {
        if (line.startsWith('unblocked:')) stdout.push(line);
      }
      reaped += 1;
    } catch (err) {
      // The bash grepped the first `^BLOCKED:` line out of reap.sh's combined
      // output, falling back to a pointer at the verb when there was none.
      const blocked =
        err instanceof Error
          ? `BLOCKED: ${err.message.split('\n')[0]!}`
          : 'see board reap output';
      stderr.push(`skipped ${candidate.id} (${candidate.slug}): ${blocked}`);
    }
  }

  if (quiet && reaped === 0) return { stdout, stderr };
  if (!dry) stdout.push(`auto-reap: ${reaped} workspace(s) reaped`);
  return { stdout, stderr };
}

// ── argv surface ──────────────────────────────────────────────────────────────

function die(message: string): never {
  process.stderr.write(`BLOCKED: ${message}\n`);
  process.exit(1);
}

/** `--flag` needs its value; the shell died on the unbound $2 the same way. */
function takeValue(argv: string[], i: number): string {
  const value = argv[i + 1];
  if (value === undefined) die(`${argv[i]} needs a value`);
  return value;
}

function liveDeps(): ReapDeps {
  const { boardDir, projectKey } = resolveBoardDir();
  const orch = loadRoot();
  return { io: realPollIo(), orch, boardDir, config: readConfig(orch), label: projectKey };
}

/**
 * stderr first, then stdout — the two streams are buffered per run, so the
 * interleaving the shell had inside one stream is preserved, and across the
 * two only a 2>&1 merge could tell the difference.
 */
function emit(result: ReapResult): void {
  for (const line of result.stderr) process.stderr.write(`${line}\n`);
  for (const line of result.stdout) console.log(line);
}

/**
 * `board reap (--item i | --workspace id --repo owner/name) [--abandon]
 * [--discard-changes] [--dry-run]`, and `board reap --auto [--dry-run]
 * [--quiet]`. Dies the way the scripts die — "BLOCKED: ..." on stderr, exit 1.
 */
export async function runReap(argv: string[]): Promise<void> {
  try {
    if (argv.includes('--auto')) {
      let dryRun = false;
      let quiet = false;
      for (const arg of argv) {
        if (arg === '--auto') continue;
        else if (arg === '--dry-run') dryRun = true;
        else if (arg === '--quiet') quiet = true;
        else die(`unknown argument: ${arg}`);
      }
      emit(await autoreap(liveDeps(), { dryRun, quiet }));
      return;
    }
    const opts: ReapOptions = {};
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i]!;
      switch (arg) {
        case '--item':
          opts.item = takeValue(argv, i);
          i += 1;
          break;
        case '--workspace':
          opts.workspace = takeValue(argv, i);
          i += 1;
          break;
        case '--repo':
          opts.repo = takeValue(argv, i);
          i += 1;
          break;
        case '--dry-run':
          opts.dryRun = true;
          break;
        case '--abandon':
          opts.abandon = true;
          break;
        case '--discard-changes':
          opts.discardChanges = true;
          break;
        default:
          die(`unknown argument: ${arg}`);
      }
    }
    emit(await reap(liveDeps(), opts));
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
}
