# Installing superset-board as a Claude Code plugin

This repository is its own single-plugin marketplace: `.claude-plugin/marketplace.json`
lists the one plugin (`superset-board`, defined in `.claude-plugin/plugin.json`), which
carries the three skills in `skills/`, the `superset-scout` subagent in `agents/`, and
one Stop hook in `hooks/`.

## Install

From a clone of this repository (the path form; a GitHub `owner/repo` or a git URL
works the same way):

```
claude plugin marketplace add /path/to/superset-board
claude plugin install superset-board@superset-board -y
```

The plugin does not include the `board` CLI itself. Install it globally
(`cd /path/to/superset-board/cli && npm install && npm install -g .` — the
`npm install` first matters, because packing runs the `prepare` build and a
fresh clone has no devDependencies for `tsc` to come from — or, for a dev loop,
`cd cli && npm install && npm run build && npm link`), then run `board doctor`.

## Dev loop (no install)

Load the plugin for a single session straight from the working tree:

```
claude --plugin-dir /path/to/superset-board
```

Validate after editing any packaging file. Two invocations are required: once the
marketplace manifest exists, validating the directory checks the marketplace only,
so the plugin side must be named explicitly.

```
claude plugin validate --strict .claude-plugin/plugin.json
claude plugin validate --strict .claude-plugin/marketplace.json
```

## What the Stop hook does

`hooks/hooks.json` registers one Stop hook: `hooks/on-stop.sh`. When a session
stops inside a Superset workspace — the dispatched implementation agents, which
have `SUPERSET_WORKSPACE_ID` in their environment — and that workspace's status
file exists, the shim hands over to `board status observe --quiet`, which records
the Stop-time observation into the status file so the orchestrator sees a fresh
signal instead of silence.

For every other session it is a no-op: without `SUPERSET_WORKSPACE_ID` the shim
exits 0 on its first line, in about 3ms, without printing anything or booting
Node. You can see the off path yourself:

```
$ env -u SUPERSET_WORKSPACE_ID sh hooks/on-stop.sh; echo $?
0
```

The same holds when the workspace has no status file yet, or when the `board`
CLI is not on `PATH` — the shim never fails, never blocks a stop, and never
writes to stdout (Stop-hook stdout can reach the model).
