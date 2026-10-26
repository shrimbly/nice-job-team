// The GitHub side of poll.sh's SENSE pass: the four `gh pr list` calls per
// repo, the review-thread enrichment, and the derivation of every field
// signals/github.json carries. Ported line for line from poll.sh's GitHub
// section — the jq quirks (`//` swallowing false, "" surviving it, codepoint
// slices) are the contract, and jq -S equality over the written file is the
// parity bar.
//
// One deliberate improvement, taken from GitHubClient.swift rather than
// invented: poll.sh ran one GraphQL query per open PR; here every open PR
// across every repo rides ONE batched query behind generated aliases
// (r<i>/p<number>), walked by shape on the way back. Same fragment, same
// derived fields, one call.

import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { ExecResult, PollIo, RepoSignalBlock } from '../types.js';
import { firstPreviewMatch } from '../cards/preview.js';

type Obj = Record<string, unknown>;

/**
 * How many repos' `gh pr list` passes run at once. The per-repo fetches are
 * independent, so running them concurrently turns a 7-repo poll's wall time
 * from the sum of seven round trips into roughly the slowest wave — but a cap
 * keeps the burst well under GitHub's secondary (abuse) limits, which trip on
 * too many requests in too short a window far sooner than the hourly budget.
 */
const REPO_FETCH_CONCURRENCY = 3;

/** exec, async when the io offers it, else the sync exec wrapped in a promise
 *  so the same code path serves both production and the synchronous test stub. */
function runExec(io: PollIo, cmd: string, args: string[]): Promise<ExecResult> {
  return io.execAsync ? io.execAsync(cmd, args) : Promise.resolve(io.exec(cmd, args));
}

/**
 * Promise.all with a concurrency cap, preserving input order. A pool of `limit`
 * workers pulls from a shared cursor, so at most `limit` commands are in flight
 * at once regardless of how many repos are configured.
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  };
  const pool = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return results;
}

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** jq's `//`: null AND false fall through; "" and 0 are kept. */
function jqAlt<T>(value: unknown, fallback: T): unknown | T {
  return value === undefined || value === null || value === false ? fallback : value;
}

/** jq's string slice `[0:n]` — by codepoint, and null slices to null. */
function jqSlice(value: unknown, n: number): unknown {
  if (typeof value === 'string') return [...value].slice(0, n).join('');
  return value === undefined ? null : value;
}

// ── Locating gh ───────────────────────────────────────────────────────────────

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Shell.locate("gh", overrideEnvironment: "BOARD_GH_PATH"), ported from the
 * Swift app: the override first, then the prefixes a bundled app cannot see on
 * launchd's PATH, then PATH itself, then a login shell for installs nothing
 * can guess (mise, nix, asdf). Null when gh is nowhere — poll.sh's behaviour
 * there was four silent `|| echo '[]'` fallbacks per repo, and that silence is
 * kept: an empty board from a missing gh looks exactly like the shell's.
 */
export function locateGh(io: PollIo): string | null {
  const env = io.env;
  const candidates: string[] = [];
  const override = env['BOARD_GH_PATH'];
  if (override !== undefined && override !== '') candidates.push(override);
  candidates.push(
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
    '/usr/bin/gh',
    '/opt/local/bin/gh',
    join(io.homeDir(), '.local', 'bin', 'gh'),
  );
  const path = env['PATH'];
  if (path !== undefined) {
    for (const dir of path.split(delimiter)) {
      if (dir !== '') candidates.push(join(dir, 'gh'));
    }
  }
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate;
  }
  // Last resort: the login shell's own lookup.
  const shell = env['SHELL'] ?? '/bin/zsh';
  if (!isExecutableFile(shell)) return null;
  const result = io.exec(shell, ['-lc', 'command -v gh']);
  if (result.status !== 0) return null;
  const found = result.stdout.trim();
  return found !== '' && isExecutableFile(found) ? found : null;
}

// ── gh pr list ────────────────────────────────────────────────────────────────

/**
 * The open-PR list fields. `statusCheckRollup` is deliberately NOT here: gh's
 * rollup pulls every CI context for every PR unbounded, and on a large repo
 * (hundreds of open PRs' worth of checks in one response) GitHub's GraphQL
 * backend returns 502/504 and the whole list degrades to [] — which made every
 * PR in that repo render "PR Gone". The CI rollup is fetched separately, with a
 * bounded `contexts(first:N)` query that cannot blow the same limit (see
 * rollupQuery / ROLLUP_CONTEXT_LIMIT).
 */
export const OPEN_FIELDS =
  'number,title,headRefName,baseRefName,url,isDraft,reviewDecision,reviewRequests,latestReviews,updatedAt,mergeStateStatus';
/** ...for `--state merged`. */
export const MERGED_FIELDS = 'number,title,headRefName,url,mergedAt';
/** ...for `--state closed`. */
export const CLOSED_FIELDS = 'number,title,headRefName,baseRefName,url,closedAt,mergedAt';

/** One repo's four lists, still raw: open not yet enriched. */
export interface RepoPRs {
  repo: string;
  open: Obj[];
  merged: Obj[];
  closed: Obj[];
}

/**
 * One `gh pr list`, degraded to [] on any failure — poll.sh's
 * `2>/dev/null || echo '[]'` on each of the four calls. A parseable non-array
 * is also [] (the bash would have fed it to jq expressions that error or
 * yield nonsense; nothing valid ever comes back shaped that way).
 */
async function ghList(io: PollIo, gh: string, args: string[]): Promise<Obj[]> {
  const result = await runExec(io, gh, args);
  if (result.status !== 0) return [];
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed.filter(isObj) : [];
  } catch {
    return [];
  }
}

/**
 * jq's unique_by(.number) over open + review-requested: group by number,
 * FIRST of each group in input order wins (so the open-list row outranks its
 * review-requested duplicate), and the result is SORTED by number ascending —
 * unique_by sorts, which is why signals and the summary list PRs in ascending
 * order rather than gh's newest-first.
 */
export function uniqueByNumber(rows: Obj[]): Obj[] {
  const byNumber = new Map<unknown, Obj>();
  for (const row of rows) {
    const key = row['number'];
    if (!byNumber.has(key)) byNumber.set(key, row);
  }
  return [...byNumber.entries()]
    .sort(([a], [b]) => {
      const an = typeof a === 'number' ? a : Number.NEGATIVE_INFINITY;
      const bn = typeof b === 'number' ? b : Number.NEGATIVE_INFINITY;
      return an - bn;
    })
    .map(([, row]) => row);
}

