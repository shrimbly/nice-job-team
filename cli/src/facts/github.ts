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
import type { PollIo, RepoSignalBlock } from '../types.js';
import { firstPreviewMatch } from '../cards/preview.js';

type Obj = Record<string, unknown>;

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

/** poll.sh's --json field list for the two open-PR queries, verbatim. */
export const OPEN_FIELDS =
  'number,title,headRefName,baseRefName,url,isDraft,reviewDecision,reviewRequests,latestReviews,updatedAt,mergeStateStatus,statusCheckRollup';
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
function ghList(io: PollIo, gh: string, args: string[]): Obj[] {
  const result = io.exec(gh, args);
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
export function fetchRepoPRs(
  io: PollIo,
  gh: string | null,
  repo: string,
  authorFilter: string | null,
  reviewLogin: string | null,
): RepoPRs {
  if (gh === null) return { repo, open: [], merged: [], closed: [] };
  const author = authorFilter === null ? [] : ['--author', authorFilter];

  const open = ghList(io, gh, [
    'pr', 'list', '--repo', repo, ...author,
    '--state', 'open', '--limit', '50', '--json', OPEN_FIELDS,
  ]);
  // A null reviewLogin turns the review-requested merge off entirely
  // (operator.includeReviewRequests: false) — the operator wants the board
  // to hold authored work only, so those PRs never even enter signals.
  const review = reviewLogin === null ? [] : ghList(io, gh, [
    'pr', 'list', '--repo', repo, '--search', `review-requested:${reviewLogin}`,
    '--state', 'open', '--limit', '30', '--json', OPEN_FIELDS,
  ]);
  const merged = ghList(io, gh, [
    'pr', 'list', '--repo', repo, ...author,
    '--state', 'merged', '--limit', '20', '--json', MERGED_FIELDS,
  ]);
  const closedAll = ghList(io, gh, [
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

// ── The batched details query ─────────────────────────────────────────────────

/**
 * poll.sh's rich per-PR fragment — reviewThreads with resolution, path, the
 * first comment (who asked, what, when) and the last (who spoke last), plus
 * the trailing 20 reviews — with `number` added so the aliased response can
 * be walked by shape, as GitHubClient.swift walks its.
 */
const PR_FRAGMENT = `fragment prDetails on PullRequest {
  number
  reviewThreads(first: 100) { nodes {
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
    ...pr,
    repo,
    previewUrl: options.preview === '' ? null : options.preview,
    ciState: ciRollup(pr['statusCheckRollup']),
    unresolvedThreads: awaitingUs.length,
    threadsAwaitingReviewer: awaitingReviewer.length,
    unresolvedSample,
    latestActivityAt,
    reviewStates,
  };
  delete row['statusCheckRollup'];
  return row;
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
}

/**
 * The enrichment pass over every repo's fetched lists: one batched GraphQL
 * call for all open PRs, then poll.sh's per-PR derivation. Repos keep their
 * input order; open rows keep theirs (already unique_by-sorted). merged and
 * closed pass through untouched — poll.sh never enriches a PR that is done.
 */
export function enrichPRs(
  io: PollIo,
  gh: string | null,
  repos: RepoPRs[],
  options: EnrichOptions,
): RepoSignalBlock[] {
  const open: { repo: string; number: number }[] = [];
  for (const block of repos) {
    for (const row of block.open) {
      if (typeof row['number'] === 'number' && Number.isInteger(row['number'])) {
        open.push({ repo: block.repo, number: row['number'] });
      }
    }
  }

  let details = new Map<string, Obj>();
  if (gh !== null && open.length > 0) {
    const { query, aliasToRepo } = detailsQuery(open);
    const result = io.exec(gh, ['api', 'graphql', '-f', `query=${query}`]);
    if (result.status === 0) {
      try {
        details = indexDetails(JSON.parse(result.stdout), aliasToRepo);
      } catch {
        // poll.sh's `|| echo '{}'`: enrichment degrades, the lists survive.
      }
    }
  }

  return repos.map((block) => ({
    repo: block.repo,
    open: block.open.map((row) => {
      const number = row['number'];
      const node =
        typeof number === 'number' ? (details.get(`${block.repo}#${number}`) ?? null) : null;
      let preview = '';
      if (typeof number === 'number' && Number.isInteger(number)) {
        preview = previewFromPrevious(options.previousSignals, block.repo, number);
        if (preview === '' && gh !== null) {
          preview = scrapePreview(io, gh, block.repo, number, options.previewPatterns);
        }
      }
      return deriveOpenRow(row, node, block.repo, {
        ourLogins: options.ourLogins,
        preview,
      });
    }),
    merged: block.merged,
    closed: block.closed,
  }));
}

/** For callers that want the whole fetch+enrich in one call per poll. */
export function collectGithub(
  io: PollIo,
  gh: string | null,
  repoNames: string[],
  authorFilter: string | null,
  reviewLogin: string | null,
  options: EnrichOptions,
): RepoSignalBlock[] {
  const fetched = repoNames.map((repo) => fetchRepoPRs(io, gh, repo, authorFilter, reviewLogin));
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

export interface ReviewQueueOptions {
  /** The previous signals/reviews.json, parsed, for previewUrl reuse. */
  previousSignals?: unknown;
  /** config's preview.patterns; null/undefined keeps the default. */
  previewPatterns?: string[] | null;
}

/**
 * The reviews lane: every open PR in the given repos that awaits a review
 * from `reviewLogin` and was NOT written by them — their own PRs are board
 * work already, in the open list. One `gh pr list --search` per repo, the
 * author excluded in the search itself (`-author:` and `review-requested:`
 * both take `@me`), degraded to nothing-per-repo on any failure exactly as
 * the four board queries degrade. Rows come back newest-updated first; the
 * whole queue is re-sorted the same way across repos so the render never has
 * to invent an order.
 */
export function collectReviewRequests(
  io: PollIo,
  gh: string | null,
  repoNames: string[],
  reviewLogin: string,
  options: ReviewQueueOptions = {},
): import('../types.js').ReviewRow[] {
  if (gh === null) return [];
  const rows: import('../types.js').ReviewRow[] = [];
  for (const repo of repoNames) {
    const listed = ghList(io, gh, [
      'pr', 'list', '--repo', repo,
      '--search', `review-requested:${reviewLogin} -author:${reviewLogin}`,
      '--state', 'open', '--limit', '30', '--json', REVIEW_FIELDS,
    ]);
    for (const raw of listed) {
      const number = raw['number'];
      if (typeof number !== 'number' || !Number.isInteger(number)) continue;
      const author = raw['author'];
      let preview = reviewPreviewFromPrevious(options.previousSignals, repo, number);
      if (preview === '') {
        preview = scrapePreview(io, gh, repo, number, options.previewPatterns);
      }
      rows.push({
        repo,
        number,
        title: typeof raw['title'] === 'string' ? raw['title'] : '',
        url: typeof raw['url'] === 'string' ? raw['url'] : null,
        author: isObj(author) && typeof author['login'] === 'string' ? author['login'] : '?',
        headRefName: typeof raw['headRefName'] === 'string' ? raw['headRefName'] : null,
        baseRefName: typeof raw['baseRefName'] === 'string' ? raw['baseRefName'] : null,
        isDraft: raw['isDraft'] === true,
        updatedAt: typeof raw['updatedAt'] === 'string' ? raw['updatedAt'] : null,
        previewUrl: preview === '' ? null : preview,
      });
    }
  }
  // Newest activity first — the queue's one order, shared by every consumer.
  rows.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return rows;
}
