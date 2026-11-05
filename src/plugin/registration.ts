import path from 'node:path';
import type { Plugin, Skill } from '@opencode/plugin';
import { loadSkillBody } from '../index.js';
import { CollisionError, type InstalledSource } from '../store.js';

type Registration = Awaited<ReturnType<Plugin.Context['skill']['transform']>>;
// Retain the previous snapshot, including bodies, so rollback never needs to read a changed local file.
export class SkillRegistration {
  private registration?: Registration;
  private current: Skill.Info[] = [];
  private fallbacks = new Set<string>();
  constructor(private readonly skills: Plugin.Context['skill']) {}
  async replace(sources: InstalledSource[], reload = true): Promise<() => Promise<void>> {
    const next = new Map<string, Skill.Info>();
    for (const source of sources.filter(s => s.enabled)) for (const skill of source.skills) {
      if (source.disabledSkills?.includes(skill.id)) continue;
      next.set(skill.id, {
        id: skill.id as Skill.Info['id'], name: skill.name as Skill.Info['name'], description: skill.description,
        path: path.resolve(skill.skillFile) as Skill.Info['path'], content: await loadSkillBody(skill), ...(skill.autoinvoke !== undefined ? { autoinvoke: skill.autoinvoke } : {}),
      });
    }
    const previous = this.current;
    const previousFallbacks = this.fallbacks;
    const fallbacks = new Set(sources.flatMap(source => source.skills.flatMap(skill => source.overrides
      .filter(origin => origin.startsWith(`${skill.id} overrides `))
      .map(origin => origin.slice(`${skill.id} overrides `.length)))).filter(origin => path.isAbsolute(origin)));
    try { await this.apply([...next.values()], reload, fallbacks); }
    catch (error) {
      try { await this.apply(previous, reload, previousFallbacks); }
      catch (rollback) { throw new AggregateError([error, rollback], 'Skill registration rollback failed'); }
      throw error;
    }
    return () => this.apply(previous, reload, previousFallbacks);
  }
  private async apply(snapshot: Skill.Info[], reload: boolean, fallbacks = new Set<string>()): Promise<void> {
    await this.registration?.dispose(); this.registration = undefined;
    if (snapshot.length) this.registration = await this.skills.transform(editor => {
      for (const skill of snapshot) { editor.remove(skill.id); editor.add(skill); }
    });
    if (reload) {
      await this.skills.reload();
      const { data: visible } = await this.skills.list();
      for (const skill of snapshot) {
        if (!visible.some(s => s.id === skill.id && s.path === skill.path)) {
          const collision = { id: skill.id, origin: visible.find(s => s.id === skill.id)?.path ?? 'unknown config origin', canOverride: false };
          throw new CollisionError(`Skill collision: ${skill.id}; explicit config skills cannot be overridden (from ${collision.origin})`, collision);
        }
      }
      // Disposing + reload must restore external/fallback skills, never leave stale plugin entries.
      for (const old of this.current) {
        if (!this.fallbacks.has(old.path) && !snapshot.some(s => s.id === old.id && s.path === old.path) && visible.some(s => s.id === old.id && s.path === old.path)) throw new Error(`Skill unregister cleanup failed: ${old.id}`);
      }
    }
    this.current = snapshot;
    this.fallbacks = fallbacks;
  }
  async dispose(): Promise<void> { await this.apply([], true); }
}
