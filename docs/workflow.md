# The workflow

## The problem it solves

One chat that spans six areas of work finishes none of them cleanly. Context fills with
detail from unrelated tasks. The operator loses track of what is in flight. Work that is
almost done sits behind work that has not started.

The workflow separates the two jobs that one chat was doing. One agent holds the queue.
Other agents write the code. Neither does the work of the other.

## The three roles

**The operator** is the human. The operator approves every dispatch, reviews every pull
request, and merges. The operator is the only role that can merge.

**The orchestrator** holds the queue. It reads signals, groups them into single-area
tasks, proposes work, starts agents after approval, and watches what happens. It writes
only inside its own state directory. It never writes product code and never merges.

**The implementation agent** takes one brief and delivers one pull request. It works in
its own git worktree on its own branch. It cannot see the orchestrator chat and cannot
talk to other agents. Its brief is the whole contract.

## Why the orchestrator does not read the code

The orchestrator has one job that depends on a small context: it must run all day. A file
that it reads today reduces what it can hold tomorrow.

So the orchestrator sends a scout for anything that needs judgment about code. A scout is
a read-only agent that answers one question and returns JSON. A conclusion costs about 200
tokens. A file dump costs about 8,000.

This rule has a second effect that is more valuable than the first. It forces every
proposal to rest on evidence that somebody wrote down, instead of on a memory of a file.

## The loop

```
SENSE ──▶ GROUP ──▶ PROPOSE ──[approval]──▶ DISPATCH ──▶ WATCH ──▶ LAND ──▶ CLOSE
  ▲                                                        │
  └────────────────────────────────────────────────────────┘
```

**SENSE** collects the state of the world. A shell script gets pull request state,
continuous integration results, review threads, live workspaces, and agent status files.
This costs no model tokens. Scouts then answer the questions that need judgment.

**GROUP** turns signals into items. One item is one area of work, one reviewer, and one
pull request. Signals that describe the same change become one item. Work that spans
unrelated areas becomes two items.

**PROPOSE** is the approval gate. The orchestrator presents at most five items, each in
one line, and says what it is not proposing and why. It never starts work on silence.
Approval covers one round only.

**DISPATCH** creates a workspace, starts an agent in it, and records the item on the
board. The brief is written first, because the agent will never see the reasoning behind
it.

**WATCH** reads agent status files and pull request state. The orchestrator acts on
changes only. It does not ask agents how they are.

**LAND** is the operator merging.

**CLOSE** deletes the workspace after the pull request merges, and moves the item to
closed. Work that another item waited for becomes available.

## One workspace, one branch, one pull request, one area

This is the rule that makes the rest work.

A workspace is a git worktree. Two agents in one worktree conflict. Two areas of work in
one pull request produce a review that nobody can hold in their head.

When a proposed item needs changes in two unrelated areas, split it. When the split has a
real dependency, stack it: the child gets the parent branch as its base, and starts only
after the parent pull request is open.

## Agents write, the orchestrator reads

There is no message passing between the orchestrator and its agents.

Each agent writes a status file into a shared directory. The orchestrator reads those
files. This is the whole protocol.

The design has one failure mode that you must plan for. An agent writes its status when it
starts a piece of work. It often forgets to write again when the work finishes, so a stale
status says "fixing" long after the fix landed. For this reason the synchronize script
trusts observable pull request state over the status file. See `board.md`.

## What the orchestrator never does

These six limits are the design. An orchestrator that breaks them becomes the problem that
the workflow was built to solve.

1. It never writes product code.
2. It never reads repository source to understand an issue. It sends a scout.
3. It never starts a workspace without approval.
4. It never opens, merges, or closes a pull request.
5. It never deletes a workspace that holds unsaved or unpushed work.
6. It never widens an item. One workspace, one branch, one pull request, one area.

## What this costs

The workflow trades tokens for parallelism and for a queue that survives a context reset.

Every dispatch writes a brief. Every brief repeats context that the orchestrator already
holds, because the agent cannot see the chat. Scouts re-read files that another scout read
last week.

This is the correct trade when the work is wide and the reviews are the limit. It is the
wrong trade for one focused task. For one task, do the work in one chat.
