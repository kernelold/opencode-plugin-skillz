import { readFile, readdir, stat, writeFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect } from 'vitest';
import { Skillz, Store, atomicJson, versionIdentity } from '../src/index.js';
import { temp, file, gitRepo, commit, server, skillText } from './helpers.js';

describe('state and facade', () => {
  it('persists update status across instances, dedupes slow checks and keeps every cached list readable', async () => {
    let blocked = false; let requests = 0;
    let release!: () => void; let started!: () => void;
    const pending = new Promise<void>(resolve => { started = resolve; });
    const url = await server((_req, res) => {
      requests++;
      if (blocked) { started(); release = () => res.end(skillText('Remote')); }
      else res.end(skillText('Remote'));
    });
    const dataDir = await temp(); const store = new Store({ dataDir });
    expect(await store.listUpdateStatus()).toEqual({ checkedAt: null, updates: [] });
    const source = await store.addSource(`${url}/remote.md`); await store.install(source.id);
    blocked = true;
    const check = store.checkUpdates();
    const other = new Store({ dataDir }); const duplicate = other.checkUpdates();
    expect(duplicate).toBe(check);
    await pending;
    try {
      const local = Promise.all([other.listInstalled(), other.listSources(), other.discoverAvailable(), other.listUpdateStatus()]);
      // The timeout catches the previous discoverAvailable lock/network dependency.
      const state = await Promise.race([local, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Cached reads blocked')), 500))]);
      expect(state[0]).toHaveLength(1); expect(state[2]).toHaveLength(1);
      expect(state[3].checkedAt).toBeNull();
    } finally { release(); }
    const updates = await check;
    expect(await duplicate).toEqual(updates); expect(requests).toBe(2);
    const status = await new Store({ dataDir }).listUpdateStatus();
    expect(status).toEqual({ checkedAt: expect.any(String), updates });
    expect(JSON.parse(await readFile(path.join(dataDir, 'updates.json'), 'utf8'))).toEqual(status);
    expect((await readdir(dataDir)).some(name => /\.tmp$/.test(name))).toBe(false);
  });
  it('persists failed checks and logs them without losing installed state', async () => {
    let fail = false;
    const url = await server((_req, res) => { res.statusCode = fail ? 503 : 200; res.end(fail ? 'Unavailable' : skillText('Remote')); });
    const dataDir = await temp(); const store = new Store({ dataDir });
    const source = await store.addSource(`${url}/remote.md`); const active = await store.install(source.id);
    await store.checkUpdates(); fail = true;
    const updates = await store.checkUpdates();
    expect(updates[0].issues[0].code).toBe('fetch-error');
    expect((await new Store({ dataDir }).listUpdateStatus()).updates).toEqual(updates);
    expect((await store.listErrors()).some(e => e.code === 'fetch-error')).toBe(true);
    expect(await store.listInstalled()).toEqual([active]);
  });
  it('installs, checks, atomically updates, rolls back validation failure, and removes all traces', async () => {
    const repo = await gitRepo(); await file(repo, 'skills/commit/SKILL.md', skillText('commit', 'First', 'First body'));
    await file(repo, 'skills/commit/scripts/run.sh', '#!/bin/sh\n', 0o755); const first = await commit(repo);
    const dataDir = await temp(); const skillz = new Skillz({ dataDir });
    const added = await skillz.addSource({ type: 'git', url: pathToFileURL(repo).href });
    const installed = await skillz.install(added.id);
    expect(installed).toMatchObject({ version: first, scope: 'user', enabled: true });
    expect(installed.current).toBe(path.join(dataDir, 'cache', added.id, first));
    expect(path.isAbsolute(installed.skills[0].skillFile)).toBe(true);
    expect(await skillz.loadSkillBody(installed.skills[0])).toBe('First body');
    expect((await stat(path.join(installed.skills[0].dir, 'scripts/run.sh'))).mode & 0o777).toBe(0o755);
    expect((await skillz.checkUpdates())[0].updateAvailable).toBe(false);
    await file(repo, 'skills/commit/SKILL.md', skillText('commit', 'Second', 'Second body')); const second = await commit(repo, 'second');
    expect((await skillz.checkUpdates())[0]).toMatchObject({ installedVersion: first, availableVersion: second, updateAvailable: true });
    // Checking never switches the installed state.
    expect((await skillz.listInstalled())[0].version).toBe(first);
    const updated = await skillz.update(added.id);
    expect(updated.version).toBe(second); expect(await skillz.loadSkillBody(updated.skills[0])).toBe('Second body');
    expect(await stat(installed.current)).toBeDefined();
    await file(repo, 'skills/commit/SKILL.md', '---\nname: commit\n---\nMissing description'); await commit(repo, 'invalid');
    await expect(skillz.update(added.id)).rejects.toThrow('validation failed');
    expect((await skillz.listInstalled())[0]).toEqual(updated); expect(await skillz.loadSkillBody(updated.skills[0])).toBe('Second body');
    expect(await readdir(path.join(dataDir, 'cache', added.id))).toHaveLength(2);
    expect((await readdir(dataDir)).filter(n => /tmp|lock|staging/.test(n))).toEqual([]);
    await skillz.removeSource(added.id, 'remove'); expect(await skillz.listInstalled()).toEqual([]); expect(await skillz.store.listSources()).toEqual([]);
    // Historical versions are not the current entry's deletion target.
    expect(await readdir(dataDir)).toEqual(['cache', 'errors.json']);
    expect(await stat(installed.current)).toBeDefined();
    await expect(stat(updated.current)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await skillz.listErrors()).length).toBeGreaterThan(0);
    await skillz.clearErrors(); expect(await readdir(dataDir)).toEqual(['cache']);
  });
  it('keeps the active version readable while a replacement is downloading', async () => {
    let text = skillText('plain', 'Plain', 'old');
    let release: (() => void) | undefined; let signal: (() => void) | undefined;
    let block = false;
    const started = new Promise<void>(resolve => { signal = resolve; });
    const url = await server((_req, res) => {
      if (block) { signal!(); release = () => res.end(text); } else res.end(text);
    });
    const skillz = new Skillz({ dataDir: await temp() }); const source = await skillz.addSource(`${url}/plain.md`); const old = await skillz.install(source.id);
    block = true; text = skillText('plain', 'Plain', 'new').replace('version: "1"', 'version: "2"');
    const updating = skillz.update(source.id); await started;
    try { expect((await skillz.listInstalled())[0]).toEqual(old); expect(await skillz.loadSkillBody(old.skills[0])).toBe('old'); }
    finally { release!(); }
    expect(await skillz.loadSkillBody((await updating).skills[0])).toBe('new');
  });
  it('links local sources in place and never deletes originals', async () => {
    const root = await temp(); const original = await file(root, 'SKILL.md'); const dataDir = await temp();
    const store = new Store({ dataDir }); const source = await store.addSource(root); const installed = await store.install(source.id);
    expect(installed.current).toBe(root); expect(installed.skills[0].skillFile).toBe(original);
    await store.removeSource(source.id, 'remove'); expect(await readdir(dataDir)).toEqual([]); expect(await readFile(original, 'utf8')).toContain('description');
  });
  it('supports a local single file and persistent state across instances', async () => {
    const root = await temp(); const original = await file(root, 'plain.md'); const dataDir = await temp();
    const first = new Skillz({ dataDir }); const source = await first.addSource(original); const installed = await first.install(source.id);
    const second = new Skillz({ dataDir }); expect(await second.listInstalled()).toEqual([installed]); expect(await second.listAvailable()).toEqual([source]);
    await second.remove(source.id); expect(await stat(original)).toBeDefined(); expect(await readdir(dataDir)).toEqual(['sources.json']);
  });
  it('installs plain .md HTML links as individual skills', async () => {
    const url = await server((req, res) => {
      if (req.url === '/index.html') res.end('<a href="plain.md">Plain</a>');
      else if (req.url === '/plain.md') res.end(skillText('plain', 'Plain', 'Body'));
      else { res.statusCode = 404; res.end(); }
    });
    const skillz = new Skillz({ dataDir: await temp() }); const source = await skillz.addSource(`${url}/`);
    const installed = await skillz.install(source.id); expect(installed.skills.map(s => s.id)).toEqual(['plain']); expect(await skillz.loadSkillBody(installed.skills[0])).toBe('Body');
  });
  it('uses declared HTTP index versions and updates when the catalog version changes', async () => {
    let version = 'one';
    const url = await server((req, res) => {
      if (req.url === '/index.json') res.end(JSON.stringify({ skills: [{ name: 'skill', version, files: ['SKILL.md'] }] }));
      else if (req.url === '/skill/SKILL.md') res.end(skillText('skill', 'A skill', version));
      else { res.statusCode = 404; res.end(); }
    });
    const skillz = new Skillz({ dataDir: await temp() }); const source = await skillz.addSource(`${url}/`);
    expect((await skillz.install(source.id)).version).toBe('one'); version = 'two';
    expect((await skillz.checkUpdates())[0]).toMatchObject({ updateAvailable: true, availableVersion: 'two' });
    expect(await skillz.loadSkillBody((await skillz.update(source.id)).skills[0])).toBe('two');
  });
  it('gives root skills without a name a stable upstream-derived id', async () => {
    const repo = await gitRepo(); await file(repo, 'SKILL.md', '---\ndescription: test\n---\nBody'); await commit(repo);
    const skillz = new Skillz({ dataDir: await temp() }); const source = await skillz.addSource({ type: 'git', url: repo });
    const installed = await skillz.install(source.id); expect(installed.skills[0].id).toBe(path.basename(repo));
    expect((await skillz.update(source.id)).skills[0].id).toBe(installed.skills[0].id);
  });
  it('does not let removal of an unknown dot id delete another source cache', async () => {
    const url = await server((_req, res) => res.end(skillText())); const skillz = new Skillz({ dataDir: await temp() });
    const source = await skillz.addSource(`${url}/one.md`); const installed = await skillz.install(source.id);
    await skillz.remove('.'); expect(await skillz.listInstalled()).toEqual([installed]); expect(await stat(installed.current)).toBeDefined();
  });
  it('rejects collisions between installed sources without touching the old source', async () => {
    const a = await temp(); const b = await temp(); await file(a, 'same/SKILL.md'); await file(b, 'same/SKILL.md');
    const store = new Store({ dataDir: await temp() }); const one = await store.addSource(a); const two = await store.addSource(b);
    const active = await store.install(one.id); await expect(store.install(two.id)).rejects.toThrow('collision'); expect(await store.listInstalled()).toEqual([active]);
  });
  it('rejects empty/invalid sources without changing installed.json', async () => {
    const dataDir = await temp(); const root = await temp(); await file(root, 'readme.txt', 'Not a skill');
    const store = new Store({ dataDir }); const source = await store.addSource(root); await expect(store.install(source.id)).rejects.toThrow('No skills');
    expect(await store.listInstalled()).toEqual([]); await expect(stat(path.join(dataDir, 'installed.json'))).rejects.toThrow();
    await expect(store.install('unknown')).rejects.toThrow('Unknown source');
  });
  it('serializes multiple Store instances using an in-process mutex', async () => {
    const dataDir = await temp(); const a = new Store({ dataDir }); const b = new Store({ dataDir });
    const records = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).addSource(`/tmp/source-${i}`)));
    expect(await a.listSources()).toHaveLength(12); expect(new Set(records.map(r => r.id)).size).toBe(12);
    expect(await readdir(dataDir)).toEqual(['sources.json']);
  });
  it('respects lock contention and does not steal a live lock', async () => {
    const dataDir = await temp(); const lock = path.join(dataDir, '.lock');
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: 'other' })); await utimes(lock, 0, 0);
    const store = new Store({ dataDir, lockTimeoutMs: 40, staleLockMs: 1 });
    await expect(store.addSource('/tmp/a')).rejects.toThrow('lock timeout'); expect(JSON.parse(await readFile(lock, 'utf8')).token).toBe('other');
  });
  it('reclaims a stale lock belonging to a dead process', async () => {
    const dataDir = await temp(); await writeFile(path.join(dataDir, '.lock'), JSON.stringify({ pid: 2147483647, token: 'stale' })); await utimes(path.join(dataDir, '.lock'), 0, 0);
    const store = new Store({ dataDir, staleLockMs: 1 }); await store.addSource('/tmp/a'); expect(await readdir(dataDir)).toEqual(['sources.json']);
  });
  it('recovers a stale empty lock left by a crashed process', async () => {
    const dataDir = await temp(); await writeFile(path.join(dataDir, '.lock'), ''); await utimes(path.join(dataDir, '.lock'), 0, 0);
    const store = new Store({ dataDir, staleLockMs: 1 }); await store.addSource('/tmp/a'); expect(await readdir(dataDir)).toEqual(['sources.json']);
  });
  it('writes complete atomic JSON and cleans temporary files on failure', async () => {
    const root = await temp(); const target = path.join(root, 'state.json');
    await atomicJson(target, { count: 1 }); await atomicJson(target, { count: 2 }); expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ count: 2 });
    const circular: { self?: unknown } = {}; circular.self = circular;
    await expect(atomicJson(target, circular)).rejects.toThrow(); expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ count: 2 }); expect(await readdir(root)).toEqual(['state.json']);
  });
  it('respects XDG_DATA_HOME and explicit override', async () => {
    const original = process.env.XDG_DATA_HOME; const root = await temp(); process.env.XDG_DATA_HOME = root;
    try { expect(new Store().dataDir).toBe(path.join(root, 'opencode-skillz')); expect(new Store({ dataDir: root }).dataDir).toBe(root); }
    finally { if (original === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = original; }
  });
  it('uses the right version identities in priority order', () => {
    expect(versionIdentity({ commit: 'git', sha256: 'archive', version: 'metadata', digest: 'digest' })).toBe('git');
    expect(versionIdentity({ sha256: 'archive', version: 'metadata' })).toBe('archive'); expect(versionIdentity({ version: 'metadata', digest: 'digest' })).toBe('metadata');
    expect(versionIdentity({ digest: 'digest' })).toBe('digest'); expect(() => versionIdentity({})).toThrow();
  });
  it('keeps sha pinned sources unchanged after upstream changes', async () => {
    const repo = await gitRepo(); await file(repo, 'SKILL.md'); const sha = await commit(repo);
    const skillz = new Skillz({ dataDir: await temp() }); const source = await skillz.addSource({ type: 'git', url: repo, sha }); await skillz.install(source.id);
    await file(repo, 'SKILL.md', skillText('changed')); await commit(repo, 'next');
    expect((await skillz.checkUpdates())[0]).toMatchObject({ updateAvailable: false, availableVersion: sha }); expect((await skillz.update(source.id)).version).toBe(sha);
  });
  it('stores auth references, not secrets', async () => {
    process.env.SKILLZ_STORE_TEST = 'super-secret-value'; const url = await server((_req, res) => res.end(skillText())); const dataDir = await temp(); const skillz = new Skillz({ dataDir });
    try {
      const source = await skillz.addSource(`${url}/skill.md`, { auth: { authEnv: 'SKILLZ_STORE_TEST', query: 'key' } }); await skillz.install(source.id);
      expect(await readFile(path.join(dataDir, 'sources.json'), 'utf8')).toContain('SKILLZ_STORE_TEST');
      expect(await readFile(path.join(dataDir, 'sources.json'), 'utf8')).not.toContain('super-secret-value');
      expect(await readFile(path.join(dataDir, 'installed.json'), 'utf8')).not.toContain('super-secret-value');
    } finally { delete process.env.SKILLZ_STORE_TEST; }
  });
});

