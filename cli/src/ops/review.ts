// `board review` — the reviews lane. PRs other people wrote that await the
// operator's review are queue work, not board work: no item, no state machine,
// no reconcile. The lane is signals/reviews.json (poll writes it per project),
// a dismissal ledger at the orchestrator root, and `start`, which turns one
// queued PR into a Superset workspace running a review agent.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assemblerConfig } from '../cards/assemble.js';
import { cfg, discoverProjects, loadConfig, loadRoot } from '../config.js';
import { supersetCommand, authed } from '../facts/superset.js';
import { atomicWriteJson } from '../store.js';
import type {
  BoardConfigFile,
  CloudIo,
  DismissedReview,
  DismissedReviewsDoc,
  OrchRoot,
  ProjectRef,
  ReviewRow,
} from '../types.js';
import { listLocalWorkspacesStrict, shellQuote } from './dispatch.js';
import { realCloudIo } from './cloud.js';

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** jq's `//`: null AND false fall through; "" and 0 are kept. */
function jqAlt(value: unknown): unknown {
  return value === undefined || value === null || value === false ? undefined : value;
}

// ── The queue on disk ─────────────────────────────────────────────────────────

/** signals/reviews.json for one project, read tolerantly: [] on any failure. */
export function readReviewsSignals(projectRoot: string): ReviewRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(projectRoot, 'signals', 'reviews.json'), 'utf8'));
  } catch {
    return [];
  }
  if (!isObj(parsed) || !Array.isArray(parsed['reviews'])) return [];
  const rows: ReviewRow[] = [];
  for (const raw of parsed['reviews']) {
    if (!isObj(raw)) continue;
    const repo = raw['repo'];
    const number = raw['number'];
    if (typeof repo !== 'string' || typeof number !== 'number' || !Number.isInteger(number)) {
      continue;
    }
    rows.push({
      repo,
      number,
      title: typeof raw['title'] === 'string' ? raw['title'] : '',
      url: typeof raw['url'] === 'string' ? raw['url'] : null,
      author: typeof raw['author'] === 'string' ? raw['author'] : '?',
      headRefName: typeof raw['headRefName'] === 'string' ? raw['headRefName'] : null,
      baseRefName: typeof raw['baseRefName'] === 'string' ? raw['baseRefName'] : null,
      isDraft: raw['isDraft'] === true,
      updatedAt: typeof raw['updatedAt'] === 'string' ? raw['updatedAt'] : null,
      previewUrl: typeof raw['previewUrl'] === 'string' ? raw['previewUrl'] : null,
    });
  }
  return rows;
}

export function reviewKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

// ── The dismissal ledger ──────────────────────────────────────────────────────
// One file at the orchestrator root, not per project: a dismissal is about the
// PR, and every project's poll sees the same globally-configured repos — a
// per-project ledger would make the same PR dismissable twice and dismissed
// once.

export function dismissedFile(orch: OrchRoot): string {
  return join(orch.root, 'reviews-dismissed.json');
}

/** The ledger, read tolerantly: an empty ledger on any failure. */
export function readDismissed(orch: OrchRoot): DismissedReview[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(dismissedFile(orch), 'utf8'));
  } catch {
    return [];
  }
  if (!isObj(parsed) || !Array.isArray(parsed['dismissed'])) return [];
  const rows: DismissedReview[] = [];
  for (const raw of parsed['dismissed']) {
    if (!isObj(raw)) continue;
    const repo = raw['repo'];
    const number = raw['number'];
    if (typeof repo !== 'string' || typeof number !== 'number') continue;
    rows.push({
      repo,
      number,
      title: typeof raw['title'] === 'string' ? raw['title'] : '',
      dismissedAt: typeof raw['dismissedAt'] === 'string' ? raw['dismissedAt'] : '',
    });
  }
  return rows;
}

function writeDismissed(orch: OrchRoot, dismissed: DismissedReview[]): void {
  const doc: DismissedReviewsDoc = { version: 1, dismissed };
  atomicWriteJson(dismissedFile(orch), doc);
}

// ── The effective queue ───────────────────────────────────────────────────────

/**
 * Every project's signals joined into one queue: deduped by (repo, number) —
 * each project's poll writes the same repos, so a plain concatenation holds
 * each PR once per project — minus the ledger, newest activity first. The
 * signals still hold dismissed PRs (poll never reads the ledger); only this
 * subtraction hides them, which is what makes undismiss instant.
 */