/**
 * The four pr-list calls poll.sh makes per repo, with its exact field lists
 * and limits. `authorFilter` null omits --author entirely (gh treats an empty
 * author as a person named nothing); review-requested PRs merge into open via
 * unique_by(number) — PRs we did not write but were asked to review are board
 * work too. Closed keeps only mergedAt == null: a PR closed WITHOUT merging is
 * in neither the open nor the merged list, and would otherwise vanish from
 * signals with nothing to transition its item.
 */
export async function fetchRepoPRs(
  io: PollIo,
  gh: string | null,
  repo: string,
  authorFilter: string | null,
  reviewLogin: string | null,
  wantMergedClosed = true,
): Promise<RepoPRs> {
  if (gh === null) return { repo, open: [], merged: [], closed: [] };
  const author = authorFilter === null ? [] : ['--author', authorFilter];

  const open = await ghList(io, gh, [
    'pr', 'list', '--repo', repo, ...author,
    '--state', 'open', '--limit', '50', '--json', OPEN_FIELDS,
  ]);
  // A null reviewLogin turns the review-requested merge off entirely
  // (operator.includeReviewRequests: false) — the operator wants the board
  // to hold authored work only, so those PRs never even enter signals.
  const review = reviewLogin === null ? [] : await ghList(io, gh, [
    'pr', 'list', '--repo', repo, '--search', `review-requested:${reviewLogin}`,
    '--state', 'open', '--limit', '30', '--json', OPEN_FIELDS,
  ]);
  // merged/closed change rarely; the caller skips them on most polls and reuses
  // the previous lists (collectGithub), so we never spend the two calls here.
  if (!wantMergedClosed) {
    return { repo, open: uniqueByNumber([...open, ...review]), merged: [], closed: [] };
  }
  const merged = await ghList(io, gh, [
    'pr', 'list', '--repo', repo, ...author,
    '--state', 'merged', '--limit', '20', '--json', MERGED_FIELDS,
  ]);
  const closedAll = await ghList(io, gh, [
    'pr', 'list', '--repo', repo, ...author,
    '--state', 'closed', '--limit', '10', '--json', CLOSED_FIELDS,
  ]);
  // `select(.mergedAt == null)` — absent reads as null and is kept.
  const closed = closedAll.filter((row) => (row['mergedAt'] ?? null) === null);

  return { repo, open: uniqueByNumber([...open, ...review]), merged, closed };
}

// ── CI rollup ─────────────────────────────────────────────────────────────────

const CI_FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED']);
const CI_PENDING = new Set(['PENDING', 'IN_PROGRESS', 'QUEUED', '']);

/**
 * poll.sh's one-word rollup over statusCheckRollup. Each entry reads
 * `.conclusion // .state // ""`: a CheckRun still running has an EMPTY
 * conclusion, which jq's `//` keeps, so it lands in the pending set rather
 * than falling through to .state — that is why a running check reads
 * "running" and not its eventual state. Failure outranks pending; no checks
 * at all is "none", not "green".
 */
export function ciRollup(statusCheckRollup: unknown): string {
  const entries = Array.isArray(statusCheckRollup) ? statusCheckRollup : [];
  const values = entries.map((entry) => {
    if (!isObj(entry)) return '';
    return String(jqAlt(jqAlt(entry['conclusion'], jqAlt(entry['state'], '')), ''));
  });
  if (values.some((v) => CI_FAILED.has(v))) return 'red';
  if (values.some((v) => CI_PENDING.has(v))) return 'running';
  if (values.length === 0) return 'none';
  return 'green';
}

/**
 * ciState from GitHub's own `statusCheckRollup.state` — the authoritative
 * verdict over EVERY check on the PR, which is why the rollup query reads it
 * instead of trusting the (bounded, possibly truncated) contexts: a PR with
 * more than 100 checks cannot be judged from one page of them. Maps GitHub's
 * StatusState enum onto poll.sh's four words. Returns null for an unknown or
 * absent state so the caller falls back to ciRollup over the contexts — which
 * also covers "no checks at all" (a null rollup has no state).
 */
export function ciFromRollupState(state: unknown): string | null {
  switch (state) {
    case 'SUCCESS':
      return 'green';
    case 'FAILURE':
    case 'ERROR':
      return 'red';
    case 'PENDING':
    case 'EXPECTED':
      return 'running';
    default:
      return null;
  }
}

// ── The preview deploy's own check ────────────────────────────────────────────

/**
 * How a deploy host names its check on GitHub, matched against the URL the
 * preview was found by — so the pending signal tracks the host the chip
 * actually opens. Cloudflare Pages deploys to *.pages.dev and names its check
 * "Cloudflare Pages"; the other two name themselves.
 */
const DEPLOY_CHECKS: { url: RegExp; check: RegExp; not?: RegExp }[] = [
  // Vercel posts two checks that both say "Vercel". `Vercel` is the deployment
  // — a StatusContext, so its verdict is in `state` — and `Vercel Preview
  // Comments` is the comment bot, a CheckRun that runs on the same push and
  // finishes on its own schedule. Matching both would call the preview
  // rebuilding whenever the bot was busy, which is not what the chip means and
  // not what the banner should wait for.
  { url: /vercel\.app/i, check: /^vercel\b/i, not: /comments?$/i },
  { url: /netlify\.app/i, check: /netlify/i },
  { url: /pages\.dev/i, check: /cloudflare/i },
];

/**
 * True when a preview deployment is being built right now. Read from the same
 * rollup `ciRollup` reads, before the raw entries are dropped from the row.
 *
 * Which checks count depends on whether there is a preview to compare against,
 * and the empty case is the one that matters most:
 *
 * - **With a URL**, the host is known. Watch that host's check and no other, so
 *   the signal tracks the deployment the chip actually opens rather than any
 *   deploy that happens to be running — the chip means "the address you can
 *   click is serving the previous push".
 * - **Without one**, the PR has been pushed and no preview has ever been
 *   published. This is exactly where the chip has something to say and nothing
 *   to say it with: an empty slot cannot tell "this project has no previews"
 *   from "the first one lands in ten seconds". The host is unknown too — it is
 *   named by the URL that does not exist yet — so any deploy check the table
 *   knows counts.
 *
 * A repository with no deploy check at all still returns false in both cases,
 * which is the "no previews here" the empty slot goes on meaning.
 */
