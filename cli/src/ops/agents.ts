// Which coding agent a dispatch spawns, and how to ask Superset for it.
//
// Two shapes of agent, because Superset offers two doors:
//   - A PRESET (claude, codex, gemini, copilot, amp) is a first-class Superset
//     agent: `workspaces create --agent <preset> --prompt <p>`, and it accepts
//     `--effort`. This is the path for anything Superset ships a preset for.
//   - OpenCode is not a preset, but it is a headless CLI that takes a model per
//     run — which is the whole point of it here ("use glm-4.6 in opencode").
//     So it rides `workspaces create --command "opencode run -m <model> <p>"`:
//     no Superset agent session, just the command run in the fresh workspace.
//     The board still tracks it the way it tracks a cloud agent — through the
//     status file the implementer skill writes and through GitHub.
//
// The implementer contract itself is provider-agnostic: SKILL.md is the open
// Agent-Skills format that Codex, OpenCode, Gemini and the rest all load, and
// the status verbs are plain CLI. The one Claude-only convenience, the Stop
// hook that runs `board status observe`, has an explicit fallback in the skill
// for agents whose runtime has no such hook.

import { shellQuote } from './dispatch.js';

/** Superset's built-in agent presets — everything `--agent` takes by name. */
export const PRESET_AGENTS = new Set(['claude', 'codex', 'gemini', 'copilot', 'amp']);
/** Agents the board drives through `--command` rather than `--agent`. */
export const COMMAND_AGENTS = new Set(['opencode']);

export function isKnownAgent(name: string): boolean {
  return PRESET_AGENTS.has(name) || COMMAND_AGENTS.has(name);
}

/**
 * A friendly model name → the `provider/model` string the runner wants.
 * `models` in config is the alias table ("glm 5.3" → "zhipuai/glm-4.6"); an
 * unlisted name passes through untouched, so an operator can always hand the
 * exact id. Case-folded and space-trimmed so "GLM 5.3" and "glm 5.3" match.
 */
export function resolveModel(models: Record<string, string> | undefined, name: string): string {
  const raw = name.trim();
  if (raw === '') return '';
  if (models !== undefined) {
    const wanted = raw.toLowerCase();
    for (const [alias, target] of Object.entries(models)) {
      if (typeof target === 'string' && alias.trim().toLowerCase() === wanted) return target;
    }
  }
  return raw;
}

export interface InvocationInputs {
  agent: string;
  prompt: string;
  /** Reasoning effort for preset agents; ignored by command agents. */
  effort: string;
  /** provider/model, already alias-resolved; only command agents use it. */
  model: string;
  /** Whether the live `workspaces create` accepts --effort (probed by caller). */
  supportsEffort: boolean;
}

/**
 * The arguments to append to `workspaces create` for one agent. The common
 * args (--local, --project, --name, --branch, --base-branch) are the caller's;
 * this decides only how the agent and its prompt are handed over.
 */
export function agentCreateArgs(input: InvocationInputs): string[] {
  if (COMMAND_AGENTS.has(input.agent)) {
    if (input.agent === 'opencode') {
      // `opencode run [-m provider/model] "<prompt>"` — the prompt is the
      // message argument, shell-quoted because it rides inside one --command
      // string that a shell will re-split. No --agent, no --prompt: Superset
      // is only running a command here, not attaching an agent session.
      const model = input.model === '' ? '' : `-m ${shellQuote(input.model)} `;
      return ['--command', `opencode run ${model}${shellQuote(input.prompt)}`];
    }
  }
  // A Superset preset.
  const args = ['--agent', input.agent, '--prompt', input.prompt];
  if (input.effort !== '' && input.supportsEffort) args.push('--effort', input.effort);
  return args;
}
