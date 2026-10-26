// The assembly layer's tests, ported case for case (and by name) from
// AssemblerTests.swift and MultiProjectTests.swift. GitHub is the required
// half of the board and the orchestrator's files are enrichment; these pin
// what happens as that enrichment comes and goes, and — for multi-project —
// the rule that replaced "show whichever board was written last": show every
// project, ordered by urgency across all of them.

import { describe, expect, test } from 'vitest';
import type { AssemblerConfig } from '../src/cards/assemble.js';
import {
  assemble,
  assembleOne,
  assemblerConfig,
  derivedKey,
  shortNameFor,
} from '../src/cards/assemble.js';
import { linearTicket } from '../src/cards/build.js';
import type {
  BoardItem,
  OrchestratorSnapshot,
  ProjectRef,
  PullRequest,
} from '../src/types.js';
import { CARD_KEYS, TONE_RANK } from '../src/types.js';

// No test here exercises stack folding on purpose — no PR below is based on
// another, so detectStacks answers singleton stacks and the assembler folds
// nothing. The chains themselves are pinned in stacks.test.ts; what belongs
// here is the seam, covered by the ProjectCard.stack default below.

// ── Fixtures ──────────────────────────────────────────────────────────────────

const prs: PullRequest[] = [
  {
    number: 10,
    title: 'ten',
    headRefName: 'feat/ten',
    url: 'https://gh/10',
    reviewDecision: 'APPROVED',
    mergeStateStatus: 'CLEAN',
    repo: 'o/r',
    ciState: 'green',
    unresolvedThreads: 0,
  },
  {
    number: 11,
    title: 'eleven',
    headRefName: 'feat/eleven',
    url: 'https://gh/11',
    isDraft: true,
    repo: 'o/r',
    ciState: 'green',
    unresolvedThreads: 0,
  },
];

function snap(
  items: BoardItem[],
  extra: Partial<Pick<OrchestratorSnapshot, 'agents' | 'workspaces' | 'mergedPRNumbers'>> = {},
): OrchestratorSnapshot {
  return {
    items,
    agents: extra.agents ?? [],
    workspaces: extra.workspaces ?? [],
    mergedPRNumbers: extra.mergedPRNumbers ?? new Set(),
    isPresent: true,
  };
}

/** OrchestratorSnapshot.absent: no orchestrator on disk at all. */
function absent(): OrchestratorSnapshot {
  return { items: [], agents: [], workspaces: [], mergedPRNumbers: new Set(), isPresent: false };
}

// ── AssemblerTests ────────────────────────────────────────────────────────────