export function previewPendingFromRollup(rollup: unknown, previewUrl: string): boolean {
  const hosts =
    previewUrl === ''
      ? DEPLOY_CHECKS
      : DEPLOY_CHECKS.filter((entry) => entry.url.test(previewUrl));
  if (hosts.length === 0) return false;
  const entries = Array.isArray(rollup) ? rollup : [];
  return entries.some((entry) => {
    if (!isObj(entry)) return false;
    // CheckRuns carry `name`, StatusContexts carry `context` — one or the other.
    const name = entry['name'] ?? entry['context'];
    if (typeof name !== 'string') return false;
    const deploy = hosts.find((h) => h.check.test(name) && h.not?.test(name) !== true);
    if (deploy === undefined) return false;
    const value = String(jqAlt(jqAlt(entry['conclusion'], jqAlt(entry['state'], '')), ''));
    return CI_PENDING.has(value);
  });
}

// ── The batched details query ─────────────────────────────────────────────────

/**
 * How many review threads to pull per PR in the details query. poll.sh asked
 * for 100; the GraphQL point cost is charged on the requested `first`, so this
 * is a direct points lever. 40 covers effectively every real PR's thread count
 * (a PR with more than 40 open threads is pathological), and unresolvedSample
 * only ever shows the first 5. Lowering it does not change the output of any PR
 * with ≤ 40 threads.
 */
export const THREAD_FETCH_LIMIT = 40;

/**
 * poll.sh's rich per-PR fragment — reviewThreads with resolution, path, the
 * first comment (who asked, what, when) and the last (who spoke last), plus
 * the trailing 20 reviews — with `number` added so the aliased response can
 * be walked by shape, as GitHubClient.swift walks its.
 */
const PR_FRAGMENT = `fragment prDetails on PullRequest {
  number
  reviewThreads(first: ${THREAD_FETCH_LIMIT}) { nodes {
    isResolved isOutdated path
    comments(first: 1) { nodes { author { login } body createdAt } }
    lastComment: comments(last: 1) { nodes { author { login } createdAt } } } }
  reviews(last: 20) { nodes { author { login } state submittedAt } }
}`;

export interface DetailsQuery {
  query: string;
  /** Generated alias → "owner/name", for indexing the response by repo. */
  aliasToRepo: Map<string, string>;
}

/**
 * One query, one alias per repo (r0, r1, … over sorted repo names) and per PR
 * (p<number>, sorted), like GitHubClient.detailsQuery — sorted so the same
 * board always produces the same query text. Repos that are not owner/name
 * are skipped; they could never resolve.
 */
export function detailsQuery(open: { repo: string; number: number }[]): DetailsQuery {
  const byRepo = new Map<string, number[]>();
  for (const pr of open) {
    const list = byRepo.get(pr.repo) ?? [];
    list.push(pr.number);
    byRepo.set(pr.repo, list);
  }
  const aliasToRepo = new Map<string, string>();
  const blocks: string[] = [];
  [...byRepo.keys()].sort().forEach((repo, index) => {
    const parts = repo.split('/');
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return;
    const alias = `r${index}`;
    aliasToRepo.set(alias, repo);
    const numbers = [...new Set(byRepo.get(repo) ?? [])].sort((a, b) => a - b);
    const fields = numbers
      .map((n) => `    p${n}: pullRequest(number: ${n}) { ...prDetails }`)
      .join('\n');
    blocks.push(`  ${alias}: repository(owner: "${parts[0]}", name: "${parts[1]}") {\n${fields}\n  }`);
  });
  const query = `query {\n  rateLimit { remaining }\n${blocks.join('\n')}\n}\n${PR_FRAGMENT}`;
  return { query, aliasToRepo };
}

/**
 * Walks the aliased response by shape: every key under `data` except
 * rateLimit is a repo block (named back through the alias map), and every key
 * of a repo block is a PR node carrying its own number. A PR that errored
 * comes back null beside the ones that resolved, and is simply absent from
 * the index — its row derives from an empty node, exactly as poll.sh's
 * per-PR `|| echo '{}'` did.
 */
export function indexDetails(response: unknown, aliasToRepo: Map<string, string>): Map<string, Obj> {
  const index = new Map<string, Obj>();
  if (!isObj(response)) return index;
  const data = response['data'];
  if (!isObj(data)) return index;
  for (const [key, block] of Object.entries(data)) {
    if (key === 'rateLimit') continue;
    const repo = aliasToRepo.get(key);
    if (repo === undefined || !isObj(block)) continue;
    for (const node of Object.values(block)) {
      if (!isObj(node)) continue;
      const number = node['number'];
      if (typeof number !== 'number') continue;
      index.set(`${repo}#${number}`, node);
    }
  }
  return index;
}

// ── The CI rollup query ───────────────────────────────────────────────────────

/**
 * How many check contexts to pull per PR for the CI rollup. Bounding this is the
 * whole point: gh's own `--json statusCheckRollup` is unbounded and 502s on a
 * busy repo, whereas `contexts(first: 20)` over every open PR in one query costs
 * about one point and never blows the backend. 20 covers every real PR's check
 * set; a repo running more than 20 checks on one PR only risks a check beyond
 * the 20th changing the rollup, which no board has met.
 */
export const ROLLUP_CONTEXT_LIMIT = 100;

/** The last commit's rollup — the per-PR body of rollupQuery. `state` is
 *  GitHub's verdict over ALL checks (what ciState is derived from, so a PR with
 *  more checks than one page holds is still judged correctly); `contexts`
 *  (bounded at GitHub's hard max of 100) feeds previewPending, which only needs
 *  to find the one named deploy check. The nodes are shaped exactly as
 *  previewPendingFromRollup reads them: a CheckRun carries name+conclusion, a
 *  StatusContext carries context+state. */
const ROLLUP_SELECTION = `number commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: ${ROLLUP_CONTEXT_LIMIT}) { nodes {
    __typename
    ... on CheckRun { name status conclusion }
    ... on StatusContext { context state } } } } } } }`;

/**
 * The CI rollup for every open PR, in ONE bounded query — the replacement for
 * the statusCheckRollup field gh used to fold into `pr list`. Same aliasing as
 * detailsQuery (r<i>/p<number>, sorted for a stable query), so the response
 * walks by shape. Run every poll over ALL open PRs (not just the changed ones):
 * a check completing does not bump the PR's updatedAt, so CI must be read fresh
 * or it would stick — and at ~1 point for dozens of PRs, fresh is affordable.
 */
