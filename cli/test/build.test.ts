// The golden tests for the card chain. Reference mode is diffed byte for byte
// against JSON that render-board.sh's own jq produced over the frozen fixtures
// (CardBuilderGoldenTests.swift uses the same inputs and goldens, so all three
// implementations answer to the same files). App mode then gets the two
// declared divergences and the rewordings — ported case for case from the
// Swift golden tests — plus unit pins on the quirks the README enumerates.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { BuildInputs } from '../src/cards/build.js';
import { buildPayload } from '../src/cards/build.js';
import {
  readAgentStatuses,
  readBoardItems,
  readGithubSignals,
  readWorkspacesSignal,
} from '../src/read.js';
import type { BoardItem, Card, CardMode, PullRequest } from '../src/types.js';
import { CARD_KEYS, TONE_RANK } from '../src/types.js';

const fixturesDir = fileURLToPath(new URL('../../Tests/BoardKitTests/Fixtures/', import.meta.url));

// The arguments the goldens were generated with: `--arg linearWs acme
// --arg generatedAt X`, and a cutoff older than every fixture item so the
// recentlyClosed list is the unfiltered one.
function loadInputs(fixture: string): BuildInputs {
  const dir = join(fixturesDir, fixture);
  const board = readBoardItems(join(dir, 'board.json'));
  const github = readGithubSignals(join(dir, 'github.json'));
  const agents = readAgentStatuses(join(dir, 'workspaces'));
  const signal = readWorkspacesSignal(join(dir, 'workspaces-signal.json'));
  // The fixtures are clean; a warning here means the readers stopped seeing
  // what the jq slurped, and the golden diff below would blame the wrong layer.
  expect([...board.warnings, ...github.warnings, ...agents.warnings, ...signal.warnings]).toEqual(
    [],
  );
  return {
    items: board.value,
    prs: github.value.prs,
    agents: agents.value,
    workspaces: signal.value.workspaces,
    linearWorkspace: 'acme',
    recentCutoff: '2020-01-01T00:00:00Z',
    generatedAt: 'X',
  };
}

function goldenCards(fixture: string): unknown[] {
  const raw = readFileSync(join(fixturesDir, fixture, 'expected-cards.json'), 'utf8');
  return (JSON.parse(raw) as { cards: unknown[] }).cards;
}

function minimalInputs(items: BoardItem[], prs: PullRequest[] = []): BuildInputs {
  return {
    items,
    prs,
    agents: [],
    workspaces: [],
    linearWorkspace: 'acme',
    recentCutoff: '2020-01-01T00:00:00Z',
    generatedAt: 'X',
  };
}

function byId(inputs: BuildInputs, mode: CardMode): Map<string, Card> {
  return new Map(buildPayload(inputs, mode).cards.map((card) => [card.id, card]));
}

// ── Reference mode: the jq, byte for byte ─────────────────────────────────────

describe.each([
  { fixture: '.', name: 'live snapshot', count: 5 },
  { fixture: 'synthetic', name: 'every pill branch', count: 27 },
])('reference golden: $name', ({ fixture, count }) => {
  test('cards match the jq output byte for byte', () => {
    const payload = buildPayload(loadInputs(fixture), 'reference');
    const golden = goldenCards(fixture);
    expect(payload.cards).toHaveLength(count);
    // Deep equality first, for a readable diff when a field drifts…
    expect(payload.cards).toEqual(golden);
    // …then bytes: JSON.parse keeps jq's construction order, so re-serialising
    // both sides compares key order and explicit nulls as well as values.
    expect(JSON.stringify(payload.cards, null, 2)).toBe(JSON.stringify(golden, null, 2));
    for (const card of payload.cards) {
      expect(Object.keys(card)).toEqual([...CARD_KEYS]);
    }
  });
});

