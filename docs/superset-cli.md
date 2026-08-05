# The Superset CLI

Verified against Superset CLI v1.17.0. `skills/superset-orchestrator/reference/cli.md`
holds the full surface.

A Superset workspace is a git worktree with an agent session attached. The CLI creates
them, lists them, and deletes them.

## The commands the workflow uses

```bash
superset auth login                       # browser flow, the operator runs this
superset auth whoami                      # confirm the CLI session
superset status                           # the host daemon

superset projects list --json             # find a project ID
superset projects create --repo-path DIR  # register a repository

superset workspaces create --agent claude --branch BRANCH --prompt "…" --json
superset workspaces list --local --json
superset workspaces get ID --json
superset workspaces delete ID --local --json
superset workspaces open ID

superset agents create --workspace ID --agent claude --prompt "…" --json
superset agents list --local --json

superset terminals create --workspace ID --command "…"
```

Add `--local` to any command that needs a host. Without it the CLI answers
`Target host required`.

## The sharp edges

Each of these cost real time. They are listed in the order they hurt.

### `agents create` does not continue a chat

It starts a **new** session in the same worktree. The new session has the brief and the
git state, and none of the reasoning from the first run.

There is no send-message command. `superset agents` has `create` and `list` only.
`superset terminals` has `create` only. Neither can write to a running terminal.

To continue a conversation, resume the Claude Code session by its identifier. See
`orchestrator.md`.

### The chat pane is a terminal buffer

The desktop application shows the scrollback of a terminal that Superset owns. It does not
read Claude Code transcripts.

A `claude --resume` command that you run yourself writes to the transcript on disk. It
writes nothing into the Superset terminal, so the application shows nothing. The work is
real and the record of it is invisible.

To get both, start the resumed session through `superset terminals create`. The
application then owns a terminal that it can show, and the session inside it holds the
earlier context.

### Two identifier spaces for one conversation

The Superset terminal session ID and the Claude Code transcript ID are different values
for the same chat. The ID that `workspaces create` returns will never match a transcript
filename.

Find the transcript by path instead:

```bash
dir="$HOME/.claude/projects/$(printf '%s' "$WORKTREE_PATH" | sed 's/[/.]/-/g')"
```

### The return shapes are inconsistent

`workspaces create` returns `{"workspace": {"id": …}}`. `projects create` returns
`{"projectId": …, "repoPath": …, "mainWorkspaceId": …}`.

Read the field defensively:

```bash
jq -r '.workspace.id // .id // .workspaceId // empty'
```

CAUTION: A wrong read looks the same as a failure. One misread of `projects create`
created a duplicate project. There is no `projects delete`, so the duplicate is permanent.

### The CLI session is not the application session

The desktop application and the CLI share `~/.superset/`. They do not share the session.
A signed-in application does not mean that `superset auth whoami` works. The CLI needs its
own `superset auth login` once.

### `workspaces list` returns every project

Filter by `projectId`. Without a filter the list holds every workspace on the host,
including projects that have nothing to do with this repository.

### The main workspace is the real clone

A project's main workspace points at the main checkout, not at a worktree. Deleting it
deletes the repository.

`reap.sh` refuses it. The test compares the two git directories, which match only in the
main checkout:

```bash
[ "$(git -C "$DIR" rev-parse --git-dir)" = "$(git -C "$DIR" rev-parse --git-common-dir)" ]
```

### Slashed branch names leave empty directories

A branch named `dev/eng-181-…` creates
`worktrees/<project>/dev/eng-181-…`. Deleting the leaf leaves an empty `dev/`
directory. `reap.sh` prunes empty parents, and never climbs above the worktrees root.

## Related tools

The workflow also needs the GitHub CLI. One trap is worth stating here.

CAUTION: `gh` returns an empty list for a renamed repository. It does not follow the
rename. `gh pr list --repo OLD/NAME` prints `[]` and exits zero, which looks the same as
"no open pull requests". Keep `repos[].name` current in the configuration.

Review threads need GraphQL, because `gh pr view` does not return them:

```bash
gh api graphql -F owner=… -F repo=… -F number=… -f query='
  query($owner:String!,$repo:String!,$number:Int!){
    repository(owner:$owner,name:$repo){ pullRequest(number:$number){
      reviewThreads(first:100){nodes{
        isResolved isOutdated path
        comments(first:1){nodes{author{login} body createdAt}}
        lastComment: comments(last:1){nodes{author{login} createdAt}}}}}}}'
```

Fetch the last comment as well as the first. Without it you cannot tell a reviewer's
question from your own answer. See `board.md`.
