# Orchestrated agent workflow

This directory documents a workflow for parallel software development with AI agents.

One orchestrator agent holds the queue. Many implementation agents write the code. Each
implementation agent works in its own git worktree, on one branch, and delivers one pull
request. The orchestrator never writes product code.

The workflow was built and proved on the acme developer platform. It ran up to eight
agents at the same time and landed more than twenty pull requests.

## The documents

| Document | Contents |
|---|---|
| [workflow.md](workflow.md) | The model, the roles, and the six-phase loop |
| [orchestrator.md](orchestrator.md) | The contract for the orchestrator agent |
| [implementer.md](implementer.md) | The contract for each implementation agent |
| [board.md](board.md) | The board file, its states, and how to maintain it |
| [superset-cli.md](superset-cli.md) | The Superset CLI surface and its sharp edges |
| [lessons.md](lessons.md) | The failures that shaped every guard in the scripts |

Read `workflow.md` first. Read `lessons.md` before you change any script, because most of
the guards look unnecessary until you know what they prevent.

## The skills

The `skills/` directory at the root of this repository holds the two agent contracts and
all the scripts. Copy that directory to adopt the workflow.

```
skills/superset-orchestrator/    the orchestrator: SKILL.md, reference/, scripts/, agents/
skills/superset-implementer/     the implementation agent: SKILL.md, reference/, scripts/
skills/superset-setup/           the setup procedure: SKILL.md
```

The scout subagent ships inside the orchestrator skill, at
`superset-orchestrator/agents/superset-scout.md`. skills.sh installs skills, not
subagents, so `setup.sh` copies it to `~/.claude/agents/`.

## How to adopt this on a new project

You need the Superset CLI, the GitHub CLI, `jq`, and an issue tracker.

1. Install the skills.

   ```bash
   npx skills add shrimbly/nice-job-team --all -g
   ```

2. Log in to the Superset CLI. The login is a browser flow, so you must run it yourself.

   ```bash
   superset auth login
   ```

   The desktop application and the CLI share `~/.superset/`. They do not share the
   session. A signed-in application does not mean that `superset auth whoami` works.

3. Register the repository as a Superset project.

   ```bash
   superset projects create --repo-path /path/to/your/repo
   ```

   Setup finds the project ID by itself when the path matches. Record the ID only if
   you register the project some other way.

4. Go to the repository. Then ask your agent to set up the orchestrator. The
   `superset-setup` skill detects the repository, the main clone, the base branch and
   your GitHub login, asks for the rest, writes the configuration, installs the scout,
   and runs the preflight check.

   CAUTION: Setup reads `repos[].name` from `gh`, which follows a rename. Do not write
   that field by hand. The GitHub CLI returns an empty list for a renamed repository
   instead of following the rename, and a stale name looks the same as "no open pull
   requests".

5. Start the background poller. Use `--all` to start one per configured project.

   ```bash
   ~/.claude/skills/superset-orchestrator/scripts/watch.sh --start --interval 60
   ~/.claude/skills/superset-orchestrator/scripts/watch.sh --start --all
   ```

6. Start a chat with the orchestrator skill. Ask it to triage the queue.

## More than one project

One orchestrator session owns one project. Each project gets its own board, its own
briefs, and its own poller, in `~/.claude/superset-orchestrator/p/<key>/`.

Select a project with `SUPERSET_ORCH_PROJECT=<key>`. With exactly one repository
configured the scripts assume it.

Two things stay global: `config.json`, and the `workspaces/` status inbox. See
[orchestrator.md](orchestrator.md) for why the inbox is shared.

The agent budget is global as well. `limits.maxActiveWorkspaces` defaults to 15 across
every project, because per-project caps multiply.

## What the workflow needs from you

The orchestrator asks for approval before it starts any work. It never merges. These two
gates are the design, not a limitation.

Your review capacity is the real limit on throughput, not the number of agents. The
`limits.maxActiveWorkspaces` setting exists for this reason. Five agents that produce five
pull requests per hour are of no use if you can review two.