export function rollupQuery(open: { repo: string; number: number }[]): DetailsQuery {
  const byRepo = new Map<string, number[]>();
  for (const pr of open) {
    const list = byRepo.get(pr.repo) ?? [];
    list.push(pr.number);
    byRepo.set(pr.repo, list);
  }
  const aliasToRepo = new Map<string, string>();
  const blocks: string[] = [];
  [...byRepo.keys()].sort().forEach((repo, index) => {
    const parts = repo.split('/');
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return;
    const alias = `r${index}`;
    aliasToRepo.set(alias, repo);
    const numbers = [...new Set(byRepo.get(repo) ?? [])].sort((a, b) => a - b);
    const fields = numbers
      .map((n) => `    p${n}: pullRequest(number: ${n}) { ${ROLLUP_SELECTION} }`)
      .join('\n');
    blocks.push(`  ${alias}: repository(owner: "${parts[0]}", name: "${parts[1]}") {\n${fields}\n  }`);
  });
  const query = `query {\n  rateLimit { remaining }\n${blocks.join('\n')}\n}`;
  return { query, aliasToRepo };
}

/**
 * Walks the rollup response to a map of (repo#number) → the flat context array
 * ciRollup/previewPendingFromRollup expect. A PR is indexed ONLY when its node
 * actually carries a `commits` field: a node without one (an errored PR, or a
 * test stub that serves the threads fixture to this query) leaves no entry, so
 * the caller falls back to whatever rollup the row already held rather than
 * wrongly blanking its CI.
 */
export interface PrRollup {
  /** GitHub's `statusCheckRollup.state` over all checks, or null (no rollup). */
  state: string | null;
  /** The bounded context nodes, for previewPending. */
  contexts: Obj[];
}

export function indexRollups(response: unknown, aliasToRepo: Map<string, string>): Map<string, PrRollup> {
  const index = new Map<string, PrRollup>();
  if (!isObj(response)) return index;
  const data = response['data'];
  if (!isObj(data)) return index;
  for (const [key, block] of Object.entries(data)) {
    if (key === 'rateLimit') continue;
    const repo = aliasToRepo.get(key);
    if (repo === undefined || !isObj(block)) continue;
    for (const node of Object.values(block)) {
      if (!isObj(node)) continue;
      const number = node['number'];
      if (typeof number !== 'number') continue;
      if (!('commits' in node)) continue; // no rollup info here — leave the fallback in charge
      const commit = nodes(node['commits'])[0];
      const rollup = isObj(commit) && isObj(commit['commit']) ? commit['commit']['statusCheckRollup'] : null;
      const state = isObj(rollup) && typeof rollup['state'] === 'string' ? rollup['state'] : null;
      const contexts = isObj(rollup) ? nodes(rollup['contexts']).filter(isObj) : [];
      index.set(`${repo}#${number}`, { state, contexts });
    }
  }
  return index;
}

// ── Field derivation ──────────────────────────────────────────────────────────

/** `.nodes` of a connection, or [] — every `// []` in the jq at once. */
function nodes(connection: unknown): unknown[] {
  if (!isObj(connection)) return [];
  const list = connection['nodes'];
  return Array.isArray(list) ? list : [];
}

/** `.comments.nodes[0]` / `.lastComment.nodes[0]` — null-safe like jq's paths. */
function firstNode(thread: Obj, key: string): Obj | null {
  const first = nodes(thread[key])[0];
  return isObj(first) ? first : null;
}

/** `.author.login // "?"` on a comment node. */
function authorLogin(comment: Obj | null): unknown {
  const author = comment === null ? null : comment['author'];
  return jqAlt(isObj(author) ? author['login'] : null, '?');
}

export interface DeriveOptions {
  /** config's `.operator.githubLogins // []` — who counts as "us" on a thread. */
  ourLogins: string[];
  /** The scraped or reused preview URL; "" reads as none, like the shell var. */
  preview: string;
  /**
   * When `preview` is empty, the PR's `updatedAt` at the moment we last scraped
   * for a preview and found none — the negative-result marker that stops the
   * next poll re-scraping an unchanged PR. Written onto the row only when there
   * is no preview to record instead; null/absent means "re-scrape as before".
   */
  previewScrapedFor?: string | null;
}

/**
 * The list-derived half of an open row: the raw `gh pr list` fields plus the
 * three fields that come from the FRESH row every poll — the preview URL, the
 * preview-pending flag, and the one-word CI rollup. Shared by deriveOpenRow
 * (which adds freshly-computed thread fields) and reuseOpenRow (which adds
 * reused ones), so the list half can never drift between the two paths.
 */
function listDerived(pr: Obj, repo: string, preview: string): Obj {
  return {
    ...pr,
    repo,
    previewUrl: preview === '' ? null : preview,
    previewPending: previewPendingFromRollup(pr['statusCheckRollup'], preview),
    // Prefer GitHub's own rollup `state` (it weighs EVERY check, even on a PR
    // whose 156 checks overflow the bounded contexts we fetch); fall back to
    // computing from the contexts when no state is attached (older signals, and
    // the tests, which carry a contexts array on the row and no `_rollupState`).
    ciState: ciFromRollupState(pr['_rollupState']) ?? ciRollup(pr['statusCheckRollup']),
  };
}

/** The shared tail of both open-row paths: the negative-scrape marker (only
 *  when there is no preview to record) and dropping the raw rollup fields. */
function finalizeOpenRow(row: Obj, previewScrapedFor: string | null | undefined): Obj {
  if (row['previewUrl'] === null && typeof previewScrapedFor === 'string') {
    row['previewScrapedFor'] = previewScrapedFor;
  }
  delete row['statusCheckRollup'];
  delete row['_rollupState'];
  return row;
}

/**
 * poll.sh's enrichment jq for one open PR: the raw `gh pr list` row plus the
 * derived fields, minus statusCheckRollup. An unresolved thread means nothing
 * on its own — what matters is who spoke LAST: a reviewer waiting on us is an
 * action (unresolvedThreads); our own reply waiting on a re-review is not
 * (threadsAwaitingReviewer). Counting both as "unresolved" made every
 * answered review look like an outstanding ask.
 */
