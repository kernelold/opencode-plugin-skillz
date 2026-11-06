import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, type Store, type UpdateInfo } from '../store.js';

export interface SchedulerOptions { automaticUpdates: boolean; updateIntervalMs: number }
export const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
export function schedulerOptions(options: Record<string, unknown>): SchedulerOptions {
  if (options.automaticUpdates !== undefined && typeof options.automaticUpdates !== 'boolean') throw new Error('automaticUpdates must be a boolean');
  const interval = options.updateIntervalMs ?? DEFAULT_INTERVAL_MS;
  if (typeof interval !== 'number' || !Number.isSafeInteger(interval) || interval < 1000 || interval > 2147483647) throw new Error('updateIntervalMs must be an integer from 1000 to 2147483647');
  return { automaticUpdates: options.automaticUpdates !== false, updateIntervalMs: interval };
}
interface Schedule { nextRun: number; running?: { pid: number; token: string } }
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
// Claim under the SAME lock as state mutations, then release it before calling Store
// methods (the lock is deliberately non-reentrant). A live owner prevents overlapping
// cycles, even if a slow download takes longer than the configured interval.
export async function scheduledCycle(store: Store, options: SchedulerOptions, now = Date.now()): Promise<UpdateInfo[] | undefined> {
  const file = path.join(store.dataDir, 'scheduler.json');
  const token = randomUUID();
  const read = async (): Promise<Schedule> => {
    try { return JSON.parse(await readFile(file, 'utf8')) as Schedule; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { nextRun: 0 }; throw error; }
  };
  const claimed = await store.withLock(async () => {
    const state = await read();
    if (state.running && alive(state.running.pid)) return false;
    if (!state.running && state.nextRun > now) return false;
    await atomicJson(file, { nextRun: now + options.updateIntervalMs, running: { pid: process.pid, token } });
    return true;
  });
  if (!claimed) return;
  try {
    const checks = await store.checkUpdates();
    if (options.automaticUpdates) for (const check of checks) {
      if (!check.updateAvailable || check.issues.length) continue;
      try { await store.update(check.sourceId, { automatic: true }); }
      catch { /* Store records failures; continue updating independent sources. */ }
    }
    return checks;
  } finally {
    await store.withLock(async () => {
      const state = await read();
      if (state.running?.token === token) await atomicJson(file, { nextRun: now + options.updateIntervalMs });
    });
  }
}

interface Client { store: Store; options: SchedulerOptions }
interface Scheduler { clients: Set<Client>; timer: NodeJS.Timeout; pending: Promise<unknown> }
const key = Symbol.for('opencode-skillz.schedulers');
const globals = globalThis as typeof globalThis & { [key]?: Map<string, Scheduler> };
const schedulers = globals[key] ??= new Map<string, Scheduler>();
// Per-location setup shares one timer. Cross-server exclusion uses scheduler.json
// under .lock. First active location's options win until it unloads.
export function startScheduler(store: Store, options: SchedulerOptions): () => Promise<void> {
  const client = { store, options };
  let scheduler = schedulers.get(store.dataDir);
  if (!scheduler) {
    const clients = new Set<Client>();
    const tick = async () => {
      const first = clients.values().next().value as Client | undefined;
      if (!first) return;
      try { await scheduledCycle(first.store, first.options); }
      catch (error) { await first.store.reportIssues([{ code: 'scheduler-error', message: String(error) }]).catch(() => {}); }
    };
    scheduler = { clients, timer: setInterval(() => { scheduler!.pending = scheduler!.pending.then(tick); }, Math.min(options.updateIntervalMs, 60000)), pending: Promise.resolve() };
    scheduler.timer.unref();
    schedulers.set(store.dataDir, scheduler);
    clients.add(client);
    scheduler.pending = tick();
  } else scheduler.clients.add(client);
  return async () => {
    scheduler!.clients.delete(client);
    if (!scheduler!.clients.size) {
      clearInterval(scheduler!.timer);
      schedulers.delete(store.dataDir);
    }
    await scheduler!.pending;
  };
}
