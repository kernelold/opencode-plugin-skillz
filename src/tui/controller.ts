import type { Plugin } from '@opencode/plugin/tui';
import type { DialogSelectOptions, DialogAlertOptions } from '@opencode/plugin/tui/context';
import type { Rpc } from '@opencode/plugin/rpc';
import type { SkillzMethods, methods, MethodInput, MethodOutput } from '../rpc.js';
import { isExcluded } from '../exclude.js';
import { nextTab, tabStrip, rowsFor, filterRows, installedDetails, sourceName, sourceLocation, sourceTrust, installConfirmation, text, defaultTab, emptyHint, skillValue, skillDetails, type Installed,
  updateStatusStale, checkedHint, InstallChecklist, type InstallPreview, type Row, type Tab, type Snapshot, type Available, type Confirmation, type RemovalChoice } from './model.js';

export type ManagerUI = Pick<Plugin.Context['ui'], 'dialog' | 'toast'> & {
  confirmation(options: Confirmation): Promise<boolean>;
  installPreview?(options: InstallPreview): Promise<string[] | undefined>;
  removalChoice(options: RemovalChoice): Promise<'remove' | 'keep' | undefined>;
  updateSelect?(options: { title: string; options: Row[]; hint: string; emptyMessage?: string }): void;
};
type UI = ManagerUI;
type Collision = Rpc.MethodError<typeof methods.install>;
function select<Value>(ui: UI, options: DialogSelectOptions<Value>): Promise<Value | undefined> {
  const pending = ui.dialog.select(options);
  // set() replaces host dialog settings: omitting centered undoes the adapter's
  // viewport layout and adds the host's large top offset to a full-height list.
  ui.dialog.set({ size: 'xlarge', centered: true });
  return pending;
}
function alert(ui: UI, options: DialogAlertOptions): Promise<void> {
  const pending = ui.dialog.alert(options);
  ui.dialog.set({ size: 'xlarge', centered: true });
  return pending;
}
export function collisionError(error: unknown): Collision | undefined {
  if (!error || typeof error !== 'object' || !('type' in error) || error.type !== 'collision' || !('data' in error)) return;
  const data = error.data;
  if (!data || typeof data !== 'object' || !('id' in data) || typeof data.id !== 'string' ||
    !('origin' in data) || typeof data.origin !== 'string' || !('canOverride' in data) || typeof data.canOverride !== 'boolean') return;
  return { type: 'collision', message: 'message' in error ? String(error.message) : 'Skill collision', data: { id: data.id, origin: data.origin, canOverride: data.canOverride } };
}
export async function confirmNo(ui: UI, title: string, message: string, active = () => true, yes = 'Yes', tone: Confirmation['tone'] = 'warning'): Promise<boolean> {
  if (!active()) return false;
  return await ui.confirmation({ title, message, yes, tone }) === true && active();
}
export async function withOverride<T>(ui: UI, action: (confirmOverride: boolean) => Promise<T>, active = () => true): Promise<T | undefined> {
  if (!active()) return;
  try { return await action(false); }
  catch (error) {
    if (!active()) return;
    const collision = collisionError(error);
    if (!collision) throw error;
    const message = `Skill ${text(collision.data.id)} already exists (from ${text(collision.data.origin)}).`;
    if (!collision.data.canOverride) {
      await alert(ui, { title: 'Cannot override', message: `${message}\nExplicit config skills cannot be overridden. Remove the explicit skills path from OpenCode config first.` });
      return;
    }
    if (!await confirmNo(ui, 'Override skill?', `${message}\nYes: the skillz version takes precedence for this and any other conflicting skills in this source.\nThe other skill is untouched; removing the source restores it.`, active, 'Yes, override')) return;
    return action(true);
  }
}

