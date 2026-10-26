// StackTests.swift, case for case, against detectStacks directly. The Swift
// tests drive BoardAssembler end to end; here the grouping is its own module,
// so the assertions land on the stacks themselves — which PRs fold, in what
// order, and which stay apart. What the Swift cases say about the resulting
// card (its id, title, pill, sort) is the assembler's contract and is noted
// where it comes up.

import { describe, expect, test } from 'vitest';
import type { PRStack } from '../src/cards/stacks.js';
import { detectStacks } from '../src/cards/stacks.js';
import type { PullRequest } from '../src/types.js';

function pr(
  number: number,
  head: string,
  base: string,
  opts: { repo?: string; title?: string } = {},
): PullRequest {
  return {
    number,
    title: opts.title ?? `pr ${number}`,
    headRefName: head,
    baseRefName: base,
    url: `https://gh/${number}`,
    repo: opts.repo ?? 'acme/platform',
    ciState: 'green',
    unresolvedThreads: 0,
  };
}

function detect(
  prs: PullRequest[],
  opts: { claimed?: number[]; landed?: number[] } = {},
): PRStack[] {
  return detectStacks(prs, new Set(opts.claimed ?? []), new Set(opts.landed ?? []));
}

/** The board's own case: PRs 573 → 574 → 575, none of them orchestrated. */
function theStack(): PullRequest[] {
  return [
    pr(573, 'eng-584-primitives', 'main', { title: 'shared table primitives' }),
    pr(574, 'eng-584-audit-logs', 'eng-584-primitives', { title: 'rebuild Audit Logs' }),
    pr(575, 'eng-584-runs', 'eng-584-audit-logs', { title: 'a Runs view' }),
  ];
}

describe('folding', () => {
  test('three PRs stacked on each other are one card, not three', () => {
    const stacks = detect(theStack());

    expect(stacks).toHaveLength(1);
    expect(stacks[0].numbers).toEqual([573, 574, 575]); // bottom first
    expect(stacks[0].members).toHaveLength(3);
  });

  test('the card is the tip: the newest work, and the one that survives a merge', () => {
    // Naming the bottom would rename the card every time one landed, taking
    // its open/closed state and its place in the list with it. The assembler
    // synthesizes the id ("pr:acme/platform#575") from the tip; the tip's repo
    // and number are what it builds from.
    const { tip, bottom } = detect(theStack())[0];

    expect(tip.number).toBe(575);
    expect(tip.title).toBe('a Runs view');
    expect(tip.url).toBe('https://gh/575');
    expect(tip.repo).toBe('acme/platform');
    expect(bottom.number).toBe(573);
  });

  test('the order the PRs are handed over does not change the answer', () => {
    const forwards = detect(theStack());
    const backwards = detect([...theStack()].reverse());

    expect(backwards.map((s) => s.numbers)).toEqual(forwards.map((s) => s.numbers));
    expect(backwards[0].tip.number).toBe(forwards[0].tip.number);
  });

  test('every PR is on exactly one card, and none goes missing', () => {
    const extra = pr(600, 'unrelated', 'main');
    const stacks = detect([...theStack(), extra]);

    const accounted = stacks.flatMap((s) => s.numbers);
    expect([...accounted].sort((a, b) => a - b)).toEqual([573, 574, 575, 600]);
    expect(new Set(accounted).size).toBe(accounted.length);
  });
});

