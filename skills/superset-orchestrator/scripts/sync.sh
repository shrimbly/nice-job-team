#!/usr/bin/env bash
# Fold what the agents and GitHub know back into board.json.
#
# Three things drift constantly and were being reconciled by hand:
#   1. item.state        — agents move on; the board does not hear about it
#   2. item.pr           — an agent opens a PR and only records it in its own status
#   3. item.workspaceId  — a workspace can be deleted, or its branch switched
#
# Cheap, idempotent, no model needed. Run it before anything that reads the board.

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

[ -f "$BOARD" ] || die "no board at $BOARD"
at="$(now)"

status_json='[]'
if ls "$WORKSPACES_DIR"/*.json >/dev/null 2>&1; then
  status_json="$(jq -s '[.[] | select(.workspaceId != null)]' "$WORKSPACES_DIR"/*.json)"
fi

# Scoped to THIS board's projects, the same filter poll.sh uses. The two disagreed:
# poll.sh filtered and sync.sh did not. That mismatch is the only reason the prune
# below was safe — an unfiltered list happens to contain every other project's live
# workspaces, so it never pruned them. Filter without reading the next comment and
# sync starts deleting the status files of every other project on the host.
projects="$(jq -c '[.repos[]?.supersetProjectId // empty]' "$CONFIG" 2>/dev/null || echo '[]')"
live_ws='[]'
if superset_authed; then
  live_ws="$(sup_json workspaces list --local \
    | jq -c --argjson p "$projects" '
        [ .[]?
          | select(($p | length) == 0 or (.projectId as $id | $p | index($id)))
          | {id, branch, name} ]')"
fi

# Prune status files whose workspace no longer exists. They are read every cycle
# and keep voting on state long after the agent that wrote them is gone. Guarded
# on a non-empty live list: a transient auth failure must not delete all of them.
#
# The inbox is shared by every project on this host, so "not in MY live list" is
# not enough to delete — that describes every other project's running agents too.
# Delete only a file this board claims: an item of ours references that workspace,
# and the workspace is gone. Anything we do not claim belongs to somebody else.
ours="$(jq -c '[.items[]?.workspaceId // empty]' "$BOARD")"
if [ "$(printf '%s' "$live_ws" | jq 'length')" -gt 0 ] && ls "$WORKSPACES_DIR"/*.json >/dev/null 2>&1; then
  for f in "$WORKSPACES_DIR"/*.json; do
    wsid="$(basename "$f" .json)"
    claimed="$(printf '%s' "$ours" | jq --arg w "$wsid" 'index($w) != null')"
    alive="$(printf '%s' "$live_ws" | jq --arg w "$wsid" 'map(select(.id == $w)) | length > 0')"
    if [ "$claimed" = "true" ] && [ "$alive" = "false" ]; then
      rm -f "$f"
      printf '  pruned orphan status file %s\n' "${wsid:0:8}"
    fi
  done
  status_json='[]'
  if ls "$WORKSPACES_DIR"/*.json >/dev/null 2>&1; then
    status_json="$(jq -s '[.[] | select(.workspaceId != null)]' "$WORKSPACES_DIR"/*.json)"
  fi
fi

# Live PR facts, so a stale status file cannot outvote an observable PR.
prs='[]'
merged_prs='[]'
if [ -f "$BOARD_DIR/signals/github.json" ]; then
  prs="$(jq -c '[.repos[]?.open[]? | {number, mergeStateStatus, unresolvedThreads, reviewDecision, ciState, isDraft}]' \
         "$BOARD_DIR/signals/github.json" 2>/dev/null || echo '[]')"
  merged_prs="$(jq -c '[.repos[]?.merged[]?.number]' \
         "$BOARD_DIR/signals/github.json" 2>/dev/null || echo '[]')"
fi

atomic_json "$BOARD" '
  ($st | INDEX(.workspaceId)) as $by
  | ($ws | INDEX(.id)) as $live
  | ($pr | INDEX(.number)) as $prby
  | .updatedAt = $at
  | .items = [ .items[]
    | . as $it
    | ($by[($it.workspaceId // "")] // null) as $a
    | ($prby[($it.pr.number // -1 | tostring)] // null) as $livepr
    # An agent writes its status when it STARTS a piece of work and often forgets
    # to write again when it finishes, so "fixing" outlives the fix. Believe the
    # PR over the status file: if the PR is open, not conflicting, and nobody is
    # waiting on us, the work is done regardless of what the agent last said.
    | (($livepr != null)
       and ($livepr.mergeStateStatus != "DIRTY")
       and ($livepr.mergeStateStatus != "CONFLICTING")
       and (($livepr.unresolvedThreads // 0) == 0)) as $prHealthy
    # The rules below exist because an agent writes "fixing" when work STARTS and
    # often never writes again, so the status outlives the fix. That reasoning only
    # holds while the status file is the older fact. When the agent wrote AFTER the
    # last thing that happened on the PR, it has not forgotten — it has just told us
    # something we do not otherwise know, such as feedback the operator gave in the
    # workspace chat rather than on GitHub. Believe it.
    #
    # Both timestamps are ISO-8601 UTC, so a string compare is a time compare.
    | (($a.updatedAt // null) as $aat
       | ($livepr.latestActivityAt // null) as $pat
       | ($aat != null) and (($pat == null) or ($aat > $pat))) as $agentFresh
    # 1. state follows the agent, except for terminal board states and except
    #    when it would drag a healthy PR backwards into work-in-progress.
    | (if ($a != null) and ($a.state != null) and ($a.state != $it.state)
          and (($it.state | IN("closed","rejected")) | not)
          and ((($it.state | IN("pr-open","ready")) and ($a.state | IN("fixing","building")) and $prHealthy and ($agentFresh | not)) | not)
       then . + {state: $a.state,
                 history: ((.history // []) + [{at:$at, from:$it.state, to:$a.state, by:"sync: agent status"}])}
       else . end)
    # 1b. and the same rule forwards: a healthy PR on an item the board still
    #     thinks is being worked on has landed, whatever the status file says.
    | (if (.state | IN("fixing","building")) and $prHealthy and ($agentFresh | not)
       then . + {state:"pr-open",
                 history: ((.history // []) + [{at:$at, from:.state, to:"pr-open", by:"sync: PR healthy, status file stale"}])}
       else . end)
    # 1c. a merged PR with no workspace left to reap. autoreap.sh only walks items
    #     that still have a workspace, so an item whose workspace was removed by
    #     hand (or by a reap that closed the item first) sits at pr-open forever
    #     and renders as "gone from open". Membership of the merged list is the
    #     test, not absence from the open one, which a rename also produces.
    | (.pr.number // null) as $prnum
    | (if (.state | IN("closed","rejected") | not)
          and ($prnum != null)
          and (($merged | index($prnum)) != null)
          and (.workspaceId == null)
       then . + {state:"closed",
                 history: ((.history // []) + [{at:$at, from:.state, to:"closed", by:"sync: PR merged, no workspace to reap"}])}
       else . end)
    # 1d. approved, green, no conflicts, nothing unresolved: the only thing left is
    #     a human pressing merge. That is worth its own state — "pr-open" covers
    #     everything from just-pushed to ready, so the one case needing action
    #     looked identical to the five that did not.
    | (if (.state | IN("pr-open","fixing"))
          and ($livepr != null)
          and ($livepr.reviewDecision == "APPROVED")
          and ($livepr.ciState == "green")
          and (($livepr.mergeStateStatus // "") | IN("CLEAN","HAS_HOOKS"))
          and (($livepr.unresolvedThreads // 0) == 0)
          and (($livepr.isDraft // false) | not)
       then . + {state:"ready",
                 history: ((.history // []) + [{at:$at, from:.state, to:"ready", by:"sync: approved, green, mergeable"}])}
       else . end)
    # …and back out again if it stops being true (a new push, a fresh conflict).
    | (if (.state == "ready") and ($livepr != null)
          and (($livepr.reviewDecision != "APPROVED") or ($livepr.ciState != "green")
               or (($livepr.unresolvedThreads // 0) > 0))
       then . + {state:"pr-open",
                 history: ((.history // []) + [{at:$at, from:"ready", to:"pr-open", by:"sync: no longer ready"}])}
       else . end)
    # 2. a PR the agent opened, which the board has never seen
    | (if ($a != null) and (($a.pr.number // null) != null) and ((.pr.number // null) == null)
       then . + {pr: ((.pr // {}) + {number: $a.pr.number, url: $a.pr.url})}
       else . end)
    # 3a. an open item with no workspace, but a live workspace on its branch: adopt
    #     it. One workspace is one branch, so the branch is a reliable key. This makes
    #     the board self-healing — a bad reading that nulled workspaceId is repaired on
    #     the next good cycle instead of needing a human to re-link it by hand.
    | (if (.workspaceId == null) and (.state | IN("closed","rejected") | not) and (.branch != null)
       then (.branch as $b
             | ($ws | map(select(.branch == $b)) | .[0]) as $found
             | if $found != null
               then . + {workspaceId: $found.id,
                         history: ((.history // []) + [{at:$at, from:.state, to:.state, by:"sync: re-linked workspace by branch"}])}
               else . end)
       else . end)
    # 3. a workspace that has gone, or moved to a different branch.
    #    Guarded on a non-empty live list, exactly as the prune above is. An empty
    #    list means the CLI failed, or the project filter matched nothing — it does
    #    NOT mean every workspace was deleted. Without this guard one bad reading
    #    nulls workspaceId on every item at once, and rule 1c then closes each one
    #    whose PR has merged, leaving live worktrees that nothing on the board owns.
    #    That is precisely what happened to four items on 2026-08-03.
    | (if (.workspaceId != null) and (.state | IN("closed","rejected") | not)
          and (($ws | length) > 0)
       then (if ($live[.workspaceId] // null) == null
             then . + {workspaceId: null,
                       history: ((.history // []) + [{at:$at, from:.state, to:.state, by:"sync: workspace gone"}])}
             elif (.branch != null) and ($live[.workspaceId].branch != .branch)
             then . + {workspaceDrift: $live[.workspaceId].branch}
             else . + {workspaceDrift: null} end)
       else . end) ]' \
  --argjson st "$status_json" --argjson ws "$live_ws" --argjson pr "$prs" --argjson merged "$merged_prs" --arg at "$at"

# Say only what changed, so this is quiet in a loop.
jq -r --arg at "$at" '
  [ .items[]? | select((.history // []) | any(.at == $at)) ] as $moved
  | if ($moved | length) == 0 then empty
    else ($moved[] | "  \(.slug // .id): " + ((.history | map(select(.at==$at)) | last | .by) // "changed")
          + " → \(.state)" + (if .pr.number then " (#\(.pr.number))" else "" end))
    end' "$BOARD"

# A closed item that still holds a live workspace. autoreap.sh only walks open
# items, so this is invisible to every automation: the agent keeps running, keeps
# writing status, and keeps a worktree on disk long after its PR landed. Never
# reaped automatically — some of these hold unpushed work — so say it out loud.
# Never nag about the primary checkout. A project's main workspace points at the
# real clone, so reap.sh refuses it by design — warning about it produces advice
# that cannot be followed, every single cycle. Work done directly in the primary
# checkout (rather than a worktree) lands here legitimately.
primary='[]'
if [ "$(printf '%s' "$live_ws" | jq 'length')" -gt 0 ]; then
  primary="$(printf '%s' "$live_ws" | jq -r '.[].id' | while read -r wid; do
    p="$(sup_json workspaces get "$wid" | jq -r '.worktreePath // empty')"
    if [ -n "$p" ] && [ -d "$p" ] && \
       [ "$(git -C "$p" rev-parse --git-dir 2>/dev/null)" = "$(git -C "$p" rev-parse --git-common-dir 2>/dev/null)" ]; then
      printf '%s\n' "$wid"
    fi
  done | jq -R . | jq -sc .)"
fi

jq -r --argjson ws "$live_ws" --argjson primary "$primary" '
  ($ws | INDEX(.id)) as $live
  | .items[]? | select((.state | IN("closed","rejected")) and .workspaceId != null and ($live[.workspaceId] != null))
  # Bind before index(): inside index(...) the input is $primary, so a bare
  # .workspaceId there indexes the ARRAY and dies. Same trap as $merged above.
  | .workspaceId as $w
  | select(($primary | index($w)) == null)
  | "  stray: \(.slug // .id) is \(.state) but workspace \(.workspaceId[0:8]) is still alive — reap.sh --item \(.id), or --abandon if it was cancelled"' \
  "$BOARD" >&2

drift="$(jq -r '[.items[]? | select(.workspaceDrift != null)] | length' "$BOARD")"
if [ "$drift" != "0" ]; then
  jq -r '.items[]? | select(.workspaceDrift != null)
    | "  drift: \(.slug // .id) expects \(.branch) but its workspace is on \(.workspaceDrift)"' "$BOARD" >&2
fi
