import { chmod, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { findSkills } from '../src/discover.js';
import { temp, file, skillText } from './helpers.js';

describe('discovery', () => {
  it('finds a nested grouped tree including extension folders', async () => {
    const root = await temp();
    for (const name of ['skills/group-a/nested/sample-one', 'skills/group-a/tools/extensions/sample-two', 'skills/design/ui/design']) await file(root, `${name}/SKILL.md`);
    await file(root, 'skills/group-a/nested/sample-one/scripts/run.sh', '#!/bin/sh\nexit 0', 0o755);
    await file(root, 'skills/group-a/nested/sample-one/nested/SKILL.md');
    await file(root, '.hidden/SKILL.md'); await file(root, 'node_modules/a/SKILL.md');
    await file(root, 'a/b/c/d/e/f/g/SKILL.md');
    const result = await findSkills(root);
    expect(result.issues).toEqual([]);
    expect(result.skills.map(s => s.id).sort()).toEqual(['design', 'sample-one', 'sample-two']);
    expect(result.skills[0]).toMatchObject({ version: '1', license: 'MIT', description: 'A useful skill' });
    expect((await stat(path.join(root, 'skills/group-a/nested/sample-one/scripts/run.sh'))).mode & 0o777).toBe(0o755);
  });
  it('recognizes a root skill and stops descending', async () => {
    const root = await temp(); await file(root, 'SKILL.md', skillText('root-name')); await file(root, 'skills/ignored/SKILL.md');
    expect((await findSkills(root)).skills.map(s => s.id)).toEqual(['root-name']);
  });
  it('recognizes the Claude default layout', async () => {
    const root = await temp(); await file(root, 'skills/a/SKILL.md'); await file(root, 'skills/b/SKILL.md');
    expect((await findSkills(root)).skills.map(s => s.id)).toEqual(['a', 'b']);
  });
  it('uses the default layout before falling back to arbitrary recursion', async () => {
    const root = await temp(); await file(root, 'skills/one/SKILL.md'); await file(root, 'nested/two/SKILL.md');
    expect((await findSkills(root)).skills.map(s => s.id)).toEqual(['one']);
  });
  it('honors explicit lists before root and reads plugin.json', async () => {
    const root = await temp(); await file(root, 'SKILL.md'); await file(root, 'one/SKILL.md'); await file(root, 'two/SKILL.md');
    expect((await findSkills(root, { skills: ['./two'] })).skills.map(s => s.id)).toEqual(['two']);
    await file(root, '.claude-plugin/plugin.json', JSON.stringify({ skills: ['./one'] }));
    expect((await findSkills(root)).skills.map(s => s.id)).toEqual(['one']);
    expect((await findSkills(root, { skills: [] })).skills).toEqual([]);
  });
  it('reports collisions, empty descriptions, and unreadable/missing skills', async () => {
    const root = await temp(); await file(root, 'a/same/SKILL.md'); await file(root, 'b/same/SKILL.md');
    await file(root, 'invalid/SKILL.md', '---\ndescription: ""\n---\nBody');
    const result = await findSkills(root);
    expect(result.skills).toHaveLength(1);
    expect(result.issues.map(i => i.code).sort()).toEqual(['collision', 'invalid-skill']);
    expect((await findSkills(root, { skills: ['missing', '../outside'] })).issues).toHaveLength(2);
    expect((await findSkills(path.join(root, 'missing'))).issues[0].code).toBe('invalid-skill');
  });
  it('rejects explicit symlink escape and skips implicit symlink directories', async () => {
    const root = await temp(); const outside = await temp(); await file(outside, 'SKILL.md');
    await symlink(outside, path.join(root, 'escape'));
    expect((await findSkills(root)).skills).toEqual([]);
    expect((await findSkills(root, { skills: ['escape'] })).issues).toHaveLength(1);
  });
  it('supports a plain file and frontmatter/name and basename fallbacks', async () => {
    const root = await temp(); const named = await file(root, 'one.md', skillText('frontmatter-name'));
    expect((await findSkills(named)).skills[0].id).toBe('frontmatter-name');
    const unnamed = await file(root, 'two.md', '---\ndescription: works\n---\nBody');
    expect((await findSkills(unnamed)).skills[0].id).toBe('two');
    await file(root, 'SKILL.md', '---\ndescription: works\n---\nBody');
    expect((await findSkills(root)).skills[0].id).toBe(path.basename(root));
    await chmod(named, 0o644);
  });
});
