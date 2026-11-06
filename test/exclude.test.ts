import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Skillz, Store, findSkills, isExcluded, parseMarketplace } from '../src/index.js';
import { methods } from '../src/rpc.js';
import { InstallChecklist, type Available } from '../src/tui/model.js';
import { temp, file, skillText, gitRepo, commit } from './helpers.js';

describe('source exclusions', () => {
  it.each(['alpha-deploy', 'alpha-*', 'alpha/', 'alpha/alpha-*', 'Deployment'])('filters exact names, globs and category prefixes (%s)', async exclude => {
    const root = await temp();
    await file(root, 'alpha/alpha-deploy/SKILL.md', skillText('Deployment'));
    await file(root, 'other-skill/SKILL.md', skillText('other-skill'));
    expect((await findSkills(root, { exclude: [exclude] })).skills.map(s => s.id)).toEqual(['other-skill']);
  });
  it('treats regex punctuation literally and category boundaries precisely', () => {
    expect(isExcluded({ id: 'a+b', name: 'a+b' }, ['a+b'])).toBe(true);
    expect(isExcluded({ id: 'ab', name: 'ab' }, ['a+b'])).toBe(false);
    expect(isExcluded({ id: 'tool', name: 'tool', category: 'alpha/extensions' }, ['alpha/'])).toBe(true);
    expect(isExcluded({ id: 'tool', name: 'tool', category: 'alpha-other' }, ['alpha/'])).toBe(false);
  });
  it('discovers grouped and direct skills together under the default skills root', async () => {
    const root = await temp(); await file(root, 'skills/flat/SKILL.md'); await file(root, 'skills/alpha/deploy/SKILL.md');
    expect((await findSkills(root)).skills.map(s => [s.id, s.category])).toEqual([['deploy', 'alpha'], ['flat', undefined]]);
  });
  it('persists exclusions across refresh/restart/update while installing new nonexcluded skills', async () => {
    const root = await temp(); const dataDir = await temp(); const skillz = new Skillz({ dataDir });
    for (const id of ['alpha-deploy', 'kept-skill']) await file(root, `${id}/SKILL.md`, skillText(id));
    const source = await skillz.addSource(root, { exclude: ['alpha-*'] });
    expect((await skillz.install(source.id)).skills.map(s => s.id)).toEqual(['kept-skill']);
    await file(root, 'alpha-setup/SKILL.md', skillText('alpha-setup')); await file(root, 'commit/SKILL.md', skillText('commit'));
    const restarted = new Store({ dataDir }); await restarted.refresh();
    expect((await restarted.listSources())[0].options.exclude).toEqual(['alpha-*']);
    expect((await restarted.update(source.id)).skills.map(s => s.id)).toEqual(['commit', 'kept-skill']);
    const [preview] = await restarted.discoverAvailable(source.id);
    expect(preview.skillChoices?.filter(s => s.excluded).map(s => s.id)).toEqual(['alpha-deploy', 'alpha-setup']);
    expect(JSON.parse(await readFile(path.join(dataDir, 'sources.json'), 'utf8'))[source.id].options.exclude).toEqual(['alpha-*']);
    expect((await restarted.install(source.id, { exclude: [] })).skills).toHaveLength(4);
  });
  it('keeps git-subdirectory categories relative to the discovered root across versions', async () => {
    const repo = await gitRepo(); const dataDir = await temp();
    await file(repo, 'skills/group-a/alpha/deploy/SKILL.md'); await file(repo, 'skills/group-a/kept-skill/SKILL.md'); await commit(repo);
    const store = new Store({ dataDir }); const source = await store.addSource({ type: 'git', url: repo, ref: 'main', subpath: 'skills/group-a' });
    expect((await store.discoverAvailable(source.id))[0].skillChoices?.find(s => s.id === 'deploy')?.category).toBe('alpha');
    const old = await store.install(source.id, { exclude: ['alpha/'] });
    await file(repo, 'skills/group-a/alpha/setup/SKILL.md'); await file(repo, 'skills/group-a/commit/SKILL.md'); await commit(repo);
    const updated = await new Store({ dataDir }).update(source.id);
    expect(updated.version).not.toBe(old.version); expect(updated.skills.map(s => s.id)).toEqual(['commit', 'kept-skill']);
  });
  it('keeps older sources compatible and refuses all-excluded installations without changing persisted options', async () => {
    const root = await temp(); const store = new Store({ dataDir: await temp() }); await file(root, 'one/SKILL.md');
    const source = await store.addSource(root); const installed = await store.install(source.id);
    expect(installed.skills).toHaveLength(1);
    await expect(store.install(source.id, { exclude: ['*'] })).rejects.toThrow('No skills found');
    expect(await store.listInstalled()).toEqual([installed]); expect((await store.listSources())[0].options).toEqual({});
  });
  it('rolls back exclusion edits when registration fails', async () => {
    const root = await temp(); let fail = false;
    const store = new Store({ dataDir: await temp(), activate: async () => { if (fail) throw new Error('reload failed'); return async () => {}; } });
    await file(root, 'one/SKILL.md'); await file(root, 'two/SKILL.md'); const source = await store.addSource(root);
    const installed = await store.install(source.id); fail = true;
    await expect(store.install(source.id, { exclude: ['two'] })).rejects.toThrow('reload failed');
    expect(await store.listInstalled()).toEqual([installed]); expect((await store.listSources())[0].options).toEqual({});
  });
  it('never registers excluded skills or asks to override their collisions', async () => {
    const root = await temp(); let registered: string[] = [];
    const store = new Store({ dataDir: await temp(), externalSkills: async () => [{ id: 'alpha-deploy', path: '/external/SKILL.md', canOverride: false }],
      activate: async next => { registered = next.flatMap(s => s.skills.map(k => k.id)); return async () => {}; } });
    await file(root, 'alpha-deploy/SKILL.md'); await file(root, 'kept-skill/SKILL.md'); const source = await store.addSource(root, { exclude: ['alpha-*'] });
    await store.install(source.id); expect(registered).toEqual(['kept-skill']);
    await store.update(source.id); expect(registered).toEqual(['kept-skill']);
  });
  it('accepts RPC and marketplace exclusions and retains user selections through catalog refresh', async () => {
    expect(methods.addSource.input.parse({ input: '/skills', options: { exclude: ['alpha-*'] } }).options?.exclude).toEqual(['alpha-*']);
    expect(methods.install.input.parse({ sourceId: 'source', options: { exclude: ['alpha/'] } }).options?.exclude).toEqual(['alpha/']);
    const root = await temp(); const manifest = { name: 'Kit', owner: { name: 'Owner' }, plugins: [{ name: 'Tools', source: './tools', exclude: ['alpha-*'] }] };
    expect(parseMarketplace(manifest, { rootDir: root }).entries[0].exclude).toEqual(['alpha-*']);
    expect(parseMarketplace({ ...manifest, plugins: [{ ...manifest.plugins[0], exclude: [1] }] }, { rootDir: root }).issues[0].code).toBe('invalid-entry');
    await file(root, '.claude-plugin/marketplace.json', JSON.stringify(manifest));
    await file(root, 'tools/alpha-one/SKILL.md'); await file(root, 'tools/kept-skill/SKILL.md');
    const store = new Store({ dataDir: await temp() }); await store.addSource(root); await store.refresh();
    const [entry] = await store.listAvailable(); expect(entry.options.exclude).toEqual(['alpha-*']);
    await store.install(entry.id, { exclude: [] }); await store.refresh();
    expect((await store.listAvailable())[0].options.exclude).toEqual([]);
  });
  it('re-includes individually removed skills without losing per-skill disablement', async () => {
    const root = await temp(); const store = new Store({ dataDir: await temp() });
    await file(root, 'one/SKILL.md'); await file(root, 'two/SKILL.md'); const source = await store.addSource(root); await store.install(source.id);
    await store.setEnabled(source.id, false, {}, 'one'); await store.remove(source.id, 'two');
    expect((await store.discoverAvailable(source.id))[0].skillChoices?.find(s => s.id === 'two')?.excluded).toBe(true);
    const restored = await store.install(source.id, { exclude: [] });
    expect(restored.skills.map(s => s.id)).toEqual(['one', 'two']); expect(restored.disabledSkills).toEqual(['one']);
  });
});