test('the synthetic fixture still reaches every branch of the reference chain', () => {
  // Guard the fixture itself: were it to stop covering the chains, the golden
  // comparison above would still pass while proving much less.
  const payload = buildPayload(loadInputs('synthetic'), 'reference');
  expect(new Set(payload.cards.map((card) => card.pill.tone))).toEqual(
    new Set(['you', 'agent', 'bad', 'good', 'review', 'mute']),
  );
  expect(new Set(payload.cards.map((card) => card.pill.label))).toEqual(
    new Set([
      'Blocked', '★ Ready to merge', 'Needs you', 'Working', 'Fixing', 'Draft',
      'CI red', 'Conflicts', 'Mergeable', 'Changes req', 'In review', 'No reviewer',
      'Merged — reap', 'Gone from open', 'Starting', 'queued',
    ]),
  );
});

test('an empty reviewDecision is a value, not an absence', () => {
  // itm_444's live row reports "": a repo with no review requirement. jq's `//`
  // keeps it, so the card must too — "" falling through to the item's memory
  // would resurrect a stale decision.
  const cards = byId(loadInputs('.'), 'reference');
  expect(cards.get('itm_444')?.review).toBe('');
  expect(cards.get('itm_444')?.pill.label).toBe('Fixing');
});

// ── recentlyClosed ────────────────────────────────────────────────────────────
// Pinned against the same jq run that regenerates expected-cards.json (the
// frozen goldens predate the list, so the expectations live here instead).

test('recentlyClosed reproduces the jq list, tie order included', () => {
  const payload = buildPayload(loadInputs('.'), 'reference');
  // Three items share one timestamp; jq sorts ascending then reverses, which
  // flips what the stable sort kept, so 439 leads despite 441 coming first in
  // board.json. The byte compare pins the row key order too.
  const expected = [
    { title: 'State the exception list, not the total', state: 'closed', num: 391, at: '2026-07-30T18:18:15Z' },
    { title: '(new PR — needs grouping)', state: 'rejected', num: 467, at: '2026-07-30T18:15:43Z' },
    { title: 'Name the Pre-install column for the action', state: 'closed', num: 439, at: '2026-07-30T16:32:37Z' },
    { title: 'Say what Pre-install does, not how it is implemented', state: 'closed', num: 440, at: '2026-07-30T16:32:37Z' },
    { title: 'Stop offering to include every custom node', state: 'closed', num: 441, at: '2026-07-30T16:32:37Z' },
  ];
  expect(payload.recentlyClosed).toEqual(expected);
  expect(JSON.stringify(payload.recentlyClosed, null, 2)).toBe(JSON.stringify(expected, null, 2));
});

test('the cutoff filters dated rows and keeps undated ones', () => {
  const dated = buildPayload(
    { ...loadInputs('.'), recentCutoff: '2026-07-30T17:00:00Z' },
    'reference',
  );
  expect(dated.recentlyClosed.map((row) => row.num)).toEqual([391, 467]);

  // The synthetic terminal items carry no history at all: their `at` is null,
  // and they survive any cutoff — dropping them would silently lose finished
  // work. i-rejected leads because reverse flips the board order of the tie.
  const undated = buildPayload(
    { ...loadInputs('synthetic'), recentCutoff: '2999-01-01T00:00:00Z' },
    'reference',
  );
  expect(undated.recentlyClosed).toEqual([
    { title: 'item i-rejected', state: 'rejected', num: null, at: null },
    { title: 'item i-closed', state: 'closed', num: 702, at: null },
  ]);
});

// ── App mode: the declared divergences, ported from CardBuilderGoldenTests ────

