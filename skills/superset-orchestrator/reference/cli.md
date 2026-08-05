# Superset CLI — the parts an orchestrator needs

Verified against **CLI v1.17.0** installed at `~/.superset/bin/superset` on
2026-07-30, cross-checked against <https://docs.superset.sh/cli/cli-reference>.
Re-verify with `superset <cmd> --help` before relying on any flag: the published
docs run ahead of the shipped binary (see *Sharp edges*).

`~/.superset/bin` may not be on `PATH` in non-login shells. Every script here
exports it. If you invoke the CLI directly, do the same:

```bash
export PATH="$HOME/.superset/bin:$PATH"
```

## Environment inside a workspace agent session

Verified by inspecting a live Superset-launched Claude session (2026-07-30). The
published env-vars page documents only the first two; the rest are real and useful.

| Variable | Example | Use |
|---|---|---|
| `SUPERSET_WORKSPACE_ID` | `4a99f362-…` | **the status file key.** Present in every agent session |
| `SUPERSET_WORKSPACE_PATH` | `/Users/you/…/website` | the worktree this session owns |
| `SUPERSET_ROOT_PATH` | `/Users/you/…/website` | repository root |
| `SUPERSET_AGENT_ID` | `claude` | which agent preset is running |
| `SUPERSET_TERMINAL_ID` | `b00ac049-…` | the PTY session id |
| `SUPERSET_HOME_DIR` | `/Users/you/.superset` | config + host tree |
| `SUPERSET_HOST_AGENT_HOOK_URL` | `http://127.0.0.1:48004/…` | internal; do not call |
| `SUPERSET_API_KEY` | `sk_live_…` | headless auth, if the operator sets it |
| `GH_TOKEN` / `GITHUB_TOKEN` | — | read by the `gh` the host shells out to for PR checkout |

`[ -n "$SUPERSET_WORKSPACE_ID" ]` is the reliable test for "am I inside a Superset
workspace". Setup/teardown scripts get a different, smaller set:
`SUPERSET_ROOT_PATH`, `SUPERSET_WORKSPACE_NAME`, `SUPERSET_WORKSPACE_PATH`.

Per-project setup/teardown lives in `.superset/config.json` at the repo root:

```json
{ "setup": ["npm install"], "teardown": ["docker compose down"], "run": ["npm run dev"] }
```

Resolution order is `~/.superset/projects/<repo-path>/config.json` (user override) →
`<worktree>/.superset/config.json` → `<repo>/.superset/config.json`. A
`.superset/config.local.json` (gitignored) can extend the team's arrays with
`before` / `after`. If a repo has no setup script, pass `--command "npm install"` on
`workspaces create` instead — otherwise the agent's first act is a cold install.

## Output modes

`--json` for parsing, `--quiet` for IDs only. **JSON is auto-enabled when
`CLAUDE_CODE`/`CLAUDECODE` is set**, which means it is on for you by default —
pass `--quiet` deliberately if you want bare IDs. Lists return arrays, get/create/
update return objects, empty results return `null` (not `[]` — guard for it).

## Auth and host

```bash
superset auth login                     # browser OAuth → ~/.superset/config.json
superset auth login --api-key sk_live_… # headless
superset auth whoami                    # { userId, email, organizationId, … }
superset status                          # host daemon: running, healthy, port, hostId
superset start --daemon                  # start the host service detached
```

The desktop app stores its own token (`~/.superset/auth-token.enc`). The CLI reads
`~/.superset/config.json`. **An authenticated app does not authenticate the CLI.**

## Projects

```bash
superset projects list --local --json     # → [{ id, name, repo, path }]
```

`id` is what every `--project` flag wants. Cache it in `config.json` per repo;
don't look it up every cycle.

## Workspaces (the unit of work)

```bash
superset workspaces create \
  --local \
  --project <projectId> \
  --name "<short-workspace-name>" \
  --branch <branch> \
  --base-branch <forkFrom> \
  --agent claude \
  --prompt "<opening prompt>" \
  --json
```

- `--branch` **or** `--pr <number>` is required. `--pr` checks out the verified PR
  head — that is the right way to open a review-fix workspace for someone else's PR.
