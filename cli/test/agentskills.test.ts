// board agents install-skills: mirror the implementer skill into the Codex and
// OpenCode skill directories.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { installSkills } from '../src/ops/agentskills.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'board-skills-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function seedClaudeSkill(home: string): void {
  const dir = join(home, '.claude', 'skills', 'superset-implementer');
  mkdirSync(join(dir, 'reference'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '# implementer contract\n');
  writeFileSync(join(dir, 'reference', 'quality-bar.md'), 'the bar\n');
}

describe('installSkills', () => {
  test('mirrors the Claude skill (and its reference/) into codex and opencode', () => {
    const home = tmp();
    seedClaudeSkill(home);
    const result = installSkills(undefined, { HOME: home });
    expect(result.source).toBe(join(home, '.claude', 'skills', 'superset-implementer'));
    expect(result.installed.map((i) => i.agent).sort()).toEqual(['codex', 'opencode']);

    const codex = join(home, '.codex', 'skills', 'superset-implementer');
    const opencode = join(home, '.config', 'opencode', 'skill', 'superset-implementer');
    for (const dir of [codex, opencode]) {
      expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('implementer contract');
      expect(existsSync(join(dir, 'reference', 'quality-bar.md'))).toBe(true);
    }
  });

  test('honours XDG_CONFIG_HOME for the opencode path', () => {
    const home = tmp();
    const xdg = tmp();
    seedClaudeSkill(home);
    installSkills(undefined, { HOME: home, XDG_CONFIG_HOME: xdg });
    expect(existsSync(join(xdg, 'opencode', 'skill', 'superset-implementer', 'SKILL.md'))).toBe(true);
  });

  test('a --from override is used as the source', () => {
    const home = tmp();
    const from = join(tmp(), 'my-skill');
    mkdirSync(from, { recursive: true });
    writeFileSync(join(from, 'SKILL.md'), '# custom\n');
    const result = installSkills(from, { HOME: home });
    expect(result.source).toBe(from);
    expect(readFileSync(join(home, '.codex', 'skills', 'superset-implementer', 'SKILL.md'), 'utf8'))
      .toContain('custom');
  });

  test('no skill anywhere returns a null source and installs nothing', () => {
    const home = tmp();
    const result = installSkills(undefined, { HOME: home });
    expect(result.source).toBeNull();
    expect(result.installed).toEqual([]);
  });

  test('re-running refreshes rather than failing', () => {
    const home = tmp();
    seedClaudeSkill(home);
    installSkills(undefined, { HOME: home });
    expect(() => installSkills(undefined, { HOME: home })).not.toThrow();
  });
})
