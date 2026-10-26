// The shared vocabulary of the board card model, ported from Sources/BoardKit
// (Orchestrator.swift, GitHub.swift, Card.swift, Project.swift) and
// skills/superset-orchestrator/reference/board.md. This CLI is becoming the one
// implementation of the model, replacing both render-board.sh's jq and the
// Swift port, so these shapes are contracts, not conveniences.
//
// Shared-append: other modules add to this file. Never rename or remove an
// existing export.
//
// A note on optionality: the orchestrator's files write explicit nulls and jq's
// `//` treats null and absent identically, so optional fields here are
// `| null` as well as `?` — readers keep whichever spelling the file used, and
// consumers must treat the two the same way jq does.

// ── GitHub ────────────────────────────────────────────────────────────────────

/**
 * A PR as the board needs it: the `gh pr list` fields plus what poll.sh
 * derives on the way into signals/github.json — the check rollup as one word,
 * the thread counts split by who spoke last, the preview URL from the deploy
 * bot's comment, and the newest review activity timestamp.
 *
 * Rows from the `merged[]` / `closed[]` signal lists reuse this shape; only
 * they carry `mergedAt` / `closedAt`, and they default `ciState` and
 * `unresolvedThreads` because poll.sh never enriches a PR that is done.
 */
export interface PullRequest {
  number: number;
  title: string;
  headRefName?: string | null;
  baseRefName?: string | null;
  url?: string | null;
  isDraft?: boolean | null;
  /**
   * "" is a value, not an absence: a repo with no review requirement reports
   * an empty reviewDecision, and jq's `//` keeps it (only null and false fall
   * through). The pill chain depends on that.
   */
  reviewDecision?: string | null;
  /** `gh pr list --json reviewRequests` objects. Only the length is ever read. */
  reviewRequests?: unknown[] | null;
  updatedAt?: string | null;
  mergeStateStatus?: string | null;
  /** "owner/name". Signal rows carry their own; the repo block's name backfills. */
  repo?: string | null;
  /** poll.sh's one-word rollup: red | running | none | green — or "unknown". */
  ciState: string;
  /** Unresolved threads where a reviewer spoke last — the ones that are our ask. */
  unresolvedThreads: number;
  /** Unresolved threads where we spoke last — waiting on a re-review, not on us. */
  threadsAwaitingReviewer?: number | null;
  previewUrl?: string | null;
  /** True while the preview host's own deploy check is still running. */
  previewPending?: boolean | null;
  /** Max of review submittedAt and thread comment createdAt; ISO-8601 UTC. */
  latestActivityAt?: string | null;
  /** Reviewer login → latest review state, as poll.sh folds `reviews(last:20)`. */
  reviewStates?: Record<string, string> | null;
  /** Only on `merged[]` signal rows. */
  mergedAt?: string | null;
  /** Only on `closed[]` signal rows (poll.sh keeps only the unmerged ones). */
  closedAt?: string | null;
}

// ── board.json ────────────────────────────────────────────────────────────────

export interface BoardItemSource {
  kind?: string | null;
  externalId?: string | null;
}

/**
 * The orchestrator's last-known PR facts. GitHub wins over these when both have
 * an answer, but they are the only source once a PR leaves `--state open`.
 */
export interface PRRef {
  number?: number | null;
  url?: string | null;
  reviewDecision?: string | null;
  ciState?: string | null;
  isDraft?: boolean | null;
  mergeStateStatus?: string | null;
}

/**
 * A Claude Code session on the web. Present instead of a workspace when the
 * item was dispatched to the cloud rather than to a local worktree.
 */
export interface SessionRef {
  id?: string | null;
  url?: string | null;
}

/** One `history` entry: a state transition and when it happened. */
export interface HistoryEntry {
  at?: string;
  from?: string | null;
  to?: string;
  by?: string | null;
}

/** One entry in board.json's `items`. */
export interface BoardItem {
  id: string;
  title: string;
  state: string;
  slug?: string | null;
  branch?: string | null;
  /**
   * "owner/name", as the orchestrator records it. Read only to keep branch
   * matching inside one repository — everything else is keyed by PR number.
   */
  repo?: string | null;
  workspaceId?: string | null;
  outcome?: string | null;
  source?: BoardItemSource | null;
  pr?: PRRef | null;
  /**
   * `local` (a Superset workspace on this machine) or `cloud` (a session on
   * claude.ai). Absent means local, because every item written before cloud
   * dispatch existed is one.
   */
  host?: string | null;
  session?: SessionRef | null;
  history?: HistoryEntry[] | null;
  createdByOrchestrator?: boolean | null;
  baseBranch?: string | null;
  briefPath?: string | null;
  /**
   * sync.sh's rule 3: the branch the item's live workspace actually sits on,
   * when that differs from item.branch — and an explicit null once the two
   * agree again. Written by reconcile every cycle the workspace is live; the
   * drift warning is the only reader.
   */
  workspaceDrift?: string | null;
}

