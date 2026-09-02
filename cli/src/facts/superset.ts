// The Superset side of poll.sh's SENSE pass: whether the CLI is logged in, and
// which local workspaces exist. Ported from lib.sh's superset_authed/sup_json
// and the filter poll.sh's summary shares with sync.sh.
//
// Every failure degrades to an empty value — a poll must produce signals files
// and a summary even with no superset CLI on the machine at all.

import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { ExecResult, PollIo } from '../types.js';

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** poll.sh's exact text when superset_authed fails; a test asserts it verbatim. */
export const SUPERSET_NOT_LOGGED_IN_WARNING =
  'superset not logged in — workspace list skipped; status files still read';

/**
 * lib.sh's `export PATH="$HOME/.superset/bin:$PATH"`: the superset CLI usually
 * lives there and nowhere a fresh shell can see. The child gets the prepended
 * PATH, and the command itself resolves to the absolute path when it exists so
 * the lookup does not depend on how the platform's exec resolves PATH.
 */
export function supersetCommand(io: PollIo): { cmd: string; env: NodeJS.ProcessEnv } {
  const bin = join(io.homeDir(), '.superset', 'bin');
  const env: NodeJS.ProcessEnv = {
    ...io.env,
    PATH: `${bin}${delimiter}${io.env['PATH'] ?? ''}`,
  };
  const absolute = join(bin, 'superset');
  try {
    accessSync(absolute, constants.X_OK);
    return { cmd: absolute, env };
  } catch {
    return { cmd: 'superset', env };
  }
}

function runSuperset(io: PollIo, args: string[]): ExecResult {
  const { cmd, env } = supersetCommand(io);
  return io.exec(cmd, args, { env });
}

/** lib.sh's superset_authed: `superset auth whoami --json` exiting 0. */
export function authed(io: PollIo): boolean {
  return runSuperset(io, ['auth', 'whoami', '--json']).status === 0;
}

/**
 * lib.sh's sup_json applied to one call: parse stdout, and normalise `null` to
 * [] the way `jq '. // []'` does (false too — same operator). A failed command
 * or unparseable output is also [] — the bash died there under pipefail, and a
 * broken workspace list must cost the workspace column, not the poll.
 */
function supJsonArray(io: PollIo, args: string[]): unknown[] {
  const result = runSuperset(io, [...args, '--json']);
  if (result.status !== 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return [];
  }
  if (parsed === null || parsed === false || parsed === undefined) return [];
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * `superset workspaces list --local --json`, rows passed through verbatim —
 * signals/workspaces.json carries them untouched, so no reshaping here.
 */
export function listLocalWorkspaces(io: PollIo): unknown[] {
  return supJsonArray(io, ['workspaces', 'list', '--local']);
}

/**
 * `superset workspaces get <id> --json` — one workspace's full record, or null
 * when the CLI fails or hands back anything but an object.
 */
export function getWorkspace(io: PollIo, id: string): Obj | null {
  const result = runSuperset(io, ['workspaces', 'get', id, '--json']);
  if (result.status !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The project scoping poll.sh's summary and sync.sh share: no configured
 * project ids means everything (an unscoped board), otherwise only workspaces
 * whose projectId is configured — a busy host carries dozens of unrelated
 * workspaces, and listing them all buries the two that matter.
 *
 * poll.sh's spelling reads `(.projectId // "")`, so a null/false/absent
 * projectId matches only a configured empty string, which nobody configures.
 */
export function filterToConfiguredProjects(workspaces: unknown[], projectIds: string[]): unknown[] {
  if (projectIds.length === 0) return workspaces;
  return workspaces.filter((raw) => {
    if (!isObj(raw)) return false;
    const projectId = raw['projectId'];
    const key =
      projectId === undefined || projectId === null || projectId === false
        ? ''
        : typeof projectId === 'string'
          ? projectId
          : '';
    return projectIds.includes(key);
  });
}

/**
 * config.json's `.repos[]?.supersetProjectId // empty` — the id list the
 * filter above takes. `// empty` drops null AND false, like every other jq.
 */
export function configuredProjectIds(repos: unknown): string[] {
  if (!Array.isArray(repos)) return [];
  const ids: string[] = [];
  for (const repo of repos) {
    if (!isObj(repo)) continue;
    const id = repo['supersetProjectId'];
    if (id === undefined || id === null || id === false) continue;
    if (typeof id === 'string') ids.push(id);
  }
  return ids;
}
