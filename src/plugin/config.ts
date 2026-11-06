import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse } from 'jsonc-parser';
import { isInside } from '../security.js';

// Skill.Info exposes only a path, not its origin. Classify explicit local paths using the
// documented V2 config locations; registration also verifies the winner after reload for
// managed/remote config that is not observable here. Never log or persist config contents.
export async function explicitSkillPaths(directory: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const dirs = [path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'opencode'), '/etc/opencode'];
  for (let dir = path.resolve(directory); ; dir = path.dirname(dir)) {
    dirs.push(dir, path.join(dir, '.opencode'));
    if (path.dirname(dir) === dir) break;
  }
  if (env.OPENCODE_CONFIG_DIR) dirs.push(env.OPENCODE_CONFIG_DIR);
  const files = dirs.flatMap(dir => ['opencode.json', 'opencode.jsonc'].map(name => path.join(dir, name)));
  if (env.OPENCODE_CONFIG) files.push(env.OPENCODE_CONFIG);
  const configs: unknown[] = [];
  for (const file of new Set(files)) {
    try { configs.push(parse(await readFile(file, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (env.OPENCODE_CONFIG_CONTENT) configs.push(parse(env.OPENCODE_CONFIG_CONTENT));
  const roots: string[] = [];
  for (const config of configs) {
    const raw = config as { skills?: unknown } | null;
    // Include V1-compatible paths without using the V1 schema as the V2 contract.
    const values = Array.isArray(raw?.skills) ? raw.skills : (raw?.skills as { paths?: unknown } | undefined)?.paths;
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (typeof value !== 'string' || /^https?:/.test(value)) continue;
      const expanded = value.replace(/\{env:([^}]+)\}/g, (_, name: string) => env[name] ?? '');
      const root = path.resolve(directory, expanded.startsWith('~/') ? path.join(os.homedir(), expanded.slice(2)) : expanded);
      try { roots.push(await realpath(root)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  return roots;
}
export async function canOverridePath(file: string, explicit: string[]): Promise<boolean> {
  let resolved = path.resolve(file);
  try { resolved = await realpath(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return !explicit.some(root => isInside(root, resolved));
}
