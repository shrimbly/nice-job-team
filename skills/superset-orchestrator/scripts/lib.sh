#!/usr/bin/env bash
# Shared helpers for the Superset orchestrator scripts.
# Source, don't execute:  . "$(dirname "$0")/lib.sh"

set -euo pipefail

export PATH="$HOME/.superset/bin:$PATH"

# ── Layout ────────────────────────────────────────────────────────────────────
# One orchestrator session per project, so each project owns its own board and
# its own poller. Two things stay GLOBAL at the root, deliberately:
#
#   config.json   one operator, one set of gates, one agent budget across all
#                 projects. Per-project settings live in repos[].
#   workspaces/   the agent status inbox. Keyed by workspace UUID, which is
#                 globally unique, so projects cannot collide. Keeping it here
#                 also means status.sh needs no knowledge of projects: an agent
#                 writes to the same path whatever project it belongs to.
#
ORCH_ROOT="${SUPERSET_ORCH_ROOT:-$HOME/.claude/superset-orchestrator}"
CONFIG="$ORCH_ROOT/config.json"
WORKSPACES_DIR="$ORCH_ROOT/workspaces"

# Not derived from BASH_SOURCE: that is unset when this file is sourced from an
# interactive zsh (the orchestrator does exactly that to call board_set by hand),
# and under `set -u` it aborts the source before the functions are defined.
SKILL_DIR="${SUPERSET_ORCH_SKILL_DIR:-$HOME/.claude/skills/superset-orchestrator}"

# Which project this invocation belongs to. Explicit wins; a single configured
# project is assumed; anything else must say which, because guessing would put a
# dispatch on the wrong board.
project_key() {
  if [ -n "${SUPERSET_ORCH_PROJECT:-}" ]; then printf '%s' "$SUPERSET_ORCH_PROJECT"; return; fi
  [ -f "$CONFIG" ] || { printf 'default'; return; }
  local n; n="$(jq '[.repos[]?] | length' "$CONFIG" 2>/dev/null || echo 0)"
  if [ "$n" = "1" ]; then
    jq -r '.repos[0] | .key // (.name | ascii_downcase | gsub("[^a-z0-9]+"; "-"))' "$CONFIG"
  else
    die "$n projects configured — set SUPERSET_ORCH_PROJECT to the one you mean.
     keys: $(jq -r '[.repos[]? | .key // (.name|ascii_downcase|gsub("[^a-z0-9]+";"-"))] | join(", ")' "$CONFIG")"
  fi
}
PROJECT_KEY="${PROJECT_KEY:-$(project_key)}"

# SUPERSET_ORCH_DIR still overrides everything, for a one-off board.
BOARD_DIR="${SUPERSET_ORCH_DIR:-$ORCH_ROOT/p/$PROJECT_KEY}"
BOARD="$BOARD_DIR/board.json"
LOG="$BOARD_DIR/log.jsonl"