// ── workspaces/<id>.json and signals/workspaces.json ─────────────────────────

export interface Diffstat {
  files?: number | null;
  insertions?: number | null;
  deletions?: number | null;
}

/**
 * What the Stop-hook OBSERVED about the agent's worktree, as opposed to what
 * the agent CLAIMED. Written into the status file alongside `observedAt` after
 * the model last spoke, so it can post-date `updatedAt`. Every field optional:
 * hooks predating a field simply never write it, and a partial observation
 * must never invalidate the file it rides in.
 */
export interface GitObservation {
  branch?: string | null;
  /** Files with uncommitted changes. 0 means the worktree is clean. */
  dirty?: number | null;
  /** Commits not on the upstream. 0 means everything is pushed. */
  ahead?: number | null;
  /** HEAD's commit sha. */
  head?: string | null;
  /** HEAD's committer date; ISO-8601 UTC. */
  headCommittedAt?: string | null;
}

/**
 * One agent's own status file, `workspaces/<id>.json` — plus the enrichment
 * poll.sh folds into signals/workspaces.json (sessionLiveness onward), which
 * only the poller can see and the agent never writes.
 *
 * Everything is optional because lib.sh's status_file_valid admits far less
 * than the documented schema requires: a file passes with workspaceId null, and
 * the reader's job is to skip the dangerous shapes, not to enforce the docs.
 */
export interface AgentStatus {
  workspaceId?: string | null;
  itemId?: string | null;
  slug?: string | null;
  branch?: string | null;
  state?: string | null;
  phase?: string | null;
  summary?: string | null;
  updatedAt?: string | null;
  verification?: Record<string, unknown> | null;
  diffstat?: Diffstat | null;
  risks?: unknown[] | null;
  questions?: unknown[] | null;
  blockedReason?: string | null;
  pr?: PRRef | null;
  needsOperator?: boolean | null;
  sessionLiveness?: string | null;
  lastSessionActivityAt?: string | null;
  worktreePath?: string | null;
  /** Counts, but written by poll.sh as strings — render-board compares `!== "0"`. */
  dirtyFiles?: string | null;
  unpushedCommits?: string | null;
  /**
   * When the Stop hook last observed the worktree; ISO-8601 UTC. Distinct from
   * `updatedAt` (stamped when the AGENT wrote): an observation newer than the
   * status write is evidence about the file's claims, not a claim itself.
   */
  observedAt?: string | null;
  /** The hook's git facts at `observedAt`. Absent on every pre-hook file. */
  git?: GitObservation | null;
}

/**
 * One `*.json` file in the agent-status inbox, keyed by its FILENAME. The
 * filename (basename sans .json) is the identity sync.sh pruned by — with no
 * validity filter — so it is carried even when the content did not parse.
 * `status` is present only for a file that passed status_file_valid; the two
 * identities can disagree (a file whose content claims another workspaceId),
 * and the prune must judge and delete by `id`, never by the content.
 */
export interface AgentInboxFile {
  id: string;
  status?: AgentStatus;
}

/**
 * A live Superset workspace, from signals/workspaces.json. The name is what
 * the operator navigates by; the rest ride along for the deep link and the
 * worktree checks.
 */
export interface WorkspaceRef {
  id: string;
  name?: string | null;
  branch?: string | null;
  projectId?: string | null;
  worktreePath?: string | null;
}

// ── Cards ─────────────────────────────────────────────────────────────────────

/** The six tones render-board.sh assigns, in the order it sorts them. */
export type Tone = 'you' | 'agent' | 'bad' | 'good' | 'review' | 'mute';

/**
 * The sort rank render-board.sh's jq gives each tone. Not alphabetical and not
 * the declaration order of anything — transcribed from the `sort_by` at the
 * bottom of its program.
 */
export const TONE_RANK: Record<Tone, number> = {
  you: 0,
  bad: 1,
  agent: 2,
  good: 3,
  review: 4,
  mute: 5,
};

