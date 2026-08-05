#!/usr/bin/env bash
# Verify everything the orchestrator depends on, seed the board directory, and
# print a READY / BLOCKED verdict. Safe to run every session; makes no changes
# beyond creating the board directory and seeding config.json on first run.

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

problems=()
notes=()

need_cmd jq
need_cmd git

# --- board directory -------------------------------------------------------
mkdir -p "$BOARD_DIR"/{briefs,signals,workspaces}
if [ ! -f "$CONFIG" ]; then
  cp "$SKILL_DIR/reference/config.example.json" "$CONFIG"
  notes+=("seeded $CONFIG from the example — review repos/reviewers before dispatching")
fi
if [ ! -f "$BOARD" ]; then
  jq -nc --arg at "$(now)" '{version:1, updatedAt:$at, items:[]}' | atomic_write "$BOARD"
  notes+=("created an empty board at $BOARD")
fi
jq -e . "$CONFIG" >/dev/null 2>&1 || problems+=("config.json is not valid JSON — fix it by hand, it holds the operator's settings")
# An unreadable board is recoverable: keep the corpse, start a clean one, and say so
# loudly. Items can be re-sensed; a stuck orchestrator cannot do anything at all.
if ! jq -e . "$BOARD" >/dev/null 2>&1; then
  bak="$BOARD.broken.$(date -u +%Y%m%dT%H%M%SZ)"
  mv -f "$BOARD" "$bak"
  jq -nc --arg at "$(now)" '{version:1, updatedAt:$at, items:[]}' | atomic_write "$BOARD"
  notes+=("board.json was empty or invalid — moved to $bak and started a clean board; re-run SENSE to rebuild it, and reconcile against live workspaces before dispatching")
fi

# --- superset cli ----------------------------------------------------------
if command -v superset >/dev/null 2>&1; then
  printf 'superset:   %s\n' "$(superset --version 2>&1 | head -1)"
  if superset_authed; then
    who="$(superset auth whoami --json 2>/dev/null || echo '{}')"
    printf 'account:    %s (org %s)\n' \
      "$(printf '%s' "$who" | jq -r '.email // "?"')" \
      "$(printf '%s' "$who" | jq -r '.organizationName // .organizationId // "?"')"
    st="$(superset status --json 2>/dev/null || echo '{}')"
    if [ "$(printf '%s' "$st" | jq -r '.running // false')" = "true" ]; then
      printf 'host:       running (pid %s, port %s)\n' \
        "$(printf '%s' "$st" | jq -r '.pid // "?"')" "$(printf '%s' "$st" | jq -r '.port // "?"')"
    else
      notes+=("host service is not running — 'superset start --daemon' before dispatching")
    fi
  else
    problems+=("not logged in — the operator must run: superset auth login  (browser OAuth; the desktop app's session does not count)")
  fi
else
  problems+=("superset CLI not found (expected ~/.superset/bin/superset)")
fi

# --- github ----------------------------------------------------------------
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then
    printf 'github:     %s\n' "$(gh api user --jq .login 2>/dev/null || echo '?')"
  else
    problems+=("gh is not authenticated — run: gh auth login")
  fi
else
  problems+=("gh CLI not found")
fi

# --- repos in config -------------------------------------------------------
while IFS=$'\t' read -r name path proj; do
  [ -z "$name" ] && continue
  line="repo:       $name"
  if [ -n "$path" ] && [ -d "$path/.git" ]; then line="$line  clone ok"; else
    problems+=("repo $name: localPath '$path' is not a git clone"); fi
  if [ -n "$proj" ]; then line="$line  project $proj"; else
    notes+=("repo $name has no supersetProjectId — get it from: superset projects list --local --json"); fi
  if [ -z "$(repo_cfg "$name" '.reviewers[0]')" ]; then
    notes+=("repo $name has no default reviewer configured — PRs will open unassigned"); fi
  printf '%s\n' "$line"
done < <(jq -r '.repos[]? | [.name, .localPath, .supersetProjectId] | @tsv' "$CONFIG" 2>/dev/null || true)

# --- board summary ---------------------------------------------------------
if [ -f "$BOARD" ]; then
  printf 'board:      %s items (%s active)\n' \
    "$(jq '[.items[]?] | length' "$BOARD")" \
    "$(jq '[.items[]? | select(.state|IN("dispatched","building","awaiting-approval","fixing","pr-open"))] | length' "$BOARD")"
fi
printf 'status files: %s\n' "$(ls -1 "$WORKSPACES_DIR"/*.json 2>/dev/null | wc -l | tr -d ' ')"

# --- verdict ---------------------------------------------------------------
echo
for n in "${notes[@]:-}"; do [ -n "$n" ] && printf 'NOTE: %s\n' "$n"; done
if [ "${#problems[@]}" -gt 0 ]; then
  for p in "${problems[@]}"; do printf 'BLOCKED: %s\n' "$p"; done
  exit 1
fi
printf 'READY\n'
