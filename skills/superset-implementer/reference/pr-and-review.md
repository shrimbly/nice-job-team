# Submitting, and surviving review

Everything here happens **after** the operator approved submission. Before that,
none of it runs.

## 1. Push

```bash
branch="$(git branch --show-current)"
git status --porcelain           # must be empty
git push -u origin "$branch"
```

Never push a branch that is not yours. Never `--force`; `--force-with-lease` only,
and only on your own branch after a rebase.

## 2. Body first, then the PR

Write the body to a file — quoting a multi-paragraph body on the command line will
mangle it.

```bash
cat > .git/PR_BODY.md <<'EOF'
## What

One paragraph: the outcome, in the words a reviewer would use.

## Why

The reason, and the constraint that shaped the approach. Link the issue.

## How it was verified

- `npm run test:unit` — 214 passed, 0 failed; new case `renders 26 rows at 900px`
- `npm run lint` — clean
- `npx nuxi typecheck` — 19 errors, identical to `main` (baseline checked)
- Manually at `/account/runs?view=list&mock=1`: 18 → 26 rows at 900px

## Look at this hardest

The sticky header's offset is resolved against the scrollport's content box, so the
padding math in `RunsTable.vue` is load-bearing.

## Screenshots

| Before | After |
| --- | --- |
| ![before](url) | ![after](url) |
EOF
```

`.git/` is never committed, so a body file there cannot leak into the diff.

```bash
gh pr create --repo <owner/name> --base <base> \
  --title "polish(runs): denser rows with per-row timing" \
  --body-file .git/PR_BODY.md
```

Title in the repo's own convention — read `git log --oneline -20` and match it.
Never open a draft unless the brief asks: reviewers skip drafts.

### How the body must read

**Load the `simple-english` skill before you write the body, and follow it.** The
orchestrator installs it — see `board init`.

The reviewer is the scarcest thing in this workflow. Their capacity, not the number
of agents, is what caps throughput. A body that takes three minutes to read costs
more than the change it describes. Agents also write the same padding every time:
"This PR aims to comprehensively improve...", "It's worth noting that...", "This
change leverages...". None of it carries a fact.

The rules that matter here:

- Write direct, brief, succinct prose. One fact per sentence.
- Instructions stay under 20 words. Explanations stay under 25.
- Active voice, simple tenses. Not "has been refactored" — "I moved it".
- `must` and `can` only. Never `should`, `may`, `might`, `could`.
- Delete `simply`, `just`, `robust`, `comprehensive`, `seamlessly`, `leverage`,
  `in order to`, `it is worth noting that`.
- Never `e.g.`, `i.e.`, `etc.` Write `for example`, `that is`, or name the items.
- No semicolons. Write two sentences.
- Code, identifiers, commands, paths and quoted errors are untouchable. Leave them
  exact, whatever the word rules say.

State the measurable result, never the adjective for it.

| Do not write | Write |
|---|---|
| This PR comprehensively refactors the runs table to be more performant. | The runs table renders 26 rows at 900px, up from 18. |
| It's worth noting that the sticky header logic may need attention. | The sticky header offset is load-bearing. Read the padding math in `RunsTable.vue`. |
| Tests have been run and are passing. | `npm run test:unit` — 214 passed, 0 failed. |

The headings stay as they are. This governs the prose under them.

## 3. Reviewer

```bash
gh pr edit <n> --repo <owner/name> --add-reviewer <login>
```

The reviewer comes from the brief (or `config.json`'s `repos[].reviewers`). If the
brief names none, say so in your gate summary and ask — an unassigned PR waits a day
for nothing. Team handles use `--add-reviewer org/team-slug`.

Then record it:

```bash
board status pr <n> <url>
```

## 4. Reading feedback properly

`gh pr view` shows top-level comments but not thread resolution. Get the real state:

```bash
gh pr view <n> --repo <owner/name> --json reviewDecision,mergeStateStatus,statusCheckRollup --comments

gh api graphql -F owner=<owner> -F repo=<name> -F number=<n> -f query='
query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewDecision
      reviewThreads(first:100){nodes{
        id isResolved isOutdated path line
        comments(first:20){nodes{id author{login} body createdAt url}}}}
    }}}'
```

Work only the threads with `isResolved: false`. An `isOutdated` thread on code you
already changed still needs a reply saying so.

## 5. Replying

One reply per thread, one line, what you did:

```bash
# Reply inside a review thread (keeps it threaded, not a new top-level comment):
gh api -X POST "repos/<owner>/<name>/pulls/<n>/comments/<commentId>/replies" \
  -f body="Moved it to a computed — recalculates once per data change now."
```

- Do not resolve threads. The reviewer resolves; resolving your own reads as
  dismissing the comment.
- Disagree at most once per thread, with the reason. Then comply, unless it is a
  correctness or safety problem — those escalate through `board status ask`.
- Never argue about style the repo has already settled.

## 6. Red CI

```bash
gh pr checks <n> --repo <owner/name>
gh run view <run-id> --log-failed          # the failing job's log only
```

Fix the cause, not the symptom. A flaky test gets named as flaky with evidence (a
re-run that passes plus the failure mode), never quietly re-run until green.

## 7. Conflicts and rebases

`mergeStateStatus: DIRTY` means conflicts:

```bash
git fetch origin
git rebase origin/<base>
# resolve, run the full suite again — a rebase can break things silently
git push --force-with-lease
```

If your PR is a stack child and its parent merged, retarget the base too:

```bash
gh pr edit <n> --repo <owner/name> --base main
```

## 8. Re-request review

```bash
gh pr edit <n> --repo <owner/name> --add-reviewer <login>
```

(`--add-reviewer` on an existing reviewer re-requests.) Then
`board status state pr-open` and stop. Do not nudge in Slack unless the operator asks.

## 9. Merge

You never merge. Not `gh pr merge`, not the web UI, not "it's approved and green so
I'll just land it". The operator merges. When you see it merged:

```bash
board status state merged "merged as #<n>"
```

Leave the tree clean and pushed, and leave the workspace alone — the orchestrator
reaps it.
