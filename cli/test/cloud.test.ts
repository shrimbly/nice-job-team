// ops/cloud.ts against stubbed io — no live network, no claude CLI, no real
// config. The refusal texts are asserted verbatim because the orchestrator
// skill and the operator both pattern-match on them, and the no-retry cases
// count fetch calls because /fire has no idempotency key: a second call is a
// second session on the same branch.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  CLOUD_BETA,
  FIRE_EPILOGUE,
  cloudCheck,
  cloudEnable,
  cloudFire,
  cloudReady,
  cloudSend,
} from '../src/ops/cloud.js';
import type { CloudDeps } from '../src/ops/cloud.js';
import type {
  BoardConfigFile,
  CloudFetchInit,
  CloudFetchResult,
  CloudIo,
  ExecResult,
  OrchRoot,
} from '../src/types.js';

type Obj = Record<string, unknown>;

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

// ── io stub ───────────────────────────────────────────────────────────────────

interface Call {
  cmd: string;
  args: string[];
}

interface FetchCall {
  url: string;
  init: CloudFetchInit;
}

interface StubOptions {
  exec?: (cmd: string, args: string[]) => ExecResult | undefined;
  /** What every fetch resolves with — or an Error every fetch rejects with. */
  fetch?: CloudFetchResult | Error;
  env?: NodeJS.ProcessEnv;
}

function makeIo(opts: StubOptions = {}): {
  io: CloudIo;
  calls: Call[];
  fetches: FetchCall[];
  warnings: string[];
} {
  const calls: Call[] = [];
  const fetches: FetchCall[] = [];
  const warnings: string[] = [];
  const io: CloudIo = {
    exec(cmd, args) {
      calls.push({ cmd, args });
      return opts.exec?.(cmd, args) ?? { status: 1, stdout: '', stderr: 'stubbed: no handler' };
    },
    async fetch(url, init) {
      fetches.push({ url, init });
      if (opts.fetch instanceof Error) throw opts.fetch;
      return opts.fetch ?? { status: 200, body: '{}' };
    },
    now: () => '2026-09-02T12:00:00Z',
    nowMs: () => Date.parse('2026-09-02T12:00:00Z'),
    homeDir: () => '/nonexistent-home',
    env: opts.env ?? {},
    warn: (message) => warnings.push(message),
  };
  return { io, calls, fetches, warnings };
}

const FIRE_URL = 'https://api.anthropic.com/v1/claude_code/routines/trig_1/fire';

function readyConfig(): BoardConfigFile {
  return {
    cloud: { enabled: true, fireUrl: FIRE_URL, tokenEnv: 'TEST_CLOUD_TOKEN' },
  };
}

const TOKEN = 'sk-ant-oat01-secret-token';

function tokenEnv(): NodeJS.ProcessEnv {
  return { TEST_CLOUD_TOKEN: TOKEN };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'board-cloud-'));
  tempRoots.push(root);
  return root;
}

/** A board dir with a brief in it, plus CloudDeps wired to the stub io. */
function fireDeps(
  stub: StubOptions = {},
  briefBody = 'Fix the widget.\n',
): { deps: CloudDeps; brief: string; boardDir: string; fetches: FetchCall[]; warnings: string[] } {
  const root = tempRoot();
  const boardDir = join(root, 'p', 'test');
  mkdirSync(join(boardDir, 'briefs'), { recursive: true });
  const brief = join(boardDir, 'briefs', 'eng-1-fix-widget.md');
  writeFileSync(brief, briefBody);
  const { io, fetches, warnings } = makeIo({ env: tokenEnv(), ...stub });
  const deps: CloudDeps = {
    config: readyConfig(),
    configPath: join(root, 'config.json'),
    boardDir,
    io,
  };
  return { deps, brief, boardDir, fetches, warnings };
}

