// `board cloud` — Claude Code on the web, ported whole from
// skills/superset-orchestrator/scripts/cloud.sh: start a session for a brief
// (`fire`), steer one that is already running (`send`), report whether cloud
// dispatch is usable (`check`), and finish setup (`enable`).
//
// WHY AN HTTP CALL AND NOT `claude --cloud`
//
// `claude --cloud "task"` creates a session interactively and cannot be
// scripted (verified against Claude Code 2.1.234: "--cloud cannot be combined
// with --print"). The routine `/fire` endpoint is the supported programmatic
// entry point; it returns the new session's id and URL and does not wait for
// the run. Sending a follow-up to an EXISTING session does work through the
// CLI, and that is the one place this module shells out to `claude`.
//
// The bearer token lives in the environment, never in config.json — that file
// is read by agents, copied into briefs, and shipped as an example in this
// repository. Nothing here may put the token in config, in the log, or in any
// printed line; only its VARIABLE NAME is ever shown.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { cfg, loadRoot, machineConfigPath, readConfig } from '../config.js';
import { appendLog, nowIso } from '../store.js';
import type {
  BoardConfigFile,
  CloudFetchInit,
  CloudIo,
  ExecOptions,
  ExecResult,
  OrchRoot,
} from '../types.js';
import { resolveBoardDir } from './item.js';

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** jq's `//`: null AND false fall through; "" and 0 are kept. */
function jqAlt(value: unknown): unknown {
  return value === undefined || value === null || value === false ? undefined : value;
}

/** jq -r of a scalar: strings as-is, everything else its JSON. */
function interp(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? 'null';
}

/**
 * The dated beta header the endpoint ships under. Breaking changes ship behind
 * a new date and the two previous versions keep working, so pinning it here
 * means an upgrade is a visible edit rather than a surprise.
 */
export const CLOUD_BETA = 'experimental-cc-routine-2026-04-01';

/** The endpoint's cap on `text`, in bytes (the shell measured with `wc -c`). */
export const FIRE_TEXT_CAP = 65536;

/**
 * cloud.sh's autonomy epilogue, verbatim. The text arrives inside a
 * <routine-fire-payload> block that labels it untrusted, so THE ROUTINE'S
 * SAVED PROMPT MUST OPT IN to acting on it (reference/cloud-sessions.md);
 * without that one-time setup the session treats all of this as inert context
 * and does nothing.
 */
export const FIRE_EPILOGUE = `Carry out the brief above.

Work autonomously to completion. Do not stop to ask for approval: no operator is
attached to this session, so a question asked here waits until somebody opens a
browser. Make the judgement calls the brief leaves open and record them in the PR
body.

When the work is done, push the branch and open a pull request as a DRAFT. That
is how this workflow signals "ready for a human", and it is the only gate a
cloud session has — there is no status file to park at. Follow the
superset-implementer skill for the PR body, the quality bar, and the branch
conventions.`;

// ── The default IO ────────────────────────────────────────────────────────────

/** Everything the cloud ops touch outside the process, live. Tests stub it. */
export function realCloudIo(): CloudIo {
  return {
    exec(cmd: string, args: string[], options?: ExecOptions): ExecResult {
      const result = spawnSync(cmd, args, {
        encoding: 'utf8',
        env: options?.env ?? process.env,
        // cloud.sh ran `claude … </dev/null` — queue-and-exit, never a child
        // waiting on a terminal that is not there.
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      });
      if (result.error !== undefined) {
        return { status: 127, stdout: '', stderr: String(result.error) };
      }
      return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    },
    async fetch(url: string, init: CloudFetchInit) {
      const response = await globalThis.fetch(url, init);
      return { status: response.status, body: await response.text() };
    },
    now: nowIso,
    nowMs: () => Date.now(),
    homeDir: () => homedir(),
    env: process.env,
    warn: (message: string) => process.stderr.write(`warn: ${message}\n`),
  };
}

// ── Readiness ─────────────────────────────────────────────────────────────────

/** The pieces cloud.sh read from config at the top of every run. */
export function cloudConfig(config: BoardConfigFile): { fireUrl: string; tokenEnv: string } {
  return {
    fireUrl: interp(cfg<unknown>(config, '.cloud.fireUrl', '')),
    tokenEnv: interp(cfg<unknown>(config, '.cloud.tokenEnv', 'SUPERSET_CLOUD_TOKEN')),
  };
}