export interface Pill {
  label: string;
  tone: Tone;
}

/**
 * One row on the board. Field-for-field the object render-board.sh's jq builds
 * — same 27 keys, same order, explicit nulls for every absent optional — so the
 * three implementations can be diffed byte for byte over the same input.
 * App mode appends one key the jq predates, `previewPending`, which is why it
 * is optional here: the reference chain must not emit it.
 */
export interface Card {
  id: string;
  num: number | null;
  title: string;
  branch: string;
  workspace: string | null;
  workspaceId: string | null;
  workspaceUrl: string | null;
  boardState: string;
  prUrl: string | null;
  ticketKey: string | null;
  ticketUrl: string | null;
  previewUrl: string | null;
  review: string | null;
  ci: string;
  threads: number;
  draft: boolean;
  mergeState: string | null;
  needsOperator: boolean;
  agentState: string | null;
  agentPhase: string | null;
  agentSummary: string | null;
  liveness: string | null;
  dirty: string | null;
  unpushed: string | null;
  whatItIs: string;
  pill: Pill;
  /** Null only in the one case jq produces null: an empty summary at the gate. */
  whereItsAt: string | null;
  /** App mode only, always set there: the preview chip reads this as "rebuilding". */
  previewPending?: boolean;
}

/**
 * Card.swift's CodingKeys order, which is also jq's construction order. The
 * order is a contract: jq -n and JSON.stringify both emit keys in insertion
 * order, so byte parity requires every Card literal to be built in exactly this
 * sequence. Kept as a value so a test can assert an emitted card against it.
 */
export const CARD_KEYS = [
  'id',
  'num',
  'title',
  'branch',
  'workspace',
  'workspaceId',
  'workspaceUrl',
  'boardState',
  'prUrl',
  'ticketKey',
  'ticketUrl',
  'previewUrl',
  'review',
  'ci',
  'threads',
  'draft',
  'mergeState',
  'needsOperator',
  'agentState',
  'agentPhase',
  'agentSummary',
  'liveness',
  'dirty',
  'unpushed',
  'whatItIs',
  'pill',
  'whereItsAt',
] as const satisfies ReadonlyArray<keyof Card>;

/** One line under "Recently closed": a terminal item younger than the cutoff. */
export interface RecentlyClosedRow {
  title: string;
  state: string;
  num: number | null;
  at: string | null;
}

/** The payload render-board.sh embeds in board.html and renders board.md from. */
export interface CardsPayload {
  generatedAt: string;
  recentlyClosed: RecentlyClosedRow[];
  cards: Card[];
}

/**
 * Which rule set builds a card. 'reference' is render-board.sh's jq, byte for
 * byte, quirks included. 'app' additionally applies BoardKit's declared
 * divergences (CardBuilder.Divergence: red CI outranks review state, running CI
 * is not mergeable) — deliberate disagreements, never silent ones.
 */
export type CardMode = 'reference' | 'app';

// ── Orchestrator layout ───────────────────────────────────────────────────────

/**
 * The orchestrator's root directory. config.json and workspaces/ are global at
 * the root — one operator, one agent-status inbox keyed by globally unique
 * workspace id — while per-project state lives under p/<key>/.
 */
export interface OrchRoot {
  root: string;
  configPath: string;
  workspacesDir: string;
}

/**
 * One project's state directory, and the key that names it. The key is the
 * directory under p/, which is also repos[].key in config.json. An empty key is
 * the pre-p/ layout, where the board sat at the root and there was only one.
 */
export interface ProjectRef {
  key: string;
  root: string;
}

// ── config.json ───────────────────────────────────────────────────────────────

export interface RepoConfig {
  name?: string;
  /** The agent this repo's work is dispatched to, unless --agent overrides it. */
  agent?: string;
  key?: string;
  shortName?: string;
  supersetProjectId?: string | null;
  localPath?: string;
  defaultBase?: string;
  reviewers?: string[];
  linearTeams?: string[];
  prTemplate?: string;
  checks?: Record<string, string>;
}

/**
 * The operator-owned config.json, per reference/config.example.json. Everything
 * is optional — the board must render with no config at all — and unknown keys
 * survive a read because the file is hand-owned.
 */
