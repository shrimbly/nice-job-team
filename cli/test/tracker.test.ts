// The tracker seam: the github-issues adapter's mapping (labels → priority,
// id = String(number), the canonical issue URL), resolveTracker's selection
// rules, the poll integration over a stubbed gh, and the ticket-link template
// on a github-issues board item through the same config → assemble path the
// render verb takes. Everything io-seamed and temp-rooted: no live gh, no
// network, nothing under ~/.claude or ~/.superset.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { assemble, assemblerConfig } from '../src/cards/assemble.js';
import type { ProjectSnapshot } from '../src/cards/assemble.js';
import { runPoll } from '../src/ops/poll.js';
import {
  collectGithubIssuesTasks,
  githubIssuesTracker,
  priorityFromLabels,
  trackerRepoName,
} from '../src/tracker/github-issues.js';
import { linearTracker, markdownTracker, resolveTracker } from '../src/tracker/index.js';
import type {
  BoardConfigFile,
  ExecResult,
  OrchRoot,
  PollIo,
  TrackerTask,
} from '../src/types.js';

const NOW_ISO = '2026-09-02T12:00:00Z';

// ── temp roots ────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-tracker-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

// ── io stub ───────────────────────────────────────────────────────────────────

function ok(stdout: string): ExecResult {
  return { status: 0, stdout, stderr: '' };
}
const FAIL: ExecResult = { status: 1, stdout: '', stderr: 'stubbed failure' };

interface Call {
  cmd: string;
  args: string[];
}

/** io whose gh at /stub/gh answers `issue list` and nothing else succeeds. */
function makeIo(
  world: { issues?: unknown; issuesRaw?: string; issuesFail?: boolean },
  env: NodeJS.ProcessEnv = {},
): { io: PollIo; calls: Call[]; warnings: string[] } {
  const calls: Call[] = [];
  const warnings: string[] = [];
  const io: PollIo = {
    exec(cmd, args) {
      calls.push({ cmd, args });
      if (cmd === '/stub/gh') {
        if (args[0] === 'issue' && args[1] === 'list') {
          if (world.issuesFail === true) return FAIL;
          if (world.issuesRaw !== undefined) return ok(world.issuesRaw);
          return ok(JSON.stringify(world.issues ?? []));
        }
        // The poll's PR pass, when this io drives runPoll.
        if (args[0] === 'pr' && args[1] === 'list') return ok('[]');
        return FAIL;
      }
      return FAIL;
    },
    now: () => NOW_ISO,
    nowMs: () => Date.parse(NOW_ISO),
    homeDir: () => '/nonexistent-home',
    env,
    warn: (message) => warnings.push(message),
  };
  return { io, calls, warnings };
}

const ISSUES_CONFIG: BoardConfigFile = {
  operator: { githubLogin: 'dev' },
  repos: [{ name: 'o/r' }],
  tracker: { kind: 'github-issues' },
};

// ── The adapter's mapping ─────────────────────────────────────────────────────

