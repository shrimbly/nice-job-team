// `board watch` — watch.sh's replacement, and the one deliberate REDESIGN of
// P3: the nohup/pidfile/md5-poll daemon becomes a supervised foreground loop
// that launchd (or systemd --user) keeps alive. What survives from the bash is
// the scar tissue, not the plumbing (docs/lessons.md holds the why):
//
//   - one watcher per project, each with its own pidfile, log and interval
//     file inside its own board directory — separate processes are the
//     failure isolation;
//   - a cycle is BOUNDED: killed at 3× the interval, because one hung
//     `--once` once wedged the loop while `--status` cheerfully reported
//     "watching" and the board froze for twelve hours;
//   - `--status` judges the watcher by its last WRITE, never by pid liveness
//     — the other half of the same twelve-hour lesson;
//   - the inbox fast path: an agent writing its status file is the one signal
//     that costs nothing to detect, so reconcile+render land within ~5s of it
//     instead of waiting out the interval, and nothing network rides along;
//   - events.log holds only what just CHANGED; standing conditions (stray:,
//     drift:) stay in watch.log so the transitions stay readable;
//   - watch.log carries the "──── <stamp> ────" cycle markers.
//
// The cycle itself is `board cycle` — ops/cycle.runCycle behind its own argv —
// spawned as a child in its own process group. A child, not an in-process
// call, for two reasons: killing a hung gh means killing a process group (the
// exec is synchronous down in the facts runners, so no in-process timer could
// ever fire), and one definition of a cycle means spawning the verb rather
// than re-listing its steps — the first watch.sh loop inlined them and
// silently skipped the events extraction for half an hour.

import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch as fsWatch,
  writeFileSync,
} from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg, loadRoot, readConfig } from './config.js';
import { resolveBoardDir } from './ops/item.js';
import { nowIso } from './store.js';
import type { BoardConfigFile, ExecResult } from './types.js';

// ── The io seam ───────────────────────────────────────────────────────────────

/**
 * One spawned board verb. `killGroup` MUST cause `wait` to settle — the real
 * implementation SIGKILLs the child's process group and the close event
 * resolves; a stub resolves its own promise.
 */
export interface CycleHandle {
  wait(): Promise<{ stdout: string; stderr: string }>;
  killGroup(): void;
}

/**
 * Everything watch touches outside its own process. Tests stub the whole
 * thing: no real cycle, no launchctl, no signal to any real pid — the danger
 * here is a watcher that reaps real workspaces, so the seam is total.
 */
export interface WatchIo {
  /** Spawn `node <mainJs> <argv...>` detached in its own process group. */
  spawnBoard(argv: string[]): CycleHandle;
  /** launchctl / systemctl, synchronously. */
  exec(cmd: string, args: string[]): ExecResult;
  pidAlive(pid: number): boolean;
  /** SIGTERM one pid (the pidfile holder --stop kills). */
  kill(pid: number): void;
  /** lib.sh's now(): ISO-8601 UTC seconds, no millis — the cycle stamp. */
  now(): string;
  nowMs(): number;
  homeDir(): string;
  uid(): number;
  platform: string;
  env: NodeJS.ProcessEnv;
  /** The node binary, for ProgramArguments/ExecStart. */
  execPath: string;
  /** The compiled main.js beside this module — the CLI the services run. */
  mainJs: string;
  /** This process, for the pidfile the foreground loop writes. */
  pid: number;
  print(line: string): void;
}

export function realWatchIo(): WatchIo {
  return {
    spawnBoard(argv: string[]): CycleHandle {
      const child = spawn(process.execPath, [this.mainJs, ...argv], {
        // Its own process group: the 3×-interval kill must take the hung gh or
        // superset grandchild with it, not just the node in between.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      const done = new Promise<{ stdout: string; stderr: string }>((resolve) => {
        let settled = false;
        const settle = (): void => {
          if (!settled) {
            settled = true;
            resolve({ stdout, stderr });
          }
        };
        child.on('close', settle);
        // A spawn failure emits error and may never emit close; a watcher that
        // hangs on a missing node would be the wedge this design exists to end.
        child.on('error', (err) => {
          stderr += `${String(err)}\n`;
          settle();
        });
      });
      return {
        wait: () => done,
        killGroup: (): void => {
          try {
            if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
          } catch {
            try {
              child.kill('SIGKILL');
            } catch {
              // already gone — which is the goal
            }
          }
        },
      };
    },
    exec(cmd: string, args: string[]): ExecResult {
      const result = spawnSync(cmd, args, { encoding: 'utf8' });
      if (result.error !== undefined) {
        return { status: 127, stdout: '', stderr: String(result.error) };
      }
      return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    },
    pidAlive(pid: number): boolean {
      // kill(pid, 0): EPERM means alive but someone else's — still watching.
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    kill(pid: number): void {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // raced with its own exit; --stop still cleans the files up
      }
    },
    now: nowIso,
    nowMs: () => Date.now(),
    homeDir: () => homedir(),
    uid: () => process.getuid?.() ?? 0,
    platform: process.platform,
    env: process.env,
    execPath: process.execPath,
    mainJs: fileURLToPath(new URL('./main.js', import.meta.url)),
    pid: process.pid,
    print: (line: string) => console.log(line),
  };
}

