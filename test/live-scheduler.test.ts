import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Store, atomicJson } from '../src/store.js';
import { startScheduler } from '../src/plugin/scheduler.js';
import { temp } from './helpers.js';

describe.skipIf(process.env.SKILLZ_LIVE_MARKETPLACE !== '1')('public LiteLLM scheduler smoke', () => {
  it('fetches the live catalog and exercises startup check/update in disposable HOME/XDG state', async () => {
    const home = await temp();
    for (const [name, value] of Object.entries({ HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache') })) vi.stubEnv(name, value);
    let stop: (() => Promise<void>) | undefined;
    try {
      const store = new Store();
      await store.addSource('http://localhost:4000/claude-code/marketplace.json');
      expect(await store.refresh()).toEqual([]);
      const available = await store.listAvailable(); expect(available.length).toBeGreaterThan(0);
      const entry = available.find(s => s.name === 'six-thinking-hats') ?? available[0];
      const installed = await store.install(entry.id);
      expect(installed.skills.length).toBeGreaterThan(0);
      // The public upstream need not change during a smoke test. Force ONLY the
      // disposable installed-version marker stale, then fetch the real upstream
      // through the scheduler's normal check + automatic update path.
      await atomicJson(path.join(store.dataDir, 'installed.json'), { [entry.id]: { ...installed, version: 'live-probe-stale' } });
      const check = vi.spyOn(store, 'checkUpdates'); const update = vi.spyOn(store, 'update');
      stop = startScheduler(store, { automaticUpdates: true, updateIntervalMs: 1000 });
      await vi.waitFor(async () => expect((await store.listInstalled())[0].version).toBe(installed.version), { timeout: 120000, interval: 200 });
      expect(check).toHaveBeenCalled(); expect(update).toHaveBeenCalledWith(entry.id, { automatic: true });
      expect(await store.listErrors()).toEqual([]);
      console.log(`Live scheduler smoke: ${available.length} public catalog entries; ${entry.name}; startup check + automatic update succeeded (isolated state).`);
    } finally { await stop?.(); vi.unstubAllEnvs(); }
  }, 180000);
});
