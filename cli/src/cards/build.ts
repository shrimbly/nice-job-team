// The card chain: board items + PR rows + agent statuses become the payload the
// board renders. This is the one implementation of the model, replacing both
// render-board.sh's jq and BoardKit's CardBuilder — so it carries both rule
// sets, selected by mode:
//
// - 'reference' is the jq, byte for byte: same fields in the same order, same
//   labels and lines, same sort, quirks included. The golden test diffs its
//   output against JSON the jq itself produced over frozen fixtures.
// - 'app' additionally applies CardBuilder.Divergence — the two places the app
//   knowingly disagrees, both about the reference calling a PR ready when it is
//   not — plus the app's briefer wordings and its shortened state labels. Every
//   other branch is shared code, so a disagreement that is not declared here
//   cannot exist.
//
// The chains are transcriptions, not redesigns: change the reference first.
// (The jq's comments avoid apostrophes because they sit inside a single-quoted
// bash string; the ones carried over here get their apostrophes back.)

import type {
  AgentStatus,
  BoardItem,
  Card,
  CardMode,
  CardsPayload,
  HistoryEntry,
  Pill,
  PullRequest,
  RecentlyClosedRow,
  WorkspaceRef,
} from '../types.js';
import { TONE_RANK } from '../types.js';

/**
 * How a ticket key becomes a link, per BoardConfig.swift. One tracker per
 * board; `kind` is matched against the item's `source.kind`, and a null
 * template means the chip shows the key and opens nothing. App mode only — the
 * reference jq predates configurable trackers and knows exactly one.
 */
export interface TicketLink {
  kind: string;
  /** `{key}` is replaced by the ticket key. */
  urlTemplate?: string | null;
}

/** BoardKit's `.linear(workspace:)`: no workspace, no link — never a half URL. */
export function linearTicket(workspace: string): TicketLink {
  return {
    kind: 'linear',
    urlTemplate: workspace === '' ? null : `https://linear.app/${workspace}/issue/{key}`,
  };
}

/**
 * Everything the jq program was handed: the four data files (already decoded by
 * read.ts) plus the four `--arg`s render-board.sh computes around it.
 */
export interface BuildInputs {
  items: BoardItem[];
  /** Open PRs only — the jq indexes `(.open // [])[]` and nothing else. */
  prs: PullRequest[];
  agents: AgentStatus[];
  workspaces: WorkspaceRef[];
  /** `--arg linearWs`: cfg `.operator.linearWorkspace`, "acme" by default. */
  linearWorkspace: string;
  /**
   * config.json's tracker block, when the operator has one. Only app mode reads
   * it; the reference links linear and nothing else.
   */
  tracker?: { kind?: string | null; issueUrl?: string | null } | null;
  /**
   * `--arg recentCutoff`, ISO-8601 UTC. Terminal items whose last transition is
   * younger render one line under "Recently closed"; archive.sh moves the older
   * ones off the board entirely.
   */
  recentCutoff: string;
  /** `--arg generatedAt`: passed through, never computed here. */
  generatedAt: string;
}

/**
 * jq's `//` for one hop: the RHS when the LHS is null, absent, or false —
 * empty string and 0 are values and are kept. The false-skip is why a board
 * item that remembers a draft keeps that memory even when GitHub says
 * otherwise.
 */
function orElse<T, F>(
  value: T | null | undefined | false,
  fallback: F,
): Exclude<T, null | undefined | false> | F {
  return value === null || value === undefined || value === false
    ? fallback
    : (value as Exclude<T, null | undefined | false>);
}

/** Terminal states leave the cards; the recent ones get one line each below. */
const TERMINAL_STATES = new Set(['closed', 'rejected', 'abandoned']);

