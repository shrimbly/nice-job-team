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
| [config.md](config.md) | The configuration layouts — the legacy file and the split |
| [superset-cli.md](superset-cli.md) | The Superset CLI surface and its sharp edges |
| [lessons.md](lessons.md) | The failures that shaped every guard in the scripts |

Read `workflow.md` first. Read `lessons.md` before you change any script, because most of
the guards look unnecessary until you know what they prevent.

## The skills

The `skills/` directory at the root of this repository holds the two agent contracts.
The commands live in the `board` CLI, built from `cli/`. Copy both to adopt the workflow.

```
skills/superset-orchestrator/    the orchestrator: SKILL.md, reference/
skills/superset-implementer/     the implementation agent: SKILL.md, reference/
skills/superset-setup/           the setup procedure: SKILL.md
agents/superset-scout.md         the read-only scout subagent
```

The scout subagent ships at the repository root, in `agents/superset-scout.md`,
where the plugin manifest picks it up. Outside the plugin, `board init --apply`
copies it to `~/.claude/agents/`.

## How to adopt this on a new project

You need Node 20 or newer, the Superset CLI, and the GitHub CLI.

A hosted issue tracker is optional. The superset-setup skill asks which
tracker you use — **GitHub Issues** (the fresh-install default: the repo's own
backlog, read with the `gh` setup already requires), **Linear**, or the
**markdown tracker**, a backlog of files committed to the repository with no
account and no network — and passes the answer to
`board init --apply --tracker ...`. `board init` itself is not interactive:
working without the skill, run `board init --detect` to see what it can figure
out, then `board init --apply` with the flags spelled yourself. See
[markdown-tracker.md](../skills/superset-orchestrator/reference/markdown-tracker.md).

1. Install the plugin and the CLI. The repository is its own single-plugin
   marketplace, and the `board` CLI installs from its `cli/` package — see the
   [root README](../README.md#install) for the exact commands. (The skills can
   also be installed alone, from the public mirror:
   `npx skills add shrimbly/nice-job-team --skill '*' --agent claude-code -g -y`.)

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

5. Install the background poller as a login service. Use `--all` to install one
   per configured project.

   ```bash
   board watch --install --interval 60
   board watch --install --all
   ```

6. Start a chat with the orchestrator skill. Ask it to triage the queue.

## More than one project

One orchestrator session owns one project. Each project gets its own board, its own
briefs, and its own poller, in `~/.claude/superset-orchestrator/p/<key>/`.

Select a project with `SUPERSET_ORCH_PROJECT=<key>`. With exactly one repository
configured the scripts assume it.

Two things stay global: the configuration, and the `workspaces/` status inbox.
See [orchestrator.md](orchestrator.md) for why the inbox is shared, and
[config.md](config.md) for the two configuration layouts (the legacy
`config.json` and the split machine + project files).

The agent budget is global as well. `limits.maxActiveWorkspaces` defaults to 15 across
every project, because per-project caps multiply.

## What the workflow needs from you

The orchestrator asks for approval before it starts any work. It never merges. These two
gates are the design, not a limitation.

Your review capacity is the real limit on throughput, not the number of agents. The
`limits.maxActiveWorkspaces` setting exists for this reason. Five agents that produce five
pull requests per hour are of no use if you can review two.
