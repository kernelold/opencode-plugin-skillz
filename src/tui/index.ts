import { Plugin } from '@opencode/plugin/tui';
import { SkillzRpc, type SkillzMethods } from '../rpc.js';
import { SkillzManager } from './controller.js';

export function setup(context: Plugin.Context): () => void {
  // Read context.client per call: OpenCode replaces it after reconnecting. Always
  // scope calls to the current/default location, including on the home screen.
  const options = () => ({ location: context.location ?? context.data.location.default() });
  const client = () => context.client.rpc(SkillzRpc);
  const rpc: SkillzMethods = {
    listSources: () => client().listSources(undefined, options()),
    listAvailable: input => client().listAvailable(input, options()),
    listInstalled: () => client().listInstalled(undefined, options()),
    listUpdateStatus: () => client().listUpdateStatus(undefined, options()),
    listErrors: () => client().listErrors(undefined, options()),
    checkUpdates: () => client().checkUpdates(undefined, options()),
    clearErrors: () => client().clearErrors(undefined, options()),
    refresh: () => client().refresh(undefined, options()),
    addSource: input => client().addSource(input, options()),
    removeSource: input => client().removeSource(input, options()),
    previewRemoveSource: input => client().previewRemoveSource(input, options()),
    install: input => client().install(input, options()),
    update: input => client().update(input, options()),
    remove: input => client().remove(input, options()),
    setEnabled: input => client().setEnabled(input, options()),
  };
  let manager: SkillzManager | undefined;
  let stopped = false;
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
