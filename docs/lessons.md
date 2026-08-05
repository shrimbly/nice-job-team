# Lessons

Each guard in the scripts exists because something failed. Before you remove a guard,
read this file. Most guards look unnecessary until you know what they prevent.

## Failures that destroyed data or hid work

### A jq error wrote an empty board

`board_set` put `--arg` before the filter. `jq` rejected the command. The write helper
accepted the empty output and replaced the board with nothing.

There are now two guards. `atomic_write` refuses an empty payload. `atomic_json` reads
both the exit status and the output before it replaces the file.

### A dispatch created an agent that nothing tracked

Without an item, `dispatch.sh` did not write to the board. It still created a
workspace, started an agent, and recorded nothing.

`poll.sh`, `sync.sh`, and `autoreap.sh` all read the item list. The work stayed
invisible until a person saw the workspace by hand.

`dispatch.sh` now refuses to run without `--item`.

### A hung cycle froze the board for twelve hours

One `watch.sh --once` stopped and never exited. The loop waits for each cycle, so no
cycle ran after it.

`watch.sh --status` reported `watching` for the whole time, because it read only the
process. Five pull requests merged while the board showed them as open.

There are now two guards. A watchdog stops a cycle that runs longer than three
intervals. `--status` judges the poller by the time of its last write, and it reports
`STALLED`.

### A reap almost deleted the repository

The main workspace of a project points at the real clone. An early version of
`reap.sh` did not refuse it.

`reap.sh` now compares `--git-dir` against `--git-common-dir`. The two are equal only
in the main checkout. `reap.sh` refuses that case. It also refuses to delete the
workspace that it runs inside.

### A stash blocked every reap

`refs/stash` is in the shared git directory. Each worktree lists the same stashes. One
forgotten stash on an unrelated branch made every workspace unreapable.

Deletion of a worktree does not change a stash. The test is now a warning.

## Failures that produced wrong reports

### A counter reported answered reviews as open questions

`poll.sh` read the first comment of each review thread. It never saw a reply, so it
gave each unresolved thread to the person who opened it.

An operator answered all the feedback on a pull request. The board still showed that
pull request as blocked. The orchestrator reported three open questions that were its
own replies.

`poll.sh` now reads the last comment as well. It divides `asks` from
`awaiting-rereview` by a comparison of the author against the operator.

### A stale status file moved a finished pull request backwards

An agent started a rebase and wrote `state: fixing`. The agent never wrote again.
`sync.sh` copied the status file over the item. A rebased, green, review-ready pull
request showed as work in progress. An operator corrected the item by hand, and the
next cycle undid the correction.

`sync.sh` now lets the observable pull request state win. The renderer held a second
copy of the same fault. It read the status file directly and printed `Fixing` over a
correct item.

### The guard against a stale status file hid a fresh one

`sync.sh` lets the observable pull request state win over an agent status file. An
agent writes `fixing` when the work starts, and often it never writes again.

Then an operator gave redesign feedback in the workspace chat instead of on GitHub.
The agent wrote `fixing` and started the work. Nothing on the pull request changed. So
the rule read the pull request as healthy and moved the item back to `pr-open` on each
cycle. The board reported an item as ready for review while an agent rewrote it.

The correction is a timestamp, not a new rule. The stale-status reasoning is true only
while the status file holds the older fact. `sync.sh` now compares the agent
`updatedAt` against the pull request `latestActivityAt`. When the agent wrote last, the
agent wins.

Each guard against stale data must know what "stale" means. A guard that assumes that
one side is always older is wrong half of the time.

### The board named a state that did not exist

The renderer labeled an item in `fixing` as `Dispatched`. That branch ran before each
pull request test. A pull request in its second round of review read as though nobody
had started it.

### A corrected application kept the fault, because a stale copy ran

The board application lost its ticket links. It showed pull request titles instead of
item titles. We found the cause, corrected it, and installed a new copy.

The fault stayed. The process on screen was a build from the worktree of the agent
that wrote the application, made hours before the correction. Nothing had stopped that
process, and nothing had started the installed copy.

There were two symptoms and one cause. Without a board to read, the application builds
each card from GitHub alone. A card built that way holds the pull request title and no
ticket, because its source is `github`. When the title format and the ticket link go
at the same time, the application does not read the board file.

