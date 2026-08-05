# Nice job team

Nice job team runs many coding agents at the same time. A macOS menu bar app shows
you what each agent does.

## How it works

One orchestrator agent holds the queue. It writes the briefs and it reads the
results. It never writes product code.

Many implementation agents write the code. Each agent works in its own git worktree,
on one branch, and delivers one pull request.

A scout agent collects signal from Linear, Slack, or GitHub. It returns JSON. It
never changes anything.

The state is a file on disk, not a chat. A context reset costs nothing, because the
next session reads the same file.

This workflow ran up to eight agents at the same time on a real product.

<img width="1003" height="636" alt="image" src="https://github.com/user-attachments/assets/df45e733-0ba0-40bd-a1ac-0fc51902fecc" />


## What is in this repository

| Directory | Contents |
|---|---|
| `docs/` | The model, the two agent contracts, and the reason for each guard |
| `skills/` | The three skills, the scripts that run the loop, and the scout |
| `Sources/`, `Tests/` | The menu bar app, in Swift, with no dependencies |

Read [docs/workflow.md](docs/workflow.md) first. Before you change a script, read
[docs/lessons.md](docs/lessons.md). Each guard looks unnecessary until you know what
it prevents.

## What you need

- **[Superset](https://superset.sh)**. Superset runs the agents. A Superset
  workspace is a git worktree with an agent session attached to it. The CLI creates
  these workspaces, lists them, and deletes them. Without Superset, the queue and the
  board still work, but no agent starts. For the commands this workflow uses, read
  [docs/superset-cli.md](docs/superset-cli.md).
- **[gh](https://cli.github.com)**, logged in. Pull request state, checks, and review
  threads come through it.
- **jq**. Each script is shell and jq. There is no other runtime.
- **An issue tracker**. The ticket links are built for Linear. Nothing else depends
  on Linear.
- **The Linear and Slack MCP plugins**, for the scout. The scout declares
  `mcp__plugin_linear_linear__*` and `mcp__plugin_slack_slack__*`. Without these
  plugins, the scout can still read GitHub and the transcript of a stalled workspace.
- **macOS 14 or later**, for the menu bar app, with the Command Line Tools
  (`xcode-select --install`). Xcode is not necessary. The app is the only part that
  needs macOS. It is also the only part that runs without Superset.

## Installation

1. Install [Superset](https://superset.sh). Then sign in. The login is a browser
   flow, so you must run it yourself.

   ```bash
   superset auth login
   superset auth whoami      # confirm the session
   ```

2. Install the three skills, for every agent you use.

   ```bash
   npx skills add shrimbly/nice-job-team --all -g
   ```

   `-g` puts them in `~/.claude/skills/`, so they work in every repository.
   Leave it out to install into the current project only. The scripts keep
   their executable bit, and [skills.sh](https://skills.sh) installs to the
   correct directory for each agent it finds.

3. Go to the repository you want to orchestrate. Then ask your agent to set it
   up:

   > set up the orchestrator for this repo

   The `superset-setup` skill reads the repository, the main clone, the base
   branch, and your GitHub login from the checkout. It asks only for your
   Linear workspace and your default reviewer. Then it writes
   `~/.claude/superset-orchestrator/config.json`, installs the scout subagent,
   and runs the preflight check.

   Repeat this step in each repository you want to add. The configuration
   merges, so a second repository does not disturb the first.

4. Start the poller.

   ```bash
   ~/.claude/skills/superset-orchestrator/scripts/watch.sh --start
   ```

To read the configuration at any time, run
`~/.claude/skills/superset-orchestrator/scripts/setup.sh --show`. To set a
repository up without an agent, run that script with no arguments and answer
the questions.

## The app

To build the app and start it, run `make run`. To copy it to `~/Applications`, run
`make install`.

The app stays in the menu bar. It shows a count of the items that need you. It opens
each link in your default browser. It reads the board of the orchestrator and never
writes to it. If no orchestrator is present, the app reads GitHub alone.

To run the tests, use `make test`. The most important test is
`CardBuilderGoldenTests`. It compares the model of the app against the JSON that
`render-board.sh` makes from the same input, field by field. The app is a port of
that script, and this test keeps the two the same. The fixtures are real captures
with the content replaced.

## What this project decides for you

- **The board is the record, not the chat.** Each context reset was survivable
  because the state was on disk.
- **A guard is better than a rule.** A reader misses a rule in a document. The
  five-word title limit held only after `dispatch.sh` started to refuse a longer one.
- **An agent stops before it pushes.** The operator reads the work before it becomes
  a pull request.
- **One operator by default.** `poll.sh` filters pull requests by
  `operator.githubLogin`. For each pull request in the repository, set that value
  to `*`.

## License

MIT. Read [LICENSE](LICENSE). The Linear mark comes from Simple Icons (CC0). Read
[NOTICE](NOTICE).
