// `board reconcile` — the IO shell around the pure reconcile() port of
// sync.sh. Everything the bash script did outside its one big jq happens here:
// collect the status inbox (warning on malformed files by name), ask superset
// for the live workspace list (empty on any failure, which disarms the prune
// and rule 3 exactly as sync.sh's `superset_authed ||` did), read the PR
// signals, take the board lock via store.writeBoard, delete the pruned inbox
// files, and print the stdout/stderr lines byte-for-byte — watch.sh seds them
// into events.log until P3.

import { existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { loadRoot, readConfig } from '../config.js';
import {
  authed,
  configuredProjectIds,
  filterToConfiguredProjects,
  getWorkspace,
  listLocalWorkspaces,
} from '../facts/superset.js';
import { readAgentInbox } from '../read.js';
import { reconcile } from '../reconcile.js';
import type { ReconcileResult } from '../reconcile.js';
import { nowIso, readBoardRaw, writeBoard } from '../store.js';
import type { AgentStatus, BoardDoc, PollIo, PullRequest, WorkspaceRef } from '../types.js';
import { resolveBoardDir } from './item.js';
import { realPollIo } from './poll.js';

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A jq program died mid-projection; the shell's `|| echo '[]'` caught it. */
class JqDied extends Error {}

/** `.x[]?` — arrays iterate, objects iterate their values, all else nothing. */
function iterOpt(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isObj(value)) return Object.values(value);
  return [];
}

/**
 * sync.sh's two projections over signals/github.json, quirks intact: each ran
 * in its own jq with its own `2>/dev/null || echo '[]'`, so a shape that
 * killed one projection blanked only that list. `.repos[]?` yields nothing on
 * a null/scalar .repos, but `.open` indexed on a non-object block died.
 *
 * DELIBERATE post-bash divergence (P3): the open-row projection keeps
 * latestActivityAt, so reconcile()'s agentFresh compare runs live. sync.sh's
 * projection dropped the field — a hole, not a choice: its $pat was always
 * null and the lessons.md timestamp rule ("an agent status older than the PR's
 * last activity is stale evidence") never actually ran in bash. The bash is
 * gone; the rule wins.
 */
function collectPrSignals(boardDir: string): { prs: PullRequest[]; mergedNumbers: Set<number> } {
  const empty = { prs: [] as PullRequest[], mergedNumbers: new Set<number>() };
  const file = join(boardDir, 'signals', 'github.json');
  if (!existsSync(file)) return empty;
  const read = readBoardRaw(file);
  if (read.missing || read.error !== undefined || !isObj(read.json)) return empty;
  const repos = iterOpt(read.json['repos']);

  let prs: PullRequest[] = [];
  try {
    const rows: PullRequest[] = [];
    for (const block of repos) {
      if (block === null || block === undefined) continue; // null.open → null → []? → nothing
      if (!isObj(block)) throw new JqDied(); // `.open` on a scalar/array killed the jq
      for (const row of iterOpt(block['open'])) {
        if (row !== null && row !== undefined && !isObj(row)) throw new JqDied();
        const r = isObj(row) ? row : {}; // {number} on null builds {number: null}
        rows.push({
          number: (r['number'] ?? null) as number,
          mergeStateStatus: (r['mergeStateStatus'] ?? null) as string | null,
          unresolvedThreads: (r['unresolvedThreads'] ?? null) as unknown as number,
          reviewDecision: (r['reviewDecision'] ?? null) as string | null,
          ciState: (r['ciState'] ?? null) as unknown as string,
          isDraft: (r['isDraft'] ?? null) as boolean | null,
          latestActivityAt: (r['latestActivityAt'] ?? null) as string | null,
        } as PullRequest);
      }
    }
    prs = rows;
  } catch {
    prs = [];
  }

  const mergedNumbers = new Set<number>();
  try {
    for (const block of repos) {
      if (block === null || block === undefined) continue;
      if (!isObj(block)) throw new JqDied();
      for (const row of iterOpt(block['merged'])) {
        if (row === null || row === undefined) continue; // null.number → null
        if (!isObj(row)) throw new JqDied();
        const n = row['number'];
        // Non-number entries landed in the bash array too, but a non-null item
        // pr number can never `index()` one, so only real numbers matter here.
        if (typeof n === 'number') mergedNumbers.add(n);
      }
    }
  } catch {
    mergedNumbers.clear();
  }
  return { prs, mergedNumbers };
}

/**
 * The stray-nag exclusion list: workspace ids whose worktree IS the primary
 * checkout — `git rev-parse --git-dir` equals `--git-common-dir`. Bash
 * compared command substitutions, so two failing git calls compare "" = ""
 * and count as primary; ported, because a warning suppressed by that quirk
 * must stay suppressed.
 */
