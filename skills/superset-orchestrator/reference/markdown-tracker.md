# The markdown tracker

A backlog that is files in the repository. No account, no API, no network. It is
versioned with the code, reviewed in the same pull requests, and travels with a
clone.

Use it when there is no issue tracker, when the work is personal, or when the
project should stay portable. Linear and GitHub issues remain supported and are
configured the same way — see `tracker` in `config.example.json`.

## The one rule

**The `status` field is the operator's intent. Nothing else may write it.**

`todo`, `doing`, `done` say what a person wants. They do not say what happened.
What happened lives in `board.json` and on the pull request.

The reason is mechanical. A task file is committed, so an agent that wrote
`status: done` would be writing to its own branch. The change would reach `main`
only when that PR merged, every parallel agent would edit the same lines, and the
backlog would be permanently behind and permanently in conflict. So `board tasks`
has no flag that sets status, and never will.

The two are reconciled by being shown together, not by either writing to the
other. `board tasks --index` annotates each task with what the board knows:

```markdown
- [Something already shipped](.tasks/old-thing.md) — low · merged · PR #499
```

A task still marked `todo` beside a merged PR is drift. It is visible, and a
person clears it.

## The format

One file per task. Per file, not one big `TASKS.md`, because a single file that a
human and several agents all edit conflicts constantly. One file per task almost
never does.

```markdown
---
id: regions-scaling
title: Region names and scaling copy
status: todo
priority: high
---

The region picker shows raw slugs instead of names.

## Done when

- [ ] Names are the human-readable ones
- [ ] Scaling copy matches the pricing page
```

| Field | Required | Meaning |
|---|---|---|
| `id` | no | The key. Defaults to the filename without `.md` |
| `title` | no | One line. Defaults to the first `# heading`, then to `id` |
| `status` | no | `todo`, `doing`, `done`, `dropped`. Defaults to `todo` |
| `priority` | no | `urgent`, `high`, `medium`, `low`. Defaults to `medium` |

Every field has a default, so a plain note dropped into the directory is a valid
task rather than an error. The frontmatter reader takes `key: value` scalars
between two `---` lines and ignores anything more elaborate. A backlog that needs
a YAML library to read is not the simple thing this is for.

The body is the brief material. The orchestrator reads it when it writes the
dispatch brief, so state the outcome there, not in the title.

## Layout

```
<repo>/.tasks/<id>.md     the tasks, committed
<repo>/TASKS.md           the index, generated
```

Hidden by default so `.tasks/` cannot collide with a `tasks/` the project already
uses. `TASKS.md` at the root is the visible surface. Set `tracker.path` to move
the directory.

## The commands

```bash
board tasks --open        # JSON: not done, not dropped
board tasks --list        # JSON: everything
board tasks --index       # rewrite TASKS.md
```

There is no scaffold command: a new task is a new markdown file dropped into the
tasks directory, and every field has a default, so an empty file with a good name
is already a valid task.

`--list` and `--open` sort the way a person works: `doing` before `todo`, then by
priority, then by id. Ties break on id, so two reads of an unchanged directory
cannot disagree.

## How a task reaches the board

`board poll` reads the backlog every cycle and writes `signals/tasks.json`. This
costs a directory listing and no model tokens — the same free tier as GitHub PR
state. A scout is not involved, and is not needed.

The poll summary lists only tasks with no board item yet, because a dispatched
task is already on the board and listing it twice reads as two pieces of work.

Dispatch an item from a task with:

```json
"source": { "kind": "markdown", "externalId": "regions-scaling" }
```

That is the same shape a Linear item uses. Everything downstream — grouping,
briefs, the board, the menu-bar app — treats it identically.

## How the board links back

Set the tracker in `config.json`:

```json
"tracker": {
  "kind": "markdown",
  "issueUrl": "https://github.com/acme/platform/blob/main/.tasks/{key}.md"
}
```

`{key}` is replaced by the task id. A GitHub blob URL opens the task in a browser
and is the better choice for a shared repository. `file:///path/to/repo/.tasks/{key}.md`
opens it in a local editor instead.

The menu-bar app reads the same field. The ticket chip shows the task id and
opens the file. Only Linear draws Linear's mark; every other tracker takes a tag.

Omit `issueUrl` and the chip still shows the id — it just opens nothing. That is
a supported setup, not a failure.
