import { describe, it, expect, vi } from 'vitest';
import type { Plugin } from '@opencode/plugin/tui';
import type { DialogSelectOptions } from '@opencode/plugin/tui/context';
import { SkillzRpc, type SkillzMethods } from '../src/rpc.js';
import plugin, { setup } from '../src/tui/index.js';
import { SkillzManager, collisionError, confirmNo, withOverride, type ManagerUI } from '../src/tui/controller.js';
import { tabs, nextTab, tabStrip, rowsFor, filterRows, badges, entryDetails, installedDetails, sourceLocation, text,
  sourceTrust, installConfirmation, actionTone, badgeTone, checkedHint, updateStatusStale, type Snapshot, type Available } from '../src/tui/model.js';

vi.mock('../src/tui/render.js', () => ({ createManagerUI: (context: Plugin.Context) => context.ui }));

const source: Available = { id: 'one', name: 'Release kit', source: { type: 'git', url: 'https://example.test/kit.git', ref: 'main', subpath: 'skills' }, options: {},
  description: 'Release tooling', skills: ['release', 'audit'], version: 'v1', license: 'MIT', parentId: 'catalog' };
function snapshot(): Snapshot {
  return { sources: [{ id: 'catalog', name: 'Example marketplace', source: { type: 'marketplace-url', url: 'https://example.test/marketplace.json' }, options: {}, catalog: true }, source],
    available: [source], installed: [{ sourceId: 'one', version: 'v1', current: '/cache/one', enabled: true, scope: 'user', overrides: ['release overrides /external/release/SKILL.md'],
      skills: [{ id: 'release', name: 'Release', description: 'Release safely', dir: '/cache/one/release', skillFile: '/cache/one/release/SKILL.md' }] }],
    errors: [{ id: 'error', code: 'unsupported-component', message: 'Commands not supported', created: '2026-11-04T00:00:00Z', sourceId: 'one' }],
    updates: [{ sourceId: 'one', installedVersion: 'v1', availableVersion: 'v2', updateAvailable: true, issues: [] }] };
}
type UI = ManagerUI;
type SelectOptions = Parameters<UI['dialog']['select']>[0];
type Step = unknown | ((options: SelectOptions) => unknown);
function harness(steps: Step[] = [], prompts: (string | undefined)[] = []) {
  const state = snapshot();
  let checkedAt: string | null = null;
  const ui: UI = { removalChoice: vi.fn(async () => steps.shift() as 'remove' | 'keep' | undefined), confirmation: vi.fn(async () => steps.shift() === true), dialog: {
    alert: vi.fn(async () => {}), confirm: vi.fn(async () => false),
    prompt: vi.fn(async () => prompts.shift()), clear: vi.fn(), set: vi.fn(), show: vi.fn(),
    select: vi.fn(async <Value>(options: DialogSelectOptions<Value>) => {
      const step = steps.shift();
      return (typeof step === 'function' ? step(options) : step) as Value | undefined;
    }) as UI['dialog']['select'],
  }, toast: { show: vi.fn() } };
  const rpc = {
    listSources: vi.fn(async () => state.sources), listAvailable: vi.fn(async () => state.available), listInstalled: vi.fn(async () => state.installed),
    listErrors: vi.fn(async () => state.errors), checkUpdates: vi.fn(async () => { checkedAt = new Date().toISOString(); return state.updates; }),
    listUpdateStatus: vi.fn(async () => ({ checkedAt, updates: state.updates })), clearErrors: vi.fn(async () => {}),
    refresh: vi.fn(async () => []), addSource: vi.fn(async () => source), removeSource: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    previewRemoveSource: vi.fn(async () => ({ sourceId: 'catalog', source: state.sources[0], entries: state.installed, skillCount: state.installed.reduce((n, s) => n + s.skills.length, 0), revision: 'preview' })),
    install: vi.fn(async () => state.installed[0]), update: vi.fn(async () => state.installed[0]), setEnabled: vi.fn(async () => ({ ...state.installed[0], enabled: false })),
  } satisfies SkillzMethods;
  return { ui, rpc, state, manager: new SkillzManager(rpc, ui) };
}
function footer(bind: string): (options: SelectOptions) => undefined {
  return options => {
    const action = options.actions?.find(a => a.bind === bind);
    expect(action?.selection).toBe('none');
    if (action?.selection === 'none') action.onTrigger();
    return undefined;
  };
}

