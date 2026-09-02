# Configuration

The board reads its configuration from one of two layouts. The legacy single
file keeps working unchanged; the split layout is additive.

## The legacy file (today's default)

`$SUPERSET_ORCH_ROOT/config.json` — default
`~/.claude/superset-orchestrator/config.json` — holds everything in one file.
Nothing about it changed, and no migration is required.

**Precedence: the legacy file wins.** When it exists, it is the effective
config exactly as written, and the split files are ignored. Only when a
machine config *also* exists does `board render` print a note saying the
legacy file is shadowing it and how to migrate. Legacy alone is today's
normal and prints nothing.

## The split layout

Two files, split by who the contents belong to.

### Machine config — `~/.config/superset-board/config.json`

`$XDG_CONFIG_HOME` is honoured. What is true of this machine and its
operator — never committed anywhere:

| Field | Meaning |
| --- | --- |
| `stateDir` | Where board state lives. Default `~/.claude/superset-orchestrator`, so nothing moves. `SUPERSET_ORCH_ROOT` still overrides it. The menu-bar app reads it the same way, so both resolve one root. |
| `operator` | Logins, Linear workspace, timezone. |
| `repos[]` | Per repo: `localPath` (this machine's clone) and `supersetProjectId`. |
| `cloud`, `limits`, `cadence`, `gates`, `answers` | Operator-side knobs. |

### Project config — `.superset-board.json`, committed in each repo

Found through the machine entry's `localPath`. What the team shares:

| Field | Meaning |
| --- | --- |
| `name` | The repo, `owner/name`. |
| `defaultBase`, `reviewers`, `shortName`, `key`, `checks` | Per-repo team settings. |
| `tracker`, `preview` | The top-level blocks. With several repos, the first project file that defines them wins. |

### Merging

The effective config is the machine config with each repo entry overlaid by
its project file: the project file wins the team fields, the machine file
wins `localPath` and `supersetProjectId` (a committed file cannot steer
another machine's paths). A repo whose project file is missing keeps whatever
its machine entry says.

## Migrating

```
board init --migrate
```

Reads the legacy file, writes both new files, and — only after both writes
land — renames the legacy file to `config.json.migrated-<ts>`. It prints
which fields went to which file. A split file that already exists is
tolerated only when it holds exactly what the migrate would write (that is a
crashed previous run, and re-running is the recovery); anything else refuses
with the manual step named — merging two configs is the operator's call. The
effective config is identical before and after; a repo entry with no
`localPath` stays whole in the machine file, and every entry keeps its
`name`/`key`/`defaultBase` machine-side as the fallback for a missing clone
or project file.

New setups can write the split layout directly:

```
board init --apply --split --repo owner/name ...
```

Same flags as a plain `--apply`; only where the answers land differs.
