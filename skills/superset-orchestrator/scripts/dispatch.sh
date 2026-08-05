#!/usr/bin/env bash
# Create a workspace, start an implementation agent in it, and record it on the
# board. Requires an approved item and an existing brief.
#
# Usage:
#   dispatch.sh --item itm_007 [--slug …] [--branch …] [--base main] [--repo owner/name]
#   dispatch.sh --slug eng-142-log-table --branch dev/eng-142-… --repo acme/website
#
# Anything not passed is read from the board item. --dry-run prints the command.

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

item="" slug="" branch="" base="" repo="" task_id="" agent="" dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --item)   item="$2"; shift 2 ;;
    --slug)   slug="$2"; shift 2 ;;
    --branch) branch="$2"; shift 2 ;;
    --base)   base="$2"; shift 2 ;;
    --repo)   repo="$2"; shift 2 ;;
    --task-id) task_id="$2"; shift 2 ;;
    --agent)  agent="$2"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    --no-item) allow_no_item=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

# An item is the board's record that this work was approved and is now running.
# Dispatching without one creates a live workspace and a live agent that nothing
# tracks: poll/sync/autoreap all iterate .items, so an unrecorded dispatch is
# invisible until someone notices the workspace by hand. Refuse by default.
if [ -z "$item" ] && [ "${allow_no_item:-0}" != 1 ]; then
  die "no --item. Create the board item first, then dispatch with --item <id>.
     Dispatching without one leaves the workspace and agent untracked — poll.sh,
     sync.sh and autoreap.sh all iterate .items and will never see it.
     If this is genuinely a throwaway workspace, pass --no-item to say so."
fi

# Fill the gaps from the board item.
if [ -n "$item" ]; then
  obj="$(board_item "$item")"
  [ -n "$obj" ] || die "no board item $item"
  [ -z "$slug" ]   && slug="$(printf '%s' "$obj"   | jq -r '.slug // empty')"
  [ -z "$branch" ] && branch="$(printf '%s' "$obj" | jq -r '.branch // empty')"
  [ -z "$base" ]   && base="$(printf '%s' "$obj"   | jq -r '.baseBranch // empty')"
  [ -z "$repo" ]   && repo="$(printf '%s' "$obj"   | jq -r '.repo // empty')"
  [ -z "$task_id" ] && task_id="$(printf '%s' "$obj" | jq -r '.supersetTaskId // empty')"

  # Board titles are scan-labels, not summaries. The board is read at a glance and
  # rendered in a narrow table column, so a title long enough to explain the work
  # pushes out the columns that carry the state. The full statement of intent lives
  # in `outcome` and in the brief; the title only has to identify the row.
  # Shape: "<TICKET> - <up to five words>". The ticket number goes first so the board
  # can be cross-referenced against Linear without opening anything, and it is derived
  # from the item's own source so the two cannot drift.
  title="$(printf '%s' "$obj" | jq -r '.title // ""')"
  eid="$(printf '%s' "$obj" | jq -r '.source.externalId // ""')"

  if [ -n "$eid" ] && [ "${title#"$eid"}" = "$title" ]; then
    die "board title for $item must start with its ticket number.
     got:      \"$title\"
     expected: \"$eid - <up to five words>\""
  fi

  # Count the description only — the ticket prefix is an identifier, not a word.
  desc="${title#"$eid"}"
  desc="${desc# - }"
  words="$(printf '%s' "$desc" | wc -w | tr -d ' ')"
  if [ "$words" -gt 5 ]; then
    die "board title for $item describes the work in $words words — max 5.
     got:  \"$title\"
     Titles name the work, they do not describe it. Put the description in .outcome.
     e.g. \"$eid - Remove API key fields\", \"$eid - Add requirements filter\"."
  fi

  state="$(printf '%s' "$obj" | jq -r '.state')"
  # `pr-open` is dispatchable too: an open PR that went red or conflicted needs an
  # agent, and it may have no workspace (or have lost one). It lands in `fixing`
  # rather than `dispatched`, because the PR already exists.
  case "$state" in
    proposed|orphaned) next_state="dispatched" ;;
    pr-open)           next_state="fixing" ;;
    *) die "item $item is in state '$state' — dispatchable states are 'proposed', 'orphaned' and 'pr-open'" ;;
  esac
  parent="$(printf '%s' "$obj" | jq -r '.stackParent // empty')"
  if [ -n "$parent" ]; then
    pstate="$(board_item "$parent" | jq -r '.state // "missing"')"
    case "$pstate" in
      pr-open|fixing|merged|closed) : ;;
      *) die "stack parent $parent is '$pstate' — dispatch a stacked child only once the parent's PR is open" ;;
    esac
  fi
