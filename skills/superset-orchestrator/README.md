# Superset orchestration — operator's guide

Three skills and one subagent, built to stop a single chat from carrying six domains
of work at once.

| Piece | Lives at | Runs where |
|---|---|---|
| `superset-orchestrator` skill | `~/.claude/skills/superset-orchestrator/` | one long-lived session, in the main clone |
| `superset-implementer` skill | `~/.claude/skills/superset-implementer/` | inside each Superset workspace, loaded by the dispatched agent |
| `superset-setup` skill | `~/.claude/skills/superset-setup/` | once for each repository, in that repository |
| `superset-scout` subagent | `~/.claude/agents/superset-scout.md` | spawned by the orchestrator, read-only, returns JSON |
| board + state | `~/.claude/superset-orchestrator/` | on disk, shared by both |

Install all three with
`npx skills add shrimbly/nice-job-team --skill '*' --agent claude-code -g -y`. The scout
ships inside this skill, at `agents/superset-scout.md`, because skills.sh installs
skills and not subagents. `scripts/setup.sh` puts it in place.

## How the two halves talk

They do not message each other. The orchestrator reads; the agents write.

```
 orchestrator                             workspace agent
 ────────────                             ───────────────
 writes briefs/<slug>.md   ───────────▶   reads its brief
 reads workspaces/<id>.json  ◀──────────  writes status via status.sh
 reads gh / Linear / Slack                works, verifies, self-reviews
 relays approval           ───────────▶   gates, then opens the PR
 reap.sh on merge          ───────────▶   (workspace deleted)
```

That one-way file protocol is the whole design. There is no session to attach to, no
transcript to parse, and no agent that has to stay responsive to be understood.

## First run

```bash
# 1. the CLI needs its own login — the desktop app's session does not count
superset auth login

# 2. check and seed everything
~/.claude/skills/superset-orchestrator/scripts/preflight.sh

# 3. fill in config.json: repos, reviewers, Slack channels, limits
$EDITOR ~/.claude/superset-orchestrator/config.json
```

Then, in a session you keep open:

> orchestrate my queue

The skill loads, runs preflight and `poll.sh`, fans scouts out over Linear/Slack,
proposes a handful of single-domain items, and waits for your approval before it
starts anything.

## Config worth getting right before the first dispatch

- `repos[].name` must be the **current** GitHub name. `acme/website` was renamed
  to `acme/platform`, and `gh pr list --repo acme/website` returns `[]`
  silently rather than following the rename — a stale name looks exactly like "no
  open PRs".
- `repos[].reviewers` — without this, PRs open unassigned and sit for a day.
- `limits.maxActiveWorkspaces` (default 4) is a limit on **your** review capacity,
  not the machine's. Raise it only if you can validate that many PRs in a day.
- `gates.*` are all on by default. Approval before dispatch, before PR submission,
  and before deleting a workspace.

## The three gates

1. **Dispatch** — nothing gets a workspace without you saying yes.
2. **PR submission** — the agent finishes, verifies, self-reviews, then *stops*. It
   does not push and does not open a PR until you approve. This is your existing
   rule, encoded: commit to a branch, but never push or open a PR until you have
   validated it.
3. **Workspace deletion** — only after the PR is merged, and only when the worktree
   is clean, fully pushed, and stash-free. `reap.sh` refuses otherwise and has no
   `--force`.

## Daily shape

```bash
# a cheap, token-free look at everything in flight
~/.claude/skills/superset-orchestrator/scripts/poll.sh

# see the queue
cat ~/.claude/superset-orchestrator/board.md

# what happened yesterday
tail -20 ~/.claude/superset-orchestrator/log.jsonl | jq -c '{at,event,itemId}'
```

The orchestrator paces itself with `ScheduleWakeup` — tighter while CI is running or
a review is fresh, ~25 minutes when everything is either building or idle. It only
notifies you when a human is actually needed: an approval, a blocked agent, changes
requested, a red build on an approved PR, or a merge that unblocks a stack.

For unattended triage, either let it register a cron for a morning cycle, or use
Superset's own scheduler:

```bash
superset automations create --name "Weekday triage" --project <id> \
  --rrule "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0" \
  --agent claude --prompt-file ~/.claude/superset-orchestrator/briefs/_cycle.md
```

Superset automations create a **fresh workspace per run** and deliver at-least-once,
so that prompt must read `board.json` and act on state rather than assume it is the
first cycle.

## Using a different agent for the implementation side

`config.superset.agent` accepts any preset from `superset agents list` (`claude`,
`codex`, `amp`, `gemini`, `copilot`, …). Non-Claude agents will not load a Claude
skill, so for those, drop
`~/.claude/skills/superset-implementer/reference/AGENTS-snippet.md` into the repo's
`AGENTS.md` (or paste it above the brief) — it carries the same contract in a form
any agent can read.

## Scripts

| Script | Does | Refuses when |
|---|---|---|
| `preflight.sh` | verify + seed; prints `READY` / `BLOCKED:` | CLI missing, not logged in, `gh` unauthenticated, config unparseable |
| `poll.sh` | GitHub PRs/CI/threads, workspaces, agent status, session liveness, deltas | never — degrades and warns |
| `dispatch.sh` | create workspace + start agent + record on the board | no brief, wrong item state, stack parent not yet in review, duplicate branch, over the active cap |
| `reap.sh` | delete a landed workspace, tidy the branch, close the item | PR not merged, worktree dirty, unpushed commits, stashes present |
| `status.sh` (implementer) | the agent's status file | unknown state values; missing file on write |

All are idempotent, all take `--dry-run` where they change anything, and all write
JSON atomically with a validity check — a failed `jq` leaves the board untouched
rather than truncating it.

## Files you will actually look at

- `~/.claude/superset-orchestrator/board.md` — the queue, one table
- `~/.claude/superset-orchestrator/briefs/<slug>.md` — what an agent was told
- `~/.claude/superset-orchestrator/workspaces/<id>.json` — what an agent is doing
- `~/.claude/superset-orchestrator/log.jsonl` — what happened
