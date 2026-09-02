// board watch, with every process spawn and service manager stubbed: no real
// cycle, no launchctl/systemctl, no signal to any real pid. Real temp
// directories carry the files (pid, interval, logs, the inbox the fast path
// watches) because the mtime/staleness and fs.watch behaviour ARE the thing
// under test.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  buildLaunchdPlist,
  buildSystemdUnit,
  cycleOnce,
  extractEvents,
  installAll,
  installWatch,
  runLoop,
  startWatch,
  statusLines,
  stopWatch,
  uninstallWatch,
  watchPaths,
} from '../src/watch.js';
import type { CycleHandle, WatchIo, WatchPaths } from '../src/watch.js';

const STAMP = '2026-09-02T10:00:00Z';

// The poll summary headers watch's extraction anchors on, verbatim from poll.ts.
const HEADER_PRS =
  '── PRs ──────────────────────────────────────────────────────────────';
const HEADER_AGENTS =
  '── Agents ───────────────────────────────────────────────────────────';
const HEADER_NO_STATUS =
  '── Workspaces without a status file ─────────────────────────────────';
const HEADER_DELTAS =
  '── Deltas since last poll ───────────────────────────────────────────';

// ── Temp layout ───────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-watch-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

interface Layout {
  home: string;
  orchRoot: string;
  boardDir: string;
  workspacesDir: string;
  paths: WatchPaths;
}

function layout(): Layout {
  const base = tempDir();
  const home = join(base, 'home');
  const orchRoot = join(base, 'orch');
  const boardDir = join(orchRoot, 'p', 'proj');
  const workspacesDir = join(orchRoot, 'workspaces');
  mkdirSync(home, { recursive: true });
  mkdirSync(boardDir, { recursive: true });
  mkdirSync(workspacesDir, { recursive: true });
  return { home, orchRoot, boardDir, workspacesDir, paths: watchPaths(boardDir, 'proj', workspacesDir) };
}

// ── io stub ───────────────────────────────────────────────────────────────────

function instantHandle(stdout: string, stderr = ''): CycleHandle {
  return { wait: () => Promise.resolve({ stdout, stderr }), killGroup: () => {} };
}

interface StubOptions {
  home: string;
  orchRoot: string;
  platform?: string;
  alive?: Set<number>;
  spawn?: (argv: string[]) => CycleHandle;
  nowMs?: () => number;
  env?: NodeJS.ProcessEnv;
  /** What `ps -o command=` reports for any live pid — the watcher-verify probe. */
  psCommand?: string;
}

/** A pidfile pid that really is a board watcher, as ps would report it. */
const WATCHER_PS = '/stub/node /stub/dist/main.js watch --start --interval 120';

interface Stub {
  io: WatchIo;
  spawns: string[][];
  execs: { cmd: string; args: string[] }[];
  prints: string[];
  killedPids: number[];
}