export function buildPayload(inputs: BuildInputs, mode: CardMode): CardsPayload {
  // Indexed by number across every repo, exactly as the reference does — two
  // repos sharing a PR number would collide, and the orchestrator only ever
  // configures one. jq's INDEX assigns in order, so the LAST row wins a
  // collision; the Swift port kept the first, but nothing legitimate produces
  // one, so the jq's answer is the answer.
  const prByNumber = new Map<string, PullRequest>();
  for (const pr of inputs.prs) prByNumber.set(String(pr.number), pr);

  // jq's INDEX tostrings its key, so a status file whose workspaceId is null
  // files under the string "null" — which no real item carries, so it matches
  // nothing. Kept, rather than dropped, because that is what the jq does.
  const agentByWorkspace = new Map<string, AgentStatus>();
  for (const agent of inputs.agents) {
    const key =
      typeof agent.workspaceId === 'string'
        ? agent.workspaceId
        : JSON.stringify(agent.workspaceId ?? null);
    agentByWorkspace.set(key, agent);
  }

  const workspaceById = new Map<string, WorkspaceRef>();
  for (const workspace of inputs.workspaces) workspaceById.set(workspace.id, workspace);

  const ticket = resolveTicket(inputs);

  const cards = inputs.items
    // Merged stays visible until its workspace is reaped.
    .filter((item) => !TERMINAL_STATES.has(item.state))
    .map((item) => {
      // `$prs[($it.pr.number // 0 | tostring)] // {}`: no number looks up "0",
      // which no PR holds, and the miss reads as "no live row".
      const pr = prByNumber.get(String(orElse(item.pr?.number, 0)));
      const agent = agentByWorkspace.get(orElse(item.workspaceId, ''));
      const flagged = orElse(agent?.needsOperator, false);
      // Divergence.needsYouIsAQuestionOrABlock: the status verbs raise
      // needsOperator for every agent that reaches the routine approval gate,
      // so half a healthy board sat at the top shouting "Needs you" while
      // genuinely stuck agents drowned in it. In app mode the flag only
      // becomes the operator's problem when the agent is blocked or has an
      // unanswered question — an agent that is merely waiting at the gate
      // renders by its item state ("At gate") or its PR, and sorts like the
      // waiting it is. The reference chain keeps the raw flag.
      const needs =
        mode === 'app'
          ? flagged &&
            (agent?.state === 'blocked' ||
              (Array.isArray(agent?.questions) && agent.questions.length > 0))
          : flagged;
      return buildCard(mode, inputs, ticket, item, pr, agent, needs, workspaceById);
    });

  // jq's sort_by is stable; the explicit index keeps that property here. The
  // tuple is (tone rank, -num): who it waits on first, newest PR first inside.
  const ranked = cards.map((card, index) => ({ card, index }));
  ranked.sort(
    (l, r) =>
      TONE_RANK[l.card.pill.tone] - TONE_RANK[r.card.pill.tone] ||
      orElse(r.card.num, 0) - orElse(l.card.num, 0) ||
      l.index - r.index,
  );

  // Key order is the contract, in the payload as in the cards.
  return {
    generatedAt: inputs.generatedAt,
    recentlyClosed: recentlyClosed(inputs.items, inputs.recentCutoff),
    cards: ranked.map((entry) => entry.card),
  };
}

/**
 * One line per terminal item younger than the cutoff. "Gone from open" is for a
 * live item whose PR state is genuinely unknown, never for finished work.
 */
function recentlyClosed(items: BoardItem[], recentCutoff: string): RecentlyClosedRow[] {
  const rows: RecentlyClosedRow[] = [];
  for (const item of items) {
    if (!TERMINAL_STATES.has(item.state)) continue;
    const history: HistoryEntry[] = orElse(item.history, []);
    // When it closed: the last transition INTO a terminal state, else the last
    // transition at all, else "" — an undated item is kept whatever the cutoff,
    // because dropping it would silently lose work that did finish.
    const terminal = history.filter((entry) => TERMINAL_STATES.has(orElse(entry.to, '')));
    const lastTerminalAt = terminal.length > 0 ? terminal[terminal.length - 1]!.at : undefined;
    const lastAt = history.length > 0 ? history[history.length - 1]!.at : undefined;
    const when = orElse(lastTerminalAt, orElse(lastAt, ''));
    // read.ts admits any object as a history entry, so `at` can carry any type.
    // A non-string is skipped: for a scalar that IS the jq's answer (numbers
    // and booleans sort below every string in jq's total order, so
    // `$when >= $recentCutoff` is false and the row is excluded), and for an
    // array or object — which jq sorts ABOVE strings and kept — the jq's own
    // board.md render then crashed slicing it, so exclusion is strictly better
    // than parity: one undated row must never cost the board.
    if (typeof when !== 'string') continue;
    // ISO-8601 UTC strings compare as times via plain string comparison.
    if (when !== '' && when < recentCutoff) continue;
    rows.push({
      title: item.title,
      state: item.state,
      num: orElse(item.pr?.number, null),
      at: when === '' ? null : when,
    });
  }
  // The jq sorts ascending by date and then reverses — which also reverses ties
  // (undated rows among them), because reverse flips what the stable sort kept.
  // Sorted then reversed here too, so the tie order matches.
  const indexed = rows.map((row, index) => ({ row, index }));
  indexed.sort((l, r) => {
    const a = orElse(l.row.at, '');
    const b = orElse(r.row.at, '');
    if (a < b) return -1;
    if (a > b) return 1;
    return l.index - r.index;
  });
  return indexed.map((entry) => entry.row).reverse();
}

