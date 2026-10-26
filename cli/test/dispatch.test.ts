// ops/dispatch.ts against stubbed io and temp boards — no superset CLI, no
// network, no real orchestrator directory. Every refusal is asserted with the
// shell's exact words, the state transitions land where dispatch.sh put them,
// createdByOrchestrator appears ONLY on a real local creation, and the
// recorders prove a --dry-run and a failed cloud fire mutate nothing.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { DispatchError, dispatch, shellQuote } from '../src/ops/dispatch.js';
import type { DispatchDeps, DispatchOptions } from '../src/ops/dispatch.js';
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

function ok(stdout: string): ExecResult {
  return { status: 0, stdout, stderr: '' };
}

/**
 * The healthy superset CLI: logged in, no live workspaces, a create --help
 * with no --effort, and a create that returns the v1.17.0 shape.
 */
function supersetExec(
  overrides: Partial<{
    whoami: ExecResult;
    list: ExecResult;
    help: ExecResult;
    create: ExecResult;
    update: ExecResult;
  }> = {},
): (cmd: string, args: string[]) => ExecResult | undefined {
  return (cmd, args) => {
    if (cmd !== 'superset') return undefined;
    const joined = args.join(' ');
    if (joined === 'auth whoami --json') return overrides.whoami ?? ok('{}');
    if (joined === 'workspaces list --local --json') return overrides.list ?? ok('[]');
    if (joined === 'workspaces create --help') {
      return overrides.help ?? ok('usage: superset workspaces create [--local] …');
    }
    if (args[0] === 'workspaces' && args[1] === 'create') {
      return (
        overrides.create ??
        ok('{"workspace":{"id":"ws-new"},"agents":[{"ok":true,"sessionId":"sess-9"}]}')
      );
    }
    if (args[0] === 'workspaces' && args[1] === 'update') return overrides.update ?? ok('{}');
    return undefined;
  };
}

// ── fixtures ──────────────────────────────────────────────────────────────────

const FIRE_URL = 'https://api.anthropic.com/v1/claude_code/routines/trig_1/fire';
const TOKEN = 'sk-ant-oat01-secret';

function baseConfig(): BoardConfigFile {
  return {
    repos: [{ name: 'octo/site', supersetProjectId: 'proj_1', defaultBase: 'main' }],
    cloud: { enabled: true, fireUrl: FIRE_URL, tokenEnv: 'TEST_CLOUD_TOKEN' },
  };
}

function proposedItem(extra: Obj = {}): Obj {
  return {
    id: 'itm_1',
    slug: 'eng-1-fix-widget',
    title: 'ENG-1 - Fix the widget',
    state: 'proposed',
    branch: 'dev/eng-1-fix-widget',
    repo: 'octo/site',
    baseBranch: 'main',
    source: { kind: 'linear', externalId: 'ENG-1' },
    pr: null,
    history: [{ at: '2026-09-01T00:00:00Z', to: 'proposed' }],
    ...extra,
  };
}

interface Fixture {
  deps: DispatchDeps;
  boardDir: string;
  boardFile: string;
  brief: string;
  calls: Call[];
  fetches: FetchCall[];
  warnings: string[];
}

function fixture(
  opts: {
    items?: Obj[];
    config?: BoardConfigFile;
    stub?: StubOptions;
    /** Skip writing the brief file, to hit the brief-must-exist guard. */
    noBrief?: boolean;
  } = {},
): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'board-dispatch-'));
  tempRoots.push(root);
  const orch: OrchRoot = {
    root,
    configPath: join(root, 'config.json'),
    workspacesDir: join(root, 'workspaces'),
  };
  const boardDir = join(root, 'p', 'test');
  mkdirSync(join(boardDir, 'briefs'), { recursive: true });
  const boardFile = join(boardDir, 'board.json');
  const items = opts.items ?? [proposedItem()];
  writeFileSync(boardFile, JSON.stringify({ version: 1, items }, null, 2) + '\n');
  const brief = join(boardDir, 'briefs', 'eng-1-fix-widget.md');
  if (opts.noBrief !== true) writeFileSync(brief, 'Fix the widget.\n');
  const stub: StubOptions = {
    exec: supersetExec(),
    env: { TEST_CLOUD_TOKEN: TOKEN },
    ...opts.stub,
  };
  const { io, calls, fetches, warnings } = makeIo(stub);
  const deps: DispatchDeps = {
    orch,
    boardDir,
    config: opts.config ?? baseConfig(),
    io,
    label: 'test',
  };
  return { deps, boardDir, boardFile, brief, calls, fetches, warnings };
}

