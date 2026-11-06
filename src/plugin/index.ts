import { Plugin } from '@opencode/plugin';
import { Skillz } from '../index.js';
import { SkillzRpc } from '../rpc.js';
import { SkillRegistration } from './registration.js';
import { explicitSkillPaths, canOverridePath } from './config.js';
import { isCollisionError, type InstalledSource } from '../store.js';
import { schedulerOptions, startScheduler } from './scheduler.js';

// setup runs per location. Broadcast mutations to every active location in this server.
const locationsKey = Symbol.for('opencode-skillz.locations');
type Locations = Map<string, Set<{ ctx: Plugin.Context; registration: SkillRegistration }>>;
const globalState = globalThis as typeof globalThis & { [locationsKey]?: Locations };
const locations: Locations = globalState[locationsKey] ??= new Map();
// OpenCode 2.0.24 validates JSON *before* encoding RPC output. Optional object
// properties must be absent, not present with undefined (discovery uses both).
export async function jsonOutput<T>(result: Promise<T>): Promise<T> {
  return JSON.parse(JSON.stringify(await result)) as T;
}
export async function setup(ctx: Plugin.Context): Promise<() => Promise<void>> {
  const schedule = schedulerOptions(ctx.options);
  const dataDir = typeof ctx.options.dataDir === 'string' ? ctx.options.dataDir : undefined;
  const registration = new SkillRegistration(ctx.skill);
  const key = new Skillz({ dataDir }).store.dataDir;
  const group: NonNullable<ReturnType<Locations['get']>> = locations.get(key) ?? new Set(); locations.set(key, group);
  const member = { ctx, registration };
  const skillz = new Skillz({
    dataDir,
    externalSkills: async () => (await Promise.all([...group].map(async m => {
      const explicit = await explicitSkillPaths(m.ctx.location.directory);
      return Promise.all((await m.ctx.skill.list()).data.map(async s => ({ id: s.id, path: s.path, canOverride: await canOverridePath(s.path, explicit) })));
    }))).flat(),
    activate: async (next: InstalledSource[]) => {
      const undos: (() => Promise<void>)[] = [];
      const undo = async () => { for (const revert of undos.reverse()) await revert(); };
      try { for (const member of group) undos.push(await member.registration.replace(next)); }
      catch (error) { await undo(); throw error; }
      return undo;
    },
  });
  let rpc: { dispose(): Promise<void> } | undefined;
  const controller = new AbortController();
  let stopScheduler: (() => Promise<void>) | undefined;
  const cleanup = async () => {
    controller.abort();
    const attempt = async (name: string, dispose: () => Promise<void> | undefined) => {
      try { await dispose(); }
      catch (error) { console.warn(`Skillz ${name} cleanup failed`, error); }
    };
    // A pending scheduler cycle may need the store lock itself.
    await attempt('scheduler', () => stopScheduler?.());
    const release = async () => {
      group.delete(member); if (!group.size) locations.delete(key);
      await attempt('RPC', () => rpc?.dispose());
      await attempt('registration', () => registration.dispose());
    };
    try { await skillz.store.withLock(release); }
    catch (error) {
      console.warn('Skillz cleanup lock failed', error);
      await release();
    }
  };
  try {
    await skillz.store.withLock(async () => {
      // Do not call list/reload during setup: filesystem/config skill discovery follows initial transforms.
      await registration.replace(await skillz.listInstalled(), false);
      group.add(member);
    });
    rpc = await ctx.rpc.register(SkillzRpc, {
      listSources: () => jsonOutput(skillz.store.listSources()),
      addSource: input => jsonOutput(skillz.addSource(input.input, input.options)),
      previewRemoveSource: input => jsonOutput(skillz.previewRemoveSource(input.sourceId)),
      removeSource: input => skillz.removeSource(input.sourceId, input.skills, input.revision),
      refresh: () => jsonOutput(skillz.refresh()),
      listAvailable: input => jsonOutput(skillz.store.discoverAvailable(input?.sourceId)),
      install: async (input, context) => {
        try { return await jsonOutput(skillz.install(input.sourceId, input.options)); }
        catch (error) { if (isCollisionError(error)) return context.error('collision', error.message, error.collision); throw error; }
      },
      update: async (input, context) => {
        try { return await jsonOutput(skillz.update(input.sourceId, input.options)); }
        catch (error) { if (isCollisionError(error)) return context.error('collision', error.message, error.collision); throw error; }
      },
      checkUpdates: async () => {
        try { return await jsonOutput(skillz.checkUpdates()); }
        catch (error) {
          await skillz.store.reportIssues([{ code: 'check-error', message: String(error) }]).catch(() => {});
          throw error;
        }
      },
      listUpdateStatus: () => jsonOutput(skillz.store.listUpdateStatus()),
      remove: input => skillz.remove(input.sourceId, input.skillId),
      setEnabled: async (input, context) => {
        try { return await jsonOutput(skillz.setEnabled(input.sourceId, input.enabled, input.options, input.skillId)); }
        catch (error) { if (isCollisionError(error)) return context.error('collision', error.message, error.collision); throw error; }
      },
      listInstalled: () => jsonOutput(skillz.listInstalled()),
      listErrors: () => jsonOutput(skillz.listErrors()),
      clearErrors: () => skillz.clearErrors(),
    });
    // The pinned V2 runtime activates config skills after user plugins. Restore approved
    // overrides only after that built-in has finished; never guess with a startup delay.
    void finishStartup(ctx, skillz, registration, controller.signal).then(() => {
      if (!controller.signal.aborted) stopScheduler = startScheduler(skillz.store, schedule);
    }).catch(async error => {
      if (!controller.signal.aborted) await skillz.store.reportIssues([{ code: 'registration-error', message: String(error) }]);
    }).catch(() => { /* An unwritable Errors log must not produce an unhandled rejection. */ });
  } catch (error) {
    await cleanup(); throw error;
  }
  return cleanup;
}
export default Plugin.define({ id: 'skillz', setup });