function buildCard(
  mode: CardMode,
  inputs: BuildInputs,
  ticket: TicketLink,
  item: BoardItem,
  pr: PullRequest | undefined,
  agent: AgentStatus | undefined,
  needs: boolean,
  workspaceById: Map<string, WorkspaceRef>,
): Card {
  const { ticketKey, ticketUrl } = ticketChip(mode, inputs, ticket, item);

  // Field for field the object the jq builds, in CARD_KEYS order — jq -n and
  // JSON.stringify both emit keys in construction order, and the order is part
  // of the byte-parity contract.
  const card: Card = {
    id: item.id,
    num: orElse(item.pr?.number, null),
    title: item.title,
    branch: orElse(item.branch, orElse(pr?.headRefName, '')),
    // Which Superset workspace holds this work — the operator instructs the
    // agent in that chat, so the name and a deep link to it are navigation.
    workspace: orElse(workspaceById.get(orElse(item.workspaceId, ''))?.name, null),
    workspaceId: orElse(item.workspaceId, null),
    workspaceUrl: workspaceUrl(item),
    boardState: item.state,
    prUrl: orElse(item.pr?.url, orElse(pr?.url, null)),
    ticketKey,
    ticketUrl,
    previewUrl: orElse(pr?.previewUrl, null),
    // "" is a value and is kept: a repo with no review requirement reports an
    // empty reviewDecision, and the pill chain depends on that.
    review: orElse(pr?.reviewDecision, orElse(item.pr?.reviewDecision, null)),
    // NB: read.ts already defaulted a rowless ciState to "unknown" (as the
    // Swift decoder did), so an open row missing the field never falls through
    // to the item's memory the way raw jq would let it. poll.sh always writes
    // the field, so the difference has no input to show on.
    ci: orElse(pr?.ciState, orElse(item.pr?.ciState, 'unknown')),
    threads: orElse(pr?.unresolvedThreads, 0),
    // jq's `//` skips false as well as null, so a board item that remembers a
    // draft keeps that memory even when GitHub says otherwise.
    draft: orElse(pr?.isDraft, orElse(item.pr?.isDraft, false)),
    mergeState: orElse(pr?.mergeStateStatus, orElse(item.pr?.mergeStateStatus, null)),
    needsOperator: needs,
    agentState: orElse(agent?.state, null),
    agentPhase: orElse(agent?.phase, null),
    agentSummary: orElse(agent?.summary, null),
    liveness: orElse(agent?.sessionLiveness, null),
    dirty: orElse(agent?.dirtyFiles, null),
    unpushed: orElse(agent?.unpushedCommits, null),
    whatItIs: orElse(item.outcome, '') !== '' ? (item.outcome as string) : item.title,
    pill: pill(mode, item, pr, agent, needs),
    whereItsAt: whereItsAt(mode, item, pr, agent),
  };
  // The one key app mode appends, after the jq's 27 — see Card's doc comment.
  // The signal row computed it from the same rollup the ciState came from.
  if (mode === 'app') card.previewPending = orElse(pr?.previewPending, false);
  return card;
}

/**
 * Where the operator goes to reach the agent. The session wins when there is
 * one: an item moved to the cloud may still carry the workspaceId of the local
 * dispatch it came from, and the live agent is the one to open.
 */
function workspaceUrl(item: BoardItem): string | null {
  const sessionUrl = orElse(item.session?.url, '');
  if (sessionUrl !== '') return sessionUrl;
  const sessionId = orElse(item.session?.id, '');
  if (sessionId !== '') return 'https://claude.ai/code/' + sessionId;
  const workspaceId = orElse(item.workspaceId, null);
  if (workspaceId !== null) return 'superset://v2-workspace/' + workspaceId;
  return null;
}

function resolveTicket(inputs: BuildInputs): TicketLink {
  // BoardConfig.load: an explicit tracker block wins; every config written
  // before `tracker` existed means Linear.
  const tracker = inputs.tracker;
  if (tracker != null) {
    return { kind: tracker.kind ?? 'linear', urlTemplate: tracker.issueUrl ?? null };
  }
  return linearTicket(inputs.linearWorkspace);
}

