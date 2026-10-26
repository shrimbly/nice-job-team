// The agent registry: model-alias resolution and the create-args each agent
// kind produces. The live dispatch wiring is covered in dispatch.test.ts.

import { describe, expect, test } from 'vitest';
import { agentCreateArgs, isKnownAgent, resolveModel } from '../src/ops/agents.js';

describe('isKnownAgent', () => {
  test('accepts presets and opencode, rejects the rest', () => {
    for (const a of ['claude', 'codex', 'gemini', 'copilot', 'amp', 'opencode']) {
      expect(isKnownAgent(a), a).toBe(true);
    }
    expect(isKnownAgent('cursor')).toBe(false);
    expect(isKnownAgent('')).toBe(false);
  });
});

describe('resolveModel', () => {
  const models = { 'glm 5.3': 'zhipuai/glm-4.6', 'Sonnet': 'anthropic/claude-sonnet' };
  test('resolves an alias case-insensitively', () => {
    expect(resolveModel(models, 'glm 5.3')).toBe('zhipuai/glm-4.6');
    expect(resolveModel(models, 'GLM 5.3')).toBe('zhipuai/glm-4.6');
    expect(resolveModel(models, ' sonnet ')).toBe('anthropic/claude-sonnet');
  });
  test('passes an unlisted name through untouched (a raw id always works)', () => {
    expect(resolveModel(models, 'openai/gpt-5')).toBe('openai/gpt-5');
    expect(resolveModel(undefined, 'zhipuai/glm-4.6')).toBe('zhipuai/glm-4.6');
  });
  test('empty stays empty', () => {
    expect(resolveModel(models, '')).toBe('');
    expect(resolveModel(models, '   ')).toBe('');
  });
});

describe('agentCreateArgs', () => {
  const base = { prompt: 'do the work', effort: '', model: '', supportsEffort: false };

  test('a preset agent takes --agent and --prompt', () => {
    expect(agentCreateArgs({ ...base, agent: 'codex' })).toEqual([
      '--agent', 'codex', '--prompt', 'do the work',
    ]);
  });

  test('effort is appended only when the CLI supports it', () => {
    expect(agentCreateArgs({ ...base, agent: 'codex', effort: 'high', supportsEffort: true }))
      .toEqual(['--agent', 'codex', '--prompt', 'do the work', '--effort', 'high']);
    expect(agentCreateArgs({ ...base, agent: 'codex', effort: 'high', supportsEffort: false }))
      .toEqual(['--agent', 'codex', '--prompt', 'do the work']);
  });

  test('opencode rides --command with the model and the shell-quoted prompt', () => {
    const args = agentCreateArgs({ ...base, agent: 'opencode', model: 'zhipuai/glm-4.6' });
    expect(args[0]).toBe('--command');
    expect(args).toHaveLength(2);
    expect(args[1]).toBe('opencode run -m zhipuai/glm-4.6 do\\ the\\ work');
    // No --agent / --prompt for a command agent.
    expect(args).not.toContain('--agent');
    expect(args).not.toContain('--prompt');
  });

  test('opencode with no model omits -m', () => {
    expect(agentCreateArgs({ ...base, agent: 'opencode' })[1]).toBe('opencode run do\\ the\\ work');
  });

  test('a prompt with newlines and quotes is safely quoted for the command', () => {
    const args = agentCreateArgs({
      ...base, agent: 'opencode', model: 'x/y',
      prompt: "line one\nsays \"hi\"",
    });
    // $'...' form once control chars are involved; the shell reassembles it.
    expect(args[1]).toContain('opencode run -m x/y ');
    expect(args[1]).toContain('\\n');
  });
})
