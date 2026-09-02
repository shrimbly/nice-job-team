// The app-mode assembly above the card chain: every project's snapshot plus the
// one PR list become ProjectCards, ordered by urgency across all of them. Ports
// BoardAssembler and the config derivation of BoardConfig.load (both
// BoardConfig.swift), and Project.swift's ProjectCard construction. GitHub is
// the required half of the board: every open PR gets a card whether or not any
// orchestrator has an item for it — the orchestrator's files are enrichment.
//
// This layer has no jq counterpart: render-board.sh renders one project and
// synthesizes nothing, so what is ported here is the Swift, quirks recorded
// where they were found. The card chain itself stays build.ts's, in app mode.

import type {
  BoardConfigFile,
  BoardItem,
  Card,
  OrchestratorSnapshot,
  PRRef,
  ProjectCard,
  ProjectRef,
  PullRequest,
} from '../types.js';
import { TONE_RANK } from '../types.js';
import type { TicketLink } from './build.js';
import { buildPayload, linearTicket } from './build.js';
import { detectStacks } from './stacks.js';
import type { PRStack } from './stacks.js';

// ── Config ────────────────────────────────────────────────────────────────────

/**
 * What the assembler needs from config.json, already derived. BoardConfig.swift
 * minus the fields only the mac app's poller reads (repos to poll, author
 * filter, preview patterns) — polling is poll.sh's job on this side, and its
 * output is what reaches `assemble` as the PR list.
 */
export interface AssemblerConfig {
  linearWorkspace: string;
  /** Project key → chip label. Falls back to the key via `shortNameFor`. */
  shortNames: Record<string, string>;
  /** Project key → the "owner/name" that project orchestrates. */
  repoNames: Record<string, string>;
  ticket: TicketLink;
}

/**
 * BoardConfig.load, minus the file IO — config.ts's readConfig owns reading
 * and already hands back an empty object for a missing or unparseable file,
 * which derives to the same fallback the Swift returns: no repos, no
 * workspace, a ticket chip that opens nothing.
 */
export function assemblerConfig(file: BoardConfigFile): AssemblerConfig {
  const shortNames: Record<string, string> = {};
  const repoNames: Record<string, string> = {};
  // config.json is hand-owned and readConfig only vets the top level, so the
  // types here are hopes, not facts: `repos` as an object, or a null entry,
  // must cost that entry — Swift fails the whole decode and falls back to the
  // empty config, and the shell's cfg shrugged; the one thing neither did is
  // take the render down.
  const repos = Array.isArray(file.repos) ? file.repos : [];
  for (const repo of repos) {
    if (repo === null || typeof repo !== 'object' || Array.isArray(repo)) continue;
    const name = repo.name;
    if (typeof name !== 'string' || name === '') continue;
    // setup.sh derives the key the same way, so a config written before `key`
    // existed still lines up with its directory under p/. An explicit key
    // wins: a real config held `key: acme-desktop` against a repo the
    // derivation spells differently, and the directory under p/ follows the
    // key — deriving anyway would look in a directory that is not there and
    // show the project as having no work.
    const key = repo.key ?? derivedKey(name);
    shortNames[key] =
      repo.shortName != null && repo.shortName !== '' ? repo.shortName : afterSlash(name);
    repoNames[key] = name;
  }
  const workspace = file.operator?.linearWorkspace ?? '';
  // An explicit tracker block wins. Without one the tracker is Linear, built
  // from the workspace slug — that is what every config written before the
  // block existed means, and re-reading it any other way would drop the
  // ticket links off a board that already had them.
  const tracker = file.tracker;
  const ticket: TicketLink =
    tracker != null
      ? { kind: tracker.kind ?? 'linear', urlTemplate: tracker.issueUrl ?? null }
      : linearTicket(workspace);
  return { linearWorkspace: workspace, shortNames, repoNames, ticket };
}