function ticketChip(
  mode: CardMode,
  inputs: BuildInputs,
  ticket: TicketLink,
  item: BoardItem,
): { ticketKey: string | null; ticketUrl: string | null } {
  if (mode === 'reference') {
    // The jq knows exactly one tracker. A linear item with a null externalId
    // still keys null but links to the issue root — jq's `+` treats null as the
    // empty string, and the parity contract keeps the resulting half-URL.
    if (item.source?.kind !== 'linear') return { ticketKey: null, ticketUrl: null };
    const externalId = item.source?.externalId ?? null;
    return {
      ticketKey: externalId,
      ticketUrl: `https://linear.app/${inputs.linearWorkspace}/issue/${externalId ?? ''}`,
    };
  }

  // App mode: any tracker's key, not just Linear's. `github` is the one kind
  // excluded, because that is what a synthesized card carries — its externalId
  // is the PR's own number, which already has a chip and is not a ticket.
  const source = item.source;
  if (source == null || source.kind === 'github') return { ticketKey: null, ticketUrl: null };
  const key = source.externalId;
  if (key == null || key === '') return { ticketKey: null, ticketUrl: null };
  // Only the configured tracker gets a link. A key from somewhere else still
  // shows on the chip, because knowing the ticket number is most of the value,
  // and a link built from another tracker's template would go somewhere wrong
  // rather than nowhere.
  const template = source.kind === ticket.kind ? ticket.urlTemplate : null;
  return {
    ticketKey: key,
    ticketUrl: template == null ? null : template.replaceAll('{key}', key),
  };
}

/**
 * App mode only. The last pill branch shows the item's own state, for a state
 * the chain does not name. Those are machine words, and `awaiting-approval` is
 * half again as wide as any label here — every pill in the column is sized to
 * the widest one, so one of these on the board indents the chips on all of
 * them. The tone is left alone: reading it as `you` would say more than the
 * reference does and move the card to the top of the board.
 */
function shortened(state: string): string {
  return state === 'awaiting-approval' ? 'At gate' : state;
}

function pill(
  mode: CardMode,
  item: BoardItem,
  pr: PullRequest | undefined,
  agent: AgentStatus | undefined,
  needs: boolean,
): Pill {
  if (needs && agent?.state === 'blocked') return { label: 'Blocked', tone: 'you' };
  // Ready outranks everything except a blocked agent: it is the only row where
  // the next move is yours and takes one click.
  if (item.state === 'ready') return { label: '★ Ready to merge', tone: 'good' };
  if (needs) return { label: 'Needs you', tone: 'you' };
  // The ITEM state, never the agent's status file. sync.sh has already
  // reconciled that file against the live PR — an agent writes "fixing" when it
  // starts and routinely never writes again, so reading the agent here brings
  // back the staleness sync exists to remove: a rebased, green, review-ready PR
  // rendered as "Fixing".
  if (item.state === 'building') return { label: 'Working', tone: 'agent' };
  // Was labelled "Dispatched", which is a different state entirely — a PR in
  // its second round of review read as though it had never been started.
  if (item.state === 'fixing') return { label: 'Fixing', tone: 'agent' };
  if (orElse(pr?.isDraft, false)) return { label: 'Draft', tone: 'mute' };
  const review = pr?.reviewDecision;
  const ci = pr?.ciState;
  if (mode === 'app') {
    // A reviewer's explicit request outranks a red check: the agent is going to
    // push again anyway, and nothing else on a collapsed row would say a human
    // has asked for something.
    if (review === 'CHANGES_REQUESTED') return { label: 'Changes req', tone: 'bad' };
    // Divergence.redCIOutranksReviewState: the reference only lets a red check
    // reach the pill once a PR is APPROVED, so a failing PR reads "In review"
    // or "No reviewer" — both of which say it is fine and waiting on a person,
    // when it cannot merge and the wait is on nobody.
    if (ci === 'red') return { label: 'CI red', tone: 'bad' };
  }
  if (review === 'APPROVED' && ci === 'red') return { label: 'CI red', tone: 'bad' };
  // Conflicts before running checks: a branch that needs a rebase is the more
  // actionable problem, and the checks will run again after it.
  if (review === 'APPROVED' && pr?.mergeStateStatus === 'DIRTY') {
    return { label: 'Conflicts', tone: 'bad' };
  }
  // Divergence.runningCIIsNotMergeable: the reference calls an approved PR
  // "Mergeable" while its checks are still running; branch protection would
  // refuse it. Waiting on a machine takes the same tone as waiting on a person,
  // so it sorts below the PRs that really can be merged now.
  if (mode === 'app' && review === 'APPROVED' && ci === 'running') {
    return { label: 'CI running', tone: 'review' };
  }
  if (review === 'APPROVED') return { label: 'Mergeable', tone: 'good' };
  if (review === 'CHANGES_REQUESTED') return { label: 'Changes req', tone: 'bad' };
  if (review === 'REVIEW_REQUIRED') return { label: 'In review', tone: 'review' };
  // reviewDecision is null when the repo does not require review, even with a
  // reviewer requested. Trust the request list.
  if (orElse(pr?.reviewRequests, []).length > 0) return { label: 'In review', tone: 'review' };
  if (pr !== undefined) return { label: 'No reviewer', tone: 'you' };
  // No live PR row: either it landed, or there is no PR at all yet.
  if (item.state === 'merged') return { label: 'Merged — reap', tone: 'good' };
  if (orElse(item.pr?.number, null) !== null) {
    return { label: mode === 'app' ? 'PR Gone' : 'Gone from open', tone: 'mute' };
  }
  if (item.state === 'dispatched') return { label: 'Starting', tone: 'agent' };
  // Unreachable — the branch above catches every building item. Kept because
  // the reference keeps it, so the two chains stay line-for-line comparable.
  if (item.state === 'building') return { label: 'Working', tone: 'agent' };
  return { label: mode === 'app' ? shortened(item.state) : item.state, tone: 'mute' };
}