// ── Layout ────────────────────────────────────────────────────────────────────

export interface WatchPaths {
  boardDir: string;
  projectKey: string;
  /** The GLOBAL agent-status inbox the fast path watches. */
  workspacesDir: string;
  pidFile: string;
  logFile: string;
  eventsFile: string;
  intervalFile: string;
}

export function watchPaths(boardDir: string, projectKey: string, workspacesDir: string): WatchPaths {
  return {
    boardDir,
    projectKey,
    workspacesDir,
    pidFile: join(boardDir, 'watch.pid'),
    logFile: join(boardDir, 'watch.log'),
    eventsFile: join(boardDir, 'events.log'),
    intervalFile: join(boardDir, 'watch.interval'),
  };
}

function resolveWatchPaths(io: WatchIo): WatchPaths {
  const orch = loadRoot(io.env);
  const { boardDir, projectKey } = resolveBoardDir(io.env);
  return watchPaths(boardDir, projectKey, orch.workspacesDir);
}

function readPid(file: string): number | undefined {
  try {
    const n = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A live pid is not a live WATCHER. The pidfile outlives a SIGKILL or a power
 * loss, and at the next boot an unrelated process can reuse the number —
 * pidAlive counts EPERM'd root processes as alive, so any of them qualifies.
 * Under KeepAlive that stale file is a permanent wedge: the respawned daemon
 * refuses "already watching", exits, and is respawned into the same refusal
 * forever, while launchd's own BLOCKED lines keep watch.log fresh enough that
 * the STALLED heuristic never trips. So before believing the pidfile, ask the
 * OS what the pid actually runs: only a command line naming this CLI's main.js
 * counts as a watcher; anything else is pid reuse and the file is stale. If ps
 * itself is unavailable, fall back to pid liveness — refusing stays the safe
 * default.
 */
function pidIsWatcher(io: WatchIo, pid: number): boolean {
  if (!io.pidAlive(pid)) return false;
  const result = io.exec('ps', ['-o', 'command=', '-p', String(pid)]);
  if (result.status !== 0) return true;
  return result.stdout.includes(io.mainJs);
}

/**
 * --start may override the configured cadence, so watch.interval remembers
 * what is actually running. Without this, --status reported the default and
 * computed its staleness threshold from a number the daemon was not using.
 */
export function resolveInterval(paths: WatchPaths, config: BoardConfigFile): number {
  try {
    const n = Number(readFileSync(paths.intervalFile, 'utf8').trim());
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    // no file: fall back to the configured cadence
  }
  const configured = Number(cfg(config, '.cadence.watchSeconds', 120));
  return Number.isFinite(configured) && configured > 0 ? configured : 120;
}

// ── events.log extraction ─────────────────────────────────────────────────────
// watch.sh's seds, ported over `board cycle`'s combined output instead of four
// per-step captures. The regions lean on shapes the board verbs guarantee:
// reconcile's change lines are the only two-space-indented stdout before the
// poll summary's first "── " header, the deltas section is the summary's last
// and runs until the first column-0 line (autoreap/archive/render speak at
// column 0), and autoreap/archive lines are shape-matched on both streams.

const REAP_OR_ARCHIVE_LINE =
  /^(auto-reaped |would reap |skipped |unblocked:|auto-reap is off|archived |would archive |nothing to archive)/;

export function extractEvents(stamp: string, stdout: string, stderr: string): string[] {
  const out = stdout.split('\n');
  const events: string[] = [];

  // The delta section: what just changed on GitHub. grep -E '^  [A-Za-z]'
  // exactly — the ★/✖ banner lines and "(first poll — no baseline)" never
  // made it into events.log, and still don't.
  const deltaIdx = out.findIndex((l) => l.includes('── Deltas since last poll'));
  if (deltaIdx >= 0) {
    for (let i = deltaIdx + 1; i < out.length; i += 1) {
      const line = out[i]!;
      if (!line.startsWith('  ')) break;
      if (/^ {2}[A-Za-z]/.test(line)) events.push(`${stamp}  ${line}`);
    }
  }

  // sed -n '/── Agents/,/── Workspaces/p' | grep -E 'NEEDS-OPERATOR|blocked='
  const agentsIdx = out.findIndex((l) => l.includes('── Agents'));
  if (agentsIdx >= 0) {
    for (let i = agentsIdx; i < out.length; i += 1) {
      const line = out[i]!;
      if (/NEEDS-OPERATOR|blocked=/.test(line)) events.push(`${stamp}  needs-operator:${line}`);
      if (i > agentsIdx && line.includes('── Workspaces')) break;
    }
  }

  // Reconcile's change lines (board cycle reconciles before polling, so they
  // sit ahead of the first summary header). `stray:` and `drift:` are standing
  // conditions, true every cycle until someone acts — appending them each
  // minute buries the state transitions events.log exists to record.
  let headerIdx = out.findIndex((l) => l.startsWith('── '));
  if (headerIdx < 0) headerIdx = out.length;
  for (let i = 0; i < headerIdx; i += 1) {
    const line = out[i]!;
    if (!line.startsWith('  ')) continue;
    if (/^ {2}(stray|drift):/.test(line)) continue;
    events.push(`${stamp}  ${line}`);
  }

  // Autoreap and archive speak only when something happened, so every line is
  // an event. Shape-matched because the two streams arrive as blobs, not as
  // the per-step captures the bash had (skipped/refusal lines ride stderr).
  for (const line of [...out, ...stderr.split('\n')]) {
    if (REAP_OR_ARCHIVE_LINE.test(line)) events.push(`${stamp}  ${line}`);
  }

  return events;
}

// ── One cycle ─────────────────────────────────────────────────────────────────

function stripTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, '');
}