describe('pure TUI model', () => {
  it('uses a ten-minute cache TTL and honest relative check times', () => {
    const now = Date.parse('2026-11-05T12:00:00Z');
    expect(updateStatusStale(null, now)).toBe(true);
    expect(updateStatusStale('invalid', now)).toBe(true);
    expect(updateStatusStale(new Date(now - 599999).toISOString(), now)).toBe(false);
    expect(updateStatusStale(new Date(now - 600000).toISOString(), now)).toBe(true);
    expect(checkedHint(null, now)).toBe('never checked');
    expect(checkedHint(new Date(now - 10800000).toISOString(), now)).toBe('checked 3h ago');
    expect(checkedHint(new Date(now - 180000).toISOString(), now)).toBe('checked 3m ago');
  });
  it('cycles tabs and formats the active tab without mutating state', () => {
    expect(nextTab('Discover', -1)).toBe('Errors');
    expect(nextTab('Errors', 1)).toBe('Discover');
    expect(nextTab('Sources', 9)).toBe('Errors');
    expect(tabStrip('Installed')).toBe('Discover · [Installed] · Sources · Errors');
  });
  it('searches all displayed metadata with case-insensitive AND matching', () => {
    const rows = rowsFor('Discover', snapshot());
    expect(filterRows('MIT example', rows)).toHaveLength(1);
    expect(filterRows('release nonexistent', rows)).toHaveLength(0);
    expect(filterRows('  ', rows)).toEqual(rows);
    expect(rows[0].category).toBe('Example marketplace');
  });
  it('formats git pins, local paths and missing entry metadata honestly', () => {
    expect(sourceLocation(source)).toBe('https://example.test/kit.git#main (skills)');
    expect(sourceLocation({ ...source, source: { type: 'local', path: '/my/skills' } })).toBe('/my/skills');
    expect(entryDetails(source)).toContain('Skills: release, audit');
    expect(entryDetails({ ...source, version: undefined, license: undefined, skills: undefined })).toContain('Version: unknown\nLicence: not declared');
    expect(text('\x1b[31mHello\nthere\x07')).toBe(' [31mHello there ');
  });
  it('computes update badges without mistaking failed or missing checks for up to date', () => {
    const s = snapshot();
    expect(badges(s.installed[0], s.updates[0])).toEqual(['enabled', 'update available', 'overrides']);
    expect(badges({ ...s.installed[0], enabled: false }, { ...s.updates[0], issues: [{ code: 'fetch-error', message: 'offline' }] })).toEqual(['disabled', 'update check failed', 'overrides']);
    expect(badges(s.installed[0])).toContain('update not checked');
    expect(badges(s.installed[0], { ...s.updates[0], updateAvailable: false })).toContain('up to date');
  });
  it('derives source trust from explicit provenance, not individual skills or host similarity', () => {
    const state = snapshot();
    expect(sourceTrust(state.sources[0], state.sources)).toEqual({ label: 'Trusted — you added this source', tone: 'success' });
    expect(sourceTrust(source, state.sources)).toEqual({ label: 'Not added by you — from marketplace Example marketplace', tone: 'warning' });
    for (const upstream of [
      { type: 'local', path: '/skills' }, { type: 'md-url', url: 'https://other.test/skill.md' },
      { type: 'archive-url', url: 'https://other.test/skill.zip', format: 'zip' },
    ] as const) expect(sourceTrust({ ...source, source: upstream, parentId: undefined }).tone).toBe('success');
    const withExplicit = [...state.sources, { ...source, id: 'explicit', parentId: undefined }];
    expect(sourceTrust(source, withExplicit).tone).toBe('success');
    expect(sourceTrust(source, []).label).toContain('marketplace catalog');
    expect(sourceTrust(source, withExplicit.filter(s => s.id !== 'explicit')).tone).toBe('warning');
    expect(sourceTrust(source, [...state.sources, { ...source, parentId: undefined, source: { ...source.source, type: 'git', url: 'https://example.test/kit.git', ref: 'other' } }]).tone).toBe('warning');
    const child = { ...source, source: { type: 'local' as const, path: '/skills/ a' } };
    expect(sourceTrust(child, [{ ...child, parentId: undefined, source: { type: 'local', path: '/skills/\na' } }]).tone).toBe('warning');
  });
  it('formats a single read-only install preview and semantic action/badge colours', () => {
    const preview = installConfirmation(source, snapshot().sources);
    expect(preview.title).toBe('Install skill? · Release kit');
    expect(preview.message).toContain('Skills: release, audit (2)');
    expect(preview.message).toContain('Version: v1    Licence: MIT');
    expect(preview.message).not.toMatch(/untrusted/i);
    expect(preview.message).toContain('Nothing is executed during install.');
    expect(preview.yes).toBe('Yes, install');
    expect(actionTone('Enable source')).toBe('success');
    expect(actionTone('Remove source')).toBe('error');
    expect(actionTone('No')).toBe('error');
    expect(actionTone('Update source')).toBe('warning');
    expect(badgeTone('overrides')).toBe('warning');
    expect(badgeTone('disabled')).toBe('error');
    expect(badgeTone('update not checked')).toBe('muted');
  });
  it('renders sources, skills, override origin, update versions and newest errors', () => {
    const s = snapshot();
    expect(rowsFor('Installed', s)[0].footer).toContain('[update available]');
    const details = installedDetails(s.installed[0], source, s.updates[0]);
    expect(details).toContain('release — Release safely');
    expect(details).toContain('release overrides /external/release/SKILL.md');
    expect(details).toContain('Available version: v2');
    expect(rowsFor('Sources', s).map(r => r.category)).toEqual(['Marketplaces', 'Marketplace entries']);
    s.errors.push({ ...s.errors[0], id: 'newer' });
    expect(rowsFor('Errors', s)[0].value).toBe('newer');
    expect(s.errors[0].id).toBe('error');
    expect(tabs.every(t => rowsFor(t, { sources: [], installed: [], available: [], errors: [], updates: [] }).length === 0)).toBe(true);
  });
});

