// The reader tests: BoardKit's BoardDecodingTests, ported case for case, plus
// the lib.sh status-file guard and a signals decode over the frozen fixture the
// Swift tests already use. Same inputs, so the three implementations can be
// held to the same answers.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { readAgentStatuses, readBoardItems, readGithubSignals } from '../src/read.js';

const fixturesDir = fileURLToPath(new URL('../../Tests/BoardKitTests/Fixtures/', import.meta.url));

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-read-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function readBoard(boardJSON: string) {
  const dir = tempDir();
  const file = join(dir, 'board.json');
  writeFileSync(file, boardJSON);
  return readBoardItems(file);
}

describe('readBoardItems', () => {
  test('a bare number in pr reads as the PR number, not as a lost item', () => {
    // The exact corruption observed on a live board: `"pr": 938`.
    const { value } = readBoard(
      '{"items":[{"id":"i1","title":"T-1 - Item","state":"pr-open","pr":938}]}',
    );
    expect(value).toHaveLength(1);
    expect(value[0]?.pr?.number).toBe(938);
  });

  test('one corrupt item costs that item, not the board', () => {
    const { value, warnings } = readBoard(`{"items":[
      {"id":"i1","title":"ok","state":"pr-open"},
      {"id":42,"title":true},
      {"id":"i3","title":"also ok","state":"building"}]}`);
    expect(value.map((item) => item.id)).toEqual(['i1', 'i3']);
    expect(warnings).toHaveLength(1);
  });

  test('a well-formed pr object still decodes in full', () => {
    const { value } = readBoard(`{"items":[{"id":"i1","title":"t","state":"pr-open",
      "pr":{"number":10,"url":"https://gh/10","isDraft":true}}]}`);
    expect(value[0]?.pr?.number).toBe(10);
    expect(value[0]?.pr?.url).toBe('https://gh/10');
    expect(value[0]?.pr?.isDraft).toBe(true);
  });

  test('a missing board.json is an empty board, not an error', () => {
    const { value, warnings } = readBoardItems(join(tempDir(), 'board.json'));
    expect(value).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe('readAgentStatuses', () => {
  test('a status file with a bare pr number is skipped, with a warning', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'aaa.json'), '{"workspaceId":"ws1","state":"building"}');
    // The shape status_file_valid exists for: pr must be an object or null.
    writeFileSync(join(dir, 'bbb.json'), '{"workspaceId":"ws2","state":"fixing","pr":938}');
    const { value, warnings } = readAgentStatuses(dir);
    expect(value.map((status) => status.workspaceId)).toEqual(['ws1']);
    expect(warnings).toEqual(['skipped malformed agent status file: bbb.json']);
  });

  test('an unparseable file is skipped the same way', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'good.json'), '{"workspaceId":"ws1"}');
    writeFileSync(join(dir, 'torn.json'), '{"workspaceId":');
    const { value, warnings } = readAgentStatuses(dir);
    expect(value).toHaveLength(1);
    expect(warnings).toEqual(['skipped malformed agent status file: torn.json']);
  });

  test('the jq // quirk: "pr": false passes as if pr were absent', () => {
    // lib.sh reads `.pr // null`, and jq's // swallows false as well as null.
    const dir = tempDir();
    writeFileSync(join(dir, 'ws.json'), '{"workspaceId":"ws1","pr":false}');
    const { value, warnings } = readAgentStatuses(dir);
    expect(value).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  test('a missing inbox directory is an empty inbox', () => {
    const { value, warnings } = readAgentStatuses(join(tempDir(), 'nope'));
    expect(value).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe('readGithubSignals', () => {
  test('decodes the frozen signals fixture the Swift tests use', () => {
    const { value, warnings } = readGithubSignals(join(fixturesDir, 'github.json'));
    expect(warnings).toEqual([]);

    // expected-gh.json freezes the enrichment per open PR: number → ciState,
    // previewUrl, unresolvedThreads. The signal rows must carry the same.
    const expected = JSON.parse(readFileSync(join(fixturesDir, 'expected-gh.json'), 'utf8')) as Record<
      string,
      { ciState: string; previewUrl: string; unresolvedThreads: number }
    >;
    expect(value.prs).toHaveLength(Object.keys(expected).length);
    for (const [number, facts] of Object.entries(expected)) {
      const pr = value.prs.find((candidate) => candidate.number === Number(number));
      expect(pr, `PR #${number} missing from decoded signals`).toBeDefined();
      expect(pr?.ciState).toBe(facts.ciState);
      expect(pr?.previewUrl).toBe(facts.previewUrl);
      expect(pr?.unresolvedThreads).toBe(facts.unresolvedThreads);
    }

    // The fields only the signals carry survive the decode.
    const approved = value.prs.find((pr) => pr.number === 442);
    expect(approved?.repo).toBe('acme/platform');
    expect(approved?.latestActivityAt).toBe('2026-07-30T16:56:52Z');
    expect(approved?.reviewStates).toEqual({ 'sam': 'APPROVED' });
    // reviewDecision "" is a value, not an absence — jq's // keeps it.
    const noDecision = value.prs.find((pr) => pr.number === 444);
    expect(noDecision?.reviewDecision).toBe('');

    expect(value.mergedNumbers.size).toBe(20);
    expect(value.mergedNumbers.has(434)).toBe(true);
    // The fixture predates the closed[] list; absence reads as none.
    expect(value.closedUnmerged).toEqual([]);
  });

  test('a closed row that somehow carries mergedAt never reads as closed-unmerged', () => {
    const dir = tempDir();
    const file = join(dir, 'github.json');
    writeFileSync(
      file,
      JSON.stringify({
        repos: [
          {
            repo: 'acme/platform',
            open: [],
            merged: [],
            closed: [
              { number: 7, title: 'abandoned', closedAt: '2026-08-01T00:00:00Z', mergedAt: null },
              { number: 8, title: 'landed', closedAt: '2026-08-01T00:00:00Z', mergedAt: '2026-08-01T00:00:00Z' },
            ],
          },
        ],
      }),
    );
    const { value } = readGithubSignals(file);
    expect(value.closedUnmerged.map((pr) => pr.number)).toEqual([7]);
    expect(value.closedUnmerged[0]?.closedAt).toBe('2026-08-01T00:00:00Z');
  });

  test('a missing signals file is an empty snapshot', () => {
    const { value, warnings } = readGithubSignals(join(tempDir(), 'github.json'));
    expect(value.prs).toEqual([]);
    expect(value.mergedNumbers.size).toBe(0);
    expect(value.closedUnmerged).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
