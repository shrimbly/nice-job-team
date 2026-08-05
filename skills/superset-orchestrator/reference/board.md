# The board — state machine and file schemas

## Directory

```
~/.claude/superset-orchestrator/
├── config.json                 # operator-owned settings
├── board.json                  # canonical queue (you own this)
├── board.md                    # rendered view (regenerate on every change)
├── briefs/<slug>.md            # dispatch briefs and feedback briefs
├── signals/
│   ├── github.json             # latest poll.sh output
│   ├── github.prev.json        # previous, for delta detection
│   ├── workspaces.json         # live workspaces + status files + liveness
│   ├── linear.json             # latest Linear scout output
│   └── slack.json              # latest Slack scout output
├── workspaces/<workspaceId>.json   # written by implementation agents
└── log.jsonl                   # append-only event log
```

Write `board.json` atomically (`tmp` + `mv`) — an automation run and an interactive
session can both be holding it.

## Item state machine

```
   proposed ──▶ dispatched ──▶ building ──▶ awaiting-approval ──▶ pr-open ──▶ merged ──▶ closed
       │             │            │  ▲              │                │ ▲
       │             │            ▼  │              ▼                ▼ │
       └─▶ rejected  └─▶ orphaned  blocked ◀────────┘            fixing ┘
```

| State | Owner | Means | Leaves when |
|---|---|---|---|
| `proposed` | you | grouped, ranked, not yet approved | operator approves → `dispatched`, declines → `rejected` |
| `dispatched` | you | workspace created, agent started, no status file yet | agent writes a status file → `building` |
| `building` | agent | implementing and self-reviewing | agent finishes → `awaiting-approval`; needs a decision → `blocked` |
| `awaiting-approval` | **operator** | work is complete and self-reviewed; PR not yet opened | operator says submit → agent opens PR → `pr-open` |
| `pr-open` | reviewer | PR open, reviewer assigned | changes requested / CI red → `fixing`; merged → `merged` |
| `fixing` | agent | addressing review feedback or a red build | pushed and re-requested review → `pr-open` |
| `blocked` | operator | agent cannot proceed without an answer | answer relayed → back to previous state |
| `merged` | you | PR merged | workspace reaped → `closed` |
| `orphaned` | you | workspace vanished while item open | recreated → `dispatched`, or → `rejected` |
| `rejected` / `closed` | — | terminal | — |

Only two transitions are yours to make unilaterally: `proposed → rejected` (when a
scout shows the item is already done or duplicated) and `merged → closed` after
`reap.sh` verifies the workspace is clean. Everything else follows an agent's status
file, a poll result, or an operator decision.

## `board.json`

```json
{
  "version": 1,
  "updatedAt": "2026-07-30T09:20:00Z",
  "items": [
    {
      "id": "itm_007",
      "slug": "eng-142-log-table",
      "title": "Denser, more informative audit log table",
      "domain": "run-history",
      "state": "pr-open",
      "priority": "high",
      "source": { "kind": "linear", "externalId": "ENG-142", "url": "https://linear.app/acme/issue/ENG-142/…" },
      "outcome": "The run history table fits ~40% more rows and each row states its own timing without a hover.",
      "repo": "acme/website",
      "branch": "dev/eng-142-run-history-denser-more-informative-log-table",
      "baseBranch": "main",
      "blockedBy": null,
      "stackParent": null,
      "workspaceId": "3f1c…",
      "supersetTaskId": null,
      "briefPath": "~/.claude/superset-orchestrator/briefs/eng-142-log-table.md",
      "pr": {
        "number": 441,
        "url": "https://github.com/acme/website/pull/441",
        "reviewers": ["octocat"],
        "reviewDecision": "CHANGES_REQUESTED",
        "unresolvedThreads": 3,
        "ciState": "success",
        "lastSeenActivityAt": "2026-07-30T08:55:12Z"
      },
      "history": [
        { "at": "2026-07-29T22:10:00Z", "from": "proposed", "to": "dispatched", "by": "operator-approval" }
      ]
    }
  ]
}
```

Rules:

- `domain` is the single-surface label that justifies the item existing on its own.
  Two items with the same `domain` and no dependency between them are a grouping
  mistake — merge them or explain why not.
- `outcome` is one sentence, verifiable, written before dispatch. If you cannot
  write it, the item is not ready to dispatch.
- `blockedBy` is for hard dependencies of any kind. `stackParent` is specifically
  "branch off this item's branch" and implies `blockedBy`.
- Never delete items. Terminal states stay for the log.

## `workspaces/<workspaceId>.json` — written by the agent

The implementation agent owns this file end to end; you only read it.

```json
{
  "version": 1,
  "workspaceId": "3f1c…",
  "itemId": "itm_007",
  "slug": "eng-142-log-table",
  "branch": "dev/eng-142-…",
  "state": "awaiting-approval",
  "updatedAt": "2026-07-30T08:41:03Z",
  "phase": "self-review complete",
  "summary": "Two-line plain-English summary of what changed and why.",
  "verification": {
    "unit": "pass — 214 tests, 0 failures",
    "lint": "pass",
    "typecheck": "pre-existing 19 errors, none new",
    "manual": "checked at /account/runs?view=list&mock=1 in Chrome; screenshots in ./.scratch/"
  },
  "diffstat": { "files": 6, "insertions": 284, "deletions": 96 },
  "risks": ["Sticky header offsets are measured against the scrollport content box — verify on Safari."],
  "questions": [],
  "blockedReason": null,
  "pr": { "number": null, "url": null },
  "needsOperator": true,
  "lastAgentSessionId": "…"
}
```

`needsOperator: true` is the flag that should make you notify. `questions` is how a
`blocked` agent asks — relay them verbatim; do not answer on the operator's behalf
unless `config.json` already contains the answer.

## `log.jsonl`

One JSON object per line, append only. Minimum fields: `at`, `event`, `itemId`,
plus whatever is relevant. Events worth logging: `sensed`, `grouped`, `proposed`,
`approved`, `declined`, `dispatched`, `re-prompted`, `gated`, `pr-opened`,
`feedback-received`, `merged`, `reaped`, `error`.

This is what lets you answer "what happened yesterday" in one `tail`, and what a
scheduled automation reads to avoid repeating a cycle it already ran.

## `board.md`

Regenerate whenever `board.json` changes. Keep it to one table the operator can
read in five seconds — state, item, PR, and who is holding it:

```markdown
# Board — 2026-07-30 09:20

| State | Item | Domain | PR | Waiting on |
|---|---|---|---|---|
| pr-open | ENG-142 denser log table | run-history | #441 (changes requested, 3 threads) | agent (fixing) |
| awaiting-approval | ENG-153 first-run prompt | account | — | **you** |
| building | ENG-155 advanced section toggle | settings-ui | — | agent (34m) |
| proposed | ENG-118 preset visibility toggle | settings-ui | — | **you** (approval) |
| blocked | ENG-104 placeholder images | assets | — | **you** (which asset set?) |
```