const entry: Available = { id: 'source', options: {}, source: { type: 'local', path: '/skills' },
  skillChoices: [{ id: 'flat', name: 'flat', excluded: false }, { id: 'deploy', name: 'deploy', category: 'alpha', excluded: false }, { id: 'setup', name: 'setup', category: 'alpha', excluded: false }] };
describe('install checklist model', () => {
  it('starts with all selected and toggles skills and tri-state categories', () => {
    const checklist = new InstallChecklist(entry); expect(checklist.selected.size).toBe(3);
    checklist.toggle(checklist.rows()[2]); expect(checklist.rows()[1].state).toBe('some'); expect(checklist.exclusions()).toEqual(['deploy']);
    checklist.toggle(checklist.rows()[1]); expect(checklist.rows()[1].state).toBe('all');
    checklist.toggle(checklist.rows()[1]); expect(checklist.rows()[1].state).toBe('none'); expect(checklist.exclusions()).toEqual(['alpha/']);
    checklist.selectAll(false); expect(checklist.selected.size).toBe(0);
    checklist.selectAll(true); expect(checklist.exclusions()).toEqual([]);
  });
  it('has no headers in a flat list', () => {
    const checklist = new InstallChecklist({ ...entry, skillChoices: undefined, skills: ['one', 'two'] });
    expect(checklist.rows().map(s => s.header)).toEqual([false, false]); expect(checklist.selected.size).toBe(2);
  });
  it('keeps existing globs until a matching skill is re-included', () => {
    const checklist = new InstallChecklist({ ...entry, options: { exclude: ['depl*'] }, skillChoices: entry.skillChoices!.map(s => ({ ...s, excluded: s.id === 'deploy' })) });
    expect(checklist.exclusions()).toEqual(['depl*']); checklist.toggle(checklist.rows()[2]); expect(checklist.exclusions()).toEqual([]);
  });
  it('does not compact a parent category when a descendant skill remains selected', () => {
    const checklist = new InstallChecklist({ ...entry, skillChoices: [...entry.skillChoices!, { id: 'extra', name: 'extra', category: 'alpha/extensions', excluded: false }] });
    checklist.toggle(checklist.rows()[1]); expect(checklist.exclusions()).toEqual(['deploy', 'setup']);
  });
});