fi

[ -n "$slug" ]   || die "need --slug"
[ -n "$branch" ] || die "need --branch"
[ -n "$repo" ]   || die "need --repo"
agent="${agent:-$(cfg '.superset.agent' claude)}"

project="$(repo_cfg "$repo" '.supersetProjectId')"
[ -n "$project" ] || die "no supersetProjectId for $repo in config.json (superset projects list --local --json)"
[ -n "$base" ] || base="$(repo_cfg "$repo" '.defaultBase' main)"

brief="$BOARD_DIR/briefs/$slug.md"
[ -f "$brief" ] || die "no brief at $brief — write it before dispatching (reference/dispatch-brief.md)"

# Concurrency cap: the operator's review capacity, not the machine's.
if [ -f "$BOARD" ]; then
  max="$(cfg '.limits.maxActiveWorkspaces' 4)"
  active="$(jq '[.items[]? | select(.state|IN("dispatched","building","awaiting-approval","fixing"))] | length' "$BOARD")"
  if [ "$active" -ge "$max" ]; then
    die "$active active workspaces already (cap $max) — land something before dispatching more"
  fi
fi

# One branch = one workspace. Refuse a duplicate rather than confusing two agents.
if superset_authed; then
  dupe="$(sup_json workspaces list --local | jq -r --arg b "$branch" '.[]? | select(.branch==$b) | .id' | head -1)"
  [ -n "$dupe" ] && die "workspace $dupe is already on branch $branch — re-prompt it with 'superset agents create --workspace $dupe' instead"
fi

prompt="Load the superset-implementer skill, then read your brief at $brief and follow it.
You are ${item:-$slug} on branch $branch, based on $base, in repo $repo.
Write your status file before you start work."

set -- workspaces create --local \
  --project "$project" \
  --name "$slug" \
  --branch "$branch" \
  --base-branch "$base" \
  --agent "$agent" \
  --prompt "$prompt"

# --effort is documented but absent from some CLI builds; only pass it if real.
effort="$(cfg '.superset.effort')"
if [ -n "$effort" ] && superset workspaces create --help 2>&1 | grep -q -- '--effort'; then
  set -- "$@" --effort "$effort"
fi

if [ "$dry" = 1 ]; then
  printf 'superset'; printf ' %q' "$@"; printf ' --json\n'
  exit 0
fi

superset_authed || die "not logged in — superset auth login"
out="$(superset "$@" --json)" || die "workspace create failed"
# v1.17.0 returns {workspace:{id,…}, agents:[…], alreadyExists}; older/other shapes
# put the id at the top level. Accept both rather than losing a created workspace.
wsid="$(printf '%s' "$out" | jq -r '.workspace.id // .id // .workspaceId // empty')"
agent_ok="$(printf '%s' "$out" | jq -r '(.agents // [])[0].ok // empty')"
session_id="$(printf '%s' "$out" | jq -r '(.agents // [])[0].sessionId // empty')"
[ "$agent_ok" = "true" ] || warn "workspace created but the agent did not start cleanly — check with: superset workspaces open $wsid"
[ -n "$wsid" ] || { printf '%s\n' "$out"; die "could not read a workspace id from the response"; }

if [ -n "$task_id" ] && [ "$(cfg '.superset.linkWorkspaceToTask' true)" = "true" ]; then
  superset workspaces update "$wsid" --task-id "$task_id" --json >/dev/null 2>&1 \
    || warn "could not link task $task_id (tasks may not be enabled on this plan)"
fi

if [ -n "$item" ]; then
  # `createdByOrchestrator` is the auto-reap permission. It is set ONLY here, where
  # we genuinely created the workspace — never when re-prompting an existing one via
  # `agents create`. Without it, autoreap.sh leaves the workspace alone, which is what
  # keeps the operator's own hand-made workspaces safe.
  board_set "$item" "$(jq -nc --arg w "$wsid" --arg b "$branch" --arg base "$base" --arg br "$brief" \
    --arg st "${next_state:-dispatched}" \
    '{state:$st, workspaceId:$w, branch:$b, baseBranch:$base, briefPath:$br,
      createdByOrchestrator:true}')"
fi
log_event dispatched "${item:--}" slug="$slug" workspaceId="$wsid" branch="$branch" repo="$repo" agent="$agent" sessionId="${session_id:-}"

printf 'dispatched %s\n' "$slug"
printf '  workspace %s\n' "$wsid"
[ -n "$session_id" ] && printf '  session   %s\n' "$session_id"
printf '  branch    %s (base %s)\n' "$branch" "$base"
printf '  brief     %s\n' "$brief"
printf '  open      superset workspaces open %s\n' "$wsid"
