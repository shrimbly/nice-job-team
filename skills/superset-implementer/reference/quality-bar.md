# The quality bar

"Very high standard" is not a feeling. It is this list, and you check it before the
gate, not after.

## Correctness

- [ ] The brief's outcome sentence is literally true, and you can demonstrate it.
- [ ] Every edge the change introduces is handled: empty, one, many; loading, error,
      success; first render and re-render; the fast path and the slow one.
- [ ] Nothing regressed in the same file or component. You checked the callers, not
      just the definition (`grep` the symbol you changed).
- [ ] Async work cannot land out of order or after teardown (guards, tickets,
      cleanup on unmount/dispose).
- [ ] Error paths say something a user can act on, and do not swallow the cause.

## Shape of the diff

- [ ] Every hunk serves the outcome. Nothing incidental rode along.
- [ ] No debug output, commented-out code, `TODO` you invented, or stray files.
- [ ] No renames, reformats, or import reshuffles mixed into a behaviour change.
- [ ] Deleted code is actually deleted, not commented out.
- [ ] The diff reads like the code around it: same naming, same idiom, same comment
      density. A reviewer should not be able to tell which hunks are new by style.
- [ ] Under ~400 lines, or uniform and mechanical if larger.

## Tests

- [ ] New behaviour has a test. A bug fix has a test that fails without the fix —
      confirm it fails, do not assume.
- [ ] Tests assert the behaviour, not the implementation (row counts, rendered text,
      emitted events — not internal class names or private call order).
- [ ] Test names read as sentences about the behaviour.
- [ ] No test was weakened, skipped, or deleted to get to green.
- [ ] The full suite passes, not only the files you touched.

## Verification you can quote

- [ ] Unit/integration suite: exact counts, recorded in the status file.
- [ ] Lint: clean, or every remaining warning proven pre-existing on the base branch.
- [ ] Types: clean, or the baseline diffed against the base branch and quoted.
- [ ] Anything visual: opened in a real browser, at a real size, and described with
      numbers or a screenshot path. Include the URL you used. **In a linked worktree
      you cannot do this** — no dev server, no e2e (they reuse whatever is on port
      3000, which is another checkout). Write "not verified in a browser: worktree"
      and leave it at that. Once the PR is open, the Vercel preview is the way.
- [ ] Anything with timing (polling, animation, debounce): watched for long enough to
      see the second and third beat, not just the first.

## Fit with the codebase

- [ ] Repo `CLAUDE.md` / `AGENTS.md` honoured, including nested ones.
- [ ] Existing components, tokens, and utilities reused rather than re-invented.
      Check before writing a helper — the repo probably has one.
- [ ] Design tokens, not literals, where the repo uses tokens.
- [ ] i18n: every user-visible string goes through the repo's i18n layer, and every
      locale file stays key-for-key identical (this repo has eight).
- [ ] No new dependency unless the brief authorised it.
- [ ] Accessibility for anything interactive: reachable by keyboard, labelled,
      focus visible, `aria-*` where the pattern needs it.

## Communication

- [ ] Status file current, with summary, diffstat, verification, and risks.
- [ ] Risks are specific: what could break, where, and how someone would notice.
- [ ] Commit messages in the repo's own style, each one a coherent step.
- [ ] PR body: what changed, why, how verified, what to look at hardest, screenshots
      for visual work.
- [ ] Anything you chose not to do is named, with the reason.

## Automatic fails

Any one of these means it is not ready, no matter how good the rest is:

- Tests edited to pass.
- "Should work" with no run behind it.
- An e2e or browser result claimed from inside a worktree. It tested another
  checkout; reporting it as yours is reporting a result you did not get.
- A claim of "pre-existing failure" that was never checked against the base branch.
- Scope creep the brief did not authorise.
- Secrets, tokens, or `.env` values anywhere in the diff or the PR body.
- A pushed branch or an opened PR before the operator approved it.
- A summary that reads better than the work: hedged verification, vague outcomes,
  or "mostly done".
