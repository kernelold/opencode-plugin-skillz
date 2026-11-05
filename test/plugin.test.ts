import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin, Skill } from '@opencode/plugin';
import { describe, expect, it, vi } from 'vitest';
import { Skillz } from '../src/index.js';
import { setup, finishStartup, jsonOutput } from '../src/plugin/index.js';
import { SkillRegistration } from '../src/plugin/registration.js';
import { scheduledCycle } from '../src/plugin/scheduler.js';
import { explicitSkillPaths, canOverridePath } from '../src/plugin/config.js';
import { methods, type SkillzMethods } from '../src/rpc.js';
import { temp, file, server, gitRepo, commit, skillText } from './helpers.js';

it('omits undefined optional properties at the JSON RPC boundary', async () => {
  expect(await jsonOutput(Promise.resolve([{ id: 'one', skills: undefined, source: { ref: undefined, type: 'git' } }])))
    .toEqual([{ id: 'one', source: { type: 'git' } }]);
});

function runtime(dataDir: string, directory: string) {
  type Editor = Parameters<Parameters<Plugin.Context['skill']['transform']>[0]>[0];
  const callbacks = new Set<(editor: Editor) => void>();
  const external: Skill.Info[] = []; const configured: Skill.Info[] = [];
  let visible: Skill.Info[] = []; let failReload = false;
  let handlers!: SkillzMethods;
  let disposed = 0;
  let pluginReady = false;
  const apply = () => {
    const registry = new Map(external.map(s => [s.id, s]));
    const editor: Editor = {
      list: () => [...registry.values()], get: id => registry.get(id as Skill.Info['id']),
      add: skill => { registry.set(skill.id, skill); }, remove: id => { registry.delete(id as Skill.Info['id']); },
      update: (id, fn) => { const skill = registry.get(id as Skill.Info['id']); if (skill) fn(skill); },
    };
    for (const callback of callbacks) callback(editor);
    for (const skill of configured) registry.set(skill.id, skill);
    visible = [...registry.values()];
  };
  const skill: Plugin.Context['skill'] = {
    transform: async callback => {
      callbacks.add(callback); apply();
      return { dispose: async () => { callbacks.delete(callback); disposed++; apply(); } };
    },
    reload: vi.fn(async () => { if (failReload) { failReload = false; throw new Error('reload failed'); } apply(); }),
    list: async () => ({ location: { directory }, data: visible }),
  };
  const ctx = {
    options: { dataDir }, location: { directory }, skill,
    plugin: { list: async () => ({ location: { directory }, data: pluginReady ? [{ id: 'opencode.config.skill', state: { status: 'active' } }] : [] }) },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    } },
    rpc: { register: vi.fn(async (_definition, implementations) => {
      const context = { error: (_type: string, message: string) => { throw new Error(message); } };
      handlers = Object.fromEntries(Object.entries(implementations).map(([name, fn]) => [name, (input: unknown) => (fn as Function)(input, context)])) as SkillzMethods;
      return { dispose: vi.fn(async () => {}) };
    }) },
  } as unknown as Plugin.Context;
  return { ctx, skill, external, configured, apply,
    setReady: () => { pluginReady = true; },
    addFilesystem: (skills: Skill.Info[]) => { callbacks.add(editor => { for (const skill of skills) editor.add(skill); }); apply(); },
    get handlers() { return handlers; }, get visible() { return visible; }, get disposed() { return disposed; }, failNextReload: () => { failReload = true; }, get registrations() { return callbacks.size; } };
}
function externalSkill(id: string, file: string): Skill.Info {
  return { id: id as Skill.Info['id'], name: id as Skill.Info['name'], path: file as Skill.Info['path'], description: 'external', content: 'external body' };
}