export interface CycleOptions {
  /** The 3×-interval cap; absent for a hand-run --once (^C is the operator's cap). */
  capSeconds?: number;
  signal?: AbortSignal;
}

/**
 * One `board cycle` under the log marker, events extracted. Never throws on a
 * failing cycle — watch.sh's `|| true` on every step, kept, because a watcher
 * that dies on a flaky poll is a board that silently freezes.
 */
export async function cycleOnce(io: WatchIo, paths: WatchPaths, opts: CycleOptions = {}): Promise<void> {
  const stamp = io.now();
  const handle = io.spawnBoard(['cycle']);

  let killed = false;
  const ac = new AbortController();
  ac.signal.addEventListener('abort', () => handle.killGroup(), { once: true });
  const timer =
    opts.capSeconds !== undefined
      ? setTimeout(() => {
          killed = true;
          ac.abort();
        }, opts.capSeconds * 1000)
      : undefined;
  const onParentAbort = (): void => ac.abort();
  opts.signal?.addEventListener('abort', onParentAbort, { once: true });

  const { stdout, stderr } = await handle.wait();
  if (timer !== undefined) clearTimeout(timer);
  opts.signal?.removeEventListener('abort', onParentAbort);

  mkdirSync(paths.boardDir, { recursive: true });
  let block = `\n──── ${stamp} ────\n${stripTrailingNewlines(stdout)}\n`;
  if (stderr.trim() !== '') block += `${stripTrailingNewlines(stderr)}\n`;
  if (killed) {
    // The partial output above is the forensics; this line is why it stops.
    block += `watch: cycle killed after ${opts.capSeconds}s (3× the interval) — a step is hung\n`;
  }
  appendFileSync(paths.logFile, block);

  const events = extractEvents(stamp, stdout, stderr);
  if (events.length > 0) appendFileSync(paths.eventsFile, events.join('\n') + '\n');
}

// ── The supervised loop ───────────────────────────────────────────────────────

export interface LoopOptions {
  intervalSeconds: number;
  /** Inbox debounce; 1s in production, injectable so tests need not wait it out. */
  debounceMs?: number;
  signal?: AbortSignal;
}

interface WaitOptions {
  intervalMs: number;
  debounceMs: number;
  capSeconds: number;
  /** The inbox changed while the cycle ran — fs.watch was not armed to see it. */
  inboxChangedDuringCycle?: boolean;
  signal?: AbortSignal;
}

/**
 * The inbox's *.json as one comparable string — the bash's `ls -l | md5`
 * snapshot. fs.watch only exists while waitForInterval runs, so a status file
 * written DURING the 30-40s cycle fires no event; comparing a before/after
 * snapshot across the cycle is how that write still gets its ~5s fast path
 * instead of waiting out the full interval.
 */
