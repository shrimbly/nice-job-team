# Grouping — split, stack, merge, rank

The operator's failure mode is a single chat carrying six unrelated changes. Yours
would be a single workspace carrying them. This file is the discipline that stops
that.

## The test for one item

An item is correctly sized when all five are true:

1. **One sentence of outcome.** "The run history table fits ~40% more rows and each
   row states its own timing without a hover." If the sentence needs an "and also",
   it is two items.
2. **One reviewer would review it in one sitting.** Roughly: under ~400 changed
   lines, or larger only when the change is mechanical and uniform.
3. **One surface.** One component tree, one endpoint, one config system. Tests and
   locale files that follow the change do not count as extra surfaces.
4. **One rollback.** Reverting the PR should not undo something unrelated that
   happened to ride along.
5. **Verifiable without the other items.** If you cannot say how to check it on its
   own, it is not independent.

## Split

Split when you see any of these:

- **Different layers.** Schema/API change + UI that consumes it → two items,
  stacked. The UI item's brief cites the parent's shape.
- **Different reviewers.** If the natural reviewer differs, so should the PR.
- **Refactor + behaviour.** "Extract this composable" and "change what it does" are
  always two PRs. A reviewer cannot see the behaviour change inside the refactor
  diff, which is exactly how regressions get approved.
- **Mechanical + judgement.** A rename across 40 files plus one real decision:
  ship the rename alone first, then the decision.
- **Speculative extras.** Anything phrased "while we're in there" belongs in its own
  `proposed` item, not in the current brief.

When you split, write both items into `board.json` before dispatching either, and
say in the proposal that it was one signal split into two — the operator should see
the split, not discover it later as two PRs.

## Stack

A stack is a split with a hard ordering. Use it when the child genuinely cannot be
written against `main`.

```
parent  itm_010  schema: add quota field       branch dev/eng-166-quota-schema      base main
child   itm_011  UI: show quota in the header  branch dev/eng-167-quota-header      base dev/eng-166-quota-schema
```

Mechanics:

- Child gets `stackParent: itm_010` and `blockedBy: itm_010`.
- **Dispatch the child only once the parent's PR is open.** Before that the parent
  branch is a moving target and the child's diff will contain the parent's work.
- Child's brief must state: "Your base branch is X, which is under review as PR
  #N. Do not modify files owned by that PR; if you need a change there, stop and
  report it."
- When the parent merges, the child needs a rebase onto `main` and a base change:
  `gh pr edit <child> --base main`. Do this as a re-prompt to the child's agent, not
  yourself.
- Cap stacks at three deep. A four-deep stack means the split was wrong.

Prefer independent items to stacks. A stack is coordination cost you pay every
cycle; two unrelated PRs cost nothing.

## Merge

Merge signals — do not merge work. Two signals are the same item when they describe
the same change: a Linear issue and the Slack thread that produced it, a bug
reported twice, a PR comment restating an existing issue. Record the extra source
in the item's history rather than creating a second item.

Never merge two Linear issues into one workspace, even when they are adjacent.
Linear matches PRs to issues by branch name, and one branch can only carry one
issue's name. Two issues, two workspaces — stack them if they touch.

## Rank

Order the queue by, in this priority:

1. **Unblocking others.** An item something else is `blockedBy` outranks everything.
2. **Work already in flight.** `fixing` and review feedback beat anything unstarted
   — an open PR with three comments is 90% delivered, a new item is 0%.
3. **Operator-blocked items.** Anything in `blocked` or `awaiting-approval` should
   be surfaced before you propose new work. Do not start a fourth thing while three
   things wait on a human.
4. **Linear priority.** `urgent` > `high` > `medium` > `low`.
5. **Certainty.** Between two equals, dispatch the one whose outcome sentence is
   sharper.
6. **Age.** Break remaining ties with the oldest `updatedAt`.

## Concurrency

Cap concurrent non-terminal workspaces at `config.limits.maxActiveWorkspaces`
(default 4). The binding constraint is not compute — it is how many PRs the operator
can meaningfully validate in a day. Count `dispatched`, `building`,
`awaiting-approval`, and `fixing` toward the cap; `pr-open` counts at half, since it
is mostly waiting.

When at the cap, propose nothing new. Say what you would dispatch next and what has
to land first. A queue the operator can see is worth more than a queue you started.

## What not to dispatch

Send these back to the operator as a question instead:

- Anything whose outcome you had to guess at.
- Anything that needs a product or visual decision that is not already recorded
  (this operator's screenshots and stated intent are the source of truth for visual
  work — an agent inventing a design will waste a whole cycle).
- Anything touching auth, billing, secrets, migrations, or CI configuration.
- Anything where "done" depends on a service you cannot verify from here.
- Anything already open as someone else's PR.
