# Signals — what to poll, how, and what comes back

Five sources. Two are free (shell), three cost tokens (scouts). Never let a scout
return prose; every scout returns one JSON object and nothing else.

Concrete defaults below reflect the operator's actual setup as of 2026-07-30:
Linear workspace `acme`, team **Engineering** (issue prefix `ENG-`), GitHub
org `acme`, Superset project id for the website repo
`00000000-0000-0000-0000-000000000000`. All of it is overridable in `config.json`
— read that first, and treat these as the fallback.

---

## 1. GitHub — free, every cycle

`scripts/poll.sh` runs these for each repo in `config.json`:

```bash
gh pr list --repo <repo> --author @me --state open \
  --json number,title,headRefName,baseRefName,url,isDraft,reviewDecision,updatedAt,mergeable,mergeStateStatus,statusCheckRollup

gh pr list --repo <repo> --author @me --state merged --limit 20 \
  --json number,headRefName,mergedAt,url
```

and, for each open PR the board is tracking, unresolved review threads via GraphQL
(the REST/`gh pr view` shapes do not expose resolution state):

```bash
gh api graphql -F owner=<owner> -F repo=<name> -F number=<n> -f query='
query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewDecision
      reviewThreads(first:100){nodes{
        isResolved isOutdated path
        comments(first:1){nodes{author{login} body createdAt}}
      }}
      reviews(last:20){nodes{author{login} state submittedAt}}
    }
  }
}'
```

Derived fields the orchestrator acts on:

- `latestActivityAt` = max of review `submittedAt` and thread comment `createdAt`.
  Compare against `board.json`'s `pr.lastSeenActivityAt` to detect *new* feedback.
- `unresolvedThreads` = count of `reviewThreads.nodes[] | select(.isResolved == false)`.
- `ciState` from `statusCheckRollup` — treat any `FAILURE`/`ERROR` as red, any
  `PENDING`/`IN_PROGRESS` as running.
- `reviewDecision` ∈ `APPROVED` / `CHANGES_REQUESTED` / `REVIEW_REQUIRED` / `null`.

`mergeStateStatus: DIRTY` means the branch has conflicts — that is a re-prompt for
the agent (rebase), not something you fix.

---

## 2. Agent status files — free, every cycle

Each implementation agent maintains `~/.claude/superset-orchestrator/workspaces/<workspaceId>.json`
(schema in `board.md`). `poll.sh` collects them all. This is the authoritative
answer to "what is that agent doing" — it is written by the agent itself at every
phase transition.

If a workspace has no status file 10 minutes after dispatch, the agent probably
never loaded the `superset-implementer` skill. Re-prompt it with an explicit
instruction to load the skill and write its status file.

---

## 3. Session liveness — free, every cycle

Claude Code writes a transcript per session under `~/.claude/projects/<slug>/`,
where `<slug>` is the worktree path with every `/` and `.` replaced by `-`. For
`~/.superset/worktrees/<projectId>/<name>` that is:

```
~/.claude/projects/-Users-you--superset-worktrees-<projectId>-<name>/*.jsonl
```

The mtime of the newest `.jsonl` in that directory is the last time the agent did
anything. That gives stall detection with zero tokens and no API:

```bash
find "$dir" -name '*.jsonl' -newermt '-45 minutes' | head -1   # empty ⇒ idle 45min+
```

Never read a transcript yourself — they run to megabytes. When you need to know
*why* an agent is idle, send a scout with an explicit `tail` budget (below).

---

## 4. Linear — scout, every cycle

Via the Linear MCP tools (`mcp__plugin_linear_linear__*`). The queries that matter:

```
list_issues  assignee="me"  state="unstarted"   fields=[id,title,status,team,priority,gitBranchName,url,updatedAt,labels,project]
list_issues  assignee="me"  state="started"     (same fields — these may already have workspaces)
list_issues  assignee="me"  updatedAt="-P1D"    (anything that moved in the last day)
get_issue    <id>                                (only when grouping needs the description)
list_comments <issueId>                          (only when a decision is pending)
```

Three rules:

1. **`gitBranchName` is the branch to use.** Linear generates it (e.g.
   `dev/eng-142-run-history-denser-more-informative-log-table`) and matches
   PRs back to the issue by it. Never invent your own branch name for a Linear item.
2. **Never write to Linear without approval**, except the two updates
   `config.json` explicitly allows (attaching a PR link, moving to In Review).
3. Read the description once, at GROUP time, and put what matters into the brief.
   The implementation agent should not need Linear access to do its job.

---

## 5. Slack — scout, every third cycle

Via the Slack MCP tools (`mcp__plugin_slack_slack__*`). Cheap version first:

```
slack_search_public_and_private  query="<operator handle> after:<yesterday>"
slack_read_channel               channel=<each channel in config.slack.channels>  limit=30
slack_read_thread                only for messages the scout flags as actionable
```

What counts as a signal: a direct ask to the operator, a bug report with a repro, a
review nudge on one of our PRs, a decision that unblocks a `blocked` item. What
does not: general discussion, anything already tracked in Linear, anything older
than the config's `slack.lookbackHours`.

Never post to Slack unless the operator asked for it in this session. Reading is
safe; writing is publishing.

---

## Scout contract

Spawn with `subagent_type: "superset-scout"`, one per source, all in one message.
Give each scout: the source, the exact queries, the lookback window, the current
board items (id + one-line title only — never the whole board), and this reminder:
*return JSON only*.

```json
{
  "source": "linear|slack|github|workspace",
  "collectedAt": "2026-07-30T09:14:00Z",
  "candidates": [
    {
      "externalId": "ENG-118",
      "title": "Preset visibility — toggle specific presets within a workspace",
      "url": "https://linear.app/acme/issue/ENG-118/…",
      "branchName": "dev/eng-118-preset-visibility-toggle-onoff-specific-presets-within-a",
      "priority": "urgent",
      "domain": "settings-ui",
      "oneLineOutcome": "A per-workspace preset allow-list toggle that persists and is reflected in the picker.",
      "estimate": "M",
      "blockers": ["needs the visibility API shape confirmed"],
      "matchesBoardItem": null,
      "evidence": "Linear ENG-118, updated 2026-07-17; no PR references the branch."
    }
  ],
  "updates": [
    { "boardItemId": "itm_004", "observation": "reviewer asked for a rebase", "sourceUrl": "…" }
  ],
  "notes": "One sentence, only if something is off (auth failure, empty result that looks wrong)."
}
```

For a stalled-workspace scout, the shape is:

```json
{
  "source": "workspace",
  "workspaceId": "…",
  "verdict": "working|waiting-on-human|stuck|crashed|done-but-silent",
  "lastAction": "one line, what the transcript's tail shows it doing",
  "asks": ["the exact question it is waiting on, if any"],
  "recommendation": "re-prompt|surface-to-operator|leave-alone",
  "evidence": "last assistant turn at 09:02, tail -c 4000 of <file>"
}
```

Scout budget: give it a hard read budget in the prompt — *"read at most the last
4000 bytes of the newest transcript; do not open repository source files unless one
specific file answers the question."* A scout that reads a whole repo defeats the
purpose of having one.