test('an approved PR whose checks are still running is not yet mergeable', () => {
  const cards = byId(loadInputs('synthetic'), 'app');

  // The reference calls this "Mergeable"; branch protection would refuse it.
  expect(cards.get('i-mergeable-running')?.pill).toEqual({ label: 'CI running', tone: 'review' });
  expect(cards.get('i-mergeable-running')?.whereItsAt).toBe(
    'Approved. Waiting on the checks to finish.',
  );

  // It sorts below the PRs that really can be merged now.
  expect(TONE_RANK[cards.get('i-mergeable')!.pill.tone]).toBeLessThan(
    TONE_RANK[cards.get('i-mergeable-running')!.pill.tone],
  );

  // ...and the cards it must leave alone.
  expect(cards.get('i-mergeable')?.pill, 'a green approved PR is still mergeable').toEqual({
    label: 'Mergeable', tone: 'good',
  });
  expect(
    cards.get('i-conflicts-running')?.pill,
    'a conflicting branch is the more actionable problem than a running check',
  ).toEqual({ label: 'Conflicts', tone: 'bad' });
  expect(
    cards.get('i-in-review')?.pill,
    "running checks do not override an unapproved PR's review state",
  ).toEqual({ label: 'In review', tone: 'review' });
});

test('a red check outranks In review and No reviewer, which the reference lets win', () => {
  const cards = byId(loadInputs('synthetic'), 'app');

  expect(cards.get('i-in-review-red')?.pill).toEqual({ label: 'CI red', tone: 'bad' });
  expect(cards.get('i-no-reviewer-red')?.pill).toEqual({ label: 'CI red', tone: 'bad' });
  expect(cards.get('i-in-review-red')?.whereItsAt).toBe(
    'A check is failing — it cannot merge until that is green.',
  );
  expect(cards.get('i-no-reviewer-red')?.whereItsAt).toBe(
    'A check is failing — it cannot merge until that is green.',
  );

  // ...and the cards it must leave alone.
  expect(cards.get('i-changes-red')?.pill, "a reviewer's request still outranks a red check").toEqual(
    { label: 'Changes req', tone: 'bad' },
  );
  expect(cards.get('i-draft-red')?.pill, 'a draft is still a draft').toEqual({
    label: 'Draft', tone: 'mute',
  });
  expect(cards.get('i-ci-red')?.pill).toEqual({ label: 'CI red', tone: 'bad' });
  expect(
    cards.get('i-ci-red')?.whereItsAt,
    "an approved PR keeps the reference's more specific line",
  ).toBe('Approved. Only the failing check is holding it.');
  expect(cards.get('i-in-review')?.pill, 'a green PR in review is untouched').toEqual({
    label: 'In review', tone: 'review',
  });
  expect(cards.get('i-no-reviewer')?.pill).toEqual({ label: 'No reviewer', tone: 'you' });
  expect(cards.get('i-blocked')?.pill, 'agent state still comes first').toEqual({
    label: 'Blocked', tone: 'you',
  });
});

test('drops closed and rejected items, as the reference does', () => {
  const items = readBoardItems(join(fixturesDir, 'synthetic', 'board.json')).value;
  const payload = buildPayload(minimalInputs(items), 'app');

  expect(items).toHaveLength(29);
  expect(payload.cards).toHaveLength(27);
  expect(payload.cards.some((card) => card.id === 'i-closed' || card.id === 'i-rejected')).toBe(
    false,
  );
});

test('the two modes disagree only where a divergence or rewording is declared', () => {
  // The Swift golden asserts a divergence count; the same fence here is the
  // exact id set, so a disagreement that is not on the list names itself.
  for (const { fixture, expected } of [
    // itm_466 is a draft: only its "at" line is reworded. itm_438's agent
    // raised needsOperator at the gate with no question —
    // Divergence.needsYouIsAQuestionOrABlock keeps it off the top in app mode.
    { fixture: '.', expected: ['itm_438', 'itm_466'] },
    // Three divergences (as the Swift golden counts) plus the rewordings — the
    // "PR Gone" label, the draft line on both draft cards — and i-needs, whose
    // flag rides no question or block, so app mode stands it down.
    {
      fixture: 'synthetic',
      expected: [
        'i-draft', 'i-draft-red', 'i-gone',
        'i-in-review-red', 'i-mergeable-running', 'i-needs', 'i-no-reviewer-red',
      ],
    },
  ]) {
    const inputs = loadInputs(fixture);
    const reference = byId(inputs, 'reference');
    const app = buildPayload(inputs, 'app');
    const differing = app.cards
      .filter((card) => {
        // previewPending is the one key app mode adds — a declared difference
        // of shape, stripped here so only differences of value name themselves.
        const { previewPending: _pending, ...rest } = card;
        return JSON.stringify(rest) !== JSON.stringify(reference.get(card.id));
      })
      .map((card) => card.id)
      .sort();
    expect(differing).toEqual(expected);
  }
});

