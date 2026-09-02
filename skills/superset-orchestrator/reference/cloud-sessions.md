# Dispatching to Claude Code on the web

`board dispatch --host cloud` sends a brief to a Claude Code session on claude.ai
instead of creating a Superset workspace on this machine. The item, the brief, the
board and the review are all the same. What changes is where the agent runs.

## Why bother

`limits.maxActiveWorkspaces` exists because a workspace is a full checkout plus an
agent session, and memory runs out before patience does. A cloud session costs this
machine nothing, so that ceiling stops applying. What remains is review capacity
and the account's rate limit, which is the honest limit on this workflow anyway.

There is no separate compute charge for the cloud VM. Sessions draw on the same
subscription usage as any other Claude Code work.

## What you give up

**The status file.** A cloud agent runs on hosted infrastructure and cannot write
to `~/.claude/superset-orchestrator/workspaces/`. Nothing is listening, so nothing
tries. A cloud item has no `agentState`, no `phase`, no `summary`, and no liveness
— for these, **GitHub is the status channel**, and `board poll` already collects
everything the board needs from it.

**The approval gate.** The gate works locally because the agent parks at
`awaiting-approval` and waits. A cloud session has nobody attached, so a question
asked there waits until somebody opens a browser. The gate becomes **a draft PR**:
the agent works to completion, records its judgement calls in the PR body, and
opens the PR as a draft. That is visible to `board poll` and already renders as
`DRAFT` on the board.

**Steering mid-run.** You can still send a follow-up, but it is a queued message
rather than a conversation:

```bash
board cloud send session_01ABC… --message "Use the existing helper in utils/date.ts"
```

## One-time setup

Cloud dispatch goes through a **routine**, because that is the only programmatic
way to start a session. `claude --cloud "task"` exists but cannot be scripted —
verified against Claude Code 2.1.234:

```
$ claude --cloud "task"          # stdout captured by a script
Error: --cloud requires an interactive terminal.
Non-interactive invocations (piped stdout, --init-only, --sdk-url) run locally
and would silently ignore --cloud. Drop --cloud, or run from a TTY.
```

Capturing stdout is what every script does, so there is no scripted form of it.
Adding `--print` is refused separately, for the same reason.

1. Go to [claude.ai/code/routines](https://claude.ai/code/routines) and click
   **New routine**.

2. Name it something like `Superset dispatch`, and give it this prompt. **The
   wording matters**: fire text arrives inside a `<routine-fire-payload>` block
   labelled untrusted, so the saved prompt has to opt into acting on it. Without
   that sentence the session treats the brief as inert context and does nothing.

   ```
   You are an implementation agent. The routine-fire-payload block contains your
   brief: read it and carry it out. Load the superset-implementer skill first and
   follow it, including the cloud-session rules — work autonomously to completion,
   do not wait for approval, and finish by opening a draft pull request.
   ```

3. Select the repository. Add no schedule trigger.

4. Save, reopen for editing, **Add another trigger → API**, then **Generate
   token**. Copy both the URL and the token now — the token is shown once and
   cannot be retrieved later.

5. Point the orchestrator at it. One command rather than hand-editing JSON,
   because a typo in `config.json` takes the board down with it:

   ```bash
   board cloud enable 'https://api.anthropic.com/v1/claude_code/routines/trig_…/fire'
   ```

   It backs the config up first, refuses a URL that is not a routine fire
   endpoint, and refuses to write invalid JSON.

6. Put the token in your shell. It is deliberately not a flag on `--enable`:
   a flag lands in shell history, and `config.json` is read by agents and quoted
   into briefs, so it must not go there either.

   ```bash
   export SUPERSET_CLOUD_TOKEN='sk-ant-oat01-…'
   ```

   Add it to your shell profile so a new terminal still has it.

7. Check it:

   ```bash
   board cloud check
   ```

## Using it

```bash
board dispatch --item itm_007 --host cloud
board dispatch --item itm_007 --host cloud --dry-run   # print, change nothing
```

(An earlier `dispatch-cloud.sh` forwarder used to run `claude --cloud` inside a
command substitution, which cannot work: the CLI refuses any invocation whose
stdout is piped, which is every invocation a script makes.)

Set `cloud.defaultHost` to `cloud` to make it the default and pass `--host local`
for the exceptions.

The brief travels inline in the fire request. The alternative was committing it to
the default branch so the session could read it from the clone, which is a change
to the repository for every piece of work proposed — including the ones that get
abandoned. The endpoint caps the text at 65,536 characters; `board cloud fire` checks
before sending, because a truncated brief is worse than a refused one.

## Constraints worth knowing before you rely on it

**A failed dispatch is never retried.** `/fire` has no idempotency key: every
successful call creates a session. A retry after an ambiguous failure gives one
item two agents on the same branch. `board cloud fire` reports and stops; the item is left
untouched so it can be dispatched again once the cause is fixed.

**Requires a claude.ai login.** Not available on Amazon Bedrock, Google Vertex, or
API-key auth. The organization's `allow_remote_sessions` policy must be on.

**Branch names are not yours.** Routines push to `claude/`-prefixed branches.
`board dispatch` records the branch it intended, and `board reconcile` corrects it from the PR
once one exists — the PR is the only source that actually knows.

**Repositories are fixed per routine**, and cloned from the default branch. One
routine per repository you want to dispatch to.

**Routines belong to an individual account**, not the team, and anything the
session does through your GitHub identity appears as you.

**IP allowlisting breaks it.** Cloud sessions call the API from Anthropic's
infrastructure, not your network. If your organization allowlists IPs, every
session fails to authenticate.

**There is a daily routine run cap** on top of subscription usage, and a `429`
carries a `Retry-After`.

## What the board shows

A cloud item looks like any other card. The differences:

- The first chip is a **cloud** glyph rather than a window, and opens
  `claude.ai/code/<session>` in a browser instead of the Superset app.
- With no PR yet it reads **"Running on claude.ai. Nothing pushed yet."** rather
  than "No PR data in the last poll", which for these would describe a fault that
  is not there.
- Once a PR exists it is an ordinary card: review state, CI, threads, merge state.

`board dump` shows the same, so a cloud board diffs against the dashboard the
same way a local one does.
