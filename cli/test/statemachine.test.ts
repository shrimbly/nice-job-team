// board_set's semantics as tests/run.sh pinned them — the flat merge, the
// history entry appended only on a state change, the by naming the writer —
// plus the state vocabulary itself, which board-set.sh prints space-joined in
// its "unknown state" error and so has an order worth freezing.

import { describe, expect, test } from 'vitest';
import { AGENT_STATES, KNOWN_STATES, TERMINAL, applyItemPatch } from '../src/statemachine.js';

/** run.sh's live item, as board_set finds it. */
const ITEM = {
  id: 'itm_1',
  slug: 'live-item',
  title: 'T-1 - Live item',
  state: 'dispatched',
  workspaceId: 'ws-good',
  pr: null,
  history: [{ at: '2026-08-01T00:00:00Z', from: 'proposed', to: 'dispatched' }],
};

const AT = '2026-09-02T12:00:00Z';

describe('the state vocabulary', () => {
  test('KNOWN_STATES matches board-set.sh, order included', () => {
    // The order is output: board-set's error prints the list space-joined.
    expect(KNOWN_STATES.join(' ')).toBe(
      'proposed dispatched building awaiting-approval pr-open fixing blocked ready merged orphaned rejected closed abandoned',
    );
  });

  test('the terminal trio, and only it', () => {
    expect([...TERMINAL].sort()).toEqual(['abandoned', 'closed', 'rejected']);
    for (const state of TERMINAL) expect(KNOWN_STATES).toContain(state);
  });

  test('AGENT_STATES are the known states with a workspace attached', () => {
    expect([...AGENT_STATES].sort()).toEqual([
      'awaiting-approval',
      'blocked',
      'building',
      'fixing',
      'merged',
      'pr-open',
    ]);
    for (const state of AGENT_STATES) {
      expect(KNOWN_STATES).toContain(state);
      expect(TERMINAL.has(state)).toBe(false);
    }
  });
});

describe('applyItemPatch', () => {
  test('a state change merges flat and appends the history entry itself', () => {
    // run.sh: board-set --item itm_1 --state building --workspace-id ws-new
    const next = applyItemPatch(
      ITEM,
      { state: 'building', workspaceId: 'ws-new' },
      'board-set',
      AT,
    );
    expect(next.state).toBe('building');
    expect(next.workspaceId).toBe('ws-new');
    expect(next.history).toHaveLength(2);
    expect(next.history[1]).toEqual({
      at: AT,
      from: 'dispatched',
      to: 'building',
      by: 'board-set',
    });
    // The input is not touched.
    expect(ITEM.state).toBe('dispatched');
    expect(ITEM.history).toHaveLength(1);
  });

  test('no by key when the caller gave none — "" and absent both mean none', () => {
    // lib.sh spells "no by" as --arg by "", and the jq checks $by != "".
    for (const by of [undefined, '']) {
      const next = applyItemPatch(ITEM, { state: 'building' }, by, AT);
      expect(next.history[1]).toEqual({ at: AT, from: 'dispatched', to: 'building' });
    }
  });

  test('a same-state patch merges without a history entry', () => {
    const next = applyItemPatch(ITEM, { state: 'dispatched', outcome: 'noted' }, 'board-set', AT);
    expect(next.history).toHaveLength(1);
    expect((next as Record<string, unknown>)['outcome']).toBe('noted');
  });

  test('a stateless patch merges without a history entry', () => {
    const next = applyItemPatch(ITEM, { workspaceId: null }, 'board-set', AT);
    expect(next.history).toHaveLength(1);
    // Flat merge: an explicit null in the patch overwrites, as jq's `+` does.
    expect(next.workspaceId).toBeNull();
  });

  test('history is reassigned from the old item — a patch can never set it', () => {
    const smuggled = applyItemPatch(ITEM, { history: [{ at: 'X', to: 'forged' }] }, undefined, AT);
    expect(smuggled.history).toEqual(ITEM.history);
  });

  test('an item without history gains [], with the entry when the state moved', () => {
    // board_set's `($old.history // []) + ...` writes .history on EVERY patch.
    const bare = { id: 'itm_9', slug: 's', title: 't', state: 'proposed' };
    const still = applyItemPatch(bare, { outcome: 'x' }, undefined, AT);
    expect((still as Record<string, unknown>)['history']).toEqual([]);
    const moved = applyItemPatch(bare, { state: 'rejected' }, 'orchestrator', AT);
    expect((moved as Record<string, unknown>)['history']).toEqual([
      { at: AT, from: 'proposed', to: 'rejected', by: 'orchestrator' },
    ]);
  });

  test('a null history normalizes to [] on any write, like the jq //', () => {
    const item = { id: 'i', slug: 's', title: 't', state: 'proposed', history: null };
    const next = applyItemPatch(item, { outcome: 'x' }, undefined, AT);
    expect((next as Record<string, unknown>)['history']).toEqual([]);
  });

  test('the jq truthiness quirk: a null or false patch state appends nothing', () => {
    // `$patch.state?` gates the entry with jq truthiness — null and false are
    // falsy, so they merge (badly) without a history line. board-set.sh can't
    // produce this shape; the port keeps the semantics anyway.
    for (const state of [null, false]) {
      const next = applyItemPatch(ITEM, { state }, 'board-set', AT);
      expect((next as Record<string, unknown>)['state']).toBe(state);
      expect(next.history).toHaveLength(1);
    }
  });

  test('an empty-string state is truthy to jq and gets its entry', () => {
    const next = applyItemPatch(ITEM, { state: '' }, undefined, AT);
    expect(next.history[1]).toEqual({ at: AT, from: 'dispatched', to: '' });
  });
});