- `--base-branch` only matters when `--branch` does not yet exist. Defaults to the
  project default branch.
- `--prompt` is **required when `--agent` is set**, and vice versa.
- `--command "<shell>"` runs a shell command in the new workspace instead of / as
  well as an agent. Useful for `npm install` when a project has no setup script.
- `--attachment <path>` uploads a local file for the agent (repeatable). Use it for
  remote hosts; for local workspaces a plain file path in the prompt is simpler.

```bash
superset workspaces list --local --json                     # → array
superset workspaces list --project website -s eng-142       # filter/search
superset workspaces get <id> --json                         # single
superset workspaces get --field worktreePath                # raw field, inside a workspace
superset workspaces update <id> --task-id <taskId>          # link to a task
superset workspaces update <id> --clear-task
superset workspaces delete <id> [<id>…]                     # destructive
superset workspaces open <id>                               # focus in desktop app
superset workspaces open <id> --print                       # deep link only
```

Worktrees live at `~/.superset/worktrees/<projectId>/<workspace-name>`. One branch
= one workspace; you cannot have two workspaces on the same branch.

`workspaces delete` is the teardown path — it runs the project's `teardown`
commands and removes the worktree. It will take uncommitted work with it. Always
check `git -C <worktreePath> status --porcelain` and the branch's push state first
(`scripts/reap.sh` does).

## Agents

```bash
superset agents list --local --json      # presets + configured instances
superset agents create \
  --workspace <workspaceId> \
  --agent claude \
  --prompt "<prompt>" \
  --json                                 # → { sessionId, kind, … }
```

`--agent` takes a preset id (`claude`, `codex`, `amp`, `gemini`, `copilot`, …), a
HostAgentConfig instance UUID, or `superset` for a built-in Superset chat session.

**`agents create` is how you continue a conversation with a running workspace.**
It adds a session to the existing worktree, so the agent keeps its files and its
branch. Prefer it over creating a second workspace for the same item.

A session created this way syncs to the desktop app but has no pane until you
navigate to it. Build the deep link yourself when you want the operator to land
straight on it:

```
superset://v2-workspace/<workspaceId>?chatSessionId=<sessionId>
superset://v2-workspace/<workspaceId>?terminalId=<sessionId>     # kind: terminal
```

## Terminals

```bash
superset terminals create --workspace <id> --command "npm test" --cwd ./ --json
```

A PTY in the workspace. Good for cheap verification you want visible in the app
(a test run the operator can watch) without spending agent tokens.

## Tasks (Superset's own tracker, Linear-aware)

```bash
superset tasks list --assignee-me --json
superset tasks list --project-name "Engineering" --sort-by updatedAt --json
superset tasks get <idOrSlug> --json
superset tasks create --title "…" --priority high --labels "a,b" --json
superset tasks update <idOrSlug> --pr-url https://github.com/o/r/pull/123 --status-id <id>
superset tasks statuses list --json      # get status IDs before using --status-id
superset tasks delete <idOrSlug>
```

`tasks list` exposes `--project` / `--project-name` / `--cycle` filters that are
described in the reference as *Linear* project and cycle — so tasks are the surface
where Superset mirrors Linear. Treat Linear (via its MCP tools) as the source of
truth for issue content and Superset tasks as the link between an issue and a
workspace (`workspaces update --task-id`).

## Automations (scheduled agent runs)

```bash
superset automations create --name "Weekday triage" \
  --project <projectId> \
  --rrule "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0" \
  --timezone Etc/UTC \
  --prompt-file ~/.claude/superset-orchestrator/briefs/_cycle.md \
  --agent claude --json
superset automations list --json
superset automations logs <id> --limit 20 --json
superset automations run <id>            # fire now, does not wait
superset automations pause|resume <id>
superset automations prompt get <id> > out.md
superset automations prompt set <id> --from-file ./prompt.md   # `-` for stdin
```

Semantics that will bite you:

- **Each run creates a fresh workspace** from the project repo. It is not a
  long-lived process, and it does not inherit any board state — the prompt must
  read `board.json` itself.