export interface BoardConfigFile {
  operator?: {
    githubLogin?: string;
    /** Logins counted as "ours" when deciding who spoke last on a thread. */
    githubLogins?: string[];
    /**
     * Whether PRs the operator was asked to review (but did not write) join
     * the open list and get cards. Default true — the historical behaviour.
     * false keeps the board to authored work only. Read directly, not via
     * cfg(): the jq `//` port there treats false as absent.
     */
    includeReviewRequests?: boolean;
    linearName?: string;
    linearWorkspace?: string;
    timezone?: string;
    supersetProjectId?: string | null;
  };
  tracker?: {
    kind?: string;
    issueUrl?: string;
    /** Where markdown-tracker task files live inside the repo. */
    path?: string;
  };
  preview?: {
    patterns?: string[];
  };
  review?: {
    /**
     * The prompt handed to the agent `board review start` launches, with
     * {url} {repo} {number} {title} {author} {branch} {base} substituted.
     * Unset means the built-in default in ops/review.ts.
     */
    prompt?: string;
    /**
     * Whether pending reviews join the menu-bar alert the way Needs-you
     * cards do. Default false — the tab badge is the only signal. Read
     * directly, not via cfg(): the jq `//` port there treats false as absent.
     */
    countsAsNeedsYou?: boolean;
  };
  repos?: RepoConfig[];
  linear?: {
    teams?: string[];
    statesToConsider?: string[];
    lookback?: string;
    autoUpdate?: Record<string, boolean>;
  };
  slack?: {
    channels?: string[];
    lookbackHours?: number;
    pollEveryNCycles?: number;
    post?: boolean;
  };
  superset?: {
    host?: string;
    agent?: string;
    effort?: string | null;
    useTasks?: boolean;
    linkWorkspaceToTask?: boolean;
  };
  cloud?: {
    enabled?: boolean;
    fireUrl?: string;
    tokenEnv?: string;
    defaultHost?: string;
  };
  limits?: {
    maxActiveWorkspaces?: number;
    maxActiveCloudSessions?: number;
    maxProposalsPerRound?: number;
    maxStackDepth?: number;
    stallMinutes?: number;
    recentlyClosedDays?: number;
  };
  cadence?: {
    idleSeconds?: number;
    activeSeconds?: number;
    ciRunningSeconds?: number;
    watchSeconds?: number;
    /**
     * How long a GitHub poll's result may be reused from the orch-root cache
     * before another caller re-fetches. The GitHub queries are global, so N
     * per-project watchers plus the app were fetching the identical PR set
     * independently; within this window they share one fetch. Defaults to
     * three-quarters of watchSeconds (so the owning watcher still refreshes
     * every cycle while siblings and the app reuse). 0 disables the cache.
     */
    pollCacheSeconds?: number;
  };
  gates?: {
    approveBeforeDispatch?: boolean;
    approveBeforePrSubmission?: boolean;
    approveBeforeWorkspaceDelete?: boolean;
    approveBeforeExternalWrites?: boolean;
  };
  /** Standing decisions the orchestrator may relay to a blocked agent. */
  answers?: Record<string, unknown>;
  [key: string]: unknown;
}

// ── Readers ───────────────────────────────────────────────────────────────────

/**
 * What a tolerant reader hands back: everything it could salvage, plus one
 * warning per thing it had to skip. No reader throws on malformed input, and a
 * missing file is an empty value with no warning — absence is the normal state
 * for half these files.
 */
export interface ReadResult<T> {
  value: T;
  warnings: string[];
}

/** signals/github.json, split the way consumers want it. */
export interface GithubSignals {
  /** Every open PR across every repo block. */
  prs: PullRequest[];
  /** Numbers poll.sh recorded as merged — the earliest "this landed" signal. */
  mergedNumbers: Set<number>;
  /** PRs closed without merging: in neither the open nor the merged list. */
  closedUnmerged: PullRequest[];
}

/** signals/workspaces.json: live workspaces plus poll.sh-enriched statuses. */
export interface WorkspacesSignal {
  workspaces: WorkspaceRef[];
  agentStatus: AgentStatus[];
}

// ── App-mode assembly ─────────────────────────────────────────────────────────

/**
 * Everything one project's orchestrator directory contributes, per
 * Orchestrator.swift's OrchestratorSnapshot. All of it is enrichment: an empty
 * snapshot still produces a board, built from GitHub alone.
 */
export interface OrchestratorSnapshot {
  items: BoardItem[];
  agents: AgentStatus[];
  workspaces: WorkspaceRef[];
  /**
   * PRs poll.sh has seen land. `gh pr list --state open` cannot report these,
   * and an item's own state only says "merged" once the orchestrator gets to
   * it, so this is the earliest the board can know a PR is done with.
   */
  mergedPRNumbers: Set<number>;
  /** False when the orchestrator directory is not on disk at all. */
  isPresent: boolean;
}

