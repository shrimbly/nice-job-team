// Stacked-PR detection, ported from Sources/BoardKit/PRStack.swift. An agent
// that splits its work into a stack used to get a card per PR — the same piece
// of work three times over, in three places in the order. One agent is one
// answer to "what is everyone doing", so the chain is one card.

import type { PullRequest } from '../types.js';

/**
 * A chain of open PRs, each based on the head branch of the one below it.
 * `members` is bottom first: `members[0]` is based on something that is not an
 * open PR, and each one after it is based on the head of the one before. The
 * tip is the newest work — that is the card; a single unstacked PR is a
 * one-member stack.
 */
export interface PRStack {
  members: PullRequest[];
  bottom: PullRequest;
  tip: PullRequest;
  numbers: number[];
}

/**
 * The (repo, ref) index key. JSON.stringify rather than string concatenation so
 * a null repo can never collide with a repo whose name contains the delimiter —
 * and so null and undefined repos land on the same key, the way jq's `//` and
 * Swift's Optional treat the two spellings as one.
 */
function refKey(repo: string | null | undefined, ref: string): string {
  return JSON.stringify([repo ?? null, ref]);
}

/**
 * Groups open PRs into stacks.
 *
 * The rule is one sentence: *an open PR that no board item claims joins the
 * card of the PR it is based on.* Walking down from any PR gives the group it
 * belongs to — step to the PR below while the one you are standing on is
 * unclaimed — and everything that stops in the same place is one stack.
 *
 * A claimed PR always keeps its own card, which is what tells one agent's stack
 * apart from two agents who happen to have branched off each other. Desktop's
 * #1382 and #1384 are stacked and are two different items, two tickets and two
 * workspaces; folding them would throw half of that away. The loop stops at a
 * claimed PR from below and never starts on one.
 *
 * `claimed` is the PR numbers a board item owns. `landed` is the PRs poll.sh
 * has seen merge — not links: a stale open list would otherwise hang a whole
 * stack off a card that the assembler's landed filter then takes off the board,
 * and the PRs above it would vanish with it.
 */
export function detectStacks(
  pullRequests: PullRequest[],
  claimed: Set<number>,
  landed: Set<number> = new Set(),
): PRStack[] {
  const live = pullRequests.filter((pr) => !landed.has(pr.number));

  // Scoped to the repository. Two repos can have the same branch name — and
  // this operator's do, since the branches are named after the ticket — so a
  // bare head-to-base match would link PRs that have nothing to do with each
  // other.
  const below = new Map<string, PullRequest>();
  for (const pr of live) {
    const head = pr.headRefName;
    if (head == null || head === '') continue;
    const key = refKey(pr.repo, head);
    // First wins, so the pairing does not depend on the order `gh` answered
    // in. Two open PRs from one branch is GitHub refusing to happen.
    if (!below.has(key)) below.set(key, pr);
  }

  function parent(pr: PullRequest): PullRequest | null {
    const base = pr.baseRefName;
    if (base == null || base === '') return null;
    const found = below.get(refKey(pr.repo, base));
    if (found === undefined || found.number === pr.number) return null;
    return found;
  }

  // The bottom of a PR's group: down through the unclaimed PRs, stopping at
  // the first one that is claimed or that is not stacked on anything.
  function bottomOf(pr: PullRequest): PullRequest {
    let current = pr;
    // GitHub cannot produce a cycle, but this reads a file on disk that
    // anything could have written, and a cycle here would hang the app.
    const visited = new Set<number>([pr.number]);
    while (!claimed.has(current.number)) {
      const next = parent(current);
      if (next === null || visited.has(next.number)) break;
      visited.add(next.number);
      current = next;
    }
    return current;
  }

  const depths = new Map<number, number>();
  function depthOf(pr: PullRequest): number {
    const known = depths.get(pr.number);
    if (known !== undefined) return known;
    let steps = 0;
    let current = pr;
    const visited = new Set<number>([pr.number]);
    while (!claimed.has(current.number)) {
      const next = parent(current);
      if (next === null || visited.has(next.number)) break;
      visited.add(next.number);
      current = next;
      steps += 1;
    }
    depths.set(pr.number, steps);
    return steps;
  }

  const groups = new Map<number, PullRequest[]>();
  const order: number[] = [];
  for (const pr of live) {
    const root = bottomOf(pr).number;
    const group = groups.get(root);
    if (group === undefined) {
      order.push(root);
      groups.set(root, [pr]);
    } else {
      group.push(pr);
    }
  }

  return order.map((root) => {
    // Bottom first. The number breaks a tie between two PRs at the same
    // depth, which only a malformed chain produces, so that the order is
    // the same on every read.
    const members = [...(groups.get(root) ?? [])].sort(
      (a, b) => depthOf(a) - depthOf(b) || a.number - b.number,
    );
    return {
      members,
      bottom: members[0],
      tip: members[members.length - 1],
      numbers: members.map((member) => member.number),
    };
  });
}