type Intent = { type: 'tab'; tab: Tab } | { type: 'toggle-skill'; value: string } | { type: 'refresh' | 'add' | 'clear' };
export class SkillzManager {
  private stopped = false;
  private running = false;
  private tab?: Tab;
  private updates: Snapshot['updates'] = [];
  private checkPending?: Promise<MethodOutput<'listUpdateStatus'>>;
  private refreshPending?: Promise<Pick<Snapshot, 'sources' | 'available'> & { failed: boolean }>;
  private catalogCheckedAt = 0;
  private view = 0;
  private readonly active = () => !this.stopped;
  constructor(private readonly rpc: SkillzMethods, private readonly ui: UI) {}
  close(): void { this.stopped = true; this.view++; if (this.running) this.ui.dialog.clear(); }
  private toast(message: string, variant: 'success' | 'warning' | 'error' | 'info' = 'success'): void {
    if (!this.stopped) this.ui.toast.show({ title: 'Skillz', message: text(message), variant });
  }
  private mutationToast(message: string): void {
    this.toast(`${message}; sessions on this server refresh next model step`);
  }
  private async load(): Promise<Snapshot> {
    const [sources, available, installed, errors, status] = await Promise.all([
      this.rpc.listSources(), this.rpc.listAvailable(), this.rpc.listInstalled(), this.rpc.listErrors(), this.rpc.listUpdateStatus(),
    ]);
    this.updates = status.updates;
    return { sources, available, installed, errors, updates: status.updates, checkedAt: status.checkedAt };
  }
  private background(tab: Tab, state: Snapshot, paint: () => void, force = false): void {
    const view = this.view;
    const visible = () => !this.stopped && view === this.view;
    if (tab === 'Installed sources' || tab === 'Skills') {
      if (!force && !this.checkPending && !updateStatusStale(state.checkedAt)) return;
      state.checking = true; state.checkFailed = false; paint();
      if (!this.checkPending) {
        this.checkPending = this.rpc.checkUpdates().then(() => this.rpc.listUpdateStatus()).finally(() => { this.checkPending = undefined; });
      }
      void this.checkPending.then(status => {
        if (!visible()) return;
        state.updates = status.updates; state.checkedAt = status.checkedAt;
        this.updates = status.updates;
        state.checkFailed = status.updates.some(u => u.issues.length > 0);
      }).catch(() => { if (visible()) state.checkFailed = true; }).finally(() => { if (visible()) { state.checking = false; paint(); } });
    } else if (tab === 'Discover' || tab === 'Sources') {
      if (!force && !this.refreshPending && Date.now() - this.catalogCheckedAt < 600000) return;
      state.checking = true; state.checkFailed = false; paint();
      if (!this.refreshPending) {
        this.refreshPending = this.rpc.refresh().then(async issues => {
          this.catalogCheckedAt = Date.now();
          const [sources, available] = await Promise.all([this.rpc.listSources(), this.rpc.listAvailable()]);
          return { sources, available, failed: issues.length > 0 };
        }).finally(() => { this.refreshPending = undefined; });
      }
      void this.refreshPending.then(({ sources, available, failed }) => {
        if (visible()) { state.sources = sources; state.available = available; state.checkFailed = failed; }
      }).catch(() => { if (visible()) state.checkFailed = true; }).finally(() => { if (visible()) { state.checking = false; paint(); } });
    }
  }
  async open(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (!this.stopped) {
        try {
          const state = await this.load();
          if (this.stopped) break;
          let intent: Intent | undefined;
          const choose = (next: Intent) => { intent = next; this.ui.dialog.clear(); };
          const tab = this.tab ??= defaultTab(state);
          const view = ++this.view;
          const rows = rowsFor(tab, state);
          const title = () => `Skillz: ${tabStrip(tab)}`;
          const paint = () => {
            if (this.stopped || view !== this.view) return;
            this.ui.updateSelect?.({ title: title(), options: rowsFor(tab, state), emptyMessage: emptyHint(tab), hint: [
              ...(tab === 'Installed sources' || tab === 'Skills' ? [checkedHint(state.checkedAt)] : []),
              ...(state.checking ? [tab === 'Installed sources' || tab === 'Skills' ? 'checking…' : state.available.length ? 'refreshing…' : 'loading…'] : []),
              ...(state.checkFailed ? ['check failed · see Errors'] : []),
            ].join(' · ') });
          };
          const pendingSelection = select(this.ui, {
            title: title(),
            placeholder: tab === 'Discover' ? 'Search entries, skills, source, licence…' : `Search ${tab.toLowerCase()}…`,
            options: rows, search: filterRows,
            actions: [
              { bind: 'left', title: 'Previous tab', selection: 'none', onTrigger: () => choose({ type: 'tab', tab: nextTab(tab, -1) }) },
              { bind: 'right', title: 'Next tab', selection: 'none', onTrigger: () => choose({ type: 'tab', tab: nextTab(tab, 1) }) },
              { bind: 'ctrl+r', title: tab === 'Installed sources' || tab === 'Skills' ? 'Check updates' : 'Refresh', selection: 'none', onTrigger: () => {
                if (tab === 'Errors') choose({ type: 'refresh' }); else this.background(tab, state, paint, true);
              } },
              ...(tab === 'Skills' ? [{ bind: 'space', title: 'Enable / disable selected skill', onTrigger: (value: string) => choose({ type: 'toggle-skill', value }) }] : []),
              ...(tab === 'Sources' || tab === 'Discover' ? [{ bind: 'ctrl+a', title: 'Add source', selection: 'none' as const, onTrigger: () => choose({ type: 'add' }) }] : []),
              ...(tab === 'Errors' ? [{ bind: 'ctrl+x', title: 'Clear errors', selection: 'none' as const, onTrigger: () => choose({ type: 'clear' }) }] : []),
            ],
          });
          paint();
          this.background(tab, state, paint);
          const selection = await pendingSelection;
          this.view++;
          if (this.stopped) break;
          if (intent) {
            const action = intent as Intent;
            if (action.type === 'tab') {
              this.tab = action.tab;
            } else if (action.type === 'toggle-skill') {
              const target = this.findSkill(action.value, state);
              if (target) await this.toggleSkill(target.item, target.skill.id);
            } else if (action.type === 'add') await this.addSource();
            else if (action.type === 'clear') {
              if (await confirmNo(this.ui, 'Clear all errors?', 'Only the error log will be cleared.', this.active)) { await this.rpc.clearErrors(); this.toast('Errors cleared'); }
            }
            continue;
          }
          if (selection === undefined) break;
          if (tab === 'Skills') await this.skill(selection, state);
          else if (tab === 'Discover') await this.discover(selection, state.sources);
          else if (tab === 'Installed sources') await this.installed(selection, state);
          else if (tab === 'Sources') await this.source(selection, state);
          else {
            const issue = state.errors.find(e => e.id === selection);
            if (issue) await alert(this.ui, { title: text(issue.code), message: [issue.created, issue.message, issue.sourceId, issue.entry, issue.path].filter(Boolean).map(s => text(s!)).join('\n') });
          }
        } catch (error) {
          this.toast(error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String(error.message) : String(error), 'error');
          // Avoid a tight retry loop on a disconnected server; /skillz can be reopened.
          break;
        }
      }
    } finally { this.view++; this.running = false; this.tab = undefined; }
  }
  private async discover(sourceId: string, sources: Snapshot['sources']): Promise<void> {
    this.toast('Inspecting source…', 'info');
    const [entry] = await this.rpc.listAvailable({ sourceId });
    if (!entry || this.stopped) return;
    await this.install(entry, sources);
  }
  private async install(entry: Available, sources: Snapshot['sources']): Promise<void> {
    if (this.stopped) return;
    if (!entry.skills?.length) { this.toast('No skills found; installation refused', 'warning'); return; }
    const preview = installConfirmation(entry, sources);
    const exclude = this.ui.installPreview ? await this.ui.installPreview({ ...preview, entry })
      : await confirmNo(this.ui, preview.title, preview.message, this.active, preview.yes, preview.tone) ? new InstallChecklist(entry).exclusions() : undefined;
    if (exclude === undefined || this.stopped) return;
    const checklist = new InstallChecklist(entry);
    // The renderer refuses an empty selection; guard other UI adapters too.
    if (!checklist.skills.some(s => !isExcluded(s, exclude))) {
      this.toast('Select at least one skill', 'warning'); return;
    }
    const result = await withOverride(this.ui, approved => this.rpc.install({ sourceId: entry.id, options: { confirmOverride: approved, exclude } }), this.active);
    if (result) this.mutationToast(`Installed ${result.skills.length} skill(s)`);
    else this.toast('Installation cancelled', 'info');
    this.updates = this.updates.filter(u => u.sourceId !== entry.id);
  }
  private async installed(sourceId: string, state: Snapshot): Promise<void> {
    const item = state.installed.find(s => s.sourceId === sourceId);
    if (!item) return;
    await alert(this.ui, { title: 'Installed source', message: installedDetails(item, state.sources.find(s => s.id === sourceId), this.updates.find(u => u.sourceId === sourceId)) });
    if (this.stopped) return;
    const action = await select(this.ui, { title: 'Source actions', options: [
      { title: item.enabled ? 'Disable source' : 'Enable source', value: 'toggle' },
      ...(!item.abandoned ? [{ title: 'Update source', value: 'update' }] : []),
      { title: 'Remove installed entry', value: 'remove' },
      ...(item.skills.length > 1 ? [{ title: 'Remove one skill…', value: 'remove-skill' }] : []),
      ...(item.skills.length > 1 ? [{ title: 'Enable / disable one skill…', value: 'toggle-skill' }] : []),
    ] });
    if (!action || this.stopped) return;
    if (action === 'toggle-skill') {
      const skillId = await select(this.ui, { title: 'Enable / disable one installed skill', options: item.skills.map(s => ({ title: `${item.disabledSkills?.includes(s.id) ? 'Enable' : 'Disable'} ${text(s.id)}`, value: s.id })) });
      if (skillId && !this.stopped) {
        await this.toggleSkill(item, skillId);
      }
    } else if (action === 'remove-skill') {
      const skillId = await select(this.ui, { title: 'Remove one installed skill', options: item.skills.map(s => ({ title: text(s.id), value: s.id })) });
      if (skillId) await this.removeSkill(sourceId, skillId);
    } else if (action === 'remove') {
      if (await confirmNo(this.ui, 'Remove installed source?', `${installedDetails(item, state.sources.find(s => s.id === sourceId))}\nUnregister only this entry and delete its unshared managed cache. The source remains available. Local files are never deleted.`, this.active, 'Yes, remove', 'error')) {
        await this.rpc.remove({ sourceId }); this.mutationToast('Source removed');
      }
    } else {
      const result = await withOverride(this.ui, approved => action === 'update'
        ? this.rpc.update({ sourceId, options: { confirmOverride: approved } })
        : this.rpc.setEnabled({ sourceId, enabled: !item.enabled, options: { confirmOverride: approved } }), this.active);
      if (result) this.mutationToast(action === 'update' ? 'Source updated' : result.enabled ? 'Source enabled' : 'Source disabled');
      else this.toast('Action cancelled', 'info');
    }
    this.updates = this.updates.filter(u => u.sourceId !== sourceId);
  }
  private findSkill(value: string, state: Snapshot) {
    for (const item of state.installed) {
      const skill = item.skills.find(s => !item.excludedSkills?.includes(s.id) && skillValue(item.sourceId, s.id) === value);
      if (skill) return { item, skill };
    }
  }
  private async toggleSkill(item: Installed, skillId: string): Promise<void> {
    const enabled = item.disabledSkills?.includes(skillId) === true;
    const result = await withOverride(this.ui, approved => this.rpc.setEnabled({ sourceId: item.sourceId, skillId, enabled, options: { confirmOverride: approved } }), this.active);
    if (result) this.mutationToast(enabled ? item.enabled ? 'Skill enabled' : 'Skill enabled; source remains disabled' : 'Skill disabled');
  }
  private async removeSkill(sourceId: string, skillId: string): Promise<void> {
    if (await confirmNo(this.ui, 'Remove installed skill?', `${text(sourceId)} / ${text(skillId)}\nOnly this installed skill is unregistered. Other origins and local files are untouched.`, this.active, 'Yes, remove', 'error')) {
      await this.rpc.remove({ sourceId, skillId }); this.mutationToast('Skill removed');
    }
  }
  private async skill(value: string, state: Snapshot): Promise<void> {
    const target = this.findSkill(value, state);
    if (!target) return;
    const { item, skill } = target;
    const sourceId = item.sourceId;
    const update = this.updates.find(u => u.sourceId === sourceId);
    const action = await select(this.ui, { title: `Skill actions · ${text(skill.name || skill.id)}`, options: [
      { title: 'View skill details / path / source', value: 'details', footer: text(skill.skillFile) },
      { title: item.disabledSkills?.includes(skill.id) ? 'Enable skill' : 'Disable skill', value: 'toggle', ...(!item.enabled ? { footer: 'Source disabled; per-skill setting only' } : {}) },
      ...(!item.enabled ? [{ title: 'Enable source (all eligible skills)', value: 'enable-source' }] : []),
      ...(!item.abandoned && update?.updateAvailable ? [{ title: 'Update source (all its skills)', value: 'update' }] : []),
      { title: 'Remove skill', value: 'remove' },
      { title: 'Cancel', value: 'cancel' },
    ] });
    if (!action || this.stopped) return;
    if (action === 'details') await alert(this.ui, { title: 'Installed skill', message: skillDetails(item, skill, state.sources.find(s => s.id === sourceId), update) });
    else if (action === 'toggle') await this.toggleSkill(item, skill.id);
    else if (action === 'remove') await this.removeSkill(sourceId, skill.id);
    else if (action === 'update' || action === 'enable-source') {
      const result = await withOverride(this.ui, approved => action === 'update'
        ? this.rpc.update({ sourceId, options: { confirmOverride: approved } })
        : this.rpc.setEnabled({ sourceId, enabled: true, options: { confirmOverride: approved } }), this.active);
      if (result) this.mutationToast(action === 'update' ? 'Source updated' : 'Source enabled');
    }
  }
  private async source(sourceId: string, state: Snapshot): Promise<void> {
    const source = state.sources.find(s => s.id === sourceId);
    if (!source) return;
    const action = await select(this.ui, { title: sourceName(source), options: [
      { title: 'Inspect source', value: 'inspect', footer: sourceLocation(source) },
      { title: 'Refresh catalogs', value: 'refresh' },
      ...(!source.catalog && source.source.type !== 'marketplace-url' ? [{ title: 'Inspect / install skills', value: 'install' }] : []),
      { title: 'Remove source', value: 'remove' },
    ] });
    if (this.stopped) return;
    if (action === 'inspect') await alert(this.ui, { title: sourceName(source), message: `${sourceLocation(source)}\n${sourceTrust(source, state.sources).label}\nID: ${text(source.id)}\nAuth env: ${text(source.options.auth?.authEnv ?? 'none')}\nExcluded: ${source.options.exclude?.map(text).join(', ') || 'none'}\nUse Inspect / install skills to re-include excluded skills.\n${source.parentId ? `Marketplace: ${text(source.parentId)}` : ''}` });
    else if (action === 'install') await this.discover(sourceId, state.sources);
    else if (action === 'refresh') { const issues = await this.rpc.refresh(); this.toast(`Refreshed (${issues.length} issue(s))`, issues.length ? 'warning' : 'success'); }
    else if (action === 'remove') {
      const preview = await this.rpc.previewRemoveSource({ sourceId });
      if (this.stopped) return;
      const displayed = preview.source ?? source;
      const message = [`Source: ${sourceName(displayed)}`, sourceLocation(displayed), `Installed skills: ${preview.skillCount}`,
        ...preview.entries.flatMap(entry => entry.skills.map(skill => `  ${text(entry.sourceId)} / ${text(skill.id)}`)),
        'Other origins and external skills are untouched. Local files are never deleted.',
        ...(preview.skillCount ? ['Keep: skills stay enabled/disabled as before, with no updates (abandoned).'] : [])].join('\n');
      const choice = preview.skillCount ? await this.ui.removalChoice({ title: 'Remove source?', message, count: preview.skillCount })
        : await confirmNo(this.ui, 'Remove source?', message, this.active, 'Yes, remove', 'error') ? 'remove' : undefined;
      if (!choice || this.stopped) return;
      await this.rpc.removeSource({ sourceId, skills: choice, revision: preview.revision }); this.mutationToast('Source removed');
    }
  }
  private async addSource(): Promise<void> {
    const kind = await select(this.ui, { title: 'Add source', options: [
      { title: 'Marketplace (manifest URL, git repository or local path)', value: 'marketplace' },
      { title: 'Direct source (skill URL, archive, git repository or local path)', value: 'direct' },
    ] });
    if (!kind || this.stopped) return;
    const input = (await this.ui.dialog.prompt({ title: kind === 'marketplace' ? 'Marketplace URL / git URL / absolute local path' : 'Source URL / git URL / absolute local path', placeholder: kind === 'marketplace' ? 'https://host/path/marketplace.json' : '/absolute/path/to/skills' }))?.trim();
    if (!input || this.stopped) return;
    const env = await this.ui.dialog.prompt({ title: 'Optional HTTP auth env-var NAME (never a token)', description: 'Leave blank for public sources / existing git credentials.', value: '' });
    if (env === undefined || this.stopped) return;
    const options: NonNullable<MethodInput<'addSource'>['options']> = {};
    if (env.trim()) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(env.trim())) throw new Error('Expected an environment-variable name, not a secret value');
      const mode = await select(this.ui, { title: 'HTTP auth transport', options: [
        { title: 'Authorization: Bearer <env value>', value: 'bearer' },
        { title: 'Custom header (env value)', value: 'header' },
        { title: 'Query parameter (env value)', value: 'query' },
      ] });
      if (!mode || this.stopped) return;
      options.auth = { authEnv: env.trim(), ...(mode === 'bearer' ? { prefix: 'Bearer ' } : {}) };
      if (mode !== 'bearer') {
        const name = (await this.ui.dialog.prompt({ title: mode === 'header' ? 'Header name (not value)' : 'Query parameter name (not value)' }))?.trim();
        if (!name || this.stopped) return;
        if (mode === 'query') options.auth.query = name;
        else { options.auth.header = name; options.auth.prefix = ''; }
      }
    }
    await this.rpc.addSource({ input, options });
    const issues = await this.rpc.refresh();
    this.toast(issues.length ? `Source added; ${issues.length} issue(s), see Errors` : 'Source added; inspect it in Discover before installing', issues.length ? 'warning' : 'success');
  }
}
