import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { Store, Skillz, type Collision } from '../src/index.js';
import { methods, SkillzRpc } from '../src/rpc.js';
import { temp, file, server, gitRepo, commit, skillText } from './helpers.js';

describe('M2 source lifecycle', () => {
  it('confirms collisions with other enabled sources, remembers origins, and leaves original files alone', async () => {
    const dataDir = await temp(); const a = await temp(); const b = await temp();
    const original = await file(a, 'same/SKILL.md'); await file(b, 'same/SKILL.md');
    const skillz = new Skillz({ dataDir }); const one = await skillz.addSource(a); const two = await skillz.addSource(b);
    await skillz.install(one.id);
    const seen: Collision[] = []; const confirmOverride = vi.fn((collision: Collision) => { seen.push(collision); return true; });
    const replacement = await skillz.install(two.id, { confirmOverride });
    expect(seen).toEqual([{ id: 'same', origin: one.id, canOverride: true }]); expect(confirmOverride).toHaveBeenCalledOnce();
    expect(replacement.overrides).toEqual([`same overrides ${one.id}`]);
    expect((await skillz.update(two.id)).overrides).toEqual(replacement.overrides);
    await skillz.remove(two.id); expect(await skillz.listInstalled()).toHaveLength(1); expect(await readFile(original, 'utf8')).toContain('description');
  });
  it('allows collisions with disabled sources but confirms them again on enable', async () => {
    const store = new Store({ dataDir: await temp() });
    const a = await temp(); const b = await temp(); await file(a, 'same/SKILL.md'); await file(b, 'same/SKILL.md');
    const one = await store.addSource(a); const two = await store.addSource(b);
    await store.install(one.id); await store.setEnabled(one.id, false); await store.install(two.id);
    await expect(store.setEnabled(one.id, true)).rejects.toThrow('override declined');
    expect((await store.listInstalled()).find(s => s.sourceId === one.id)?.enabled).toBe(false);
    expect((await store.setEnabled(one.id, true, { confirmOverride: true })).overrides).toEqual([`same overrides ${two.id}`]);
  });
  it('never prompts on automatic updates; skips new collisions and retains the old pointer', async () => {
    const dataDir = await temp(); const repo = await gitRepo(); await file(repo, 'one/SKILL.md'); await commit(repo);
    const store = new Store({ dataDir }); const source = await store.addSource({ type: 'git', url: pathToFileURL(repo).href }); const old = await store.install(source.id);
    const other = await temp(); await file(other, 'two/SKILL.md'); const two = await store.addSource(other); await store.install(two.id);
    await file(repo, 'two/SKILL.md'); await commit(repo, 'add collision');
    const confirmOverride = vi.fn(() => true);
    expect(await store.update(source.id, { automatic: true, confirmOverride })).toEqual(old);
    expect(confirmOverride).not.toHaveBeenCalled(); expect((await store.listErrors()).map(e => e.code)).toContain('update-skipped');
    expect(await readdir(path.dirname(old.current))).toEqual([old.version]);
  });
  it('refuses non-overridable external skills without calling the confirmation callback', async () => {
    const root = await temp(); await file(root, 'same/SKILL.md');
    const store = new Store({ dataDir: await temp(), externalSkills: async () => [{ id: 'same', path: '/explicit/SKILL.md', canOverride: false }] });
    const source = await store.addSource(root); const confirmOverride = vi.fn(() => true);
    await expect(store.install(source.id, { confirmOverride })).rejects.toThrow('explicit config');
    expect(confirmOverride).not.toHaveBeenCalled(); expect((await store.listErrors())[0].code).toBe('collision');
  });
  it('undoes activation if writing the pointer fails and deletes only the new cache', async () => {
    // Turn the destination state file into a directory after activation, so the atomic rename fails.
    const { mkdir, rm } = await import('node:fs/promises');
    const dataDir = await temp(); const repo = await gitRepo(); await file(repo, 'one/SKILL.md'); await commit(repo);
    const plain = new Store({ dataDir }); const source = await plain.addSource({ type: 'git', url: pathToFileURL(repo).href }); const old = await plain.install(source.id);
    await file(repo, 'one/SKILL.md', skillText('New')); await commit(repo, 'next');
    let active = old; let undoCalled = false;
    const store = new Store({ dataDir, activate: async next => {
      active = next[0]; await rm(path.join(dataDir, 'installed.json')); await mkdir(path.join(dataDir, 'installed.json'));
      return async () => { undoCalled = true; active = old; await rm(path.join(dataDir, 'installed.json'), { recursive: true }); };
    } });
    await expect(store.update(source.id)).rejects.toThrow();
    expect(undoCalled).toBe(true); expect(active).toEqual(old); expect(await readdir(path.dirname(old.current))).toEqual([old.version]);
  });
  it('persists refresh/check/install/discovery issues across instances and clears them explicitly', async () => {
    const dataDir = await temp(); let fail = false;
    const url = await server((req, res) => {
      if (fail) { res.statusCode = 503; res.end('unavailable'); }
      else if (req.url === '/marketplace.json') res.end(JSON.stringify({ name: 'Catalog', owner: { name: 'Test' }, plugins: [{ name: 'unsupported', source: { source: 'npm' } }] }));
      else res.end(skillText());
    });
    const skillz = new Skillz({ dataDir }); const source = await skillz.addSource(`${url}/one.md`); await skillz.install(source.id);
    await skillz.addSource(`${url}/marketplace.json`); await skillz.refresh();
    fail = true; await skillz.refresh(); await skillz.checkUpdates(); await expect(skillz.update(source.id)).rejects.toThrow();
    const second = new Skillz({ dataDir }); const entries = await second.listErrors();
    expect(entries.map(e => e.code)).toEqual(expect.arrayContaining(['unsupported-source', 'fetch-error', 'install-error']));
    expect(entries.every(e => e.id && e.created)).toBe(true);
    await second.clearErrors(); expect(await skillz.listErrors()).toEqual([]);
  });
  it('reports unsupported plugin components without rejecting valid skills', async () => {
    const root = await temp(); await file(root, 'one/SKILL.md');
    await file(root, '.claude-plugin/plugin.json', JSON.stringify({ commands: ['command.md'], agents: ['agent.md'] }));
    const store = new Store({ dataDir: await temp() }); const source = await store.addSource(root, { skills: ['one'] });
    expect((await store.install(source.id)).skills).toHaveLength(1);
    expect((await store.listErrors()).filter(e => e.code === 'unsupported-component')).toHaveLength(2);
  });
  it('models a LiteLLM git-subdir catalog without skills/strict and keeps commit identity over marketplace version', async () => {
    const repo = await gitRepo(); await file(repo, 'skills/domain/category/entry/SKILL.md', skillText('entry')); const sha = await commit(repo);
    const url = await server((_req, res) => res.end(JSON.stringify({ name: 'litellm', owner: { name: 'LiteLLM' }, plugins: [{ name: 'entry', description: 'Marketplace description', license: 'MIT', source: { source: 'git-subdir', url: pathToFileURL(repo).href, path: 'skills/domain/category/entry' }, version: '1.0.0' }] })));
    const store = new Store({ dataDir: await temp() }); await store.addSource(`${url}/marketplace.json`); expect(await store.refresh()).toEqual([]);
    const available = await store.discoverAvailable(); expect(available[0]).toMatchObject({ version: '1.0.0', description: 'Marketplace description', license: 'MIT' });
    expect(available[0].skills).toBeUndefined(); // No invented contents and no eager clone of every catalog entry.
    const detail = await store.discoverAvailable(available[0].id); expect(detail[0]).toMatchObject({ skills: ['entry'], version: sha });
    const installed = await store.install(available[0].id); expect(installed.version).toBe(sha);
    expect(installed.skills.map(s => s.id)).toEqual(['entry']); expect(await stat(installed.skills[0].skillFile)).toBeDefined();
  });
});

