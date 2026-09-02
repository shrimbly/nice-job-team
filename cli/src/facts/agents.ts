// The agent-status side of poll.sh's SENSE pass: every file in the global
// status inbox, enriched with what only the poller can see — transcript
// liveness, uncommitted files, unpushed commits. Ported from poll.sh's
// "Superset + agents" section; the enrichment fields land in
// signals/workspaces.json alone, never back into workspaces/*.json.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { PollIo } from '../types.js';

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The transcript directory's name for a worktree: `sed 's|[/.]|-|g'` — every
 * slash AND dot becomes a dash, which is how Claude Code names
 * ~/.claude/projects entries.
 */
export function transcriptSlug(worktreePath: string): string {
  return worktreePath.replace(/[/.]/g, '-');
}

/** `date -u -r <file> +%Y-%m-%dT%H:%M:%SZ`: mtime, seconds, no millis. */
function isoSeconds(epochMs: number): string {
  return new Date(Math.floor(epochMs / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * poll.sh's worktree lookup: `.[]? | select(.id==$id) | .worktreePath // empty`
 * over the live workspace rows. First matching row whose worktreePath survives
 * `//` wins (the shell concatenated multiple matches into one garbled string;
 * ids are unique in practice, so first-match is the sane reading of it).
 */
function worktreeFor(workspaces: unknown[], workspaceId: string): string {
  for (const raw of workspaces) {
    if (!isObj(raw) || raw['id'] !== workspaceId) continue;
    const path = raw['worktreePath'];
    if (path === undefined || path === null || path === false) continue;
    if (typeof path === 'string' && path !== '') return path;
  }
  return '';
}

interface Liveness {
  live: string;
  last: string;
}

/**
 * Transcript liveness: the newest *.jsonl under the worktree's transcript
 * directory. Newer than stallMinutes → active, older → idle; no directory or
 * no transcripts at all leaves "unknown" — poll.sh only ever upgrades from
 * unknown inside its `[ -n "$newest" ]` guard, and `last` stays "" (an empty
 * string, not null: the shell passed it through --arg).
 */
function liveness(io: PollIo, worktree: string, stallMinutes: number): Liveness {
  const result: Liveness = { live: 'unknown', last: '' };
  if (worktree === '') return result;
  const dir = join(io.homeDir(), '.claude', 'projects', transcriptSlug(worktree));
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return result;
  }
  let newestMs: number | null = null;
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      const ms = statSync(join(dir, name)).mtimeMs;
      if (newestMs === null || ms > newestMs) newestMs = ms;
    } catch {
      // raced a deletion; ls -t would have missed it the same way
    }
  }
  if (newestMs === null) return result;
  result.last = isoSeconds(newestMs);
  // find -newermt "-N minutes": strictly newer than the cutoff.
  result.live = newestMs > io.nowMs() - stallMinutes * 60 * 1000 ? 'active' : 'idle';
  return result;
}

interface GitState {
  dirty: string;
  ahead: string;
}

/**
 * Uncommitted / unpushed state, so LAND and CLOSE never guess. Strings on
 * purpose — the shell's wc/rev-list output — and "?" when there is no
 * worktree directory to ask. A failing `git status` counts zero lines (what
 * wc saw of an empty pipe); a missing upstream is the literal "no-upstream",
 * poll.sh's own `|| echo`.
 */
function gitState(io: PollIo, worktree: string): GitState {
  const state: GitState = { dirty: '?', ahead: '?' };
  if (worktree === '') return state;
  try {
    if (!statSync(worktree).isDirectory()) return state;
  } catch {
    return state;
  }
  const status = io.exec('git', ['-C', worktree, 'status', '--porcelain']);
  // wc -l counts newlines, so an empty output — or a failed git the bash
  // piped to /dev/null — is 0, not an error.
  const out = status.status === 0 ? status.stdout : '';
  state.dirty = String((out.match(/\n/g) ?? []).length);
  const ahead = io.exec('git', ['-C', worktree, 'rev-list', '--count', '@{u}..HEAD']);
  state.ahead = ahead.status === 0 ? ahead.stdout.trim() : 'no-upstream';
  return state;
}

export interface AgentFacts {
  /** The enriched rows, in inbox filename order — the shell's glob order. */
  agentStatus: Obj[];
  warnings: string[];
}

/**
 * The status-inbox walk: every workspaces/*.json in sorted name order, each
 * parseable file passed through verbatim plus the five enrichment fields.
 *
 * poll.sh warned "unparseable status file: <path>" and skipped only files jq
 * could not parse at all; a parseable NON-OBJECT (a bare number, an array)
 * then crashed the enrichment jq and took the whole poll down with it. Ported
 * as a skip with the same warning — one bad file costs one agent, never the
 * poll. (lib.sh's stricter status_file_valid guard belongs to sync/render,
 * not here: poll.sh deliberately reads more than sync folds in.)
 */
export function collectAgentStatus(
  workspacesDir: string,
  workspaces: unknown[],
  stallMinutes: number,
  io: PollIo,
): AgentFacts {
  const warnings: string[] = [];
  let names: string[];
  try {
    names = readdirSync(workspacesDir);
  } catch {
    return { agentStatus: [], warnings };
  }

  const agentStatus: Obj[] = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const file = join(workspacesDir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      warnings.push(`unparseable status file: ${file}`);
      continue;
    }
    if (!isObj(parsed)) {
      warnings.push(`unparseable status file: ${file}`);
      continue;
    }

    const workspaceId = basename(name, '.json');
    const worktree = worktreeFor(workspaces, workspaceId);
    const { live, last } = liveness(io, worktree, stallMinutes);
    const { dirty, ahead } = gitState(io, worktree);

    agentStatus.push({
      ...parsed,
      sessionLiveness: live,
      lastSessionActivityAt: last,
      worktreePath: worktree,
      dirtyFiles: dirty,
      unpushedCommits: ahead,
    });
  }
  return { agentStatus, warnings };
}