export function effectiveQueue(
  orch: OrchRoot,
  projects: ProjectRef[],
): { rows: ReviewRow[]; signalsPresent: boolean } {
  const dismissed = new Set(readDismissed(orch).map((d) => reviewKey(d.repo, d.number)));
  const seen = new Set<string>();
  const rows: ReviewRow[] = [];
  let signalsPresent = false;
  for (const project of projects) {
    if (existsSync(join(project.root, 'signals', 'reviews.json'))) signalsPresent = true;
    for (const row of readReviewsSignals(project.root)) {
      const key = reviewKey(row.repo, row.number);
      if (seen.has(key) || dismissed.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  rows.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return { rows, signalsPresent };
}

// ── start ─────────────────────────────────────────────────────────────────────

/**
 * The default review prompt. The agent reviews under the operator's gh auth,
 * so its verdicts read as the operator's: approving a healthy PR is wanted
 * (that is the review getting done), but a "changes requested" block is a
 * standing veto only the operator should place — concerns go in comments and
 * the PR stays approvable by a human.
 */
export const DEFAULT_REVIEW_PROMPT =
  'You are reviewing a pull request you did not write: {url} — "{title}" by {author}.\n' +
  'The PR branch {branch} (into {base}) is checked out in this workspace.\n' +
  'Read the full diff commit by commit, run the tests the change touches, and verify the\n' +
  'change does what the PR claims. Leave your findings as comments on the PR itself\n' +
  '(gh pr review / gh pr comment), specific, citing files and lines.\n' +
  'If the change is in a good state — it does what it claims, the tests pass, and you\n' +
  'found nothing that must change — approve it (gh pr review --approve), summarising\n' +
  'what you checked. NEVER use --request-changes: raise concerns as comments and leave\n' +
  'the verdict open — a block is the operator\'s call, not yours.\n' +
  'Never push to this branch and never merge.';

/** {url} {repo} {number} {title} {author} {branch} {base}, every occurrence. */
export function fillPrompt(template: string, row: ReviewRow, base: string): string {
  const values: Record<string, string> = {
    url: row.url ?? '',
    repo: row.repo,
    number: String(row.number),
    title: row.title,
    author: row.author,
    branch: row.headRefName ?? '',
    base,
  };
  return template.replace(/\{(url|repo|number|title|author|branch|base)\}/g, (_, key: string) => values[key]!);
}

/** lib.sh's repo_cfg reading, one field for one repo — see dispatch.ts's twin. */
function repoField(config: BoardConfigFile, repo: string, field: string): string {
  const repos = Array.isArray(config.repos) ? config.repos : [];
  for (const entry of repos) {
    if (!isObj(entry) || entry['name'] !== repo) continue;
    const value = jqAlt(entry[field]);
    if (value !== undefined && typeof value === 'string' && value !== '') return value;
  }
  return '';
}

export interface StartResult {
  lines: string[];
  json: Obj | null;
}

export function startReview(
  orch: OrchRoot,
  config: BoardConfigFile,
  row: ReviewRow,
  io: CloudIo,
  opts: { dryRun?: boolean } = {},
): StartResult {
  if (row.headRefName === null || row.headRefName === '') {
    throw new Error(`the queue has no branch recorded for ${reviewKey(row.repo, row.number)} — board poll and retry`);
  }
  const project = repoField(config, row.repo, 'supersetProjectId');
  if (project === '') {
    throw new Error(
      `no supersetProjectId for ${row.repo} in config.json (superset projects list --local --json)`,
    );
  }
  const base = row.baseRefName ?? (repoField(config, row.repo, 'defaultBase') || 'main');
  const template = String(cfg<string>(config, '.review.prompt', DEFAULT_REVIEW_PROMPT));
  const prompt = fillPrompt(template, row, base);
  const agent = String(cfg<string>(config, '.superset.agent', 'claude'));
  const slug = `review-${row.number}`;

  // One branch = one workspace, same guard as dispatch: a review agent and an
  // implementation agent sharing a checkout would trip over each other.
  if (!opts.dryRun && authed(io)) {
    const dupeRow = listLocalWorkspacesStrict(io).find(
      (ws) => isObj(ws) && ws['branch'] === row.headRefName,
    );
    if (dupeRow !== undefined) {
      const dupe = String(jqAlt((dupeRow as Obj)['id']) ?? '?');
      throw new Error(
        `workspace ${dupe} is already on branch ${row.headRefName} — open it instead: superset://v2-workspace/${dupe}`,
      );
    }
  }

  const args = [
    'workspaces', 'create', '--local',
    '--project', project,
    '--name', slug,
    '--branch', row.headRefName,
    '--base-branch', base,
    '--agent', agent,
    '--prompt', prompt,
  ];
  if (opts.dryRun === true) {
    return { lines: [`superset ${args.map(shellQuote).join(' ')} --json`], json: null };
  }

  if (!authed(io)) throw new Error('not logged in — superset auth login');
  const { cmd, env } = supersetCommand(io);
  const create = io.exec(cmd, [...args, '--json'], { env });
  if (create.status !== 0) throw new Error('workspace create failed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(create.stdout);
  } catch {
    parsed = undefined;
  }
  const record = isObj(parsed) ? parsed : {};
  const workspace = isObj(record['workspace']) ? record['workspace'] : {};
  const wsid = String(
    jqAlt(workspace['id']) ?? jqAlt(record['id']) ?? jqAlt(record['workspaceId']) ?? '',
  );
  if (wsid === '') {
    throw new Error('could not read a workspace id from the response');
  }
  const url = `superset://v2-workspace/${wsid}`;
  return {
    lines: [
      `review workspace ready for ${reviewKey(row.repo, row.number)}`,
      `  workspace ${wsid}`,
      `  open      ${url}`,
      '  note      untracked on purpose — reviews are not board items. Delete the',
      `            workspace when the review lands: superset workspaces delete ${wsid}`,
    ],
    json: { workspaceId: wsid, workspaceUrl: url, repo: row.repo, number: row.number },
  };
}

// ── argv surface ──────────────────────────────────────────────────────────────

function die(message: string): never {
  process.stderr.write(`BLOCKED: ${message}\n`);
  process.exit(1);
}

/** "owner/name#123" → {repo, number}; anything else dies. */
function parseRef(value: string | undefined): { repo: string; number: number } {
  const match = value === undefined ? null : /^(\S+\/\S+)#(\d+)$/.exec(value);
  if (match === null) die(`expected owner/name#number, got '${value ?? ''}'`);
  return { repo: match[1]!, number: Number(match[2]!) };
}

export async function runReview(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const orch = loadRoot();
  const loaded = loadConfig(orch);
  if (loaded.deprecationNote !== undefined) {
    process.stderr.write(`note: ${loaded.deprecationNote}\n`);
  }
  const config = loaded.config;
  const projects = discoverProjects(orch);

  switch (sub) {
    case undefined:
    case 'list': {
      const wantDismissed = rest.includes('--dismissed');
      const asJson = rest.includes('--json');
      if (wantDismissed) {
        const dismissed = readDismissed(orch);
        if (asJson) {
          process.stdout.write(JSON.stringify(dismissed, null, 2) + '\n');
          return;
        }
        if (dismissed.length === 0) {
          console.log('nothing dismissed.');
          return;
        }
        for (const d of dismissed) {
          console.log(`${reviewKey(d.repo, d.number)}  dismissed ${d.dismissedAt}  ${d.title}`);
        }
        return;
      }
      const { rows } = effectiveQueue(orch, projects);
      if (asJson) {
        process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
        return;
      }
      if (rows.length === 0) {
        console.log('no PRs waiting on your review.');
        return;
      }
      for (const row of rows) {
        const draft = row.isDraft ? ' [draft]' : '';
        console.log(`${reviewKey(row.repo, row.number)}  ${row.author}${draft}  ${row.title}`);
      }
      return;
    }
    case 'dismiss': {
      const ref = parseRef(rest[0]);
      const key = reviewKey(ref.repo, ref.number);
      const dismissed = readDismissed(orch);
      if (dismissed.some((d) => reviewKey(d.repo, d.number) === key)) {
        console.log(`${key} is already dismissed.`);
        return;
      }
      // The title from the queue, when the queue still has it — the ledger
      // should read without GitHub.
      const { rows } = effectiveQueue(orch, projects);
      const row = rows.find((r) => reviewKey(r.repo, r.number) === key);
      dismissed.push({
        repo: ref.repo,
        number: ref.number,
        title: row?.title ?? '',
        dismissedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      });
      writeDismissed(orch, dismissed);
      console.log(`dismissed ${key} — it will not appear on the board again (board review undismiss ${key} reverses this).`);
      return;
    }
    case 'undismiss': {
      const ref = parseRef(rest[0]);
      const key = reviewKey(ref.repo, ref.number);
      const dismissed = readDismissed(orch);
      const kept = dismissed.filter((d) => reviewKey(d.repo, d.number) !== key);
      if (kept.length === dismissed.length) {
        die(`${key} is not in the dismissed ledger (board review list --dismissed)`);
      }
      writeDismissed(orch, kept);
      console.log(`undismissed ${key}.`);
      return;
    }
    case 'start': {
      const ref = parseRef(rest.find((a) => !a.startsWith('--')));
      const dryRun = rest.includes('--dry-run');
      const asJson = rest.includes('--json');
      const key = reviewKey(ref.repo, ref.number);
      // The raw signals, ledger not subtracted: starting a review of a PR you
      // dismissed is a change of mind, not an error.
      const seen = new Set<string>();
      let row: ReviewRow | undefined;
      for (const project of projects) {
        for (const r of readReviewsSignals(project.root)) {
          const k = reviewKey(r.repo, r.number);
          if (seen.has(k)) continue;
          seen.add(k);
          if (k === key) row = r;
        }
      }
      if (row === undefined) {
        die(`${key} is not in the review queue — board poll first, then board review list`);
      }
      try {
        const result = startReview(orch, config, row, realCloudIo(), { dryRun });
        if (asJson && result.json !== null) {
          process.stdout.write(JSON.stringify(result.json, null, 2) + '\n');
        } else {
          for (const line of result.lines) console.log(line);
        }
      } catch (err) {
        die(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    default:
      die(`unknown review verb: ${sub} (list | dismiss | undismiss | start)`);
  }
}