test('Needs you takes a question or a block, not the routine gate', () => {
  const gate = (over: Record<string, unknown>) => {
    const item: BoardItem = { id: 'i', title: 't', state: 'awaiting-approval', workspaceId: 'ws' };
    const inputs = {
      ...minimalInputs([item]),
      agents: [{ workspaceId: 'ws', state: 'awaiting-approval', needsOperator: true, ...over }],
    };
    return {
      app: buildPayload(inputs, 'app').cards[0]!,
      reference: buildPayload(inputs, 'reference').cards[0]!,
    };
  };

  // An agent merely waiting at the gate renders by its item state and sorts
  // like the waiting it is; the reference keeps the raw flag.
  const waiting = gate({});
  expect(waiting.app.pill).toEqual({ label: 'At gate', tone: 'mute' });
  expect(waiting.app.needsOperator).toBe(false);
  expect(waiting.reference.pill).toEqual({ label: 'Needs you', tone: 'you' });

  // An unanswered question is the operator's, wherever the agent stands.
  const asking = gate({ questions: ['which base branch?'] });
  expect(asking.app.pill).toEqual({ label: 'Needs you', tone: 'you' });
  expect(asking.app.needsOperator).toBe(true);

  // A blocked agent still shouts.
  const blocked = gate({ state: 'blocked' });
  expect(blocked.app.pill).toEqual({ label: 'Blocked', tone: 'you' });

  // The flag off means off, questions or not — an answered question the agent
  // cleared the flag for must not resurrect the shout.
  const cleared = gate({ needsOperator: false, questions: ['answered'] });
  expect(cleared.app.pill).toEqual({ label: 'At gate', tone: 'mute' });
});

test('app mode rewords the labels and lines it inherited, without re-deciding', () => {
  const cards = byId(loadInputs('synthetic'), 'app');
  expect(cards.get('i-gone')?.pill).toEqual({ label: 'PR Gone', tone: 'mute' });
  expect(cards.get('i-draft')?.pill).toEqual({ label: 'Draft', tone: 'mute' });
  expect(cards.get('i-draft')?.whereItsAt).toBe('PR is open as draft');
});

test('app mode shortens awaiting-approval, and only app mode', () => {
  const item: BoardItem = { id: 'i-gate', title: 't', state: 'awaiting-approval' };
  const app = buildPayload(minimalInputs([item]), 'app').cards[0]!;
  const reference = buildPayload(minimalInputs([item]), 'reference').cards[0]!;
  expect(app.pill).toEqual({ label: 'At gate', tone: 'mute' });
  // The machine word, at its machine width — and the tone stays mute in both:
  // promoting it would move the card, not just relabel it.
  expect(reference.pill).toEqual({ label: 'awaiting-approval', tone: 'mute' });
});

// ── The inherited quirks, pinned one by one ───────────────────────────────────

test('an empty summary at the gate yields no line at all', () => {
  // jq: `"" | split("\n")[0]` is null. The synthetic fixture's gate agent has
  // no summary key (a different branch), so the quirk is pinned here.
  const item: BoardItem = { id: 'i', title: 't', state: 'pr-open', workspaceId: 'ws' };
  const inputs: BuildInputs = {
    ...minimalInputs([item]),
    agents: [{ workspaceId: 'ws', state: 'awaiting-approval', summary: '' }],
  };
  for (const mode of ['reference', 'app'] as const) {
    expect(buildPayload(inputs, mode).cards[0]?.whereItsAt).toBeNull();
  }
});