# ── Board lock ────────────────────────────────────────────────────────────────
# One orchestrator per project is the design, but two chats on one project is an
# easy accident. shlock ships with macOS, writes the holder's PID, and clears a
# lock whose process is gone. Without it two writers are last-write-wins, and the
# loser's items vanish with no error.
BOARD_LOCK="$BOARD_DIR/board.lock"
board_lock() {
  local waited=0
  until shlock -f "$BOARD_LOCK" -p $$ 2>/dev/null; do
    waited=$((waited + 1))
    if [ "$waited" -gt 50 ]; then
      die "board is locked by pid $(cat "$BOARD_LOCK" 2>/dev/null || echo '?') after 10s — another orchestrator is writing to $PROJECT_KEY"
    fi
    sleep 0.2
  done
}
board_unlock() { rm -f "$BOARD_LOCK"; }

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
die() { printf 'BLOCKED: %s\n' "$*" >&2; exit 1; }
warn() { printf 'warn: %s\n' "$*" >&2; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

# Write stdin to $1 atomically, so a concurrent reader never sees a half file.
# Refuses an empty payload: a failed producer upstream must not truncate the target.
atomic_write() {
  local target="$1" tmp
  tmp="$(mktemp "${target}.XXXXXX")"
  cat > "$tmp"
  if [ ! -s "$tmp" ]; then rm -f "$tmp"; die "refusing to write an empty $target"; fi
  mv -f "$tmp" "$target"
}

# jq-edit a JSON file in place.  atomic_json <file> <jq filter> [jq args...]
# Validates jq's exit status and its output before replacing anything, so a bad
# filter leaves the original file untouched instead of blanking it.
atomic_json() {
  local file="$1"; shift
  local filter="$1"; shift
  [ -f "$file" ] || die "no such file: $file"

  # Serialise writes to the board. Two orchestrators on one project is otherwise
  # last-write-wins: both read the same board, both write, and the loser's items
  # disappear without an error anywhere. Only the board is locked — signals and
  # rendered output are derived, so a torn read of those costs one cycle.
  local locked=0
  if [ "$file" = "$BOARD" ]; then board_lock; locked=1; fi

  local tmp; tmp="$(mktemp "${file}.XXXXXX")"
  if ! jq "$@" "$filter" "$file" > "$tmp" 2>"$tmp.err"; then
    warn "$(cat "$tmp.err")"; rm -f "$tmp" "$tmp.err"
    [ "$locked" = 1 ] && board_unlock
    die "jq edit of $file failed — file left unchanged"
  fi
  if [ ! -s "$tmp" ] || ! jq -e . "$tmp" >/dev/null 2>&1; then
    rm -f "$tmp" "$tmp.err"
    [ "$locked" = 1 ] && board_unlock
    die "jq edit of $file produced invalid JSON — file left unchanged"
  fi
  rm -f "$tmp.err"

  # A monotonic counter, so a reader can tell that the board moved under it.
  if [ "$locked" = 1 ]; then
    jq '.version = ((.version // 0) + 1)' "$tmp" > "$tmp.v" && mv -f "$tmp.v" "$tmp"
  fi

  mv -f "$tmp" "$file"
  [ "$locked" = 1 ] && board_unlock
  return 0
}

cfg() { # cfg '.limits.maxActiveWorkspaces' [default]
  local filter="$1" default="${2-}" out
  [ -f "$CONFIG" ] || { printf '%s' "$default"; return 0; }
  out="$(jq -r "$filter // empty" "$CONFIG" 2>/dev/null || true)"
  [ -n "$out" ] && printf '%s' "$out" || printf '%s' "$default"
}

log_event() { # log_event <event> <itemId|-> [key=value ...]
  local event="$1" item="$2"; shift 2
  local obj; obj="$(jq -nc --arg at "$(now)" --arg event "$event" --arg itemId "$item" \
    '{at:$at, event:$event, itemId:(if $itemId=="-" then null else $itemId end)}')"
  local kv k v
  for kv in "$@"; do
    k="${kv%%=*}"; v="${kv#*=}"
    obj="$(printf '%s' "$obj" | jq -c --arg k "$k" --arg v "$v" '. + {($k): $v}')"
  done
  mkdir -p "$BOARD_DIR"
  printf '%s\n' "$obj" >> "$LOG"
}

board_item() { # board_item <itemId> → the item object, or empty
  [ -f "$BOARD" ] || return 0
  jq -c --arg id "$1" '.items[]? | select(.id == $id)' "$BOARD"
}

board_set() { # board_set <itemId> <jq object merge>  e.g. '{state:"dispatched"}'
  local id="$1" patch="$2"
  [ -f "$BOARD" ] || die "no board at $BOARD — run preflight.sh"
  atomic_json "$BOARD" \
    '.updatedAt = $at
     | .items = [ .items[] | if .id == $id then
         (. as $old
          | . + $patch
          | .history = (($old.history // []) + (
              if ($patch.state? and $patch.state != $old.state)
              then [{at:$at, from:$old.state, to:$patch.state}] else [] end)))
       else . end ]' \
    --arg id "$id" --arg at "$(now)" --argjson patch "$patch"
}

# The repo entry from config for a "owner/name" repo.
repo_cfg() { # repo_cfg <repo> <jq path within the repo object> [default]
  local repo="$1" path="$2" default="${3-}" out
  out="$(jq -r --arg r "$repo" "(.repos[]? | select(.name==\$r) | $path) // empty" "$CONFIG" 2>/dev/null || true)"
  [ -n "$out" ] && printf '%s' "$out" || printf '%s' "$default"
}

superset_authed() {
  superset auth whoami --json >/dev/null 2>&1
}

# Superset's JSON is auto-enabled under agent envs; ask for it explicitly anyway,
# and normalise an empty result (`null`) to an empty array.
sup_json() { # sup_json workspaces list --local
  superset "$@" --json 2>/dev/null | jq -c '. // []'
}
