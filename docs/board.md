# The board

The board is `~/.claude/superset-orchestrator/p/<key>/board.json`, one file per project.
The board is the record of the work in flight. When the board and the memory of the
orchestrator disagree, the board is correct.

## Writes are locked

The design gives one orchestrator session to each project. Two chats on one project is
an easy accident. Without a lock, the last write wins: both sessions read the same
board, both write it, and the items of the loser disappear. No error appears anywhere.

Each write to `board.json` takes a lock first. `shlock` comes with macOS. It records the
PID of the holder, and it clears a lock whose process is gone. A writer that cannot take
the lock within ten seconds stops. It then names the holder.

Only the board takes a lock. The signals and the rendered output are derived data. A
torn read of those costs one cycle and nothing more.

`board.version` counts up on each write, so a reader can see that the board moved.

## An item

```json
{
  "id": "itm_644",
  "slug": "eng-181-add-export-target",
  "title": "ENG-181 - Rename to Add export target",
  "domain": "exports-detail",
  "state": "pr-open",
  "priority": "medium",
  "source": { "kind": "linear", "externalId": "ENG-181" },
  "outcome": "The row-level Export button names the action it performs.",
  "repo": "acme/platform",
  "branch": "dev/eng-181-exports-tab-…",
  "baseBranch": "main",
  "blockedBy": null,
  "stackParent": null,
  "workspaceId": "26da60e9-…",
  "briefPath": "/Users/you/.claude/superset-orchestrator/briefs/eng-181-add-export-target.md",
  "pr": { "number": 507, "url": "https://github.com/…" },
  "history": [ { "at": "…", "from": "proposed", "to": "dispatched" } ],
  "createdByOrchestrator": true,
  "workspaceDrift": null
}
```

### Titles

A title has the form `<TICKET> - <five words maximum>`. `dispatch.sh` refuses any other
form.

A reader reads the board at a glance, in a narrow column. A title long enough to explain
the work pushes out the columns that carry the state. The five-word limit applies to the
description only, because the ticket number is an identifier.

Do not put the description after a colon. "Review step: CTA starts the build,
unambiguous size copy" is a summary that looks like a title.

| Write | Do not write |
|---|---|
| ENG-176 - Remove API key fields | Try it: stop asking a signed-in user for an API key |
| ENG-174 - Add requirements filter | Requirements step: add a real filter, stop Enter eating the query |

Put the full statement of intent in `outcome`. The body of the card shows that field.

## The states

| State | Meaning |
|---|---|
| `proposed` | the operator approved it, and nobody started it |
| `dispatched` | the workspace and the agent exist |
| `building` | the agent does the work |
| `awaiting-approval` | the agent is at the gate and needs the operator |
| `pr-open` | the pull request is open |
| `fixing` | the agent works on review feedback or on a conflict |
| `ready` | approved, green, mergeable, nothing unresolved |
| `merged` | the pull request merged |
| `closed` | the work is complete and the workspace is deleted |
| `orphaned` | the workspace is gone and the item is open |
| `rejected` | the operator declined it |

`ready` exists because `pr-open` covered each state from just-pushed to
approved-and-waiting. The one case that needs the operator looked the same as the five
cases that do not.

## The scripts

Each script is in `skills/superset-orchestrator/scripts/`.

| Script | Job |
|---|---|
| `setup.sh` | ask for the configuration, then write `config.json` |
| `preflight.sh` | test the CLI, the authentication, the host daemon, and the board directory |
| `poll.sh` | collect pull request state, continuous integration, threads, workspaces, agent status |
| `sync.sh` | fold what the agents and GitHub know back into the board |
| `dispatch.sh` | create a workspace, start an agent, record the item |
| `reap.sh` | delete a workspace after its work lands |
| `autoreap.sh` | reap the workspaces that the orchestrator created, without a question |
| `render-board.sh` | write `board.md` and `board.html` |
| `watch.sh` | run one cycle for each interval, in the background |

## How the board stays correct

Five things drift. Each one has a guard.

**An agent completes the work and does not write its status.** `sync.sh` compares the
status file against the live pull request state. If the pull request is open, has no conflict, and holds no unresolved question for
us, the work is complete. Even when
the file says something else, this rule holds. The board then records `sync: PR healthy, status
file stale`.

**A review thread that we already answered looks like an open question.** A count of the
unresolved threads is not enough. `poll.sh` reads the last comment in each thread. It
compares the author of that comment against `operator.githubLogins`. It reports `asks`,
where a reviewer spoke last, apart from `awaiting-rereview`, where we spoke last.
Without this division, each answered review makes a pull request look blocked.

**A merged pull request with no workspace stays at `pr-open` forever.** Automatic reap
reads only the items that still hold a workspace. `poll.sh` therefore collects the
recently merged pull requests as well as the open ones. `sync.sh` closes an item whose
number is in that list. Absence from the open list is not enough on its own. A rename, a change of
permission, and a failed poll all look the same.

The merged query returns the last 20. A pull request that merged before those 20, and
whose item never caught up, stays where it is.

**A status file outlives its workspace.** When a workspace no longer exists, `sync.sh`
deletes its status file. Two guards apply. The test runs only on a workspace list
that is not empty, so one authentication failure cannot delete every file. `sync.sh`
also deletes only a file that this board claims, because each project on the host shares
the inbox. "Not in my live list" also describes the agents of every other project.

**A workspace stays alive on a closed item.** `sync.sh` gives a warning and does
nothing, because some of these workspaces hold unpushed work. The warning names the reap
command. `sync.sh` skips the main checkout, which `reap.sh` refuses to delete by design.

## Maintenance

To run one cycle by hand, use this command:

```bash
~/.claude/skills/superset-orchestrator/scripts/watch.sh --once
```

To read the state of the poller, use this command:

```bash
~/.claude/skills/superset-orchestrator/scripts/watch.sh --status
```

`--status` judges the poller by the time of its last write. It does not judge the poller
by the presence of a process. A live process is not a poller that works. If the log is
older than three intervals, the command reports `STALLED` and gives the restart commands.

If the board becomes invalid, `preflight.sh` makes a backup and builds a new board. Each
write goes through `atomic_json`. That helper reads the result before it replaces the
file, so a failed edit leaves the board unchanged.

## Reading the board

`board.md` is a table. `board.html` is a dashboard. It reloads itself, and it links to
the pull request, the ticket, the preview deployment, and the Superset workspace.

The macOS application in this repository shows the same board in the menu bar.