function stubIo(opts: StubOptions): Stub {
  const spawns: string[][] = [];
  const execs: { cmd: string; args: string[] }[] = [];
  const prints: string[] = [];
  const killedPids: number[] = [];
  const io: WatchIo = {
    spawnBoard(argv: string[]): CycleHandle {
      spawns.push(argv);
      return (opts.spawn ?? (() => instantHandle('')))(argv);
    },
    exec(cmd: string, args: string[]) {
      execs.push({ cmd, args });
      if (cmd === 'ps') return { status: 0, stdout: `${opts.psCommand ?? ''}\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
    pidAlive: (pid: number) => opts.alive?.has(pid) ?? false,
    kill: (pid: number) => {
      killedPids.push(pid);
    },
    now: () => STAMP,
    nowMs: opts.nowMs ?? (() => Date.now()),
    homeDir: () => opts.home,
    uid: () => 501,
    platform: opts.platform ?? 'darwin',
    // An isolated root keeps the tests away from any real ~/.claude config.
    env: opts.env ?? { SUPERSET_ORCH_ROOT: opts.orchRoot },
    execPath: '/stub/node',
    mainJs: '/stub/dist/main.js',
    pid: 4242,
    print: (line: string) => prints.push(line),
  };
  return { io, spawns, execs, prints, killedPids };
}

async function until(cond: () => boolean, ms: number): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ── events extraction ─────────────────────────────────────────────────────────

const CYCLE_STDOUT =
  [
    '  fix-login: agent → review (#12)',
    '  pruned orphan status file abcd1234',
    HEADER_PRS,
    '  acme/app#12 Fix login',
    '      review=none ci=green asks=0 merge=CLEAN last=2026-09-02T09:00:00Z',
    HEADER_AGENTS,
    '  fix-login state=working session=live dirty=0 unpushed=0 ',
    '  slow-one state=blocked session=live dirty=2 unpushed=1 NEEDS-OPERATOR blocked=waiting on the operator ',
    HEADER_NO_STATUS,
    '  mystery [branch-x] deadbeef-0000',
    HEADER_DELTAS,
    '  acme/app#12: review -→APPROVED ci green→green threads 0→0',
    '  ★ READY TO MERGE  acme/app#12 Fix login — approved, green, no conflicts',
    '  MERGED acme/app#9 Old thing at 2026-09-01T00:00:00Z',
    'auto-reaped item-9 (old-thing) — PR #9 merged',
    'unblocked: item-11',
    'archived 1 item(s) to /tmp/b/archive.json',
    'wrote /tmp/b/board.html and board.md (3 cards, 1 terminal and hidden)',
  ].join('\n') + '\n';

const CYCLE_STDERR =
  [
    '  stray: old-thing is closed but workspace deadbeef is still alive — reap.sh --item item-9, or --abandon if it was cancelled',
    '  drift: fix-login expects branch-a but its workspace is on branch-b',
    'skipped item-13 (meh): BLOCKED: workspace dirty',
    'warn: workspaces/bad.json is not valid JSON — skipped',
  ].join('\n') + '\n';

const EXPECTED_EVENTS = [
  `${STAMP}    acme/app#12: review -→APPROVED ci green→green threads 0→0`,
  `${STAMP}    MERGED acme/app#9 Old thing at 2026-09-01T00:00:00Z`,
  `${STAMP}  needs-operator:  slow-one state=blocked session=live dirty=2 unpushed=1 NEEDS-OPERATOR blocked=waiting on the operator `,
  `${STAMP}    fix-login: agent → review (#12)`,
  `${STAMP}    pruned orphan status file abcd1234`,
  `${STAMP}  auto-reaped item-9 (old-thing) — PR #9 merged`,
  `${STAMP}  unblocked: item-11`,
  `${STAMP}  archived 1 item(s) to /tmp/b/archive.json`,
  `${STAMP}  skipped item-13 (meh): BLOCKED: workspace dirty`,
];

describe('events extraction', () => {
  test('ports the four sed/grep selections over one cycle output', () => {
    expect(extractEvents(STAMP, CYCLE_STDOUT, CYCLE_STDERR)).toEqual(EXPECTED_EVENTS);
  });

  test('the ★ banner, standing stray/drift and warn lines never reach events.log', () => {
    const events = extractEvents(STAMP, CYCLE_STDOUT, CYCLE_STDERR).join('\n');
    expect(events).not.toContain('READY TO MERGE');
    expect(events).not.toContain('stray:');
    expect(events).not.toContain('drift:');
    expect(events).not.toContain('warn:');
    // The no-status section is informational, not a delta.
    expect(events).not.toContain('mystery');
  });

  test('a cycle with no poll summary extracts nothing from column-0 output', () => {
    const events = extractEvents(STAMP, 'wrote /x/board.html and board.md (0 cards, 0 terminal and hidden)\n', '');
    expect(events).toEqual([]);
  });
});

describe('cycleOnce', () => {
  test('writes the cycle marker to watch.log and the extraction to events.log', async () => {
    const l = layout();
    const stub = stubIo({
      home: l.home,
      orchRoot: l.orchRoot,
      spawn: () => instantHandle(CYCLE_STDOUT, CYCLE_STDERR),
    });
    await cycleOnce(stub.io, l.paths);
    expect(stub.spawns).toEqual([['cycle']]);

    const log = readFileSync(l.paths.logFile, 'utf8');
    expect(log.startsWith(`\n──── ${STAMP} ────\n`)).toBe(true);
    expect(log).toContain('  fix-login: agent → review (#12)');
    expect(log).toContain('  stray: old-thing'); // standing conditions stay in watch.log
    expect(log).not.toContain('cycle killed');

    const events = readFileSync(l.paths.eventsFile, 'utf8');
    expect(events).toBe(EXPECTED_EVENTS.join('\n') + '\n');
  });
});

// ── the supervised loop ───────────────────────────────────────────────────────

describe('the loop', () => {
  test('a hung cycle is killed at 3× the interval and noted in watch.log', async () => {
    const l = layout();
    let killGroups = 0;
    let cycles = 0;
    let release!: (v: { stdout: string; stderr: string }) => void;
    const hang = new Promise<{ stdout: string; stderr: string }>((r) => {
      release = r;
    });
    const stub = stubIo({
      home: l.home,
      orchRoot: l.orchRoot,
      spawn: (argv) => {
        if (argv[0] === 'cycle' && cycles++ === 0) {
          return {
            wait: () => hang,
            killGroup: () => {
              killGroups += 1;
              release({ stdout: 'partial output\n', stderr: '' });
            },
          };
        }
        return instantHandle('');
      },
    });
    const ac = new AbortController();
    const loop = runLoop(stub.io, l.paths, { intervalSeconds: 0.05, signal: ac.signal });
    await until(() => killGroups === 1, 3000);
    ac.abort();
    await loop;

    expect(killGroups).toBe(1);
    const log = readFileSync(l.paths.logFile, 'utf8');
    expect(log).toContain('partial output');
    expect(log).toContain('cycle killed after');
  });

  test('two quick status-file writes debounce into ONE reconcile+render fast path', async () => {
    const l = layout();
    const stub = stubIo({ home: l.home, orchRoot: l.orchRoot });
    const ac = new AbortController();
    const loop = runLoop(stub.io, l.paths, {
      intervalSeconds: 30, // far beyond the test: only the fast path can spawn
      debounceMs: 200,
      signal: ac.signal,
    });
    // The first cycle has finished once its block lands in watch.log; the
    // inbox watcher is armed synchronously right after.
    await until(() => existsSync(l.paths.logFile), 3000);
    await new Promise((r) => setTimeout(r, 100));

    writeFileSync(join(l.workspacesDir, 'a.json'), '{}');
    writeFileSync(join(l.workspacesDir, 'b.json'), '{}');
    await until(() => stub.spawns.some((s) => s[0] === 'render'), 3000);
    // Any second (undebounced) fast path would fire within this window.
    await new Promise((r) => setTimeout(r, 400));
    ac.abort();
    await loop;

    expect(stub.spawns).toEqual([['cycle'], ['reconcile'], ['render']]);
  });

  test('refuses a double --start while the pidfile holder is alive', async () => {
    const l = layout();
    writeFileSync(l.paths.pidFile, '999\n');
    const stub = stubIo({
      home: l.home,
      orchRoot: l.orchRoot,
      alive: new Set([999]),
      psCommand: WATCHER_PS,
    });
    const ac = new AbortController();
    ac.abort();
    await expect(startWatch(stub.io, l.paths, { signal: ac.signal })).rejects.toThrow(
      'already watching (pid 999) — stop it first',
    );
    // The refusal must not have touched the running daemon's interval file.
    expect(existsSync(l.paths.intervalFile)).toBe(false);
  });

  test('a stale pidfile whose pid was REUSED by an unrelated process is reclaimed', async () => {
    // The KeepAlive wedge: SIGKILL/power loss leaves the pidfile, reboot hands
    // the number to some root daemon (pidAlive counts EPERM), and a refusal
    // here would respawn into itself forever.
    const l = layout();
    writeFileSync(l.paths.pidFile, '999\n');
    const stub = stubIo({
      home: l.home,
      orchRoot: l.orchRoot,
      alive: new Set([999]),
      psCommand: '/usr/libexec/somethingd',
    });
    const ac = new AbortController();
    ac.abort(); // reclaim, then exit before the first cycle
    await startWatch(stub.io, l.paths, { signal: ac.signal });
    expect(stub.prints[0]).toBe('watching every 120s (pid 4242)');
  });

  test('a status write landing DURING the cycle still gets the fast path', async () => {
    const l = layout();
    let cycles = 0;
    const stub = stubIo({
      home: l.home,
      orchRoot: l.orchRoot,
      spawn: (argv) => {
        if (argv[0] === 'cycle' && cycles++ === 0) {
          return {
            wait: () => {
              // The agent writes its status mid-cycle: before waitForInterval's
              // fs.watch exists, so only the snapshot comparison can see it.
              writeFileSync(join(l.workspacesDir, 'mid.json'), '{"state":"working"}');
              return Promise.resolve({ stdout: '', stderr: '' });
            },
            killGroup: () => {},
          };
        }
        return instantHandle('');
      },
    });
    const ac = new AbortController();
    const loop = runLoop(stub.io, l.paths, {
      intervalSeconds: 30, // far beyond the test: only the fast path can spawn
      debounceMs: 50,
      signal: ac.signal,
    });
    await until(() => stub.spawns.some((s) => s[0] === 'render'), 3000);
    ac.abort();
    await loop;
    expect(stub.spawns).toEqual([['cycle'], ['reconcile'], ['render']]);
  });

  test('--start prints the banner, writes pid+interval, and cleans its pid up', async () => {
    const l = layout();
    const stub = stubIo({ home: l.home, orchRoot: l.orchRoot });
    const ac = new AbortController();
    ac.abort(); // loop exits before its first cycle
    await startWatch(stub.io, l.paths, { signal: ac.signal });
    expect(stub.prints[0]).toBe('watching every 120s (pid 4242)');
    expect(stub.prints[1]).toBe(`  log:    ${l.paths.logFile}`);
    expect(stub.prints[2]).toBe(`  events: ${l.paths.eventsFile}`);
    expect(stub.prints[3]).toBe(`  board:  ${join(l.boardDir, 'board.html')}`);
    expect(readFileSync(l.paths.intervalFile, 'utf8')).toBe('120');
    // A clean stop leaves no stale pidfile behind.
    expect(existsSync(l.paths.pidFile)).toBe(false);
  });
});

// ── status ────────────────────────────────────────────────────────────────────

describe('--status', () => {
  test('judges a live pid by its last WRITE: stale log means STALLED', () => {
    const l = layout();
    writeFileSync(l.paths.pidFile, '4242\n');
    writeFileSync(l.paths.intervalFile, '120');
    writeFileSync(l.paths.logFile, 'old\n');
    const past = Math.floor(Date.now() / 1000) - 4000;
    utimesSync(l.paths.logFile, past, past);
    const mtimeMs = statSync(l.paths.logFile).mtimeMs;
    const stub = stubIo({
      home: l.home,
      orchRoot: l.orchRoot,
      alive: new Set([4242]),
      nowMs: () => mtimeMs + 400_000, // 400s of silence > 3×120s
    });
    const lines = statusLines(stub.io, l.paths);
    expect(lines[0]).toBe('STALLED — pid 4242 is alive but has not written for 6m (interval 120s)');
    expect(lines[1]).toBe('  a cycle is probably hung; restart with: board watch --stop && board watch --start');
    expect(lines[2]).toMatch(/^ {2}last cycle: \d\d:\d\d:\d\dZ$/);
  });

  test('a fresh write is watching, with the last-cycle stamp', () => {
    const l = layout();
    writeFileSync(l.paths.pidFile, '4242\n');
    writeFileSync(l.paths.intervalFile, '120');
    writeFileSync(l.paths.logFile, 'fresh\n');
    const stub = stubIo({ home: l.home, orchRoot: l.orchRoot, alive: new Set([4242]) });
    const lines = statusLines(stub.io, l.paths);
    expect(lines[0]).toBe('watching (pid 4242, every 120s)');
    expect(lines[1]).toMatch(/^ {2}last cycle: \d\d:\d\d:\d\dZ$/);
  });

  test('a live pid with no log yet says so instead of inventing a verdict', () => {
    const l = layout();
    writeFileSync(l.paths.pidFile, '4242\n');
    writeFileSync(l.paths.intervalFile, '120');
    const stub = stubIo({ home: l.home, orchRoot: l.orchRoot, alive: new Set([4242]) });
    expect(statusLines(stub.io, l.paths)[0]).toBe('watching (pid 4242, every 120s) — no log yet');
  });

  test('a dead pid is not watching, whatever the pidfile says', () => {
    const l = layout();
    writeFileSync(l.paths.pidFile, '999\n');
    const stub = stubIo({ home: l.home, orchRoot: l.orchRoot });
    expect(statusLines(stub.io, l.paths)).toEqual(['not watching — start with: board watch --start']);
  });

  test('tails the last six events, indented', () => {
    const l = layout();
    writeFileSync(l.paths.pidFile, '4242\n');
    writeFileSync(l.paths.intervalFile, '120');
    writeFileSync(l.paths.logFile, 'fresh\n');
    writeFileSync(l.paths.eventsFile, ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8'].join('\n') + '\n');
    const stub = stubIo({ home: l.home, orchRoot: l.orchRoot, alive: new Set([4242]) });
    const lines = statusLines(stub.io, l.paths);
    const at = lines.indexOf('  recent events:');
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1)).toEqual(['    e3', '    e4', '    e5', '    e6', '    e7', '    e8']);
  });
});

// ── stop vs uninstall ─────────────────────────────────────────────────────────

describe('--stop', () => {
  test('kills the pidfile holder and removes the state files', () => {
    const l = layout();
    writeFileSync(l.paths.pidFile, '4321\n');
    writeFileSync(l.paths.intervalFile, '120');
    const stub = stubIo({
      home: l.home,
      orchRoot: l.orchRoot,
      alive: new Set([4321]),
      psCommand: WATCHER_PS,
    });
    expect(stopWatch(stub.io, l.paths)).toBe('stopped');
    expect(stub.killedPids).toEqual([4321]);
    expect(existsSync(l.paths.pidFile)).toBe(false);
    expect(existsSync(l.paths.intervalFile)).toBe(false);
  });

  test('with nothing running it just tidies up', () => {
    const l = layout();
    const stub = stubIo({ home: l.home, orchRoot: l.orchRoot });
    expect(stopWatch(stub.io, l.paths)).toBe('not running');
  });

  test('never SIGTERMs a pid an unrelated process reused — that is a bystander', () => {
    const l = layout();
    writeFileSync(l.paths.pidFile, '4321\n');
    const stub = stubIo({
      home: l.home,
      orchRoot: l.orchRoot,
      alive: new Set([4321]),
      psCommand: '/usr/libexec/somethingd',
    });
    expect(stopWatch(stub.io, l.paths)).toBe('not running');
    expect(stub.killedPids).toEqual([]);
    expect(existsSync(l.paths.pidFile)).toBe(false);
  });

  test('refuses to stop an installed watcher — the supervisor would respawn it', () => {
    const l = layout();
    const plist = join(l.home, 'Library', 'LaunchAgents', 'com.superset-board.proj.plist');
    mkdirSync(join(l.home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(plist, 'placeholder');
    writeFileSync(l.paths.pidFile, '4321\n');
    const stub = stubIo({ home: l.home, orchRoot: l.orchRoot, alive: new Set([4321]) });
    expect(() => stopWatch(stub.io, l.paths)).toThrow(/board watch --uninstall/);
    expect(stub.killedPids).toEqual([]);
  });

  test('the systemd unit triggers the same guidance on linux', () => {
    const l = layout();
    const unit = join(l.home, '.config', 'systemd', 'user', 'superset-board-proj.service');
    mkdirSync(join(l.home, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(unit, 'placeholder');
    const stub = stubIo({ home: l.home, orchRoot: l.orchRoot, platform: 'linux' });
    expect(() => stopWatch(stub.io, l.paths)).toThrow(/board watch --uninstall/);
  });
});

// ── install / uninstall ───────────────────────────────────────────────────────

function expectedPlist(l: Layout): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>com.superset-board.proj</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/stub/node</string>',
    '    <string>/stub/dist/main.js</string>',
    '    <string>watch</string>',
    '    <string>--start</string>',
    '    <string>--interval</string>',
    '    <string>90</string>',
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>SUPERSET_ORCH_PROJECT</key>',
    '    <string>proj</string>',
    '    <key>SUPERSET_ORCH_ROOT</key>',
    `    <string>${l.orchRoot}</string>`,
    '    <key>PATH</key>',
    `    <string>/stub:${l.home}/.superset/bin:/usr/bin:/bin</string>`,
    '  </dict>',
    '  <key>StandardOutPath</key>',
    `  <string>${l.paths.logFile}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${l.paths.logFile}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function expectedUnit(l: Layout): string {
  return [
    '# Managed by `board watch --install` — remove with `board watch --uninstall`.',
    '[Unit]',
    'Description=Superset board watcher (proj)',
    '',
    '[Service]',
    'ExecStart=/stub/node /stub/dist/main.js watch --start --interval 90',
    'Environment="SUPERSET_ORCH_PROJECT=proj"',
    `Environment="SUPERSET_ORCH_ROOT=${l.orchRoot}"`,
    `Environment="PATH=/stub:${l.home}/.superset/bin:/usr/bin:/bin"`,
    'Restart=always',
    'RestartSec=5',
    `StandardOutput=append:${l.paths.logFile}`,
    `StandardError=append:${l.paths.logFile}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

describe('--install', () => {
  test('darwin: writes the LaunchAgent plist verbatim and bootstraps it', () => {
    const l = layout();
    const stub = stubIo({ home: l.home, orchRoot: l.orchRoot });
    installWatch(stub.io, l.paths, { interval: 90 });

    const plistPath = join(l.home, 'Library', 'LaunchAgents', 'com.superset-board.proj.plist');
    expect(readFileSync(plistPath, 'utf8')).toBe(expectedPlist(l));
    expect(stub.execs).toEqual([
      { cmd: 'launchctl', args: ['bootout', 'gui/501/com.superset-board.proj'] },
      { cmd: 'launchctl', args: ['bootstrap', 'gui/501', plistPath] },
    ]);
    // --status must compute staleness from the installed cadence immediately.
    expect(readFileSync(l.paths.intervalFile, 'utf8')).toBe('90');
    expect(stub.prints[0]).toBe(`installed ${plistPath}`);
    expect(stub.prints.at(-1)).toBe('  undo: board watch --uninstall');
  });

  test('linux: writes the systemd user unit verbatim and enables it', () => {
    const l = layout();
    const stub = stubIo({ home: l.home, orchRoot: l.orchRoot, platform: 'linux' });
    installWatch(stub.io, l.paths, { interval: 90 });

    const unitPath = join(l.home, '.config', 'systemd', 'user', 'superset-board-proj.service');
    expect(readFileSync(unitPath, 'utf8')).toBe(expectedUnit(l));
    expect(stub.execs).toEqual([
      { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
      { cmd: 'systemctl', args: ['--user', 'enable', '--now', 'superset-board-proj.service'] },
    ]);
    expect(stub.prints.at(-1)).toBe('  undo: board watch --uninstall');
  });

  test('refuses while a hand-started watcher holds the pidfile', () => {
    const l = layout();
    writeFileSync(l.paths.pidFile, '999\n');
    const stub = stubIo({
      home: l.home,
      orchRoot: l.orchRoot,
      alive: new Set([999]),
      psCommand: WATCHER_PS,
    });
    expect(() => installWatch(stub.io, l.paths, { interval: 90 })).toThrow(
      'already watching (pid 999) — stop it first',
    );
  });

  test('reinstalling over a RUNNING installed service replaces it instead of refusing', () => {
    // The old dead end: --install said "stop it first", --stop said
    // "--uninstall" — no path changed a healthy daemon's cadence.
    const l = layout();
    const plistPath = join(l.home, 'Library', 'LaunchAgents', 'com.superset-board.proj.plist');
    mkdirSync(join(l.home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(plistPath, 'placeholder');
    writeFileSync(l.paths.pidFile, '999\n');
    const stub = stubIo({
      home: l.home,
      orchRoot: l.orchRoot,
      alive: new Set([999]),
      psCommand: WATCHER_PS,
    });
    installWatch(stub.io, l.paths, { interval: 90 });
    expect(stub.execs).toEqual([
      { cmd: 'launchctl', args: ['bootout', 'gui/501/com.superset-board.proj'] },
      { cmd: 'launchctl', args: ['bootstrap', 'gui/501', plistPath] },
    ]);
    expect(readFileSync(l.paths.intervalFile, 'utf8')).toBe('90');
  });

  test('--all installs one service per configured project', () => {
    const l = layout();
    writeFileSync(
      join(l.orchRoot, 'config.json'),
      JSON.stringify({ repos: [{ key: 'alpha' }, { name: 'Beta Proj' }] }),
    );
    const stub = stubIo({ home: l.home, orchRoot: l.orchRoot });
    installAll(stub.io, 90);
    const agents = join(l.home, 'Library', 'LaunchAgents');
    expect(existsSync(join(agents, 'com.superset-board.alpha.plist'))).toBe(true);
    expect(existsSync(join(agents, 'com.superset-board.beta-proj.plist'))).toBe(true);
    expect(stub.prints.some((p) => p.startsWith('[alpha] installed '))).toBe(true);
    expect(stub.prints.some((p) => p.startsWith('[beta-proj] installed '))).toBe(true);
  });
});

describe('--uninstall', () => {
  test('darwin: boots the agent out and removes the plist and state files', () => {
    const l = layout();
    const plistPath = join(l.home, 'Library', 'LaunchAgents', 'com.superset-board.proj.plist');
    mkdirSync(join(l.home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(plistPath, 'placeholder');
    writeFileSync(l.paths.pidFile, '4242\n');
    writeFileSync(l.paths.intervalFile, '120');
    const stub = stubIo({ home: l.home, orchRoot: l.orchRoot });
    uninstallWatch(stub.io, l.paths);
    expect(stub.execs).toEqual([
      { cmd: 'launchctl', args: ['bootout', 'gui/501/com.superset-board.proj'] },
    ]);
    expect(existsSync(plistPath)).toBe(false);
    expect(existsSync(l.paths.pidFile)).toBe(false);
    expect(existsSync(l.paths.intervalFile)).toBe(false);
    expect(stub.prints).toEqual([`uninstalled ${plistPath}`]);
  });

  test('uninstalling what was never installed says so', () => {
    const l = layout();
    const stub = stubIo({ home: l.home, orchRoot: l.orchRoot });
    uninstallWatch(stub.io, l.paths);
    expect(stub.prints[0]).toMatch(/^not installed /);
  });

  test('a not-installed uninstall leaves a hand-started watcher its pidfile', () => {
    // Deleting it would orphan the live loop: --status blind, --start doubling
    // it, --stop with no pid left to kill.
    const l = layout();
    writeFileSync(l.paths.pidFile, '999\n');
    writeFileSync(l.paths.intervalFile, '60');
    const stub = stubIo({ home: l.home, orchRoot: l.orchRoot, alive: new Set([999]) });
    uninstallWatch(stub.io, l.paths);
    expect(stub.prints[0]).toMatch(/^not installed /);
    expect(existsSync(l.paths.pidFile)).toBe(true);
    expect(existsSync(l.paths.intervalFile)).toBe(true);
  });
});

// ── service content builders ──────────────────────────────────────────────────

describe('service specs', () => {
  test('plist XML-escapes paths', () => {
    const plist = buildLaunchdPlist({
      label: 'com.superset-board.x',
      node: '/opt/a&b/node',
      mainJs: '/opt/a&b/main.js',
      interval: 60,
      logFile: '/logs/<x>/watch.log',
      env: { PATH: '/bin' },
    });
    expect(plist).toContain('<string>/opt/a&amp;b/node</string>');
    expect(plist).toContain('<string>/logs/&lt;x&gt;/watch.log</string>');
  });

  test('unit quotes ExecStart arguments carrying spaces', () => {
    const unit = buildSystemdUnit({
      label: 'x',
      node: '/opt/my node/bin/node',
      mainJs: '/srv/main.js',
      interval: 60,
      logFile: '/logs/watch.log',
      env: { PATH: '/bin' },
    });
    expect(unit).toContain('ExecStart="/opt/my node/bin/node" /srv/main.js watch --start --interval 60');
  });
});
