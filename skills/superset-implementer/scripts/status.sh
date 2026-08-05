#!/usr/bin/env bash
# The implementation agent's status file — the only channel back to the
# orchestrator. Writes ~/.claude/superset-orchestrator/workspaces/<workspaceId>.json
#
#   status.sh init --item itm_007 --slug eng-142-log-table [--base main]
#   status.sh phase "implementing the sticky header"
#   status.sh state building|awaiting-approval|pr-open|fixing|blocked|merged
#   status.sh verify unit="pass — 214 tests" lint=pass typecheck="19 pre-existing, 0 new"
#   status.sh risk  "sticky offsets measured against the content box; check Safari"
#   status.sh ask   "which asset set replaces the placeholders?"     # → blocked
#   status.sh gate  "Denser rows + per-row timing; 6 files, tests added."
#   status.sh pr    441 https://github.com/acme/website/pull/441
#   status.sh show
#
# Every write is atomic and merges into the existing file. Safe to call often —
# call it at every phase change, because silence reads as a stall.

set -euo pipefail
export PATH="$HOME/.superset/bin:$PATH"

# The status inbox is deliberately global: it is keyed by workspace UUID, so this
# script needs no knowledge of projects. It therefore hangs off the ROOT, not off
# SUPERSET_ORCH_DIR — that names one project's board directory (p/<key>), and
# writing there put the status file somewhere the orchestrator never looks.
ORCH_ROOT="${SUPERSET_ORCH_ROOT:-$HOME/.claude/superset-orchestrator}"
DIR="$ORCH_ROOT/workspaces"
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
die() { printf 'status.sh: %s\n' "$*" >&2; exit 1; }

command -v jq >/dev/null || die "jq is required"

# --- which workspace am I? --------------------------------------------------
resolve_id() {
  if [ -n "${SUPERSET_WORKSPACE_ID:-}" ]; then printf '%s' "$SUPERSET_WORKSPACE_ID"; return; fi
  local root; root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  local id=""
  if command -v superset >/dev/null 2>&1; then
    id="$(superset workspaces list --local --json 2>/dev/null \
          | jq -r --arg p "$root" '(. // [])[] | select(.worktreePath==$p) | .id' | head -1 || true)"
  fi
  if [ -z "$id" ]; then
    # Last resort: a branch-keyed file the orchestrator can reconcile by branch.
    local br; br="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
    id="branch--$(printf '%s' "$br" | tr '/ ' '--')"
    printf 'status.sh: no workspace id; keying by branch (%s)\n' "$id" >&2
  fi
  printf '%s' "$id"
}

WSID="$(resolve_id)"
FILE="$DIR/$WSID.json"
mkdir -p "$DIR"

patch() { # patch <jq filter> [jq args…] — merge into the file, atomically
  local filter="$1"; shift
  [ -f "$FILE" ] || die "no status file yet — run: status.sh init --item <id> --slug <slug>"
  local tmp; tmp="$(mktemp "$FILE.XXXXXX")"
  jq "$@" --arg _at "$(now)" "($filter) | .updatedAt = \$_at" "$FILE" > "$tmp"
  mv -f "$tmp" "$FILE"
}

diffstat() { # against the recorded base; zeroes when git cannot answer
  local base; base="$(jq -r '.baseBranch // "main"' "$FILE" 2>/dev/null || echo main)"
  # Prefer origin/<base>: the local ref drifts behind whenever someone else merges,
  # and a diffstat measured against a stale base reports a change far bigger than it
  # is. An agent quoting that number at its gate is quoting fiction.
  local range
  if git rev-parse --verify --quiet "origin/$base" >/dev/null 2>&1; then
    range="origin/$base...HEAD"
  elif git rev-parse --verify --quiet "$base" >/dev/null 2>&1; then
    range="$base...HEAD"
  else
    range="HEAD"
  fi
  # --numstat, not --shortstat: parsing the prose form needs GNU sed (BSD sed has
  # no \+), and numstat is machine-readable anyway. Binary files report "-", which
  # awk reads as 0.
  git diff --numstat "$range" 2>/dev/null | awk '
    { i += $1; d += $2; f += 1 }
    END { printf "{\"files\":%d,\"insertions\":%d,\"deletions\":%d}", f+0, i+0, d+0 }'
}