function inboxSnapshot(dir: string): string {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => {
        try {
          const st = statSync(join(dir, name));
          return `${name} ${st.size} ${st.mtimeMs}`;
        } catch {
          return name;
        }
      })
      .join('\n');
  } catch {
    // No inbox directory reads the same before and after: never dirty.
    return '';
  }
}

/**
 * The between-cycles wait, watching the status inbox. An agent writing its
 * status file is the one signal that costs nothing to detect — no API, no
 * quota — so a change runs reconcile+render (nothing network) after a short
 * debounce instead of waiting out the interval. fs.watch replaces the bash's
 * 5-second `ls -l | md5` poll: same fast path, no busy loop.
 */
function waitForInterval(io: WatchIo, paths: WatchPaths, opts: WaitOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    let elapsed = false;
    let fastRunning = false;
    let rearm = false;
    let debounce: NodeJS.Timeout | undefined;
    let watcher: FSWatcher | undefined;
    let current: CycleHandle | undefined;

    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (debounce !== undefined) clearTimeout(debounce);
      watcher?.close();
      opts.signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    // A full cycle must not start while a fast-path child holds the board
    // lock; the interval's expiry waits for the fast path to drain first.
    const maybeFinish = (): void => {
      if ((elapsed || opts.signal?.aborted === true) && !fastRunning) finish();
    };
    const onAbort = (): void => {
      current?.killGroup();
      maybeFinish();
    };
    const timer = setTimeout(() => {
      elapsed = true;
      maybeFinish();
    }, opts.intervalMs);
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const runFastPath = async (): Promise<void> => {
      fastRunning = true;
      try {
        // Only sync and render run on this path: nothing network touches it.
        for (const verb of ['reconcile', 'render']) {
          if (opts.signal?.aborted === true) break;
          const handle = io.spawnBoard([verb]);
          current = handle;
          // Bounded like the full cycle: a hung reconcile must not wedge the
          // loop any more than a hung poll may.
          const cap = setTimeout(() => handle.killGroup(), opts.capSeconds * 1000);
          await handle.wait();
          clearTimeout(cap);
        }
      } finally {
        current = undefined;
        fastRunning = false;
        // A status file that changed mid-run still deserves its ~5s; re-arm
        // rather than dropping the event on the floor.
        if (rearm && !elapsed && opts.signal?.aborted !== true) {
          rearm = false;
          armDebounce();
        }
        maybeFinish();
      }
    };
    const armDebounce = (): void => {
      if (debounce !== undefined) clearTimeout(debounce);
      debounce = setTimeout(() => {
        void runFastPath();
      }, opts.debounceMs);
    };

    try {
      watcher = fsWatch(paths.workspacesDir, (_event, filename) => {
        // Only the inbox's *.json matter; a null filename is a change we
        // cannot attribute, so it counts.
        if (typeof filename === 'string' && filename !== '' && !filename.endsWith('.json')) return;
        if (elapsed || opts.signal?.aborted === true) return;
        if (fastRunning) {
          rearm = true;
          return;
        }
        armDebounce();
      });
      // A vanished inbox directory must degrade to a plain sleep, not a crash.
      watcher.on('error', () => {});
    } catch {
      // No inbox yet: the interval alone paces the loop.
    }

    // A write that landed mid-cycle predates the watcher above and fired no
    // event; run its fast path now rather than dropping it on the floor —
    // bash's persistent `seen` snapshot caught exactly this on the wait's
    // first 5s tick.
    if (opts.inboxChangedDuringCycle === true && opts.signal?.aborted !== true) armDebounce();
  });
}

/** cycle → bounded wait → cycle, forever — the caller's signal is the off switch. */
export async function runLoop(io: WatchIo, paths: WatchPaths, opts: LoopOptions): Promise<void> {
  const debounceMs = opts.debounceMs ?? 1000;
  const capSeconds = opts.intervalSeconds * 3;
  // A function, not a bare read: the signal flips underneath us, which the
  // type system's narrowing would otherwise reason away.
  const aborted = (): boolean => opts.signal?.aborted === true;
  while (!aborted()) {
    // Snapshot the inbox around the cycle: only this comparison can see a
    // status file written while the cycle runs, because waitForInterval's
    // fs.watch does not exist yet at that moment.
    const seen = inboxSnapshot(paths.workspacesDir);
    await cycleOnce(io, paths, { capSeconds, signal: opts.signal });
    if (aborted()) break;
    await waitForInterval(io, paths, {
      intervalMs: opts.intervalSeconds * 1000,
      debounceMs,
      capSeconds,
      inboxChangedDuringCycle: inboxSnapshot(paths.workspacesDir) !== seen,
      signal: opts.signal,
    });
  }
}