function logLines(boardDir: string): Obj[] {
  const file = join(boardDir, 'log.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Obj);
}

// ── cloud_ready / --check ─────────────────────────────────────────────────────

describe('cloudReady', () => {
  test('off by default, with the exact warning', () => {
    const { io, warnings } = makeIo();
    expect(cloudReady({}, '/orch/config.json', io)).toBe(false);
    expect(warnings).toEqual(['cloud dispatch is off (cloud.enabled)']);
  });

  test('warns only the FIRST unmet requirement, like the shell short-circuit', () => {
    const { io, warnings } = makeIo();
    // enabled but nothing else: fireUrl is the first miss, the token never warns
    expect(cloudReady({ cloud: { enabled: true } }, '/orch/config.json', io)).toBe(false);
    expect(warnings).toEqual(['no cloud.fireUrl in /orch/config.json — see reference/cloud-sessions.md']);
  });

  test('names the token VARIABLE when it is empty — never a value', () => {
    const { io, warnings } = makeIo();
    expect(cloudReady(readyConfig(), '/orch/config.json', io)).toBe(false);
    expect(warnings).toEqual(["$TEST_CLOUD_TOKEN is empty — export the routine's bearer token"]);
  });

  test('token is read indirectly through the env var config names', () => {
    const { io, warnings } = makeIo({ env: tokenEnv() });
    expect(cloudReady(readyConfig(), '/orch/config.json', io)).toBe(true);
    expect(warnings).toEqual([]);
  });

  test('the string "true" passes like the boolean, as jq -r rendered both', () => {
    const config: BoardConfigFile = {
      cloud: { enabled: 'true' as unknown as boolean, fireUrl: FIRE_URL },
    };
    const { io } = makeIo({ env: { SUPERSET_CLOUD_TOKEN: 'tok' } });
    expect(cloudReady(config, '/orch/config.json', io)).toBe(true);
  });
});

describe('cloudCheck', () => {
  test('READY block shows the url and the token NAME only', () => {
    const { io } = makeIo({ env: tokenEnv() });
    const { ready, lines } = cloudCheck(readyConfig(), '/orch/config.json', io);
    expect(ready).toBe(true);
    expect(lines).toEqual([
      'READY: cloud dispatch configured',
      `  fireUrl: ${FIRE_URL}`,
      '  token:   $TEST_CLOUD_TOKEN is set',
    ]);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  test('BLOCKED line when not usable', () => {
    const { io } = makeIo();
    const { ready, lines } = cloudCheck({}, '/orch/config.json', io);
    expect(ready).toBe(false);
    expect(lines).toEqual(['BLOCKED: cloud dispatch is not usable — see the warnings above']);
  });
});

// ── --enable ──────────────────────────────────────────────────────────────────

function orchAt(root: string): OrchRoot {
  return { root, configPath: join(root, 'config.json'), workspacesDir: join(root, 'workspaces') };
}

describe('cloudEnable', () => {
  test('refuses a URL that is not a routine fire URL', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'config.json'), '{}\n');
    const { io } = makeIo();
    expect(() => cloudEnable(orchAt(root), 'https://example.com/fire', io)).toThrow(
      'that does not look like a routine fire URL.\n' +
        '     Expected: https://api.anthropic.com/v1/claude_code/routines/trig_…/fire\n' +
        '     Copy it from the API trigger modal at claude.ai/code/routines',
    );
  });

  test('the glob needs a middle segment: routines/fire alone is refused', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'config.json'), '{}\n');
    const { io } = makeIo();
    expect(() =>
      cloudEnable(orchAt(root), 'https://api.anthropic.com/v1/claude_code/routines/fire', io),
    ).toThrow(/does not look like a routine fire URL/);
  });

  test('writes {enabled, fireUrl, tokenEnv, defaultHost} with defaults, and a backup', () => {
    const root = tempRoot();
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ operator: { githubLogin: 'w' } }, null, 2) + '\n');
    const { io } = makeIo();
    const lines = cloudEnable(orchAt(root), FIRE_URL, io);

    const written = JSON.parse(readFileSync(configPath, 'utf8')) as Obj;
    expect(written['cloud']).toEqual({
      enabled: true,
      fireUrl: FIRE_URL,
      tokenEnv: 'SUPERSET_CLOUD_TOKEN',
      defaultHost: 'local',
    });
    // untouched keys survive — the file is operator-owned
    expect(written['operator']).toEqual({ githubLogin: 'w' });
    expect(existsSync(`${configPath}.bak-20260902120000`)).toBe(true);
    expect(lines).toEqual([
      `cloud dispatch enabled in ${configPath}`,
      `  fireUrl: ${FIRE_URL}`,
      '',
      'One step left — put the routine token in your shell, then check:',
      "  export SUPERSET_CLOUD_TOKEN='sk-ant-oat01-…'",
      '  board cloud check',
    ]);
  });

  test('keeps an existing tokenEnv and defaultHost', () => {
    const root = tempRoot();
    const configPath = join(root, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({ cloud: { tokenEnv: 'MY_TOKEN', defaultHost: 'cloud' } }) + '\n',
    );
    const { io } = makeIo();
    const lines = cloudEnable(orchAt(root), FIRE_URL, io);
    const written = JSON.parse(readFileSync(configPath, 'utf8')) as Obj;
    expect(written['cloud']).toEqual({
      tokenEnv: 'MY_TOKEN',
      defaultHost: 'cloud',
      enabled: true,
      fireUrl: FIRE_URL,
    });
    expect(lines).toContain("  export MY_TOKEN='sk-ant-oat01-…'");
  });

  test('a missing or unparseable config dies as the jq edit did', () => {
    const root = tempRoot();
    // No legacy file and no machine config either: the write targets the
    // machine path (cloud is a machine setting) and dies naming it.
    const xdg = tempRoot();
    const { io } = makeIo({ env: { XDG_CONFIG_HOME: xdg } });
    expect(() => cloudEnable(orchAt(root), FIRE_URL, io)).toThrow(
      `could not update ${join(xdg, 'superset-board', 'config.json')}`,
    );
    writeFileSync(join(root, 'config.json'), 'not json');
    expect(() => cloudEnable(orchAt(root), FIRE_URL, io)).toThrow(
      `could not update ${join(root, 'config.json')}`,
    );
  });

  test('split-only setup: enable writes the machine config, never a legacy file', () => {
    const root = tempRoot();
    const xdg = tempRoot();
    const machinePath = join(xdg, 'superset-board', 'config.json');
    mkdirSync(join(xdg, 'superset-board'), { recursive: true });
    writeFileSync(machinePath, JSON.stringify({ stateDir: root, repos: [] }, null, 2) + '\n');
    const { io } = makeIo({ env: { XDG_CONFIG_HOME: xdg } });
    const lines = cloudEnable(orchAt(root), FIRE_URL, io);

    // The legacy path stays absent — recreating it would WIN over the split
    // layout and silently change a working board.
    expect(existsSync(join(root, 'config.json'))).toBe(false);
    const written = JSON.parse(readFileSync(machinePath, 'utf8')) as Obj;
    expect(written['cloud']).toEqual({
      enabled: true,
      fireUrl: FIRE_URL,
      tokenEnv: 'SUPERSET_CLOUD_TOKEN',
      defaultHost: 'local',
    });
    expect(written['stateDir']).toBe(root);
    expect(lines[0]).toBe(`cloud dispatch enabled in ${machinePath}`);
  });
});