describe('explicit override confirmation', () => {
  const collision = { type: 'collision', message: 'collision', data: { id: 'release', origin: '/external/SKILL.md', canOverride: true } };
  it.each([undefined, false])('defaults to No for cancellation/Enter (%s)', async answer => {
    const h = harness([answer]);
    const action = vi.fn(async (_approved: boolean): Promise<string> => { throw collision; });
    expect(await withOverride(h.ui, action)).toBeUndefined();
    expect(action).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.ui.confirmation).toHaveBeenCalledWith(expect.objectContaining({ yes: 'Yes, override', message: expect.stringContaining('/external/SKILL.md') }));
    expect(h.ui.dialog.alert).not.toHaveBeenCalled();
  });
  it('retries using confirmOverride=true only on explicit Yes', async () => {
    const h = harness([true]);
    const action = vi.fn(async (approved: boolean) => { if (!approved) throw collision; return 'ok'; });
    expect(await withOverride(h.ui, action)).toBe('ok');
    expect(action.mock.calls).toEqual([[false], [true]]);
    expect(h.ui.confirmation).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('any other conflicting skills') }));
    expect(h.ui.confirmation).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('removing the source restores it') }));
  });
  it('never retries non-overridable config skills or generic transport errors', async () => {
    const h = harness([true]);
    const action = vi.fn(async () => { throw { ...collision, data: { ...collision.data, canOverride: false } }; });
    await withOverride(h.ui, action);
    expect(action).toHaveBeenCalledTimes(1);
    expect(h.ui.dialog.select).not.toHaveBeenCalled();
    expect(h.ui.dialog.alert).toHaveBeenCalledWith(expect.objectContaining({ title: 'Cannot override' }));
    await expect(withOverride(h.ui, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(collisionError({ type: 'collision', data: { id: 5 } })).toBeUndefined();
    expect(collisionError(undefined)).toBeUndefined();
  });
  it('does not open a confirmation or retry after plugin cleanup', async () => {
    const h = harness([true]);
    let active = true;
    h.ui.confirmation = vi.fn(async () => { active = false; return true; });
    expect(await confirmNo(h.ui, 'Continue?', 'Test', () => active)).toBe(false);
    expect(h.ui.dialog.select).not.toHaveBeenCalled();
    const action = vi.fn(async () => 'ok');
    await withOverride(h.ui, action, () => active);
    expect(action).not.toHaveBeenCalled();
  });
});