function run(fx: Fixture, opts: DispatchOptions = { item: 'itm_1' }): Promise<string[]> {
  return dispatch(fx.deps, opts);
}

function boardItem(boardFile: string, id: string): Obj {
  const doc = JSON.parse(readFileSync(boardFile, 'utf8')) as Obj;
  return (doc['items'] as Obj[]).find((it) => it['id'] === id)!;
}

function logLines(boardDir: string): Obj[] {
  const file = join(boardDir, 'log.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Obj);
}

// ── refusals ──────────────────────────────────────────────────────────────────

describe('dispatch refusals', () => {
  test('no --item, verbatim, and nothing is spawned', async () => {
    const fx = fixture();
    await expect(run(fx, {})).rejects.toThrow(
      'no --item. Create the board item first, then dispatch with --item <id>.\n' +
        '     Dispatching without one leaves the workspace and agent untracked — board poll,\n' +
        '     board reconcile and board reap --auto all iterate .items and will never see it.\n' +
        '     If this is genuinely a throwaway workspace, pass --no-item to say so.',
    );
    expect(fx.calls).toHaveLength(0);
    expect(fx.fetches).toHaveLength(0);
  });

  test('an unknown item', async () => {
    const fx = fixture();
    await expect(run(fx, { item: 'itm_9' })).rejects.toThrow('no board item itm_9');
  });

  test('TITLE GUARD: the title must start with the ticket number', async () => {
    const fx = fixture({ items: [proposedItem({ title: 'Fix the widget' })] });
    await expect(run(fx)).rejects.toThrow(
      'board title for itm_1 must start with its ticket number.\n' +
        '     got:      "Fix the widget"\n' +
        '     expected: "ENG-1 - <up to five words>"',
    );
  });

  test('TITLE GUARD: at most five words of description', async () => {
    const fx = fixture({
      items: [proposedItem({ title: 'ENG-1 - Fix the widget so it stops flickering' })],
    });
    await expect(run(fx)).rejects.toThrow(
      'board title for itm_1 describes the work in 7 words — max 5.\n' +
        '     got:  "ENG-1 - Fix the widget so it stops flickering"\n' +
        '     Titles name the work, they do not describe it. Put the description in .outcome.\n' +
        '     e.g. "ENG-1 - Remove API key fields", "ENG-1 - Add requirements filter".',
    );
  });

  test('the ticket prefix is an identifier, not a word: five words still pass', async () => {
    const fx = fixture({
      items: [proposedItem({ title: 'ENG-1 - Fix the widget flicker now' })],
    });
    await expect(run(fx)).resolves.toBeDefined();
  });

  test('a non-dispatchable state', async () => {
    const fx = fixture({ items: [proposedItem({ state: 'building' })] });
    await expect(run(fx)).rejects.toThrow(
      "item itm_1 is in state 'building' — dispatchable states are 'proposed', 'orphaned' and 'pr-open'",
    );
  });

  test('a stacked child waits for its parent PR', async () => {
    const fx = fixture({
      items: [
        proposedItem({ stackParent: 'itm_0' }),
        { id: 'itm_0', slug: 'parent', title: 'P', state: 'proposed', history: [] },
      ],
    });
    await expect(run(fx)).rejects.toThrow(
      "stack parent itm_0 is 'proposed' — dispatch a stacked child only once the parent's PR is open",
    );
  });

  test("a MISSING stack parent reads as '' — the shell piped nothing into jq", async () => {
    const fx = fixture({ items: [proposedItem({ stackParent: 'itm_ghost' })] });
    await expect(run(fx)).rejects.toThrow(
      "stack parent itm_ghost is '' — dispatch a stacked child only once the parent's PR is open",
    );
  });

  test('brief must exist before dispatching', async () => {
    const fx = fixture({ noBrief: true });
    await expect(run(fx)).rejects.toThrow(
      `no brief at ${fx.brief} — write it before dispatching (reference/dispatch-brief.md)`,
    );
  });

  test('a repo with no supersetProjectId', async () => {
    const fx = fixture({ config: { ...baseConfig(), repos: [] } });
    await expect(run(fx)).rejects.toThrow(
      'no supersetProjectId for octo/site in config.json (superset projects list --local --json)',
    );
  });

  test('an unknown host', async () => {
    const fx = fixture();
    await expect(run(fx, { item: 'itm_1', host: 'mars' })).rejects.toThrow(
      "unknown --host 'mars' — use 'local' or 'cloud'",
    );
  });

  test('the local cap counts only local running states', async () => {
    const running = ['dispatched', 'building', 'awaiting-approval', 'fixing'].map((state, i) => ({
      id: `itm_r${i}`,
      slug: `run-${i}`,
      title: `R${i}`,
      state,
      history: [],
    }));
    // a cloud item in a running state must NOT count against the local cap
    const cloudRunning = {
      id: 'itm_c',
      slug: 'cloudy',
      title: 'C',
      state: 'dispatched',
      host: 'cloud',
      history: [],
    };
    const fx = fixture({ items: [proposedItem(), ...running, cloudRunning] });
    await expect(run(fx)).rejects.toThrow(
      '4 active workspaces already (cap 4) — land something before dispatching more',
    );
    expect(fx.calls).toHaveLength(0); // refused before any superset call
  });

  test('the cloud cap is its own limit, named by its config key', async () => {
    const cloudRunning = {
      id: 'itm_c',
      slug: 'cloudy',
      title: 'C',
      state: 'fixing',
      host: 'cloud',
      history: [],
    };
    const fx = fixture({
      items: [proposedItem(), cloudRunning],
      config: { ...baseConfig(), limits: { maxActiveCloudSessions: 1 } },
    });
    await expect(run(fx, { item: 'itm_1', host: 'cloud' })).rejects.toThrow(
      '1 cloud sessions already running (cap 1 — limits.maxActiveCloudSessions)',
    );
    expect(fx.fetches).toHaveLength(0);
  });

  test('one branch = one workspace: a live duplicate is refused by id', async () => {
    const fx = fixture({
      stub: {
        exec: supersetExec({
          list: ok('[{"id":"ws-dup","branch":"dev/eng-1-fix-widget"}]'),
        }),
      },
    });
    await expect(run(fx)).rejects.toThrow(
      "workspace ws-dup is already on branch dev/eng-1-fix-widget — re-prompt it with 'superset agents create --workspace ws-dup' instead",
    );
  });

  test('a FAILED workspace list refuses instead of disarming the dupe check', async () => {
    // The shell died under pipefail here; degrading to [] (poll-grade) would
    // let dispatch create a second workspace and agent on the same branch.
    const fx = fixture({
      stub: { exec: supersetExec({ list: { status: 1, stdout: '', stderr: 'flaky' } }) },
    });
    await expect(run(fx)).rejects.toThrow(
      'could not list workspaces — refusing to dispatch without the duplicate-branch check',
    );
    // refused before anything mutating: no create was ever spawned
    expect(fx.calls.some((c) => c.args[1] === 'create')).toBe(false);
  });

  test('a GARBLED workspace list refuses the same way', async () => {
    const fx = fixture({
      stub: { exec: supersetExec({ list: ok('[{"id":"ws-dup","branch":"dev/eng-1-fi') }) },
    });
    await expect(run(fx)).rejects.toThrow(
      'could not list workspaces — refusing to dispatch without the duplicate-branch check',
    );
    expect(fx.calls.some((c) => c.args[1] === 'create')).toBe(false);
  });

  test('a null list parses as [] — jq `. // []` — and dispatch proceeds', async () => {
    const fx = fixture({ stub: { exec: supersetExec({ list: ok('null') }) } });
    await expect(run(fx, { item: 'itm_1', dryRun: true })).resolves.toBeDefined();
  });

  test('not logged in dies only on the real create path', async () => {
    const fx = fixture({
      stub: { exec: supersetExec({ whoami: { status: 1, stdout: '', stderr: '' } }) },
    });
    // the dupe check quietly skips when unauthenticated, then the gate fires
    await expect(run(fx)).rejects.toThrow('not logged in — superset auth login');
  });
});

// ── local dispatch ────────────────────────────────────────────────────────────

describe('local dispatch', () => {
  test('creates the workspace and records it, createdByOrchestrator included', async () => {
    const fx = fixture();
    const lines = await run(fx);

    expect(lines).toEqual([
      'dispatched eng-1-fix-widget',
      '  workspace ws-new',
      '  session   sess-9',
      '  branch    dev/eng-1-fix-widget (base main)',
      `  brief     ${fx.brief}`,
      '  open      superset workspaces open ws-new',
    ]);

    const item = boardItem(fx.boardFile, 'itm_1');
    expect(item['state']).toBe('dispatched');
    expect(item['host']).toBe('local');
    expect(item['workspaceId']).toBe('ws-new');
    expect(item['branch']).toBe('dev/eng-1-fix-widget');
    expect(item['baseBranch']).toBe('main');
    expect(item['briefPath']).toBe(fx.brief);
    // the auto-reap permission, set ONLY on a genuine local creation
    expect(item['createdByOrchestrator']).toBe(true);
    expect(item['history']).toEqual([
      { at: '2026-09-01T00:00:00Z', to: 'proposed' },
      { at: '2026-09-02T12:00:00Z', from: 'proposed', to: 'dispatched' },
    ]);

    const create = fx.calls.find((c) => c.args[0] === 'workspaces' && c.args[1] === 'create' && c.args.includes('--json'));
    expect(create?.args).toEqual([
      'workspaces',
      'create',
      '--local',
      '--project',
      'proj_1',
      '--name',
      'eng-1-fix-widget',
      '--branch',
      'dev/eng-1-fix-widget',
      '--base-branch',
      'main',
      '--agent',
      'claude',
      '--prompt',
      `Load the superset-implementer skill, then read your brief at ${fx.brief} and follow it.\n` +
        'You are itm_1 on branch dev/eng-1-fix-widget, based on main, in repo octo/site.\n' +
        'Write your status file before you start work.',
      '--json',
    ]);

    expect(logLines(fx.boardDir)).toEqual([
      {
        at: expect.any(String),
        event: 'dispatched',
        itemId: 'itm_1',
        slug: 'eng-1-fix-widget',
        workspaceId: 'ws-new',
        branch: 'dev/eng-1-fix-widget',
        repo: 'octo/site',
        agent: 'claude',
        sessionId: 'sess-9',
      },
    ]);
    expect(fx.warnings).toEqual([]);
  });

  test('pr-open dispatches into fixing, because the PR already exists', async () => {
    const fx = fixture({
      items: [proposedItem({ state: 'pr-open', pr: { number: 7, url: 'https://gh/7' } })],
    });
    await run(fx);
    expect(boardItem(fx.boardFile, 'itm_1')['state']).toBe('fixing');
  });

  test('orphaned is dispatchable too, back into dispatched', async () => {
    const fx = fixture({ items: [proposedItem({ state: 'orphaned' })] });
    await run(fx);
    expect(boardItem(fx.boardFile, 'itm_1')['state']).toBe('dispatched');
  });

  test('accepts the older id shapes, and omits the session line without one', async () => {
    for (const body of ['{"id":"ws-top"}', '{"workspaceId":"ws-top"}']) {
      const fx = fixture({ stub: { exec: supersetExec({ create: ok(body) }) } });
      const lines = await run(fx);
      expect(lines[1]).toBe('  workspace ws-top');
      expect(lines).not.toContainEqual(expect.stringContaining('session'));
      // no agents[] in these shapes: the not-clean warning fires
      expect(fx.warnings).toEqual([
        'workspace created but the agent did not start cleanly — check with: superset workspaces open ws-top',
      ]);
    }
  });

  test('a response with no id prints the response, then dies', async () => {
    const fx = fixture({ stub: { exec: supersetExec({ create: ok('{"agents":[]}') } ) } });
    const err = await run(fx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DispatchError);
    expect((err as Error).message).toBe('could not read a workspace id from the response');
    expect((err as DispatchError).stdoutLines).toEqual(['{"agents":[]}']);
    // no id means no board write: the item still says proposed
    expect(boardItem(fx.boardFile, 'itm_1')['state']).toBe('proposed');
  });

  test('a failed create dies before touching the board', async () => {
    const fx = fixture({
      stub: { exec: supersetExec({ create: { status: 1, stdout: '', stderr: 'boom' } }) },
    });
    await expect(run(fx)).rejects.toThrow('workspace create failed');
    expect(boardItem(fx.boardFile, 'itm_1')['state']).toBe('proposed');
  });

  test('links the superset task when the item names one, and warns on failure', async () => {
    const fx = fixture({ items: [proposedItem({ supersetTaskId: 'task_9' })] });
    await run(fx);
    const update = fx.calls.find((c) => c.args[0] === 'workspaces' && c.args[1] === 'update');
    expect(update?.args).toEqual(['workspaces', 'update', 'ws-new', '--task-id', 'task_9', '--json']);

    const failing = fixture({
      items: [proposedItem({ supersetTaskId: 'task_9' })],
      stub: { exec: supersetExec({ update: { status: 1, stdout: '', stderr: 'no tasks' } }) },
    });
    await run(failing);
    expect(failing.warnings).toEqual([
      'could not link task task_9 (tasks may not be enabled on this plan)',
    ]);
  });

  test('linkWorkspaceToTask:false still links — jq // swallowed false, ported as-is', async () => {
    const fx = fixture({
      items: [proposedItem({ supersetTaskId: 'task_9' })],
      config: { ...baseConfig(), superset: { linkWorkspaceToTask: false } },
    });
    await run(fx);
    expect(fx.calls.some((c) => c.args[1] === 'update')).toBe(true);
  });

  test('--no-item creates the workspace but writes no board item and logs itemId null', async () => {
    const fx = fixture();
    const before = readFileSync(fx.boardFile, 'utf8');
    const lines = await dispatch(fx.deps, {
      noItem: true,
      slug: 'eng-1-fix-widget',
      branch: 'dev/other',
      repo: 'octo/site',
    });
    expect(lines[0]).toBe('dispatched eng-1-fix-widget');
    expect(readFileSync(fx.boardFile, 'utf8')).toBe(before);
    expect(logLines(fx.boardDir)[0]).toMatchObject({ event: 'dispatched', itemId: null });
  });
});

// ── the --effort capability probe ─────────────────────────────────────────────

describe('--effort probe', () => {
  test('passes --effort only when create --help advertises it', async () => {
    const config = { ...baseConfig(), superset: { effort: 'high' } };
    const withFlag = fixture({
      config,
      stub: { exec: supersetExec({ help: ok('… --effort <level> …') }) },
    });
    const line = (await run(withFlag, { item: 'itm_1', dryRun: true }))[0]!;
    expect(line).toContain('--effort high');

    const without = fixture({ config });
    const bare = (await run(without, { item: 'itm_1', dryRun: true }))[0]!;
    expect(bare).not.toContain('--effort');
  });

  test('no configured effort means no probe at all', async () => {
    const fx = fixture();
    await run(fx, { item: 'itm_1', dryRun: true });
    expect(fx.calls.some((c) => c.args.includes('--help'))).toBe(false);
  });
});

// ── multi-provider dispatch ───────────────────────────────────────────────────

describe('agent selection', () => {
  test('--agent codex dispatches the Superset preset', async () => {
    const fx = fixture();
    const line = (await run(fx, { item: 'itm_1', agent: 'codex', dryRun: true }))[0]!;
    expect(line).toContain('--agent codex');
    expect(line).toContain('--prompt');
    expect(line).not.toContain('--command');
  });

  test('opencode dispatches via --command with the resolved model, no --agent', async () => {
    const fx = fixture({
      config: { ...baseConfig(), models: { 'glm 5.3': 'zhipuai/glm-4.6' } },
    });
    const line = (await run(fx, { item: 'itm_1', agent: 'opencode', model: 'glm 5.3', dryRun: true }))[0]!;
    // The dry-run shell-quotes the whole line, so the --command value's spaces
    // are escaped; assert on the tokens that survive quoting.
    expect(line).toContain('--command');
    expect(line).toContain('opencode');
    expect(line).toContain('zhipuai/glm-4.6');
    expect(line).not.toContain('--agent');
    expect(line).not.toContain('--prompt');
    // The implementer contract still rides in, as opencode's message arg.
    expect(line).toContain('superset-implementer');
  });

  test('opencode falls back to the configured default model', async () => {
    const fx = fixture({
      config: { ...baseConfig(), agents: { opencode: { defaultModel: 'zhipuai/glm-4.6' } } },
    });
    const line = (await run(fx, { item: 'itm_1', agent: 'opencode', dryRun: true }))[0]!;
    expect(line).toContain('--command');
    expect(line).toContain('zhipuai/glm-4.6');
  });

  test("a repo's own agent is used when --agent is absent", async () => {
    const fx = fixture({
      config: {
        ...baseConfig(),
        repos: [{ name: 'octo/site', supersetProjectId: 'proj_1', defaultBase: 'main', agent: 'codex' }],
      },
    });
    const line = (await run(fx, { item: 'itm_1', dryRun: true }))[0]!;
    expect(line).toContain('--agent codex');
  });

  test('--agent overrides the repo default', async () => {
    const fx = fixture({
      config: {
        ...baseConfig(),
        repos: [{ name: 'octo/site', supersetProjectId: 'proj_1', defaultBase: 'main', agent: 'codex' }],
      },
    });
    const line = (await run(fx, { item: 'itm_1', agent: 'claude', dryRun: true }))[0]!;
    expect(line).toContain('--agent claude');
  });

  test('an unknown agent is refused before anything is created', async () => {
    const fx = fixture();
    await expect(run(fx, { item: 'itm_1', agent: 'cursor', dryRun: true })).rejects.toThrow(
      /unknown --agent 'cursor'/,
    );
  });
});

// ── dry runs ──────────────────────────────────────────────────────────────────

describe('--dry-run', () => {
  test('local: prints the %q-quoted command and spawns nothing mutating', async () => {
    const fx = fixture();
    const before = readFileSync(fx.boardFile, 'utf8');
    const lines = await run(fx, { item: 'itm_1', dryRun: true });

    const prompt =
      `Load the superset-implementer skill, then read your brief at ${fx.brief} and follow it.\n` +
      'You are itm_1 on branch dev/eng-1-fix-widget, based on main, in repo octo/site.\n' +
      'Write your status file before you start work.';
    expect(lines).toEqual([
      'superset workspaces create --local --project proj_1 --name eng-1-fix-widget ' +
        '--branch dev/eng-1-fix-widget --base-branch main --agent claude ' +
        `--prompt ${shellQuote(prompt)} --json`,
    ]);
    // the prompt's newlines force bash %q's $'…' form
    expect(lines[0]).toContain("$'Load the superset-implementer skill");
    expect(lines[0]).toContain('\\n');

    // only read-only spawns: whoami and the workspace list — never create
    expect(fx.calls.map((c) => c.args.join(' '))).toEqual([
      'auth whoami --json',
      'workspaces list --local --json',
    ]);
    expect(readFileSync(fx.boardFile, 'utf8')).toBe(before);
    expect(logLines(fx.boardDir)).toEqual([]);
  });

  test('cloud: prints the fire line and neither fetches nor spawns', async () => {
    const fx = fixture();
    const before = readFileSync(fx.boardFile, 'utf8');
    const lines = await run(fx, { item: 'itm_1', host: 'cloud', dryRun: true });
    expect(lines).toEqual([`board cloud fire --brief ${fx.brief} --item itm_1`]);
    expect(fx.fetches).toHaveLength(0);
    expect(fx.calls).toHaveLength(0);
    expect(readFileSync(fx.boardFile, 'utf8')).toBe(before);
  });
});

// ── cloud dispatch ────────────────────────────────────────────────────────────

describe('cloud dispatch', () => {
  test('fires, records the session — and never createdByOrchestrator', async () => {
    const fx = fixture({
      stub: {
        env: { TEST_CLOUD_TOKEN: TOKEN },
        fetch: { status: 200, body: '{"claude_code_session_id":"sess_abc"}' },
      },
    });
    const lines = await run(fx, { item: 'itm_1', host: 'cloud' });

    expect(lines).toEqual([
      'dispatched eng-1-fix-widget to the cloud',
      '  session   sess_abc',
      '  watch     https://claude.ai/code/sess_abc',
      `  brief     ${fx.brief}`,
      '  note      no status file — this item gets its state from GitHub.',
      '            steer it with: board cloud send sess_abc --message "..."',
    ]);

    const item = boardItem(fx.boardFile, 'itm_1');
    expect(item['state']).toBe('dispatched');
    expect(item['host']).toBe('cloud');
    expect(item['session']).toEqual({ id: 'sess_abc', url: 'https://claude.ai/code/sess_abc' });
    // no workspace exists, so autoreap must never get permission to delete one
    expect('createdByOrchestrator' in item).toBe(false);
    expect(item['workspaceId']).toBeUndefined();

    expect(logLines(fx.boardDir)).toEqual([
      expect.objectContaining({ event: 'cloud-fired', itemId: 'itm_1', sessionId: 'sess_abc' }),
      expect.objectContaining({
        event: 'dispatched',
        itemId: 'itm_1',
        slug: 'eng-1-fix-widget',
        host: 'cloud',
        sessionId: 'sess_abc',
        branch: 'dev/eng-1-fix-widget',
        repo: 'octo/site',
      }),
    ]);
    // no superset CLI involvement on the cloud path
    expect(fx.calls).toHaveLength(0);
  });

  test('a pr-open item fired to the cloud lands in fixing', async () => {
    const fx = fixture({
      items: [proposedItem({ state: 'pr-open', pr: { number: 7 } })],
      stub: {
        env: { TEST_CLOUD_TOKEN: TOKEN },
        fetch: { status: 200, body: '{"claude_code_session_id":"sess_abc"}' },
      },
    });
    await run(fx, { item: 'itm_1', host: 'cloud' });
    expect(boardItem(fx.boardFile, 'itm_1')['state']).toBe('fixing');
  });

  test('a failed fire leaves the item byte-for-byte unchanged, and never retries', async () => {
    const fx = fixture({
      stub: {
        env: { TEST_CLOUD_TOKEN: TOKEN },
        fetch: { status: 429, body: '{}' },
      },
    });
    const before = readFileSync(fx.boardFile, 'utf8');
    const err = await run(fx, { item: 'itm_1', host: 'cloud' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DispatchError);
    expect((err as Error).message).toBe(
      'cloud dispatch failed — the item is unchanged, so it can be dispatched again once fixed',
    );
    // the underlying fire refusal rides along for the operator's stderr
    expect(((err as Error).cause as Error).message).toContain('cloud fire rate limited (429)');
    expect(fx.fetches).toHaveLength(1);
    expect(readFileSync(fx.boardFile, 'utf8')).toBe(before);
    expect(logLines(fx.boardDir)).toEqual([]);
  });

  test('cloud.defaultHost routes a plain dispatch to the cloud', async () => {
    const fx = fixture({
      config: {
        ...baseConfig(),
        cloud: { ...baseConfig().cloud, defaultHost: 'cloud' },
      },
      stub: {
        env: { TEST_CLOUD_TOKEN: TOKEN },
        fetch: { status: 200, body: '{"claude_code_session_id":"sess_abc"}' },
      },
    });
    const lines = await run(fx);
    expect(lines[0]).toBe('dispatched eng-1-fix-widget to the cloud');
  });
});

// ── shellQuote (bash printf %q) ───────────────────────────────────────────────

describe('shellQuote', () => {
  test('safe words pass through unquoted', () => {
    expect(shellQuote('eng-1-fix-widget')).toBe('eng-1-fix-widget');
    expect(shellQuote('/a/b.md')).toBe('/a/b.md');
  });

  test('metacharacters are backslash-escaped, like %q', () => {
    expect(shellQuote('a b')).toBe('a\\ b');
    expect(shellQuote('a"b')).toBe('a\\"b');
  });

  test("control characters force the $'…' form", () => {
    expect(shellQuote('a\nb')).toBe("$'a\\nb'");
    expect(shellQuote("it's\nfine")).toBe("$'it\\'s\\nfine'");
  });

  test('the empty string is quoted, not dropped', () => {
    expect(shellQuote('')).toBe("''");
  });
});