describe('assembler', () => {
  test('githubOnly: with no orchestrator at all, every open PR still gets a card', () => {
    const cards = assembleOne(absent(), prs, 'acme');

    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.pill.label)).toEqual(['Mergeable', 'Draft']);
    expect(cards[0]?.title).toBe('ten');
    expect(cards[0]?.prUrl).toBe('https://gh/10');
    expect(cards[0]?.branch).toBe('feat/ten');
    // Nothing to link to but GitHub.
    expect(cards.every((card) => card.workspaceUrl === null && card.ticketUrl === null)).toBe(
      true,
    );
  });

  test('noDuplicates: a PR the orchestrator already tracks is not duplicated', () => {
    const snapshot = snap([
      { id: 'itm_10', title: 'tracked', state: 'pr-open', pr: { number: 10 } },
    ]);

    const cards = assembleOne(snapshot, prs, 'acme');

    expect(cards).toHaveLength(2);
    expect(cards.some((card) => card.id === 'itm_10' && card.title === 'tracked')).toBe(true);
    expect(cards.filter((card) => card.num === 10)).toHaveLength(1);
  });

  test('claimsByBranch: an item that has not recorded its PR number claims the PR on its branch', () => {
    // sync.sh may not have caught up, and a cloud item has no status file to
    // catch up from. Without the branch claim this PR got a second card of
    // its own, titled from GitHub instead of by the item.
    const snapshot = snap([
      { id: 'itm_10', title: 'T-1 - Tracked', state: 'pr-open', branch: 'feat/ten' },
    ]);

    const cards = assembleOne(snapshot, prs, 'acme');

    expect(cards.filter((card) => card.num === 10)).toHaveLength(1);
    const card = cards.find((c) => c.num === 10);
    expect(card?.id).toBe('itm_10');
    expect(card?.title).toBe('T-1 - Tracked');
    expect(card?.prUrl).toBe('https://gh/10');
    expect(card?.pill).toEqual({ label: 'Mergeable', tone: 'good' });
  });

  test('adoptionStaysInsideTheRepo: branch adoption never crosses repositories', () => {
    // Two repositories can hold the same branch name; the wrong repo's PR
    // must not pin its facts to this item's card.
    const twin: PullRequest = {
      number: 99,
      title: 'twin',
      headRefName: 'feat/ten',
      url: 'https://gh/99',
      repo: 'o/other',
      ciState: 'green',
      unresolvedThreads: 0,
    };

    // The ambiguous branch resolves to the repo the item names.
    const named = snap([
      { id: 'itm_10', title: 'T-1 - Tracked', state: 'pr-open', branch: 'feat/ten', repo: 'o/r' },
    ]);
    const namedCards = assembleOne(named, [...prs, twin], 'acme');
    expect(namedCards.find((card) => card.id === 'itm_10')?.num).toBe(10);

    // An item that names no repo adopts nothing from an ambiguous branch.
    const vague = snap([
      { id: 'itm_v', title: 'T-2 - Vague', state: 'pr-open', branch: 'feat/ten' },
    ]);
    const vagueCards = assembleOne(vague, [...prs, twin], 'acme');
    expect(vagueCards.find((card) => card.id === 'itm_v')?.num).toBeNull();
  });

  test('terminalDoesNotClaimByBranch: a terminal item does not claim by branch alone', () => {
    // A recorded number on a terminal item hides its PR by decision; a branch
    // match is too weak an inference to hide an open PR with.
    const snapshot = snap([
      { id: 'itm_10', title: 'T-1 - Closed', state: 'closed', branch: 'feat/ten' },
    ]);

    const cards = assembleOne(snapshot, prs, 'acme');

    expect(cards.some((card) => card.num === 10 && card.title === 'ten')).toBe(true);
  });

  test('abandonedStaysHidden: abandoned is terminal — hidden like closed and rejected, PR included', () => {
    const snapshot = snap([
      { id: 'itm_11', title: 'left behind', state: 'abandoned', pr: { number: 11 } },
    ]);

    const cards = assembleOne(snapshot, prs, 'acme');

    expect(cards).toHaveLength(1);
    expect(cards[0]?.num).toBe(10);
  });

  test("prTitleTravels: the PR's own title rides the project card, for the chip hover", () => {
    const snapshot = snap([
      { id: 'itm_10', title: 'T-1 - Tracked', state: 'pr-open', pr: { number: 10 } },
    ]);

    const cards = assemble([{ project: { key: '', root: '/' }, snapshot }], prs, {
      linearWorkspace: 'acme',
      shortNames: {},
      repoNames: {},
      ticket: linearTicket('acme'),
    });

    expect(cards.find((pc) => pc.card.id === 'itm_10')?.prTitle).toBe('ten');
    // A synthesized card is already titled from GitHub; repeating it says nothing.
    expect(cards.find((pc) => pc.card.num === 11)?.prTitle).toBeNull();
    // Unstacked PRs carry no stack — the count, not the emptiness, is what the
    // chip reads — and nobody dispatched either of these anywhere but local.
    expect(cards.every((pc) => pc.stack.length === 0 && pc.host === 'local')).toBe(true);
  });

  test('rejectedStaysHidden: a PR the orchestrator has closed or rejected stays hidden', () => {
    // The orchestrator hiding a PR is a decision about that PR; resurrecting
    // it as a GitHub-only card would quietly overrule the operator.
    for (const state of ['closed', 'rejected']) {
      const snapshot = snap([{ id: 'itm_11', title: 'rejected', state, pr: { number: 11 } }]);

      const cards = assembleOne(snapshot, prs, 'acme');

      expect(cards, `${state} should leave only PR 10`).toHaveLength(1);
      expect(cards[0]?.num).toBe(10);
    }
  });

  // ── Landed PRs leave the board ──────────────────────────────────────────────

  test('hiddenOnceMergedEvenWhileItemSaysOpen: a PR poll.sh has seen merged is off the board, before the item catches up', () => {
    // The real case: board.json still said state=pr-open for two PRs that had
    // already landed, so they sat there as "PR Gone".
    const snapshot = snap(
      [
        { id: 'itm_10', title: 'landed', state: 'pr-open', pr: { number: 10 } },
        { id: 'itm_11', title: 'still open', state: 'pr-open', pr: { number: 11 } },
      ],
      { mergedPRNumbers: new Set([10]) },
    );

    const cards = assembleOne(snapshot, prs, 'acme');

    expect(cards.map((card) => card.id)).toEqual(['itm_11']);
  });

  test('staysHiddenAfterItemCatchesUp: it stays hidden once the orchestrator moves the item to merged', () => {
    // Hiding on only one of the two signals makes a landed PR vanish and then
    // reappear as "Merged — reap" when the orchestrator gets round to it.
    for (const merged of [new Set<number>(), new Set([10])]) {
      const snapshot = snap(
        [
          {
            id: 'itm_10',
            title: 'landed',
            state: 'merged',
            workspaceId: 'ws-1',
            pr: { number: 10 },
          },
        ],
        { mergedPRNumbers: merged },
      );

      const cards = assembleOne(snapshot, [], 'acme');

      expect(cards, `merged item with poll.sh reporting ${[...merged].join()}`).toHaveLength(0);
    }
  });

  test('closedButNotMergedStillShows: an unmerged PR that left the open list is still shown', () => {
    // Closed without merging is worth seeing — it is not the same as landing.
    const snapshot = snap(
      [{ id: 'itm_99', title: 'closed unmerged', state: 'pr-open', pr: { number: 99 } }],
      { mergedPRNumbers: new Set([10]) },
    );

    const cards = assembleOne(snapshot, [], 'acme');

    expect(cards.map((card) => card.pill.label)).toEqual(['PR Gone']);
  });

  test('enrichment: agent status and workspace names enrich the card the item owns', () => {
    const snapshot = snap(
      // The item and the agent agree, so this stays a test about enrichment —
      // see stalePhaseIsLabelled for what happens when they do not.
      [
        {
          id: 'itm_10',
          title: 'tracked',
          state: 'building',
          workspaceId: 'ws-1',
          outcome: 'the outcome',
          source: { kind: 'linear', externalId: 'ENG-1' },
          pr: { number: 10 },
        },
      ],
      {
        agents: [
          {
            workspaceId: 'ws-1',
            state: 'building',
            phase: 'writing it',
            sessionLiveness: 'active',
            dirtyFiles: '3',
          },
        ],
        workspaces: [{ id: 'ws-1', name: 'the workspace' }],
      },
    );

    const card = assembleOne(snapshot, prs, 'acme').find((c) => c.num === 10);

    expect(card?.pill).toEqual({ label: 'Working', tone: 'agent' });
    expect(card?.workspace).toBe('the workspace');
    expect(card?.workspaceUrl).toBe('superset://v2-workspace/ws-1');
    expect(card?.ticketUrl).toBe('https://linear.app/acme/issue/ENG-1');
    expect(card?.whatItIs).toBe('the outcome');
    expect(card?.whereItsAt).toBe('writing it');
    expect(card?.liveness).toBe('active');
    expect(card?.dirty).toBe('3');
  });

  test("stalePhaseIsLabelled: a phase left behind by the item's own state is labelled, not read as live", () => {
    // An agent writes "fixing" when it starts and routinely never writes
    // again. sync.sh reconciles the item against the live PR, so when the two
    // disagree it is the status file that is behind — and its phase is
    // describing work that has already finished.
    const snapshot = snap(
      [
        {
          id: 'itm_10',
          title: 'tracked',
          state: 'pr-open',
          workspaceId: 'ws-1',
          pr: { number: 10 },
        },
      ],
      { agents: [{ workspaceId: 'ws-1', state: 'fixing', phase: 'rebasing onto main' }] },
    );

    const card = assembleOne(snapshot, prs, 'acme').find((c) => c.num === 10);

    expect(card?.whereItsAt).toBe('last agent update: rebasing onto main');
    // And the pill comes from the reconciled item, so the finished rebase does
    // not hold the card at "Fixing".
    expect(card?.pill).toEqual({ label: 'Mergeable', tone: 'good' });
  });

  test('encodesExplicitNulls: cards serialize every field, writing absent optionals as explicit nulls', () => {
    const cards = assembleOne(absent(), prs, 'acme');
    // Matching jq's shape is what lets app output diff against the dashboard:
    // the JSON round-trip drops undefined-valued keys, so 28 surviving keys
    // proves every absent optional went out as an explicit null — the jq's 27
    // plus the one app-mode key, previewPending, which is always set here.
    const objects = cards.map(
      (card) => JSON.parse(JSON.stringify(card)) as Record<string, unknown>,
    );
    expect(Object.keys(objects[0]!)).toHaveLength(28);
    expect(Object.keys(objects[0]!)).toEqual([...CARD_KEYS, 'previewPending']);
    expect(objects[0]!['workspaceUrl']).toBeNull();
    expect(objects[0]!['ticketKey']).toBeNull();
    expect(objects[0]!['previewPending']).toBe(false);
  });
});

