#!/bin/sh
# Stop-hook shim for the superset-board plugin.
#
# This runs on EVERY session Stop for EVERY user of the machine with the
# plugin enabled, so it is deliberately POSIX sh — the one sanctioned piece
# of shell in this repo — and must decide "not for me" without booting Node.
# Everything past the guards is the board CLI.
#
# Exit discipline: every path exits 0. A Stop hook's non-zero exit surfaces
# stderr into the user's session (exit 2 even blocks the stop), and no board
# bookkeeping is worth breaking a stranger's session over. Nothing is ever
# printed to stdout here: Stop-hook stdout can reach the model as context,
# and an observation shim has nothing to say to it.
#
# Measured no-op path (guard 1, env unset): ~3.1ms per run on this machine
# (Darwin 25.2.0, /bin/sh; 100 sequential `sh hooks/on-stop.sh` runs took
# 0.309s wall total, interpreter start included) — under the 10ms budget.

# Guard 1: not a Superset workspace session — implementation agents get
# SUPERSET_WORKSPACE_ID exported into their environment by dispatch; nobody
# else has it. This is the path every ordinary session takes.
[ -n "$SUPERSET_WORKSPACE_ID" ] || exit 0

# Guard 2: no status file for this workspace. The status file is the agent's
# one channel back to the orchestrator; until `board status init` creates it
# there is nothing to observe against, and a Stop before init (or after reap
# deleted the file) must stay silent.
#
# The tilde expansion mirrors config.ts's expandTilde exactly (bare ~ and the
# ~/ prefix, nothing else): SUPERSET_ORCH_ROOT is set by humans, and a quoted
# "~/orch-copy" reaches us unexpanded. The CLI and the Swift app both expand
# it, and a shim testing the literal path would find no file and silently
# never observe — on precisely the configuration config.ts exists to survive.
root="${SUPERSET_ORCH_ROOT:-$HOME/.claude/superset-orchestrator}"
case "$root" in
  "~") root="$HOME" ;;
  "~/"*) root="$HOME/${root#"~/"}" ;;
esac
status_file="$root/workspaces/$SUPERSET_WORKSPACE_ID.json"
[ -f "$status_file" ] || exit 0

# Guard 3: a missing CLI must never break someone's session. The plugin can
# be installed on a machine where the board CLI is not (or not yet) on PATH —
# a hook that errors there would nag on every single Stop, so absence is a
# clean no-op, never a failure.
command -v board >/dev/null 2>&1 || exit 0

# Run the CLI: `board status observe --quiet` records the Stop-time
# observation into the status file and is contracted to exit 0 and print
# nothing under --quiet. No exec — the shell must survive to absorb the exit
# code, because guard 3 only proved a launcher named `board` exists, not that
# it runs: a stale dist ("is the CLI built?") or a too-old Node exits 1 with
# stderr, and a Stop hook's nonzero exit surfaces that into the user's
# session on EVERY Stop. Both streams are tied off for the same reason: the
# contract is silence, and anything else is noise this shim must not forward.
board status observe --quiet >/dev/null 2>&1
exit 0