describe('dialog manager through the RPC interface only', () => {
  it('renders cached Installed badges before a slow check, dedupes Ctrl+R and repaints without reopening', async () => {
    let finish!: (value?: string) => void;
    let complete!: () => void;
    const h = harness([footer('ctrl+right'), () => new Promise(resolve => { finish = resolve; })]);
    const checkedAt = new Date(Date.now() - 3 * 3600000).toISOString();
    h.rpc.listUpdateStatus.mockResolvedValue({ checkedAt, updates: h.state.updates });
    h.rpc.checkUpdates.mockImplementation(() => new Promise(resolve => { complete = () => resolve(h.state.updates); }));
    h.ui.updateSelect = vi.fn();
    const open = h.manager.open();
    await vi.waitFor(() => expect(h.ui.dialog.select).toHaveBeenCalledTimes(2));
    const options = vi.mocked(h.ui.dialog.select).mock.calls[1][0];
    expect(options.options[0].footer).toContain('[update available]');
    expect(options.options[0].footer).toContain('checked 3h ago');
    expect(h.ui.updateSelect).toHaveBeenCalledWith(expect.objectContaining({ hint: expect.stringContaining('checking…') }));
    const refresh = options.actions!.find(a => a.bind === 'ctrl+r')!;
    if (refresh.selection === 'none') { refresh.onTrigger(); refresh.onTrigger(); }
    expect(h.rpc.checkUpdates).toHaveBeenCalledTimes(1);
    h.rpc.listUpdateStatus.mockResolvedValue({ checkedAt: new Date().toISOString(), updates: [{ ...h.state.updates[0], updateAvailable: false }] });
    complete();
    await vi.waitFor(() => expect(h.ui.updateSelect).toHaveBeenLastCalledWith(expect.objectContaining({
      hint: 'checked just now', options: [expect.objectContaining({ footer: expect.stringContaining('[up to date]') })],
    })));
    expect(h.ui.dialog.select).toHaveBeenCalledTimes(2);
    finish(); await open;
  });
  it('uses fresh persisted status without checking until Ctrl+R forces an asynchronous check', async () => {
    let finish!: () => void;
    const h = harness([footer('ctrl+right'), () => new Promise(resolve => { finish = () => resolve(undefined); })]);
    h.rpc.listUpdateStatus.mockResolvedValue({ checkedAt: new Date().toISOString(), updates: h.state.updates });
    const open = h.manager.open();
    await vi.waitFor(() => expect(h.ui.dialog.select).toHaveBeenCalledTimes(2));
    expect(h.rpc.checkUpdates).not.toHaveBeenCalled();
    const refresh = vi.mocked(h.ui.dialog.select).mock.calls[1][0].actions!.find(a => a.bind === 'ctrl+r')!;
    if (refresh.selection === 'none') refresh.onTrigger();
    expect(h.rpc.checkUpdates).toHaveBeenCalledTimes(1);
    finish(); await open;
  });
  it.each(['dismiss', 'cleanup'])('ignores a slow check after %s closes the Installed dialog', async how => {
    let finish!: () => void;
    let complete!: () => void;
    const h = harness([footer('ctrl+right'), () => new Promise(resolve => { finish = () => resolve(undefined); })]);
    h.rpc.checkUpdates.mockImplementation(() => new Promise(resolve => { complete = () => resolve(h.state.updates); }));
    h.ui.updateSelect = vi.fn();
    const open = h.manager.open();
    await vi.waitFor(() => expect(h.rpc.checkUpdates).toHaveBeenCalledTimes(1));
    if (how === 'cleanup') h.manager.close();
    finish(); await open;
    const paints = vi.mocked(h.ui.updateSelect).mock.calls.length;
    complete(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(h.ui.updateSelect).toHaveBeenCalledTimes(paints);
    expect(h.ui.dialog.alert).not.toHaveBeenCalled();
  });
  it('keeps background failures quiet and displays a dim failure hint instead of a dialog', async () => {
    let finish!: () => void;
    const h = harness([footer('ctrl+right'), () => new Promise(resolve => { finish = () => resolve(undefined); })]);
    h.rpc.checkUpdates.mockRejectedValue(new Error('offline'));
    h.ui.updateSelect = vi.fn();
    const open = h.manager.open();
    await vi.waitFor(() => expect(h.ui.updateSelect).toHaveBeenCalledWith(expect.objectContaining({ hint: expect.stringContaining('check failed') })));
    expect(h.ui.dialog.alert).not.toHaveBeenCalled();
    expect(h.ui.toast.show).not.toHaveBeenCalled();
    finish(); await open;
  });
  it('shows cached Discover rows while a catalog refresh is pending and updates them in place', async () => {
    let finish!: () => void;
    let complete!: () => void;
    const h = harness([() => new Promise(resolve => { finish = () => resolve(undefined); })]);
    h.rpc.refresh.mockImplementation(() => new Promise(resolve => { complete = () => resolve([]); }));
    h.ui.updateSelect = vi.fn();
    const open = h.manager.open();
    await vi.waitFor(() => expect(h.rpc.refresh).toHaveBeenCalledTimes(1));
    expect(vi.mocked(h.ui.dialog.select).mock.calls[0][0].options[0].title).toBe('Release kit');
    h.state.available = [{ ...source, name: 'New catalog entry' }];
    complete();
    await vi.waitFor(() => expect(h.ui.updateSelect).toHaveBeenLastCalledWith(expect.objectContaining({ options: [expect.objectContaining({ title: 'New catalog entry' })] })));
    expect(h.ui.dialog.select).toHaveBeenCalledTimes(1);
    finish(); await open;
  });
  it('switches to cached Sources while the Discover refresh is still pending, without starting another fetch', async () => {
    let finish!: () => void;
    let complete!: () => void;
    const h = harness([footer('ctrl+t'), 'Sources', () => new Promise(resolve => { finish = () => resolve(undefined); })]);
    h.rpc.refresh.mockImplementation(() => new Promise(resolve => { complete = () => resolve([]); }));
    h.ui.updateSelect = vi.fn();
    const open = h.manager.open();
    await vi.waitFor(() => expect(h.ui.dialog.select).toHaveBeenCalledTimes(3));
    expect(vi.mocked(h.ui.dialog.select).mock.calls[2][0].options[0].title).toBe('Example marketplace');
    expect(h.rpc.refresh).toHaveBeenCalledTimes(1);
    h.state.sources = [{ ...source, name: 'Refreshed source' }];
    complete();
    await vi.waitFor(() => expect(h.ui.updateSelect).toHaveBeenLastCalledWith(expect.objectContaining({ title: expect.stringContaining('[Sources]'), hint: '', options: [expect.objectContaining({ title: 'Refreshed source' })] })));
    expect(vi.mocked(h.ui.updateSelect).mock.calls.filter(([update]) => update.options.some(r => r.title === 'Refreshed source')).every(([update]) => update.title.includes('[Sources]'))).toBe(true);
    finish(); await open;
  });
  it('previews exact skills/source before installing and toasts success', async () => {
    const h = harness(['one', true, undefined]);
    await h.manager.open();
    expect(h.rpc.listAvailable).toHaveBeenCalledWith({ sourceId: 'one' });
    expect(h.ui.confirmation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: 'Install skill? · Release kit', yes: 'Yes, install', message: expect.stringContaining('Skills: release, audit (2)') }));
    expect(h.ui.dialog.alert).not.toHaveBeenCalled();
    expect(h.rpc.install).toHaveBeenCalledWith({ sourceId: 'one', options: { confirmOverride: false } });
    expect(h.ui.toast.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Installed 1 skill(s); sessions on this server refresh next model step', variant: 'success' }));
  });
  it('does not install on No or without discovered skills', async () => {
    const no = harness(['one', false, undefined]); await no.manager.open(); expect(no.rpc.install).not.toHaveBeenCalled();
    const empty = harness(['one', true, undefined]); empty.state.available[0] = { ...source, skills: [] };
    await empty.manager.open(); expect(empty.rpc.install).not.toHaveBeenCalled();
  });
  it.each(['toggle', 'update', 'remove'])('supports Installed action %s', async action => {
    const h = harness([footer('ctrl+right'), 'one', action, ...(action === 'remove' ? [true] : []), undefined]);
    await h.manager.open();
    expect(h.rpc.checkUpdates).toHaveBeenCalledTimes(1);
    if (action === 'toggle') expect(h.rpc.setEnabled).toHaveBeenCalledWith({ sourceId: 'one', enabled: false, options: { confirmOverride: false } });
    if (action === 'update') expect(h.rpc.update).toHaveBeenCalledWith({ sourceId: 'one', options: { confirmOverride: false } });
    if (action === 'remove') expect(h.rpc.remove).toHaveBeenCalledWith({ sourceId: 'one' });
    expect(h.ui.toast.show).toHaveBeenCalledWith(expect.objectContaining({ message: `${action === 'toggle' ? 'Source disabled' : action === 'update' ? 'Source updated' : 'Source removed'}; sessions on this server refresh next model step`, variant: 'success' }));
  });
  it('explains refresh timing when enabling a disabled source', async () => {
    const h = harness([footer('ctrl+right'), 'one', 'toggle', undefined]);
    h.state.installed[0].enabled = false;
    h.rpc.setEnabled.mockResolvedValue({ ...h.state.installed[0], enabled: true });
    await h.manager.open();
    expect(h.ui.toast.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Source enabled; sessions on this server refresh next model step', variant: 'success' }));
  });
  it('switches tabs, shows Errors and clears only with confirmation', async () => {
    const h = harness([footer('ctrl+t'), 'Errors', 'error', footer('ctrl+x'), true, undefined]);
    await h.manager.open();
    expect(h.rpc.listErrors).toHaveBeenCalled();
    expect(h.ui.dialog.alert).toHaveBeenCalledWith(expect.objectContaining({ title: 'unsupported-component', message: expect.stringContaining('Commands not supported') }));
    expect(h.rpc.clearErrors).toHaveBeenCalledTimes(1);
  });
  it('adds a public LiteLLM marketplace and refreshes it without installing', async () => {
    const h = harness([footer('ctrl+a'), 'marketplace', undefined], ['http://localhost:4000/claude-code/marketplace.json', '']);
    await h.manager.open();
    expect(h.rpc.addSource).toHaveBeenCalledWith({ input: 'http://localhost:4000/claude-code/marketplace.json', options: {} });
    expect(h.rpc.refresh).toHaveBeenCalled();
    expect(h.rpc.install).not.toHaveBeenCalled();
  });
  it.each(['bearer', 'header', 'query'])('adds auth by env-var reference only (%s)', async mode => {
    const prompts = ['https://example.test/skill.md', 'SKILLZ_TOKEN', ...(mode === 'bearer' ? [] : ['X-Api-Key'])];
    const h = harness([footer('ctrl+a'), 'direct', mode, undefined], prompts);
    await h.manager.open();
    expect(h.rpc.addSource).toHaveBeenCalledWith({ input: 'https://example.test/skill.md', options: { auth: mode === 'bearer'
      ? { authEnv: 'SKILLZ_TOKEN', prefix: 'Bearer ' } : mode === 'header' ? { authEnv: 'SKILLZ_TOKEN', header: 'X-Api-Key', prefix: '' } : { authEnv: 'SKILLZ_TOKEN', query: 'X-Api-Key' } } });
  });
  it('rejects invalid env names and reports disconnected-server errors without retry loops', async () => {
    const h = harness([footer('ctrl+a'), 'direct'], ['https://example.test/skill.md', 'not a name']);
    await h.manager.open(); expect(h.rpc.addSource).not.toHaveBeenCalled();
    expect(h.ui.toast.show).toHaveBeenCalledWith(expect.objectContaining({ variant: 'error' }));
    const offline = harness(); offline.rpc.listSources.mockRejectedValue(new Error('offline')); await offline.manager.open();
    expect(offline.rpc.listSources).toHaveBeenCalledTimes(1);
    expect(offline.ui.toast.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'offline', variant: 'error' }));
  });
  it.each(['remove', 'keep', undefined])('previews exact marketplace origins and makes explicit choice %s', async choice => {
    const h = harness([footer('ctrl+t'), 'Sources', 'catalog', 'remove', choice, undefined]);
    await h.manager.open();
    expect(h.rpc.previewRemoveSource).toHaveBeenCalledWith({ sourceId: 'catalog' });
    expect(h.ui.removalChoice).toHaveBeenCalledWith(expect.objectContaining({ count: 1, message: expect.stringContaining('one / release') }));
    expect(h.ui.confirmation).not.toHaveBeenCalled();
    if (choice) expect(h.rpc.removeSource).toHaveBeenCalledWith({ sourceId: 'catalog', skills: choice, revision: 'preview' });
    else expect(h.rpc.removeSource).not.toHaveBeenCalled();
  });
  it('uses a simple safe confirmation for a source with no installed skills', async () => {
    const h = harness([footer('ctrl+t'), 'Sources', 'catalog', 'remove', true, undefined]);
    h.state.installed = [];
    await h.manager.open();
    expect(h.ui.removalChoice).not.toHaveBeenCalled();
    expect(h.ui.confirmation).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Installed skills: 0') }));
    expect(h.rpc.removeSource).toHaveBeenCalledWith({ sourceId: 'catalog', skills: 'remove', revision: 'preview' });
  });
  it('shows abandoned badge and dim source-removed hint without update action', async () => {
    const h = harness([footer('ctrl+right'), 'one', undefined]);
    h.state.installed[0].abandoned = true;
    expect(rowsFor('Installed', h.state)[0].footer).toContain('[abandoned]');
    expect(rowsFor('Installed', h.state)[0].footer).toContain('source removed');
    expect(badges(h.state.installed[0], h.state.updates[0])).not.toContain('update available');
    await h.manager.open();
    const actions = vi.mocked(h.ui.dialog.select).mock.calls.find(([o]) => o.title === 'Source actions')![0];
    expect(actions.options.map(o => o.value)).not.toContain('update');
  });
  it.each(['remove-skill', 'toggle-skill'])('targets an individual abandoned skill with %s', async action => {
    const h = harness([footer('ctrl+right'), 'one', action, 'release', ...(action === 'remove-skill' ? [true] : []), undefined]);
    h.state.installed[0].abandoned = true;
    h.state.installed[0].skills.push({ ...h.state.installed[0].skills[0], id: 'audit' });
    await h.manager.open();
    if (action === 'remove-skill') expect(h.rpc.remove).toHaveBeenCalledWith({ sourceId: 'one', skillId: 'release' });
    else expect(h.rpc.setEnabled).toHaveBeenCalledWith({ sourceId: 'one', skillId: 'release', enabled: false, options: { confirmOverride: false } });
    expect(h.rpc.removeSource).not.toHaveBeenCalled();
  });
});

