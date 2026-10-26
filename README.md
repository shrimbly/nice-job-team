# Superset Board

An orchestrated agent workflow you can install. One orchestrator agent holds a
queue of work; many implementation agents each deliver one pull request from
their own git worktree; a board shows every card — PR state, CI, review
threads, agent liveness — ordered by what needs you. The TypeScript CLI in
`cli/` (the `board` command, zero runtime dependencies, Node >= 20) owns all
of it: polling GitHub and Superset, the board state, the card model, and the
rendered dashboards. The repository doubles as a Claude Code plugin carrying
the agent skills, the read-only scout subagent and the status Stop hook, and
an optional macOS menu-bar app draws the same board from the CLI's
`cards.json`.

```
┌──────────────────────────────────────────────────┐
│ Board                    ● 8 open · 2 need you   │
├──────────────────────────────────────────────────┤
│ Region names and scaling copy     [IN REVIEW]  ⌄ │
│ PR-508  ENG-645  Preview                         │
│ Restrict access to partner mo…    [NEEDS YOU]  ⌄ │
│ ●eng-607-partner-restrict  ENG-607               │
│ Test-this-deployment card: sa…    [DRAFT]      ⌄ │
│ PR-470  ENG-609  Preview                         │
├──────────────────────────────────────────────────┤
│ polled just now                   Refresh   Quit │
└──────────────────────────────────────────────────┘
```

## Install

Everything installs from a clone. There is **no published npm package** yet,
and the clone in front of you may have **no public remote** — the public
mirror is a separate export — so the commands below name paths, and every one
of them works against a plain local checkout.

**1. The plugin.** The agent side — the three skills, the `superset-scout`
subagent, and the status-observation Stop hook — installs as a Claude Code
plugin. The repository is its own single-plugin marketplace:

```sh
claude plugin marketplace add /path/to/superset-board   # or owner/repo, or a git URL
claude plugin install superset-board@superset-board -y
```

**2. The CLI.** The plugin does not carry the `board` binary itself; install
it from the `cli/` package. The `npm install` first is required: packing the
directory runs the `prepare` build, and a fresh clone has no devDependencies
for `tsc` to come from:

```sh
cd /path/to/superset-board/cli && npm install && npm install -g .
```

(`npm install -g github:<owner>/<repo>` would also work — but only against a
repository that has a public remote to fetch from, which this clone may not.
The path form above always holds.)

The `board` verbs need the CLI on the **login** PATH, not just this shell:
dispatched implementation agents open their own shells and write their status
files with the same `board` command.

**3. Verify.** The first command to run, always:

```sh
board doctor
```

It checks git, the GitHub CLI, the Superset CLI and its login, seeds the
board directory, and prints READY or BLOCKED with the fix named.

Packaging details, the no-install dev loop, and what the Stop hook does are
in [README-PLUGIN.md](README-PLUGIN.md).

## Quickstart

From inside the repository you want orchestrated:

```sh
board init --detect      # print what can be detected — changes nothing
board init --apply --repo owner/name --reviewer <login>
```

The `superset-setup` skill drives these two for you and asks only for what
cannot be detected. A first `--apply` that names no `--tracker` defaults to
**GitHub Issues** — the repo's own backlog, read with the `gh` you already
have; `--tracker linear|markdown` chooses the others. Configuration lands in
`~/.claude/superset-orchestrator/config.json` (the legacy single file, still
the default and fully supported) — or in the split machine + project layout
via `--apply --split` / `board init --migrate`; see [docs/config.md](docs/config.md).

Then start the poller and look at the board:

```sh
board watch --install    # register the poller as a login service (launchd/systemd)
board cycle --open       # one full maintenance cycle, then open board.html
```

**Optional, macOS:** the menu-bar app, so a count and a tint can tell you
something needs you without you going to look:

```sh
make install             # build dist/NiceJobTeam.app, copy to ~/Applications
```

