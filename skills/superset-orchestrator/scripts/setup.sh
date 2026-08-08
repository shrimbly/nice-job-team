#!/bin/bash
# Configure the orchestrator for one repository. Run it from inside that
# repository and it works out almost everything by itself.
#
#   setup.sh                 # detect, ask for the rest, write
#   setup.sh --show          # print what is configured now, change nothing
#   setup.sh --detect        # print what it can detect as JSON, change nothing
#   setup.sh --apply [flags] # write without asking (the superset-setup skill
#                            # calls this after collecting the answers)
#
# --apply flags, all optional except --repo:
#   --repo owner/name  --path DIR  --base BRANCH  --operator LOGIN  --name NAME
#   --linear SLUG|URL  --timezone TZ  --reviewer LOGIN  --superset-project ID
#   --short-name LABEL
#   --no-scout
#
# Adding a second repository keeps the first. Everything merges into the
# existing config; only the fields you pass are touched.
#
# Deliberately does NOT source lib.sh. That resolves the project key as it loads
# and refuses when no repo is configured, which is exactly the state this runs in.
set -eu

ROOT="${SUPERSET_ORCH_ROOT:-$HOME/.claude/superset-orchestrator}"
CONFIG="$ROOT/config.json"
SKILL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS_DIR="${SUPERSET_ORCH_AGENTS_DIR:-$HOME/.claude/agents}"

die()  { printf '\n%s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
say()  { printf '%s\n' "$*"; }

# ── What has to be there ──────────────────────────────────────────────────────
require_tools() {
  for tool in jq git gh; do
    have "$tool" || die "$tool is required and is not on PATH."
  done
  gh auth status >/dev/null 2>&1 || die "gh is not logged in — run: gh auth login"
}

# ── Detection ─────────────────────────────────────────────────────────────────
# Everything here is derived from the checkout the caller is standing in. A
# value that cannot be found comes back empty rather than guessed, so the
# caller can tell "not found" from "found nothing".

detect_repo() {
  # gh reads the remote and follows a rename. `gh pr list` does not follow one,
  # and a stale name returns an empty list rather than an error, which reads
  # exactly like "no open PRs" — so the name has to be right here.
  gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true
}

detect_path() {
  # The main clone, never a linked worktree: a worktree's checkout disappears
  # under reap, and the branch checks would follow it.
  local top
  top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$top" ] || return 0
  if [ "$(git rev-parse --git-dir 2>/dev/null)" != "$(git rev-parse --git-common-dir 2>/dev/null)" ]; then
    # In a linked worktree the common dir points into the main clone's .git.
    local common; common="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
    printf '%s' "$(dirname "$common")"
    return 0
  fi
  printf '%s' "$top"
}

detect_base()     { gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || true; }
detect_login()    { gh api user -q .login 2>/dev/null || true; }
detect_timezone() { readlink /etc/localtime 2>/dev/null | sed 's#.*/zoneinfo/##' || true; }

detect_superset_project() { # detect_superset_project <local path>
  local path="$1"
  have superset || return 0
  superset auth whoami --json >/dev/null 2>&1 || return 0
  superset projects list --local --json 2>/dev/null \
    | jq -r --arg p "$path" '.[]? | select(.repoPath == $p) | .id // empty' 2>/dev/null | head -1 || true
}

repo_key() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's#[^a-z0-9]\{1,\}#-#g'; }

