#!/usr/bin/env bash
# The free tier of SENSE: GitHub PR state, CI, unresolved review threads, live
# Superset workspaces, agent status files, and session liveness. No model tokens.
#
# Writes  signals/github.json, signals/workspaces.json  (previous → *.prev.json)
# Prints  a compact human summary — read the summary, not the files.
#
# Usage: poll.sh [--repo owner/name]   (default: every repo in config.json)

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

only_repo=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) only_repo="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -f "$CONFIG" ] || die "no config at $CONFIG — run preflight.sh"
mkdir -p "$BOARD_DIR/signals"
stall_minutes="$(cfg '.limits.stallMinutes' 45)"

# ---------------------------------------------------------------- GitHub ----
gh_out='[]'
repos="$(jq -r '.repos[]?.name' "$CONFIG")"
# Whose pull requests land on the board. `@me` is the authenticated user, which is
# right for a single operator and wrong for a team — a colleague's PR on a tracked
# item would simply never appear. Set operator.githubLogin to "*" for every PR in
# the repo, or to a login to watch somebody else's.
author="$(cfg '.operator.githubLogin' '@me')"
case "$author" in
  ""|"*"|all) author_filter="" ;;
  *)          author_filter="--author $author" ;;
esac

for repo in $repos; do
  [ -n "$only_repo" ] && [ "$repo" != "$only_repo" ] && continue
  owner="${repo%%/*}"; name="${repo##*/}"

  open_prs="$(gh pr list --repo "$repo" $author_filter --state open --limit 50 \
    --json number,title,headRefName,baseRefName,url,isDraft,reviewDecision,updatedAt,mergeStateStatus,statusCheckRollup \
    2>/dev/null || echo '[]')"
  merged_prs="$(gh pr list --repo "$repo" $author_filter --state merged --limit 20 \
    --json number,title,headRefName,url,mergedAt 2>/dev/null || echo '[]')"

  # Roll CI checks up to one word, and pull thread state for each open PR.
  enriched='[]'
  while IFS= read -r pr; do
    [ -z "$pr" ] && continue
    n="$(printf '%s' "$pr" | jq -r '.number')"
    # The Vercel preview URL is only ever in the bot's comment — the Vercel check's
    # targetUrl points at the dashboard inspector, not the deployed site.
    #
    # Reuse the one we already found. Fetching every comment on every PR, every
    # cycle, to re-derive a URL that is fixed for the life of the branch was the
    # single largest cost in the poll and it scales with PR count *and* comment
    # count — the busiest PRs were the slowest to check.
    preview="$(jq -r --argjson n "$n" --arg repo "$repo" \
      '[.repos[]? | select(.repo==$repo) | .open[]? | select(.number==$n) | .previewUrl // empty][0] // empty' \
      "$BOARD_DIR/signals/github.json" 2>/dev/null || true)"
    if [ -z "$preview" ]; then
      preview="$(gh pr view "$n" --repo "$repo" --json comments --jq '[.comments[].body] | join("\n")' 2>/dev/null \
        | grep -oE 'https://[a-z0-9._-]*vercel\.app[^ )"]*' | head -1 || true)"
    fi
    threads="$(gh api graphql -F owner="$owner" -F repo="$name" -F number="$n" -f query='
      query($owner:String!,$repo:String!,$number:Int!){
        repository(owner:$owner,name:$repo){
          pullRequest(number:$number){
            reviewThreads(first:100){nodes{
              isResolved isOutdated path
              comments(first:1){nodes{author{login} body createdAt}}
              lastComment: comments(last:1){nodes{author{login} createdAt}}}}
            reviews(last:20){nodes{author{login} state submittedAt}}
          }}}' 2>/dev/null || echo '{}')"
    enriched="$(jq -nc \
      --argjson pr "$pr" --argjson t "$threads" --arg repo "$repo" --argjson acc "$enriched" \
      --arg preview "$preview" --argjson ours "$(jq -c '.operator.githubLogins // []' "$CONFIG")" '
      ($t.data.repository.pullRequest // {}) as $p
      | ($p.reviewThreads.nodes // []) as $threads
      | ($p.reviews.nodes // []) as $reviews
      | ($threads | map(select(.isResolved == false))) as $unresolved
      # An unresolved thread means nothing on its own. What matters is who spoke
      # LAST: a reviewer waiting on us is an action; our own reply waiting on a
      # re-review is not. Counting both as "unresolved" made every answered
      # review look like an outstanding ask.
      | ($unresolved | map(select(
          ((.lastComment.nodes[0].author.login // "?") as $who | $ours | index($who) | not)
        ))) as $awaitingUs
      | ($unresolved | map(select(
          ((.lastComment.nodes[0].author.login // "?") as $who | $ours | index($who))
        ))) as $awaitingReviewer
      | $acc + [ $pr + {
          repo: $repo,
          previewUrl: (if $preview == "" then null else $preview end),
          ciState: (
            [($pr.statusCheckRollup // [])[] | (.conclusion // .state // "")] as $c
            | if ($c | map(select(. == "FAILURE" or . == "ERROR" or . == "TIMED_OUT" or . == "CANCELLED")) | length) > 0 then "red"
              elif ($c | map(select(. == "PENDING" or . == "IN_PROGRESS" or . == "QUEUED" or . == "" )) | length) > 0 then "running"
              elif ($c | length) == 0 then "none"
              else "green" end),
          unresolvedThreads: ($awaitingUs | length),
          threadsAwaitingReviewer: ($awaitingReviewer | length),
          unresolvedSample: ($awaitingUs | map({path, author: (.comments.nodes[0].author.login // "?"),
                             body: ((.comments.nodes[0].body // "") | .[0:200])}) | .[0:5]),
          latestActivityAt: ([ ($reviews[]?.submittedAt), ($threads[]?.comments.nodes[0].createdAt) ]
                             | map(select(. != null)) | sort | last),
          reviewStates: ($reviews | map({(.author.login // "?"): .state}) | add // {})
        } ] | map(del(.statusCheckRollup))')"
  done < <(printf '%s' "$open_prs" | jq -c '.[]?')

  gh_out="$(jq -nc --argjson acc "$gh_out" --arg repo "$repo" \
    --argjson open "$enriched" --argjson merged "$merged_prs" \
    '$acc + [{repo:$repo, open:$open, merged:$merged}]')"
done
[ -f "$BOARD_DIR/signals/github.json" ] && cp "$BOARD_DIR/signals/github.json" "$BOARD_DIR/signals/github.prev.json"
jq -nc --arg at "$(now)" --argjson repos "$gh_out" '{collectedAt:$at, repos:$repos}' \
  | atomic_write "$BOARD_DIR/signals/github.json"

# ------------------------------------------------------- Superset + agents ---
ws='[]'
if superset_authed; then
  ws="$(sup_json workspaces list --local)"
else
  warn "superset not logged in — workspace list skipped; status files still read"
fi

# Agent status files + transcript liveness per workspace.
status_json='[]'
for f in "$WORKSPACES_DIR"/*.json; do
  [ -e "$f" ] || continue
  jq -e . "$f" >/dev/null 2>&1 || { warn "unparseable status file: $f"; continue; }
  wsid="$(basename "$f" .json)"
  wt="$(printf '%s' "$ws" | jq -r --arg id "$wsid" '.[]? | select(.id==$id) | .worktreePath // empty')"
  live="unknown"; last=""
  if [ -n "$wt" ]; then
    slug="$(printf '%s' "$wt" | sed 's|[/.]|-|g')"
    dir="$HOME/.claude/projects/$slug"
    if [ -d "$dir" ]; then
      newest="$(ls -t "$dir"/*.jsonl 2>/dev/null | head -1 || true)"
      if [ -n "$newest" ]; then
        last="$(date -u -r "$newest" +%Y-%m-%dT%H:%M:%SZ)"
        if [ -n "$(find "$dir" -name '*.jsonl' -newermt "-${stall_minutes} minutes" -print -quit 2>/dev/null)" ]; then
          live="active"; else live="idle"; fi
      fi
    fi
  fi
  # Uncommitted / unpushed state, so LAND and CLOSE never guess.
  dirty="?"; ahead="?"
  if [ -n "$wt" ] && [ -d "$wt" ]; then
    dirty="$(git -C "$wt" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
    ahead="$(git -C "$wt" rev-list --count '@{u}..HEAD' 2>/dev/null || echo 'no-upstream')"
  fi
  status_json="$(jq -nc --argjson acc "$status_json" --slurpfile s "$f" \
    --arg live "$live" --arg last "$last" --arg wt "$wt" --arg dirty "$dirty" --arg ahead "$ahead" \
    '$acc + [ $s[0] + {sessionLiveness:$live, lastSessionActivityAt:$last,
                       worktreePath:$wt, dirtyFiles:$dirty, unpushedCommits:$ahead} ]')"
done

[ -f "$BOARD_DIR/signals/workspaces.json" ] && cp "$BOARD_DIR/signals/workspaces.json" "$BOARD_DIR/signals/workspaces.prev.json"
jq -nc --arg at "$(now)" --argjson ws "$ws" --argjson st "$status_json" \
  '{collectedAt:$at, workspaces:$ws, agentStatus:$st}' \
  | atomic_write "$BOARD_DIR/signals/workspaces.json"

# ------------------------------------------------------------- summary ------
echo "── PRs ──────────────────────────────────────────────────────────────"
jq -r '.repos[]? | .repo as $r
  | (.open[]? | "  \($r)#\(.number) \(.title[0:52])
      review=\(.reviewDecision // "none") ci=\(.ciState) asks=\(.unresolvedThreads)\(if (.threadsAwaitingReviewer // 0) > 0 then " awaiting-rereview=\(.threadsAwaitingReviewer)" else "" end) \(if .isDraft then "draft " else "" end)merge=\(.mergeStateStatus // "?") last=\(.latestActivityAt // "-")"),
    (.merged[]? | "  MERGED \($r)#\(.number) \(.title[0:52]) at \(.mergedAt)")' \
  "$BOARD_DIR/signals/github.json" 2>/dev/null || true

echo "── Agents ───────────────────────────────────────────────────────────"
jq -r '.agentStatus[]? |
  "  \(.slug // .workspaceId[0:8]) state=\(.state) session=\(.sessionLiveness) " +
  "dirty=\(.dirtyFiles) unpushed=\(.unpushedCommits) " +
  (if .needsOperator then "NEEDS-OPERATOR " else "" end) +
  (if (.questions // []) | length > 0 then "questions=\((.questions|length)) " else "" end) +
  (if .blockedReason then "blocked=\(.blockedReason[0:60])" else "" end)' \
  "$BOARD_DIR/signals/workspaces.json" 2>/dev/null || true

echo "── Workspaces without a status file ─────────────────────────────────"
# Only the projects this orchestrator is configured for. A busy host carries
# dozens of unrelated workspaces, and listing them all buries the two that matter.
configured_projects="$(jq -c '[.repos[]?.supersetProjectId // empty]' "$CONFIG")"
jq -r --slurpfile st <(jq '[.agentStatus[]?.workspaceId]' "$BOARD_DIR/signals/workspaces.json") \
  --argjson projects "$configured_projects" \
  '.workspaces[]?
   | select(($projects | length) == 0 or ((.projectId // "") as $p | ($projects | index($p)) != null))
   | select(.id as $i | ($st[0] | index($i)) == null)
   | "  \(.name) [\(.branch)] \(.id)"' \
  "$BOARD_DIR/signals/workspaces.json" 2>/dev/null || true

echo "── Deltas since last poll ───────────────────────────────────────────"
if [ -f "$BOARD_DIR/signals/github.prev.json" ]; then
  jq -n --slurpfile new "$BOARD_DIR/signals/github.json" --slurpfile old "$BOARD_DIR/signals/github.prev.json" -r '
    ($old[0].repos // []) as $o
    | ($new[0].repos // [])[] | .repo as $r | .open[]?
    | . as $pr
    | ([$o[] | select(.repo==$r) | .open[]? | select(.number==$pr.number)] | first) as $was
    | select($was == null
             or $was.latestActivityAt != $pr.latestActivityAt
             or $was.reviewDecision  != $pr.reviewDecision
             or $was.ciState         != $pr.ciState)
    | (def ready: (.reviewDecision == "APPROVED") and (.ciState == "green")
                  and ((.mergeStateStatus // "") | IN("CLEAN","HAS_HOOKS"))
                  and ((.unresolvedThreads // 0) == 0) and ((.isDraft // false) | not);
       if ($pr | ready) and (($was | ready) | not)
       then "  ★ READY TO MERGE  \($r)#\($pr.number) \($pr.title[0:56]) — approved, green, no conflicts"
       else "  \($r)#\($pr.number): review \($was.reviewDecision // "-")→\($pr.reviewDecision // "-") " +
            "ci \($was.ciState // "-")→\($pr.ciState) threads \($was.unresolvedThreads // "-")→\($pr.unresolvedThreads)"
       end)' \
    2>/dev/null || true
else
  echo "  (first poll — no baseline)"
fi