export interface StartOptions {
  /** --interval override; otherwise watch.interval, then cadence.watchSeconds. */
  interval?: number;
  debounceMs?: number;
  signal?: AbortSignal;
}

/**
 * The foreground `--start`: refuse a second watcher, write the pid and
 * interval files --status reads, print watch.sh's banner, loop until told to
 * stop. Under launchd/systemd this IS the daemon; in a terminal it is ^C-able.
 */
export async function startWatch(io: WatchIo, paths: WatchPaths, opts: StartOptions = {}): Promise<void> {
  const interval = opts.interval ?? resolveInterval(paths, readConfig(loadRoot(io.env)));

  // Checked BEFORE any file is written: watch.sh overwrote watch.interval
  // first, so a refused start still changed the running daemon's --status
  // math. The refusal text itself is load-bearing — the orchestrator skill
  // pattern-matches on it. The pid must be a verified watcher, not merely
  // alive: bash's --start was always human-run, but this loop is supervisor-
  // respawned at boot, where a stale pidfile plus pid reuse would wedge it
  // permanently (see pidIsWatcher).
  const existing = readPid(paths.pidFile);
  if (existing !== undefined && pidIsWatcher(io, existing)) {
    throw new Error(`already watching (pid ${existing}) — stop it first`);
  }

  mkdirSync(paths.boardDir, { recursive: true });
  writeFileSync(paths.intervalFile, String(interval));
  writeFileSync(paths.pidFile, `${io.pid}\n`);

  io.print(`watching every ${interval}s (pid ${io.pid})`);
  io.print(`  log:    ${paths.logFile}`);
  io.print(`  events: ${paths.eventsFile}`);
  io.print(`  board:  ${join(paths.boardDir, 'board.html')}`);

  try {
    await runLoop(io, paths, {
      intervalSeconds: interval,
      debounceMs: opts.debounceMs,
      signal: opts.signal,
    });
  } finally {
    // A clean stop leaves no stale pidfile; a SIGKILLed loop skips this and
    // the pid-alive check covers it.
    try {
      if (readPid(paths.pidFile) === io.pid) rmSync(paths.pidFile, { force: true });
    } catch {
      // the file is the casualty, not the loop
    }
  }
}

// ── status / stop ─────────────────────────────────────────────────────────────

