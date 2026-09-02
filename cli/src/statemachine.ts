// The item state machine — the vocabulary from board-set.sh and
// reference/board.md, plus board_set's patch/history semantics as a pure
// function. The write path (store.ts) carries no state knowledge; verbs
// compose the two.

/**
 * board-set.sh's KNOWN_STATES, order included: its "unknown state" error
 * prints the list space-joined in exactly this sequence, so the order is
 * output, not decoration. Anything else on a board is a typo that renders as
 * a state nothing knows how to leave.
 */
export const KNOWN_STATES = [
  'proposed',
  'dispatched',
  'building',
  'awaiting-approval',
  'pr-open',
  'fixing',
  'blocked',
  'ready',
  'merged',
  'orphaned',
  'rejected',
  'closed',
  'abandoned',
] as const;

export type KnownState = (typeof KNOWN_STATES)[number];

/** The terminal trio: never left, archived after limits.recentlyClosedDays. */
export const TERMINAL: ReadonlySet<string> = new Set(['closed', 'rejected', 'abandoned']);

/**
 * States in which an agent workspace exists for the item — everything between
 * dispatch taking effect (the agent's first status file) and reap. `merged`
 * belongs here because the workspace outlives the merge until reap.sh
 * verifies it clean; `dispatched` does not, because no status file exists yet
 * and sync has nothing to reconcile against.
 */
export const AGENT_STATES: ReadonlySet<string> = new Set([
  'building',
  'awaiting-approval',
  'pr-open',
  'fixing',
  'blocked',
  'merged',
]);

/**
 * lib.sh's board_set, per item: a flat top-level merge of the patch (patch
 * values win, explicit nulls included), and a history entry appended ONLY on
 * a state change — {at, from, to} plus by when the caller gave one.
 *
 * Ported quirks, all from the jq:
 *  - `$patch.state?` gates the entry with jq truthiness, so a null or false
 *    state in the patch merges without a history line;
 *  - history is REASSIGNED from the old item's on every write — a patch can
 *    never set it, a null/absent history normalizes to [], and an item
 *    without the key gains it (the jq errored on a truthy non-array; here it
 *    normalizes too, same board_validate backstop either way);
 *  - `$by != ""` means both an absent and an empty by leave the key off,
 *    because the shell spelled "no by" as --arg by "".
 */
export function applyItemPatch<T extends object>(
  item: T,
  patch: Record<string, unknown>,
  by: string | undefined,
  at: string,
): T {
  const old = item as Record<string, unknown>;
  const oldState = old['state'];
  const patchState = patch['state'];
  const stateChanged =
    patchState !== undefined &&
    patchState !== null &&
    patchState !== false &&
    patchState !== oldState;

  const base = Array.isArray(old['history']) ? (old['history'] as unknown[]) : [];
  const history = stateChanged
    ? [
        ...base,
        {
          at,
          from: oldState ?? null,
          to: patchState,
          ...(by !== undefined && by !== '' ? { by } : {}),
        },
      ]
    : [...base]; // fresh array either way — jq copied, aliasing must not leak

  return { ...item, ...patch, history } as T;
}