describe('github-issues adapter', () => {
  test('labels map to priorities case-insensitively, most urgent label wins, default medium', () => {
    expect(priorityFromLabels([{ name: 'High' }])).toBe('high');
    expect(priorityFromLabels(['urgent'])).toBe('urgent');
    expect(priorityFromLabels([{ name: 'low' }, { name: 'urgent' }])).toBe('urgent');
    expect(priorityFromLabels([{ name: 'bug' }, { name: 'triage' }])).toBe('medium');
    expect(priorityFromLabels([])).toBe('medium');
    expect(priorityFromLabels(undefined)).toBe('medium');
    expect(priorityFromLabels([null, 42, { noName: true }])).toBe('medium');
  });

  test('openTasks maps issues to the TrackerTask shape, id as the plain number string', () => {
    const { io, calls } = makeIo({
      issues: [
        {
          number: 17,
          title: 'Fix the flaky test',
          labels: [{ name: 'high' }, { name: 'bug' }],
          updatedAt: '2026-09-01T00:00:00Z',
        },
      ],
    });
    const tasks = collectGithubIssuesTasks(io, ISSUES_CONFIG, '/stub/gh');
    expect(tasks).toEqual([
      {
        id: '17', // String(number) — no '#'; that spelling belongs to the synthesized 'github' kind
        title: 'Fix the flaky test',
        status: 'todo',
        priority: 'high',
        path: '',
        relPath: '',
        body: '',
      },
    ]);
    // The one gh call, exactly as specified.
    expect(calls).toEqual([
      {
        cmd: '/stub/gh',
        args: [
          'issue', 'list',
          '--repo', 'o/r',
          '--state', 'open',
          '--limit', '100',
          '--json', 'number,title,labels,updatedAt',
        ],
      },
    ]);
  });

  test('sorts by priority rank, then newest activity, then number — whatever order gh returned', () => {
    const { io } = makeIo({
      issues: [
        { number: 3, title: 'medium old', labels: [], updatedAt: '2026-08-01T00:00:00Z' },
        { number: 9, title: 'urgent', labels: [{ name: 'urgent' }], updatedAt: '2026-08-15T00:00:00Z' },
        { number: 5, title: 'medium new', labels: [], updatedAt: '2026-09-01T00:00:00Z' },
        { number: 4, title: 'medium new twin', labels: [], updatedAt: '2026-09-01T00:00:00Z' },
      ],
    });
    const ids = collectGithubIssuesTasks(io, ISSUES_CONFIG, '/stub/gh').map((t) => t.id);
    expect(ids).toEqual(['9', '5', '4', '3']);
  });

  test('malformed rows are skipped, not fatal; a missing title falls back to the number', () => {
    const { io } = makeIo({
      issues: [
        'not an object',
        { title: 'no number' },
        { number: 8, labels: [], updatedAt: '' },
      ],
    });
    const tasks = collectGithubIssuesTasks(io, ISSUES_CONFIG, '/stub/gh');
    expect(tasks.map((t) => [t.id, t.title])).toEqual([['8', '8']]);
  });

  test('every failure is silently []: no gh, gh nonzero, bad JSON, non-array, no repo', () => {
    expect(collectGithubIssuesTasks(makeIo({}).io, ISSUES_CONFIG, null)).toEqual([]);
    expect(
      collectGithubIssuesTasks(makeIo({ issuesFail: true }).io, ISSUES_CONFIG, '/stub/gh'),
    ).toEqual([]);
    expect(
      collectGithubIssuesTasks(makeIo({ issuesRaw: '{nope' }).io, ISSUES_CONFIG, '/stub/gh'),
    ).toEqual([]);
    expect(
      collectGithubIssuesTasks(makeIo({ issuesRaw: '{"a":1}' }).io, ISSUES_CONFIG, '/stub/gh'),
    ).toEqual([]);
    const noRepo = makeIo({ issues: [{ number: 1, title: 't' }] });
    expect(collectGithubIssuesTasks(noRepo.io, { repos: [] }, '/stub/gh')).toEqual([]);
    expect(noRepo.calls).toEqual([]); // no repo means no gh call at all
  });

  test('SUPERSET_ORCH_REPO overrides the configured repo, as the markdown tracker honours it', () => {
    const { io, calls } = makeIo({ issues: [] }, { SUPERSET_ORCH_REPO: 'other/repo' });
    expect(trackerRepoName(ISSUES_CONFIG, io.env)).toBe('other/repo');
    collectGithubIssuesTasks(io, ISSUES_CONFIG, '/stub/gh');
    expect(calls[0]!.args).toContain('other/repo');
  });

  test('issueUrl is the canonical issues URL, an explicit template wins, no repo means null', () => {
    expect(githubIssuesTracker(ISSUES_CONFIG, { env: {} }).issueUrl('42')).toBe(
      'https://github.com/o/r/issues/42',
    );
    const templated: BoardConfigFile = {
      ...ISSUES_CONFIG,
      tracker: { kind: 'github-issues', issueUrl: 'https://github.com/o/r/issues/{key}?ref=b' },
    };
    expect(githubIssuesTracker(templated, { env: {} }).issueUrl('42')).toBe(
      'https://github.com/o/r/issues/42?ref=b',
    );
    expect(githubIssuesTracker({ repos: [] }, { env: {} }).issueUrl('42')).toBeNull();
  });
});

// ── resolveTracker ────────────────────────────────────────────────────────────