export function statusLines(io: WatchIo, paths: WatchPaths): string[] {
  const interval = resolveInterval(paths, readConfig(loadRoot(io.env)));
  const pid = readPid(paths.pidFile);
  if (pid === undefined || !io.pidAlive(pid)) {
    return ['not watching — start with: board watch --start'];
  }

  const lines: string[] = [];
  let mtimeMs: number | undefined;
  try {
    mtimeMs = statSync(paths.logFile).mtimeMs;
  } catch {
    mtimeMs = undefined;
  }
  if (mtimeMs !== undefined) {
    // A live pid is not a working watcher. Judge it by when it last wrote,
    // not by whether the process exists — that distinction cost twelve hours.
    const age = Math.floor((io.nowMs() - mtimeMs) / 1000);
    if (age > interval * 3) {
      lines.push(
        `STALLED — pid ${pid} is alive but has not written for ${Math.floor(age / 60)}m (interval ${interval}s)`,
      );
      lines.push('  a cycle is probably hung; restart with: board watch --stop && board watch --start');
    } else {
      lines.push(`watching (pid ${pid}, every ${interval}s)`);
    }
    lines.push(`  last cycle: ${new Date(mtimeMs).toISOString().slice(11, 19)}Z`);
  } else {
    lines.push(`watching (pid ${pid}, every ${interval}s) — no log yet`);
  }
  if (existsSync(paths.eventsFile)) {
    lines.push('  recent events:');
    const tail = readFileSync(paths.eventsFile, 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .slice(-6);
    for (const line of tail) lines.push(`    ${line}`);
  }
  return lines;
}

/** launchd labels and unit names need a non-empty key; '' is the legacy layout. */
function serviceKey(projectKey: string): string {
  return projectKey === '' ? 'default' : projectKey;
}

function launchdLabel(projectKey: string): string {
  return `com.superset-board.${serviceKey(projectKey)}`;
}

function launchdPlistPath(io: WatchIo, projectKey: string): string {
  return join(io.homeDir(), 'Library', 'LaunchAgents', `${launchdLabel(projectKey)}.plist`);
}

function systemdUnitName(projectKey: string): string {
  return `superset-board-${serviceKey(projectKey)}.service`;
}

function systemdUnitPath(io: WatchIo, projectKey: string): string {
  return join(io.homeDir(), '.config', 'systemd', 'user', systemdUnitName(projectKey));
}

/** The installed service file for this platform+project, if one exists. */
function installedServicePath(io: WatchIo, projectKey: string): string | undefined {
  if (io.platform === 'darwin') {
    const p = launchdPlistPath(io, projectKey);
    return existsSync(p) ? p : undefined;
  }
  if (io.platform === 'linux') {
    const p = systemdUnitPath(io, projectKey);
    return existsSync(p) ? p : undefined;
  }
  return undefined;
}

/**
 * Kill the --start loop the pidfile names. Refuses an --install'd watcher: its
 * supervisor (KeepAlive / Restart=always) would respawn what --stop killed,
 * which reads as "--stop is broken" at 2am.
 */
export function stopWatch(io: WatchIo, paths: WatchPaths): string {
  const service = installedServicePath(io, paths.projectKey);
  if (service !== undefined) {
    throw new Error(
      `this watcher is installed as a service (${service}) — stopping the process would just respawn it; remove it with: board watch --uninstall`,
    );
  }
  // Verified, not just alive: SIGTERMing a pid that some unrelated process
  // reused after a reboot would be --stop shooting a bystander.
  const pid = readPid(paths.pidFile);
  if (pid !== undefined && pidIsWatcher(io, pid)) {
    io.kill(pid);
    rmSync(paths.pidFile, { force: true });
    rmSync(paths.intervalFile, { force: true });
    return 'stopped';
  }
  rmSync(paths.pidFile, { force: true });
  rmSync(paths.intervalFile, { force: true });
  return 'not running';
}

// ── install / uninstall ───────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface ServiceSpec {
  label: string;
  node: string;
  mainJs: string;
  interval: number;
  logFile: string;
  /** In insertion order; SUPERSET_ORCH_PROJECT first, PATH last. */
  env: Record<string, string>;
}