describe('TUI plugin load smoke', () => {
  it('loads the real plugin definition, registers /skillz globally and scopes typed RPC calls on home', async () => {
    const h = harness();
    let layer!: ReturnType<Parameters<Plugin.Context['keymap']['layer']>[0]>;
    const location = { directory: '/isolated/home' };
    const rpcFactory = vi.fn(() => h.rpc);
    const ctx = { ui: h.ui, client: { rpc: rpcFactory }, data: { location: { default: () => location } },
      keymap: { layer: (factory: () => typeof layer) => { layer = factory(); } } } as unknown as Plugin.Context;
    expect(plugin.id).toBe('skillz.tui');
    expect(plugin.setup).toBe(setup);
    const cleanup = setup(ctx);
    expect(layer.mode).toBe('global');
    expect(layer.commands?.map(c => c.slash?.name)).toEqual(['skillz']);
    await layer.commands![0].run();
    expect(rpcFactory).toHaveBeenCalledWith(SkillzRpc);
    expect(h.rpc.listSources).toHaveBeenCalledWith(undefined, { location });
    // Let the non-blocking Discover refresh finish its local-cache reread.
    await vi.waitFor(() => expect(h.rpc.listSources).toHaveBeenCalledTimes(2));
    cleanup();
    await layer.commands![0].run();
    expect(h.rpc.listSources).toHaveBeenCalledTimes(2);
  });
});