cmd="${1:-show}"; shift || true

case "$cmd" in
  init)
    item="" slug="" base=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --item) item="$2"; shift 2 ;;
        --slug) slug="$2"; shift 2 ;;
        --base) base="$2"; shift 2 ;;
        *) die "unknown argument: $1" ;;
      esac
    done
    [ -n "$base" ] || base="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || echo main)"
    jq -nc --arg at "$(now)" --arg w "$WSID" --arg item "$item" --arg slug "$slug" \
      --arg branch "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)" \
      --arg base "$base" --arg wt "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" \
      '{version:1, workspaceId:$w, itemId:(if $item=="" then null else $item end),
        slug:(if $slug=="" then null else $slug end), branch:$branch, baseBranch:$base,
        worktreePath:$wt, state:"building", phase:"orienting", updatedAt:$at,
        summary:null, verification:{}, diffstat:null, risks:[], questions:[],
        blockedReason:null, pr:{number:null, url:null}, needsOperator:false}' \
      > "$FILE"
    printf 'initialised %s\n' "$FILE"
    ;;

  phase)  [ $# -ge 1 ] || die "phase needs text"; patch '.phase = $v' --arg v "$1" ;;

  state)
    [ $# -ge 1 ] || die "state needs a value"
    case "$1" in
      building|awaiting-approval|pr-open|fixing|blocked|merged) : ;;
      *) die "unknown state: $1" ;;
    esac
    patch '.state = $v | (if $note != "" then .phase = $note else . end)
           | .needsOperator = (($v == "awaiting-approval") or ($v == "blocked"))' \
      --arg v "$1" --arg note "${2-}"
    ;;

  verify)
    [ $# -ge 1 ] || die "verify needs key=value pairs"
    for kv in "$@"; do
      patch '.verification[$k] = $v' --arg k "${kv%%=*}" --arg v "${kv#*=}"
    done
    ;;

  risk)     [ $# -ge 1 ] || die "risk needs text"; patch '.risks += [$v]' --arg v "$1" ;;

  ask)
    [ $# -ge 1 ] || die "ask needs a question"
    patch '.questions += [$v] | .state = "blocked" | .blockedReason = $v | .needsOperator = true' --arg v "$1"
    printf 'blocked, and the orchestrator has been told. Stop working and wait.\n'
    ;;

  gate)
    [ $# -ge 1 ] || die "gate needs a one-or-two-line summary"
    patch '.state = "awaiting-approval" | .summary = $v | .phase = "self-review complete"
           | .needsOperator = true | .diffstat = $ds' \
      --arg v "$1" --argjson ds "$(diffstat)"
    printf 'gated for approval. Do not push and do not open a PR until told to.\n'
    ;;

  pr)
    [ $# -ge 2 ] || die "pr needs <number> <url>"
    patch '.state = "pr-open" | .pr = {number: ($n|tonumber), url: $u}
           | .needsOperator = false | .phase = "awaiting review" | .diffstat = $ds' \
      --arg n "$1" --arg u "$2" --argjson ds "$(diffstat)"
    ;;

  clear-questions) patch '.questions = [] | .blockedReason = null | .needsOperator = false' ;;

  set)  [ $# -ge 1 ] || die "set needs a JSON object"; patch '. + $p' --argjson p "$1" ;;

  show) [ -f "$FILE" ] && jq . "$FILE" || printf 'no status file at %s\n' "$FILE" ;;

  path) printf '%s\n' "$FILE" ;;

  *) die "unknown command: $cmd" ;;
esac