/**
 * Two inherited quirks, kept in both modes: CHANGES_REQUESTED has no line of
 * its own and falls through to the "nobody has been asked to review it" text,
 * and an agent at the gate with an empty summary yields nothing at all.
 */
function whereItsAt(
  mode: CardMode,
  item: BoardItem,
  pr: PullRequest | undefined,
  agent: AgentStatus | undefined,
): string | null {
  const phase = orElse(agent?.phase, null);
  const summary = orElse(agent?.summary, null);
  // At the gate the phase ("self-review complete") says nothing useful, so
  // prefer the first line of the summary the agent wrote.
  if (agent?.state === 'awaiting-approval' && summary !== null) {
    // jq's `"" | split("\n")` is [], so [0] is null — an empty summary at the
    // gate leaves the line blank rather than falling through to the phase.
    if (summary === '') return null;
    return summary.split('\n')[0]!;
  }
  // When the agent's own state disagrees with the reconciled item state, its
  // phase is describing work that has already finished — "rebasing #477…"
  // beside a green, review-ready PR. Say so rather than let it read as live.
  if (agent?.state != null && agent.state !== item.state && phase !== null) {
    return `last agent update: ${phase}`;
  }
  if (phase !== null) return phase;
  if (summary !== null) return summary;
  if (orElse(pr?.isDraft, false)) {
    return mode === 'app'
      ? 'PR is open as draft'
      : 'Open as a draft — reviewers skip drafts until it is marked ready.';
  }
  const review = pr?.reviewDecision;
  const ci = pr?.ciState;
  // An approved PR keeps the reference's more specific line, in both modes.
  if (review === 'APPROVED' && ci === 'red') {
    return 'Approved. Only the failing check is holding it.';
  }
  // Divergence.redCIOutranksReviewState follows its pill: saying "waiting on a
  // reviewer" beside a CI-red pill, or calling a failing PR green, would be
  // worse than the quirk it replaces.
  if (mode === 'app' && ci === 'red' && review !== 'CHANGES_REQUESTED') {
    return 'A check is failing — it cannot merge until that is green.';
  }
  if (review === 'APPROVED' && pr?.mergeStateStatus === 'DIRTY') {
    return 'Approved, but the branch conflicts with main.';
  }
  // Divergence.runningCIIsNotMergeable, likewise following its pill.
  if (mode === 'app' && review === 'APPROVED' && ci === 'running') {
    return 'Approved. Waiting on the checks to finish.';
  }
  if (review === 'APPROVED') return 'Approved and clean — ready for you to merge.';
  if (review === 'REVIEW_REQUIRED') return 'Waiting on a reviewer.';
  if (orElse(pr?.reviewRequests, []).length > 0) return 'Waiting on a reviewer.';
  if (pr !== undefined) return 'Open, green, and nobody has been asked to review it.';
  // A cloud item reaching here has no PR yet and no status file — and never
  // will have one, because the agent runs on hosted infrastructure and cannot
  // write to this machine. "No PR data in the last poll" would read as a fault;
  // for these it is simply how they look until the branch is pushed.
  if (orElse(item.host, 'local') === 'cloud') return 'Running on claude.ai. Nothing pushed yet.';
  return 'No PR data in the last poll.';
}
