# The orchestrator

The full contract is `skills/superset-orchestrator/SKILL.md`. This document explains the
parts that need reasons, and the configuration that controls them.

## State on disk

Everything durable lives under `~/.claude/superset-orchestrator/`. Nothing durable lives
in the chat.

One orchestrator session owns one project, so each project owns its own board and its own
poller. Two things stay global.

**Global, at the root:**

| Path | Owner | Contents |
|---|---|---|
| `config.json` | operator | repositories, project IDs, reviewers, cadence, gates, the agent budget |
| `workspaces/<id>.json` | **agents** | the status inbox, one file per agent |

`workspaces/` is global on purpose. The key is a workspace UUID, which is unique across
every project, so two projects cannot collide. It also means `status.sh` needs no
knowledge of projects: an agent writes to the same path whatever project it belongs to.

**Per project, in `p/<key>/`:**

| Path | Owner | Contents |
|---|---|---|
| `board.json` | orchestrator | the queue: every item, its state, its workspace, its pull request |
| `board.md`, `board.html` | orchestrator | the rendered board, rewritten every cycle |
| `briefs/<slug>.md` | orchestrator | the brief handed to each agent |
| `signals/*.json` | scripts | the most recent poll output |
| `log.jsonl`, `events.log` | scripts | append-only history |
| `watch.pid`, `watch.log` | scripts | that project's poller |

The orchestrator owns every file except `config.json` and the status files. It must not
rewrite `config.json` without saying so.

`repos[].key` names the directory. Omit it and the scripts derive it from the repository
name, so `acme/platform` becomes `acme-platform`.

## Choosing a project

Set `SUPERSET_ORCH_PROJECT=<key>` to select one. With exactly one repository configured
the scripts assume it. With more than one and no variable, they refuse.

They refuse rather than guess because a guess puts a dispatch on the wrong board, and the
agent then works from the wrong brief.

## The approval gate

The orchestrator asks before it starts work. It asks once per round, with at most five
items. It never treats approval from a previous round as approval for this one.

`gates.approveBeforeDispatch` controls this. Set it to `false` only when the operator asks
for that in words.

The other gates follow the same rule:

| Gate | Effect |
|---|---|
| `approveBeforeDispatch` | ask before any workspace starts |
| `approveBeforePrSubmission` | ask before an agent opens a pull request |
| `approveBeforeWorkspaceDelete` | ask before deleting a workspace the orchestrator did not create |
| `approveBeforeExternalWrites` | ask before writing to Linear, Slack, or GitHub |
| `autoReapOwnWorkspaces` | delete a workspace automatically after its pull request merges, for workspaces the orchestrator created |

## Concurrency

`limits.maxActiveWorkspaces` caps the number of live agents. `dispatch.sh` refuses to go
over it. The default is 15.

**This budget is global across every project, not per project.** Per-project caps multiply:
five projects with a cap of five is twenty-five agents feeding one human.

Two limits sit above it. The first is your review capacity. Agents that produce pull
requests faster than you can read them add queue, not throughput. The second is memory.
Each workspace is a full checkout with an agent session attached, so the machine usually
stops you before 15 does.

The count includes the states `dispatched`, `building`, `awaiting-approval`, and `fixing`.
An item at `pr-open` does not count, because the agent is finished and the operator holds
it.

## Briefs

The brief is the whole contract. The agent will not see the orchestrator chat, the
reasoning, or the conversation with the operator.

A good brief states:

- the outcome, in one sentence
- what is decided and must be done
- what is open and belongs to the agent
- what is out of scope, by name
- which files other agents hold, so the agent stays clear of them
- how to verify, with the commands
- a definition of done as a checklist

CAUTION: Read the ticket immediately before you write the brief. Tickets get rewritten.
Two briefs in one session were wrong at the moment of dispatch, because the operator
rewrote the tickets while the briefs were being written.

When a brief becomes wrong after dispatch, rewrite the file and put a warning at the top
that says the earlier version was wrong. Then tell the agent.

## How to continue an agent

`superset agents create --workspace <id>` does **not** continue an existing chat. It
starts a new session in the same worktree. The new session has the brief and the git
state, and none of the reasoning from the first run.

To continue the conversation, resume the Claude Code session by its identifier:

```bash
wt="$(superset workspaces get "$WS" --json | jq -r .worktreePath)"
dir="$HOME/.claude/projects/$(printf '%s' "$wt" | sed 's/[/.]/-/g')"
ls -lS "$dir"/*.jsonl        # the largest file is the session that did the work
(cd "$wt" && claude --resume <session-id> --dangerously-skip-permissions -p "…")
```

Two checks before you resume:

1. Verify that the worktree is not in the middle of a rebase or a merge. A cancelled
   session can leave one behind.
2. Pick the correct transcript. A workspace collects one file per session. Sort by size.
   The original is large. A new session is a few dozen lines.

To make the resumed session visible in the desktop application, start it through a
Superset terminal instead:

```bash
superset terminals create --workspace "$WS" \
  --command "claude --resume <session-id> --dangerously-skip-permissions"
```

A process started outside a Superset terminal writes to the Claude Code transcript. The
desktop application shows a terminal buffer, so it shows nothing. See `lessons.md`.

## Cadence

The orchestrator is event driven with a heartbeat. It does not poll in a loop.

`watch.sh --start --interval 60` runs one cycle per minute in the background. One cycle is
poll, then synchronize, then automatic reap, then render. A cycle takes about 14 seconds.

`watch.sh --start --all` starts one poller per configured project. They are separate
processes, each with its own pidfile, log and watchdog inside its own board directory.
That separation is the failure isolation: a project whose cycle hangs cannot stop any
other project from polling.

Between full cycles each poller watches the status inbox locally, every five seconds. An
agent writing its status is the one signal that costs no quota to detect, so agent state
reaches the board in about five seconds instead of waiting out the interval. Only
synchronize and render run on that path. Nothing on it touches the network.

Between cycles the orchestrator schedules its own wake-up. It matches the delay to what it
waits for. A short delay suits a run of continuous integration. A long delay suits a board
where every item is building or idle.

Notify the operator only when a human is needed: an approval gate, a blocked agent,
changes requested, a red build on an approved pull request, or a merge that unblocks other
work. Never notify to say that something is still building.

## Scouts

A scout is a read-only agent. It answers one question about one source and returns strict
JSON.

Rules for scouts:

- Never give a scout write access.
- Never ask a scout to fix anything.
- Give it the exact question and the exact JSON shape you want back.

A scout's claim is a hypothesis, not a finding. Two errors in one session came from
treating a scout's output as fact:

- A scout inferred that a GitHub account belonged to the operator. It belonged to a
  colleague. The reported pull request count was wrong by seventeen.
- A scout reported that a ticket asked for a design change that needed backend work. The
  orchestrator contradicted it from memory of an earlier version of the ticket. The scout
  had read the current ticket and was right.

Verify a scout's claim about identity, or about what a ticket says, before you act on it.
