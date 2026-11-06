import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, rmdir, stat, writeFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { assertNoInlineCredentials, parseSource, sourceId, type Source, type SourceOptions, type Issue } from './source.js';
import { findSkills, isExcluded, type Skill } from './discover.js';
import { safeJoin, isInside, removeManagedTree, type Limits } from './security.js';
import { fetchGit } from './fetch/git.js';
import { fetchArchive } from './fetch/archive.js';
import { fetchHttpIndex } from './fetch/http-index.js';
import { fetchMd } from './fetch/md-url.js';
import { download } from './fetch/http.js';
import { parseMarketplace, type Marketplace } from './marketplace.js';

export interface SourceRecord { id: string; source: Source; options: SourceOptions; name?: string; parentId?: string; catalog?: boolean; description?: string; license?: string }
export interface AvailableSource extends SourceRecord { skills?: string[]; skillChoices?: { id: string; name: string; category?: string; excluded: boolean }[]; version?: string }
export interface InstalledSource {
  sourceId: string; version: string; current: string; skills: Skill[]; enabled: boolean; scope: 'user'; overrides: string[];
  abandoned?: boolean; formerSource?: SourceRecord; upstream?: SourceRecord; excludedSkills?: string[]; disabledSkills?: string[];
}
export interface RemovalPreview { sourceId: string; source?: SourceRecord; entries: InstalledSource[]; skillCount: number; revision: string }
export type SourceSkillChoice = 'remove' | 'keep';
export interface UpdateInfo { sourceId: string; installedVersion: string; availableVersion?: string; updateAvailable: boolean; issues: Issue[] }
export interface UpdateStatus { checkedAt: string | null; updates: UpdateInfo[] }
export function isPinned(source: Source): boolean { return source.type === 'git' ? !!(source.sha || source.ref) : source.type === 'archive-url' && !!source.sha256; }
export interface ErrorEntry extends Issue { id: string; created: string; sourceId?: string }
export interface Collision { id: string; origin: string; canOverride: boolean }
export class CollisionError extends Error {
  constructor(message: string, readonly collision: Collision) { super(message); this.name = 'CollisionError'; }
}
export function isCollisionError(error: unknown): error is CollisionError {
  if (!(error instanceof Error) || error.name !== 'CollisionError' || !('collision' in error)) return false;
  const collision = error.collision as Partial<Collision> | undefined;
  return typeof collision?.id === 'string' && typeof collision.origin === 'string' && typeof collision.canOverride === 'boolean';
}
export interface InstallOptions { confirmOverride?: boolean | ((collision: Collision) => boolean | Promise<boolean>); automatic?: boolean; exclude?: string[] }
export interface ExternalSkill { id: string; path: string; canOverride?: boolean }
export interface StoreOptions {
  dataDir?: string; lockTimeoutMs?: number; staleLockMs?: number; limits?: Partial<Limits>;
  externalSkills?: () => Promise<ExternalSkill[]>;
  // Called under the state lock before committing. Must be atomic on failure and return an undo
  // for a subsequent state-write failure. Must not call Store writes (the lock is non-reentrant).
  activate?: (next: InstalledSource[], previous: InstalledSource[]) => Promise<() => Promise<void>>;
}
interface Prepared { root: string; version: string; skills: Skill[]; issues: Issue[] }
interface RemovalTransaction { previousSources: Record<string, SourceRecord>; nextSources: Record<string, SourceRecord>; nextInstalled: InstalledSource[] }
// OpenCode versions local module graphs on reload; keep the mutex shared across those graphs.
const mutexKey = Symbol.for('opencode-skillz.mutexes');
const globalState = globalThis as typeof globalThis & { [mutexKey]?: Map<string, Promise<void>> };
const mutexes = globalState[mutexKey] ??= new Map<string, Promise<void>>();
const checksKey = Symbol.for('opencode-skillz.checks');
const checksGlobal = globalThis as typeof globalThis & { [checksKey]?: Map<string, Promise<UpdateInfo[]>> };
const checks = checksGlobal[checksKey] ??= new Map<string, Promise<UpdateInfo[]>>();
const refreshKey = Symbol.for('opencode-skillz.refreshes');
const refreshGlobal = globalThis as typeof globalThis & { [refreshKey]?: Map<string, Promise<Issue[]>> };
const refreshes = refreshGlobal[refreshKey] ??= new Map<string, Promise<Issue[]>>();
export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
}
async function json<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
}
async function exists(file: string): Promise<boolean> { try { await stat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
export function versionIdentity(input: { commit?: string; sha256?: string; version?: string; digest?: string }): string {
  const version = input.commit ?? input.sha256 ?? input.version ?? input.digest;
  if (!version) throw new Error('No version identity');
  return version;
}
async function treeDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  const info = await stat(root);
  if (info.isFile()) return hash.update(await readFile(root)).digest('hex');
  async function walk(dir: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      const file = path.join(dir, entry.name);
      hash.update(path.relative(root, file));
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) { hash.update(String((await stat(file)).mode)); hash.update(await readFile(file)); }
    }
  }
  await walk(root); return hash.digest('hex');
}
export class Store {
  readonly dataDir: string;
  private readonly options: StoreOptions;
  constructor(options: StoreOptions = {}) {
    this.options = options;
    this.dataDir = path.resolve(options.dataDir ?? path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local/share'), 'opencode-skillz'));
  }
  private file(name: string): string { return path.join(this.dataDir, name); }
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prior = mutexes.get(this.dataDir) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    mutexes.set(this.dataDir, next);
    await prior;
    const lock = this.file('.lock'); const token = randomUUID(); let held = false;
    try {
      await mkdir(this.dataDir, { recursive: true });
      const start = Date.now();
      while (!held) {
        try {
          const handle = await open(lock, 'wx', 0o600);
          try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, created: Date.now() })); } finally { await handle.close(); }
          held = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          try {
            const info = await stat(lock);
            let owner: { pid?: number } = {};
            try { owner = await json<{ pid?: number }>(lock, {}); } catch { /* A crashed writer can leave an empty lock. */ }
            let alive = false;
            if (owner.pid) { try { process.kill(owner.pid, 0); alive = true; } catch (error) { alive = (error as NodeJS.ErrnoException).code === 'EPERM'; } }
            if (!alive && Date.now() - info.mtimeMs > (this.options.staleLockMs ?? 300000)) {
              const current = await stat(lock);
              if (current.ino === info.ino && current.mtimeMs === info.mtimeMs) await rm(lock, { force: true });
              continue;
            }
          } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; }
          if (Date.now() - start >= (this.options.lockTimeoutMs ?? 10000)) throw new Error('State lock timeout');
          await delay(20);
        }
      }
      // Resolve an interrupted two-file source/installation transaction before any
      // new writer (including scheduler or plugin setup) can observe it.
      const transaction = await json<RemovalTransaction | null>(this.file('removal.json'), null);
      if (transaction) {
        const committed = JSON.stringify(await this.listInstalled()) === JSON.stringify(transaction.nextInstalled);
        await this.writeSources(committed ? transaction.nextSources : transaction.previousSources);
        await rm(this.file('removal.json'), { force: true });
        await this.recordIssues([{ code: 'removal-recovered', message: `Interrupted source removal ${committed ? 'committed' : 'rolled back'}; unreferenced cache may remain` }]);
      }
      return await fn();
    } finally {
      try { if (held) { const owner = await json<{ token?: string }>(lock, {}); if (owner.token === token) await rm(lock, { force: true }); } }
      finally { release(); if (mutexes.get(this.dataDir) === next) mutexes.delete(this.dataDir); }
    }
  }
  async listSources(): Promise<SourceRecord[]> { return Object.values(await json<Record<string, SourceRecord>>(this.file('sources.json'), {})); }
  async listInstalled(): Promise<InstalledSource[]> { return Object.values(await json<Record<string, InstalledSource>>(this.file('installed.json'), {})); }
  async listUpdateStatus(): Promise<UpdateStatus> {
    const status = await json<UpdateStatus>(this.file('updates.json'), { checkedAt: null, updates: [] });
    const installed = await this.listInstalled();
    const updates = status.updates.flatMap(update => {
      const current = installed.find(s => !s.abandoned && s.sourceId === update.sourceId);
      if (!current) return [];
      if (current.version === update.installedVersion) return [update];
      // An automatic/manual update may have installed the checked version.
      return !update.issues.length && current.version === update.availableVersion
        ? [{ ...update, installedVersion: current.version, updateAvailable: false }] : [];
    });
    return { checkedAt: updates.length === installed.filter(s => !s.abandoned).length ? status.checkedAt : null, updates };
  }
  async listErrors(): Promise<ErrorEntry[]> { return json(this.file('errors.json'), []); }
  async clearErrors(): Promise<void> { await this.withLock(() => rm(this.file('errors.json'), { force: true })); }
  private async clean<T>(value: T): Promise<T> {
    const secrets = (await this.listSources()).flatMap(s => { const env = s.options.auth?.authEnv; return env && process.env[env] ? [process.env[env]!] : []; });
    const visit = (item: unknown): unknown => typeof item === 'string' ? secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), item)
      : Array.isArray(item) ? item.map(visit) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([k, v]) => [k, visit(v)])) : item;
    return visit(value) as T;
  }
  private async recordIssues(issues: Issue[], sourceId?: string): Promise<void> {
    if (!issues.length) return;
    const entries = (await this.clean(issues)).map(issue => ({ ...issue, id: randomUUID(), created: new Date().toISOString(), sourceId }));
    await atomicJson(this.file('errors.json'), [...await this.listErrors(), ...entries]);
  }
  async reportIssues(issues: Issue[], sourceId?: string): Promise<void> { await this.withLock(() => this.recordIssues(issues, sourceId)); }
  private async switchInstalled(next: InstalledSource[], previous: InstalledSource[]): Promise<void> {
    let undo: (() => Promise<void>) | undefined;
    try {
      undo = await this.options.activate?.(next, previous);
      if (next.length) await atomicJson(this.file('installed.json'), Object.fromEntries(next.map(s => [s.sourceId, s])));
      else await rm(this.file('installed.json'), { force: true });
    } catch (error) {
      try { await undo?.(); }
      catch (rollback) { throw new AggregateError([error, rollback], 'Activation and registration rollback failed'); }
      throw error;
    }
  }
  private async collisions(skills: Skill[], id: string, installed: InstalledSource[], opts: InstallOptions, previous?: InstalledSource): Promise<string[]> {
    const collisions: Collision[] = [];
    for (const other of installed.filter(s => s.sourceId !== id && s.enabled)) for (const skill of other.skills) {
      if (other.disabledSkills?.includes(skill.id)) continue;
      // Updating an older, deliberately shadowed source must not reverse its precedence.
      if (previous?.skills.some(s => s.id === skill.id) && other.overrides.includes(`${skill.id} overrides ${id}`)) continue;
      if (skills.some(s => s.id === skill.id)) collisions.push({ id: skill.id, origin: other.sourceId, canOverride: true });
    }
    const managedPaths = new Set(installed.flatMap(s => s.skills.map(k => k.skillFile)));
    for (const skill of await this.options.externalSkills?.() ?? []) {
      if (!managedPaths.has(skill.path) && skills.some(s => s.id === skill.id)) collisions.push({ id: skill.id, origin: skill.path, canOverride: skill.canOverride !== false });
    }
    // Overridden external definitions are hidden by our current registry entry. Retain their
    // approvals across updates; otherwise a restart would forget why this source takes priority.
    const overrides = previous?.overrides.filter(origin => skills.some(skill => origin.startsWith(`${skill.id} overrides `))) ?? [];
    for (const collision of new Map(collisions.map(c => [`${c.id}:${c.origin}`, c])).values()) {
      const key = `${collision.id} overrides ${collision.origin}`;
      const known = previous?.overrides.includes(key);
      const confirmed = collision.canOverride && (known || (!opts.automatic && (typeof opts.confirmOverride === 'function' ? await opts.confirmOverride(collision) : opts.confirmOverride === true)));
      if (!confirmed) {
        const message = `Skill collision: ${collision.id} (from ${collision.origin})${collision.canOverride ? '; override declined (default No)' : '; explicit config skills cannot be overridden'}`;
        throw new CollisionError(message, collision);
      }
      if (!overrides.includes(key)) overrides.push(key);
    }
    return overrides;
  }
  async addSource(input: string | Source, options: SourceOptions = {}): Promise<SourceRecord> {
    if (options.exclude !== undefined && (!Array.isArray(options.exclude) || !options.exclude.every(s => typeof s === 'string'))) throw new Error('exclude must be a string array');
    const source = typeof input === 'string' ? parseSource(input) : structuredClone(input);
    if (source.type === 'local') source.path = path.resolve(source.path);
    if ('url' in source) assertNoInlineCredentials(source.url);
    if (options.auth) {
      if (!/^[a-zA-Z_][a-zA-Z\d_]*$/.test(options.auth.authEnv)) throw new Error('Invalid auth environment variable name');
      if (/[\r\n]/.test(`${options.auth.header ?? ''}${options.auth.prefix ?? ''}${options.auth.query ?? ''}`)) throw new Error('Invalid auth reference');
      const secret = process.env[options.auth.authEnv];
      if (secret && JSON.stringify({ source, options }).includes(secret)) throw new Error('Auth value must not be stored in source configuration');
    }
    if (source.type === 'archive-url' && options.sha256) source.sha256 = options.sha256;
    if (source.type === 'archive-url' && source.sha256) {
      if (!/^[a-fA-F0-9]{64}$/.test(source.sha256)) throw new Error('sha256 must be 64 hex characters');
      source.sha256 = source.sha256.toLowerCase();
    }
    const record = { id: sourceId(source), source, options };
    return this.withLock(async () => {
      const sources = await json<Record<string, SourceRecord>>(this.file('sources.json'), {});
      const before = { ...sources };
      sources[record.id] = record;
      await this.writeSources(sources);
      try { await this.readopt(sources); }
      catch (error) { await this.writeSources(before); throw error; }
      return record;
    });
  }
  private async fetched(record: SourceRecord, stage: string): Promise<{ root: string; version?: string; plainFiles?: string[] }> {
    const s = record.source;
    const opts = { auth: record.options.auth, limits: this.options.limits };
    if (s.type === 'local') return { root: await realpath(s.path) };
    if (s.type === 'git') return { root: stage, ...(await fetchGit(s, stage)) };
    if (s.type === 'archive-url') return { root: stage, ...(await fetchArchive(s, stage, opts)) };
    if (s.type === 'md-url') return { root: await fetchMd(s.url, stage, opts) };
    if (s.type === 'http-folder') return { root: stage, ...(await fetchHttpIndex(s.url, stage, opts)) };
    throw new Error('A marketplace is a catalog; install one of its entries');
  }
  private async prepare(record: SourceRecord, stage: string, preview = false): Promise<Prepared> {
    const fetched = await this.fetched(record, stage);
    let location = record.source.type === 'local' ? record.source.path : record.source.type === 'git' && record.source.subpath ? record.source.subpath : record.source.url;
    try { location = new URL(location).pathname; } catch { /* Local git paths and SCP-style URLs are not WHATWG URLs. */ }
    const rootName = record.name ?? path.basename(location).replace(/\.(git|zip|tgz|tar\.gz)$/, '');
    const discovery = await findSkills(fetched.root, { skills: record.options.skills, exclude: preview ? undefined : record.options.exclude, rootName });
    if (!record.options.skills) for (const file of fetched.plainFiles ?? []) {
      const plain = await findSkills(file, { exclude: preview ? undefined : record.options.exclude });
      discovery.issues.push(...plain.issues);
      for (const skill of plain.skills) {
        if (discovery.skills.some(s => s.id === skill.id)) discovery.issues.push({ code: 'collision', message: `Duplicate skill ID: ${skill.id}`, path: file });
        else discovery.skills.push(skill);
      }
    }
    const metadataVersion = discovery.skills.length === 1 ? discovery.skills[0].version : discovery.skills.length && discovery.skills.every(s => s.version) ? `metadata-${createHash('sha256').update(JSON.stringify(discovery.skills.map(s => [s.id, s.version]).sort(([a], [b]) => a!.localeCompare(b!)))).digest('hex')}` : undefined;
    const version = versionIdentity({ commit: record.source.type === 'git' ? fetched.version : undefined, sha256: record.source.type === 'archive-url' ? fetched.version : undefined, version: record.options.version ?? (record.source.type === 'http-folder' ? fetched.version : undefined) ?? metadataVersion, digest: await treeDigest(fetched.root) });
    return { ...discovery, root: fetched.root, version };
  }
  private async staging<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = this.file(`staging/${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    try { return await fn(dir); } finally {
      await removeManagedTree(dir);
      try { await rmdir(this.file('staging')); } catch { /* Other staging work may still exist. */ }
    }
  }
  async install(id: string, opts: InstallOptions = {}): Promise<InstalledSource> {
    return this.withLock(async () => {
      try {
        const savedRecord = (await this.listSources()).find(s => s.id === id);
        let record = savedRecord;
        const existing = (await this.listInstalled()).find(s => s.sourceId === id);
        // A scheduled check can finish just before deletion. Recheck under the mutation
        // lock: never resurrect a removed/abandoned entry from that stale result.
        if (opts.automatic && (!record || !existing || existing.abandoned)) {
          if (existing) return existing;
          throw new Error(`Source removed; automatic update skipped: ${id}`);
        }
        if (existing?.abandoned) throw new Error(`Skill source is abandoned: ${id}; add the same source to re-adopt it`);
        if (!record) throw new Error(`Unknown source: ${id}`);
        if (opts.exclude !== undefined) {
          if (!Array.isArray(opts.exclude) || !opts.exclude.every(s => typeof s === 'string')) throw new Error('exclude must be a string array');
          record = { ...record, options: { ...record.options, exclude: [...opts.exclude] } };
        }
        const selectedRecord = record;
        if (record.catalog) throw new Error('A marketplace is a catalog; install one of its entries');
        if (opts.automatic && isPinned(record.source)) {
          const current = (await this.listInstalled()).find(s => s.sourceId === id);
          if (current) return current;
        }
        return await this.staging(async stage => {
          const ready = await this.prepare(selectedRecord, stage);
          ready.skills = ready.skills.filter(s => opts.exclude !== undefined || !existing?.excludedSkills?.includes(s.id));
          await this.recordIssues(ready.issues, id);
          if (ready.issues.some(i => i.code !== 'unsupported-component') || !ready.skills.length) throw new Error(`Source validation failed: ${ready.issues.map(i => i.message).join('; ') || 'No skills found'}`);
          const installed = await json<Record<string, InstalledSource>>(this.file('installed.json'), {});
          const previous = installed[id];
          const overrides = await this.collisions(ready.skills.filter(s => !previous?.disabledSkills?.includes(s.id)), id, Object.values(installed), opts, previous);
          const local = record.source.type === 'local';
          // installed.json is the authoritative, atomically replaced current-version pointer.
          const versionDir = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,127}$/.test(ready.version) ? ready.version : createHash('sha256').update(ready.version).digest('hex');
          const destination = local ? ready.root : this.file(`cache/${id}/${versionDir}`);
          const mapPath = (file: string) => local ? file : (path.resolve(ready.root) === path.resolve(stage) ? path.join(destination, path.relative(stage, file)) : path.join(destination, path.basename(file)));
          const skills = ready.skills.map(s => ({ ...s, dir: local ? s.dir : path.dirname(mapPath(s.skillFile)), skillFile: mapPath(s.skillFile) }));
          let created = false; let committed = false;
          try {
            if (!local && !(await exists(destination))) {
              await mkdir(path.dirname(destination), { recursive: true });
              await rename(stage, destination); created = true;
            }
            const active: InstalledSource = { sourceId: id, version: ready.version, current: destination, skills, enabled: previous?.enabled ?? true, scope: 'user', overrides, upstream: record, ...(previous?.excludedSkills ? { excludedSkills: opts.exclude !== undefined ? [] : previous.excludedSkills } : {}), ...(previous?.disabledSkills ? { disabledSkills: previous.disabledSkills } : {}) };
            const before = Object.values(installed);
            const changedPriority = overrides.some(origin => !previous?.overrides.includes(origin));
            const next = previous && !changedPriority ? before.map(s => s.sourceId === id ? active : s) : [...before.filter(s => s.sourceId !== id), active];
            if (opts.exclude !== undefined) {
              const previousSources = Object.fromEntries((await this.listSources()).map(s => [s.id, s]));
              const nextSources = { ...previousSources, [id]: selectedRecord };
              await atomicJson(this.file('removal.json'), { previousSources, nextSources, nextInstalled: next } satisfies RemovalTransaction);
              try { await this.writeSources(nextSources); await this.switchInstalled(next, before); committed = true; }
              catch (error) { await this.writeSources(previousSources); await rm(this.file('removal.json'), { force: true }); throw error; }
              await rm(this.file('removal.json'), { force: true });
            } else { await this.switchInstalled(next, before); committed = true; }
            return active;
          } catch (error) { if (created && !committed) await removeManagedTree(destination); throw error; }
        });
      } catch (error) { await this.recordIssues([{ code: isCollisionError(error) ? 'collision' : 'install-error', message: String(error) }], id); throw error; }
    });
  }
  async update(id: string, opts: InstallOptions = {}): Promise<InstalledSource> {
    try { return await this.install(id, opts); }
    catch (error) {
      if (opts.automatic && isCollisionError(error)) {
        const previous = (await this.listInstalled()).find(s => s.sourceId === id);
        if (previous) { await this.reportIssues([{ code: 'update-skipped', message: error.message }], id); return previous; }
      }
      throw error;
    }
  }
  async setEnabled(id: string, enabled: boolean, opts: InstallOptions = {}, skillId?: string): Promise<InstalledSource> {
    return this.withLock(async () => {
      try {
        const installed = await this.listInstalled(); const current = installed.find(s => s.sourceId === id);
        if (!current) throw new Error(`Source is not installed: ${id}`);
        if (skillId !== undefined) {
          const skill = current.skills.find(s => s.id === skillId);
          if (!skill) throw new Error(`Skill is not installed from ${id}: ${skillId}`);
          const disabledSkills = new Set(current.disabledSkills ?? []);
          if (enabled === !disabledSkills.has(skillId)) return current;
          if (enabled) disabledSkills.delete(skillId); else disabledSkills.add(skillId);
          const overrides = enabled && current.enabled
            ? [...new Set([...current.overrides, ...await this.collisions([skill], id, installed, opts, current)])] : current.overrides;
          const active = { ...current, disabledSkills: [...disabledSkills], overrides };
          const changedPriority = overrides.some(origin => !current.overrides.includes(origin));
          const next = changedPriority ? [...installed.filter(s => s.sourceId !== id), active] : installed.map(s => s.sourceId === id ? active : s);
          await this.switchInstalled(next, installed); return active;
        }
        if (current.enabled === enabled) return current;
        const active = { ...current, enabled, overrides: enabled ? await this.collisions(current.skills.filter(s => !current.disabledSkills?.includes(s.id)), id, installed, opts, current) : current.overrides };
        const changedPriority = active.overrides.some(origin => !current.overrides.includes(origin));
        const next = changedPriority ? [...installed.filter(s => s.sourceId !== id), active] : installed.map(s => s.sourceId === id ? active : s);
        await this.switchInstalled(next, installed);
        return active;
      } catch (error) { await this.recordIssues([{ code: isCollisionError(error) ? 'collision' : 'activation-error', message: String(error) }], id); throw error; }
    });
  }
  checkUpdates(): Promise<UpdateInfo[]> {
    const pending = checks.get(this.dataDir);
    if (pending) return pending;
    const task = this.runChecks().finally(() => { if (checks.get(this.dataDir) === task) checks.delete(this.dataDir); });
    checks.set(this.dataDir, task);
    return task;
  }
  private async runChecks(): Promise<UpdateInfo[]> {
    return this.withLock(async () => {
      const sources = await this.listSources(); const result: UpdateInfo[] = [];
      for (const installed of await this.listInstalled()) {
        if (installed.abandoned) continue;
        const record = sources.find(s => s.id === installed.sourceId);
        if (!record) continue;
        try {
          const ready = await this.staging(stage => this.prepare(record, stage));
          result.push({ sourceId: record.id, installedVersion: installed.version, availableVersion: ready.version, updateAvailable: installed.version !== ready.version, issues: ready.issues });
        } catch (error) { result.push({ sourceId: record.id, installedVersion: installed.version, updateAvailable: false, issues: [{ code: 'fetch-error', message: String(error) }] }); }
      }
      for (const item of result) await this.recordIssues(item.issues, item.sourceId);
      const clean = await this.clean(result);
      await atomicJson(this.file('updates.json'), { checkedAt: new Date().toISOString(), updates: clean });
      return clean;
    });
  }
  refresh(): Promise<Issue[]> {
    const pending = refreshes.get(this.dataDir);
    if (pending) return pending;
    const task = this.runRefresh().finally(() => { if (refreshes.get(this.dataDir) === task) refreshes.delete(this.dataDir); });
    refreshes.set(this.dataDir, task);
    return task;
  }
  private async runRefresh(): Promise<Issue[]> {
    return this.withLock(async () => {
      const sources = await json<Record<string, SourceRecord>>(this.file('sources.json'), {});
      const issues: Issue[] = [];
      for (const record of Object.values(sources).filter(r => !r.parentId)) {
        try {
          await this.staging(async stage => {
            let marketplace: Marketplace;
            if (record.source.type === 'marketplace-url') marketplace = parseMarketplace((await download(record.source.url, { auth: record.options.auth, limits: this.options.limits })).toString('utf8'), { url: record.source.url });
            else {
              const { root } = await this.fetched(record, stage);
              if ((await stat(root)).isFile()) return;
              const file = path.join(root, '.claude-plugin/marketplace.json');
              if (!(await exists(file))) { if (record.catalog) throw new Error('Marketplace manifest not found'); return; }
              marketplace = parseMarketplace(await readFile(file, 'utf8'), { rootDir: root });
              if (record.source.type !== 'local') {
                for (const entry of marketplace.entries) {
                  if (entry.source.type !== 'local') continue;
                  const relative = path.relative(root, entry.source.path);
                  if (record.source.type !== 'git') throw new Error('Relative entries in archive/HTTP catalogs are not supported');
                  entry.source = { ...record.source, subpath: [record.source.subpath, relative].filter(Boolean).join('/') || undefined };
                }
              }
            }
            issues.push(...marketplace.issues);
            record.catalog = true;
            const installedIds = new Set((await this.listInstalled()).map(s => s.sourceId));
            const names = new Set(marketplace.entries.map(e => e.name));
            for (const old of Object.values(sources)) if (old.parentId === record.id && !names.has(old.name!) && !installedIds.has(old.id)) delete sources[old.id];
            for (const entry of marketplace.entries) {
              const id = record.id + '-' + createHash('sha256').update(entry.name).digest('hex').slice(0, 12);
              sources[id] = { id, source: entry.source, name: entry.name, description: entry.description, license: typeof entry.manifest.license === 'string' ? entry.manifest.license : undefined, parentId: record.id, options: { skills: entry.skills, exclude: sources[id]?.options.exclude ?? entry.exclude, version: entry.version, auth: record.options.auth } };
            }
          });
        } catch (error) { issues.push({ code: 'fetch-error', message: String(error), entry: record.id }); }
      }
      await atomicJson(this.file('sources.json'), sources); await this.readopt(sources); await this.recordIssues(issues); return issues;
    });
  }
  async listAvailable(): Promise<SourceRecord[]> { return (await this.listSources()).filter(r => r.source.type !== 'marketplace-url' && !r.catalog); }
  async discoverAvailable(id?: string): Promise<AvailableSource[]> {
    const installed = await this.listInstalled();
    const records = (await this.listAvailable()).filter(s => !id || s.id === id);
    if (id && !records.length) throw new Error(`Unknown available source: ${id}`);
    // Listing cached metadata must never queue behind a network writer's lock.
    if (!id) return records.map(record => {
      const active = installed.find(s => s.sourceId === record.id);
      return { ...record, skills: active?.skills.map(s => s.id) ?? record.options.skills, version: record.options.version ?? active?.version, license: record.license ?? active?.skills.find(s => s.license)?.license };
    });
    return this.withLock(async () => Promise.all(records.map(async record => {
      try {
        return await this.staging(async stage => {
          const ready = await this.prepare(record, stage, true); await this.recordIssues(ready.issues, id);
          const active = installed.find(s => s.sourceId === id);
          return { ...record, skills: ready.skills.map(s => s.id), skillChoices: ready.skills.map(s => ({ id: s.id, name: s.name, category: s.category, excluded: isExcluded(s, record.options.exclude) || active?.excludedSkills?.includes(s.id) === true })), version: ready.version, license: record.license ?? ready.skills.find(s => s.license)?.license };
        });
      } catch (error) { await this.recordIssues([{ code: 'fetch-error', message: String(error) }], id); throw error; }
    })));
  }
  private async writeSources(sources: Record<string, SourceRecord>): Promise<void> {
    if (Object.keys(sources).length) await atomicJson(this.file('sources.json'), sources);
    else await rm(this.file('sources.json'), { force: true });
  }
  private async readopt(sources: Record<string, SourceRecord>): Promise<void> {
    const before = await this.listInstalled();
    const identity = (r: SourceRecord) => JSON.stringify([sourceId(r.source), r.options.skills ?? null, r.options.exclude ?? null, r.options.version ?? null]);
    const next = before.map(entry => {
      const record = sources[entry.sourceId];
      if (!entry.abandoned || !entry.formerSource || !record || identity(record) !== identity(entry.formerSource)) return entry;
      const { abandoned: _abandoned, formerSource: _former, ...rest } = entry;
      return { ...rest, upstream: record };
    });
    if (next.some((s, i) => s !== before[i])) await this.switchInstalled(next, before);
  }
  private removalIds(id: string, sources: SourceRecord[]): Set<string> {
    const ids = new Set([id]);
    // Catalog membership is recorded provenance, never an upstream/name match.
    for (const record of sources) if (record.parentId === id) ids.add(record.id);
    return ids;
  }
  private removalRevision(id: string, sources: SourceRecord[], entries: InstalledSource[]): string {
    const ids = this.removalIds(id, sources);
    return createHash('sha256').update(JSON.stringify([sources.filter(s => ids.has(s.id)), entries])).digest('hex');
  }
  async previewRemoveSource(id: string): Promise<RemovalPreview> {
    return this.withLock(async () => {
      const sources = await this.listSources(); const ids = this.removalIds(id, sources);
      const entries = (await this.listInstalled()).filter(s => !s.abandoned && ids.has(s.sourceId));
      return { sourceId: id, source: sources.find(s => s.id === id), entries, skillCount: entries.reduce((n, s) => n + s.skills.length, 0), revision: this.removalRevision(id, sources, entries) };
    });
  }
  // Only a recorded version directory owned by this exact origin may be deleted.
  // Check EVERY ancestor with lstat: rm does not follow a final link, but would
  // follow a symlink in cache/<id> without these checks.
  private async cleanupRemoved(removed: InstalledSource[], remaining: InstalledSource[]): Promise<void> {
    for (const entry of removed) {
      if (!/^[a-zA-Z0-9_-]+$/.test(entry.sourceId)) continue;
      const owner = entry.upstream ?? entry.formerSource;
      // Older installed.json entries have no upstream snapshot. Their caller must
      // supply the live source record, otherwise ownership is unknown: retain files.
      if (!owner || owner.id !== entry.sourceId || owner.source.type === 'local') continue;
      const root = safeJoin(this.file('cache'), entry.sourceId);
      const target = path.resolve(entry.current);
      if (path.dirname(target) !== root) continue;
      if (remaining.some(s => isInside(s.current, target) || [s.current, ...s.skills.map(k => k.skillFile)].some(p => isInside(target, p)))) continue;
      if (await realpath(this.dataDir) !== this.dataDir) continue;
      let safe = true;
      for (const dir of [this.dataDir, this.file('cache'), root, target]) {
        try { const info = await lstat(dir); if (info.isSymbolicLink() || !info.isDirectory()) { safe = false; break; } }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { safe = false; break; } throw error; }
      }
      if (!safe) continue;
      await removeManagedTree(target);
      if (await exists(target)) throw new Error(`Removal cache cleanup failed: ${target}`);
      try { await rmdir(root); } catch { /* Historical or shared versions survive. */ }
    }
    try { await rmdir(this.file('cache')); } catch { /* Keep referenced versions. */ }
  }
  private async finishRemoval(removed: InstalledSource[], next: InstalledSource[]): Promise<void> {
    try { await this.cleanupRemoved(removed, next); }
    catch (error) {
      // Registration/state have committed; never roll back to files already deleted.
      await this.recordIssues([{ code: 'removal-cleanup-error', message: `Skills unregistered; managed cache cleanup incomplete: ${String(error)}` }]);
      throw new Error(`Removal committed, but cache cleanup incomplete: ${String(error)}`);
    }
    if (!next.length) await rm(this.file('updates.json'), { force: true });
  }
  async removeSource(id: string, skills: SourceSkillChoice, revision?: string): Promise<void> {
    if (skills !== 'remove' && skills !== 'keep') throw new Error('Choose whether to remove or keep installed skills');
    await this.withLock(async () => {
      const sources = await json<Record<string, SourceRecord>>(this.file('sources.json'), {});
      if (!sources[id]) return; // Retry must not delete an already-abandoned entry.
      const before = await this.listInstalled(); const ids = this.removalIds(id, Object.values(sources));
      const affected = before.filter(s => !s.abandoned && ids.has(s.sourceId));
      if (revision !== undefined && revision !== this.removalRevision(id, Object.values(sources), affected)) throw new Error('Source changed since removal preview; review it again');
      const next = before.flatMap(s => !affected.includes(s) ? [s] : skills === 'remove' ? []
        : [{ ...s, abandoned: true, formerSource: sources[s.sourceId] ?? s.upstream }]);
      const nextSources = Object.fromEntries(Object.entries(sources).filter(([key]) => !ids.has(key)));
      // installed.json is the atomic authoritative registration snapshot. Source
      // metadata is restored if activation/state commit fails; no cache is touched.
      await atomicJson(this.file('removal.json'), { previousSources: sources, nextSources, nextInstalled: next } satisfies RemovalTransaction);
      try {
        await this.writeSources(nextSources);
        await this.switchInstalled(next, before);
      } catch (error) {
        await this.writeSources(sources);
        await rm(this.file('removal.json'), { force: true });
        throw error;
      }
      await rm(this.file('removal.json'), { force: true });
      await this.finishRemoval(skills === 'remove' ? affected.map(s => ({ ...s, upstream: s.upstream ?? sources[s.sourceId] })) : [], next);
    });
  }
  async remove(id: string, skillId?: string): Promise<void> {
    await this.withLock(async () => {
      const before = await this.listInstalled(); const entry = before.find(s => s.sourceId === id);
      if (!entry || (skillId && !entry.skills.some(s => s.id === skillId))) return;
      const skills = skillId ? entry.skills.filter(s => s.id !== skillId) : [];
      const next = before.flatMap(s => s !== entry ? [s] : skills.length ? [{ ...s, skills, excludedSkills: [...new Set([...(s.excludedSkills ?? []), skillId!])] }] : []);
      const owner = entry.upstream ?? entry.formerSource ?? (await this.listSources()).find(s => s.id === id);
      await this.switchInstalled(next, before);
      await this.finishRemoval([{ ...entry, upstream: owner }], next);
    });
  }
}
