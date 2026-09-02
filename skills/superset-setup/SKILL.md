---
name: superset-setup
description: Configure the Superset orchestrator for the repository you are standing in — detect the repo, the main clone, the base branch and the GitHub login, ask only for what cannot be detected, write config.json, install the scout subagent and the bundled skills, and verify with board doctor. Use when asked to set up, configure, install, or onboard the orchestrator, to add another repository to it, or when a board verb refuses because no repo is configured.
---

# Set up the orchestrator

Run this from inside the repository the operator wants to orchestrate. Almost
everything comes from the checkout. Ask for the two things that cannot.

Adding a second repository is the same procedure. The config merges, so an
existing repository keeps its settings.

## 1. Detect

```bash
board init --detect
```

That prints JSON and changes nothing:

```json
{
  "detected": { "repo": "…", "localPath": "…", "defaultBase": "…",
                "githubLogin": "…", "timezone": "…", "supersetProjectId": "…" },
  "needed": ["linearWorkspace", "reviewer"],
  "supersetOnPath": true,
  "configPath": "…",
  "configLayout": "none",
  "existing": null
}
```

Read it before you ask anything:

- **`detected.repo` is empty.** The working directory is not a GitHub checkout,
  or `gh` cannot see it. Ask which repository to orchestrate, as `owner/name`.
  Do not guess from the directory name.
- **`existing` is not null.** This repository is already configured. Say what is
  set now and confirm the change before you write. Do not silently re-run.
- **`configLayout` is `"split"`.** The machine is on the split machine + project
  layout (no legacy `config.json`), and `existing` came from that merge. Any
  `--apply` you run here MUST include `--split` — a plain `--apply` refuses
  rather than write a legacy file that would shadow the split config.
- **`supersetOnPath` is false.** Say that the board still works and that nothing
  will dispatch. Do not treat it as a failure.

## 2. Ask, once

Ask for everything you need in **one** `AskUserQuestion` call. Never ask for a
value that came back in `detected`.

| Ask | Why it cannot be detected |
|---|---|
| Tracker: GitHub Issues (default), Linear, or markdown | a choice, not a fact about the checkout |
| Linear workspace | only if the tracker is Linear — a slug or any Linear URL |
| Default reviewer | a person, not a setting — a GitHub login, or none |
| Every PR, or only yours | `githubLogin` filters the board; `*` takes the whole repo |

Offer the detected `githubLogin` as the default for the last one. An operator
who works alone in the repository usually wants `*`.

Ask the tracker question first, and skip the Linear one unless the answer is
Linear. The choices:

- **github-issues** — the repository's own issues, read with the `gh` setup
  already requires. No extra account, and the backlog shows up in the poll's
  free pass. Priority comes from the labels `urgent`/`high`/`medium`/`low`
  (unlabeled issues read as medium). **This is the fresh-install default**: a
  first `--apply` that names no `--tracker` gets it. A re-apply over an
  existing config never changes the tracker — including a config with no
  tracker block, which means Linear.
- **linear** — ticket links on the cards; the backlog itself is a scout job
  (an API session, not the free poll). Needs the workspace slug.
- **markdown** — a backlog of files in the repository — no account, no
  network, versioned with the code. It suits a project with no tracker,
  personal work, or anything that should stay portable. See
  `superset-orchestrator/reference/markdown-tracker.md`.

`--apply` derives the issue URL for the chosen kind (the repo's issues URL for
github-issues, a blob link from repo and base branch for markdown, the
workspace's issue URL for linear), so `--tracker-url` is only needed for a
non-GitHub host or a local `file://` link.

## 3. Write

```bash
board init --apply \
  --repo owner/name \
  --tracker github-issues|linear|markdown \
  --linear <slug-or-url> \
  --reviewer <login> \
  --operator <login-or-*>
```

Pass only what you collected. Every flag you leave out is detected again, and
any field already in the config that you do not pass keeps its value.

`--apply` also installs the scout subagent to `~/.claude/agents/`. skills.sh
installs skills, not subagents, so without this step the orchestrator can read
GitHub and nothing else. The copy comes from the plugin root when
`$CLAUDE_PLUGIN_ROOT` is set, else from the skill's own `agents/` directory —
plugin installs already register the scout directly from `plugin.json`, so for
them this copy is a harmless duplicate; for a skills-only install it is the
only scout there is.

It then installs three skills from skills.sh, globally:

| Skill | Used for |
|---|---|
| `aminblg/simpleenglish@simple-english` | the PR body style the implementer requires |
| `coderabbitai/skills@code-review` | the review pass before the operator's gate |
| `jackjin1997/clawforge@clean-code` | the tidying pass |

Globally, because implementation agents work in linked worktrees — a project-level
install in the main clone reaches none of them.

Installation never fails setup. If npx is missing or the registry is unreachable,
`board init` prints the commands and carries on. Pass `--no-skills` to skip it. Say
which skills went in, and repeat any command it printed.

## 4. Verify

```bash
board doctor
```

It tests the CLI, the authentication, the host daemon, and the board directory.
Report what it says. Two results need a sentence from you rather than a paste:

- **`not logged in`** for Superset. The operator must run `superset auth login`
  themselves — it is a browser flow. The desktop app's session does not count.
- **`no supersetProjectId`**. Dispatch will refuse. Get the id with
  `superset projects list --local --json`, then re-run `--apply` with
  `--superset-project <id>`. Setup finds it by itself when the project is
  already registered against the same path.

## 5. Hand over

Say these three things, and stop:

```bash
board watch --install    # register the poller as a login service (launchd/systemd)
board watch --status     # is it alive
board cycle --open       # one full cycle, then open board.html
```

The `board` verbs need the CLI on the login PATH: `npm install -g <repo>/cli`,
or add `<repo>/cli/bin` to `PATH` in the shell profile. A one-session `export`
is not enough — dispatched implementation agents open their own shells and
write their status files with the same `board` command, and where it does not
resolve for them no status file is ever written, so the item just reads as
stalled.

Do not install the poller without being asked. It is a background service on the
operator's machine.

## Rules

1. **Never write the config by hand.** `board init --apply` validates the JSON and
   backs up what was there. A hand-edited config that fails to parse takes the
   board with it.
2. **Never overwrite a repository entry to "clean it up".** The merge is the
   safety property that lets a second repository join.
3. **Detect before you ask.** An operator who is asked for their own GitHub login
   while standing in their own checkout will not trust the rest of it.
4. **Do not invent a Linear workspace.** With no tracker, ticket links are
   omitted and everything else works. That is a supported setup, not a failure.
