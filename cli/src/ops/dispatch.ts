// `board dispatch` — create a workspace, start an implementation agent in it,
// and record it on the board. Ports skills/superset-orchestrator/scripts/
// dispatch.sh whole: requires an approved item and an existing brief, and
// every refusal keeps the shell's exact words — the orchestrator skill and the
// operator both pattern-match on them (docs/lessons.md is the why).
//
// TWO HOSTS. `local` is a Superset workspace: a git worktree on this machine
// and an agent that writes a status file the board reads. `cloud` sends the
// same brief to Claude Code on the web — no worktree, no local memory cost,
// and no status file, because the agent runs on hosted infrastructure and
// cannot write to this machine. A cloud item gets its state from GitHub alone.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cfg, loadRoot, readConfig } from '../config.js';
import { authed, supersetCommand } from '../facts/superset.js';
import { applyItemPatch } from '../statemachine.js';
import { appendLog, readBoardRaw, writeBoard } from '../store.js';
import type { BoardConfigFile, CloudIo, OrchRoot } from '../types.js';
import { agentCreateArgs, isKnownAgent, PRESET_AGENTS, resolveModel } from './agents.js';
import { cloudFire, realCloudIo } from './cloud.js';
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
 * bash's `printf %q`, for the --dry-run command lines: safe words unquoted,
 * shell metacharacters backslash-escaped, and the $'…' form once control
 * characters (the prompt's newlines) are involved.
 */
export function shellQuote(value: string): string {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  if (/[\x00-\x1f\x7f]/.test(value)) {
    const escaped = value
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t')
      .replace(/\r/g, '\\r');
    return `$'${escaped}'`;
  }
  return value.replace(/[^A-Za-z0-9_@%+=:,./-]/g, (c) => `\\${c}`);
}

/**
 * A refusal that must flush partial stdout first (the shell printed the raw
 * create response before dying on it), and can carry the underlying cloud
 * failure as `cause` so the operator sees both BLOCKED lines, as they did when
 * dispatch.sh died on top of cloud.sh's own die.
 */
export class DispatchError extends Error {
  stdoutLines: string[];
  constructor(message: string, opts: { cause?: unknown; stdoutLines?: string[] } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.stdoutLines = opts.stdoutLines ?? [];
  }
}

export interface DispatchDeps {
  orch: OrchRoot;
  boardDir: string;
  config: BoardConfigFile;
  io: CloudIo;
  /** What a lock timeout blames — lib.sh names $PROJECT_KEY. */
  label?: string;
}

export interface DispatchOptions {
  item?: string;
  host?: string;
  slug?: string;
  branch?: string;
  base?: string;
  repo?: string;
  taskId?: string;
  agent?: string;
  model?: string;
  dryRun?: boolean;
  noItem?: boolean;
}

/** dispatch.sh's running set: the states that hold a cap slot. */
const RUNNING_STATES = ['dispatched', 'building', 'awaiting-approval', 'fixing'];

/**
 * lib.sh's repo_cfg: `(.repos[]? | select(.name==$r) | .field) // empty`
 * captured as one substitution — every matching repo's value, newline-joined,
 * with `//` dropping null and false from the stream; the fallback only when
 * nothing at all came out.
 */
function repoCfg(config: BoardConfigFile, repo: string, field: string, fallback: string): string {
  const repos = Array.isArray(config.repos) ? config.repos : [];
  const outputs: string[] = [];
  for (const entry of repos) {
    if (!isObj(entry) || entry['name'] !== repo) continue;
    const value = jqAlt(entry[field]);
    if (value !== undefined) outputs.push(interp(value));
  }
  const out = outputs.join('\n');
  return out !== '' ? out : fallback;
}

/** `wc -w`: whitespace-separated tokens, zero for an all-blank string. */
function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/**
 * The per-host concurrency count. Caps are counted per host because they are
 * different limits: the local cap is this machine's memory (a workspace is a
 * full checkout plus an agent session), while a cloud session costs this
 * machine nothing — its cap is review capacity and the account's rate limit.
 * Counting the two together would let a cloud dispatch block a local one over
 * memory nobody is using.
 */
function countActive(items: unknown[], host: 'local' | 'cloud', boardFile: string): number {
  let active = 0;
  for (const raw of items) {
    // jq's `.host` on null yields null; on any other non-object it errored and
    // the shell died mid-count — same refusal, with a message naming the file.
    if (raw !== null && raw !== undefined && !isObj(raw)) {
      throw new Error(`board at ${boardFile} has a non-object item — cannot count the concurrency cap`);
    }
    const item = isObj(raw) ? raw : {};
    const itemHost = jqAlt(item['host']) ?? 'local';
    const isCloud = itemHost === 'cloud';
    if ((host === 'cloud') !== isCloud) continue;
    const state = item['state'];
    if (typeof state === 'string' && RUNNING_STATES.includes(state)) active += 1;
  }
  return active;
}

/**
 * The dupe check's workspace list, STRICT. facts/superset's listLocalWorkspaces
 * degrades a failed or garbled `workspaces list` to [] — poll-grade, because a
 * broken list must cost the workspace column, not the poll — but here an empty
 * list reads as "no duplicate" and dispatch would create a second workspace
 * and a second agent on the same branch: exactly the two-confused-agents state
 * the guard exists to refuse. The shell died under pipefail on a failed or
 * unparseable list before creating anything; the port refuses the same way.
 */
export function listLocalWorkspacesStrict(io: CloudIo): unknown[] {
  const refusal =
    'could not list workspaces — refusing to dispatch without the duplicate-branch check';
  const { cmd, env } = supersetCommand(io);
  const result = io.exec(cmd, ['workspaces', 'list', '--local', '--json'], { env });
  if (result.status !== 0) throw new Error(refusal);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(refusal);
  }
  // The list ran and parsed: `jq '. // []'` normalises null AND false to [].
  if (parsed === null || parsed === false || parsed === undefined) return [];
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * The whole verb. Returns the stdout lines the script printed; refusals throw
 * with the shell's die text (minus the BLOCKED prefix the argv surface adds),
 * warnings go through io.warn. A --dry-run never spawns a mutating
 * subprocess: the only exec allowed on that path is read-only (auth whoami,
 * workspaces list, create --help), and the cloud path fires nothing.
 */
export async function dispatch(deps: DispatchDeps, opts: DispatchOptions): Promise<string[]> {
  const { orch, boardDir, config, io } = deps;
  const boardFile = join(boardDir, 'board.json');

  let item = opts.item ?? '';
  let slug = opts.slug ?? '';
  let branch = opts.branch ?? '';
  let base = opts.base ?? '';
  let repo = opts.repo ?? '';
  let taskId = opts.taskId ?? '';
  let agent = opts.agent ?? '';
  const dry = opts.dryRun === true;
  const host = opts.host ?? interp(cfg<unknown>(config, '.cloud.defaultHost', 'local'));

  // An item is the board's record that this work was approved and is now
  // running. Dispatching without one creates a live workspace and a live agent
  // that nothing tracks: poll/reconcile/autoreap all iterate .items, so an
  // unrecorded dispatch is invisible until someone notices the workspace by
  // hand. Refuse by default.
  if (item === '' && opts.noItem !== true) {
    throw new Error(
      'no --item. Create the board item first, then dispatch with --item <id>.\n' +
        '     Dispatching without one leaves the workspace and agent untracked — board poll,\n' +
        '     board reconcile and board reap --auto all iterate .items and will never see it.\n' +
        '     If this is genuinely a throwaway workspace, pass --no-item to say so.',
    );
  }

  const boardRead = readBoardRaw(boardFile);
  if (boardRead.error !== undefined) {
    throw new Error(`board at ${boardFile} is not parseable JSON: ${boardRead.error}`);
  }
  const rootItems =
    !boardRead.missing && isObj(boardRead.json) && Array.isArray(boardRead.json['items'])
      ? boardRead.json['items']
      : [];

  let nextState = 'dispatched';
  if (item !== '') {
    const obj = rootItems.find((it): it is Obj => isObj(it) && it['id'] === item);
    if (obj === undefined) throw new Error(`no board item ${item}`);
    const fill = (current: string, key: string): string => {
      if (current !== '') return current;
      const value = jqAlt(obj[key]);
      return value === undefined ? '' : interp(value);
    };
    slug = fill(slug, 'slug');
    branch = fill(branch, 'branch');
    base = fill(base, 'baseBranch');
    repo = fill(repo, 'repo');
    taskId = fill(taskId, 'supersetTaskId');

    // Board titles are scan-labels, not summaries. The board is read at a
    // glance and rendered in a narrow table column, so a title long enough to
    // explain the work pushes out the columns that carry the state. The full
    // statement of intent lives in `outcome` and in the brief; the title only
    // has to identify the row. Shape: "<TICKET> - <up to five words>". The
    // ticket number goes first so the board can be cross-referenced against
    // Linear without opening anything, and it is derived from the item's own
    // source so the two cannot drift.
    const title = interp(jqAlt(obj['title']) ?? '');
    const source = obj['source'];
    const eid = isObj(source) ? interp(jqAlt(source['externalId']) ?? '') : '';

    if (eid !== '' && !title.startsWith(eid)) {
      throw new Error(
        `board title for ${item} must start with its ticket number.\n` +
          `     got:      "${title}"\n` +
          `     expected: "${eid} - <up to five words>"`,
      );
    }

    // Count the description only — the ticket prefix is an identifier, not a
    // word.
    let desc = title.startsWith(eid) ? title.slice(eid.length) : title;
    if (desc.startsWith(' - ')) desc = desc.slice(3);
    const words = wordCount(desc);
    if (words > 5) {
      throw new Error(
        `board title for ${item} describes the work in ${words} words — max 5.\n` +
          `     got:  "${title}"\n` +
          '     Titles name the work, they do not describe it. Put the description in .outcome.\n' +
          `     e.g. "${eid} - Remove API key fields", "${eid} - Add requirements filter".`,
      );
    }

    // `pr-open` is dispatchable too: an open PR that went red or conflicted
    // needs an agent, and it may have no workspace (or have lost one). It
    // lands in `fixing` rather than `dispatched`, because the PR already
    // exists.
    // `jq -r '.state'` had no `//`, so null renders "null" and false "false".
    const state = interp(obj['state'] ?? null);
    if (state === 'proposed' || state === 'orphaned') nextState = 'dispatched';
    else if (state === 'pr-open') nextState = 'fixing';
    else {
      throw new Error(
        `item ${item} is in state '${state}' — dispatchable states are 'proposed', 'orphaned' and 'pr-open'`,
      );
    }

    const parent = jqAlt(obj['stackParent']);
    if (parent !== undefined && interp(parent) !== '') {
      const parentId = interp(parent);
      const parentObj = rootItems.find((it): it is Obj => isObj(it) && it['id'] === parentId);
      // board_item on a missing parent piped nothing into jq, so pstate was
      // '' — "missing" names only a parent that exists with no state.
      const pstate =
        parentObj === undefined ? '' : interp(jqAlt(parentObj['state']) ?? 'missing');
      if (!['pr-open', 'fixing', 'merged', 'closed'].includes(pstate)) {
        throw new Error(
          `stack parent ${parentId} is '${pstate}' — dispatch a stacked child only once the parent's PR is open`,
        );
      }
    }
  }

  if (slug === '') throw new Error('need --slug');
  if (branch === '') throw new Error('need --branch');
  if (repo === '') throw new Error('need --repo');
  // Which agent: the --agent flag wins, then the repo's own default, then the
  // global default. An unknown name is refused rather than passed to Superset,
  // where it would fail late with a murkier message.
  if (agent === '') agent = repoCfg(config, repo, 'agent', '');
  if (agent === '') agent = interp(cfg<unknown>(config, '.superset.agent', 'claude'));
  if (!isKnownAgent(agent)) {
    throw new Error(
      `unknown --agent '${agent}' — known agents: ${[...PRESET_AGENTS, 'opencode'].join(', ')}`,
    );
  }
  // The model only means something to a command agent (opencode); resolved
  // through the config alias table so "glm 5.3" reaches the runner as its real
  // provider/model id. A preset agent picks its own model, so this is ignored.
  const modelsAlias = isObj(config.models) ? (config.models as Record<string, string>) : undefined;
  let model = resolveModel(modelsAlias, opts.model ?? '');
  if (model === '' && agent === 'opencode') {
    model = resolveModel(modelsAlias, interp(cfg<unknown>(config, '.agents.opencode.defaultModel', '')));
  }

  const project = repoCfg(config, repo, 'supersetProjectId', '');
  if (project === '') {
    throw new Error(
      `no supersetProjectId for ${repo} in config.json (superset projects list --local --json)`,
    );
  }
  if (base === '') base = repoCfg(config, repo, 'defaultBase', 'main');

  const brief = join(boardDir, 'briefs', `${slug}.md`);
  if (!existsSync(brief)) {
    throw new Error(`no brief at ${brief} — write it before dispatching (reference/dispatch-brief.md)`);
  }

  if (host !== 'local' && host !== 'cloud') {
    throw new Error(`unknown --host '${host}' — use 'local' or 'cloud'`);
  }

  if (!boardRead.missing) {
    if (host === 'cloud') {
      const max = Number(interp(cfg<unknown>(config, '.limits.maxActiveCloudSessions', 8)));
      const active = countActive(rootItems, 'cloud', boardFile);
      if (active >= max) {
        throw new Error(
          `${active} cloud sessions already running (cap ${max} — limits.maxActiveCloudSessions)`,
        );
      }
    } else {
      const max = Number(interp(cfg<unknown>(config, '.limits.maxActiveWorkspaces', 4)));
      const active = countActive(rootItems, 'local', boardFile);
      if (active >= max) {
        throw new Error(
          `${active} active workspaces already (cap ${max}) — land something before dispatching more`,
        );
      }
    }
  }

  // ── Cloud ───────────────────────────────────────────────────────────────────
  // No workspace, no worktree, no agent on this machine. The session clones
  // the GitHub remote itself, so nothing here has to exist locally.
  if (host === 'cloud') {
    if (dry) {
      return [`board cloud fire --brief ${shellQuote(brief)} --item ${shellQuote(item)}`];
    }
    let fired;
    try {
      fired = await cloudFire(
        { config, configPath: orch.configPath, boardDir, io },
        { brief, item: item === '' ? undefined : item },
      );
    } catch (err) {
      throw new DispatchError(
        'cloud dispatch failed — the item is unchanged, so it can be dispatched again once fixed',
        { cause: err },
      );
    }

    if (item !== '') {
      // No createdByOrchestrator: that flag is auto-reap permission to DELETE
      // a workspace, and there is no workspace here. Nothing to reap but the
      // item.
      const at = io.now();
      const patch: Obj = {
        state: nextState,
        host: 'cloud',
        session: { id: fired.sessionId, url: fired.sessionUrl },
        branch,
        baseBranch: base,
        briefPath: brief,
      };
      await writeBoard(
        boardDir,
        (board) => {
          board['updatedAt'] = at;
          const items = board['items'];
          if (!Array.isArray(items)) {
            throw new Error(`edit of ${boardFile} failed — .items is not an array, file left unchanged`);
          }
          board['items'] = items.map((it) =>
            isObj(it) && it['id'] === item ? applyItemPatch(it, patch, undefined, at) : it,
          );
          return board;
        },
        deps.label,
      );
    }
    appendLog(boardDir, 'dispatched', item === '' ? '-' : item, {
      slug,
      host: 'cloud',
      sessionId: fired.sessionId,
      branch,
      repo,
    });

    return [
      `dispatched ${slug} to the cloud`,
      `  session   ${fired.sessionId}`,
      `  watch     ${fired.sessionUrl}`,
      `  brief     ${brief}`,
      '  note      no status file — this item gets its state from GitHub.',
      `            steer it with: board cloud send ${fired.sessionId} --message "..."`,
    ];
  }

  // One branch = one workspace. Refuse a duplicate rather than confusing two
  // agents. (Read-only, so it runs on --dry-run too, exactly as the shell did.)
  if (authed(io)) {
    const dupeRow = listLocalWorkspacesStrict(io).find(
      (row) => isObj(row) && row['branch'] === branch,
    );
    if (dupeRow !== undefined) {
      const dupe = interp(jqAlt((dupeRow as Obj)['id']) ?? null);
      throw new Error(
        `workspace ${dupe} is already on branch ${branch} — re-prompt it with 'superset agents create --workspace ${dupe}' instead`,
      );
    }
  }

  const prompt =
    `Load the superset-implementer skill, then read your brief at ${brief} and follow it.\n` +
    `You are ${item !== '' ? item : slug} on branch ${branch}, based on ${base}, in repo ${repo}.\n` +
    'Write your status file before you start work.';

  // --effort is documented but absent from some CLI builds; only pass it if
  // real. The probe is `create --help`, which mutates nothing. Command agents
  // (opencode) take a model, not an effort preset, so the probe is skipped for
  // them.
  const effort = interp(cfg<unknown>(config, '.superset.effort', ''));
  const { cmd, env } = supersetCommand(io);
  let supportsEffort = false;
  if (effort !== '' && PRESET_AGENTS.has(agent)) {
    const help = io.exec(cmd, ['workspaces', 'create', '--help'], { env });
    supportsEffort = (help.stdout + help.stderr).includes('--effort');
  }

  const args = [
    'workspaces',
    'create',
    '--local',
    '--project',
    project,
    '--name',
    slug,
    '--branch',
    branch,
    '--base-branch',
    base,
    ...agentCreateArgs({ agent, prompt, effort, model, supportsEffort }),
  ];

  if (dry) {
    return [`superset ${args.map(shellQuote).join(' ')} --json`];
  }

  if (!authed(io)) throw new Error('not logged in — superset auth login');
  const create = io.exec(cmd, [...args, '--json'], { env });
  if (create.status !== 0) throw new Error('workspace create failed');
  const out = create.stdout;

  // v1.17.0 returns {workspace:{id,…}, agents:[…], alreadyExists}; older/other
  // shapes put the id at the top level. Accept both rather than losing a
  // created workspace.
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    parsed = undefined;
  }
  const record = isObj(parsed) ? parsed : {};
  const workspace = isObj(record['workspace']) ? record['workspace'] : {};
  const wsidValue =
    jqAlt(workspace['id']) ?? jqAlt(record['id']) ?? jqAlt(record['workspaceId']);
  const wsid = wsidValue === undefined ? '' : interp(wsidValue);
  const agents = jqAlt(record['agents']) ?? [];
  const firstAgent = Array.isArray(agents) && isObj(agents[0]) ? agents[0] : {};
  const agentOkValue = jqAlt(firstAgent['ok']);
  const agentOk = agentOkValue === undefined ? '' : interp(agentOkValue);
  const sessionIdValue = jqAlt(firstAgent['sessionId']);
  const sessionId = sessionIdValue === undefined ? '' : interp(sessionIdValue);

  if (agentOk !== 'true') {
    io.warn(
      `workspace created but the agent did not start cleanly — check with: superset workspaces open ${wsid}`,
    );
  }
  if (wsid === '') {
    // The shell printed the raw response before dying, so the operator can
    // still fish the workspace out of it.
    throw new DispatchError('could not read a workspace id from the response', {
      stdoutLines: [out.replace(/\n$/, '')],
    });
  }

  // jq's `//` swallows a configured `false` here, so linkWorkspaceToTask:false
  // still reads as the default true — the shell had exactly this quirk, and
  // the linking is a warn-only nice-to-have either way.
  if (taskId !== '' && interp(cfg<unknown>(config, '.superset.linkWorkspaceToTask', true)) === 'true') {
    const link = io.exec(cmd, ['workspaces', 'update', wsid, '--task-id', taskId, '--json'], { env });
    if (link.status !== 0) {
      io.warn(`could not link task ${taskId} (tasks may not be enabled on this plan)`);
    }
  }

  if (item !== '') {
    // `createdByOrchestrator` is the auto-reap permission. It is set ONLY
    // here, where we genuinely created the workspace — never when re-prompting
    // an existing one via `agents create`, and never on a cloud dispatch.
    // Without it, autoreap leaves the workspace alone, which is what keeps the
    // operator's own hand-made workspaces safe.
    const at = io.now();
    const patch: Obj = {
      state: nextState,
      host: 'local',
      workspaceId: wsid,
      branch,
      baseBranch: base,
      briefPath: brief,
      createdByOrchestrator: true,
    };
    await writeBoard(
      boardDir,
      (board) => {
        board['updatedAt'] = at;
        const items = board['items'];
        if (!Array.isArray(items)) {
          throw new Error(`edit of ${boardFile} failed — .items is not an array, file left unchanged`);
        }
        board['items'] = items.map((it) =>
          isObj(it) && it['id'] === item ? applyItemPatch(it, patch, undefined, at) : it,
        );
        return board;
      },
      deps.label,
    );
  }
  appendLog(boardDir, 'dispatched', item === '' ? '-' : item, {
    slug,
    workspaceId: wsid,
    branch,
    repo,
    agent,
    sessionId,
  });

  const lines = [`dispatched ${slug}`, `  workspace ${wsid}`];
  if (sessionId !== '') lines.push(`  session   ${sessionId}`);
  lines.push(
    `  branch    ${branch} (base ${base})`,
    `  brief     ${brief}`,
    `  open      superset workspaces open ${wsid}`,
  );
  return lines;
}

