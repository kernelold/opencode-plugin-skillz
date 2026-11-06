import { Plugin } from '@opencode/plugin/tui';
import { SkillzRpc, type SkillzMethods } from '../rpc.js';
import { SkillzManager } from './controller.js';

export function createRpc(context: Plugin.Context, active = () => true): SkillzMethods {
  // Read context.client per call: OpenCode replaces it after reconnecting. Always
  // scope calls to the current/default location, including on the home screen.
  const options = () => ({ location: context.location ?? context.data.location.default() });
  const client = () => context.client.rpc(SkillzRpc);
  const mutate = async <T>(action: (scope: ReturnType<typeof options>) => Promise<T>): Promise<T> => {
    const scope = options();
    const result = await action(scope);
    if (!active()) return result;
    // 2.0.24 strips Location from user-plugin execution (core/plugin.ts), so
    // skill.reload emits an unlocated skill.updated that client/solid ignores.
    // Refresh the native cache after the RPC commits, not the Location services:
    // this neither disposes plugins nor interrupts a running model turn.
    try {
      context.data.location.skill.invalidate(scope.location);
      await context.data.location.skill.sync(scope.location);
    } catch {
      if (active()) context.ui.toast.show({ title: 'Skillz', variant: 'warning',
        message: 'Change saved, but OpenCode skill inventory could not be refreshed.' });
    }
    return result;
  };
  return {
    listSources: () => client().listSources(undefined, options()),
    listAvailable: input => client().listAvailable(input, options()),
    listInstalled: () => client().listInstalled(undefined, options()),
    listUpdateStatus: () => client().listUpdateStatus(undefined, options()),
    listErrors: () => client().listErrors(undefined, options()),
    checkUpdates: () => client().checkUpdates(undefined, options()),
    clearErrors: () => client().clearErrors(undefined, options()),
    // Catalog refresh can re-adopt previously abandoned marketplace entries.
    refresh: () => mutate(scope => client().refresh(undefined, scope)),
    addSource: input => mutate(scope => client().addSource(input, scope)),
    removeSource: input => mutate(scope => client().removeSource(input, scope)),
    previewRemoveSource: input => client().previewRemoveSource(input, options()),
    install: input => mutate(scope => client().install(input, scope)),
    update: input => mutate(scope => client().update(input, scope)),
    remove: input => mutate(scope => client().remove(input, scope)),
    setEnabled: input => mutate(scope => client().setEnabled(input, scope)),
  };
}
export function setup(context: Plugin.Context): () => void {
  let manager: SkillzManager | undefined;
  let stopped = false;
  const rpc = createRpc(context, () => !stopped);
  let opening = false;
  context.keymap.layer(() => ({ mode: 'global', commands: [{
    id: 'skillz.open', title: 'Manage skills (Skillz)', group: 'Skillz', palette: true,
    slash: { name: 'skillz' }, run: async () => {
      if (stopped || opening) return;
      opening = true;
      try {
        const { createManagerUI } = await import('./render.js');
        if (stopped) return;
        manager ??= new SkillzManager(rpc, createManagerUI(context));
        await manager.open();
      } finally { opening = false; }
    },
  }] }));
  return () => { stopped = true; manager?.close(); };
}
export default Plugin.define({ id: 'skillz.tui', setup });