// ── MultiProjectTests ─────────────────────────────────────────────────────────

describe('multi-project', () => {
  function ref(key: string): ProjectRef {
    return { key, root: `/tmp/${key}` };
  }

  function item(id: string, state: string, prNumber?: number): BoardItem {
    return {
      id,
      title: `${id} title`,
      state,
      ...(prNumber !== undefined ? { pr: { number: prNumber, url: null } } : {}),
    };
  }

  const config: AssemblerConfig = {
    linearWorkspace: 'acme',
    shortNames: { platform: 'platform', desktop: 'desktop' },
    repoNames: {},
    ticket: linearTicket('acme'),
  };

  const twoRepos: AssemblerConfig = {
    ...config,
    repoNames: { platform: 'acme/platform', desktop: 'acme/desktop' },
  };

  function pr(number: number, repo: string, title: string): PullRequest {
    return { number, title, repo, ciState: '', unresolvedThreads: 0 };
  }

  test('showsEveryProject: every project contributes cards, not just the newest board', () => {
    const cards = assemble(
      [
        { project: ref('platform'), snapshot: snap([item('itm_1', 'building')]) },
        { project: ref('desktop'), snapshot: snap([item('itm_9', 'building')]) },
      ],
      [],
      config,
    );

    expect(cards).toHaveLength(2);
    expect(new Set(cards.map((pc) => pc.project.key))).toEqual(new Set(['platform', 'desktop']));
  });

  test('idsDoNotCollide: an id repeated across projects still gives two distinct rows', () => {
    // Two orchestrators number their items independently, so this is not a
    // contrived case. A keyed renderer reuses a row for a repeated id, so one
    // card would have been drawn twice and the other never.
    const cards = assemble(
      [
        { project: ref('platform'), snapshot: snap([item('itm_4', 'building')]) },
        { project: ref('desktop'), snapshot: snap([item('itm_4', 'building')]) },
      ],
      [],
      config,
    );

    expect(cards).toHaveLength(2);
    expect(new Set(cards.map((pc) => pc.id)).size).toBe(2);
    expect(cards.map((pc) => pc.id).sort()).toEqual(['desktop:itm_4', 'platform:itm_4']);
  });

  test('sortsByUrgencyAcrossProjects: urgency wins over project, so a card needing you is never buried', () => {
    // The reason the board is not grouped by project: grouping would put this
    // draft above the blocked card, purely because of its heading.
    const blocked = item('itm_b', 'blocked');
    const draft = item('itm_d', 'building');

    const cards = assemble(
      [
        { project: ref('platform'), snapshot: snap([draft]) },
        { project: ref('desktop'), snapshot: snap([blocked]) },
      ],
      [],
      config,
    );

    const ranks = cards.map((pc) => TONE_RANK[pc.card.pill.tone]);
    expect(ranks, 'cards must be ordered by tone across projects').toEqual(
      [...ranks].sort((a, b) => a - b),
    );
  });

  test('orderIsStable: the order does not change between two identical reads', () => {
    const projects = [
      {
        project: ref('platform'),
        snapshot: snap([item('itm_1', 'building'), item('itm_2', 'building')]),
      },
      {
        project: ref('desktop'),
        snapshot: snap([item('itm_3', 'building'), item('itm_4', 'building')]),
      },
    ];
    const first = assemble(projects, [], config);
    const again = assemble(projects, [], config);
    expect(first.map((pc) => pc.id)).toEqual(again.map((pc) => pc.id));
  });

  test('noDuplicateAcrossProjects: a PR one project orchestrates is not invented again by the other', () => {
    // The board showed both: the item's card with its ticket title, and a
    // second card titled from the PR. Every project was handed the whole PR
    // list, and each saw the others' PRs as unclaimed.
    const cards = assemble(
      [
        { project: ref('platform'), snapshot: snap([item('itm_663', 'pr-open', 538)]) },
        { project: ref('desktop'), snapshot: snap([item('itm_cb1', 'pr-open', 1382)]) },
      ],
      [
        pr(538, 'acme/platform', 'feat(reports): build a report'),
        pr(1382, 'acme/desktop', 'chore(acmebuilder): merge main'),
      ],
      twoRepos,
    );

    expect(cards, 'one card for each PR, not one for each project').toHaveLength(2);
    expect(cards.map((pc) => pc.card.id).sort()).toEqual(['itm_663', 'itm_cb1']);
    expect(
      cards.some((pc) => pc.card.id.startsWith('pr:')),
      'no synthesized card: both PRs are claimed by an item',
    ).toBe(false);
  });

  test('synthesizesOnceForTheOwningProject: an unorchestrated PR is synthesized once, by the project owning the repo', () => {
    const cards = assemble(
      [
        { project: ref('platform'), snapshot: snap([]) },
        { project: ref('desktop'), snapshot: snap([]) },
      ],
      [pr(99, 'acme/desktop', 'a PR nobody tracked')],
      twoRepos,
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]?.project.key, 'attributed by repo, not by position').toBe('desktop');
    expect(cards[0]?.card.id).toBe('pr:acme/desktop#99');
  });

  // Adding a repository to the orchestrator hands the board every stale open
  // PR left in it. Those cannot be hidden by a state — they have no item to
  // hold one — so the ledger subtracts them here, where the card is invented.
  test('dismissedPRsAreNotSynthesized: a dismissed PR makes no card', () => {
    const withLedger: AssemblerConfig = {
      ...twoRepos,
      dismissed: new Set(['pr:acme/desktop#99']),
    };
    const cards = assemble(
      [
        { project: ref('platform'), snapshot: snap([]) },
        { project: ref('desktop'), snapshot: snap([]) },
      ],
      [pr(99, 'acme/desktop', 'a PR nobody tracked'), pr(100, 'acme/desktop', 'one still wanted')],
      withLedger,
    );

    expect(cards.map((c) => c.card.id)).toEqual(['pr:acme/desktop#100']);
  });

  // Any card can be dismissed, by its own id — including one an item stands
  // behind, which is why the subtraction is on the finished cards and not on
  // the synthesis. Dismissing it hides the card, not the item.
  test('dismissalReachesItemBackedCards: an item-backed card goes by its item id', () => {
    const claimed = item('itm_1', 'pr-open');
    claimed.pr = { number: 99, url: null };
    const cards = assemble(
      [{ project: ref('desktop'), snapshot: snap([claimed]) }],
      [pr(99, 'acme/desktop', 'a PR an item tracks')],
      { ...twoRepos, dismissed: new Set(['itm_1']) },
    );

    expect(cards).toHaveLength(0);
  });

  // And the PR reference is NOT the item's card id, so dismissing the pull
  // request does not reach the card the item titles.
  test('dismissingThePRDoesNotHideTheItemsCard: the ids are different things', () => {
    const claimed = item('itm_1', 'pr-open');
    claimed.pr = { number: 99, url: null };
    const cards = assemble(
      [{ project: ref('desktop'), snapshot: snap([claimed]) }],
      [pr(99, 'acme/desktop', 'a PR an item tracks')],
      { ...twoRepos, dismissed: new Set(['pr:acme/desktop#99']) },
    );

    expect(cards.map((c) => c.card.id)).toEqual(['itm_1']);
  });

  test('unownedPRStillAppears: a PR whose repo matches no project still gets exactly one card', () => {
    const cards = assemble(
      [
        { project: ref('platform'), snapshot: snap([]) },
        { project: ref('desktop'), snapshot: snap([]) },
      ],
      [pr(7, 'acme/unconfigured', 'from a repo nobody claims')],
      twoRepos,
    );

    expect(cards, 'must not vanish, and must not appear on every project').toHaveLength(1);
  });

  test('chipFallsBackToKey: the chip falls back to the key when config does not name the project', () => {
    const bare: AssemblerConfig = {
      linearWorkspace: 'acme',
      shortNames: {},
      repoNames: {},
      ticket: linearTicket('acme'),
    };
    const cards = assemble(
      [{ project: ref('unnamed'), snapshot: snap([item('itm_1', 'building')]) }],
      [],
      bare,
    );

    expect(cards[0]?.shortName).toBe('unnamed');
  });

  test('shortNameFromConfig: shortName is read from config, and defaults to the repo name', () => {
    // The Swift test writes config.json to disk because BoardConfig.load owns
    // the IO; here readConfig (config.ts) owns it, so the derivation is fed
    // the already-parsed file.
    const config = assemblerConfig({
      operator: { linearWorkspace: 'acme' },
      repos: [
        { name: 'Acme-Org/platform', key: 'acme-org-platform' },
        { name: 'Acme-Org/Desktop', key: 'acme-org-desktop', shortName: 'desk' },
      ],
    });

    // No shortName: the part after the slash, not the whole "owner/name".
    expect(shortNameFor(config, 'acme-org-platform')).toBe('platform');
    expect(shortNameFor(config, 'acme-org-desktop')).toBe('desk');
  });

  test('derivedKeyMatchesSetup: the derivation mirrors setup.sh, and an explicit key still wins', () => {
    // setup.sh: tr '[:upper:]' '[:lower:]' | sed 's#[^a-z0-9]\{1,\}#-#g'
    expect(derivedKey('acme/platform')).toBe('acme-platform');
    expect(derivedKey('acme/Widget-Desktop')).toBe('acme-widget-desktop');

    // A real config had `key: acme-desktop` against that same repo, which
    // the derivation does not produce. The directory under p/ follows the key,
    // so deriving when a key is written would look in a directory that is not
    // there and show the project as having no work.
    const config = assemblerConfig({
      repos: [{ name: 'acme/Widget-Desktop', key: 'acme-desktop' }],
    });
    expect(shortNameFor(config, 'acme-desktop')).toBe('Widget-Desktop');
  });
});
