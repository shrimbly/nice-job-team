#!/bin/bash
# Write the orchestrator's config.json by asking, so adopting this does not start
# with reading a schema.
#
#   setup.sh            # ask, then write
#   setup.sh --show     # print what is configured now, change nothing
#
# Deliberately does NOT source lib.sh. That resolves the project key as it loads and
# refuses when no repo is configured, which is exactly the state this runs in.
set -eu

ROOT="${SUPERSET_ORCH_ROOT:-$HOME/.claude/superset-orchestrator}"
CONFIG="$ROOT/config.json"

die()  { printf '\n%s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
say()  { printf '%s\n' "$*"; }

ask() { # ask <prompt> <default> -> answer on stdout
  local prompt="$1" default="${2-}" reply
  if [ -n "$default" ]; then
    printf '%s [%s]: ' "$prompt" "$default" >&2
  else
    printf '%s: ' "$prompt" >&2
  fi
  IFS= read -r reply || true
  printf '%s' "${reply:-$default}"
}

if [ "${1-}" = "--show" ]; then
  [ -f "$CONFIG" ] || die "no config at $CONFIG — run $0 to write one."
  jq '{operator, repos: [.repos[] | {name, key, localPath, defaultBase}], limits, cadence}' "$CONFIG"
  exit 0
fi

# ── What has to be there ──────────────────────────────────────────────────────
for tool in jq git gh; do
  have "$tool" || die "$tool is required and is not on PATH."
done
gh auth status >/dev/null 2>&1 || die "gh is not logged in — run: gh auth login"
have superset || say "note: the superset CLI is not on PATH. The board and the
      scripts still work; dispatching agents into workspaces does not."

say ""
say "Setting up the orchestrator. Enter accepts the value in brackets."
say ""

# ── Operator ──────────────────────────────────────────────────────────────────
detected_login="$(gh api user -q .login 2>/dev/null || true)"
github_login="$(ask "Your GitHub login, or * for every PR in the repo" "${detected_login:-@me}")"
operator_name="$(ask "Your name as it appears in your issue tracker" "$github_login")"

# A workspace slug is the first path segment of any Linear URL, which is easier to
# paste than to remember.
linear_raw="$(ask "Your Linear workspace (slug, or paste any Linear URL)" "")"
case "$linear_raw" in
  http*linear.app/*) linear_ws="$(printf '%s' "$linear_raw" | sed -E 's#^https?://linear\.app/([^/]+).*#\1#')" ;;
  *)                 linear_ws="$linear_raw" ;;
esac
[ -n "$linear_ws" ] || say "note: no Linear workspace — ticket links will be omitted."

timezone="$(ask "Your timezone" "$(readlink /etc/localtime 2>/dev/null | sed 's#.*/zoneinfo/##' || echo UTC)")"

# ── The repository ────────────────────────────────────────────────────────────
repo=""
while [ -z "$repo" ]; do
  repo="$(ask "The repository to orchestrate (owner/name)" "")"
  [ -n "$repo" ] || { say "  a repository is required."; continue; }
  # gh follows a rename here; `gh pr list` does not, and a stale name returns an
  # empty list rather than an error, which reads exactly like "no open PRs".
  actual="$(gh repo view "$repo" --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
  if [ -z "$actual" ]; then
    say "  cannot see $repo with your gh login — check the name, or your access."
    repo=""
  elif [ "$actual" != "$repo" ]; then
    say "  $repo is now $actual — using that, because gh pr list will not follow the rename."
    repo="$actual"
  fi
done

default_base="$(gh repo view "$repo" --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || echo main)"
local_path="$(ask "Path to your main clone of $repo (not a worktree)" "$PWD")"
[ -d "$local_path/.git" ] || say "note: $local_path is not a git checkout — branch checks will be skipped."
reviewer="$(ask "Default reviewer for PRs (GitHub login, blank for none)" "")"

superset_project=""
if have superset; then
  superset_project="$(ask "Superset project id (blank to fill in later)" "")"
fi

key="$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]' | sed 's#[^a-z0-9]\{1,\}#-#g')"

# ── Write it ──────────────────────────────────────────────────────────────────
mkdir -p "$ROOT/workspaces" "$ROOT/p/$key"
if [ -f "$CONFIG" ]; then
  backup="$CONFIG.$(date +%Y%m%d%H%M%S).bak"
  cp "$CONFIG" "$backup"
  say ""
  say "existing config saved to $backup"
fi

tmp="$(mktemp "$CONFIG.XXXXXX")"
jq -n \
  --arg login "$github_login" --arg name "$operator_name" --arg ws "$linear_ws" \
  --arg tz "$timezone" --arg repo "$repo" --arg key "$key" --arg base "$default_base" \
  --arg path "$local_path" --arg reviewer "$reviewer" --arg sp "$superset_project" '
  {
    operator: { githubLogin: $login, linearName: $name, linearWorkspace: $ws, timezone: $tz },
    repos: [ {
      name: $repo, key: $key, defaultBase: $base, localPath: $path,
      reviewers: (if $reviewer == "" then [] else [$reviewer] end),
      supersetProjectId: (if $sp == "" then null else $sp end)
    } ],
    limits:  { maxActiveWorkspaces: 4 },
    cadence: { watchSeconds: 120 }
  }' > "$tmp"
jq -e . "$tmp" >/dev/null || { rm -f "$tmp"; die "refusing to write invalid JSON."; }
mv -f "$tmp" "$CONFIG"

say ""
say "wrote $CONFIG"
say ""
say "Next:"
say "  1. $(dirname "$0")/preflight.sh          # check the environment"
say "  2. $(dirname "$0")/poll.sh               # first collection"
say "  3. $(dirname "$0")/render-board.sh --open"