describe('marketplace lifecycle', () => {
  it('refreshes a local marketplace, installs an explicit entry, removes catalog and children', async () => {
    const root = await temp(); await file(root, 'skills/a/SKILL.md'); await file(root, 'skills/b/SKILL.md');
    await file(root, '.claude-plugin/marketplace.json', JSON.stringify({ name: 'Local', owner: { name: 'Test' }, plugins: [{ name: 'one', source: './', strict: false, skills: ['./skills/a'] }] }));
    const dataDir = await temp(); const skillz = new Skillz({ dataDir }); const catalog = await skillz.addSource(root);
    expect(await skillz.refresh()).toEqual([]); const entry = (await skillz.listAvailable()).find(s => s.parentId === catalog.id)!;
    expect(entry.name).toBe('one'); expect((await skillz.install(entry.id)).skills.map(s => s.id)).toEqual(['a']);
    await skillz.removeSource(catalog.id, 'remove'); expect(await readdir(dataDir)).toEqual([]); expect(await stat(path.join(root, 'skills/a/SKILL.md'))).toBeDefined();
  });
  it('resolves git marketplace relative entries to git sources rather than temporary paths', async () => {
    const repo = await gitRepo(); await file(repo, 'skills/a/SKILL.md');
    await file(repo, '.claude-plugin/marketplace.json', JSON.stringify({ name: 'Git', owner: { name: 'Test' }, plugins: [{ name: 'one', source: './', skills: ['./skills/a'] }] })); await commit(repo);
    const skillz = new Skillz({ dataDir: await temp() }); const catalog = await skillz.addSource({ type: 'git', url: pathToFileURL(repo).href });
    expect(await skillz.refresh()).toEqual([]); const entry = (await skillz.listAvailable()).find(s => s.parentId === catalog.id)!;
    expect(entry.source.type).toBe('git'); expect((await skillz.install(entry.id)).skills[0].id).toBe('a');
  });
  it('refreshes a URL marketplace and reports unsupported/relative entries', async () => {
    const repo = await gitRepo(); await file(repo, 'SKILL.md'); await commit(repo);
    const url = await server((_req, res) => res.end(JSON.stringify({ name: 'Remote', owner: { name: 'Test' }, plugins: [
      { name: 'git', source: { source: 'url', url: pathToFileURL(repo).href }, commands: [] },
      { name: 'invalid', source: './' },
    ] })));
    const skillz = new Skillz({ dataDir: await temp() }); await skillz.addSource(`${url}/marketplace.json`);
    expect((await skillz.refresh()).map(i => i.code)).toEqual(['unsupported-component', 'invalid-entry']);
    const entries = await skillz.listAvailable(); expect(entries).toHaveLength(1); expect((await skillz.install(entries[0].id)).skills).toHaveLength(1);
  });
});

it.skipIf(!process.env.SKILLZ_LITELLM_URL)('opt-in LiteLLM marketplace: fetch and report entries', async () => {
  const skillz = new Skillz({ dataDir: await temp() }); await skillz.addSource(process.env.SKILLZ_LITELLM_URL!);
  const issues = await skillz.refresh(); const entries = await skillz.listAvailable();
  console.info('LiteLLM entries:', entries.map(e => ({ name: e.name, source: e.source })), 'issues:', issues);
  expect(entries.length).toBeGreaterThan(0);
});
