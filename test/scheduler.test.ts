import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { Store, atomicJson } from '../src/store.js';
import { schedulerOptions, scheduledCycle, startScheduler, DEFAULT_INTERVAL_MS } from '../src/plugin/scheduler.js';
import { temp, file, server, gitRepo, commit, skillText } from './helpers.js';

const automatic = { automaticUpdates: true, updateIntervalMs: 1000 };
describe('shared scheduler', () => {
  it('validates options with default startup/6h and manual-only checks', () => {
    expect(schedulerOptions({})).toEqual({ automaticUpdates: true, updateIntervalMs: DEFAULT_INTERVAL_MS });
    expect(schedulerOptions({ automaticUpdates: false, updateIntervalMs: 5000 }).automaticUpdates).toBe(false);
    for (const updateIntervalMs of [0, -1, 0.1, NaN, Infinity, '6h', 2147483648]) expect(() => schedulerOptions({ updateIntervalMs })).toThrow();
    expect(() => schedulerOptions({ automaticUpdates: 'false' })).toThrow();
  });
  it('claims once per user/interval under the state lock across Store instances, checks and updates', async () => {
    const dataDir = await temp(); const root = await temp();
    await file(root, 'a/SKILL.md', skillText().replace('version: "1"', 'version: "1"'));
    const a = new Store({ dataDir }); const b = new Store({ dataDir });
    const source = await a.addSource(root); await a.install(source.id);
    await file(root, 'a/SKILL.md', skillText().replace('version: "1"', 'version: "2"'));
    const checks = await Promise.all([scheduledCycle(a, automatic, 1000), scheduledCycle(b, automatic, 1000)]);
    expect(checks.filter(Boolean)).toHaveLength(1);
    expect(checks.find(Boolean)?.[0].updateAvailable).toBe(true);
    expect((await a.listInstalled())[0].version).toBe('2');
    expect((await a.listUpdateStatus()).updates[0].updateAvailable).toBe(false);
    expect(await scheduledCycle(b, automatic, 1999)).toBeUndefined();
    expect(await scheduledCycle(b, automatic, 2000)).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(dataDir, 'scheduler.json'), 'utf8'))).toEqual({ nextRun: 3000 });
  });
  it('manual-only still discovers update badges but never installs automatically', async () => {
    const store = new Store({ dataDir: await temp() }); const root = await temp(); await file(root, 'a/SKILL.md');
    const source = await store.addSource(root); const old = await store.install(source.id);
    await file(root, 'a/SKILL.md', skillText().replace('version: "1"', 'version: "2"'));
    expect((await scheduledCycle(store, { ...automatic, automaticUpdates: false }))?.[0].updateAvailable).toBe(true);
    expect(await store.listInstalled()).toEqual([old]);
    expect(await new Store({ dataDir: store.dataDir }).listUpdateStatus()).toEqual({ checkedAt: expect.any(String), updates: [expect.objectContaining({ updateAvailable: true, availableVersion: '2' })] });
    expect((await store.checkUpdates())[0].updateAvailable).toBe(true);
    expect((await store.update(source.id)).version).toBe('2');
  });
  it('uses one timer per data dir and keeps it until the last location unloads', async () => {
    const store = new Store({ dataDir: await temp() }); const check = vi.spyOn(store, 'checkUpdates');
    const interval = vi.spyOn(globalThis, 'setInterval');
    const stopA = startScheduler(store, automatic); const stopB = startScheduler(store, automatic);
    try {
      await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());
      expect(interval).toHaveBeenCalledOnce(); await stopA();
      await vi.waitFor(() => expect(check.mock.calls.length).toBeGreaterThan(1), { timeout: 2500 });
    } finally { await stopA(); await stopB(); interval.mockRestore(); }
  });
  it('does not move ref/sha/sha256 pins automatically, even a moving branch', async () => {
    const repo = await gitRepo(); await file(repo, 'a/SKILL.md'); const first = await commit(repo);
    const store = new Store({ dataDir: await temp() });
    const ref = await store.addSource({ type: 'git', url: pathToFileURL(repo).href, ref: 'main' });
    const sha = await store.addSource({ type: 'git', url: pathToFileURL(repo).href, sha: first });
    const old = await store.install(ref.id); await store.install(sha.id, { confirmOverride: true });
    await file(repo, 'a/SKILL.md', skillText('New')); const second = await commit(repo, 'new');
    const checks = await scheduledCycle(store, automatic);
    expect(checks?.find(c => c.sourceId === ref.id)?.updateAvailable).toBe(true);
    expect((await store.listInstalled()).map(s => s.version)).toEqual([first, first]);
    expect((await store.update(ref.id, { automatic: true })).version).toBe(old.version);
    expect((await store.update(ref.id, { confirmOverride: true })).version).toBe(second);
    const archive = await store.addSource({ type: 'archive-url', url: 'https://example.invalid/a.zip', format: 'zip', sha256: '0'.repeat(64) });
    // Exercise the guard without downloading an archive (its install pin is independently verified).
    const installed = await store.listInstalled();
    await atomicJson(path.join(store.dataDir, 'installed.json'), Object.fromEntries([...installed, { ...old, sourceId: archive.id }].map(s => [s.sourceId, s])));
    expect((await store.update(archive.id, { automatic: true })).version).toBe(first);
  });
  it('recovers a dead scheduler claim but respects a live owner, regardless of interval', async () => {
    const store = new Store({ dataDir: await temp() }); const state = path.join(store.dataDir, 'scheduler.json');
    await atomicJson(state, { nextRun: 99999, running: { pid: process.pid, token: 'live' } });
    expect(await scheduledCycle(store, automatic, 100000)).toBeUndefined();
    await atomicJson(state, { nextRun: 99999, running: { pid: 2147483647, token: 'dead' } });
    expect(await scheduledCycle(store, automatic, 1)).toEqual([]);
  });
  it('rolls back failure mid-update and continues independent sources', async () => {
    let version = '1'; let requests = 0;
    const url = await server((_req, res) => {
      if (++requests === 3) { res.statusCode = 503; res.end('injected mid-update failure'); }
      else res.end(skillText().replace('version: "1"', `version: "${version}"`));
    });
    const store = new Store({ dataDir: await temp() }); const source = await store.addSource(`${url}/a.md`); const old = await store.install(source.id);
    version = '2'; await scheduledCycle(store, automatic, 1000);
    expect(await store.listInstalled()).toEqual([old]); expect(await readFile(old.skills[0].skillFile, 'utf8')).toContain('version: "1"');
    expect(await readdir(path.dirname(old.current))).toEqual(['1']);
    expect((await store.listErrors()).some(e => e.code === 'install-error')).toBe(true);
    await scheduledCycle(store, automatic, 2000); expect((await store.listInstalled())[0].version).toBe('2');
  });
  it('rolls back scheduled registration failure without deleting the old version', async () => {
    let fail = false; const root = await temp(); await file(root, 'a/SKILL.md');
    const store = new Store({ dataDir: await temp(), activate: async () => { if (fail) throw new Error('injected registration failure'); return async () => {}; } });
    const source = await store.addSource(root); const old = await store.install(source.id);
    await file(root, 'a/SKILL.md', skillText().replace('version: "1"', 'version: "2"')); fail = true;
    await scheduledCycle(store, automatic); expect(await store.listInstalled()).toEqual([old]);
    expect((await store.listErrors()).at(-1)?.message).toContain('registration failure');
  });
});