describe('resolveTracker', () => {
  test('selects by tracker.kind; absent block and absent kind both mean linear', () => {
    expect(resolveTracker({}).kind).toBe('linear');
    expect(resolveTracker({ tracker: {} }).kind).toBe('linear');
    expect(resolveTracker({ tracker: { kind: 'markdown' } }).kind).toBe('markdown');
    expect(resolveTracker(ISSUES_CONFIG).kind).toBe('github-issues');
  });

  test('linear links from the workspace only while the block is absent — an explicit block is verbatim', () => {
    const implicit: BoardConfigFile = { operator: { linearWorkspace: 'acme' } };
    expect(resolveTracker(implicit).issueUrl('ENG-1')).toBe(
      'https://linear.app/acme/issue/ENG-1',
    );
    expect(resolveTracker({}).issueUrl('ENG-1')).toBeNull(); // no workspace, never a half URL
    // An explicit {kind: linear} with no issueUrl links nothing — exactly what
    // cards/build.ts's resolveTicket makes of the same config.
    const explicit: BoardConfigFile = {
      operator: { linearWorkspace: 'acme' },
      tracker: { kind: 'linear' },
    };
    expect(linearTracker(explicit).issueUrl('ENG-1')).toBeNull();
    // linear collects nothing on the free tier: a Linear backlog is a scout job.
    expect(resolveTracker(implicit).openTasks(makeIo({}).io, implicit)).toEqual([]);
  });

  test('markdown delegates openTasks to ops/tasks.ts over the repo, and links via the template', async () => {
    const repoRoot = tempDir();
    mkdirSync(join(repoRoot, '.tasks'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.tasks', 'T-1.md'),
      '---\nid: T-1\ntitle: Do a thing\nstatus: todo\npriority: high\n---\nbody\n',
    );
    writeFileSync(
      join(repoRoot, '.tasks', 'T-2.md'),
      '---\nid: T-2\ntitle: Done already\nstatus: done\n---\n',
    );
    const config: BoardConfigFile = {
      repos: [{ name: 'o/r', localPath: repoRoot }],
      tracker: { kind: 'markdown', issueUrl: 'https://github.com/o/r/blob/main/.tasks/{key}.md' },
    };
    const tracker = markdownTracker(config);
    const tasks = (await tracker.openTasks(makeIo({}).io, config)) as TrackerTask[];
    expect(tasks.map((t) => t.id)).toEqual(['T-1']); // open only — done stays out
    expect(tracker.issueUrl('T-1')).toBe('https://github.com/o/r/blob/main/.tasks/T-1.md');
  });

  test('an unknown kind degrades: collects nothing, links only through its own template', () => {
    const config: BoardConfigFile = {
      tracker: { kind: 'jira', issueUrl: 'https://acme.atlassian.net/browse/{key}' },
    };
    const tracker = resolveTracker(config);
    expect(tracker.kind).toBe('jira');
    expect(tracker.openTasks(makeIo({}).io, config)).toEqual([]);
    expect(tracker.issueUrl('X-1')).toBe('https://acme.atlassian.net/browse/X-1');
    expect(resolveTracker({ tracker: { kind: 'jira' } }).issueUrl('X-1')).toBeNull();
  });
});

// ── runPoll integration ───────────────────────────────────────────────────────

const HEADER_BACKLOG =
  '── Backlog (github-issues tracker, not yet on the board) ────────────';

function layout(): { root: OrchRoot; projectDir: string } {
  const base = tempDir();
  const root: OrchRoot = {
    root: base,
    configPath: join(base, 'config.json'),
    workspacesDir: join(base, 'workspaces'),
  };
  mkdirSync(root.workspacesDir, { recursive: true });
  const projectDir = join(base, 'p', 'proj');
  mkdirSync(projectDir, { recursive: true });
  return { root, projectDir };
}

describe('runPoll with a github-issues tracker', () => {
  test('collects the backlog into signals/tasks.json and prints the Backlog section', () => {
    const { root, projectDir } = layout();
    // Issue 9 is already on the board as a github-issues item — the summary
    // must skip it, and only the kind that matches the tracker claims a task.
    writeFileSync(
      join(projectDir, 'board.json'),
      JSON.stringify({
        items: [
          {
            id: 'itm_1',
            title: 't',
            state: 'building',
            source: { kind: 'github-issues', externalId: '9' },
          },
        ],
      }),
    );
    const { io } = makeIo({
      issues: [
        { number: 17, title: 'Fix the flaky test', labels: [{ name: 'high' }], updatedAt: '2026-09-01T00:00:00Z' },
        { number: 21, title: 'Ship the tracker', labels: [], updatedAt: '2026-09-02T00:00:00Z' },
        { number: 9, title: 'Already on the board', labels: [{ name: 'urgent' }], updatedAt: '2026-09-01T00:00:00Z' },
      ],
    });
    const summary = runPoll(root, projectDir, ISSUES_CONFIG, io, { ghPath: '/stub/gh' });
    const lines = summary.split('\n');

    // The section keeps poll.sh's line shape; the header names the kind that
    // filled it, padded to poll.sh's 69 columns.
    const at = lines.indexOf(HEADER_BACKLOG);
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at + 1, at + 3)).toEqual([
      '  todo/high  17  Fix the flaky test',
      '  todo/medium  21  Ship the tracker',
    ]);
    expect(summary).not.toContain('Already on the board');

    // The signal file carries every open issue — the board filter is display-only.
    const doc = JSON.parse(readFileSync(join(projectDir, 'signals', 'tasks.json'), 'utf8'));
    expect(doc.collectedAt).toBe(NOW_ISO);
    expect(doc.tasks.map((t: TrackerTask) => t.id)).toEqual(['9', '17', '21']);
    expect(doc.tasks[1]).toEqual({
      id: '17',
      title: 'Fix the flaky test',
      status: 'todo',
      priority: 'high',
      path: '',
      relPath: '',
      body: '',
    });
  });

  test('a failing gh is a silent empty backlog: [] in the signal, no section at all', () => {
    const { root, projectDir } = layout();
    const { io, warnings } = makeIo({ issuesFail: true });
    const summary = runPoll(root, projectDir, ISSUES_CONFIG, io, { ghPath: '/stub/gh' });
    expect(summary).not.toContain(HEADER_BACKLOG);
    const doc = JSON.parse(readFileSync(join(projectDir, 'signals', 'tasks.json'), 'utf8'));
    expect(doc.tasks).toEqual([]);
    expect(warnings.filter((w) => w.includes('issue'))).toEqual([]);
  });

  test('a linear (or absent) tracker still collects no tasks', () => {
    const { root, projectDir } = layout();
    const { io, calls } = makeIo({ issues: [{ number: 1, title: 'x' }] });
    const config: BoardConfigFile = { ...ISSUES_CONFIG, tracker: { kind: 'linear' } };
    runPoll(root, projectDir, config, io, { ghPath: '/stub/gh' });
    const doc = JSON.parse(readFileSync(join(projectDir, 'signals', 'tasks.json'), 'utf8'));
    expect(doc.tasks).toEqual([]);
    expect(calls.some((c) => c.args[0] === 'issue')).toBe(false);
  });
});