- **At-least-once delivery**: a run can fire twice. Every automation prompt must be
  idempotent.
- **Silently skipped when the target host is offline.** Check `automations logs`
  before assuming a cycle ran.
- Requires a v2 project linked to GitHub and an online host.

## Response shapes (they are not what you would guess)

Verified against v1.17.0 on 2026-07-30, after each one cost a mistake:

| Command | Returns | Not |
|---|---|---|
| `workspaces create` | `{workspace:{id,name,branch,…}, terminals:[…], agents:[{ok,kind,sessionId,label}], alreadyExists}` | `{id}` |
| `projects create` | `{projectId, repoPath, mainWorkspaceId}` | `{id, name, path}` |
| `agents create` | `{kind, sessionId, label}` — no top-level `ok` | `{ok:true,…}` |
| `workspaces list` | array with `projectId`, `projectName`, `worktreePath`, `worktreeExists` | — |

Read the id defensively: `.workspace.id // .id // .workspaceId`. A create that
"failed" because you parsed the wrong key has still created the thing — check before
you retry, or you get two.

**There is no `projects delete`.** `superset projects` has only `create`, `list` and
`setup`, so a duplicate project is permanent from the CLI. Always
`projects list --local --json | jq '.[] | select(.name=="…")'` before creating.

## Running an agent with custom flags

Agent presets are fixed commands (`claude`, `codex`, `amp`, `gemini`, `copilot`) —
`agents list --local --json` shows `command` for each, and there is no flag for
appending arguments. So `--agent claude` cannot pass, say,
`--dangerously-skip-permissions`.

Use `--command` instead of `--agent`, which runs an arbitrary shell command in the
new workspace's terminal:

```bash
superset workspaces create --local --project <id> --name <n> --branch <b> \
  --command "claude --dangerously-skip-permissions \"<the opening prompt>\"" --json
```

The response then carries `terminals: 1, agents: 0` — that is expected and not a
failure. Confirm it really started with `ps -eo pid,etime,command | grep '[c]laude'`;
the session transcript directory under `~/.claude/projects/` does not appear until
the first turn completes, so its absence proves nothing in the first minute.

Keep the prompt to a single line of plain ASCII — it survives two levels of quoting
that way. Everything else belongs in the brief file.

## Sharp edges

- **Docs ahead of binary.** The published reference documents `--effort
  <low|medium|high|xhigh|max>` on `workspaces create` and `agents create`;
  v1.17.0's `--help` does **not** list it. Probe before use:
  `superset agents create --help | grep -q -- --effort` and only then pass it.
- **`superset <group> <sub> --help` fails under zsh word-splitting** if you build
  the command from an unquoted variable — zsh does not split unquoted expansions.
  Write the words out, or use `${=var}`.
- **Not-logged-in errors exit non-zero with a hint on stderr**, so `set -e` scripts
  die usefully; don't swallow stderr.
- **`--json` with an empty result gives `null`.** `jq -r '.[]'` on it errors. Use
  `jq -r '(. // []) | .[]'`.
- **Deleting a workspace is not reversible** and runs teardown. There is no
  archive-instead-of-delete flag.
- **`tasks` and `automations` are organization-scoped cloud features.** If the
  operator's plan does not include them, these commands fail while `workspaces`,
  `agents`, and `terminals` keep working. Degrade gracefully: the board on disk is
  the fallback tracker, and Linear is the fallback for tasks. Never block a
  dispatch because `tasks create` failed.

## Optional: the official Superset skills

```bash
npx skills add superset-sh/skills     # adds `superset` and `superset-mcp` skills
```

If those are installed, defer to them for CLI mechanics and MCP setup; this file
exists so the orchestrator works without them. The MCP server is an alternative to
shelling out — same 27-ish operations as tools:

```bash
claude mcp add superset --transport http https://api.superset.sh/api/v2/agent/mcp
```

Tools mirror the CLI: `workspaces_create`, `agents_create`, `tasks_*`,
`automations_*`, `projects_list`, `hosts_list`. Prefer the CLI in scripts (it is
cheaper and scriptable); prefer MCP when you want structured results without a
shell.