/**
 * setup.sh's key derivation: `tr '[:upper:]' '[:lower:]' | sed
 * 's#[^a-z0-9]\{1,\}#-#g'`. The split-and-rejoin collapses runs to one dash
 * and trims the ends, matching the Swift port character for character.
 */
export function derivedKey(repoName: string): string {
  const mapped = [...repoName.toLowerCase()]
    .map((ch) => (/[\p{L}\p{N}]/u.test(ch) ? ch : '-'))
    .join('');
  return mapped
    .split('-')
    .filter((part) => part !== '')
    .join('-');
}

/**
 * The chip label for a project. Falls back to the key, so an unconfigured
 * project is still named rather than blank.
 */
export function shortNameFor(config: AssemblerConfig, key: string): string {
  return config.shortNames[key] ?? key;
}

/** Swift's `split(separator: "/")` omits empty subsequences: "a/b" → "b". */
function afterSlash(name: string): string {
  const parts = name.split('/').filter((part) => part !== '');
  return parts.length > 0 ? parts[parts.length - 1]! : name;
}

// ── The assembler ─────────────────────────────────────────────────────────────

/** One project and what its orchestrator directory held. */
export interface ProjectSnapshot {
  project: ProjectRef;
  snapshot: OrchestratorSnapshot;
}

/**
 * Every project's cards in one list, ordered by urgency across all of them.
 *
 * Not grouped by project on purpose. A heading per project would put a draft
 * above a card that needs the operator, because the draft sits under an
 * earlier heading. Urgency is the order that makes the board worth opening,
 * and the chip carries the project instead.
 */