linear_slug() { # accepts a slug or any Linear URL
  case "$1" in
    http*linear.app/*) printf '%s' "$1" | sed -E 's#^https?://linear\.app/([^/]+).*#\1#' ;;
    *)                 printf '%s' "$1" ;;
  esac
}

# ── The scout ─────────────────────────────────────────────────────────────────
# skills.sh installs skills, not subagents, so the scout ships inside this skill
# and gets placed here. Without it the orchestrator has no way to read Linear or
# Slack, and every signal has to come from gh.
install_scout() {
  local src="$SKILL_ROOT/agents/superset-scout.md"
  [ -f "$src" ] || { say "note: no scout at $src — skipping."; return 0; }
  mkdir -p "$AGENTS_DIR"
  if [ -f "$AGENTS_DIR/superset-scout.md" ] \
     && cmp -s "$src" "$AGENTS_DIR/superset-scout.md"; then
    say "scout already current at $AGENTS_DIR/superset-scout.md"
  else
    cp "$src" "$AGENTS_DIR/superset-scout.md"
    say "installed the scout to $AGENTS_DIR/superset-scout.md"
  fi
}

# ── Writing ───────────────────────────────────────────────────────────────────
# One repo at a time, merged. An existing entry keeps any field this run does
# not set, and the other repos are not touched.
write_config() { # write_config <json of {operator, repo}>
  local incoming="$1" key repo tmp backup existing_key
  repo="$(printf '%s' "$incoming" | jq -r '.repo.name')"

  # An existing key wins over the derivation. The board, the briefs and the log
  # all live in p/<key>/, so re-deriving a key that was set by hand would point
  # this repo at an empty directory and show the project as having no work.
  # `Acme-Org/Acme-Desktop` derives to `acme-org-acme-desktop`, against a
  # real config that says `acme-org-desktop`.
  existing_key=""
  [ -s "$CONFIG" ] && existing_key="$(jq -r --arg n "$repo" \
    '(.repos[]? | select(.name==$n) | .key) // empty' "$CONFIG" 2>/dev/null || true)"
  key="${existing_key:-$(repo_key "$repo")}"

  mkdir -p "$ROOT/workspaces" "$ROOT/p/$key"

  # Back up only a config that was already there. A first run has nothing to lose.
  if [ -s "$CONFIG" ]; then
    backup="$CONFIG.$(date +%Y%m%d%H%M%S).bak"
    cp "$CONFIG" "$backup"
  else
    printf '{}\n' > "$CONFIG"
  fi

  tmp="$(mktemp "$CONFIG.XXXXXX")"
  jq --argjson in "$incoming" --arg key "$key" '
    # Only non-empty incoming values win, so a re-run that skips a question
    # cannot blank a value that is already set.
    def live: with_entries(select(.value != null and .value != "" and .value != []));
    ($in.repo.name) as $name
    | .operator = ((.operator // {}) + ($in.operator | live))
    | .repos = (
        (.repos // []) as $rs
        | ($in.repo + {key: $key} | live) as $new
        | if ($rs | any(.name == $name))
          then ($rs | map(if .name == $name then . + $new else . end))
          else $rs + [$new] end
      )
    | .limits  = (.limits  // {maxActiveWorkspaces: 4})
    | .cadence = (.cadence // {watchSeconds: 120})
  ' "$CONFIG" > "$tmp"

  jq -e . "$tmp" >/dev/null 2>&1 || { rm -f "$tmp"; die "refusing to write invalid JSON."; }
  jq -e '.repos | length > 0' "$tmp" >/dev/null 2>&1 \
    || { rm -f "$tmp"; die "refusing to write a config with no repos."; }
  mv -f "$tmp" "$CONFIG"

  [ -n "${backup:-}" ] && say "previous config saved to $backup"
  say "wrote $CONFIG"
}

# ── --show ────────────────────────────────────────────────────────────────────
if [ "${1-}" = "--show" ]; then
  [ -f "$CONFIG" ] || die "no config at $CONFIG — run setup.sh to write one."
  jq '{operator, repos: [.repos[] | {name, key, shortName, localPath, defaultBase,
                                     supersetProjectId}], limits, cadence}' "$CONFIG"
  exit 0
fi

# ── --detect ──────────────────────────────────────────────────────────────────
# Machine-readable, so the setup skill can ask only for what is missing.
if [ "${1-}" = "--detect" ]; then
  require_tools
  d_repo="$(detect_repo)"; d_path="$(detect_path)"
  d_sp=""; [ -n "$d_path" ] && d_sp="$(detect_superset_project "$d_path")"
  existing='null'
  [ -f "$CONFIG" ] && existing="$(jq -c --arg r "$d_repo" \
      '{operator: (.operator // {}),
        repo: ((.repos // []) | map(select(.name == $r)) | first)}' "$CONFIG" 2>/dev/null || echo null)"

  jq -n --arg repo "$d_repo" --arg path "$d_path" --arg base "$(detect_base)" \
        --arg login "$(detect_login)" --arg tz "$(detect_timezone)" \
        --arg sp "$d_sp" --arg config "$CONFIG" --argjson existing "$existing" \
        --argjson hasSuperset "$(have superset && echo true || echo false)" '
    { detected: { repo: $repo, localPath: $path, defaultBase: $base,
                  githubLogin: $login, timezone: $tz, supersetProjectId: $sp },
      # Nothing here can be worked out from the checkout. Ask for these.
      needed: ( [ if $repo  == "" then "repo"      else empty end,
                  if $path  == "" then "localPath" else empty end,
                  "linearWorkspace", "reviewer" ] ),
      supersetOnPath: $hasSuperset,
      configPath: $config,
      existing: $existing }'
  exit 0
fi

# ── --apply ───────────────────────────────────────────────────────────────────
if [ "${1-}" = "--apply" ]; then
  shift
  require_tools
  a_repo="" a_path="" a_base="" a_login="" a_name="" a_linear="" a_tz="" a_reviewer=""
  a_short=""
  a_sp="" scout=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo)              a_repo="$2"; shift 2 ;;
      --path)              a_path="$2"; shift 2 ;;
      --base)              a_base="$2"; shift 2 ;;
      --operator)          a_login="$2"; shift 2 ;;
      --name)              a_name="$2"; shift 2 ;;
      --linear)            a_linear="$(linear_slug "$2")"; shift 2 ;;
      --timezone)          a_tz="$2"; shift 2 ;;
      --reviewer)          a_reviewer="$2"; shift 2 ;;
      --short-name)        a_short="$2"; shift 2 ;;
      --superset-project)  a_sp="$2"; shift 2 ;;
      --no-scout)          scout=0; shift ;;
      *) die "unknown flag: $1" ;;
    esac
  done
  [ -n "$a_repo" ] || die "--apply needs --repo owner/name"

  # Fill the blanks from the checkout rather than writing empties.
  [ -n "$a_path" ]  || a_path="$(detect_path)"
  [ -n "$a_base" ]  || a_base="$(detect_base)"
  [ -n "$a_login" ] || a_login="$(detect_login)"
  [ -n "$a_tz" ]    || a_tz="$(detect_timezone)"
  if [ -z "$a_sp" ] && [ -n "$a_path" ]; then a_sp="$(detect_superset_project "$a_path")"; fi

  write_config "$(jq -n \
    --arg login "$a_login" --arg name "$a_name" --arg ws "$a_linear" --arg tz "$a_tz" \
    --arg repo "$a_repo" --arg base "$a_base" --arg path "$a_path" \
    --arg reviewer "$a_reviewer" --arg sp "$a_sp" --arg short "$a_short" '
    { operator: { githubLogin: $login, linearName: $name, linearWorkspace: $ws, timezone: $tz },
      repo: { name: $repo, defaultBase: $base, localPath: $path,
              shortName: (if $short == "" then ($repo | split("/") | last) else $short end),
              reviewers: (if $reviewer == "" then [] else [$reviewer] end),
              supersetProjectId: (if $sp == "" then null else $sp end) } }')"
  [ "$scout" = 1 ] && install_scout
  exit 0
fi

[ $# -eq 0 ] || die "unknown argument: $1  (try --show, --detect, or --apply)"

# ── Interactive ───────────────────────────────────────────────────────────────
require_tools

ask() { # ask <prompt> <default> -> answer on stdout
  local prompt="$1" default="${2-}" reply
  if [ -n "$default" ]; then printf '%s [%s]: ' "$prompt" "$default" >&2
  else printf '%s: ' "$prompt" >&2; fi
  IFS= read -r reply || true
  printf '%s' "${reply:-$default}"
}

have superset || say "note: the superset CLI is not on PATH. The board and the
      scripts still work; dispatching agents into workspaces does not."

say ""
say "Setting up the orchestrator. Enter accepts the value in brackets."
say ""

d_repo="$(detect_repo)"
[ -n "$d_repo" ] && say "detected repository $d_repo"

repo=""
while [ -z "$repo" ]; do
  repo="$(ask "The repository to orchestrate (owner/name)" "$d_repo")"
  [ -n "$repo" ] || { say "  a repository is required."; continue; }
  actual="$(gh repo view "$repo" --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
  if [ -z "$actual" ]; then
    say "  cannot see $repo with your gh login — check the name, or your access."
    repo=""
  elif [ "$actual" != "$repo" ]; then
    say "  $repo is now $actual — using that, because gh pr list will not follow the rename."
    repo="$actual"
  fi
done

github_login="$(ask "Your GitHub login, or * for every PR in the repo" "$(detect_login)")"
operator_name="$(ask "Your name as it appears in your issue tracker" "$github_login")"
linear_raw="$(ask "Your Linear workspace (slug, or paste any Linear URL)" "")"
linear_ws="$(linear_slug "$linear_raw")"
[ -n "$linear_ws" ] || say "note: no Linear workspace — ticket links will be omitted."
timezone="$(ask "Your timezone" "$(detect_timezone)")"

local_path="$(ask "Path to your main clone of $repo (not a worktree)" "$(detect_path)")"
[ -d "$local_path/.git" ] || say "note: $local_path is not a git checkout — branch checks will be skipped."
default_base="$(ask "The base branch" "$(detect_base)")"
reviewer="$(ask "Default reviewer for PRs (GitHub login, blank for none)" "")"

superset_project=""
if have superset; then
  detected_sp="$(detect_superset_project "$local_path")"
  [ -n "$detected_sp" ] && say "detected Superset project $detected_sp"
  superset_project="$(ask "Superset project id (blank to fill in later)" "$detected_sp")"
fi

say ""
write_config "$(jq -n \
  --arg login "$github_login" --arg name "$operator_name" --arg ws "$linear_ws" \
  --arg tz "$timezone" --arg repo "$repo" --arg base "$default_base" \
  --arg path "$local_path" --arg reviewer "$reviewer" --arg sp "$superset_project" --arg short "$short_name" '
  { operator: { githubLogin: $login, linearName: $name, linearWorkspace: $ws, timezone: $tz },
    repo: { name: $repo, defaultBase: $base, localPath: $path,
              shortName: (if $short == "" then ($repo | split("/") | last) else $short end),
            reviewers: (if $reviewer == "" then [] else [$reviewer] end),
            supersetProjectId: (if $sp == "" then null else $sp end) } }')"
install_scout

say ""
say "Next:"
say "  1. $SKILL_ROOT/scripts/preflight.sh      # check the environment"
say "  2. $SKILL_ROOT/scripts/watch.sh --start  # start the poller"
