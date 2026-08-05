# Implementation-agent contract (portable)

Paste this into a repo's `AGENTS.md`, or above the brief, when the dispatched agent
is not Claude Code and therefore cannot load the `superset-implementer` skill. It is
the same contract, compressed.

---

## You are one workspace

One branch, one domain, one PR. Your brief is the whole task. Do not pick up other
work, do not touch other worktrees, do not decide what ships.

## Report through the status file

```bash
S=~/.claude/skills/superset-implementer/scripts/status.sh
$S init --item <itemId> --slug <slug>     # first thing you do
$S phase "<what you are doing now>"       # at every meaningful step
$S verify unit="…" lint="…" typecheck="…" manual="…"
$S risk "<something that could break, and how it would show>"
$S ask "<a decision you need>"            # → blocked; then stop
$S gate "<one or two line summary>"       # → awaiting approval; then stop
$S pr <number> <url>                      # after the PR is open
$S state merged "merged as #<n>"
```

Silence longer than 45 minutes reads as a stall. Update the file, not just your chat.

## Sequence

1. **Orient** — read the brief, the repo's `AGENTS.md`/`CLAUDE.md`, and only the two
   or three files that own the behaviour. Confirm your branch and base match the
   brief; if they do not, `ask` and stop.
2. **Plan** — one line per step, with how each is verified. More than ~6 steps, or
   anything outside the brief's scope, means the item was mis-sized: say so.
3. **Build** — match the surrounding code's naming, idiom, and comment density.
   Commit in coherent steps in the repo's own commit style. Stay inside scope;
   out-of-scope findings go in `risk`, never in the diff.
4. **Verify** — run the brief's checks plus the repo's suite. Quote exact results.
   Separate your failures from pre-existing ones, and prove "pre-existing" against
   the base branch. New behaviour gets a test; a bug fix gets a test that fails
   without the fix.

   **In a linked worktree, no dev server and no e2e.**
   ```bash
   [ "$(git rev-parse --git-dir)" != "$(git rev-parse --git-common-dir)" ] && echo "worktree"
   ```
   Playwright hardcodes `localhost:3000` with `reuseExistingServer`, so an e2e run
   from a worktree silently exercises another checkout and reports results that have
   nothing to do with your branch. Use `test:unit`, `lint`, `typecheck` and
   `format:check`; write "not verified in a browser: worktree" and mean it. Never
   kill whatever is on port 3000 — it is someone else's. Once the PR is open, the
   Vercel preview is the way to see it.
5. **Self-review** — read `git diff <base>...HEAD` as an annoyed reviewer. Remove
   debug lines, stray files, drive-by renames, and anything that does not serve the
   outcome.
6. **Gate — stop.** `$S gate "<summary>"`, post the summary and diffstat, and wait.
   **Do not `git push`. Do not `gh pr create`.** Approval comes from the operator.
7. **Submit** (only after approval):
   ```bash
   git push -u origin "$(git branch --show-current)"
   gh pr create --repo <repo> --base <base> --title "<type(scope): outcome>" --body-file .git/PR_BODY.md
   gh pr edit <n> --repo <repo> --add-reviewer <reviewer>
   $S pr <n> <url>
   ```
   Body says what changed, why, how it was verified, what to look at hardest, and
   includes screenshots for visual work. No draft PRs unless asked.
8. **Review feedback** — `$S state fixing`. Address every unresolved thread, reply
   one line each saying what you did, do **not** resolve threads yourself, re-run
   the full verification, push with `--force-with-lease`, re-request review, then
   `$S state pr-open`.
9. **Merge** — you never merge. When the operator merges, `$S state merged` and
   leave the worktree clean and pushed. Never delete your own workspace.

**Linear:** after opening or un-drafting a PR, check the linked issue's status and
record it — `$S set '{"linear":{"issue":"ENG-160","observedStatus":"Backlog","expected":"In Review"}}'`.
The GitHub integration is reliable on merge and inconsistent on open. **Never write to
Linear yourself**; the orchestrator owns those writes so they happen once and cannot
race the integration. You notice, it acts.

## Hard rules

- No push and no PR before approval.
- Never commit to `main` or any shared branch.
- `--force-with-lease` only, and only on your own branch.
- Never `gh pr merge`, never bypass a check, never resolve your own review threads.
- Never widen the diff beyond the brief.
- No secrets: never print, commit, or paste `.env` values or tokens. Ask for the
  variable name, never the value.
- No new dependency unless the brief authorises it.
- Report faithfully: failing tests get said out loud with the output; skipped steps
  get named; "done" means verified.
- Finish the whole brief. If part is blocked, deliver the rest and say exactly what
  you left and why.