test("a false isDraft from GitHub does not erase the item's draft memory", () => {
  // jq's `//` skips false as well as null — but only the card's draft field
  // reads the item's memory; the pill trusts the live row alone.
  const item: BoardItem = {
    id: 'i', title: 't', state: 'pr-open',
    pr: { number: 1, isDraft: true },
  };
  const pr: PullRequest = { number: 1, title: 't', ciState: 'green', unresolvedThreads: 0, isDraft: false };
  const card = buildPayload(minimalInputs([item], [pr]), 'reference').cards[0]!;
  expect(card.draft).toBe(true);
  expect(card.pill.label).toBe('No reviewer');
});

test('a cloud item is running elsewhere, not missing', () => {
  const item: BoardItem = {
    id: 'i', title: 't', state: 'dispatched', host: 'cloud',
    workspaceId: 'ws-old',
    session: { id: 'sess-1', url: 'https://claude.ai/code/sess-1' },
  };
  const card = buildPayload(minimalInputs([item]), 'reference').cards[0]!;
  expect(card.whereItsAt).toBe('Running on claude.ai. Nothing pushed yet.');
  // The session wins over the stale local workspaceId: the live agent is the
  // one to open.
  expect(card.workspaceUrl).toBe('https://claude.ai/code/sess-1');
});

// ── Ticket links (app mode reads the tracker config; the reference cannot) ────

describe('ticket links', () => {
  function cardWith(
    source: BoardItem['source'],
    mode: CardMode,
    tracker?: BuildInputs['tracker'],
    linearWorkspace = 'acme',
  ): Card {
    const item: BoardItem = { id: 'i', title: 't', state: 'pr-open', source };
    const inputs = { ...minimalInputs([item]), linearWorkspace, tracker };
    return buildPayload(inputs, mode).cards[0]!;
  }

  test('Linear still links exactly as it did', () => {
    const card = cardWith({ kind: 'linear', externalId: 'ENG-1' }, 'app');
    expect(card.ticketKey).toBe('ENG-1');
    expect(card.ticketUrl).toBe('https://linear.app/acme/issue/ENG-1');
  });

  test('another tracker gets a key and a link from its own template', () => {
    const card = cardWith(
      { kind: 'markdown', externalId: 'regions-scaling' },
      'app',
      { kind: 'markdown', issueUrl: 'file:///tasks/{key}.md' },
    );
    expect(card.ticketKey).toBe('regions-scaling');
    expect(card.ticketUrl).toBe('file:///tasks/regions-scaling.md');
  });

  test('a key from a tracker the config does not name shows, but does not link', () => {
    const card = cardWith({ kind: 'jira', externalId: 'PROJ-9' }, 'app');
    expect(card.ticketKey).toBe('PROJ-9');
    // Better nowhere than somewhere wrong: linear.app/acme/issue/PROJ-9 is a
    // link, and it is a lie.
    expect(card.ticketUrl).toBeNull();
  });

  test('a synthesized PR has no ticket, only a pull request', () => {
    const card = cardWith({ kind: 'github', externalId: '#508' }, 'app');
    expect(card.ticketKey).toBeNull();
    expect(card.ticketUrl).toBeNull();
  });

  test('no workspace configured means the key shows with nothing behind it', () => {
    const card = cardWith({ kind: 'linear', externalId: 'ENG-1' }, 'app', undefined, '');
    expect(card.ticketKey).toBe('ENG-1');
    expect(card.ticketUrl).toBeNull();
  });

  test('the reference links linear and nothing else, tracker config or not', () => {
    const card = cardWith(
      { kind: 'markdown', externalId: 'regions-scaling' },
      'reference',
      { kind: 'markdown', issueUrl: 'file:///tasks/{key}.md' },
    );
    expect(card.ticketKey).toBeNull();
    expect(card.ticketUrl).toBeNull();
  });
});