// ── argv surface ──────────────────────────────────────────────────────────────

function die(message: string): never {
  process.stderr.write(`BLOCKED: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): DispatchOptions {
  const opts: DispatchOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = (): string => {
      const v = argv[i + 1];
      if (v === undefined) die(`${arg} needs a value`);
      i += 1;
      return v;
    };
    switch (arg) {
      case '--host':
        opts.host = value();
        break;
      case '--item':
        opts.item = value();
        break;
      case '--slug':
        opts.slug = value();
        break;
      case '--branch':
        opts.branch = value();
        break;
      case '--base':
        opts.base = value();
        break;
      case '--repo':
        opts.repo = value();
        break;
      case '--task-id':
        opts.taskId = value();
        break;
      case '--agent':
        opts.agent = value();
        break;
      case '--model':
        opts.model = value();
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--no-item':
        opts.noItem = true;
        break;
      default:
        die(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

/** `board dispatch --item <id> [--host local|cloud] …` — dies BLOCKED-style. */
export async function runDispatch(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  try {
    const orch = loadRoot();
    const { boardDir, projectKey } = resolveBoardDir();
    const config = readConfig(orch);
    const lines = await dispatch(
      { orch, boardDir, config, io: realCloudIo(), label: projectKey },
      opts,
    );
    for (const line of lines) console.log(line);
  } catch (err) {
    if (err instanceof DispatchError) {
      for (const line of err.stdoutLines) console.log(line);
      // cloud.sh's own BLOCKED line printed before dispatch.sh's, and the
      // operator pattern-matches on both — keep the pair.
      if (err.cause instanceof Error) process.stderr.write(`BLOCKED: ${err.cause.message}\n`);
    }
    die(err instanceof Error ? err.message : String(err));
  }
}