/**
 * board.json as one document — what store.ts's readBoardDoc hands back. The
 * items come through the same lossy decode as readBoardItems; version and
 * updatedAt are null when absent or mistyped, because jq's readers masked both
 * through `// null` and a board written before versioning has neither.
 */
export interface BoardDoc {
  version: number | null;
  updatedAt: string | null;
  items: BoardItem[];
}

// ── Poll IO ───────────────────────────────────────────────────────────────────

/** What one external command produced. `status` is non-zero on spawn failure. */
export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Replaces (not merges with) the child's environment when set. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Everything ops/poll.ts touches outside its own process, behind one seam so
 * the tests can run the whole poll with no gh, no superset and no network.
 * `warn` receives the message WITHOUT lib.sh's "warn: " prefix — the caller
 * that prints adds it, the way main.ts's warnAll does.
 */
export interface PollIo {
  exec(cmd: string, args: string[], options?: ExecOptions): ExecResult;
  /**
   * The async twin of `exec`, for running independent commands concurrently —
   * the per-repo `gh pr list` calls are the poll's wall-clock cost now that the
   * GraphQL points are tamed. Optional: when a caller (or a test stub) omits it,
   * the collectors fall back to the synchronous `exec`, running sequentially.
   */
  execAsync?(cmd: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  /** lib.sh's now(): ISO-8601 UTC seconds, no millis. */
  now(): string;
  /** Epoch milliseconds, for stall cutoffs and the closed-PR window. */
  nowMs(): number;
  homeDir(): string;
  env: NodeJS.ProcessEnv;
  warn(message: string): void;
}

/**
 * One repo's block in signals/github.json, exactly as poll.sh assembles it:
 * {repo, open, merged, closed}. Rows are raw gh JSON (open rows enriched then
 * stripped of statusCheckRollup), so they stay untyped objects — the file is
 * a passthrough, and inventing a shape here would drop fields the shell kept.
 */
export interface RepoSignalBlock {
  repo: string;
  open: Record<string, unknown>[];
  merged: unknown[];
  closed: unknown[];
}

/** signals/github.json as written: {collectedAt, repos}. */
export interface GithubSignalsDoc {
  collectedAt: string;
  repos: RepoSignalBlock[];
  /**
   * When the merged/closed lists were last fetched from GitHub. Those states
   * change rarely, so the poll refetches them only every
   * cadence.mergedClosedEverySeconds and reuses the previous lists in between;
   * this stamps the last real fetch so the next poll can tell. Absent on a doc
   * written before this field, which simply forces one refetch.
   */
  mergedClosedAt?: string;
  /**
   * The GraphQL budget `remaining` the last details query reported. The next
   * poll reads it to back off (skip merged/closed, widen the cache) as the
   * hourly budget drains, so the board never spends the agents' headroom. Null
   * when the last poll made no details call (nothing changed) or it failed.
   */
  rateRemaining?: number | null;
  /**
   * How many open PRs the last poll actually re-enriched. 0 means an idle board
   * (every open PR reused its previous threads), which lets the poll widen the
   * disk-cache TTL to cadence.pollCacheIdleSeconds.
   */
  enrichedCount?: number;
}

/** signals/workspaces.json as written: {collectedAt, workspaces, agentStatus}. */
export interface WorkspacesSignalsDoc {
  collectedAt: string;
  /** The superset CLI's rows, passed through verbatim. */
  workspaces: unknown[];
  agentStatus: Record<string, unknown>[];
}

/** signals/tasks.json as written: {collectedAt, tasks}. */
export interface TasksSignalsDoc {
  collectedAt: string;
  /** Whatever tasks.sh --open printed, parsed; [] on every failure. */
  tasks: unknown;
}

/**
 * One PR awaiting the operator's review — the reviews lane. Never a board
 * item: reviews have no state machine, no workspace, no reconcile. The lane is
 * a queue (signals/reviews.json per project), a dismissal ledger at the
 * orchestrator root, and one dispatch verb (`board review start`).
 */
export interface ReviewRow {
  repo: string;
  number: number;
  title: string;
  url: string | null;
  author: string;
  headRefName: string | null;
  baseRefName: string | null;
  isDraft: boolean;
  updatedAt: string | null;
  previewUrl: string | null;
  /**
   * When there is no previewUrl, the `updatedAt` we last scraped this PR for
   * and found none — the negative-result marker that stops the next poll
   * re-running `gh pr view` on an unchanged review. Absent when a preview was
   * found or was never looked for.
   */
  previewScrapedFor?: string;
}

/** signals/reviews.json as written: {collectedAt, reviews}. */
export interface ReviewsSignalsDoc {
  collectedAt: string;
  reviews: ReviewRow[];
}

/** One dismissed review in the root-level reviews-dismissed.json ledger. */
export interface DismissedReview {
  repo: string;
  number: number;
  /** The title at dismissal time, so the ledger reads without GitHub. */
  title: string;
  dismissedAt: string;
}

/** reviews-dismissed.json as written: {version, dismissed}. */
export interface DismissedReviewsDoc {
  version: 1;
  dismissed: DismissedReview[];
}

/**
 * One dismissed card in the root-level cards-dismissed.json ledger — the
 * board lane's counterpart to reviews-dismissed.json, and deliberately a
 * separate file: declining to review a PR and declining to track it are two
 * decisions, and one ledger would make either imply the other.
 */
export interface DismissedCard {
  /**
   * The card's own id, which is what the render subtracts: `pr:owner/name#N`
   * for a card the board invented, or the board item's id for one an item
   * stands behind. Keyed by id rather than by PR so that a card with no PR —
   * a proposed item, an agent still working — can be dismissed too.
   */
  id: string;
  /** The title at dismissal time, so the ledger reads without GitHub. */
  title: string;
  dismissedAt: string;
}

/** cards-dismissed.json as written: {version, dismissed}. */
export interface DismissedCardsDoc {
  version: 1;
  dismissed: DismissedCard[];
}

/**
 * A card, and which project it came from — Project.swift's ProjectCard.
 *
 * The project is deliberately OUTSIDE Card. Card mirrors render-board.sh's jq
 * output field for field, and the golden tests compare the two with no
 * allowance for extra keys — a field added here would either break that test
 * or force it to loosen, and the test's whole value is that it cannot be
 * loosened. Wrapping keeps the port honest and adds what only app mode needs.
 */
export interface ProjectCard {
  project: ProjectRef;
  /** The label on the project chip. The repository name by default, or shortName. */
  shortName: string;
  card: Card;
  /**
   * Every PR this card stands for, bottom of the stack first. Empty on an
   * ordinary card — the count, not the emptiness, is what the chip reads, so a
   * card for one PR carries nothing here rather than a list of one.
   */
  stack: PullRequest[];
  /** Which tracker the ticket chip stands for, so it can name and draw itself. */
  trackerKind: string;
  /** `local` or `cloud` — where the card's agent runs. */
  host: string;
  /**
   * The PR's own title, when the card is titled by a board item and the two
   * differ. The card shows the item's short title; this rides the PR chip's
   * hover so the GitHub title stays reachable.
   */
  prTitle: string | null;
  /**
   * "<projectKey>:<itemId>" — unique across projects. Two orchestrators number
   * their items independently, so itm_4 can exist on both boards, and a keyed
   * renderer would then reuse one row for two cards.
   */
  id: string;
}

// ── Cloud IO ──────────────────────────────────────────────────────────────────

/** The one HTTPS POST cloud dispatch makes — the routine /fire call. */
export interface CloudFetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** curl's view of the response: the status line's code and the raw body. */
export interface CloudFetchResult {
  status: number;
  body: string;
}

/**
 * PollIo plus network, for ops/cloud.ts and ops/dispatch.ts. Tests stub
 * `fetch` the way they stub `exec` — zero live network, and a fire that must
 * not happen is provable by an empty recorder.
 */
export interface CloudIo extends PollIo {
  fetch(url: string, init: CloudFetchInit): Promise<CloudFetchResult>;
}

// ── Markdown tracker ──────────────────────────────────────────────────────────

/**
 * One markdown-tracker task, exactly the object tasks.sh printed per file:
 * frontmatter scalars with their defaults, the file's absolute and repo-
 * relative paths, and the body after the closing `---`. Key order is the
 * output contract — `board tasks --list` emits these fields in this order.
 */
export interface TrackerTask {
  id: string;
  title: string;
  /** todo | doing | done | dropped — free text kept as written; todo default. */
  status: string;
  /** urgent | high | medium | low — free text kept as written; medium default. */
  priority: string;
  path: string;
  relPath: string;
  body: string;
}