// ── Ticket links on the cards ─────────────────────────────────────────────────

describe('github-issues ticket links through the render path', () => {
  const CONFIG_FILE: BoardConfigFile = {
    operator: { linearWorkspace: '' },
    repos: [{ name: 'o/r', key: 'proj' }],
    tracker: { kind: 'github-issues', issueUrl: 'https://github.com/o/r/issues/{key}' },
  };

  function snapshotOf(items: ProjectSnapshot['snapshot']['items']): ProjectSnapshot {
    return {
      project: { key: 'proj', root: '/tmp/proj' },
      snapshot: {
        items,
        agents: [],
        workspaces: [],
        mergedPRNumbers: new Set<number>(),
        isPresent: true,
      },
    };
  }

  test('a board item with source.kind github-issues links via the config template', () => {
    // The exact path `board render` takes: config file → assemblerConfig →
    // assemble → the card chain's ticketChip. No extra wiring — the tracker
    // block IS the template.
    const config = assemblerConfig(CONFIG_FILE);
    expect(config.ticket).toEqual({
      kind: 'github-issues',
      urlTemplate: 'https://github.com/o/r/issues/{key}',
    });
    const cards = assemble(
      [
        snapshotOf([
          {
            id: 'itm_1',
            title: 'Fix the flaky test',
            state: 'building',
            source: { kind: 'github-issues', externalId: '17' },
          },
        ]),
      ],
      [],
      config,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]!.trackerKind).toBe('github-issues');
    expect(cards[0]!.card.ticketKey).toBe('17');
    expect(cards[0]!.card.ticketUrl).toBe('https://github.com/o/r/issues/17');
  });

  test("the synthesized 'github' kind stays excluded from ticket links — it is not 'github-issues'", () => {
    // An unclaimed PR synthesizes an item with source {kind: 'github',
    // externalId: '#7'} — the PR's own number, which already has a chip. The
    // one-character-different kind string is deliberate and must never link.
    const cards = assemble(
      [snapshotOf([])],
      [{ number: 7, title: 'A PR', ciState: 'unknown', unresolvedThreads: 0 }],
      assemblerConfig(CONFIG_FILE),
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]!.card.ticketKey).toBeNull();
    expect(cards[0]!.card.ticketUrl).toBeNull();
  });
});
