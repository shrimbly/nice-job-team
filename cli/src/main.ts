// The CLI over the one card model. `render` is render-board.sh's replacement:
// same inputs, byte-identical board.html and board.md, plus the cards.json v2
// document the shell never had. `dump` prints the model without touching disk
// — and with --golden, in the exact shape the frozen expected-cards.json
// goldens were generated in, so regenerating them stays a redirect away.
//
// This module runs on import: bin/board reaches it via dynamic import(), and
// the parity harness via `node dist/main.js`, and both must behave the same.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assemble, assemblerConfig } from './cards/assemble.js';
import type { AssemblerConfig } from './cards/assemble.js';
import { buildPayload } from './cards/build.js';
import { loadConfig, loadRoot } from './config.js';
import { runDoctor } from './doctor.js';
import { runInit } from './init.js';
import { runArchive } from './ops/archive.js';
import { runCloud } from './ops/cloud.js';
import { runCycle, runPollVerb } from './ops/cycle.js';
import { runDispatch } from './ops/dispatch.js';
import { runItem } from './ops/item.js';
import { runReap } from './ops/reap.js';
import { runReconcile } from './ops/reconcile.js';
import { effectiveQueue, runReview } from './ops/review.js';
import {
  gatherProjects,
  loadProject,
  renderBoards,
  runRefresh,
  selectProjects,
} from './ops/refresh.js';
import { runStatus } from './ops/status.js';
import { runTasks } from './ops/tasks.js';
import { runWatch } from './watch.js';
import {
  readAgentStatuses,
  readBoardItems,
  readGithubSignals,
  readWorkspacesSignal,
} from './read.js';
import { renderCardsJson } from './render/cardsjson.js';
import type { BoardConfigFile, OrchRoot } from './types.js';

/** lib.sh's now(): `date -u +%Y-%m-%dT%H:%M:%SZ` — ISO seconds, no millis. */
function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function warnAll(warnings: string[]): void {
  // lib.sh's warn() prefix, so a wrapper that greps orchestrator logs keeps
  // matching whichever implementation rendered.
  for (const warning of warnings) process.stderr.write(`warn: ${warning}\n`);
}

// ── Argument plumbing ─────────────────────────────────────────────────────────

interface ParsedArgs {
  project?: string;
  golden?: string;
}

/**
 * The two verbs share two flags; anything unrecognised dies the way lib.sh's
 * die does, because a misspelled flag silently ignored is a render of the
 * wrong board.
 */
