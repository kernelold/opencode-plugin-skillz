import { mkdir, readFile, rename, rm, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Store, atomicJson, type InstalledSource } from '../src/store.js';
import { scheduledCycle } from '../src/plugin/scheduler.js';
import { temp, file, server, skillText, gitRepo, commit } from './helpers.js';

async function marketplace() {
  const repo = await gitRepo();
  await file(repo, 'skills/same/SKILL.md', skillText('Same', 'Same', 'Retained body'));
  await file(repo, 'skills/same/references/help.txt', 'Retained supporting file');
  await commit(repo);
  const url = await server((_req, res) => res.end(JSON.stringify({ name: 'Catalog', owner: { name: 'Test' }, plugins: [
    { name: 'one', source: { source: 'url', url: repo } },
    { name: 'two', source: { source: 'url', url: repo } },
  ] })));
  const dataDir = await temp(); const store = new Store({ dataDir });
  const catalog = await store.addSource(`${url}/marketplace.json`);
  await store.refresh(); const entries = await store.listAvailable();
  return { store, dataDir, catalog, entries, repo };
}

describe('safe exact-origin removal', () => {
  it('requires an explicit source-removal policy even for untyped core callers', async () => {
    const root = await temp(); await file(root, 'same/SKILL.md');
    const store = new Store({ dataDir: await temp() }); const source = await store.addSource(root); const old = await store.install(source.id);
    await expect(store.removeSource(source.id, undefined as never)).rejects.toThrow('Choose whether');
    expect(await store.listSources()).toEqual([source]); expect(await store.listInstalled()).toEqual([old]);
  });
  it.each(['remove', 'keep'] as const)('marketplace %s affects only recorded child origins, not independent identical upstream or same-id origins', async choice => {
    const { store, dataDir, catalog, entries, repo } = await marketplace();
    const first = await store.install(entries[0].id);
    const second = await store.install(entries[1].id, { confirmOverride: true });
    await store.setEnabled(second.sourceId, false);
    const direct = await store.addSource({ type: 'git', url: repo });
    const independent = await store.install(direct.id, { confirmOverride: true });
    const otherRoot = await temp(); const external = await file(otherRoot, '.agents/skills/same/SKILL.md');
    const projectExternal = await file(otherRoot, '.opencode/skills/same/SKILL.md');
    const configExternal = await file(otherRoot, 'config/same/SKILL.md');
    const other = await store.addSource(otherRoot, { skills: ['.agents/skills/same'] });
    const another = await store.install(other.id, { confirmOverride: true });
    const preview = await store.previewRemoveSource(catalog.id);
    expect(preview.skillCount).toBe(2);
    expect(preview.entries.map(s => s.sourceId)).toEqual(entries.map(s => s.id));
    expect(preview.entries.flatMap(s => s.skills.map(k => k.id))).toEqual(['same', 'same']);
    const before = await store.listInstalled();
    await store.removeSource(catalog.id, choice, preview.revision);
    await store.removeSource(catalog.id, choice); // retry must not remove abandoned entries
    expect((await store.listSources()).map(s => s.id)).toEqual([direct.id, other.id]);
    const remaining = await store.listInstalled();
    expect(remaining.filter(s => !s.abandoned)).toEqual([independent, another]);
    for (const original of [first, second]) {
      if (choice === 'remove') await expect(stat(original.current)).rejects.toMatchObject({ code: 'ENOENT' });
      else {
        const kept = remaining.find(s => s.sourceId === original.sourceId)!;
        expect(kept).toMatchObject({ abandoned: true, formerSource: entries.find(s => s.id === original.sourceId), upstream: entries.find(s => s.id === original.sourceId), enabled: before.find(s => s.sourceId === original.sourceId)!.enabled });
        expect(await readFile(kept.skills[0].skillFile, 'utf8')).toContain('Retained body');
        expect(await readFile(path.join(kept.skills[0].dir, 'references/help.txt'), 'utf8')).toContain('Retained supporting file');
      }
    }
    for (const untouched of [external, projectExternal, configExternal, independent.skills[0].skillFile, another.skills[0].skillFile]) expect(await stat(untouched)).toBeDefined();
    expect(await new Store({ dataDir }).listInstalled()).toEqual(remaining);
  });

  it('abandoned sources are never checked or scheduled, stay toggleable/removable, and re-adopt only after the same marketplace entry returns', async () => {
    const { store, catalog, entries } = await marketplace();
    const installed = await store.install(entries[0].id);
    await store.checkUpdates();
    await store.removeSource(catalog.id, 'keep');
    expect((await store.listUpdateStatus()).updates).toEqual([]);
    expect(await store.checkUpdates()).toEqual([]);
    expect(await scheduledCycle(store, { automaticUpdates: true, updateIntervalMs: 1000 })).toEqual([]);
    expect((await store.listInstalled())[0]).toMatchObject({ abandoned: true, version: installed.version });
    await expect(store.update(installed.sourceId)).rejects.toThrow();
    expect(await store.update(installed.sourceId, { automatic: true })).toMatchObject({ abandoned: true, version: installed.version });
    await store.setEnabled(installed.sourceId, false);
    await store.setEnabled(installed.sourceId, true);
    await store.addSource(catalog.source);
    expect((await store.listInstalled())[0].abandoned).toBe(true); // parent alone is not the entry
    await store.refresh();
    expect((await store.listInstalled())[0]).toEqual(installed);
    expect((await store.checkUpdates()).map(s => s.sourceId)).toEqual([installed.sourceId]);
    await store.removeSource(catalog.id, 'keep');
    await store.remove(installed.sourceId);
    expect(await store.listInstalled()).toEqual([]);
    await expect(stat(installed.current)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('direct re-add re-adopts without fetch or moving the installed version, but changed selection does not', async () => {
    let requests = 0;
    const url = await server((_req, res) => { requests++; res.end(skillText()); });
    const store = new Store({ dataDir: await temp() }); const source = await store.addSource(`${url}/skill.md`);
    const old = await store.install(source.id); await store.removeSource(source.id, 'keep');
    await store.addSource(source.source, { skills: ['other'] });
    expect((await store.listInstalled())[0].abandoned).toBe(true);
    expect(await store.checkUpdates()).toEqual([]);
    await expect(store.update(source.id)).rejects.toThrow('abandoned');
    await store.addSource(source.source);
    expect(await store.listInstalled()).toEqual([old]); expect(requests).toBe(1);
  });

  it('protects remaining and abandoned shared-cache references and removes only one skill of one origin', async () => {
    const { store, dataDir, entries } = await marketplace();
    const a = await store.install(entries[0].id); const b = await store.install(entries[1].id, { confirmOverride: true });
    const shared = { ...b, current: a.current, skills: a.skills, abandoned: true, formerSource: entries[1] };
    await atomicJson(path.join(dataDir, 'installed.json'), { [a.sourceId]: a, [b.sourceId]: shared });
    await store.removeSource(b.sourceId, 'keep');
    await store.removeSource(a.sourceId, 'remove');
    expect(await store.listInstalled()).toEqual([shared]); expect(await stat(a.skills[0].skillFile)).toBeDefined();

    const root = await temp(); await file(root, 'same/SKILL.md'); await file(root, 'second/SKILL.md');
    const direct = await store.addSource(root); await store.install(direct.id, { confirmOverride: true });
    await store.remove(direct.id, 'same'); await store.remove(direct.id, 'same');
    expect((await store.listInstalled()).find(s => s.sourceId === direct.id)!.skills.map(s => s.id)).toEqual(['second']);
    expect((await store.update(direct.id)).skills.map(s => s.id)).toEqual(['second']);
    expect((await store.listInstalled()).find(s => s.sourceId === b.sourceId)).toEqual(shared);
    expect(await stat(path.join(root, 'same/SKILL.md'))).toBeDefined();
    expect((await store.listSources()).some(s => s.id === direct.id)).toBe(true);
  });

  it.each(['outside', 'local-cache', 'owner-link', 'cache-link', 'version-link', 'dot-origin'])('never deletes unowned/local paths or follows symlinks (%s)', async kind => {
    const dataDir = await temp(); const outside = await temp(); const sentinel = await file(outside, 'v1/same/SKILL.md');
    const store = new Store({ dataDir });
    const source = await store.addSource(kind === 'local-cache' ? path.join(dataDir, 'cache/local/v1') : 'https://example.test/skill.md');
    const cache = path.join(dataDir, 'cache'); const owner = path.join(cache, source.id);
    let current = path.join(owner, 'v1');
    if (kind === 'owner-link') { await mkdir(cache); await symlink(outside, owner); }
    if (kind === 'cache-link') { await file(outside, `${source.id}/v1/same/SKILL.md`); await symlink(outside, cache); }
    if (kind === 'version-link') { await mkdir(owner, { recursive: true }); await symlink(path.join(outside, 'v1'), current); }
    if (kind === 'outside') current = path.join(outside, 'v1');
    if (kind === 'local-cache') { current = source.source.type === 'local' ? source.source.path : ''; await file(current, 'same/SKILL.md'); }
    if (kind === 'dot-origin') { current = path.join(cache, 'victim'); await file(current, 'same/SKILL.md'); }
    const id = kind === 'dot-origin' ? '.' : source.id;
    const installed: InstalledSource = { sourceId: id, current, version: 'v1', skills: [{ id: 'same', name: 'Same', description: 'Same', dir: path.dirname(sentinel), skillFile: sentinel }], enabled: true, overrides: [], scope: 'user', upstream: source };
    await atomicJson(path.join(dataDir, 'installed.json'), { [id]: installed });
    await store.remove(id);
    expect(await store.listInstalled()).toEqual([]);
    expect(await readFile(sentinel, 'utf8')).toContain('description');
    if (kind === 'cache-link') expect(await stat(path.join(outside, source.id, 'v1/same/SKILL.md'))).toBeDefined();
    if (kind === 'local-cache' || kind === 'dot-origin') expect(await stat(path.join(current, 'same/SKILL.md'))).toBeDefined();
  });
  it.each(['remove', 'removeSource'] as const)('legacy local entries resolving inside managed cache are still only unlinked (%s)', async method => {
    const dataDir = await temp(); const store = new Store({ dataDir });
    const source = await store.addSource(path.join(await temp(), 'local-link'));
    const current = path.join(dataDir, 'cache', source.id, 'v1'); const original = await file(current, 'same/SKILL.md');
    if (source.source.type !== 'local') throw new Error('Expected local');
    await symlink(current, source.source.path);
    const entry: InstalledSource = { sourceId: source.id, version: 'v1', current, skills: [{ id: 'same', name: 'Same', description: 'Same', dir: path.dirname(original), skillFile: original }], enabled: true, overrides: [], scope: 'user' };
    await atomicJson(path.join(dataDir, 'installed.json'), { [source.id]: entry }); // pre-upstream-snapshot format
    if (method === 'remove') await store.remove(source.id); else await store.removeSource(source.id, 'remove');
    expect(await store.listInstalled()).toEqual([]); expect(await stat(original)).toBeDefined();
  });

  it('refuses a stale preview and serializes removal against a check/update already fetching', async () => {
    let release!: () => void; let started!: () => void; let blocked = false;
    const pending = new Promise<void>(resolve => { started = resolve; });
    const url = await server((_req, res) => { if (blocked) { started(); release = () => res.end(skillText()); } else res.end(skillText()); });
    const store = new Store({ dataDir: await temp() }); const source = await store.addSource(`${url}/skill.md`); await store.install(source.id);
    const preview = await store.previewRemoveSource(source.id); await store.setEnabled(source.id, false);
    await expect(store.removeSource(source.id, 'remove', preview.revision)).rejects.toThrow('changed since removal preview');
    blocked = true; const checking = store.checkUpdates(); await pending;
    const removing = store.removeSource(source.id, 'keep'); release(); await checking; await removing;
    const kept = (await store.listInstalled())[0];
    expect(kept.abandoned).toBe(true);
    expect(await store.update(source.id, { automatic: true })).toEqual(kept);
    expect((await store.listUpdateStatus()).updates).toEqual([]);
  });
  it.each(['remove', 'keep', 'installed'] as const)('scheduler skips a source %s after its check but before its automatic update', async choice => {
    let version = '1'; let requests = 0;
    const url = await server((_req, res) => { requests++; res.end(skillText().replace('version: "1"', `version: "${version}"`)); });
    const store = new Store({ dataDir: await temp() }); const source = await store.addSource(`${url}/skill.md`); const original = await store.install(source.id);
    version = '2'; const check = store.checkUpdates.bind(store);
    vi.spyOn(store, 'checkUpdates').mockImplementationOnce(async () => {
      const result = await check();
      if (choice === 'installed') await store.remove(source.id); else await store.removeSource(source.id, choice);
      return result;
    });
    await scheduledCycle(store, { automaticUpdates: true, updateIntervalMs: 1000 });
    expect(requests).toBe(2); // install + check; no stale scheduled fetch
    expect(await store.listSources()).toEqual(choice === 'installed' ? [source] : []);
    expect(await store.listInstalled()).toEqual(choice === 'keep' ? [{ ...original, abandoned: true, formerSource: source }] : []);
  });

  it.each(['remove', 'keep'] as const)('rolls back sources, installation and registration on %s state-pointer failure without deleting cache', async choice => {
    const dataDir = await temp(); const url = await server((_req, res) => res.end(skillText()));
    let breakWrite = false; const undo = vi.fn();
    const store = new Store({ dataDir, activate: async () => {
      if (breakWrite) {
        const state = path.join(dataDir, 'installed.json');
        await rename(state, `${state}.backup`); await mkdir(state);
        return async () => { undo(); await rm(state, { recursive: true }); await rename(`${state}.backup`, state); };
      }
      return async () => {};
    } });
    const source = await store.addSource(`${url}/skill.md`); const old = await store.install(source.id); breakWrite = true;
    await expect(store.removeSource(source.id, choice)).rejects.toThrow();
    expect(undo).toHaveBeenCalledOnce(); expect(await store.listSources()).toEqual([source]); expect(await store.listInstalled()).toEqual([old]);
    expect(await stat(old.current)).toBeDefined();
  });

  it.each([false, true])('recovers interrupted source metadata using atomic installed pointer (committed=%s)', async committed => {
    const dataDir = await temp(); const root = await temp(); await file(root, 'same/SKILL.md');
    const store = new Store({ dataDir }); const source = await store.addSource(root); const old = await store.install(source.id);
    const next = [{ ...old, abandoned: true, formerSource: source }];
    await atomicJson(path.join(dataDir, 'removal.json'), { previousSources: { [source.id]: source }, nextSources: {}, nextInstalled: next });
    await rm(path.join(dataDir, 'sources.json'));
    if (committed) await atomicJson(path.join(dataDir, 'installed.json'), { [source.id]: next[0] });
    await new Store({ dataDir }).withLock(async () => {});
    expect(await store.listSources()).toEqual(committed ? [] : [source]);
    expect(await store.listInstalled()).toEqual(committed ? next : [old]);
    expect((await store.listErrors()).some(e => e.code === 'removal-recovered')).toBe(true);
  });
  it('reports post-commit cache cleanup failure without restoring an installation to partially deleted files', async () => {
    const url = await server((_req, res) => res.end(skillText()));
    const store = new Store({ dataDir: await temp() }); const source = await store.addSource(`${url}/skill.md`); const old = await store.install(source.id);
    vi.spyOn(store as unknown as { cleanupRemoved: () => Promise<void> }, 'cleanupRemoved').mockRejectedValueOnce(new Error('simulated unlink failure'));
    await expect(store.removeSource(source.id, 'remove')).rejects.toThrow('Removal committed, but cache cleanup incomplete');
    expect(await store.listInstalled()).toEqual([]); expect(await store.listSources()).toEqual([]);
    expect(await stat(old.current)).toBeDefined();
    expect((await store.listErrors()).some(e => e.code === 'removal-cleanup-error')).toBe(true);
    await store.removeSource(source.id, 'remove'); // idempotent committed state
  });
});