describe('what must not fold', () => {
  test('two stacked PRs that each have a board item stay two cards', () => {
    // The live case this had to get right: desktop's #1382 and #1384 are
    // stacked, and they are two items, two tickets, two agents and two
    // workspaces. Folding them would throw half of that away. (That each card
    // then keeps its item's identity is the assembler's half of the test.)
    const stacks = detect(
      [
        pr(1382, 'eng-691-catch-up', 'acme-builder', { repo: 'acme/desktop' }),
        pr(1384, 'eng-693-file-menu', 'eng-691-catch-up', { repo: 'acme/desktop' }),
      ],
      { claimed: [1382, 1384] },
    );

    expect(stacks).toHaveLength(2);
    expect(stacks.map((s) => s.numbers)).toEqual([[1382], [1384]]);
  });

  test('an unclaimed PR stacked on a claimed one joins its card without taking it over', () => {
    // One stack, rooted at the claimed 573. That the card keeps the item's id
    // and title rather than the tip's is the assembler's contract.
    const stacks = detect(theStack(), { claimed: [573] });

    expect(stacks).toHaveLength(1);
    expect(stacks[0].numbers).toEqual([573, 574, 575]);
  });

  test('a claimed PR in the middle splits the chain', () => {
    // 573 is based on main and unclaimed: its own card. 574 is claimed: its
    // own card, and 575 is stacked on it, so it joins.
    const stacks = detect(theStack(), { claimed: [574] });

    expect(stacks).toHaveLength(2);
    const byBottom = new Map(stacks.map((s) => [s.bottom.number, s]));
    expect(byBottom.get(573)?.numbers).toEqual([573]);
    expect(byBottom.get(574)?.numbers).toEqual([574, 575]);
  });

  test('PRs based on main are separate cards, and two stacks stay two', () => {
    const other = [pr(700, 'other-base', 'main'), pr(701, 'other-top', 'other-base')];
    const stacks = detect([...theStack(), ...other, pr(800, 'solo', 'main')]);

    expect(stacks).toHaveLength(3);
    expect(new Set(stacks.map((s) => s.members.length))).toEqual(new Set([3, 2, 1]));
    // First-appearance order of the roots, so the grouping never reshuffles
    // between reads of the same file. (The board's order is the sort the
    // assembler applies afterwards.)
    expect(stacks.map((s) => s.bottom.number)).toEqual([573, 700, 800]);
  });

  test('the same branch name in two repos does not link two PRs', () => {
    // The branches here are named after the ticket, so one name in two repos
    // is routine rather than contrived.
    const stacks = detect([
      pr(10, 'eng-584-primitives', 'main', { repo: 'acme/platform' }),
      pr(20, 'eng-584-runs', 'eng-584-primitives', { repo: 'acme/desktop' }),
    ]);

    expect(stacks).toHaveLength(2);
    expect(stacks.map((s) => s.numbers)).toEqual([[10], [20]]);
  });

  test('a PR poll.sh has seen merge does not take the stack above it off the board', () => {
    // The bottom of a stack lands first. A card is removed once its PR merges,
    // so hanging the others off it would take all three off the board at once
    // — and `gh` can still be reporting the merged one as open.
    const stacks = detect(theStack(), { landed: [573] });

    expect(stacks).toHaveLength(1);
    expect(stacks[0].tip.number).toBe(575);
    // The landed PR is gone, the rest are not.
    expect(stacks[0].numbers).toEqual([574, 575]);
  });

  test('a chain that refers back to itself terminates, and loses nothing', () => {
    // GitHub cannot produce this. The PRs are read from a file on disk that
    // anything could have written, and a cycle here would hang the app.
    //
    // There is no bottom to such a chain, so there is no card it can fold onto
    // and the two are left as they were. That is the point: the guard is about
    // terminating and about not dropping a PR, not about making sense of data
    // that has none.
    const stacks = detect([pr(1, 'a', 'b'), pr(2, 'b', 'a')]);

    const accounted = stacks.flatMap((s) => s.numbers);
    expect([...accounted].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  test('a PR based on its own branch is not stacked on itself', () => {
    const stacks = detect([pr(1, 'a', 'a')]);

    expect(stacks).toHaveLength(1);
    expect(stacks[0].numbers).toEqual([1]);
  });
});

// Not ported, deliberately — three StackTests cases assert on what the card
// says rather than on how the PRs group, and their subjects live elsewhere:
//
// - "the pill speaks for the tip, whatever state the rest of the stack is in"
//   (pillFollowsTheTip) and "a stack sorts on the tip's number, like any other
//   card" (sortsOnTheTip) are about the assembled card — the tip feeds the
//   build/sort chain — and belong with the assembler's tests.
// - "the chip counts the stack, and names a single PR" (chipLabels) tests
//   PRChipLabel, a piece of app UI with no CLI counterpart.