export function assemble(
  projects: ProjectSnapshot[],
  pullRequests: PullRequest[],
  config: AssemblerConfig,
): ProjectCard[] {
  // An item that has not recorded its PR number yet still owns the PR on its
  // branch — sync.sh may not have caught up, and a cloud item has no status
  // file to catch up from. Left unclaimed, that PR got a synthesized card of
  // its own, titled from GitHub: two cards for one piece of work, and the one
  // the operator read carried the wrong title. Adopting the number here lets
  // the item's card claim the PR and carry its facts.
  const adopted = projects.map((entry) => ({
    project: entry.project,
    snapshot: {
      ...entry.snapshot,
      items: adoptingPRsByBranch(entry.snapshot.items, pullRequests),
    },
  }));

  // The PR's own title, for the chip hover on a card the item titles. First
  // row wins a number collision, as in the Swift.
  const prTitleByNumber = new Map<number, string>();
  for (const pr of pullRequests) {
    if (!prTitleByNumber.has(pr.number)) prTitleByNumber.set(pr.number, pr.title);
  }

  // A PR that any project's item claims is that item's card, everywhere.
  // Without this, a PR orchestrated by one project is "unclaimed" as far as
  // the others can see, and each of them invents a card for it.
  const claimedAnywhere = new Set<number>();
  for (const entry of adopted) {
    for (const item of entry.snapshot.items) {
      const num = item.pr?.number;
      if (typeof num === 'number') claimedAnywhere.add(num);
    }
  }
  const landedAnywhere = new Set<number>();
  for (const entry of adopted) {
    for (const num of entry.snapshot.mergedPRNumbers) landedAnywhere.add(num);
  }
  // The claims whose card will actually render. A terminal item's claim still
  // hides its own PR, and a merged item's card is dropped by hasLanded — so a
  // stack keyed on either bottom would fold its follow-ups onto a card that
  // never appears, and they would vanish with it.
  const visiblyClaimed = new Set<number>();
  for (const entry of adopted) {
    for (const item of entry.snapshot.items) {
      const num = item.pr?.number;
      if (typeof num !== 'number') continue;
      if (!isVisible(item) || item.state === 'merged') continue;
      if (landedAnywhere.has(num)) continue;
      visiblyClaimed.add(num);
    }
  }

  // Stacked PRs are one card. Detected once, over the whole list, because a
  // chain does not know about project boundaries and because both halves of
  // the answer come from it: which PRs may be synthesized, and which card each
  // stack belongs to.
  const stacks: readonly PRStack[] = detectStacks(pullRequests, claimedAnywhere, landedAnywhere);
  // The PR whose card the stack is: the item's, when an item claims the one at
  // the bottom, and otherwise the newest — the tip is the work as the operator
  // thinks of it, and it keeps its identity as the stack drains, where naming
  // the bottom would rename the card at every merge.
  const stackByCard = new Map<number, PullRequest[]>();
  // Everything a stack folded in now sits on another card, so nobody may make
  // it a card of its own.
  const folded = new Set<number>();
  for (const stack of stacks) {
    if (stack.members.length <= 1) continue;
    // The bottom keeps the stack only when its claiming item's card will
    // exist. Keying on ANY claim — as BoardConfig.swift still does, a RECORDED
    // DIVERGENCE, see README's deliberate divergences — hands the stack to a
    // card the terminal filter or hasLanded then removes, and every folded PR
    // vanishes with it. Only the bottom can be claimed inside one stack
    // (detectStacks never walks past a claimed PR), so the tip is a fallback
    // that always renders: it is unclaimed, and unclaimed synthesizes.
    const cardNumber = visiblyClaimed.has(stack.bottom.number)
      ? stack.bottom.number
      : stack.tip.number;
    stackByCard.set(cardNumber, stack.members);
    for (const number of stack.numbers) {
      if (number !== cardNumber) folded.add(number);
    }
  }

  // Otherwise a PR belongs to the project that orchestrates its repository,
  // and only that project may synthesize it. A PR whose repository matches no
  // project is given to the first, so an unowned PR still gets a card rather
  // than silently going missing. (The ?? null on both sides keeps the Swift's
  // `nil == nil`: a project with no configured repo owns the PRs that name no
  // repo — input poll.sh does not produce, kept rather than silently changed.)
  const owner = new Map<number, string>();
  for (const pr of pullRequests) {
    if (claimedAnywhere.has(pr.number) || folded.has(pr.number)) continue;
    const match = adopted.find(
      (entry) => (config.repoNames[entry.project.key] ?? null) === (pr.repo ?? null),
    );
    const entry = match ?? adopted[0];
    if (entry !== undefined) owner.set(pr.number, entry.project.key);
  }

  const merged: ProjectCard[] = [];
  for (const entry of adopted) {
    const mine = new Set<number>();
    for (const [num, key] of owner) {
      if (key === entry.project.key) mine.add(num);
    }
    // Where each card's agent runs. Keyed by item id, which is the card's id —
    // a synthesized PR has no item and is local by default, which is right:
    // nobody dispatched it anywhere. First item wins a duplicated id.
    const hostByCard = new Map<string, string>();
    for (const item of entry.snapshot.items) {
      if (!hostByCard.has(item.id)) hostByCard.set(item.id, item.host ?? 'local');
    }
    for (const card of projectCards(entry.snapshot, pullRequests, config, mine)) {
      const members = (card.num !== null ? stackByCard.get(card.num) : undefined) ?? [];
      const prTitle = card.num !== null ? prTitleByNumber.get(card.num) : undefined;
      merged.push({
        project: entry.project,
        shortName: shortNameFor(config, entry.project.key),
        card,
        // A stack of one is stored as no stack at all — the count, not the
        // emptiness, is what the chip reads. stackByCard only holds chains of
        // two or more, but the guard keeps ProjectCard's own invariant local.
        stack: members.length > 1 ? members : [],
        trackerKind: config.ticket.kind,
        host: hostByCard.get(card.id) ?? 'local',
        // Only when it says something the card does not: a synthesized card is
        // already titled from GitHub.
        prTitle:
          prTitle == null || prTitle === '' || prTitle === card.title ? null : prTitle,
        id: `${entry.project.key}:${card.id}`,
      });
    }
  }

  // The same key the card chain sorts by, applied across the joined list. The
  // project key breaks a tie so two boards cannot swap places between reads;
  // the index keeps the sort stable, as Swift's offset does. Keys are the
  // directory names under p/ — ASCII — so code-unit comparison matches Swift.
  return merged
    .map((projectCard, index) => ({ projectCard, index }))
    .sort(
      (l, r) =>
        TONE_RANK[l.projectCard.card.pill.tone] - TONE_RANK[r.projectCard.card.pill.tone] ||
        (r.projectCard.card.num ?? 0) - (l.projectCard.card.num ?? 0) ||
        compareKeys(l.projectCard.project.key, r.projectCard.project.key) ||
        l.index - r.index,
    )
    .map((entry) => entry.projectCard);
}