Needs Swift 6.1+ and no Xcode — see [The menu-bar app](#the-menu-bar-app).

## The workflow this board watches

The board is one view onto an orchestrated agent workflow: one orchestrator
agent holds the queue, and many implementation agents each deliver one pull
request from one git worktree.

That workflow is documented in [`docs/`](docs/), and the agent contracts are
in [`skills/`](skills/) so they can be copied to another project.

- [docs/README.md](docs/README.md) — start here, and how to adopt it
- [docs/workflow.md](docs/workflow.md) — the model, the roles, the loop
- [docs/board.md](docs/board.md) — the board file, its states, its commands
- [docs/config.md](docs/config.md) — the config layouts, legacy and split
- [docs/lessons.md](docs/lessons.md) — why each guard exists

## The menu-bar app

A native macOS menu-bar app for the same board: one compact card per task/PR,
refreshed without being asked, with links out to the PR, its ticket, its
preview deployment and the Superset workspace holding the work. Each card is
two fixed rows — title, then links — so every card is the same height. The
status pill sits top right, in its own column to scan down.

The app is a **thin client of the `board` CLI**: a refresh spawns
`board refresh` (which owns `gh`, the card logic and the stack folding), reads
the root-level `cards.json` it wrote, and draws that. Refresh is every 60
seconds, plus **when the Mac wakes** and **when you open the panel** on data
older than an interval. "polled Xm ago" in the footer comes from the
document's own `generatedAt`, so it reports when the board was actually
polled. While a refresh is failing it retries after 15 seconds, then backs off
by doubling to a ten-minute ceiling; the last good `cards.json` keeps the
cards up rather than going blank, and when the CLI itself had to degrade (a
`gh` call failed mid-poll) the document's `note` says so and the footer shows
it.

### Build and install

There is no Xcode on the target machine — only Command Line Tools — so the
`.app` is assembled by hand from the SwiftPM binary. There is no
`.xcodeproj`, and `xcodebuild` is not used.

```sh
make            # build and assemble dist/NiceJobTeam.app
make run        # ...and launch it
make install    # copy it to ~/Applications
make test       # swift test
```

Needs Swift 6.1+ (`swift --version`). The app shells out to the `board` CLI,
which owns the `gh` calls, so it stores no token of its own.

To start it at login: System Settings → General → Login Items → **+** →
`~/Applications/NiceJobTeam.app`.

**Gatekeeper.** The app is unsigned, so the first launch from
`~/Applications` may be refused. Right-click the app → **Open** → **Open**,
or System Settings → Privacy & Security → **Open Anyway**. Launching from
`make run` in the build directory is not usually challenged.

**Menu-bar managers.** Ice, Bartender and the like put new items in their
hidden section by default; move the Board item out the usual way (⌘-drag, or
the manager's own settings).

### Using it

- **Click the menu-bar item** for the panel. **Right-click** for Refresh and
  Quit.
- The item shows the number of open cards. When any card needs you it turns
  amber, the glyph fills in, and the number becomes the count that needs you —
  that is the app's whole job while the panel is shut.
- **When a PR turns mergeable or a preview deployment lands**, a banner drops
  in under the menu-bar item — the app's own, not the system's, so it is attributed to
  the app and clicking it opens the link. Banners stay until dismissed: the
  ✕ puts one away without opening it, and opening the panel clears them all.
  The pile is stacked sonner-style — the newest in front, older banners
  peeking beneath it until you hover, when the stack fans out. Three at a
  time, the rest queued behind them. A preview banner waits for the deploy to
  finish: the push that starts it is not news, and the preview URL is the
  branch's and never changes, so what the banner marks is the moment the site
  is actually serving the new change.
- **Click a row** to expand it into what it is / where it's at, plus a meta
  strip: review, CI, unresolved threads, merge state, agent liveness,
  uncommitted files, branch. Expanded rows are remembered across launches.
- **Click a chip** to open it. Everything opens in your default browser,
  except the workspace chip, which opens the Superset app at that chat — that
  is how you reach the agent to instruct it. A card whose agent runs in the
  cloud carries a **cloud** glyph there instead, and opens the session on
  claude.ai. A preview chip whose deployment is rebuilding — the deploy check
  still running after a push — spins until the new one is live, then resolves
  to the globe.

The pill colours are the dashboard's, with one change: `IN REVIEW` is teal
rather than the same grey as `DRAFT` — the two were indistinguishable, and a
PR out for review is further along than a draft.

## Where the cards come from

**GitHub is required; the orchestrator's files are enrichment.** With
`~/.claude/superset-orchestrator/` missing entirely the board still shows a
card per open PR — it just has no workspace names, tickets, outcomes or agent
status to add. Point it at a repo with `BOARD_REPOS=owner/name` (under the
hood: `board refresh --repos … --stdout`, no orchestrator root needed). With
neither a config nor that variable, nothing polls and the board says so,
rather than guessing at a repository.

**Whose PRs.** `operator.githubLogin` decides, and `board poll` reads the same
field, so the two halves cannot show different boards. A login watches that
person; `*` takes every PR in the repo, which is what a team board wants.

**Which tracker.** An explicit `tracker` block chooses: `kind` is matched
against the board item's `source.kind`, and `issueUrl` has `{key}`
substituted. Without a block, tickets are Linear built from
`operator.linearWorkspace` — what every config written before the block
existed means. A key from a tracker the config does not name still shows on
the card — it just does not link, because a link built from the wrong template
goes somewhere wrong rather than nowhere. Two kinds need no extra account:
`github-issues` (the fresh-install default — the repo's own issues, priority
from the labels `urgent`/`high`/`medium`/`low`) and `markdown`, a backlog of
files committed to the repository, one per task — see
[markdown-tracker.md](skills/superset-orchestrator/reference/markdown-tracker.md).

**Which preview host.** A preview deployment is found by matching the PR's
bot comments, Vercel by default. `preview.patterns` replaces that list —
first match wins, and an unusable pattern costs a chip rather than the board.

**Where the agent runs.** An item dispatched with `--host cloud` runs as a
Claude Code session on claude.ai rather than in a Superset workspace on this
machine. Its card shows a cloud glyph and opens the session in a browser.
Such an agent cannot write to the orchestrator's status inbox, so these cards
carry no agent state, phase or liveness, and everything they say comes from
GitHub. Before a PR exists the card reads "Running on claude.ai. Nothing
pushed yet." rather than reporting missing data as a fault. See
[cloud-sessions.md](skills/superset-orchestrator/reference/cloud-sessions.md).

All of those sources are the CLI's to read — `board refresh` polls GitHub,
folds the orchestrator's files in, and writes one `cards.json` v2 document at
the orchestrator root (plus per-project `board.html`, `board.md` and
`cards.json`). The app reads the root document and nothing else.

| Source | Read by | Used for |
|---|---|---|
| `gh pr list` / `gh api graphql` | the CLI, per refresh | the PRs, their state, threads, previews |
| `board.json`, `workspaces/*.json`, `signals/*` | the CLI, per render | items, agents, liveness, landed PRs |
| the config ([docs/config.md](docs/config.md)) | the CLI | which repos, whose PRs, tracker and preview links |
| `cards.json` | **the app** | everything it draws |

The orchestrator's directory is watched with FSEvents, so an agent writing
its status redraws the board at once without a GitHub call: the app runs
`board refresh --render-only` (which polls nothing) and re-reads. **The app
only ever reads the orchestrator's state**; the only writer is the CLI it
spawns.

An open PR that the orchestrator has closed or rejected stays hidden. Hiding
it is a decision about that PR, and re-adding it as a GitHub-only card would
quietly overrule you. **A merged PR leaves the board** — it asks nothing of
you — while a PR closed *without* merging stays, as `GONE FROM OPEN`.

## Design notes

The card model in `cli/src/cards/` is a **port, not a redesign**: the pill
chain, the "is / at" chain and the sort order are transcribed from the
original `render-board.sh` jq, quirks kept deliberately so old and new agree
byte for byte — and every place the port *chose* to differ is enumerated as a
`Divergence` in `cli/src/cards/build.ts` (a red check outranks a waiting
review; running CI is not "mergeable"; merged PRs are dropped rather than
shown as `MERGED — REAP`). The goldens live in `cli/test/` — `build.test.ts`
diffs the chain against the reference jq's frozen output; `assemble.test.ts`
and `stacks.test.ts` hold the app-mode assembly. The Swift side is pinned the
other way round: `Tests/BoardKitTests/CardsDocumentDecodingTests` decodes a
`cards-v2.json` fixture **generated by the CLI itself** (the regeneration
command is in the test file's header), so the app's reader is tested against
the producer's actual output.

The history of why each guard exists — the failure that taught it — is in
[docs/lessons.md](docs/lessons.md).

To look at the model by hand:

```sh
board dump | jq '.projects[].cards[] | {id, pill}'
```

`board dump` prints the same cards.json v2 document the app reads, explicit
nulls and all.

## Environment

| Variable | Effect |
|---|---|
| `SUPERSET_ORCH_ROOT` | the orchestrator root (default `~/.claude/superset-orchestrator`) |
| `SUPERSET_ORCH_PROJECT` | select one project key under `p/` |
| `SUPERSET_ORCH_DIR` | a one-off board directory, outside the root's world |
| `BOARD_CLI_PATH` | (app) path to the `board` CLI, if it is somewhere unusual |
| `BOARD_ORCHESTRATOR_DIR` | (app) read a different orchestrator directory — a copy, for a look at another board |
| `BOARD_REPOS` | `owner/name`, comma-separated: a board with no orchestrator at all |
| `BOARD_APPEARANCE` | (app) `dark` or `light`, pinning the panel instead of following the system |

A bundled app inherits launchd's `PATH`, which does not include
`/opt/homebrew/bin`, so the `board` CLI is located explicitly:
`BOARD_CLI_PATH`, then the usual install prefixes, then your login shell's
`command -v board`. If the footer says the CLI was not found, set
`BOARD_CLI_PATH`.

## Layout

```
cli/                  the board CLI — all state, polling, card logic, rendering
skills/               the agent contracts: orchestrator, implementer, setup
agents/               the read-only scout subagent
hooks/                the status-observation Stop hook
.claude-plugin/       the plugin manifest and marketplace
docs/                 the workflow documentation
Sources/BoardKit/     the app's client model — cards.json decoding, CLI location
Sources/Board/        the app — status item, panel, refresh loop
Tests/BoardKitTests/  decoding tests against a CLI-generated cards.json fixture
Resources/Info.plist  LSUIElement, so it lives in the menu bar with no Dock icon
Makefile              build → .app, no Xcode involved
```

Tests use **swift-testing**, not XCTest: Command Line Tools ships
`Testing.framework` but no XCTest, so `swift test` cannot link XCTest on a
machine without Xcode.