describe('OpenCode V2 registration', () => {
  it('disposes only its own transform when a replacement exposes the same skill file', async () => {
    const dataDir = await temp(); const root = await temp();
    const original = await file(root, 'six-thinking-hats/SKILL.md');
    const core = new Skillz({ dataDir }); const source = await core.addSource(root); await core.install(source.id);
    const host = runtime(dataDir, await temp());
    const old = new SkillRegistration(host.skill); const replacement = new SkillRegistration(host.skill);
    await old.replace(await core.listInstalled(), false);
    await replacement.replace(await core.listInstalled(), false);
    const list = vi.spyOn(host.skill, 'list');
    await expect(old.dispose()).resolves.toBeUndefined();
    await old.dispose(); // Already disposed is also success.
    expect(list).not.toHaveBeenCalled(); expect(host.skill.reload).not.toHaveBeenCalled();
    expect(host.registrations).toBe(1); expect(host.visible.map(s => s.path)).toEqual([original]);
    await replacement.dispose(); expect(host.registrations).toBe(0); expect(host.visible).toEqual([]);
  });
  it('accepts an independently discovered same-file fallback without an override record', async () => {
    const dataDir = await temp(); const root = await temp(); const original = await file(root, 'same/SKILL.md');
    const core = new Skillz({ dataDir }); const source = await core.addSource(root); await core.install(source.id);
    const host = runtime(dataDir, await temp()); const registration = new SkillRegistration(host.skill);
    await registration.replace(await core.listInstalled());
    host.external.push(externalSkill('same', original));
    await expect(registration.replace([])).resolves.toBeTypeOf('function');
    expect(host.registrations).toBe(0); expect(host.visible.map(s => s.path)).toEqual([original]);
    expect(await stat(original)).toBeDefined();
  });
  it('releases skill registrations even when RPC cleanup fails and the skill API is unavailable', async () => {
    const dataDir = await temp(); const root = await temp(); await file(root, 'one/SKILL.md');
    const core = new Skillz({ dataDir }); const source = await core.addSource(root); await core.install(source.id);
    const host = runtime(dataDir, await temp()); const cleanup = await setup(host.ctx);
    const rpc = await vi.mocked(host.ctx.rpc.register).mock.results[0].value;
    vi.spyOn(rpc, 'dispose').mockRejectedValue(new Error('RPC already unavailable'));
    const list = vi.spyOn(host.skill, 'list').mockRejectedValue(new Error('location closed'));
    vi.mocked(host.skill.reload).mockRejectedValue(new Error('location closed'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(cleanup()).resolves.toBeUndefined();
      expect(warning).toHaveBeenCalledWith('Skillz RPC cleanup failed', expect.any(Error));
      expect(host.registrations).toBe(0); expect(host.visible).toEqual([]);
      expect(list).not.toHaveBeenCalled(); expect(host.skill.reload).not.toHaveBeenCalled();
    } finally { warning.mockRestore(); }
  });
  it('keeps abandoned multi-skill entries individually toggleable/removable without affecting sibling or external files', async () => {
    const root = await temp(); const first = await file(root, 'same/SKILL.md'); const second = await file(root, 'other/SKILL.md');
    const fallback = await file(await temp(), '.opencode/skills/same/SKILL.md');
    const host = runtime(await temp(), await temp()); host.external.push(externalSkill('same', fallback)); host.apply();
    const cleanup = await setup(host.ctx);
    try {
      const source = await host.handlers.addSource({ input: root });
      await host.handlers.install({ sourceId: source.id, options: { confirmOverride: true } });
      await host.handlers.setEnabled({ sourceId: source.id, skillId: 'other', enabled: false });
      await host.handlers.removeSource({ sourceId: source.id, skills: 'keep' });
      expect(host.visible.map(s => s.path)).toEqual([first]);
      expect((await host.handlers.listInstalled())[0]).toMatchObject({ abandoned: true, disabledSkills: ['other'] });
      await host.handlers.setEnabled({ sourceId: source.id, skillId: 'same', enabled: false });
      expect(host.visible.map(s => s.path)).toEqual([fallback]);
      await host.handlers.setEnabled({ sourceId: source.id, skillId: 'other', enabled: true });
      expect(host.visible.map(s => s.path)).toEqual([fallback, second]);
      await host.handlers.remove({ sourceId: source.id, skillId: 'same' });
      expect(host.visible.map(s => s.path)).toEqual([fallback, second]);
      expect((await host.handlers.listInstalled())[0].skills.map(s => s.id)).toEqual(['other']);
      for (const original of [first, second, fallback]) expect(await stat(original)).toBeDefined();
    } finally { await cleanup(); }
  });
  it.each(['remove', 'keep'] as const)('source %s preserves correct same-id override precedence in every active location', async choice => {
    const dataDir = await temp(); const one = await temp(); const two = await temp();
    const oneFile = await file(one, 'same/SKILL.md', skillText('One', 'One', 'One body'));
    const twoFile = await file(two, 'same/SKILL.md', skillText('Two', 'Two', 'Two body'));
    const external = await file(await temp(), '.agents/skills/same/SKILL.md');
    const a = runtime(dataDir, await temp()); const b = runtime(dataDir, await temp());
    for (const host of [a, b]) { host.external.push(externalSkill('same', external)); host.apply(); }
    const cleanA = await setup(a.ctx); const cleanB = await setup(b.ctx);
    try {
      const first = await a.handlers.addSource({ input: one }); const second = await a.handlers.addSource({ input: two });
      await a.handlers.install({ sourceId: first.id, options: { confirmOverride: true } });
      await a.handlers.install({ sourceId: second.id, options: { confirmOverride: true } });
      const preview = await a.handlers.previewRemoveSource({ sourceId: first.id });
      expect(methods.previewRemoveSource.output.parse(preview)).toEqual(preview);
      expect(JSON.parse(JSON.stringify(preview))).toEqual(preview);
      await a.handlers.removeSource({ sourceId: first.id, skills: choice, revision: preview.revision });
      for (const host of [a, b]) expect(host.visible.map(s => s.path)).toEqual([twoFile]);
      await b.handlers.removeSource({ sourceId: second.id, skills: 'remove' });
      for (const host of [a, b]) expect(host.visible.map(s => s.path)).toEqual([choice === 'keep' ? oneFile : external]);
      if (choice === 'keep') {
        const [abandoned] = await a.handlers.listInstalled();
        expect(abandoned.abandoned).toBe(true);
        await b.handlers.setEnabled({ sourceId: first.id, enabled: false });
        for (const host of [a, b]) expect(host.visible.map(s => s.path)).toEqual([external]);
        await b.handlers.setEnabled({ sourceId: first.id, enabled: true });
        await b.handlers.remove({ sourceId: first.id });
        for (const host of [a, b]) expect(host.visible.map(s => s.path)).toEqual([external]);
      }
      for (const original of [oneFile, twoFile, external]) expect(await stat(original)).toBeDefined();
    } finally { await cleanA(); await cleanB(); }
  });
  it.each(['remove', 'keep'] as const)('source %s rolls back all locations and both state files when a later location reload fails', async choice => {
    const dataDir = await temp(); const root = await temp(); const original = await file(root, 'same/SKILL.md');
    const a = runtime(dataDir, await temp()); const b = runtime(dataDir, await temp());
    const cleanA = await setup(a.ctx); const cleanB = await setup(b.ctx);
    try {
      const source = await a.handlers.addSource({ input: root }); const before = await a.handlers.install({ sourceId: source.id });
      b.failNextReload();
      await expect(a.handlers.removeSource({ sourceId: source.id, skills: choice })).rejects.toThrow('reload failed');
      expect(await a.handlers.listSources()).toEqual([source]); expect(await a.handlers.listInstalled()).toEqual([before]);
      for (const host of [a, b]) expect(host.visible.map(s => s.path)).toEqual([original]);
      expect(await stat(original)).toBeDefined();
    } finally { await cleanA(); await cleanB(); }
  });
  it('starts one automatic scheduler after readiness for multiple plugin locations', async () => {
    let version = '1'; let requests = 0;
    const url = await server((_req, res) => { requests++; res.end(skillText('Remote', 'Remote', `Body ${version}`).replace('version: "1"', `version: "${version}"`)); });
    const dataDir = await temp(); const core = new Skillz({ dataDir });
    const source = await core.addSource(`${url}/one.md`); await core.install(source.id); version = '2';
    const a = runtime(dataDir, await temp()); const b = runtime(dataDir, await temp()); a.setReady(); b.setReady();
    const cleanA = await setup(a.ctx); const cleanB = await setup(b.ctx);
    try {
      await vi.waitFor(async () => {
        expect((await core.listInstalled())[0].version).toBe('2');
        expect(a.visible[0].content).toBe('Body 2'); expect(b.visible[0].content).toBe('Body 2');
      });
      expect(requests).toBe(3); // install once, one shared check, one automatic update
    } finally { await cleanA(); await cleanB(); }
  });
  it('restores previous content when scheduler activation fails during registration', async () => {
    const dataDir = await temp(); const repo = await gitRepo(); await file(repo, 'one/SKILL.md', skillText('One', 'Old', 'Old body')); await commit(repo);
    const core = new Skillz({ dataDir }); const source = await core.addSource({ type: 'git', url: pathToFileURL(repo).href }); const old = await core.install(source.id);
    const host = runtime(dataDir, await temp()); const registration = new SkillRegistration(host.skill);
    await registration.replace([old]);
    const managed = new Skillz({ dataDir, activate: next => registration.replace(next) });
    await file(repo, 'one/SKILL.md', skillText('One', 'New', 'New body')); await commit(repo, 'update'); host.failNextReload();
    await scheduledCycle(managed.store, { automaticUpdates: true, updateIntervalMs: 1000 });
    expect(await managed.listInstalled()).toEqual([old]); expect(host.visible[0].content).toBe('Old body');
    expect(await readdir(path.dirname(old.current))).toEqual([old.version]); await registration.dispose();
  });
  it('preloads enabled sources at startup without list/reload and disposes on unload', async () => {
    const dataDir = await temp(); const root = await temp();
    await file(root, 'a/SKILL.md', skillText('A', 'Description', 'Only body'));
    await file(root, 'b/SKILL.md');
    const core = new Skillz({ dataDir }); const source = await core.addSource(root); await core.install(source.id);
    const disabledRoot = await temp(); await file(disabledRoot, 'disabled/SKILL.md');
    const disabled = await core.addSource(disabledRoot); await core.install(disabled.id); await core.setEnabled(disabled.id, false);
    const host = runtime(dataDir, await temp());
    const list = vi.spyOn(host.skill, 'list'); const cleanup = await setup(host.ctx);
    try {
      expect(list).not.toHaveBeenCalled(); expect(host.skill.reload).not.toHaveBeenCalled();
      expect(host.visible.map(s => s.id)).toEqual(['a', 'b']);
      expect(host.visible[0]).toMatchObject({ name: 'A', path: path.join(root, 'a/SKILL.md'), content: 'Only body' });
      expect(Object.hasOwn(host.visible[0], 'autoinvoke')).toBe(false); // V2 codecs reject an explicit undefined here.
      expect(host.registrations).toBe(1);
    } finally { await cleanup(); }
    expect(host.registrations).toBe(0); expect(host.visible).toEqual([]);
  });
  it('implements install, enable/disable, removal and typed RPC', async () => {
    const dataDir = await temp(); const root = await temp(); const original = await file(root, 'one/SKILL.md');
    const host = runtime(dataDir, await temp()); const cleanup = await setup(host.ctx);
    try {
      const source = await host.handlers.addSource({ input: root });
      const active = await host.handlers.install({ sourceId: source.id });
      expect(host.visible[0].path).toBe(original); expect(methods.listInstalled.output.parse(await host.handlers.listInstalled(undefined))).toEqual([active]);
      expect((await host.handlers.listAvailable(undefined))[0]).toMatchObject({ skills: ['one'], version: active.version, license: 'MIT' });
      expect(await host.handlers.listUpdateStatus()).toEqual({ checkedAt: null, updates: [] });
      const checks = await host.handlers.checkUpdates();
      const status = await host.handlers.listUpdateStatus();
      expect(methods.listUpdateStatus.output.parse(status)).toEqual({ checkedAt: expect.any(String), updates: checks });
      expect(JSON.parse(JSON.stringify(status))).toEqual(status);
      await host.handlers.setEnabled({ sourceId: source.id, enabled: false }); expect(host.visible).toEqual([]);
      expect((await host.handlers.listInstalled(undefined))[0].enabled).toBe(false);
      await host.handlers.setEnabled({ sourceId: source.id, enabled: true }); expect(host.visible).toHaveLength(1);
      await host.handlers.remove({ sourceId: source.id }); expect(host.visible).toEqual([]); expect(host.disposed).toBeGreaterThan(0);
      expect(await readdir(dataDir)).toEqual(['sources.json']); expect(await stat(original)).toBeDefined();
    } finally { await cleanup(); }
  });
  it('detects external skills discovered after initial transforms, defaults to No and restores overrides', async () => {
    const dataDir = await temp(); const root = await temp(); await file(root, 'same/SKILL.md');
    const fallback = await file(await temp(), 'same/SKILL.md', skillText('Fallback'));
    const host = runtime(dataDir, await temp()); const cleanup = await setup(host.ctx);
    try {
      host.external.push(externalSkill('same', fallback)); host.apply();
      const source = await host.handlers.addSource({ input: root });
      await expect(host.handlers.install({ sourceId: source.id })).rejects.toThrow('override declined');
      expect(host.visible[0].path).toBe(fallback); expect(await host.handlers.listInstalled(undefined)).toEqual([]);
      expect((await host.handlers.listErrors(undefined)).some(e => e.code === 'collision')).toBe(true);
      const installed = await host.handlers.install({ sourceId: source.id, options: { confirmOverride: true } });
      expect(installed.overrides).toEqual([`same overrides ${fallback}`]); expect(host.visible[0].path).not.toBe(fallback);
      expect((await host.handlers.update({ sourceId: source.id })).overrides).toEqual(installed.overrides);
      await host.handlers.remove({ sourceId: source.id }); expect(host.visible[0].path).toBe(fallback); expect(await stat(fallback)).toBeDefined();
      await host.handlers.clearErrors(undefined); expect(await host.handlers.listErrors(undefined)).toEqual([]);
    } finally { await cleanup(); }
  });
  it('rejects explicit config collisions even with Yes and verifies unknown config origins after reload', async () => {
    const directory = await temp(); const dataDir = await temp(); const configRoot = await temp();
    const fallback = await file(configRoot, 'same/SKILL.md');
    await file(directory, 'opencode.jsonc', `// Comment\n{ "skills": [${JSON.stringify(configRoot)}], }`);
    const root = await temp(); await file(root, 'same/SKILL.md');
    const host = runtime(dataDir, directory); const cleanup = await setup(host.ctx);
    try {
      host.configured.push(externalSkill('same', fallback)); host.apply();
      const source = await host.handlers.addSource({ input: root });
      await expect(host.handlers.install({ sourceId: source.id, options: { confirmOverride: true } })).rejects.toThrow('explicit config');
      expect(host.visible[0].path).toBe(fallback); expect(await host.handlers.listInstalled(undefined)).toEqual([]);
      // Simulate config from a managed/remote origin unavailable to the local path classifier.
      await file(directory, 'opencode.jsonc', '{}');
      await expect(host.handlers.install({ sourceId: source.id, options: { confirmOverride: true } })).rejects.toThrow('explicit config');
      expect(host.visible[0].path).toBe(fallback); expect(host.registrations).toBe(0);
    } finally { await cleanup(); }
  });
  it('unlinks a local source even when the restored external definition uses the exact same file', async () => {
    const root = await temp(); const original = await file(root, 'same/SKILL.md');
    const host = runtime(await temp(), await temp()); const cleanup = await setup(host.ctx);
    try {
      host.external.push(externalSkill('same', original)); host.apply();
      const source = await host.handlers.addSource({ input: root });
      await host.handlers.install({ sourceId: source.id, options: { confirmOverride: true } });
      await host.handlers.remove({ sourceId: source.id });
      expect(host.visible[0].path).toBe(original); expect(await stat(original)).toBeDefined();
    } finally { await cleanup(); }
  });
  it('switches git updates only after registration succeeds and rolls back a reload failure', async () => {
    const dataDir = await temp(); const repo = await gitRepo(); await file(repo, 'one/SKILL.md', skillText('One', 'Old', 'Old body')); const first = await commit(repo);
    const host = runtime(dataDir, await temp()); const cleanup = await setup(host.ctx);
    try {
      const source = await host.handlers.addSource({ input: { type: 'git', url: pathToFileURL(repo).href } });
      const old = await host.handlers.install({ sourceId: source.id }); expect(old.version).toBe(first);
      await file(repo, 'one/SKILL.md', skillText('One', 'New', 'New body')); const second = await commit(repo, 'new');
      host.failNextReload(); await expect(host.handlers.update({ sourceId: source.id })).rejects.toThrow('reload failed');
      expect(await host.handlers.listInstalled(undefined)).toEqual([old]); expect(host.visible[0].content).toBe('Old body');
      expect(await readdir(path.dirname(old.current))).toEqual([first]);
      const updated = await host.handlers.update({ sourceId: source.id }); expect(updated.version).toBe(second); expect(host.visible[0].content).toBe('New body');
      expect(await stat(old.current)).toBeDefined();
      await host.handlers.setEnabled({ sourceId: source.id, enabled: false });
      expect((await host.handlers.update({ sourceId: source.id })).enabled).toBe(false); expect(host.visible).toEqual([]);
    } finally { await cleanup(); }
  });
  it('rolls back enable/disable and removal if reload fails', async () => {
    const dataDir = await temp(); const root = await temp(); const original = await file(root, 'one/SKILL.md');
    const host = runtime(dataDir, await temp()); const cleanup = await setup(host.ctx);
    try {
      const source = await host.handlers.addSource({ input: root }); const old = await host.handlers.install({ sourceId: source.id });
      host.failNextReload(); await expect(host.handlers.setEnabled({ sourceId: source.id, enabled: false })).rejects.toThrow();
      expect(await host.handlers.listInstalled(undefined)).toEqual([old]); expect(host.visible).toHaveLength(1);
      host.failNextReload(); await expect(host.handlers.remove({ sourceId: source.id })).rejects.toThrow();
      expect(await host.handlers.listInstalled(undefined)).toEqual([old]); expect(host.visible[0].path).toBe(original);
    } finally { await cleanup(); }
  });
  it('updates an overridden skillz source without stealing precedence from its approved replacement', async () => {
    const dataDir = await temp(); const one = await temp(); const two = await temp();
    await file(one, 'same/SKILL.md', skillText('Older', 'Older', 'Older body'));
    await file(two, 'same/SKILL.md', skillText('Replacement', 'Replacement', 'Replacement body'));
    const host = runtime(dataDir, await temp()); const cleanup = await setup(host.ctx);
    try {
      const a = await host.handlers.addSource({ input: one }); const b = await host.handlers.addSource({ input: two });
      await host.handlers.install({ sourceId: a.id }); await host.handlers.install({ sourceId: b.id, options: { confirmOverride: true } });
      expect(host.visible[0].name).toBe('Replacement');
      await host.handlers.update({ sourceId: a.id, options: { automatic: true } });
      expect(host.visible[0].name).toBe('Replacement');
      await host.handlers.remove({ sourceId: b.id }); expect(host.visible[0].name).toBe('Older');
    } finally { await cleanup(); }
  });
  it('keeps all active locations synchronized and rolls back every location if one fails', async () => {
    const dataDir = await temp(); const root = await temp(); await file(root, 'one/SKILL.md');
    const a = runtime(dataDir, await temp()); const b = runtime(dataDir, await temp());
    const cleanA = await setup(a.ctx); const cleanB = await setup(b.ctx);
    try {
      const source = await a.handlers.addSource({ input: root });
      b.failNextReload(); await expect(a.handlers.install({ sourceId: source.id })).rejects.toThrow('reload failed');
      expect(a.visible).toEqual([]); expect(b.visible).toEqual([]); expect(await a.handlers.listInstalled(undefined)).toEqual([]);
      vi.mocked(a.skill.reload).mockClear(); vi.mocked(b.skill.reload).mockClear();
      await a.handlers.install({ sourceId: source.id }); expect(a.visible).toHaveLength(1); expect(b.visible).toHaveLength(1);
      await a.handlers.update({ sourceId: source.id });
      await a.handlers.setEnabled({ sourceId: source.id, enabled: false }); expect(a.visible).toEqual([]); expect(b.visible).toEqual([]);
      await b.handlers.setEnabled({ sourceId: source.id, enabled: true }); expect(a.visible).toHaveLength(1); expect(b.visible).toHaveLength(1);
      await b.handlers.remove({ sourceId: source.id }); expect(a.visible).toEqual([]); expect(b.visible).toEqual([]);
      expect(a.skill.reload).toHaveBeenCalledTimes(5); expect(b.skill.reload).toHaveBeenCalledTimes(5);
    } finally { await cleanA(); await cleanB(); }
  });
  it('reads skill files before installing synchronous transforms and keeps the previous snapshot on read failure', async () => {
    const host = runtime(await temp(), await temp()); const registration = new SkillRegistration(host.skill);
    const transform = vi.spyOn(host.skill, 'transform');
    await expect(registration.replace([{ sourceId: 'missing', enabled: true, version: '1', current: '/missing', skills: [{ id: 'missing', name: 'missing', description: 'missing', dir: '/missing', skillFile: '/missing/SKILL.md' }], scope: 'user', overrides: [] }])).rejects.toThrow();
    expect(transform).not.toHaveBeenCalled();
  });
  it('restores approved overrides after the filesystem/config built-in activates at startup', async () => {
    const dataDir = await temp(); const root = await temp(); await file(root, 'same/SKILL.md', skillText('Own', 'Own', 'Own body'));
    const fallback = await file(await temp(), 'same/SKILL.md');
    const core = new Skillz({ dataDir, externalSkills: async () => [{ id: 'same', path: fallback }] });
    const source = await core.addSource(root); await core.install(source.id, { confirmOverride: true });
    const host = runtime(dataDir, await temp()); const registration = new SkillRegistration(host.skill);
    await registration.replace(await core.listInstalled(), false);
    host.addFilesystem([externalSkill('same', fallback)]); expect(host.visible[0].path).toBe(fallback);
    host.setReady(); await finishStartup(host.ctx, core, registration, new AbortController().signal);
    expect(host.visible[0].content).toBe('Own body'); expect(await core.listErrors()).toEqual([]);
    await registration.dispose(); expect(host.visible[0].path).toBe(fallback);
  });
  it('does not silently approve new startup collisions and records them for the Errors tab', async () => {
    const dataDir = await temp(); const root = await temp(); await file(root, 'same/SKILL.md');
    const fallback = await file(await temp(), 'same/SKILL.md');
    const core = new Skillz({ dataDir }); const source = await core.addSource(root); await core.install(source.id);
    const host = runtime(dataDir, await temp()); const registration = new SkillRegistration(host.skill);
    await registration.replace(await core.listInstalled(), false); host.addFilesystem([externalSkill('same', fallback)]); host.setReady();
    await finishStartup(host.ctx, core, registration, new AbortController().signal);
    expect(host.visible[0].path).toBe(fallback); expect((await core.listErrors())[0]).toMatchObject({ code: 'collision', entry: source.id });
    await registration.dispose();
  });
});

describe('explicit config paths', () => {
  it('supports JSONC, ancestors, env substitution, legacy paths and symlink realpaths', async () => {
    const root = await temp(); const directory = path.join(root, 'nested'); await file(directory, 'keep', '');
    const skills = await temp(); const skill = await file(skills, 'same/SKILL.md');
    await file(root, '.opencode/opencode.jsonc', '{ // comment\n "skills": ["{env:SKILLZ_EXPLICIT}"], }');
    const env = { XDG_CONFIG_HOME: await temp(), SKILLZ_EXPLICIT: skills, OPENCODE_CONFIG_CONTENT: '{"skills":{"paths":["./extra"]}}' };
    const roots = await explicitSkillPaths(directory, env);
    expect(roots).toContain(skills); expect(await canOverridePath(skill, roots)).toBe(false);
    expect(await canOverridePath('/nonexistent/virtual/builtin.md', roots)).toBe(true);
  });
});
