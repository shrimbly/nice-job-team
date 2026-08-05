# The implementation agent

The full contract is `skills/superset-implementer/SKILL.md`. This document explains the
parts that matter most, and the traps that a worktree creates.

## What the agent gets

The agent starts with an opening prompt that says two things: load the implementer skill,
and read the brief at this path. Everything else is in the brief.

The prompt is short on purpose. A long prompt gets mangled, and it cannot be revised after
the agent starts. A brief is a file, so the orchestrator can rewrite it.

## The status file

The status file is the only channel back to the orchestrator. The agent writes it. Nothing
reads the agent's chat.

```bash
S=~/.claude/skills/superset-implementer/scripts/status.sh
$S init --item <itemId> --slug <slug>
$S phase "orienting"
$S set '{"state":"pr-open"}'
```

The states are `building`, `awaiting-approval`, `pr-open`, `fixing`, and `blocked`.

### Write the status when work ends, not only when it starts

This is the failure that the workflow hit most often. The status file is not missing. It
is frozen in the middle of a task:

> `state: fixing`, `phase: "rebasing #477 onto main past #355"`

written when a rebase began, and never touched again. The rebase finished. The branch was
pushed. Continuous integration passed. The board still showed the work in progress.

So the last action in any phase is to write what happened. Write immediately after you:

- finish a rebase or resolve conflicts
- push anything that changes the pull request
- finish work on review feedback
- reach the approval gate, or become blocked

A phase in the present participle ("rebasing", "fixing") claims that the work is happening
now. If it is not happening now, the claim is false. Past tense is usually correct:
"rebased past #355, force-pushed, continuous integration green".

## A worktree is not the main checkout

An agent works in a git worktree. Three things behave differently there.

CAUTION: Do not run the development server or the end-to-end tests from a worktree. Many
test harnesses hardcode a port and reuse an existing server. The tests then run against a
different checkout and pass while your code is broken. Record end-to-end tests as not run,
and say that they need a real run before merge.

To find out whether you are in a worktree, compare the two git directories. They differ in
a worktree and match in the main checkout:

```bash
git rev-parse --git-dir
git rev-parse --git-common-dir
```

`refs/stash` lives in the shared git directory. Every worktree of the repository lists the
same stashes. Deleting a worktree does not delete a stash.

## The approval gate

The agent does not open a pull request on its own. It reaches a gate, writes a summary and
a diff statistic into its status file, and waits.

The summary must state:

- what changed, and why
- what was verified, with the command output
- what was not verified, and why
- anything that surprised it

The operator reads the summary and answers in the agent's own chat. The orchestrator
relays nothing.

## Quality

The bar is a pull request that a careful reviewer approves without asking for a rewrite.

- Match the surrounding code. Comment density, naming, and idiom.
- Report failures out loud, with the output. A failing test that is described as passing
  destroys the value of every other claim in the summary.
- Never print, commit, or paste secret values. Never put a credential in a pull request
  body or a test fixture. If you need a value that you do not have, ask for the name of
  the variable, not for the value.
- A visual change cannot be judged from a worktree. Say in the pull request body exactly
  what to look at on the preview deployment, and what the correct result looks like.

## Keep the issue tracker honest

The agent reports what it observes about the ticket. It does not write to the tracker.

```bash
$S set '{"linear":{"issue":"ENG-160","observedStatus":"Backlog","expected":"In Review"}}'
```

The orchestrator owns tracker writes. This keeps one writer, so two agents cannot fight
over one field.

## When several agents share one file

Large files attract several agents at once. In one session three agents held pull requests
against the same 3,721-line file.

The brief must carve the regions by line number and name the other holders:

> Your regions: the summary pane at 896 to 937, and the footer at 938 to 1000.
> ENG-171 owns 199 to 790. Do not touch it.
> ENG-174 owns 791 to 895. Do not touch it.

Every agent in a shared file must rebase on the main branch immediately before it opens a
pull request. Locale files and other append-only lists will still conflict. Tell the agent
to rebase and add its entry again, instead of resolving by hand.
