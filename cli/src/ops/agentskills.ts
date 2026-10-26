// `board agents install-skills` — make the implementer contract discoverable to
// the non-Claude agents the orchestrator can now dispatch (Codex, OpenCode, …).
//
// SKILL.md is the open Agent-Skills format, so the SAME file Claude Code loads
// works unchanged in the others — they just look in their own directories. This
// mirrors the already-deployed `superset-implementer` skill into each of those,
// rather than shipping a second copy: one source of truth, copied out.
//
//   Claude Code : ~/.claude/skills/superset-implementer/   (the plugin's copy)
//   Codex       : ~/.codex/skills/superset-implementer/
//   OpenCode    : ~/.config/opencode/skill/superset-implementer/   (XDG-aware)

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SKILL = 'superset-implementer';

/** Where the canonical skill already lives — the plugin/Claude install, or a
 *  --from override. Returns the skill DIRECTORY (containing SKILL.md), or null. */
function findSource(fromArg: string | undefined, env: NodeJS.ProcessEnv): string | null {
  const candidates: string[] = [];
  if (fromArg !== undefined && fromArg !== '') candidates.push(fromArg);
  const home = env['HOME'] ?? homedir();
  candidates.push(
    join(home, '.claude', 'skills', SKILL),
    join(home, '.claude', 'plugins', 'cache', 'superset-board', 'superset-board', 'skills', SKILL),
  );
  for (const dir of candidates) {
    if (existsSync(join(dir, 'SKILL.md'))) return dir;
  }
  return null;
}

/** The per-agent skill roots, XDG-aware for OpenCode. */
function targets(env: NodeJS.ProcessEnv): { agent: string; dir: string }[] {
  const home = env['HOME'] ?? homedir();
  const xdg = env['XDG_CONFIG_HOME'];
  const opencodeBase = xdg !== undefined && xdg !== '' ? xdg : join(home, '.config');
  return [
    { agent: 'codex', dir: join(home, '.codex', 'skills', SKILL) },
    { agent: 'opencode', dir: join(opencodeBase, 'opencode', 'skill', SKILL) },
  ];
}

export interface InstallSkillsResult {
  source: string | null;
  installed: { agent: string; dir: string }[];
}

export function installSkills(
  fromArg: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): InstallSkillsResult {
  const source = findSource(fromArg, env);
  if (source === null) return { source: null, installed: [] };
  const installed: { agent: string; dir: string }[] = [];
  for (const target of targets(env)) {
    mkdirSync(target.dir, { recursive: true });
    // Copy the whole skill directory (SKILL.md plus any reference/ it carries),
    // shallow-merging over whatever is there so a re-run just refreshes it.
    for (const entry of readdirSync(source)) {
      const src = join(source, entry);
      const dst = join(target.dir, entry);
      if (statSync(src).isDirectory()) cpSync(src, dst, { recursive: true });
      else copyFileSync(src, dst);
    }
    installed.push(target);
  }
  return { source, installed };
}

export function runAgents(argv: string[]): void {
  const [sub, ...rest] = argv;
  if (sub !== 'install-skills') {
    process.stderr.write(`BLOCKED: unknown agents verb: ${sub ?? ''} (install-skills)\n`);
    process.exit(1);
  }
  const fromIndex = rest.indexOf('--from');
  const fromArg = fromIndex >= 0 ? rest[fromIndex + 1] : undefined;
  const result = installSkills(fromArg);
  if (result.source === null) {
    process.stderr.write(
      'BLOCKED: could not find the superset-implementer skill to install.\n' +
        '     Looked in ~/.claude/skills and the plugin cache. Install the plugin\n' +
        '     first, or pass --from <dir containing SKILL.md>.\n',
    );
    process.exit(1);
  }
  console.log(`installed ${SKILL} from ${result.source}:`);
  for (const t of result.installed) console.log(`  ${t.agent}  ${t.dir}`);
  console.log('Codex and OpenCode agents will now find the implementer contract.');
}