function parseArgs(argv: string[], allowGolden: boolean): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--project' && argv[i + 1] !== undefined) {
      parsed.project = argv[i + 1]!;
      i += 1;
    } else if (allowGolden && arg === '--golden' && argv[i + 1] !== undefined) {
      parsed.golden = argv[i + 1]!;
      i += 1;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function fail(message: string): never {
  process.stderr.write(`BLOCKED: ${message}\n`);
  process.exit(1);
}

/**
 * main.ts's config read, through the split-aware loader. One seam: everything
 * downstream keeps receiving a plain BoardConfigFile, and the note the loader
 * attaches when the legacy file is shadowing a machine config surfaces here,
 * once, on stderr — informational, so not through warn:'s grep contract.
 */
function effectiveConfig(orch: OrchRoot): BoardConfigFile {
  const loaded = loadConfig(orch);
  if (loaded.deprecationNote !== undefined) {
    process.stderr.write(`note: ${loaded.deprecationNote}\n`);
  }
  return loaded.config;
}

// ── Verbs ─────────────────────────────────────────────────────────────────────

function runRender(argv: string[]): void {
  const args = parseArgs(argv, false);
  const orch = loadRoot();
  // The whole render — per-project board.html/board.md/cards.json plus the
  // root-level merged cards.json — lives in ops/refresh.ts, where `board
  // refresh` shares it; this module runs its dispatch on import and so can
  // export nothing itself.
  renderBoards({
    orch,
    config: effectiveConfig(orch),
    selected: selectProjects(orch, args.project),
    log: (line) => console.log(line),
    warn: (message) => warnAll([message]),
    note: null,
  });
}

function runDump(argv: string[]): void {
  const args = parseArgs(argv, true);

  if (args.golden !== undefined) {
    // A fixture-shaped directory, read exactly the way the golden tests read
    // it, printed in the goldens' own {cards} shape with their arguments:
    // linearWs acme, a cutoff before every fixture, a generatedAt nothing
    // compares. `board dump --golden <dir> > expected-cards.json` regenerates.
    const dir = args.golden;
    const board = readBoardItems(join(dir, 'board.json'));
    const github = readGithubSignals(join(dir, 'github.json'));
    const agents = readAgentStatuses(join(dir, 'workspaces'));
    const signal = readWorkspacesSignal(join(dir, 'workspaces-signal.json'));
    warnAll([...board.warnings, ...github.warnings, ...agents.warnings, ...signal.warnings]);
    const payload = buildPayload(
      {
        items: board.value,
        prs: github.value.prs,
        agents: agents.value,
        workspaces: signal.value.workspaces,
        linearWorkspace: 'acme',
        recentCutoff: '2020-01-01T00:00:00Z',
        generatedAt: 'X',
      },
      'reference',
    );
    process.stdout.write(JSON.stringify({ cards: payload.cards }, null, 2) + '\n');
    return;
  }

  // The v2 document over the live layout, to stdout: what `render` writes per
  // project, except assembled across every project at once so cross-project
  // claims and stacks resolve the way the app resolves them. gatherProjects
  // owns the per-(repo, number) PR dedupe the joined signal files need.
  const orch = loadRoot();
  const config = effectiveConfig(orch);
  const appConfig: AssemblerConfig = assemblerConfig(config);
  const projects = selectProjects(orch, args.project);
  const gathered = gatherProjects(projects, (project) => {
    const data = loadProject(orch, project);
    warnAll(data.warnings);
    return data;
  });
  const cards = assemble(gathered.snapshots, gathered.prs, appConfig);
  const reviews = effectiveQueue(orch, projects).rows;
  process.stdout.write(
    renderCardsJson(
      projects, cards, appConfig, nowIso(), null, reviews,
      config.review?.countsAsNeedsYou === true,
    ),
  );
}

function printHelp(): void {
  process.stdout.write(
    [
      'board — the Superset orchestrator board, rendered from one card model',
      '',
      'usage:',
      '  board doctor                       verify the environment, seed the board',
      '                                     directory, print READY or BLOCKED',
      '  board init --show|--detect|--apply configure the orchestrator for the repo',
      '                                     you are standing in (the superset-setup',
      '                                     skill drives --detect and --apply;',
      '                                     --apply --split writes the machine +',
      '                                     project config files instead)',
      '  board init --migrate               split the legacy config.json into the',
      '                                     machine + project config files',
      '  board cycle [--dry-run] [--open]   the whole maintenance cycle:',
      '                                     reconcile → poll → autoreap → archive → render',
      '  board poll [--repo owner/name]     collect GitHub/superset/agent signals,',
      '                                     write signals/*.json, print the summary',
      '  board reconcile                    fold agent statuses and PR facts into board.json',
      '  board archive [--dry-run]          move long-terminal items into archive.json',
      '  board item set|add|list|show ...   read and write individual board items',
      '  board dispatch --item <id> ...     create a workspace (or cloud session) and',
      '                                     start an implementation agent on one item',
      '  board reap --item <id> ...         verify merged + clean, delete the workspace,',
      '                                     close the item; --auto reaps settled PRs',
      '  board review [list] [--dismissed]  the queue of PRs awaiting your review',
      '  board review dismiss|undismiss <owner/name#N>',
      '                                     hide one from the board for good (or undo)',
      '  board review start <owner/name#N> [--json|--dry-run]',
      '                                     workspace on the PR branch + a review agent',
      '                                     (prompt template: config review.prompt)',
      '  board tasks [--open|--list|--index] read the markdown tracker as JSON, or',
      '                                     regenerate TASKS.md (never writes a status)',
      '  board status <verb> [...]          the implementation agent\'s status file:',
      '                                     init|phase|state|verify|risk|ask|gate|pr|',
      '                                     clear-questions|set|show|path|observe',
      '                                     (observe records git facts for the Stop',
      '                                     hook; --quiet, and it never fails)',
      '  board cloud check|enable|send|fire cloud-dispatch plumbing and its preflight',
      '  board watch --once|--start|--status|--stop',
      '            --install|--uninstall     the supervised cycle loop, or its service',
      '  board render [--project <key>]     write board.html, board.md and cards.json',
      '                                     into each project directory, plus the',
      '                                     merged root-level cards.json',
      '  board refresh [--project <key>] [--render-only] [--stdout]',
      '                                     poll signals, then render — never',
      '                                     reconciles, so a read-only client can',
      '                                     call it; --render-only skips the poll,',
      '                                     --stdout also prints the root document',
      '  board refresh --repos owner/name[,owner/name]',
      '                                     github-only: print the v2 document from',
      '                                     live PRs, no orchestrator root needed',
      '                                     (BOARD_REPOS is the flagless spelling)',
      '  board dump [--project <key>]       print the cards.json v2 document',
      '  board dump --golden <dir>          print {cards} for a fixture directory,',
      '                                     in the expected-cards.json shape',
      '  board --version',
      '  board help',
      '',
      'environment: SUPERSET_ORCH_ROOT, SUPERSET_ORCH_DIR, SUPERSET_ORCH_PROJECT',
      '(same meanings as the shell scripts).',
      '',
    ].join('\n'),
  );
}

function printVersion(): void {
  // dist/main.js sits one level under the package root, so ../package.json is
  // ours; the version lives there alone rather than in two places.
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const version = (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  console.log(version);
}

const [verb, ...rest] = process.argv.slice(2);
switch (verb) {
  case 'render':
    runRender(rest);
    break;
  case 'refresh':
    process.exitCode = await runRefresh(rest);
    break;
  case 'dump':
    runDump(rest);
    break;
  // The board-state verbs each own their argv parsing and die BLOCKED-style
  // themselves, so wiring is one awaited call apiece. `cycle` gets render as a
  // callback because importing main.ts from ops/ would re-run this dispatch.
  case 'poll':
    await runPollVerb(rest);
    break;
  case 'reconcile':
    await runReconcile(rest);
    break;
  case 'archive':
    await runArchive(rest);
    break;
  case 'item':
    await runItem(rest);
    break;
  case 'dispatch':
    await runDispatch(rest);
    break;
  case 'reap':
    await runReap(rest);
    break;
  case 'review':
    await runReview(rest);
    break;
  case 'tasks':
    await runTasks(rest);
    break;
  case 'status':
    runStatus(rest);
    break;
  case 'cloud':
    await runCloud(rest);
    break;
  case 'watch':
    await runWatch(rest);
    break;
  case 'cycle':
    await runCycle(rest, { render: () => runRender([]) });
    break;
  case 'doctor':
    runDoctor(rest);
    break;
  case 'init':
    runInit(rest);
    break;
  case '--version':
  case '-v':
    printVersion();
    break;
  case undefined:
  case 'help':
  case '--help':
  case '-h':
    printHelp();
    break;
  default:
    fail(`unknown verb: ${verb} (try: board help)`);
}
