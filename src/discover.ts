import { readFile, readdir, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { assertSafeTree, isInside, safeJoin } from './security.js';
import type { Issue } from './source.js';

export interface Skill { id: string; dir: string; skillFile: string; name: string; description: string; version?: string; license?: string; autoinvoke?: boolean }
export interface Discovery { skills: Skill[]; issues: Issue[] }
export async function findSkills(rootDir: string, opts: { skills?: string[]; maxDepth?: number; rootName?: string } = {}): Promise<Discovery> {
  const root = path.resolve(rootDir);
  const result: Discovery = { skills: [], issues: [] };
  const ids = new Set<string>();
  async function add(file: string, rootSkill = false, plain = false): Promise<void> {
    try {
      if (!isInside((await stat(root)).isFile() ? path.dirname(await realpath(root)) : await realpath(root), await realpath(file))) throw new Error('Skill file escapes source');
      const { data } = parseFrontmatter(await readFile(file, 'utf8'));
      const dir = path.dirname(file);
      const id = (rootSkill || plain) && typeof data.name === 'string' && data.name.trim() ? data.name : plain ? path.basename(file, path.extname(file)) : rootSkill && opts.rootName ? opts.rootName : path.basename(dir);
      if (typeof data.description !== 'string' || !data.description.trim()) {
        result.issues.push({ code: 'invalid-skill', message: 'Skill requires a nonempty description', path: file }); return;
      }
      if (ids.has(id)) { result.issues.push({ code: 'collision', message: `Duplicate skill ID: ${id}`, path: file }); return; }
      ids.add(id);
      const metadata = data.metadata as Record<string, unknown> | undefined;
      const autoinvoke = typeof metadata?.['opencode/autoinvoke'] === 'boolean' ? metadata['opencode/autoinvoke'] : typeof data['disable-model-invocation'] === 'boolean' ? !data['disable-model-invocation'] : typeof data.autoinvoke === 'boolean' ? data.autoinvoke : undefined;
      result.skills.push({ id, dir, skillFile: file, name: typeof data.name === 'string' ? data.name : id, description: data.description, ...(metadata?.version != null ? { version: String(metadata.version) } : {}), ...(typeof data.license === 'string' ? { license: data.license } : {}), ...(autoinvoke !== undefined ? { autoinvoke } : {}) });
    } catch (error) { result.issues.push({ code: 'invalid-skill', message: String(error), path: file }); }
  }
  try {
    if ((await stat(root)).isFile()) { await add(root, false, true); return result; }
    await assertSafeTree(root);
    let explicit = opts.skills;
    {
      try {
        const plugin = JSON.parse(await readFile(path.join(root, '.claude-plugin/plugin.json'), 'utf8'));
        if (!explicit && Array.isArray(plugin.skills)) explicit = plugin.skills;
        for (const component of ['commands', 'agents', 'hooks', 'mcpServers', 'lspServers', 'outputStyles']) {
          if (plugin[component] !== undefined) result.issues.push({ code: 'unsupported-component', message: `${component} is not supported`, path: path.join(root, '.claude-plugin/plugin.json') });
        }
      } catch { /* Optional manifest. */ }
    }
    if (explicit) {
      for (const relative of explicit) {
        try {
          const dir = safeJoin(root, relative);
          if (!isInside(await realpath(root), await realpath(dir))) throw new Error('Explicit skill escapes root');
          await add((await stat(dir)).isFile() ? dir : path.join(dir, 'SKILL.md'), dir === root, (await stat(dir)).isFile());
        } catch (error) { result.issues.push({ code: 'invalid-skill', message: String(error), path: String(relative) }); }
      }
      return result;
    }
    async function walk(dir: string, depth: number): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      if (entries.some(e => e.name === 'SKILL.md' && e.isFile())) { await add(path.join(dir, 'SKILL.md'), dir === root); return; }
      if (depth >= (opts.maxDepth ?? 6)) return;
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') await walk(path.join(dir, e.name), depth + 1);
      }
    }
    const rootEntries = await readdir(root, { withFileTypes: true });
    if (!rootEntries.some(e => e.name === 'SKILL.md' && e.isFile())) {
      const defaults: string[] = [];
      try {
        for (const entry of (await readdir(path.join(root, 'skills'), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          const dir = path.join(root, 'skills', entry.name);
          if ((await readdir(dir, { withFileTypes: true })).some(e => e.name === 'SKILL.md' && e.isFile())) defaults.push(path.join(dir, 'SKILL.md'));
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (defaults.length) { for (const file of defaults) await add(file); return result; }
    }
    await walk(root, 0);
  } catch (error) { result.issues.push({ code: 'invalid-skill', message: String(error), path: root }); }
  return result;
}
