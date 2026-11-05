import path from 'node:path';
import type { Plugin, Skill } from '@opencode/plugin';
import { loadSkillBody } from '../index.js';
import { CollisionError, type InstalledSource } from '../store.js';

type Registration = Awaited<ReturnType<Plugin.Context['skill']['transform']>>;
// Retain the previous snapshot, including bodies, so rollback never needs to read a changed local file.
export class SkillRegistration {
  private registration?: Registration;
  private current: Skill.Info[] = [];
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
    try { await this.apply([...next.values()], reload); }
    catch (error) {
      try { await this.apply(previous, reload); }
      catch (rollback) { throw new AggregateError([error, rollback], 'Skill registration rollback failed'); }
      throw error;
    }
    return () => this.apply(previous, reload);
  }
  private async apply(snapshot: Skill.Info[], reload: boolean): Promise<void> {
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
    }
    this.current = snapshot;
  }
  // The handle owns the transform, not its visible IDs/paths: another provider (or
  // replacement instance) may expose the same files. Disposal invalidates the host
  // registry; do not reload/list location services while they are shutting down.
  async dispose(): Promise<void> { await this.apply([], false); }
}