/** `${!token_env-}` — the indirect env read. The token never goes further. */
function cloudToken(config: BoardConfigFile, io: CloudIo): string {
  return io.env[cloudConfig(config).tokenEnv] ?? '';
}

/**
 * cloud.sh's cloud_ready: prints nothing on success; on failure warns the
 * FIRST unmet requirement (the shell's `|| { warn; return 1; }` chain never
 * reached the second) and returns false.
 */
export function cloudReady(config: BoardConfigFile, configPath: string, io: CloudIo): boolean {
  const { fireUrl, tokenEnv } = cloudConfig(config);
  // jq -r rendered the boolean, so `true` and the string "true" both pass.
  if (interp(cfg<unknown>(config, '.cloud.enabled', 'false')) !== 'true') {
    io.warn('cloud dispatch is off (cloud.enabled)');
    return false;
  }
  if (fireUrl === '') {
    io.warn(`no cloud.fireUrl in ${configPath} — see reference/cloud-sessions.md`);
    return false;
  }
  if (cloudToken(config, io) === '') {
    io.warn(`$${tokenEnv} is empty — export the routine's bearer token`);
    return false;
  }
  return true;
}

/** `--check`: the READY block, or the BLOCKED line (stdout, like the echo). */
export function cloudCheck(
  config: BoardConfigFile,
  configPath: string,
  io: CloudIo,
): { ready: boolean; lines: string[] } {
  if (cloudReady(config, configPath, io)) {
    const { fireUrl, tokenEnv } = cloudConfig(config);
    return {
      ready: true,
      lines: [
        'READY: cloud dispatch configured',
        `  fireUrl: ${fireUrl}`,
        `  token:   $${tokenEnv} is set`,
      ],
    };
  }
  return { ready: false, lines: ['BLOCKED: cloud dispatch is not usable — see the warnings above'] };
}

// ── --enable ──────────────────────────────────────────────────────────────────

/**
 * The last mile of setup, so the operator does not hand-edit config.json. The
 * token is deliberately NOT taken here: it would land in shell history, and
 * this repository's files are read by agents and quoted into briefs.
 */
export function cloudEnable(orch: OrchRoot, url: string, io: CloudIo): string[] {
  if (url === '') throw new Error('usage: board cloud enable <routine fire URL>');
  // The shell's case glob `https://api.anthropic.com/v1/claude_code/routines/*/fire`:
  // the star spans anything, but `routines/fire` with no middle segment fails.
  const prefix = 'https://api.anthropic.com/v1/claude_code/routines/';
  if (!url.startsWith(prefix) || !url.slice(prefix.length).endsWith('/fire')) {
    throw new Error(
      'that does not look like a routine fire URL.\n' +
        '     Expected: https://api.anthropic.com/v1/claude_code/routines/trig_…/fire\n' +
        '     Copy it from the API trigger modal at claude.ai/code/routines',
    );
  }

  // Cloud settings are machine settings. The legacy file, while it exists, is
  // the effective config and gets updated in place — but on a migrated setup
  // (split files only) the write goes to the MACHINE config: recreating the
  // legacy path here would resurrect a file that wins over the split pair and
  // silently change a working board.
  const targetPath = existsSync(orch.configPath) ? orch.configPath : machineConfigPath(io.env);

  // jq read the file directly, so a missing or unparseable config — and a
  // truthy non-object .cloud, which broke jq's `+` — all die the same way.
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(targetPath, 'utf8'));
  } catch {
    throw new Error(`could not update ${targetPath}`);
  }
  if (!isObj(parsed)) throw new Error(`could not update ${targetPath}`);
  const existingCloud = jqAlt(parsed['cloud']) ?? {};
  if (!isObj(existingCloud)) throw new Error(`could not update ${targetPath}`);

  const tokenEnv = jqAlt(existingCloud['tokenEnv']) ?? 'SUPERSET_CLOUD_TOKEN';
  const merged: Obj = {
    ...existingCloud,
    enabled: true,
    fireUrl: url,
    tokenEnv,
    defaultHost: jqAlt(existingCloud['defaultHost']) ?? 'local',
  };
  const next: Obj = { ...parsed, cloud: merged };

  // Backup before the swap, as the shell cp'd before its mv. The timestamp
  // comes from io.now() so tests get a deterministic name.
  const stamp = io.now().replace(/[^0-9]/g, '');
  copyFileSync(targetPath, `${targetPath}.bak-${stamp}`);
  const tmp = `${targetPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    renameSync(tmp, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // never created, or already renamed
    }
    throw err;
  }

  return [
    `cloud dispatch enabled in ${targetPath}`,
    `  fireUrl: ${url}`,
    '',
    'One step left — put the routine token in your shell, then check:',
    `  export ${interp(tokenEnv)}='sk-ant-oat01-…'`,
    '  board cloud check',
  ];
}

// ── --send ────────────────────────────────────────────────────────────────────

/**
 * Steer a live session — the CLI path, which works for an existing session
 * even though creation does not. Queue-and-exit: it authenticates as the
 * account, sends no local state, and so works from any machine, including one
 * that never dispatched the session.
 */
export function cloudSend(io: CloudIo, session: string, message: string): ExecResult {
  if (session === '') throw new Error('--send needs a session id');
  if (message === '') throw new Error('--send needs --message');
  const result = io.exec('claude', ['-p', message, '--cloud', session, '--output-format', 'json']);
  // need_cmd's job: a spawn that never found the binary dies by name.
  if (result.status === 127) throw new Error('missing command: claude');
  return result;
}

// ── --fire ────────────────────────────────────────────────────────────────────

export interface CloudDeps {
  config: BoardConfigFile;
  configPath: string;
  boardDir: string;
  io: CloudIo;
}

export interface FireResult {
  sessionId: string;
  sessionUrl: string;
  brief: string;
}

/** `.error.message // empty`, else the raw body — curl error text included. */
function fireReason(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isObj(parsed) && isObj(parsed['error'])) {
      const message = jqAlt(parsed['error']['message']);
      if (message !== undefined) return interp(message);
    }
  } catch {
    // not JSON — the body itself is the reason
  }
  return body;
}