After you correct an application, stop the process on screen. Then start the copy that
you installed. To name the binary that runs, use `ps aux | grep MacOS/Board`.

### A colleague was reported as the operator

A scout decided that a GitHub account belonged to the operator. The account belonged
to a colleague. The orchestrator repeated that decision as a fact. It reported about
thirty-eight pull requests as work by the operator. The true number was twenty-one.

A claim from a scout about identity is a hypothesis. Make sure that it is correct.

### The orchestrator overruled a scout and was wrong

A scout reported that a ticket asked for a design change that needed backend work. The
orchestrator disagreed, from its memory of a version of the ticket that it wrote hours
before.

The scout read the current ticket. The operator rewrote the ticket in between.

Read the ticket immediately before you write the brief. A scout that disagrees with
your memory of a ticket usually reads a newer one.

## Traps in the tools

### The same jq mistake, four times

Inside `index(...)`, `startswith(...)`, or any filter that rebinds the input, `.` is no
longer the object:

```jq
$merged | index(.pr.number)          # WRONG: .pr indexes the array
(.pr.number) as $n | $merged | index($n)   # correct
```

This fault occurred four times in one session, in four different files. Bind the value
before you test it.

### An apostrophe in a comment ends the script

A jq program inside a single-quoted shell string ends at the first apostrophe. A
comment that holds the words `the agent's state` closes that string. The shell then
reports a syntax error many lines later.

Write the comments in those blocks without an apostrophe.

### The tests pass against the wrong checkout

Many test harnesses hold one port and reuse a server that already runs. If you run the
end-to-end tests from a worktree, they test the checkout on that port. That checkout is
a different one.

The tests pass and the code is broken. Agents must never run those tests from a
worktree.

### Continuous integration does not run on a stacked branch

Continuous integration starts on a pull request that targets a main branch. A pull
request that targets another branch shows green, and nothing ran.

Do not read a green check on a stacked branch as a result.

### The GitHub CLI hides a repository that was renamed

`gh pr list --repo OLD/NAME` prints `[]` and exits zero. It does not follow the
rename. This output reads the same as "no open pull requests".

### ETags do not apply, and the rate limit was not the problem

We wrote a plan to add conditional requests to `poll.sh`. Then we dropped the plan,
because a measurement contradicted it.

The reasoning was that GitHub answers a conditional request with `304 Not Modified`,
and that a 304 does not use rate limit. That is true of the REST API, and `poll.sh`
does not use the REST API. `gh pr list --json …`, `gh pr view --json …` and `gh api
graphql` all use GraphQL. **GraphQL has no ETags and no conditional requests.**

The measurement also showed that the ceiling was much further away than the estimate:

| | |
|---|---|
| GraphQL budget | 5,000 points per hour |
| `gh pr list` with `statusCheckRollup` | 1 point |
| One cycle, four open pull requests | about 8 points |
| One project at 60 seconds | about 480 points per hour |

That budget holds about ten projects, not five.

Two rules follow. Measure the quota before you make it smaller. And a webhook is the
only way to get information faster than the poll interval, because nothing is cheaper
to poll.

### macOS has no `timeout`

The watchdog in `watch.sh` is a background sleeper that stops the cycle. `timeout` and
`gtimeout` are not present by default.

### `git merge-tree` has two forms

The deprecated three-argument form reported a branch as free of conflicts. The modern
`--write-tree` form found eleven conflicted files. A trial rebase found the same
eleven.

## What made the most difference

**The board is the record, not the chat.** Each context reset in this workflow was
survivable because the state was on disk.

**A guard is better than a rule.** A reader misses a rule in a document. The five-word
title limit was a rule, and somebody broke it within the hour. It held only after
`dispatch.sh` started to refuse a longer title.

**Give each ticket evidence.** The tickets that produced clean pull requests were the
ones where somebody read the code first. Tickets written from a meeting transcript
alone needed three corrections.

**A meeting transcript is not a source of fact.** A recording from one microphone gave
each line to one speaker. Three tickets named the wrong cause. The operator sent
screenshots, and only then did we correct them.

**Say what you did not test.** The agents that reported "end-to-end not run, needs a
real run before merge" were more useful than the agents that reported all green.