export function deriveOpenRow(pr: Obj, node: Obj | null, repo: string, options: DeriveOptions): Obj {
  const p: Obj = node ?? {};
  const threads = nodes(p['reviewThreads']).filter(isObj);
  const reviews = nodes(p['reviews']).filter(isObj);
  // `select(.isResolved == false)` — strictly false; null is not unresolved.
  const unresolved = threads.filter((t) => t['isResolved'] === false);
  const spokeLast = (t: Obj): unknown => authorLogin(firstNode(t, 'lastComment'));
  const ours = (who: unknown): boolean =>
    typeof who === 'string' && options.ourLogins.includes(who);
  const awaitingUs = unresolved.filter((t) => !ours(spokeLast(t)));
  const awaitingReviewer = unresolved.filter((t) => ours(spokeLast(t)));

  // `[($reviews[]?.submittedAt), ($threads[]?.comments.nodes[0].createdAt)]
  //  | map(select(. != null)) | sort | last` — ALL threads, not just the
  // unresolved ones, and ISO-8601 UTC strings compare as times via sort.
  const stamps: string[] = [];
  for (const review of reviews) {
    const at = review['submittedAt'];
    if (typeof at === 'string') stamps.push(at);
  }
  for (const thread of threads) {
    const at = firstNode(thread, 'comments')?.['createdAt'];
    if (typeof at === 'string') stamps.push(at);
  }
  stamps.sort();
  const latestActivityAt = stamps.length > 0 ? stamps[stamps.length - 1]! : null;

  // `map({(.author.login // "?"): .state}) | add // {}` — last review per
  // login wins, because object add overwrites left with right.
  const reviewStates: Obj = {};
  for (const review of reviews) {
    const author = review['author'];
    const login = jqAlt(isObj(author) ? author['login'] : null, '?');
    reviewStates[typeof login === 'string' ? login : String(login)] = review['state'] as unknown;
  }

  const unresolvedSample = awaitingUs
    .map((t) => {
      const first = firstNode(t, 'comments');
      return {
        path: t['path'] ?? null,
        author: authorLogin(first),
        body: jqSlice(jqAlt(first?.['body'], ''), 200),
      };
    })
    .slice(0, 5);

  const row: Obj = {
    ...listDerived(pr, repo, options.preview),
    unresolvedThreads: awaitingUs.length,
    threadsAwaitingReviewer: awaitingReviewer.length,
    unresolvedSample,
    latestActivityAt,
    reviewStates,
  };
  // The negative-scrape marker rides along ONLY when there is no preview to
  // record — a found preview is reused by number forever and needs no marker,
  // and omitting the key on that path keeps the row identical to the shell's.
  return finalizeOpenRow(row, options.previewScrapedFor);
}

/**
 * The open row for a PR that has NOT changed since the last poll: fresh
 * list-derived fields (ciState/preview move with the current `gh pr list` row),
 * but the five thread-derived fields are REUSED from the previous signals row
 * instead of being recomputed from a fresh reviewThreads/reviews fetch. That
 * fetch is the single most expensive part of the poll, and for an unchanged PR
 * it would return exactly what we already hold — so this produces a row
 * identical to a fresh deriveOpenRow while making no GraphQL request for it.
 *
 * "Unchanged" is decided by the caller (enrichPRs) on updatedAt + reviewDecision
 * — the same updatedAt-keyed tolerance the preview negative-cache already runs.
 */
export function reuseOpenRow(
  pr: Obj,
  prev: Obj,
  repo: string,
  options: DeriveOptions,
): Obj {
  const asNumber = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const row: Obj = {
    ...listDerived(pr, repo, options.preview),
    unresolvedThreads: asNumber(prev['unresolvedThreads'], 0),
    threadsAwaitingReviewer: asNumber(prev['threadsAwaitingReviewer'], 0),
    unresolvedSample: Array.isArray(prev['unresolvedSample']) ? prev['unresolvedSample'] : [],
    latestActivityAt: typeof prev['latestActivityAt'] === 'string' ? prev['latestActivityAt'] : null,
    reviewStates: isObj(prev['reviewStates']) ? prev['reviewStates'] : {},
  };
  return finalizeOpenRow(row, options.previewScrapedFor);
}

/**
 * Whether an open PR must be re-enriched this poll, or its thread-derived
 * fields can be reused from `prev`. Reuse only when the previous row is one we
 * actually enriched (it carries a numeric unresolvedThreads) AND neither the
 * PR's updatedAt nor its reviewDecision has moved. updatedAt catches almost
 * everything (a new comment, review or push bumps it); reviewDecision is the
 * belt-and-suspenders trigger for a review verdict landing, and the whole rule
 * degrades safely — an unsure case re-enriches rather than reuses.
 */
export function needsEnrich(row: Obj, prev: Obj | null): boolean {
  if (prev === null) return true;
  if (typeof prev['unresolvedThreads'] !== 'number') return true;
  if ((prev['updatedAt'] ?? null) !== (row['updatedAt'] ?? null)) return true;
  if ((prev['reviewDecision'] ?? null) !== (row['reviewDecision'] ?? null)) return true;
  return false;
}

/** The previous poll's enriched open row for (repo, number), or null — the
 *  reuse source for an unchanged PR, read from the same previous github.json
 *  the preview cache reads. */
export function previousOpenRow(previous: unknown, repo: string, number: number): Obj | null {
  if (!isObj(previous)) return null;
  const repos = previous['repos'];
  if (!Array.isArray(repos)) return null;
  for (const block of repos) {
    if (!isObj(block) || block['repo'] !== repo) continue;
    const open = block['open'];
    if (!Array.isArray(open)) continue;
    for (const prev of open) {
      if (isObj(prev) && prev['number'] === number) return prev;
    }
  }
  return null;
}

// ── Preview URL ───────────────────────────────────────────────────────────────

/**
 * The previewUrl already recorded for (repo, number) in the previous
 * signals/github.json, or "". Fetching every comment on every PR, every
 * cycle, to re-derive a URL that is fixed for the life of the branch was the
 * single largest cost in the poll — reuse the one we already found.
 * `.previewUrl // empty` means a recorded null does NOT count as found.
 */
export function previewFromPrevious(previous: unknown, repo: string, number: number): string {
  if (!isObj(previous)) return '';
  const repos = previous['repos'];
  if (!Array.isArray(repos)) return '';
  for (const block of repos) {
    if (!isObj(block) || block['repo'] !== repo) continue;
    const open = block['open'];
    if (!Array.isArray(open)) continue;
    for (const row of open) {
      if (!isObj(row) || row['number'] !== number) continue;
      const preview = row['previewUrl'];
      if (preview === undefined || preview === null || preview === false) continue;
      // Signals we wrote only ever hold a string here; anything else came
      // from a hand-edited file and is not worth trusting as a URL.
      if (typeof preview === 'string') return preview;
    }
  }
  return '';
}

