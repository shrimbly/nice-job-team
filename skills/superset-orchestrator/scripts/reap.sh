#!/usr/bin/env bash
# Close a landed item: verify the PR merged and the worktree holds nothing
# unsaved, delete the workspace, tidy the local branch, and close the board item.
#
# Refuses on anything unmerged, dirty, or unpushed. There is no --force: if the
# checks fail, the answer is a human looking at it, not a bigger hammer.
#
# Usage: reap.sh --item itm_007 [--dry-run]
#        reap.sh --workspace <id> --repo owner/name [--dry-run]

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

item="" wsid="" repo="" dry=0 abandon=0 discard=0
while [ $# -gt 0 ]; do
  case "$1" in
    --item) item="$2"; shift 2 ;;
    --workspace) wsid="$2"; shift 2 ;;
    --repo) repo="$2"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    # Cancelled work, not landed work: skip the merged-PR proof. Everything else —
    # clean tree, nothing unpushed, not the primary checkout — still applies, so an
    # abandon cannot quietly destroy work someone would want back.
    --abandon) abandon=1; shift ;;
    # Only with --abandon, and only when you mean it: allow uncommitted/unpushed work
    # to be thrown away. Prints exactly what it is dropping first.
    --discard-changes) discard=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ "$discard" = 1 ] && [ "$abandon" = 0 ] && die "--discard-changes only makes sense with --abandon"

branch="" pr=""
if [ -n "$item" ]; then
  obj="$(board_item "$item")"
  [ -n "$obj" ] || die "no board item $item"
  wsid="${wsid:-$(printf '%s' "$obj" | jq -r '.workspaceId // empty')}"
  repo="${repo:-$(printf '%s' "$obj" | jq -r '.repo // empty')}"
  branch="$(printf '%s' "$obj" | jq -r '.branch // empty')"
  pr="$(printf '%s' "$obj" | jq -r '.pr.number // empty')"
fi
[ -n "$wsid" ] || die "need --item or --workspace"
[ -n "$repo" ] || die "need --repo (or an item that records one)"

superset_authed || die "not logged in — superset auth login"

ws="$(superset workspaces get "$wsid" --json 2>/dev/null || echo '{}')"
[ "$(printf '%s' "$ws" | jq -r '.id // empty')" = "$wsid" ] || die "workspace $wsid not found on this host"
wt="$(printf '%s' "$ws" | jq -r '.worktreePath // empty')"
[ -z "$branch" ] && branch="$(printf '%s' "$ws" | jq -r '.branch // empty')"

# --- 0. never reap the primary checkout, or the workspace we are running in ---
# A project's main workspace points at the real clone, not a linked worktree.
# Deleting it takes the repository with it. `git-dir == git-common-dir` is the test.
if [ -n "$wt" ] && [ -d "$wt" ]; then
  if [ "$(git -C "$wt" rev-parse --git-dir 2>/dev/null)" = "$(git -C "$wt" rev-parse --git-common-dir 2>/dev/null)" ]; then
    die "workspace $wsid is the PRIMARY CHECKOUT at $wt, not a linked worktree — deleting it would take the clone with it. Reap only linked worktrees."
  fi
fi
if [ -n "${SUPERSET_WORKSPACE_ID:-}" ] && [ "$wsid" = "$SUPERSET_WORKSPACE_ID" ]; then
  die "workspace $wsid is the one this session is running in — refusing to delete the ground under our feet"
fi

# --- 1. the PR really merged ------------------------------------------------
if [ "$abandon" = 1 ]; then
  warn "--abandon: skipping the merged-PR check. This is cancelled work, not landed work."
else
  if [ -z "$pr" ] && [ -n "$branch" ]; then
    pr="$(gh pr list --repo "$repo" --head "$branch" --state all --limit 1 --json number --jq '.[0].number // empty' 2>/dev/null || true)"
  fi
  [ -n "$pr" ] || die "no PR found for branch '$branch' in $repo — nothing has landed, so nothing to reap. If the task was cancelled, use --abandon."
  prj="$(gh pr view "$pr" --repo "$repo" --json state,mergedAt,url,headRefName 2>/dev/null || echo '{}')"
  state="$(printf '%s' "$prj" | jq -r '.state // "?"')"
  [ "$state" = "MERGED" ] || die "PR #$pr is $state, not MERGED — $(printf '%s' "$prj" | jq -r '.url // ""')"
fi