function primaryWorkspaceIds(io: PollIo, liveWorkspaces: WorkspaceRef[]): string[] {
  if (liveWorkspaces.length === 0) return [];
  const trimmed = (cmd: string, args: string[]): string => {
    const result = io.exec(cmd, args);
    return result.status === 0 ? result.stdout.replace(/\n+$/, '') : '';
  };
  const out: string[] = [];
  for (const ws of liveWorkspaces) {
    if (typeof ws.id !== 'string') continue;
    const record = getWorkspace(io, ws.id);
    const path = record === null ? undefined : record['worktreePath'];
    if (typeof path !== 'string' || path === '') continue; // `.worktreePath // empty`
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    const gitDir = trimmed('git', ['-C', path, 'rev-parse', '--git-dir']);
    const commonDir = trimmed('git', ['-C', path, 'rev-parse', '--git-common-dir']);
    if (gitDir === commonDir) out.push(ws.id);
  }
  return out;
}

/**
 * One reconcile pass over this project's board. Throws with sync.sh's message
 * on the failures the bash die()d on; the caller (runReconcile, or a cycle
 * step) owns the exit code.
 */
export async function reconcileVerb(io: PollIo = realPollIo()): Promise<void> {
  const orch = loadRoot();
  const { boardDir, projectKey } = resolveBoardDir();
  const boardFile = join(boardDir, 'board.json');
  if (!existsSync(boardFile)) throw new Error(`no board at ${boardFile}`);
  const at = nowIso();

  // collect_status: skip malformed files with sync.sh's exact warning, then
  // `select(.workspaceId != null)` — jq's `!= null`, so a false workspaceId
  // stays, exactly as the bash kept it. The inbox itself (every *.json by
  // filename, malformed included) rides along because the prune walks the
  // DIRECTORY, not the surviving votes — sync.sh's `basename "$f" .json`.
  const inboxRead = readAgentInbox(orch.workspacesDir);
  for (const warning of inboxRead.warnings) io.warn(warning);
  const inbox = inboxRead.value;
  const statuses = inbox
    .map((f) => f.status)
    .filter((s): s is AgentStatus => s !== undefined)
    .filter((s) => s.workspaceId !== null && s.workspaceId !== undefined);

  // Live workspaces, scoped to this board's projects — the same filter poll.sh
  // uses, and the reason the prune is safe at all (see reconcile.ts's notes).
  // Any auth or CLI failure reads as [], which disarms the prune and rule 3.
  const config = readConfig(orch);
  const projectIds = configuredProjectIds(config.repos);
  let liveWorkspaces: WorkspaceRef[] = [];
  if (authed(io)) {
    liveWorkspaces = filterToConfiguredProjects(listLocalWorkspaces(io), projectIds).map(
      (raw) => {
        // sync.sh's `{id, branch, name}` projection: absent keys become null,
        // and no row is dropped — the list's LENGTH arms the guards.
        const row = raw as Obj;
        return {
          id: (row['id'] ?? null) as string,
          branch: (row['branch'] ?? null) as string | null,
          name: (row['name'] ?? null) as string | null,
        };
      },
    );
  }

  const { prs, mergedNumbers } = collectPrSignals(boardDir);
  const primaries = primaryWorkspaceIds(io, liveWorkspaces);

  // The reconcile itself runs INSIDE the locked write, against the board as it
  // is under the lock — the same file sync.sh's jq read while holding it.
  let result: ReconcileResult | undefined;
  await writeBoard(
    boardDir,
    (board) => {
      if (!Array.isArray(board['items'])) {
        // sync.sh's `.items[]` died here and atomic_json refused the write.
        throw new Error(`edit of ${boardFile} failed — .items is not an array, file left unchanged`);
      }
      result = reconcile({
        board: board as unknown as BoardDoc,
        statuses,
        inbox,
        liveWorkspaces,
        prs,
        mergedNumbers,
        primaryWorkspaceIds: primaries,
        at,
      });
      return result.board as unknown as Obj;
    },
    projectKey,
  );
  const outcome = result!;

  // The prune: bash rm -f'd before its write and printed unconditionally; the
  // ids are the FILENAMES reconcile judged (basename sans .json, malformed
  // files included), so the unlink hits the exact file the decision was about.
  // Only the deletion moved to after the lock released.
  for (const wsid of outcome.prunedStatusFiles) {
    try {
      unlinkSync(join(orch.workspacesDir, `${wsid}.json`));
    } catch {
      // rm -f: a file already gone is already pruned
    }
    console.log(`  pruned orphan status file ${wsid.slice(0, 8)}`);
  }

  for (const line of outcome.stdout) console.log(line);
  for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
}

// ── argv surface ──────────────────────────────────────────────────────────────

function die(message: string): never {
  process.stderr.write(`BLOCKED: ${message}\n`);
  process.exit(1);
}

/** `board reconcile` — sync.sh took no flags, and neither does this. */
export async function runReconcile(argv: string[]): Promise<void> {
  for (const arg of argv) die(`unknown argument: ${arg}`);
  try {
    await reconcileVerb();
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
}
