# The dispatch brief

The brief is the entire contract. The agent that reads it has none of your context:
not this conversation, not the board, not the Linear thread, not the operator's
screenshots. Anything you leave out, it will either invent or ask about — and asking
costs a whole cycle.

Write it to `~/.claude/superset-orchestrator/briefs/<slug>.md`, then point the
opening prompt at it.

## The opening prompt (short, fixed shape)

```
Load the superset-implementer skill, then read your brief at
~/.claude/superset-orchestrator/briefs/<slug>.md and follow it.
You are itm_007 / ENG-142 on branch dev/eng-142-…, based on main.
Write your status file before you start work.
```

Keep it to that. Long `--prompt` strings get mangled by shell quoting, cannot be
revised, and are invisible to you afterwards. The file can be corrected; the prompt
cannot.

## The brief template

````markdown
# <slug> — <one-line title>

- **Item:** itm_007
- **Source:** Linear ENG-142 — https://linear.app/acme/issue/ENG-142/…
- **Repo:** acme/website (worktree you are already in)
- **Branch:** dev/eng-142-run-history-denser-more-informative-log-table
- **Base:** main
- **Reviewer (when the operator approves the PR):** @octocat
- **Domain:** run-history

## Outcome

One sentence, verifiable, no "and also":

> The run history table fits roughly 40% more rows on a 900px viewport, and each row
> states its own timing without needing a hover.

## Why this matters

Two or three sentences of the actual reason, in the operator's words where you have
them. The agent makes better judgement calls when it knows what the change is for.

## Scope

**In scope**
- components/RunsTable.vue row density and header
- the timing column's formatting
- locale keys for anything new

**Out of scope — do not touch**
- pagination behaviour (owned by itm_009)
- the run detail drawer
- anything under services/ or middleware/

If you believe something out of scope must change, stop and report it in your
status file's `questions`. Do not widen the diff.

## What is already known

Everything you would otherwise have to rediscover:
- The table is a hand-rolled CSS grid; `--table-grid` / `--table-min-width` drive
  the columns.
- `--overlay-*` tokens are translucent, so a sticky header needs the overlay
  layered over `--color-background` or rows show through it.
- Prior attempt: measuring geometry in JS was removed in 7054787 — do not bring it
  back; the fixed-height flex chain replaces it.

## Constraints

- Mock-first: define the experience against the existing dev mock
  (`?view=runs&mock=1`); no backend changes in this PR.
- PrimeVue only — this repo has no shadcn.
- Eight locales must stay key-for-key identical.
- Do not push and do not open a PR until the operator approves (your skill's
  approval gate).

## How to verify

Be specific enough that the agent does not have to guess what "done" looks like:
- `npm run test:unit -- RunsTable` green, plus a new case for row density.
- `npm run lint` and `npx nuxi typecheck` — report pre-existing failures separately
  from anything you introduced.
- `npm run format:check`.

**You are in a linked worktree: no dev server, no e2e.** Playwright hardcodes
`localhost:3000` with `reuseExistingServer`, so a run from here silently tests
another checkout. Record "not verified in a browser: worktree" — the Vercel preview
on the PR is how this gets looked at.

## Definition of done

- [ ] Outcome sentence is true and demonstrated
- [ ] Tests written for the behaviour that changed
- [ ] Full unit suite green; lint clean; no new type errors
- [ ] Manually verified in a browser, with the numbers recorded
- [ ] Diff contains nothing outside Scope
- [ ] Status file at `awaiting-approval` with summary, diffstat, risks
````

## Feedback briefs

When review comments land, write a **new** file
(`briefs/<slug>-feedback-<n>.md`) rather than editing the original — the agent
should be able to see what was asked and when.

```markdown
# <slug> — review feedback #2

PR #441, reviewed by @octocat at 2026-07-30T08:55Z.
Decision: CHANGES_REQUESTED. Unresolved threads: 3. CI: green.

## Asks (verbatim, with locations)

1. `components/RunsTable.vue:214` — "this recalculates on every scroll; can it be
   a computed?"
2. `tests/unit/components/RunsTable.spec.ts:88` — "assert the row count, not the
   class name"
3. General — "please rebase, main has moved"

## How to respond

- Address each thread, then reply to it on GitHub saying what you did (one line
  each). Do not resolve threads yourself — the reviewer resolves.
- If you disagree with an ask, say so in the thread with your reasoning and do it
  their way anyway unless it is a correctness problem; if it is, stop and report.
- Rebase onto main, force-push with `--force-with-lease` on your own branch only.
- Re-request review when green: `gh pr review --request @octocat` is not a
  command — use `gh pr edit <n> --add-reviewer octocat`.
- Update your status file to `pr-open` when you have pushed.
```

## Brief quality bar

Before you dispatch, reread the brief and ask: *if I knew nothing else, could I do
this work and know when I was finished?* The common failures, in order of how often
they waste a cycle:

1. No verifiable outcome — the agent ships something plausible and wrong.
2. No "out of scope" list — the diff sprawls and the reviewer rejects the shape.
3. No verification recipe — the agent tests what is easy, not what changed.
4. Missing known context — the agent rediscovers something the operator already
   learned, or reintroduces code that was deliberately deleted.
5. Missing reviewer — the PR sits unassigned for a day.
6. **A verification recipe the workspace cannot run.** Every brief must say which
   kind of workspace this is, because it changes what "verified" can mean:

   | Workspace | Verification the brief may ask for |
   |---|---|
   | linked worktree (`~/.superset/worktrees/…`) | unit, lint, typecheck, format. **No dev server, no e2e** — they reuse port 3000 and silently test another checkout. |
   | the main checkout | all of the above, plus dev server and e2e |

   Check before you write the brief:
   `git -C <worktreePath> rev-parse --git-dir` differing from `--git-common-dir`
   means linked. Asking a worktree agent to "open it in a browser" costs a cycle and
   invites a fabricated result.