export async function finishStartup(ctx: Plugin.Context, skillz: Skillz, registration: SkillRegistration, signal: AbortSignal): Promise<void> {
  const ready = async () => (await ctx.plugin.list()).data.some(p => p.id === 'opencode.config.skill' && p.state.status === 'active');
  const local = new AbortController();
  const events = ctx.event.subscribe({ signal: AbortSignal.any([signal, local.signal]) });
  // Start receiving before the readiness check so the last activation event cannot be lost.
  const iterator = events[Symbol.asyncIterator]();
  let pending = iterator.next();
  void pending.catch(() => {});
  try {
    while (!await ready()) {
      const event = await pending;
      if (event.done || signal.aborted) return;
      pending = iterator.next();
      void pending.catch(() => {});
    }
    if (signal.aborted) return;
    const issues = await skillz.store.withLock(async () => {
      if (signal.aborted) return [];
      const installed = await skillz.listInstalled();
      const visible = (await ctx.skill.list()).data;
      const expected = new Map(installed.filter(s => s.enabled).flatMap(source => source.skills.filter(skill => !source.disabledSkills?.includes(skill.id)).map(skill => [skill.id, { source, skill }] as const)));
      const explicit = await explicitSkillPaths(ctx.location.directory);
      const blocked = new Set<string>(); const issues = [];
      let changed = false;
      for (const [id, { source, skill }] of expected) {
        const other = visible.find(s => s.id === id);
        if (!other || other.path === skill.skillFile) continue;
        changed = true;
        const origin = installed.find(s => s.skills.some(k => k.id === id && k.skillFile === other.path))?.sourceId ?? other.path;
        const known = source.overrides.includes(`${id} overrides ${origin}`);
        if (!known || !await canOverridePath(other.path, explicit)) {
          blocked.add(source.sourceId);
          issues.push({ code: 'collision', message: `Skill collision at startup: ${id} (from ${other.path}); ${known ? 'explicit config skills cannot be overridden' : 'override not approved'}`, entry: source.sourceId });
        }
      }
      if (changed) await registration.replace(installed.filter(s => !blocked.has(s.sourceId)));
      return issues;
    });
    if (issues.length) await skillz.store.reportIssues(issues);
  } finally {
    // Abort the outstanding next() before returning the iterator (which otherwise waits).
    local.abort();
    await iterator.return?.().catch(() => {});
  }
}
