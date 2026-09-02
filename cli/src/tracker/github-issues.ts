// The GitHub Issues tracker adapter — the fresh-install default since P6. The
// backlog is the repo's own open issues, read with the gh CLI the orchestrator
// already requires, so a new install gets a working tracker with no extra
// account and no extra file format.
//
// KIND STRINGS, DECIDED AND DOCUMENTED: this tracker's kind is 'github-issues',
// deliberately NOT 'github'. 'github' is the synthesized-card kind
// (cards/assemble.ts's synthesizedItem) — an unclaimed PR dressed as a board
// item, whose source.externalId is the PR's own "#<number>" and which
// cards/build.ts's ticketChip excludes from ticket links because the PR chip
// already covers it. A 'github-issues' item is a real ticket and DOES get the
// chip and the link, so the two must never share a kind string.
//
// TASK IDS: id = String(number) — the plain digits, no '#'. A board item
// dispatched from this backlog carries source.externalId equal to the task id,
// and the {key} template then renders .../issues/42; a '#' in the id would put
// a '#' in the URL. The '#<number>' spelling stays the synthesized 'github'
// kind's alone.

import { locateGh } from '../facts/github.js';
import type { BoardConfigFile, PollIo, TrackerTask } from '../types.js';
import type { Tracker } from './index.js';

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const GITHUB_ISSUES_KIND = 'github-issues';

/**
 * Which repository's issues are the backlog: the same resolution the markdown
 * tracker uses for its task directory (ops/tasks.ts's resolveTrackerPaths),
 * minus the localPath requirement — SUPERSET_ORCH_REPO overrides, else
 * repos[0].name, else "" (which reads as an empty backlog, never an error).
 */
export function trackerRepoName(
  config: BoardConfigFile,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const repos = Array.isArray(config.repos) ? config.repos : [];
  const first = repos[0];
  let name = isObj(first) && typeof first['name'] === 'string' ? first['name'] : '';
  const override = env['SUPERSET_ORCH_REPO'];
  if (override !== undefined && override !== '') name = override;
  return name;
}

/** The label names that read as priorities, most urgent first. */
const PRIORITY_LABELS = ['urgent', 'high', 'medium', 'low'] as const;

/**
 * An issue's priority is a label named urgent/high/medium/low (matched
 * case-insensitively; gh emits labels as {name,...} objects, but bare strings
 * are taken too). Two priority labels on one issue read as the more urgent.
 * No priority label means 'medium', like a markdown task with no frontmatter.
 */
export function priorityFromLabels(labels: unknown): string {
  const names = new Set<string>();
  if (Array.isArray(labels)) {
    for (const label of labels) {
      if (typeof label === 'string') names.add(label.toLowerCase());
      else if (isObj(label) && typeof label['name'] === 'string') {
        names.add(label['name'].toLowerCase());
      }
    }
  }
  for (const priority of PRIORITY_LABELS) {
    if (names.has(priority)) return priority;
  }
  return 'medium';
}

/** The sort ranks, matching ops/tasks.ts's PRIORITY_RANK. */
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/**
 * The backlog: every open issue in the tracker repo, as TrackerTask rows in
 * exactly the shape ops/tasks.ts feeds signals/tasks.json. Status is 'todo'
 * for all of them — GitHub's open/closed carries no doing/dropped, and a
 * dispatched issue leaves the Backlog section by being on the board, not by a
 * status. path/relPath/body take the string null-equivalent "": the fields are
 * about task FILES, and an issue has none.
 *
 * Sorted by priority rank, then updatedAt (newest first), then number
 * descending — so two polls over an unchanged repo cannot disagree whatever
 * order gh returned. Every failure — no repo configured, no gh, gh nonzero,
 * unparseable output — is silently [] with no warning, the same silent
 * no-backlog the markdown pass shows (ops/tasks.ts's collectOpenTasks).
 */
export function collectGithubIssuesTasks(
  io: PollIo,
  config: BoardConfigFile,
  gh: string | null,
): TrackerTask[] {
  const repo = trackerRepoName(config, io.env);
  if (repo === '' || gh === null) return [];
  const result = io.exec(gh, [
    'issue', 'list',
    '--repo', repo,
    '--state', 'open',
    '--limit', '100',
    '--json', 'number,title,labels,updatedAt',
  ]);
  if (result.status !== 0) return [];
  let rows: unknown;
  try {
    rows = JSON.parse(result.stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];

  const collected: { task: TrackerTask; number: number; updatedAt: string }[] = [];
  for (const row of rows) {
    if (!isObj(row)) continue;
    const number = row['number'];
    if (typeof number !== 'number' || !Number.isFinite(number)) continue;
    const title = typeof row['title'] === 'string' && row['title'] !== '' ? row['title'] : String(number);
    collected.push({
      task: {
        id: String(number),
        title,
        status: 'todo',
        priority: priorityFromLabels(row['labels']),
        path: '',
        relPath: '',
        body: '',
      },
      number,
      updatedAt: typeof row['updatedAt'] === 'string' ? row['updatedAt'] : '',
    });
  }
  collected.sort((a, b) => {
    const p = (PRIORITY_RANK[a.task.priority] ?? 2) - (PRIORITY_RANK[b.task.priority] ?? 2);
    if (p !== 0) return p;
    // ISO-8601 UTC strings compare as times; newest activity first.
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    return b.number - a.number;
  });
  return collected.map((entry) => entry.task);
}

/** The canonical issue URL for one key, or null when no repo is configured. */
export function githubIssueUrl(config: BoardConfigFile, key: string, env?: NodeJS.ProcessEnv): string | null {
  const repo = trackerRepoName(config, env);
  return repo === '' ? null : `https://github.com/${repo}/issues/${key}`;
}

export interface GithubIssuesOptions {
  /** Bypass locateGh — tests pin a stub path; null means "no gh anywhere". */
  ghPath?: string | null;
  /** For trackerRepoName's SUPERSET_ORCH_REPO override in issueUrl. */
  env?: NodeJS.ProcessEnv;
}

/**
 * The Tracker over the adapter. issueUrl honours an explicit
 * tracker.issueUrl template first — that is the template the card chain links
 * with (cards/build.ts's ticketChip), and the two must agree — and derives the
 * canonical https://github.com/<repo>/issues/<key> when the config has none.
 */
export function githubIssuesTracker(
  config: BoardConfigFile,
  options: GithubIssuesOptions = {},
): Tracker {
  return {
    kind: GITHUB_ISSUES_KIND,
    openTasks(io: PollIo, cfg: BoardConfigFile): TrackerTask[] {
      const gh = options.ghPath !== undefined ? options.ghPath : locateGh(io);
      return collectGithubIssuesTasks(io, cfg, gh);
    },
    issueUrl(key: string): string | null {
      const tracker = config.tracker;
      const template =
        tracker != null && tracker.kind === GITHUB_ISSUES_KIND ? (tracker.issueUrl ?? null) : null;
      if (template !== null) return template.replaceAll('{key}', key);
      return githubIssueUrl(config, key, options.env);
    },
  };
}
