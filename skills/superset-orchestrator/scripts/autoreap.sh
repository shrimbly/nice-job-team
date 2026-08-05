#!/usr/bin/env bash
# Reap the workspaces this orchestrator created, once their PR has merged.
#
# Only touches items with `createdByOrchestrator: true` — set by dispatch.sh at the
# moment it creates a workspace, and never when re-prompting an existing one. The
# operator's own hand-made workspaces are therefore never auto-deleted, even when
# their PR merges.
#
# reap.sh still does all four safety checks (merged / clean / pushed / not the
# primary checkout) and refuses on any of them, so this loop is safe to run often.
#
#   autoreap.sh            # reap everything eligible
#   autoreap.sh --dry-run  # say what it would do
#   autoreap.sh --quiet    # only speak when something happened

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

dry=""; quiet=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry="--dry-run"; shift ;;
    --quiet) quiet=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ "$(cfg '.gates.autoReapOwnWorkspaces' false)" = "true" ] || {
  [ "$quiet" = 1 ] || printf 'auto-reap is off (gates.autoReapOwnWorkspaces)\n'; exit 0; }

[ -f "$BOARD" ] || die "no board at $BOARD"
reaped=0

# Candidates: ours, still have a workspace, have a PR, not already closed.
while IFS=$'\t' read -r item wsid repo pr slug; do
  [ -z "$item" ] && continue
  state="$(gh pr view "$pr" --repo "$repo" --json state --jq .state 2>/dev/null || echo '')"
  [ "$state" = "MERGED" ] || continue

  if [ -n "$dry" ]; then
    printf 'would reap %s (%s) — PR #%s merged\n' "$item" "$slug" "$pr"
    continue
  fi

  # reap.sh refuses loudly on dirty/unpushed/primary-checkout; that refusal is not an
  # error here, it just means "not yet". Keep going through the rest either way.
  if out="$("$SKILL_DIR/scripts/reap.sh" --item "$item" 2>&1)"; then
    printf 'auto-reaped %s (%s) — PR #%s merged\n' "$item" "$slug" "$pr"
    printf '%s\n' "$out" | grep -E '^unblocked:' || true
    reaped=$((reaped + 1))
  else
    printf 'skipped %s (%s): %s\n' "$item" "$slug" \
      "$(printf '%s' "$out" | grep -m1 '^BLOCKED:' || printf 'see reap.sh output')" >&2
  fi
done < <(jq -r '.items[]?
  | select(.createdByOrchestrator == true)
  | select(.workspaceId != null)
  | select(.pr.number != null)
  | select(.state | IN("closed","rejected") | not)
  | [.id, .workspaceId, .repo, (.pr.number|tostring), (.slug // .id)] | @tsv' "$BOARD")

if [ "$quiet" = 1 ] && [ "$reaped" = 0 ]; then exit 0; fi
# An `if`, not `[ ] && cmd` — a trailing test that evaluates false makes the whole
# script exit non-zero under `set -e`, which reads as a failure to every caller.
if [ -z "$dry" ]; then
  printf 'auto-reap: %s workspace(s) reaped\n' "$reaped"
fi
exit 0