/**
 * The `previewScrapedFor` marker recorded for (repo, number) in the previous
 * signals/github.json: the PR's `updatedAt` the last time we scraped and found
 * no preview. Null when there is no marker — a PR we have never scraped-empty,
 * or one whose previous row predates this field. Its whole job is to let the
 * next poll skip the `gh pr view` for a PR that has not changed since we last
 * looked and came up empty — the 13-PRs-with-no-preview re-scrape that ran
 * every cycle for nothing.
 */
export function previewScrapedForFromPrevious(
  previous: unknown,
  repo: string,
  number: number,
): string | null {
  if (!isObj(previous)) return null;
  const repos = previous['repos'];
  if (!Array.isArray(repos)) return null;
  for (const block of repos) {
    if (!isObj(block) || block['repo'] !== repo) continue;
    const open = block['open'];
    if (!Array.isArray(open)) continue;
    for (const row of open) {
      if (!isObj(row) || row['number'] !== number) continue;
      const marker = row['previewScrapedFor'];
      return typeof marker === 'string' ? marker : null;
    }
  }
  return null;
}

/**
 * poll.sh's fallback scrape: `gh pr view --json comments`, bodies joined,
 * first preview-pattern match. The URL lives only in the deploy bot's comment
 * — the Vercel check's targetUrl points at the dashboard inspector, not the
 * deployed site. Patterns come from config's preview.patterns when set (the
 * portability seam the Swift app already honours); null falls back to the
 * same vercel pattern poll.sh greps for.
 */
export function scrapePreview(
  io: PollIo,
  gh: string,
  repo: string,
  number: number,
  patterns: string[] | null | undefined,
): string {
  const result = io.exec(gh, ['pr', 'view', String(number), '--repo', repo, '--json', 'comments']);
  if (result.status !== 0) return '';
  let bodies: string[] = [];
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (isObj(parsed) && Array.isArray(parsed['comments'])) {
      bodies = parsed['comments']
        .map((c: unknown) => (isObj(c) ? c['body'] : null))
        .filter((b: unknown): b is string => typeof b === 'string');
    }
  } catch {
    return '';
  }
  return firstPreviewMatch(bodies, patterns) ?? '';
}

// ── Enrichment over every repo at once ────────────────────────────────────────

export interface EnrichOptions {
  /** config's `.operator.githubLogins // []`. */
  ourLogins: string[];
  /** The previous signals/github.json, parsed, for previewUrl reuse. */
  previousSignals?: unknown;
  /** config's preview.patterns; null/undefined keeps the default. */
  previewPatterns?: string[] | null;
  /**
   * Called once after the details pass with what it cost and did: the GraphQL
   * budget `remaining` the query reported (null if no call was made or it
   * failed) and how many open PRs were actually re-enriched this poll. poll.ts
   * stores both on the github doc — the first to drive rate-limit backoff, the
   * second to tell an idle board (0 enriched) from a busy one.
   */
  onStats?: (stats: { rateRemaining: number | null; enriched: number }) => void;
}

/** The `data.rateLimit.remaining` the details query reports, or null. */
function rateRemainingFrom(parsed: unknown): number | null {
  if (!isObj(parsed)) return null;
  const data = parsed['data'];
  if (!isObj(data)) return null;
  const rl = data['rateLimit'];
  if (!isObj(rl)) return null;
  const remaining = rl['remaining'];
  return typeof remaining === 'number' ? remaining : null;
}

/**
 * The enrichment pass over every repo's fetched lists. poll.sh re-fetched
 * reviewThreads + reviews for EVERY open PR every poll — the single most
 * expensive part of the cycle (measured at the bulk of ~475 GraphQL points on
 * a 7-repo board). Almost none of those PRs changed between polls, and an
 * unchanged PR's threads return exactly what the previous github.json already
 * holds. So this enriches only the PRs that CHANGED (needsEnrich, keyed on
 * updatedAt + reviewDecision like the preview cache), batches just those into
 * the one GraphQL call, and REUSES the previous poll's thread-derived fields
 * for the rest (reuseOpenRow). The list-derived fields (ciState, preview) are
 * always fresh from the current `gh pr list` row, so the output of an unchanged
 * PR is identical to a fresh enrichment — at zero GraphQL cost.
 *
 * Repos keep their input order; open rows keep theirs (already
 * unique_by-sorted). merged and closed pass through untouched.
 */