/**
 * One project's cards — the port of BoardAssembler's single-project overload.
 *
 * A thin delegate, so there is exactly one implementation of the assembly. The
 * last time a second path existed, --dump-cards built its own and reproduced a
 * duplicate-card bug the app no longer had — a diagnostic that takes its own
 * route can only ever describe itself.
 */
export function assembleOne(
  snapshot: OrchestratorSnapshot,
  pullRequests: PullRequest[],
  linearWorkspace: string,
): Card[] {
  return assemble([{ project: { key: '', root: '/' }, snapshot }], pullRequests, {
    linearWorkspace,
    shortNames: {},
    repoNames: {},
    ticket: linearTicket(linearWorkspace),
  }).map((projectCard) => projectCard.card);
}

/**
 * 1 for an ordinary card, so callers do not have to know that a stack of one
 * is stored as no stack at all.
 */
export function prCount(card: ProjectCard): number {
  return Math.max(1, card.stack.length);
}

/** True when the card's agent runs on claude.ai rather than a local workspace. */
export function isCloudCard(card: ProjectCard): boolean {
  return card.host === 'cloud';
}

// ── One project ───────────────────────────────────────────────────────────────

/**
 * One project's cards, through the shared chain in app mode.
 *
 * `synthesizable` is the PR numbers this project may turn into cards of its
 * own; null means "anything unclaimed". Every project is handed the whole PR
 * list so its items still enrich, but only the project that owns the
 * repository may invent a card — otherwise each project synthesizes the
 * others' PRs and every orchestrated PR appears twice, once titled from the
 * item and once from GitHub.
 */
function projectCards(
  snapshot: OrchestratorSnapshot,
  pullRequests: PullRequest[],
  config: AssemblerConfig,
  synthesizable: Set<number> | null,
): Card[] {
  // Every item claims its PR, including the closed and rejected ones. The
  // orchestrator hiding a PR is a decision about that PR, not an absence of
  // one, and re-adding it here would quietly overrule the operator.
  const claimed = new Set<number>();
  for (const item of snapshot.items) {
    const num = item.pr?.number;
    if (typeof num === 'number') claimed.add(num);
  }
  const unclaimed = pullRequests
    .filter((pr) => !claimed.has(pr.number))
    .filter((pr) => synthesizable === null || synthesizable.has(pr.number))
    .sort((a, b) => b.number - a.number)
    .map(synthesizedItem);

  const payload = buildPayload(
    {
      items: [...snapshot.items, ...unclaimed],
      prs: pullRequests,
      agents: snapshot.agents,
      workspaces: snapshot.workspaces,
      linearWorkspace: config.linearWorkspace,
      // Round-trips to exactly config.ticket inside the chain's resolveTicket,
      // so the assembler and the chain agree on one TicketLink.
      tracker: { kind: config.ticket.kind, issueUrl: config.ticket.urlTemplate ?? null },
      // The assembler only reads .cards; recentlyClosed and generatedAt belong
      // to the payload render path, which does not come through here.
      recentCutoff: '',
      generatedAt: '',
    },
    'app',
  );

  return payload.cards.filter((card) => !hasLanded(card, snapshot.mergedPRNumbers));
}

