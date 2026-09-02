// `board poll` and `board cycle` — the argv surfaces over runPoll and the
// whole maintenance cycle. cycle.sh's replacement, step for step:
//
//   reconcile → poll → autoreap --quiet [--dry-run] → archive [--dry-run] → render
//
// A failing step is named and the cycle keeps going — the render always runs,
// so the board reflects whatever did complete rather than going stale on one
// error.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cfg, loadConfig, loadRoot, readConfig } from '../config.js';
import { archive } from './archive.js';
import { resolveBoardDir } from './item.js';
import { realPollIo, runPoll } from './poll.js';
import { autoreap } from './reap.js';
import { reconcileVerb } from './reconcile.js';

function die(message: string): never {
  process.stderr.write(`BLOCKED: ${message}\n`);
  process.exit(1);
}

/**
 * poll.sh's preamble: no config is a hard stop, with the fix in the message.
 * "No config" means NO layout — the split-aware loader's sources are empty
 * exactly when neither the legacy config.json nor the machine + project pair
 * exists, so a migrated setup keeps polling without a legacy file.
 */
async function pollVerb(onlyRepo?: string): Promise<void> {
  const orch = loadRoot();
  const loaded = loadConfig(orch);
  if (loaded.sources.length === 0) {
    throw new Error(`no config at ${orch.configPath} — run board doctor`);
  }
  const { boardDir } = resolveBoardDir();
  const summary = runPoll(orch, boardDir, loaded.config, realPollIo(), { onlyRepo });
  console.log(summary);
}

/** `board poll [--repo owner/name]` — poll.sh's argv surface. */
export async function runPollVerb(argv: string[]): Promise<void> {
  let onlyRepo: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repo' && argv[i + 1] !== undefined) {
      onlyRepo = argv[i + 1];
      i += 1;
    } else {
      die(`unknown argument: ${argv[i]}`);
    }
  }
  try {
    await pollVerb(onlyRepo);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
}

// ── board cycle ───────────────────────────────────────────────────────────────

/**
 * main.ts hands the render step in, because importing main.ts from here would
 * re-run its top-level verb dispatch. archiveVerb exists for the same shape.
 */
export interface CycleDeps {
  render: () => void;
}

/** archive.sh's config plumbing, shared by the standalone verb and the cycle. */
async function archiveStep(dryRun: boolean): Promise<void> {
  const { boardDir, projectKey } = resolveBoardDir();
  const config = readConfig(loadRoot());
  const days = cfg<unknown>(config, '.limits.recentlyClosedDays', 7);
  for (const line of await archive(boardDir, { dryRun, days, label: projectKey })) {
    console.log(line);
  }
}

/**
 * `board cycle [--dry-run] [--open]`. Ports cycle.sh's run_step contract: a
 * failing step prints its own error (the way each script printed its BLOCKED
 * line), then "cycle: <step> failed (exit <n>) — continuing", and the closing
 * FAILED line lists every failed step before exiting 1.
 */
export async function runCycle(argv: string[], deps: CycleDeps): Promise<void> {
  let dry = false;
  let open = false;
  for (const arg of argv) {
    if (arg === '--dry-run') dry = true;
    else if (arg === '--open') open = true;
    else die(`unknown argument: ${arg}`);
  }

  // lib.sh died at source time when the project could not be resolved, before
  // any step ran; keep that shape rather than failing five steps in a row.
  try {
    resolveBoardDir();
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }

  const failed: string[] = [];
  const note = (name: string, rc: number): void => {
    failed.push(name);
    process.stderr.write(`cycle: ${name} failed (exit ${rc}) — continuing\n`);
  };
  const step = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      // The bash scripts spoke their own failures; keep that voice, then name
      // the step the way cycle.sh's run_step did.
      process.stderr.write(`BLOCKED: ${err instanceof Error ? err.message : String(err)}\n`);
      note(name, 1);
    }
  };

  await step('reconcile', () => reconcileVerb());
  await step('poll', () => pollVerb());

  // In-process since P3 — `board reap --auto --quiet`, exactly the invocation
  // cycle.sh shelled out to autoreap.sh for. stderr before stdout, the same
  // per-run buffering runReap's emit uses.
  await step('autoreap', async () => {
    const { boardDir, projectKey } = resolveBoardDir();
    const orch = loadRoot();
    const result = await autoreap(
      { io: realPollIo(), orch, boardDir, config: readConfig(orch), label: projectKey },
      { quiet: true, dryRun: dry },
    );
    for (const line of result.stderr) process.stderr.write(`${line}\n`);
    for (const line of result.stdout) console.log(line);
  });

  await step('archive', () => archiveStep(dry));
  await step('render', () => deps.render());

  if (open) {
    // A viewer concern, exactly as cycle.sh kept it: render writes files, this
    // flag opens one.
    const { boardDir } = resolveBoardDir();
    spawnSync('open', [join(boardDir, 'board.html')], { stdio: 'inherit' });
  }

  if (failed.length > 0) {
    process.stderr.write(
      `cycle: FAILED steps: ${failed.join(' ')} — board rendered from what did complete\n`,
    );
    process.exitCode = 1;
  }
}
