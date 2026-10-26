// cards.json v2 — the machine-readable board. Version 1 was BoardKit's
// --dump-cards shape: a bare {cards} with no room for a second project, so the
// desktop app and the platform board could not share one file. v2 wraps cards
// in a projects array unconditionally — one project is a projects array of one
// — so a consumer written against a single-project board keeps working the day
// a second project appears.
//
// The card entries are the app-mode assembly (assemble()), not the reference
// jq: this file exists for consumers that want the model, and the model is the
// app's — declared divergences applied, stacks folded, unclaimed PRs
// synthesized. Each entry is the reference chain's 27 keys, the app-mode
// `previewPending`, and the three things only the assembly knows: host,
// prTitle, and the folded stack.

import type { AssemblerConfig } from '../cards/assemble.js';
import { shortNameFor } from '../cards/assemble.js';
import type { ProjectCard, ProjectRef, PullRequest, ReviewRow } from '../types.js';
import { CARD_KEYS } from '../types.js';

/**
 * One folded-in PR, reduced to what a chip or a hover needs. Deliberately not
 * the whole PullRequest: the signal rows carry per-poll noise (thread counts,
 * activity timestamps) that would churn this file on every cycle without
 * telling a consumer anything the card does not already say.
 */
function stackEntry(pr: PullRequest): Record<string, unknown> {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url ?? null,
    previewUrl: pr.previewUrl ?? null,
    // Card.draft defaults false the same way; null would force every consumer
    // to re-invent the jq's `// false`.
    isDraft: pr.isDraft ?? false,
  };
}

function cardEntry(projectCard: ProjectCard): Record<string, unknown> {
  // Built key-by-key from CARD_KEYS rather than spread, so this file's key
  // order is pinned to the same contract the golden tests enforce — a Card
  // built out of order upstream would still serialize in order here.
  const entry: Record<string, unknown> = {};
  for (const key of CARD_KEYS) entry[key] = projectCard.card[key];
  // The app-mode key the reference chain does not carry — see Card.
  entry['previewPending'] = projectCard.card.previewPending ?? false;
  entry['host'] = projectCard.host;
  entry['prTitle'] = projectCard.prTitle;
  entry['stack'] = projectCard.stack.map(stackEntry);
  return entry;
}

/**
 * The v2 document. `projects` is the given list in the given order — a project
 * with no cards still appears, because "this board is empty" and "this board
 * is not in the file" must not read the same. Cards keep the assembled order,
 * which is urgency across all projects, so a consumer that flattens the
 * projects back together can re-sort by nothing and still be right per
 * project.
 *
 * The same function renders both audiences of the shape: each project
 * directory's cards.json (that one project in a projects array of one) and
 * the merged root-level $SUPERSET_ORCH_ROOT/cards.json a thin client reads
 * (every discovered project, cards from the multi-project assembly).
 */
/**
 * One review-queue row as the document carries it: what a row on the Reviews
 * tab needs and nothing the tab does not read. The branch names stay in
 * signals — `board review start` reads those, never this file.
 */
function reviewEntry(row: ReviewRow): Record<string, unknown> {
  return {
    repo: row.repo,
    number: row.number,
    title: row.title,
    url: row.url,
    author: row.author,
    isDraft: row.isDraft,
    updatedAt: row.updatedAt,
    previewUrl: row.previewUrl,
  };
}

export function renderCardsJson(
  projects: ProjectRef[],
  cards: ProjectCard[],
  config: AssemblerConfig,
  generatedAt: string,
  note: string | null = null,
  reviews: ReviewRow[] = [],
  reviewsCountAsNeedsYou = false,
): string {
  const doc = {
    version: 2,
    generatedAt,
    // The human-facing degradation annotation ("gh pr list for o/r failed") —
    // `board refresh` fills it when a poll degraded mid-run. Null on a clean
    // render, and present from day one so consumers never learn to treat the
    // key as optional.
    note,
    // Whether pending reviews should join the client's alert (menu-bar tint)
    // the way Needs-you cards do — config's review.countsAsNeedsYou, carried
    // here so thin clients never read config.
    reviewsCountAsNeedsYou,
    projects: projects.map((project) => ({
      key: project.key,
      shortName: shortNameFor(config, project.key),
      trackerKind: config.ticket.kind,
      cards: cards
        .filter((projectCard) => projectCard.project.key === project.key)
        .map(cardEntry),
      // The review queue, already deduped and ledger-subtracted by the
      // caller, grouped the way cards are: each row lands under the project
      // that orchestrates its repo. A repo no listed project orchestrates
      // drops out — exactly what happens to its cards. Present from day one
      // (an old document simply lacks the key), so "queue is clear" and
      // "this CLI predates reviews" never read the same.
      reviews: reviews
        .filter((row) => config.repoNames[project.key] === row.repo)
        .map(reviewEntry),
    })),
  };
  return JSON.stringify(doc, null, 2) + '\n';
}