describe('RPC contract', () => {
  it('exports all M2 methods and validates confirmations, sources, output and errors', () => {
    expect(SkillzRpc.id).toBe('skillz');
    expect(Object.keys(methods)).toEqual(['listSources', 'addSource', 'previewRemoveSource', 'removeSource', 'refresh', 'listAvailable', 'install', 'update', 'checkUpdates', 'listUpdateStatus', 'remove', 'setEnabled', 'listInstalled', 'listErrors', 'clearErrors']);
    expect(() => methods.removeSource.input.parse({ sourceId: 'one' })).toThrow();
    expect(() => methods.removeSource.input.parse({ sourceId: 'one', skills: 'all' })).toThrow();
    expect(methods.removeSource.input.parse({ sourceId: 'one', skills: 'keep', revision: 'checked' })).toEqual({ sourceId: 'one', skills: 'keep', revision: 'checked' });
    expect(methods.remove.input.parse({ sourceId: 'one', skillId: 'same' })).toEqual({ sourceId: 'one', skillId: 'same' });
    expect(methods.install.input.parse({ sourceId: 'one', options: {} })).toEqual({ sourceId: 'one', options: { confirmOverride: false, automatic: false } });
    expect(() => methods.install.input.parse({ sourceId: 'one', options: { confirmOverride: 'yes' } })).toThrow();
    expect(() => methods.addSource.input.parse({ input: { type: 'arbitrary', path: '/' } })).toThrow();
    expect(() => methods.listInstalled.output.parse([{ sourceId: 'incomplete' }])).toThrow();
    expect(() => methods.listErrors.output.parse([{ code: 'error', message: 'missing id/time' }])).toThrow();
  });
});