export function buildLaunchdPlist(spec: ServiceSpec): string {
  const envLines = Object.entries(spec.env)
    .map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${escapeXml(spec.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${escapeXml(spec.node)}</string>`,
    `    <string>${escapeXml(spec.mainJs)}</string>`,
    '    <string>watch</string>',
    '    <string>--start</string>',
    '    <string>--interval</string>',
    `    <string>${spec.interval}</string>`,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    envLines,
    '  </dict>',
    // The loop appends its own cycle blocks; launchd appends the banner and
    // anything a crashing node says to the same file, so nothing is lost.
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(spec.logFile)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(spec.logFile)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function buildSystemdUnit(spec: ServiceSpec): string {
  const quoteArg = (s: string): string =>
    /[\s"\\]/.test(s) ? `"${s.replace(/([\\"])/g, '\\$1')}"` : s;
  const envLines = Object.entries(spec.env)
    .map(([k, v]) => `Environment="${k}=${v.replace(/([\\"])/g, '\\$1')}"`)
    .join('\n');
  return [
    '# Managed by `board watch --install` — remove with `board watch --uninstall`.',
    '[Unit]',
    `Description=Superset board watcher (${spec.label})`,
    '',
    '[Service]',
    `ExecStart=${quoteArg(spec.node)} ${quoteArg(spec.mainJs)} watch --start --interval ${spec.interval}`,
    envLines,
    'Restart=always',
    'RestartSec=5',
    `StandardOutput=append:${spec.logFile}`,
    `StandardError=append:${spec.logFile}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function serviceEnv(io: WatchIo, projectKey: string): Record<string, string> {
  const env: Record<string, string> = { SUPERSET_ORCH_PROJECT: projectKey };
  // A custom root (or a one-off board directory) must survive into the
  // daemon, or it would watch a different board than the one just installed.
  for (const key of ['SUPERSET_ORCH_ROOT', 'SUPERSET_ORCH_DIR'] as const) {
    const value = io.env[key];
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  // launchd starts daemons with a bare PATH: the node that runs the loop and
  // the superset CLI both live outside it, and gh/jq ride the caller's PATH.
  env['PATH'] = [
    dirname(io.execPath),
    join(io.homeDir(), '.superset', 'bin'),
    io.env['PATH'] ?? '/usr/bin:/bin',
  ].join(':');
  return env;
}

export interface InstallOptions {
  interval?: number;
  /** Prepended to every printed line — --all's `[key] ` prefix. */
  printPrefix?: string;
}

export function installWatch(io: WatchIo, paths: WatchPaths, opts: InstallOptions = {}): void {
  const interval = opts.interval ?? resolveInterval(paths, readConfig(loadRoot(io.env)));
  const print = (line: string): void => io.print(`${opts.printPrefix ?? ''}${line}`);

  // A hand-started loop and an installed one would fight over the pidfile and
  // the board lock; same refusal, same words, as a double --start. But when a
  // service is already installed, the running pid is that service's own daemon
  // and the refusal would be a dead end — --stop refuses installed watchers
  // and points back at --uninstall — so the bootout/restart below replaces the
  // daemon instead of colliding with it. The refusal is reserved for a live
  // watcher with NO service file: a hand-started loop.
  const existing = readPid(paths.pidFile);
  if (
    existing !== undefined &&
    installedServicePath(io, paths.projectKey) === undefined &&
    pidIsWatcher(io, existing)
  ) {
    throw new Error(`already watching (pid ${existing}) — stop it first`);
  }

  const spec: ServiceSpec = {
    label: io.platform === 'darwin' ? launchdLabel(paths.projectKey) : serviceKey(paths.projectKey),
    node: io.execPath,
    mainJs: io.mainJs,
    interval,
    logFile: paths.logFile,
    env: serviceEnv(io, paths.projectKey),
  };

  // Written before the service starts, so the daemon's very first --status
  // computes its staleness threshold from the installed cadence.
  mkdirSync(paths.boardDir, { recursive: true });
  writeFileSync(paths.intervalFile, String(interval));

  if (io.platform === 'darwin') {
    const plistPath = launchdPlistPath(io, paths.projectKey);
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, buildLaunchdPlist(spec));
    // Best-effort bootout first: a reinstall replaces the running daemon
    // rather than colliding with it.
    io.exec('launchctl', ['bootout', `gui/${io.uid()}/${spec.label}`]);
    const boot = io.exec('launchctl', ['bootstrap', `gui/${io.uid()}`, plistPath]);
    if (boot.status !== 0) {
      throw new Error(
        `launchctl bootstrap failed (${boot.stderr.trim() || `exit ${boot.status}`}) — the plist is written; load it with: launchctl bootstrap gui/${io.uid()} ${plistPath}`,
      );
    }
    print(`installed ${plistPath}`);
    print(`  runs: ${io.execPath} ${io.mainJs} watch --start --interval ${interval} (KeepAlive, RunAtLoad)`);
    print('  undo: board watch --uninstall');
    return;
  }

  if (io.platform === 'linux') {
    const unitPath = systemdUnitPath(io, paths.projectKey);
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, buildSystemdUnit(spec));
    io.exec('systemctl', ['--user', 'daemon-reload']);
    const enable = io.exec('systemctl', ['--user', 'enable', '--now', systemdUnitName(paths.projectKey)]);
    if (enable.status !== 0) {
      throw new Error(
        `systemctl enable --now failed (${enable.stderr.trim() || `exit ${enable.status}`}) — the unit is written at ${unitPath}`,
      );
    }
    print(`installed ${unitPath}`);
    print(`  runs: ${io.execPath} ${io.mainJs} watch --start --interval ${interval} (Restart=always)`);
    print('  undo: board watch --uninstall');
    return;
  }

  throw new Error(
    `--install knows launchd (darwin) and systemd --user (linux) — on ${io.platform}, run: board watch --start`,
  );
}

export function uninstallWatch(io: WatchIo, paths: WatchPaths): void {
  let removed = false;
  if (io.platform === 'darwin') {
    const plistPath = launchdPlistPath(io, paths.projectKey);
    // Best-effort: "not loaded" is not a failure to uninstall.
    io.exec('launchctl', ['bootout', `gui/${io.uid()}/${launchdLabel(paths.projectKey)}`]);
    if (existsSync(plistPath)) {
      rmSync(plistPath, { force: true });
      io.print(`uninstalled ${plistPath}`);
      removed = true;
    } else {
      io.print(`not installed (${plistPath})`);
    }
  } else if (io.platform === 'linux') {
    const unitPath = systemdUnitPath(io, paths.projectKey);
    io.exec('systemctl', ['--user', 'disable', '--now', systemdUnitName(paths.projectKey)]);
    if (existsSync(unitPath)) {
      rmSync(unitPath, { force: true });
      io.exec('systemctl', ['--user', 'daemon-reload']);
      io.print(`uninstalled ${unitPath}`);
      removed = true;
    } else {
      io.print(`not installed (${unitPath})`);
    }
  } else {
    io.print(`nothing to uninstall — --install never ran on ${io.platform}`);
    return;
  }
  // The bootout/disable killed the loop, so leave no stale files for --status
  // — but ONLY when a service actually existed. With nothing installed, the
  // pidfile may belong to a live hand-started --start loop, and deleting it
  // would orphan that loop: --status blind, --start doubling it, --stop with
  // no pid left to kill.
  if (removed) {
    rmSync(paths.pidFile, { force: true });
    rmSync(paths.intervalFile, { force: true });
  }
}

// ── --install --all ───────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** jq's `ascii_downcase | gsub("[^a-z0-9]+"; "-")` — ASCII letters only. */
function keySlug(name: string): string {
  return name.replace(/[A-Z]/g, (c) => c.toLowerCase()).replace(/[^a-z0-9]+/g, '-');
}

/** watch.sh's `.repos[]? | .key // (.name|ascii_downcase|gsub(...))`. */
export function configuredKeys(config: BoardConfigFile): string[] {
  const repos = Array.isArray(config.repos) ? config.repos : [];
  const keys: string[] = [];
  for (const repo of repos) {
    if (!isObj(repo)) continue;
    const key = (repo as Obj)['key'];
    if (key !== undefined && key !== null && key !== false) {
      keys.push(typeof key === 'string' ? key : JSON.stringify(key) ?? 'null');
      continue;
    }
    const name = (repo as Obj)['name'];
    // A repo with neither key nor name killed the shell's whole jq listing;
    // skipping just that row is the recoverable reading of the same verdict.
    if (typeof name === 'string') keys.push(keySlug(name));
  }
  return keys;
}

/** One supervised watcher per configured project — the failure isolation. */
export function installAll(io: WatchIo, interval?: number): void {
  const orch = loadRoot(io.env);
  const config = readConfig(orch);
  // SUPERSET_ORCH_DIR names ONE board directory; carrying it into every
  // project's service would point them all at the same board.
  const env = { ...io.env };
  delete env['SUPERSET_ORCH_DIR'];
  const scoped: WatchIo = { ...io, env };
  for (const key of configuredKeys(config)) {
    const paths = watchPaths(join(orch.root, 'p', key), key, orch.workspacesDir);
    installWatch(scoped, paths, { interval, printPrefix: `[${key}] ` });
  }
}

// ── argv surface ──────────────────────────────────────────────────────────────

const USAGE =
  'usage: board watch --start [--interval N] | --stop | --status | --once | --install [--interval N] [--all] | --uninstall';

function die(message: string): never {
  process.stderr.write(`BLOCKED: ${message}\n`);
  process.exit(1);
}

/** `board watch ...` — no argument means --status, exactly as watch.sh read $1. */
export async function runWatch(argv: string[], io: WatchIo = realWatchIo()): Promise<void> {
  const mode = argv[0] ?? '--status';
  let interval: number | undefined;
  let all = false;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--interval' && argv[i + 1] !== undefined) {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0) die(`--interval wants a positive number of seconds, got ${argv[i + 1]}`);
      interval = n;
      i += 1;
    } else if (arg === '--all') {
      all = true;
    } else {
      die(USAGE);
    }
  }

  try {
    switch (mode) {
      case '--once': {
        const paths = resolveWatchPaths(io);
        await cycleOnce(io, paths);
        io.print(`one cycle done — see ${paths.eventsFile}`);
        break;
      }
      case '--start': {
        if (all) {
          // The foreground redesign runs ONE loop per process on purpose — a
          // project whose cycle hangs must not stop any other project from
          // polling. The many-projects answer is one service apiece.
          throw new Error(
            '--start runs one foreground watcher — for every configured project use: board watch --install --all',
          );
        }
        const paths = resolveWatchPaths(io);
        const ac = new AbortController();
        const stop = (): void => ac.abort();
        process.once('SIGTERM', stop);
        process.once('SIGINT', stop);
        await startWatch(io, paths, { interval, signal: ac.signal });
        break;
      }
      case '--stop':
        io.print(stopWatch(io, resolveWatchPaths(io)));
        break;
      case '--status':
        for (const line of statusLines(io, resolveWatchPaths(io))) io.print(line);
        break;
      case '--install':
        if (all) installAll(io, interval);
        else installWatch(io, resolveWatchPaths(io), { interval });
        break;
      case '--uninstall':
        uninstallWatch(io, resolveWatchPaths(io));
        break;
      default:
        die(USAGE);
    }
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
}
