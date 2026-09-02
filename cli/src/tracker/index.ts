// The tracker seam: one interface over "where does the backlog live and how
// does a ticket key become a link". Three implementations — markdown, linear,
// github-issues — so poll.ts and anything else tracker-shaped select by
// config.tracker.kind instead of growing a per-kind branch of their own.
//
// This module is the markdown logic's TRACKER-FACING surface only: the
// internals (frontmatter parsing, the task directory walk, TASKS.md) stay in
// ops/tasks.ts, and markdownTracker delegates. The link rules deliberately
// mirror cards/build.ts's resolveTicket/ticketChip — an explicit tracker block
// wins, an absent block means Linear built from the workspace slug — so the
// URL a Tracker hands out is the URL the card chip opens.

import { linearTicket } from '../cards/build.js';
import { collectOpenTasks } from '../ops/tasks.js';
import type { BoardConfigFile, PollIo, TrackerTask } from '../types.js';
import { GITHUB_ISSUES_KIND, githubIssuesTracker } from './github-issues.js';
import type { GithubIssuesOptions } from './github-issues.js';

/**
 * One tracker. `kind` is the string board items carry in source.kind and the
 * config carries in tracker.kind; openTasks is the free backlog pass poll.ts
 * writes into signals/tasks.json (synchronous today, Promise allowed so an
 * API-backed tracker does not force an interface change); issueUrl turns one
 * task id into the link its chip opens, or null when there is nothing to link.
 */
export interface Tracker {
  kind: string;
  openTasks(io: PollIo, config: BoardConfigFile): TrackerTask[] | Promise<TrackerTask[]>;
  issueUrl(key: string): string | null;
}

/** `{key}` replaced, or null through — never a half URL. */
function fromTemplate(template: string | null, key: string): string | null {
  return template === null ? null : template.replaceAll('{key}', key);
}

/**
 * The explicit template for one kind: tracker.issueUrl when the config's block
 * names that kind, else null. A block of another kind must not lend its
 * template — a link built from another tracker's template goes somewhere
 * wrong rather than nowhere (ticketChip's rule, kept here).
 */
function configuredTemplate(config: BoardConfigFile, kind: string): string | null {
  const tracker = config.tracker;
  if (tracker == null) return null;
  if ((tracker.kind ?? 'linear') !== kind) return null;
  return tracker.issueUrl ?? null;
}

/**
 * The markdown tracker: task files in the repo, read by ops/tasks.ts. The
 * issueUrl template comes from config alone (board init derives a GitHub blob
 * link when it writes the block), because a task file has no canonical URL of
 * its own.
 */
export function markdownTracker(config: BoardConfigFile): Tracker {
  return {
    kind: 'markdown',
    openTasks(io: PollIo, cfg: BoardConfigFile): TrackerTask[] {
      return collectOpenTasks(cfg, io.env);
    },
    issueUrl(key: string): string | null {
      return fromTemplate(configuredTemplate(config, 'markdown'), key);
    },
  };
}

/**
 * The Linear tracker. openTasks is deliberately empty: a Linear backlog needs
 * an API session, which makes it a scout job — model tokens, not the free
 * tier poll.ts runs on. issueUrl mirrors resolveTicket exactly: an explicit
 * linear block uses its own issueUrl (null and all — the operator wrote the
 * block), and only the absent block derives from operator.linearWorkspace.
 */
export function linearTracker(config: BoardConfigFile): Tracker {
  return {
    kind: 'linear',
    openTasks(): TrackerTask[] {
      return [];
    },
    issueUrl(key: string): string | null {
      const template =
        config.tracker != null
          ? configuredTemplate(config, 'linear')
          : (linearTicket(config.operator?.linearWorkspace ?? '').urlTemplate ?? null);
      return fromTemplate(template, key);
    },
  };
}

export { GITHUB_ISSUES_KIND, githubIssuesTracker };
export type { GithubIssuesOptions };

/**
 * The configured tracker. Absent block and absent kind both mean Linear —
 * what every config written before the block existed means — and an unknown
 * kind gets a tracker that collects nothing and links only through its own
 * template, so a config from a newer CLI degrades to chips without links
 * rather than an error.
 */
export function resolveTracker(
  config: BoardConfigFile,
  options: GithubIssuesOptions = {},
): Tracker {
  const kind = config.tracker?.kind ?? 'linear';
  if (kind === 'markdown') return markdownTracker(config);
  if (kind === GITHUB_ISSUES_KIND) return githubIssuesTracker(config, options);
  if (kind === 'linear') return linearTracker(config);
  return {
    kind,
    openTasks(): TrackerTask[] {
      return [];
    },
    issueUrl(key: string): string | null {
      return fromTemplate(configuredTemplate(config, kind), key);
    },
  };
}