// ── --send ────────────────────────────────────────────────────────────────────

describe('cloudSend', () => {
  test('shells out to claude with the exact queue-and-exit argv', () => {
    const { io, calls } = makeIo({ exec: () => ({ status: 0, stdout: '{"ok":true}', stderr: '' }) });
    const result = cloudSend(io, 'sess_1', 'ship it');
    expect(result.status).toBe(0);
    expect(calls).toEqual([
      { cmd: 'claude', args: ['-p', 'ship it', '--cloud', 'sess_1', '--output-format', 'json'] },
    ]);
  });

  test('a session id and a message are both required', () => {
    const { io } = makeIo();
    expect(() => cloudSend(io, '', 'hi')).toThrow('--send needs a session id');
    expect(() => cloudSend(io, 'sess_1', '')).toThrow('--send needs --message');
  });

  test('a missing claude binary dies by name, like need_cmd', () => {
    const { io } = makeIo({ exec: () => ({ status: 127, stdout: '', stderr: 'ENOENT' }) });
    expect(() => cloudSend(io, 'sess_1', 'hi')).toThrow('missing command: claude');
  });
});

// ── --fire ────────────────────────────────────────────────────────────────────

describe('cloudFire', () => {
  test('POSTs the brief inline with the verbatim autonomy epilogue and headers', async () => {
    const { deps, brief, boardDir, fetches } = fireDeps({
      fetch: { status: 200, body: '{"claude_code_session_id":"sess_abc","claude_code_session_url":"https://claude.ai/code/sess_abc"}' },
    });
    const result = await cloudFire(deps, { brief, item: 'itm_7' });

    expect(result).toEqual({
      sessionId: 'sess_abc',
      sessionUrl: 'https://claude.ai/code/sess_abc',
      brief,
    });
    expect(fetches).toHaveLength(1);
    const [call] = fetches;
    expect(call!.url).toBe(FIRE_URL);
    expect(call!.init.method).toBe('POST');
    expect(call!.init.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      'anthropic-beta': CLOUD_BETA,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    });
    // $(cat brief) strips the trailing newline before the separator
    expect(JSON.parse(call!.init.body)).toEqual({
      text: `Fix the widget.\n\n---\n\n${FIRE_EPILOGUE}`,
    });

    const log = logLines(boardDir);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      event: 'cloud-fired',
      itemId: 'itm_7',
      sessionId: 'sess_abc',
      brief,
    });
    // the bearer token never lands in the log
    expect(readFileSync(join(boardDir, 'log.jsonl'), 'utf8')).not.toContain(TOKEN);
  });

  test('falls back to https://claude.ai/code/<id> when the response has no url', async () => {
    const { deps, brief } = fireDeps({
      fetch: { status: 200, body: '{"claude_code_session_id":"sess_x"}' },
    });
    const result = await cloudFire(deps, { brief });
    expect(result.sessionUrl).toBe('https://claude.ai/code/sess_x');
  });

  test('refuses to fire when cloud is not ready — nothing sent', async () => {
    const { deps, brief, fetches } = fireDeps({ env: {} });
    await expect(cloudFire(deps, { brief })).rejects.toThrow(
      'cloud dispatch is not usable — see the warnings above',
    );
    expect(fetches).toHaveLength(0);
  });

  test('a missing brief and a missing --brief die with the shell texts', async () => {
    const { deps } = fireDeps();
    await expect(cloudFire(deps, { brief: '' })).rejects.toThrow('--fire needs --brief <path>');
    await expect(cloudFire(deps, { brief: '/nope/brief.md' })).rejects.toThrow(
      'no brief at /nope/brief.md',
    );
  });

  test('checks the 65,536 cap BEFORE sending, in bytes, naming the real size', async () => {
    const body = 'x'.repeat(66000);
    const { deps, brief, fetches } = fireDeps({}, body);
    const size = Buffer.byteLength(`${body}\n\n---\n\n${FIRE_EPILOGUE}`, 'utf8');
    await expect(cloudFire(deps, { brief })).rejects.toThrow(
      `brief is too big to send: ${size} characters, and the endpoint caps text at 65536.\n` +
        `     Trim ${brief} — quoted logs and diffs are usually what pushes it over.`,
    );
    expect(fetches).toHaveLength(0);
  });

  test('200 with no session id is a refusal quoting the body', async () => {
    const { deps, brief, boardDir } = fireDeps({ fetch: { status: 200, body: '{"ok":true}' } });
    await expect(cloudFire(deps, { brief })).rejects.toThrow(
      'cloud fire returned 200 with no session id: {"ok":true}',
    );
    expect(logLines(boardDir)).toHaveLength(0);
  });

  const errorCases: Array<{ status: number; body: string; expected: string }> = [
    {
      status: 400,
      body: '{"error":{"message":"routine is paused"}}',
      expected:
        'cloud fire rejected (400): routine is paused\n' +
        '     Usually a paused routine, or text over the 65,536-character cap.',
    },
    {
      status: 401,
      body: '{}',
      expected:
        'cloud fire unauthorized (401): the token in $TEST_CLOUD_TOKEN does not match this routine.',
    },
    {
      status: 403,
      body: '{}',
      expected: 'cloud fire forbidden (403): this account cannot use the endpoint.',
    },
    {
      status: 404,
      body: '{}',
      expected: `cloud fire not found (404): no routine at ${FIRE_URL}`,
    },
    {
      status: 429,
      body: '{}',
      expected:
        "cloud fire rate limited (429): the daily routine allowance or the account's usage limit is spent.\n" +
        '     NOT retried — a retry that succeeds would create a second session for the same item.',
    },
    {
      status: 500,
      body: 'upstream exploded',
      expected: 'cloud fire failed (HTTP 500): upstream exploded\n     NOT retried — see above.',
    },
  ];

  for (const { status, body, expected } of errorCases) {
    test(`maps ${status} to the exact refusal, and never retries`, async () => {
      const { deps, brief, fetches } = fireDeps({ fetch: { status, body } });
      await expect(cloudFire(deps, { brief })).rejects.toThrow(expected);
      // /fire has no idempotency key: exactly one call, success or not
      expect(fetches).toHaveLength(1);
    });
  }

  test('a network failure is HTTP ? — reported once, never retried', async () => {
    const { deps, brief, fetches, boardDir } = fireDeps({
      fetch: new Error('connect ECONNREFUSED'),
    });
    await expect(cloudFire(deps, { brief })).rejects.toThrow(
      'cloud fire failed (HTTP ?): connect ECONNREFUSED\n     NOT retried — see above.',
    );
    expect(fetches).toHaveLength(1);
    expect(logLines(boardDir)).toHaveLength(0);
  });
});
