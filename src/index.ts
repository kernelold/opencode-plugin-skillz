import { readFile } from 'node:fs/promises';
import { Store, type StoreOptions, type InstallOptions } from './store.js';
import { stripFrontmatter } from './frontmatter.js';
import type { Skill } from './discover.js';
import type { Source, SourceOptions } from './source.js';

export class Skillz {
  readonly store: Store;
  constructor(options: StoreOptions = {}) { this.store = new Store(options); }
  addSource(input: string | Source, opts: SourceOptions = {}) { return this.store.addSource(input, opts); }
  refresh() { return this.store.refresh(); }
  listAvailable() { return this.store.listAvailable(); }
  install(sourceId: string, opts: InstallOptions = {}) { return this.store.install(sourceId, opts); }
  checkUpdates() { return this.store.checkUpdates(); }
  update(sourceId: string, opts: InstallOptions = {}) { return this.store.update(sourceId, opts); }
  setEnabled(sourceId: string, enabled: boolean, opts: InstallOptions = {}, skillId?: string) { return this.store.setEnabled(sourceId, enabled, opts, skillId); }
  previewRemoveSource(sourceId: string) { return this.store.previewRemoveSource(sourceId); }
  removeSource(sourceId: string, skills: 'remove' | 'keep', revision?: string) { return this.store.removeSource(sourceId, skills, revision); }
  listErrors() { return this.store.listErrors(); }
  clearErrors() { return this.store.clearErrors(); }
  remove(sourceId: string, skillId?: string) { return this.store.remove(sourceId, skillId); }
  listInstalled() { return this.store.listInstalled(); }
  loadSkillBody(skill: Pick<Skill, 'skillFile'>) { return loadSkillBody(skill); }
}
export async function loadSkillBody(skill: Pick<Skill, 'skillFile'>): Promise<string> { return stripFrontmatter(await readFile(skill.skillFile, 'utf8')); }
export * from './source.js';
export * from './frontmatter.js';
export * from './discover.js';
export * from './marketplace.js';
export * from './security.js';
export * from './store.js';
export * from './fetch/git.js';
export * from './fetch/archive.js';
export * from './fetch/http.js';
export * from './fetch/http-index.js';
export * from './fetch/md-url.js';