export function enrichPRs(
  io: PollIo,
  gh: string | null,
  repos: RepoPRs[],
  options: EnrichOptions,
): RepoSignalBlock[] {
  // Decide reuse-vs-enrich per open PR first, so only the changed ones go into
  // the (expensive) threads query. allOpen drives the (cheap) rollup query,
  // which runs over every open PR every poll — CI changes do not bump a PR's
  // updatedAt, so the rollup cannot be made incremental the way threads are.
  const prevOf = new Map<string, Obj | null>();
  const enrichSet = new Set<string>();
  const toEnrich: { repo: string; number: number }[] = [];
  const allOpen: { repo: string; number: number }[] = [];
  for (const block of repos) {
    for (const row of block.open) {
      const number = row['number'];
      if (typeof number !== 'number' || !Number.isInteger(number)) continue;
      const key = `${block.repo}#${number}`;
      allOpen.push({ repo: block.repo, number });
      const prev = previousOpenRow(options.previousSignals, block.repo, number);
      prevOf.set(key, prev);
      if (needsEnrich(row, prev)) {
        enrichSet.add(key);
        toEnrich.push({ repo: block.repo, number });
      }
    }
  }

  let rateRemaining: number | null = null;

  // The CI rollup for every open PR, in one bounded query (see rollupQuery:
  // this is what replaced the statusCheckRollup gh folded into `pr list` and
  // 502'd on busy repos). The row then derives ciState/previewPending from it.
  let rollups = new Map<string, PrRollup>();
  if (gh !== null && allOpen.length > 0) {
    const { query, aliasToRepo } = rollupQuery(allOpen);
    const result = io.exec(gh, ['api', 'graphql', '-f', `query=${query}`]);
    if (result.status === 0) {
      try {
        const parsed: unknown = JSON.parse(result.stdout);
        rollups = indexRollups(parsed, aliasToRepo);
        rateRemaining = rateRemainingFrom(parsed);
      } catch {
        // Degrade like the shell: no rollup, the lists (and CI 'none') survive.
      }
    }
  }

  // The threads/reviews enrichment, only for the PRs that changed.
  let details = new Map<string, Obj>();
  if (gh !== null && toEnrich.length > 0) {
    const { query, aliasToRepo } = detailsQuery(toEnrich);
    const result = io.exec(gh, ['api', 'graphql', '-f', `query=${query}`]);
    if (result.status === 0) {
      try {
        const parsed: unknown = JSON.parse(result.stdout);
        details = indexDetails(parsed, aliasToRepo);
        if (rateRemaining === null) rateRemaining = rateRemainingFrom(parsed);
      } catch {
        // poll.sh's `|| echo '{}'`: enrichment degrades, the lists survive.
      }
    }
  }

  const blocks = repos.map((block) => ({
    repo: block.repo,
    open: block.open.map((row) => {
      const number = row['number'];
      const key = typeof number === 'number' ? `${block.repo}#${number}` : '';
      const node =
        typeof number === 'number' ? (details.get(`${block.repo}#${number}`) ?? null) : null;
      // Attach the freshly-fetched CI rollup so ciState/previewPending derive
      // from it (the open list no longer carries statusCheckRollup). If the
      // rollup query had no entry for this PR — an errored node, or a test that
      // served another fixture — keep whatever rollup the row already had.
      const fetchedRollup = key === '' ? undefined : rollups.get(key);
      const row2 =
        fetchedRollup !== undefined
          ? { ...row, statusCheckRollup: fetchedRollup.contexts, _rollupState: fetchedRollup.state }
          : row;
      let preview = '';
      let scrapedFor: string | null = null;
      if (typeof number === 'number' && Number.isInteger(number)) {
        preview = previewFromPrevious(options.previousSignals, block.repo, number);
        if (preview === '' && gh !== null) {
          // Re-scrape only when there is a reason to. A preview is fixed for a
          // branch's life and appears via a deploy-bot comment, which bumps the
          // PR's updatedAt — so if updatedAt has not moved since we last looked
          // and found nothing, the answer is still nothing and the `gh pr view`
          // is pure cost. Look again when the PR changed, when a deploy is
          // building this push (the comment may land without an updatedAt bump),
          // or when we have never looked. This is the single biggest per-poll
          // saving: the PRs that will never have a preview stop being scraped.
          const updatedAt = typeof row['updatedAt'] === 'string' ? row['updatedAt'] : null;
          const pending = previewPendingFromRollup(row2['statusCheckRollup'], '');
          const lastScrapedFor = previewScrapedForFromPrevious(
            options.previousSignals,
            block.repo,
            number,
          );
          const worthScraping = pending || updatedAt === null || lastScrapedFor !== updatedAt;
          if (worthScraping) {
            preview = scrapePreview(io, gh, block.repo, number, options.previewPatterns);
            // Remember we looked at THIS version and found nothing, so the next
            // poll can skip it until the PR changes again.
            if (preview === '') scrapedFor = updatedAt;
          } else {
            // Carry the marker forward unchanged — the PR has not moved.
            scrapedFor = lastScrapedFor;
          }
        }
      }
      const derive: DeriveOptions = {
        ourLogins: options.ourLogins,
        preview,
        previewScrapedFor: scrapedFor,
      };
      // Changed PRs (and malformed rows with no number) derive fresh from the
      // GraphQL node; unchanged PRs reuse the previous poll's thread fields.
      if (key === '' || enrichSet.has(key)) {
        return deriveOpenRow(row2, node, block.repo, derive);
      }
      return reuseOpenRow(row2, prevOf.get(key) ?? {}, block.repo, derive);
    }),
    merged: block.merged,
    closed: block.closed,
  }));

  options.onStats?.({ rateRemaining, enriched: toEnrich.length });
  return blocks;
}

/** The previous poll's merged/closed lists for a repo — reused on the polls
 *  that skip the merged/closed fetch (they change rarely; see collectGithub's
 *  wantMergedClosed). [] when the previous file has nothing for the repo. */
function previousMergedClosed(previous: unknown, repo: string): { merged: Obj[]; closed: Obj[] } {
  if (isObj(previous) && Array.isArray(previous['repos'])) {
    for (const block of previous['repos']) {
      if (!isObj(block) || block['repo'] !== repo) continue;
      return {
        merged: Array.isArray(block['merged']) ? block['merged'].filter(isObj) : [],
        closed: Array.isArray(block['closed']) ? block['closed'].filter(isObj) : [],
      };
    }
  }
  return { merged: [], closed: [] };
}

/**
 * The whole fetch+enrich in one call per poll. `wantMergedClosed` false skips
 * the two per-repo merged/closed `gh pr list` calls and reuses the previous
 * poll's lists instead — those states change rarely, so poll.ts fetches them
 * only every cadence.mergedClosedEverySeconds and reuses in between, which
 * removes 2 of every repo's 3 list calls from most polls.
 */
export async function collectGithub(
  io: PollIo,
  gh: string | null,
  repoNames: string[],
  authorFilter: string | null,
  reviewLogin: string | null,
  options: EnrichOptions,
  wantMergedClosed = true,
): Promise<RepoSignalBlock[]> {
  // The repos are independent, so fetch them concurrently (bounded) rather than
  // one slow round trip after another — the poll's wall-clock cost now that the
  // per-poll GraphQL points are tamed by incremental enrichment.
  const fetched = await mapLimit(repoNames, REPO_FETCH_CONCURRENCY, (repo) =>
    fetchRepoPRs(io, gh, repo, authorFilter, reviewLogin, wantMergedClosed),
  );
  if (!wantMergedClosed) {
    for (const block of fetched) {
      const prev = previousMergedClosed(options.previousSignals, block.repo);
      block.merged = prev.merged;
      block.closed = prev.closed;
    }
  }
  return enrichPRs(io, gh, fetched, options);
}

// ── The review queue ──────────────────────────────────────────────────────────

/** The field list for the review-queue query — what a review card needs. */
export const REVIEW_FIELDS = 'number,title,url,headRefName,baseRefName,isDraft,updatedAt,author';

/**
 * The previewUrl the previous signals/reviews.json recorded for
 * (repo, number), or "" — same reuse rule as previewFromPrevious: a preview
 * is fixed for the life of the branch, so it is scraped once and carried.
 */