# --- 2. nothing unsaved in the worktree -------------------------------------
if [ -n "$wt" ] && [ -d "$wt" ]; then
  dirty="$(git -C "$wt" status --porcelain | wc -l | tr -d ' ')"
  if [ "$dirty" != "0" ]; then
    if [ "$discard" = 1 ]; then
      warn "--discard-changes: throwing away $dirty uncommitted change(s) in $wt:"
      git -C "$wt" status --short | sed 's/^/         /' >&2
    else
      die "$dirty uncommitted change(s) in $wt — deleting the workspace would destroy them. Add --discard-changes if that is intended."
    fi
  fi
  if git -C "$wt" rev-parse '@{u}' >/dev/null 2>&1; then
    ahead="$(git -C "$wt" rev-list --count '@{u}..HEAD')"
    if [ "$ahead" != "0" ]; then
      if [ "$discard" = 1 ]; then
        warn "--discard-changes: throwing away $ahead unpushed commit(s) in $wt:"
        git -C "$wt" log --oneline '@{u}..HEAD' | sed 's/^/         /' >&2
      else
        die "$ahead unpushed commit(s) in $wt — add --discard-changes if that is intended"
      fi
    fi
  elif [ "$abandon" = 1 ]; then
    # No upstream on abandoned work is normal — it was never pushed. But commits that
    # exist only here vanish with the worktree, so name them before they go.
    local_only="$(git -C "$wt" rev-list --count origin/HEAD..HEAD 2>/dev/null || echo 0)"
    if [ "$local_only" != "0" ] && [ "$local_only" != "" ]; then
      if [ "$discard" = 1 ]; then
        warn "--discard-changes: $local_only local commit(s) exist nowhere else and will be lost:"
        git -C "$wt" log --oneline origin/HEAD..HEAD 2>/dev/null | sed 's/^/         /' >&2
      else
        die "$local_only local commit(s) were never pushed and exist only in $wt — add --discard-changes if losing them is intended"
      fi
    fi
  else
    warn "no upstream for $branch in $wt — PR #$pr merged, so treating as pushed"
  fi
  # Stashes are worth mentioning but never worth blocking on: `refs/stash` lives in
  # the SHARED git dir, so every worktree of the repo lists the same stashes and
  # removing a worktree does not touch any of them. Blocking here meant one forgotten
  # stash on an unrelated branch made every workspace in the repo unreapable.
  st="$(git -C "$wt" stash list 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$st" != "0" ]; then
    warn "$st stash entr(ies) visible from this worktree — shared with the whole repo, and untouched by this delete:"
    git -C "$wt" stash list | sed 's/^/         /' >&2
  fi
else
  warn "worktree path not on disk — skipping the dirty/unpushed checks"
fi

if [ "$dry" = 1 ]; then
  if [ "$abandon" = 1 ]; then
    printf 'would abandon workspace %s (%s) — cancelled work, %s\n' "$wsid" "$branch" \
      "$([ "${dirty:-0}" = "0" ] && echo 'nothing to lose' || echo "DISCARDING ${dirty} change(s)")"
  else
    printf 'would delete workspace %s (%s) — PR #%s merged, worktree clean\n' "$wsid" "$branch" "$pr"
  fi
  exit 0
fi

# --- 3. delete the workspace (runs the project's teardown) -------------------
superset workspaces delete "$wsid" --local --json >/dev/null || die "workspace delete failed"

# --- 3b. prune the empty parent a slashed branch name leaves behind ----------
# `dev/preset-count-copy` becomes .../worktrees/<project>/dev/preset-count-copy,
# so deleting the leaf strands an empty `dev/`. Only ever removes empty dirs,
# and never climbs above the worktrees root.
if [ -n "$wt" ]; then
  root="$HOME/.superset/worktrees"
  parent="$(dirname "$wt")"
  while [ "$parent" != "$root" ] && [ "$parent" != "/" ] && \
        case "$parent" in "$root"/*) true ;; *) false ;; esac && \
        [ -d "$parent" ] && [ -z "$(ls -A "$parent" 2>/dev/null)" ]; do
    rmdir "$parent" 2>/dev/null || break
    parent="$(dirname "$parent")"
  done
fi

# --- 4. tidy the local branch in the main clone ------------------------------
clone="$(repo_cfg "$repo" '.localPath')"
if [ -n "$clone" ] && [ -d "$clone/.git" ] && [ -n "$branch" ]; then
  git -C "$clone" worktree prune >/dev/null 2>&1 || true
  if git -C "$clone" branch --list "$branch" | grep -q .; then
    git -C "$clone" branch -d "$branch" >/dev/null 2>&1 \
      || warn "kept local branch $branch (git says it is not fully merged — check by hand)"
  fi
fi

# --- 5. close the item and log ----------------------------------------------
if [ -n "$item" ]; then
  board_set "$item" "$(jq -nc '{state:"closed"}')"
  # Anything waiting on this item is now dispatchable — surface it.
  unblocked="$(jq -r --arg id "$item" '.items[]? | select((.blockedBy==$id) or (.stackParent==$id)) | .id' "$BOARD" | tr '\n' ' ')"
  [ -n "$unblocked" ] && printf 'unblocked: %s\n' "$unblocked"
fi
rm -f "$WORKSPACES_DIR/$wsid.json"
log_event reaped "${item:--}" workspaceId="$wsid" branch="$branch" pr="$pr" repo="$repo"

if [ "$abandon" = 1 ]; then
  printf 'abandoned %s — cancelled work, workspace deleted, branch tidied\n' "${item:-$wsid}"
else
  printf 'reaped %s — PR #%s merged, workspace deleted, branch tidied\n' "${item:-$wsid}" "$pr"
fi