/**
 * Start a cloud session for a brief. The brief travels INLINE, in the fire
 * text: the alternative was a pointer to a committed file, but the cloud VM
 * clones the remote and cannot see this machine's working tree, so a pointer
 * means committing every proposed brief — including the abandoned ones — to
 * the default branch. Inline keeps dispatch free of side effects.
 */
export async function cloudFire(
  deps: CloudDeps,
  opts: { brief: string; item?: string },
): Promise<FireResult> {
  const { config, configPath, boardDir, io } = deps;
  const brief = opts.brief ?? '';
  if (brief === '') throw new Error('--fire needs --brief <path>');
  if (!existsSync(brief)) throw new Error(`no brief at ${brief}`);
  if (!cloudReady(config, configPath, io)) {
    throw new Error('cloud dispatch is not usable — see the warnings above');
  }
  const { fireUrl, tokenEnv } = cloudConfig(config);

  // `$(cat "$brief")` strips trailing newlines before the epilogue is glued on.
  const briefBody = readFileSync(brief, 'utf8').replace(/\n+$/, '');
  const text = `${briefBody}\n\n---\n\n${FIRE_EPILOGUE}`;

  // The 65,536 cap is the endpoint's, on `text`. A brief is a few kilobytes,
  // so this is headroom rather than a constraint — but a brief that quotes a
  // long log could reach it, and a truncated brief is worse than a refused
  // one, so it is checked (in bytes, as `wc -c` counted) rather than trusted.
  const size = Buffer.byteLength(text, 'utf8');
  if (size > FIRE_TEXT_CAP) {
    throw new Error(
      `brief is too big to send: ${size} characters, and the endpoint caps text at 65536.\n` +
        `     Trim ${brief} — quoted logs and diffs are usually what pushes it over.`,
    );
  }

  // NO RETRY, deliberately — not on a 429, not on a network error, not ever.
  // `/fire` has no idempotency key: every successful call creates a session,
  // so a retry on an ambiguous failure gives one item two agents working the
  // same branch. Report and let the operator decide.
  let code: number | undefined;
  let body = '';
  try {
    const response = await io.fetch(fireUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cloudToken(config, io)}`,
        'anthropic-beta': CLOUD_BETA,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });
    code = response.status;
    body = response.body;
  } catch (err) {
    // curl's connection failure: no status line at all — `${code:-?}` below.
    code = undefined;
    body = err instanceof Error ? err.message : String(err);
  }

  if (code !== 200) {
    const reason = fireReason(body);
    switch (code) {
      case 400:
        throw new Error(
          `cloud fire rejected (400): ${reason}\n` +
            '     Usually a paused routine, or text over the 65,536-character cap.',
        );
      case 401:
        throw new Error(
          `cloud fire unauthorized (401): the token in $${tokenEnv} does not match this routine.`,
        );
      case 403:
        throw new Error('cloud fire forbidden (403): this account cannot use the endpoint.');
      case 404:
        throw new Error(`cloud fire not found (404): no routine at ${fireUrl}`);
      case 429:
        throw new Error(
          "cloud fire rate limited (429): the daily routine allowance or the account's usage limit is spent.\n" +
            '     NOT retried — a retry that succeeds would create a second session for the same item.',
        );
      default:
        throw new Error(
          `cloud fire failed (HTTP ${code ?? '?'}): ${reason}\n     NOT retried — see above.`,
        );
    }
  }

  // A 200 whose body is not JSON, or is JSON with no session id, is the same
  // failure: a session may or may not exist, and only the operator can tell.
  let sessionId = '';
  let sessionUrl = '';
  try {
    const parsed: unknown = JSON.parse(body);
    if (isObj(parsed)) {
      const id = jqAlt(parsed['claude_code_session_id']);
      if (id !== undefined) sessionId = interp(id);
      const url = jqAlt(parsed['claude_code_session_url']);
      if (url !== undefined) sessionUrl = interp(url);
    }
  } catch {
    // fall through to the no-session-id refusal with the raw body
  }
  if (sessionId === '') throw new Error(`cloud fire returned 200 with no session id: ${body}`);
  if (sessionUrl === '') sessionUrl = `https://claude.ai/code/${sessionId}`;

  appendLog(boardDir, 'cloud-fired', opts.item ?? '-', { sessionId, brief });
  return { sessionId, sessionUrl, brief };
}

// ── argv surface ──────────────────────────────────────────────────────────────

function die(message: string): never {
  process.stderr.write(`BLOCKED: ${message}\n`);
  process.exit(1);
}

const USAGE =
  'usage: board cloud fire --brief <path> [--item id] | send <id> --message … | check | enable <url>';

/**
 * `board cloud <check|enable|send|fire> ...` — cloud.sh's argv surface, verb
 * names instead of --flags but the same refusals underneath.
 */
export async function runCloud(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const io = realCloudIo();
  try {
    switch (sub) {
      case 'enable': {
        const orch = loadRoot();
        for (const line of cloudEnable(orch, rest[0] ?? '', io)) console.log(line);
        return;
      }
      case 'check': {
        const orch = loadRoot();
        const { ready, lines } = cloudCheck(readConfig(orch), orch.configPath, io);
        for (const line of lines) console.log(line);
        if (!ready) process.exit(1);
        return;
      }
      case 'send': {
        const session = rest[0] !== undefined && !rest[0].startsWith('--') ? rest[0] : '';
        let message = '';
        for (let i = session === '' ? 0 : 1; i < rest.length; i += 2) {
          if (rest[i] === '--message' && rest[i + 1] !== undefined) message = rest[i + 1]!;
          else die(`unknown argument: ${rest[i]}`);
        }
        const result = cloudSend(io, session, message);
        if (result.stdout !== '') process.stdout.write(result.stdout);
        if (result.stderr !== '') process.stderr.write(result.stderr);
        process.exit(result.status);
      }
      case 'fire': {
        let brief = '';
        let item = '';
        for (let i = 0; i < rest.length; i += 2) {
          if (rest[i] === '--brief' && rest[i + 1] !== undefined) brief = rest[i + 1]!;
          else if (rest[i] === '--item' && rest[i + 1] !== undefined) item = rest[i + 1]!;
          else die(`unknown argument: ${rest[i]}`);
        }
        const orch = loadRoot();
        const { boardDir } = resolveBoardDir();
        const result = await cloudFire(
          { config: readConfig(orch), configPath: orch.configPath, boardDir, io },
          { brief, item: item === '' ? undefined : item },
        );
        // jq -nc's shape: compact, sessionId/sessionUrl/brief in that order.
        console.log(JSON.stringify(result));
        return;
      }
      default:
        die(USAGE);
    }
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
}