function reviewPreviewFromPrevious(previous: unknown, repo: string, number: number): string {
  if (!isObj(previous)) return '';
  const rows = previous['reviews'];
  if (!Array.isArray(rows)) return '';
  for (const row of rows) {
    if (!isObj(row) || row['repo'] !== repo || row['number'] !== number) continue;
    const preview = row['previewUrl'];
    if (typeof preview === 'string' && preview !== '') return preview;
  }
  return '';
}

/** The `previewScrapedFor` marker from the previous reviews.json — see the
 *  github.json twin previewScrapedForFromPrevious. */
function reviewScrapedForFromPrevious(previous: unknown, repo: string, number: number): string | null {
  if (!isObj(previous)) return null;
  const rows = previous['reviews'];
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (!isObj(row) || row['repo'] !== repo || row['number'] !== number) continue;
    const marker = row['previewScrapedFor'];
    return typeof marker === 'string' ? marker : null;
  }
  return null;
}

export interface ReviewQueueOptions {
  /** The previous signals/reviews.json, parsed, for previewUrl reuse. */
  previousSignals?: unknown;
  /** config's preview.patterns; null/undefined keeps the default. */
  previewPatterns?: string[] | null;
}

/**
 * One cross-repo GraphQL search for the whole reviews lane, built from the
 * configured repos. poll.sh (and the first port) ran one `gh pr list --search`
 * PER repo — seven GraphQL search operations on a 7-repo board, every poll, for
 * a lane that is usually short. GitHub's `search` OR-combines repeated `repo:`
 * qualifiers, so the same queue comes back in ONE operation. `repository
 * { nameWithOwner }` tags each hit with its repo (search spans them all at
 * once), and `first: 100` covers every configured repo's requests together
 * where the per-repo form capped at 30 each.
 */
function reviewSearchQuery(repoNames: string[], reviewLogin: string): string {
  const repoQ = repoNames.map((r) => `repo:${r}`).join(' ');
  const q = `${repoQ} review-requested:${reviewLogin} -author:${reviewLogin} is:pr is:open sort:updated-desc`;
  return `query {
  search(query: ${JSON.stringify(q)}, type: ISSUE, first: 100) {
    nodes { ... on PullRequest {
      number title url headRefName baseRefName isDraft updatedAt
      author { login }
      repository { nameWithOwner }
    } }
  }
}`;
}

/** The PullRequest nodes of the review search response, or [] on any shape we
 *  do not recognise — the degrade poll.sh got from its per-repo `|| echo []`. */
function reviewNodesFrom(parsed: unknown): Obj[] {
  if (!isObj(parsed)) return [];
  const data = parsed['data'];
  if (!isObj(data)) return [];
  const search = data['search'];
  if (!isObj(search) || !Array.isArray(search['nodes'])) return [];
  return search['nodes'].filter(isObj);
}

/**
 * The reviews lane: every open PR in the given repos that awaits a review from
 * `reviewLogin` and was NOT written by them — their own PRs are board work
 * already, in the open list. One cross-repo GraphQL search (reviewSearchQuery),
 * degraded to [] on any failure exactly as the per-repo form degraded. The
 * preview reuse/scrape negative-cache is unchanged, per row. Rows come back
 * newest-updated first; the whole queue is re-sorted the same way so the render
 * never has to invent an order.
 */
export function collectReviewRequests(
  io: PollIo,
  gh: string | null,
  repoNames: string[],
  reviewLogin: string,
  options: ReviewQueueOptions = {},
): import('../types.js').ReviewRow[] {
  if (gh === null || repoNames.length === 0) return [];
  // GitHub returns a repo's canonical nameWithOwner; map it back to the
  // configured spelling (case-insensitively) so the row's repo — which keys the
  // dismissal ledger and every consumer — stays exactly what the config wrote.
  const canonical = new Map<string, string>();
  for (const name of repoNames) canonical.set(name.toLowerCase(), name);

  const result = io.exec(gh, ['api', 'graphql', '-f', `query=${reviewSearchQuery(repoNames, reviewLogin)}`]);
  if (result.status !== 0) return [];
  let listed: Obj[];
  try {
    listed = reviewNodesFrom(JSON.parse(result.stdout));
  } catch {
    return [];
  }

  const rows: import('../types.js').ReviewRow[] = [];
  for (const raw of listed) {
    const number = raw['number'];
    if (typeof number !== 'number' || !Number.isInteger(number)) continue;
    const repository = raw['repository'];
    const nameWithOwner =
      isObj(repository) && typeof repository['nameWithOwner'] === 'string'
        ? repository['nameWithOwner']
        : null;
    if (nameWithOwner === null) continue;
    const repo = canonical.get(nameWithOwner.toLowerCase()) ?? nameWithOwner;
    const author = raw['author'];
    const updatedAt = typeof raw['updatedAt'] === 'string' ? raw['updatedAt'] : null;
    let preview = reviewPreviewFromPrevious(options.previousSignals, repo, number);
    let scrapedFor: string | null = null;
    if (preview === '') {
      // Same negative-result skip as the board's open-PR pass: a review with
      // no preview and no change since we last looked is not scraped again.
      const lastScrapedFor = reviewScrapedForFromPrevious(options.previousSignals, repo, number);
      if (updatedAt === null || lastScrapedFor !== updatedAt) {
        preview = scrapePreview(io, gh, repo, number, options.previewPatterns);
        if (preview === '') scrapedFor = updatedAt;
      } else {
        scrapedFor = lastScrapedFor;
      }
    }
    const reviewRow: import('../types.js').ReviewRow = {
      repo,
      number,
      title: typeof raw['title'] === 'string' ? raw['title'] : '',
      url: typeof raw['url'] === 'string' ? raw['url'] : null,
      author: isObj(author) && typeof author['login'] === 'string' ? author['login'] : '?',
      headRefName: typeof raw['headRefName'] === 'string' ? raw['headRefName'] : null,
      baseRefName: typeof raw['baseRefName'] === 'string' ? raw['baseRefName'] : null,
      isDraft: raw['isDraft'] === true,
      updatedAt,
      previewUrl: preview === '' ? null : preview,
    };
    if (reviewRow.previewUrl === null && scrapedFor !== null) {
      reviewRow.previewScrapedFor = scrapedFor;
    }
    rows.push(reviewRow);
  }
  // Newest activity first — the queue's one order, shared by every consumer.
  rows.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return rows;
}
