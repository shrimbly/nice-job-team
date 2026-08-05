---
name: superset-setup
description: Configure the Superset orchestrator for the repository you are standing in — detect the repo, the main clone, the base branch and the GitHub login, ask only for what cannot be detected, write config.json, install the scout subagent, and verify with preflight. Use when asked to set up, configure, install, or onboard the orchestrator, to add another repository to it, or when a script refuses because no repo is configured.
---

# Set up the orchestrator

Run this from inside the repository the operator wants to orchestrate. Almost
everything comes from the checkout. Ask for the two things that cannot.

Adding a second repository is the same procedure. The config merges, so an
existing repository keeps its settings.

## 1. Detect

```bash
S=~/.claude/skills/superset-orchestrator/scripts
$S/setup.sh --detect
```

That prints JSON and changes nothing:

```json
{
  "detected": { "repo": "…", "localPath": "…", "defaultBase": "…",
                "githubLogin": "…", "timezone": "…", "supersetProjectId": "…" },
  "needed": ["linearWorkspace", "reviewer"],
  "supersetOnPath": true,
  "configPath": "…",
  "existing": null
}
```

Read it before you ask anything:

- **`detected.repo` is empty.** The working directory is not a GitHub checkout,
  or `gh` cannot see it. Ask which repository to orchestrate, as `owner/name`.
  Do not guess from the directory name.
- **`existing` is not null.** This repository is already configured. Say what is
  set now and confirm the change before you write. Do not silently re-run.
- **`supersetOnPath` is false.** Say that the board still works and that nothing
  will dispatch. Do not treat it as a failure.

## 2. Ask, once

Ask for everything you need in **one** `AskUserQuestion` call. Never ask for a
value that came back in `detected`.

| Ask | Why it cannot be detected |
|---|---|
| Linear workspace | not derivable from the checkout — a slug or any Linear URL |
| Default reviewer | a person, not a setting — a GitHub login, or none |
| Every PR, or only yours | `githubLogin` filters the board; `*` takes the whole repo |

Offer the detected `githubLogin` as the default for the last one. An operator
who works alone in the repository usually wants `*`.

## 3. Write

```bash
$S/setup.sh --apply \
  --repo owner/name \
  --linear <slug-or-url> \
  --reviewer <login> \
  --operator <login-or-*>
```

Pass only what you collected. Every flag you leave out is detected again, and
any field already in the config that you do not pass keeps its value.

`--apply` also installs the scout subagent to `~/.claude/agents/`. skills.sh
installs skills, not subagents, so without this step the orchestrator can read
GitHub and nothing else.

## 4. Verify

```bash
$S/preflight.sh
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
$S/watch.sh --start      # the poller, every 120s
$S/watch.sh --status     # is it alive
$S/render-board.sh --open
```

Do not start the poller without being asked. It is a background process on the
operator's machine.

## Rules

1. **Never write the config by hand.** `setup.sh --apply` validates the JSON and
   backs up what was there. A hand-edited config that fails to parse takes the
   board with it.
2. **Never overwrite a repository entry to "clean it up".** The merge is the
   safety property that lets a second repository join.
3. **Detect before you ask.** An operator who is asked for their own GitHub login
   while standing in their own checkout will not trust the rest of it.
4. **Do not invent a Linear workspace.** With no tracker, ticket links are
   omitted and everything else works. That is a supported setup, not a failure.