/**
 * An open PR the orchestrator does not know about — because it is not running,
 * or because it has not grouped that PR into an item yet. Built so the pill
 * chain treats it exactly like a board item whose agent is absent.
 */
export function synthesizedItem(pr: PullRequest): BoardItem {
  return {
    id: `pr:${pr.repo ?? '?'}#${pr.number}`,
    title: pr.title,
    state: 'pr-open',
    branch: pr.headRefName ?? null,
    // kind "github" is what keeps the ticket chip off these cards: the
    // externalId is the PR's own number, which already has a chip of its own
    // and is not a ticket.
    source: { kind: 'github', externalId: `#${pr.number}` },
    pr: { number: pr.number, url: pr.url ?? null },
  };
}

/**
 * A merged PR is off the board. It asks nothing of the operator, and this side
 * cannot reap the workspace behind it — that is the orchestrator's job.
 *
 * Both sources have to be checked or the card comes back: poll.sh sees the
 * merge first, then the orchestrator moves the item to "merged", at which
 * point the chain would light it up again as "Merged — reap". Hiding on only
 * one of them makes a landed PR vanish and then reappear.
 */
function hasLanded(card: Card, merged: Set<number>): boolean {
  if (card.boardState === 'merged') return true;
  return card.num !== null && merged.has(card.num);
}

// ── Branch adoption ───────────────────────────────────────────────────────────

/**
 * Fills in pr.number/pr.url on a live item whose branch matches an open PR, so
 * the item claims the PR and the card is titled from the item.
 *
 * Only live items adopt: a recorded number on a terminal item is the
 * orchestrator's decision to hide that PR, but a branch match alone is too
 * weak an inference to hide an open PR with.
 */
function adoptingPRsByBranch(items: BoardItem[], pullRequests: PullRequest[]): BoardItem[] {
  const byBranch = new Map<string, PullRequest[]>();
  for (const pr of pullRequests) {
    if (pr.headRefName == null) continue;
    const list = byBranch.get(pr.headRefName);
    if (list === undefined) byBranch.set(pr.headRefName, [pr]);
    else list.push(pr);
  }
  return items.map((item) => {
    if (!isVisible(item)) return item;
    if (item.pr?.number != null) return item;
    const branch = item.branch;
    if (branch == null) return item;
    const pr = matchAmong(byBranch.get(branch) ?? [], item.repo ?? null);
    if (pr === undefined) return item;
    const ref: PRRef = { ...(item.pr ?? {}) };
    ref.number = pr.number;
    if (ref.url == null) ref.url = pr.url ?? null;
    return { ...item, pr: ref };
  });
}

/**
 * Which of the PRs on a branch name the item may adopt. Two repositories can
 * hold the same branch name, so a repo the item names must agree — and when
 * the name is ambiguous, only an explicit repo match resolves it. Adopting
 * across repositories would pin the wrong PR's facts to the card.
 */
function matchAmong(candidates: PullRequest[], repo: string | null): PullRequest | undefined {
  if (candidates.length === 1) {
    const only = candidates[0]!;
    return repo == null || only.repo == null || only.repo === repo ? only : undefined;
  }
  return candidates.find((candidate) => candidate.repo != null && candidate.repo === repo);
}

/**
 * BoardItem.isVisible: the chain hides the terminal states — closed, rejected,
 * abandoned — and keeps merged visible until the reaper takes them (hasLanded
 * is what takes them off this board first). Mirrors build.ts's TERMINAL_STATES,
 * which the chain keeps private.
 */
function isVisible(item: BoardItem): boolean {
  return item.state !== 'closed' && item.state !== 'rejected' && item.state !== 'abandoned';
}

/** Project keys are ASCII directory names, where code-unit order is order. */
function compareKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
