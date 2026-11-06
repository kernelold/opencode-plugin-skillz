import { describe, expect, it, vi } from 'vitest';
import type { Plugin } from '@opencode/plugin/tui';
import type { KeymapCommand } from '@opencode/plugin/tui/context';
import type { KeyEvent } from '@opentui/core';
import { createManagerUI } from '../src/tui/render.js';
import { SkillzManager } from '../src/tui/controller.js';
import type { SkillzMethods } from '../src/rpc.js';
import { tabStrip, tabs } from '../src/tui/model.js';
import { wrappedRows } from '../src/tui/viewport.js';

// Test the renderer's input/focus contract without loading native Zig bindings
// into Node. The separate real-CLI smoke verifies these actual OpenTUI classes.
vi.mock('@opentui/core', () => {
  class Node {
    children: Node[] = [];
    isDestroyed = false;
    content?: unknown;
    value = '';
    scrollTop = 0;
    layoutScrollTop?: number;
    height = 1;
    y = 0;
    id?: string;
    renderBefore?: () => void;
    get viewport() { return { y: 0, height: this.height }; }
    listeners: Record<string, () => void> = {};
    constructor(private renderer: { width: number }, options: object) {
      Object.assign(this, options);
      if (this.id === 'skillz-list') Object.defineProperty(this, 'content', { get: () => ({ y: -(this.layoutScrollTop ?? this.scrollTop), chunks: [] }) });
    }
    add(child: Node) { this.children.push(child); }
    remove(child: Node) { this.children = this.children.filter(n => n !== child); }
    getChildren() { return this.children; }
    destroyRecursively() { this.isDestroyed = true; this.children.forEach(n => n.destroyRecursively()); }
    scrollChildIntoView() {}
    getRenderable(id: string) {
      let top = 0;
      for (const child of this.children) {
        child.height = Math.max(1, child.children.reduce((n, text) => {
          const content = typeof text.content === 'string' ? text.content : (text.content as { chunks: { text: string }[] })?.chunks.map(c => c.text).join('') ?? '';
          return n + wrappedRows(content, Math.min(109, this.renderer.width - 9) - 2);
        }, 0)); child.y = top - (this.layoutScrollTop ?? this.scrollTop);
        if (child.id === id) return child;
        top += child.height;
      }
    }
    scrollBy(delta: number) { this.scrollTop += delta; }
    focus() {}
    blur() {}
    on(name: string, handler: () => void) { this.listeners[name] = handler; }
  }
  return { BoxRenderable: Node, TextRenderable: Node, InputRenderable: Node, ScrollBoxRenderable: Node,
    StyledText: class { constructor(public chunks: unknown[]) {} },
    fg: (color: unknown) => (text: string) => ({ text, fg: color }), bold: (chunk: unknown) => chunk };
});
vi.mock('solid-js', () => ({ createEffect: vi.fn((draw: () => void) => draw()), onCleanup: vi.fn() }));

type Node = { content?: string | { chunks: { text: string; fg: string }[] }; children: Node[]; height: number; id?: string; renderBefore?: () => void;
  listeners: Record<string, () => void>; value: string; scrollTop: number; layoutScrollTop?: number; backgroundColor?: string; fg?: string; onMouseDown?: () => void };
function harness(height = 48, width = 150) {
  let root!: Node;
  let close: (() => void) | undefined;
  let commands: KeymapCommand[] = [];
  const context = {
    renderer: { width, height, on: vi.fn(), off: vi.fn(), requestRender: vi.fn() },
    theme: { text: { base: 'theme-text', muted: 'theme-muted', feedback: {
      success: { base: 'theme-green' }, error: { base: 'theme-red' }, warning: { base: 'theme-yellow' }, info: { base: 'theme-info' },
    } }, background: { raised: { base: 'theme-raised', high: 'theme-selected' }, formfield: { base: 'theme-input' } } },
    ui: { dialog: { show: (render: () => Node, onClose?: () => void) => { root = render(); close = onClose; },
      clear: () => close?.(), set: vi.fn(), prompt: vi.fn() }, toast: { show: vi.fn() } },
    keymap: { layer: (factory: () => { commands: typeof commands }) => { commands = [...factory().commands]; } },
  };
  const nodes = (): Node[] => { const walk = (n: Node): Node[] => [n, ...n.children.flatMap(walk)]; return walk(root); };
  const chunks = () => nodes().flatMap(n => typeof n.content === 'object' ? n.content.chunks : []);
  const layout = () => nodes().forEach(n => n.renderBefore?.());
  return { ui: createManagerUI(context as unknown as Plugin.Context), nodes, chunks,
    root: () => root, dialogSets: context.ui.dialog.set,
    resize: (height: number, width = context.renderer.width) => {
      context.renderer.height = height; context.renderer.width = width;
      for (const [event, draw] of context.renderer.on.mock.calls as unknown as [string, () => void][]) if (event === 'resize') draw();
      layout();
    },
    layout,
    binds: () => commands.map(c => c.bind),
    press: (bind: string, event?: Partial<KeyEvent>) => { const command = commands.find(c => c.bind === bind); expect(command).toBeDefined(); command!.run(undefined, event ? { preventDefault: vi.fn(), stopPropagation: vi.fn(), ...event } as KeyEvent : undefined); layout(); },
    dismiss: () => close?.() };
}
const preview = { title: 'Install skill? · Kit', message: 'Source: /skills\nTrusted — you added this source\nSkills: a, b (2)\nVersion: v1    Licence: MIT', yes: 'Yes, install', tone: 'success' as const };

describe('theme-aware custom dialog adapter', () => {
  it.each(tabs)('jumps %s sections without traversing rows, keeps scroll, and pages only in the list', async tab => {
    const h = harness(24, 80);
    const pending = h.ui.dialog.select({ title: `Skillz: ${tabStrip(tab)}`, options: Array.from({ length: 37 }, (_, value) => ({ title: `Row ${value}`, value, description: 'Description' })), actions: [
      { bind: 'left', title: 'Previous', selection: 'none', onTrigger: vi.fn() },
      { bind: 'right', title: 'Next', selection: 'none', onTrigger: vi.fn() },
      { bind: 'ctrl+r', title: 'Refresh', selection: 'none', onTrigger: vi.fn() },
      { bind: 'ctrl+a', title: 'Add', selection: 'none', onTrigger: vi.fn() },
    ] });
    const list = h.nodes().find(n => n.id === 'skillz-list')!;
    const row = (index: number) => expect(h.chunks().some(c => c.text === `› Row ${index}`)).toBe(true);
    h.layout(); row(0);
    h.press('pagedown'); const page = Math.ceil(list.height / 2); row(page);
    h.press('pageup'); row(0);
    h.press('end'); row(36); const scroll = list.scrollTop;
    const before = h.chunks();
    for (const modifier of ['ctrl', 'meta', 'shift', 'option', 'super', 'hyper']) {
      for (const key of ['pageup', 'pagedown', 'home', 'end']) h.press(key, { [modifier]: true });
      if (modifier !== 'shift') h.press('tab', { [modifier]: true });
      h.press('shift+tab', { [modifier]: true, ctrl: true });
    }
    expect(h.chunks()).toEqual(before);
    const preventDefault = vi.fn(), stopPropagation = vi.fn();
    h.press('tab', { preventDefault, stopPropagation });
    expect(preventDefault).toHaveBeenCalledOnce(); expect(stopPropagation).toHaveBeenCalledOnce();
    expect(h.nodes().some(n => n.content === '› [ Refresh ]')).toBe(true);
    h.press('home'); h.press('pageup'); expect(list.scrollTop).toBe(scroll);
    h.press('down'); expect(h.nodes().some(n => n.content === '› [ Add ]')).toBe(true);
    h.press('tab'); expect(String(h.root().children[0].content)).toMatch(/^› /);
    h.press('end'); h.press('pagedown'); expect(list.scrollTop).toBe(scroll);
    h.press('tab'); row(36); expect(list.scrollTop).toBe(scroll);
    h.press('shift+tab', { shift: true }); expect(String(h.root().children[0].content)).toMatch(/^› /);
    h.press('shift+tab', { shift: true }); expect(h.nodes().some(n => n.content === '› [ Refresh ]')).toBe(true);
    h.press('shift+tab', { shift: true }); row(36);
    h.press('home'); row(0); h.press('pageup'); row(0);
    h.resize(12, 60); expect(String(h.root().children.at(-1)?.content)).toContain('Tab: next section');
    h.press('escape'); await pending;
  });
  it('restores each main tab row, query and scroll across controller tab switches', async () => {
    const h = harness(24, 80);
    const sources = Array.from({ length: 37 }, (_, i) => ({ id: `source-${i}`, name: `Source ${i}`, source: { type: 'local', path: `/source-${i}` }, options: {} }));
    const rpc = { listSources: async () => sources, listAvailable: async () => sources,
      listInstalled: async () => [], listErrors: async () => [], listUpdateStatus: async () => ({ checkedAt: new Date().toISOString(), updates: [] }), refresh: async () => [],
    } as unknown as SkillzMethods;
    const manager = new SkillzManager(rpc, h.ui), pending = manager.open();
    const wait = (tab: string) => vi.waitFor(() => expect(String(h.root().children[0].content)).toContain(`[${tab}]`));
    await vi.waitFor(() => expect(h.binds()).toContain('tab')); await wait('Discover');
    h.press('end'); const discoverScroll = h.nodes().find(n => n.id === 'skillz-list')!.scrollTop;
    h.press('right'); await wait('Installed sources'); h.press('right'); await wait('Sources');
    h.press('down'); h.press('down'); h.press('down');
    h.press('left'); await wait('Installed sources'); h.press('left'); await wait('Discover'); h.layout();
    expect(h.chunks().some(c => c.text === '› Source 36')).toBe(true);
    expect(h.nodes().find(n => n.id === 'skillz-list')!.scrollTop).toBe(discoverScroll);
    h.press('right'); await wait('Installed sources'); h.press('right'); await wait('Sources');
    expect(h.chunks().some(c => c.text === '› Source 3')).toBe(true);
    const input = h.nodes().find(n => n.listeners.input)!; input.value = 'Source 36'; input.listeners.input(); h.layout();
    h.press('right'); await wait('Errors'); h.press('left'); await wait('Sources');
    expect(h.nodes().find(n => n.listeners.input)!.value).toBe('Source 36');
    expect(h.chunks().some(c => c.text === '› Source 36')).toBe(true);
    h.press('escape'); await pending;
  });
  it('jumps install choices/checklist/bulk actions, restores folded focus, and pages inside the checklist', async () => {
    const h = harness(24, 80), pending = h.ui.installPreview!({ ...preview, entry: {
      id: 'kit', source: { type: 'local', path: '/skills' }, options: {},
      skillChoices: Array.from({ length: 37 }, (_, i) => ({ id: `skill-${i}`, name: `skill-${i}`, category: 'group', excluded: false })),
    } });
    h.press('e'); h.press('down'); h.press('tab');
    expect(h.chunks().some(c => c.text === '› ▾ [x] group (37/37)')).toBe(true);
    h.press('pagedown'); expect(h.chunks().some(c => /^›\s+\[x\] skill-/.test(c.text))).toBe(true);
    h.press('home'); expect(h.chunks().some(c => c.text.startsWith('› ▾'))).toBe(true);
    h.press('end'); expect(h.chunks().some(c => c.text === '›   [x] skill-36')).toBe(true);
    const list = h.nodes().find(n => n.id === 'skillz-list')!, scroll = list.scrollTop;
    h.press('tab'); expect(h.nodes().some(n => n.content === '› [ Select all skills ]')).toBe(true); expect(list.scrollTop).toBe(scroll);
    h.press('tab'); expect(h.chunks()[1].text).toBe('› [ No, cancel ]');
    h.press('tab'); expect(h.chunks().some(c => c.text === '›   [x] skill-36')).toBe(true); expect(list.scrollTop).toBe(scroll);
    h.press('shift+tab', { shift: true }); expect(h.chunks()[1].text).toBe('› [ No, cancel ]');
    h.press('c'); h.press('tab'); expect(h.chunks().some(c => c.text === '› ▸ [x] group (37/37)')).toBe(true);
    h.press('tab'); h.press('shift+tab', { shift: true }); expect(h.chunks().some(c => c.text.startsWith('› ▸'))).toBe(true);
    h.press('escape'); await pending;
  });
  it.each(['Source URL', 'Auth env-var', 'Header name', 'Query name'])('jumps %s input/button regions without altering text or cursor keys', async title => {
    const h = harness(24, 80), pending = h.ui.dialog.prompt({ title, value: 'typed' });
    h.press('tab'); expect(h.nodes().some(n => n.content === '› [ Cancel ]')).toBe(true);
    h.press('left'); expect(h.nodes().some(n => n.content === '› [ Continue ]')).toBe(true);
    h.press('tab'); expect(h.nodes().some(n => String(n.content).startsWith('› ['))).toBe(false);
    h.press('shift+tab', { shift: true }); expect(h.nodes().some(n => n.content === '› [ Cancel ]')).toBe(true);
    h.press('shift+tab', { shift: true });
    expect(h.nodes().find(n => n.value === 'typed')).toBeDefined();
    expect(String(h.root().children.at(-1)?.content)).toContain('Tab: next section');
    h.press('return'); expect(await pending).toBe('typed');
  });
  it('retains single-region menu/button Tab cycling and leaves detail-only screens alone', async () => {
    const h = harness(), pending = h.ui.dialog.select({ title: 'Source actions', options: [{ title: 'Inspect', value: 'inspect' }, { title: 'Remove', value: 'remove' }] });
    h.press('tab'); expect(h.chunks()[1].text).toBe('› Remove');
    h.press('shift+tab', { shift: true }); expect(h.chunks()[0].text).toBe('› Inspect');
    h.press('escape'); await pending;
    const detail = h.ui.dialog.alert({ title: 'Details', message: 'Long details\n'.repeat(30) });
    const before = h.nodes().map(n => n.scrollTop); h.press('tab'); h.press('shift+tab', { shift: true });
    expect(h.nodes().map(n => n.scrollTop)).toEqual(before); h.press('escape'); await detail;
  });
  it('restores list row identity after a background reorder while another section is focused', async () => {
    const h = harness(), pending = h.ui.dialog.select({ title: `Skillz: ${tabStrip('Sources')}`, options: [
      { title: 'Alpha', value: 'a' }, { title: 'Beta', value: 'b' },
    ], actions: [
      { bind: 'left', title: 'Previous', selection: 'none', onTrigger: vi.fn() },
      { bind: 'right', title: 'Next', selection: 'none', onTrigger: vi.fn() },
      { bind: 'ctrl+r', title: 'Refresh', selection: 'none', onTrigger: vi.fn() },
    ] });
    h.press('down'); h.press('tab');
    h.ui.updateSelect!({ title: `Skillz: ${tabStrip('Sources')}`, hint: 'refreshed', options: [{ title: 'Beta', value: 'b' }, { title: 'Alpha', value: 'a' }] });
    expect(h.nodes().some(n => n.content === '› [ Refresh ]')).toBe(true);
    h.press('tab'); h.press('tab'); expect(h.chunks().some(c => c.text === '› Beta')).toBe(true);
    h.press('escape'); await pending;
  });
  it('restores tab memory before the initial Solid effect runs and does not reuse it in source menus', async () => {
    const h = harness(24, 80), options = { title: `Skillz: ${tabStrip('Sources')}`, options: Array.from({ length: 37 }, (_, value) => ({ title: `Row ${value}`, value: String(value) })), actions: [
      { bind: 'left', title: 'Previous', selection: 'none' as const, onTrigger: vi.fn() },
      { bind: 'right', title: 'Next', selection: 'none' as const, onTrigger: vi.fn() },
    ] };
    const first = h.ui.dialog.select(options);
    h.ui.updateSelect!({ title: options.title, options: options.options, hint: 'checked just now' }); h.press('end');
    const scroll = h.nodes().find(n => n.id === 'skillz-list')!.scrollTop;
    h.press('escape'); await first;
    const { createEffect } = await import('solid-js');
    vi.mocked(createEffect).mockImplementationOnce(() => undefined);
    const restored = h.ui.dialog.select(options);
    h.ui.updateSelect!({ title: options.title, options: options.options, hint: 'checked just now' }); h.layout();
    expect(h.chunks().some(c => c.text === '› Row 36')).toBe(true);
    expect(h.nodes().find(n => n.id === 'skillz-list')!.scrollTop).toBe(scroll);
    h.press('escape'); await restored;
    const menu = h.ui.dialog.select({ title: '[Sources]', options: [{ title: 'Inspect', value: 'inspect' }, { title: 'Remove', value: 'remove' }] });
    expect(h.chunks()[0].text).toBe('› Inspect'); h.press('escape'); await menu;
  });
  it('reveals focus when screen translation still reflects the previous scroll frame', async () => {
    const h = harness(12, 80);
    const pending = h.ui.dialog.select({ title: `Skillz: ${tabStrip('Skills')}`, options: Array.from({ length: 37 }, (_, value) => ({ title: `Row ${value}`, value })), actions: [
      { bind: 'left', title: 'Previous', selection: 'none', onTrigger: vi.fn() },
      { bind: 'right', title: 'Next', selection: 'none', onTrigger: vi.fn() },
      { bind: 'ctrl+r', title: 'Check updates', selection: 'none', onTrigger: vi.fn() },
    ] });
    const list = h.nodes().find(n => n.id === 'skillz-list')!;
    list.scrollTop = 20; list.layoutScrollTop = 0;
    h.press('down'); expect(list.scrollTop).toBe(1);
    h.press('escape'); await pending;
  });
  it('opens Skills actions with Enter, toggles and removes with arrows, and keeps No/Cancel safe', async () => {
    const h = harness();
    const item = { sourceId: 'one', version: 'v1', current: '/cache', enabled: true, scope: 'user' as const, overrides: [], disabledSkills: [] as string[],
      skills: [{ id: 'probe', name: 'Probe', description: 'Probe description', dir: '/cache/probe', skillFile: '/cache/probe/SKILL.md' }] };
    const rpc = { listSources: async () => [], listAvailable: async () => [], listErrors: async () => [], listInstalled: async () => [item],
      listUpdateStatus: async () => ({ checkedAt: new Date().toISOString(), updates: [] }),
      setEnabled: vi.fn(async ({ enabled }: { enabled: boolean }) => { item.disabledSkills = enabled ? [] : ['probe']; return item; }),
      remove: vi.fn(async () => { item.skills = []; }),
    } as unknown as SkillzMethods;
    const manager = new SkillzManager(rpc, h.ui); const pending = manager.open();
    const wait = (label: string) => vi.waitFor(() => expect(h.nodes().some(n => n.content === label)).toBe(true));
    const title = `Skillz: ${tabStrip('Skills')}`;
    await wait(title); expect(h.chunks().some(c => c.text === '› Probe')).toBe(true);
    expect(h.dialogSets.mock.calls.every(([options]) => options.centered === true)).toBe(true);
    h.press('up'); h.press('space'); expect(rpc.setEnabled).not.toHaveBeenCalled(); h.press('down');
    h.press('return'); await wait('Skill actions · Probe');
    h.press('up'); h.press('return'); await wait(title);
    expect(rpc.setEnabled).not.toHaveBeenCalled();
    h.press('return'); await wait('Skill actions · Probe'); h.press('down'); h.press('return'); await wait(title);
    expect(rpc.setEnabled).toHaveBeenLastCalledWith({ sourceId: 'one', skillId: 'probe', enabled: false, options: { confirmOverride: false } });
    h.press('return'); await wait('Skill actions · Probe'); h.press('down'); h.press('return'); await wait(title);
    expect(rpc.setEnabled).toHaveBeenLastCalledWith({ sourceId: 'one', skillId: 'probe', enabled: true, options: { confirmOverride: false } });
    h.press('space'); await vi.waitFor(() => expect(rpc.setEnabled).toHaveBeenCalledTimes(3)); await wait(title);
    const remove = async () => { h.press('return'); await wait('Skill actions · Probe'); h.press('down'); h.press('down'); h.press('return'); await wait('Remove installed skill?'); };
    await remove(); h.press('return'); await wait(title); expect(rpc.remove).not.toHaveBeenCalled();
    await remove(); h.press('escape'); await wait(title); expect(rpc.remove).not.toHaveBeenCalled();
    await remove(); h.press('up'); h.press('return');
    await wait('No installed skills. Find skills in Discover or add a source in Sources.');
    expect(rpc.remove).toHaveBeenCalledWith({ sourceId: 'one', skillId: 'probe' }); h.press('escape'); await pending;
  });
  it.each(tabs)('pins %s chrome and reveals actual multiline row heights at every viewport size', async tab => {
    const h = harness(24, 80);
    const actionTitles = tab === 'Skills' ? ['Check updates', 'Enable / disable selected skill'] : tab === 'Installed sources' ? ['Check updates']
      : tab === 'Errors' ? ['Refresh', 'Clear errors'] : ['Refresh', 'Add source'];
    const pending = h.ui.dialog.select({ title: `Skillz: ${tabStrip(tab)}`, options: Array.from({ length: 37 }, (_, i) => ({
      title: `Row ${i} with a long name`, value: i, category: 'Category', description: 'A long description that wraps across several terminal lines.', footer: '[enabled] [up to date] · source identifier',
    })), actions: [
      { bind: 'left', title: 'Previous tab', selection: 'none', onTrigger: vi.fn() },
      { bind: 'right', title: 'Next tab', selection: 'none', onTrigger: vi.fn() },
      ...actionTitles.map((title, i) => ({ bind: i ? 'ctrl+a' : 'ctrl+r', title, selection: 'none' as const, onTrigger: vi.fn() })),
    ] });
    const verify = (height: number, width: number) => {
      const list = h.nodes().find(n => n.id === 'skillz-list')!;
      expect(h.root().height).toBeLessThanOrEqual(Math.max(1, height - 3));
      expect(h.nodes().every(n => n.height >= 0)).toBe(true);
      // Check requested chrome positions, not merely that footer nodes exist.
      expect(h.root().children.reduce((n, child) => n + child.height, 0)).toBeLessThanOrEqual(h.root().height);
      expect(String(h.root().children[0].content).length).toBeLessThanOrEqual(Math.max(1, width - 9));
      if (height >= 8) {
        expect(h.root().children.at(-1)?.height).toBeGreaterThan(0);
        expect(h.nodes().find(n => n.id === 'skillz-actions')!.height).toBeGreaterThan(0);
      }
      const index = list.children.findIndex(row => typeof row.children[0]?.content === 'object' && row.children[0].content.chunks[0].text.startsWith('›'));
      if (index < 0 || !list.height) return;
      const start = list.children.slice(0, index).reduce((n, row) => n + row.height, 0);
      expect(start).toBeGreaterThanOrEqual(list.scrollTop);
      expect(start + Math.min(list.children[index].height, list.height)).toBeLessThanOrEqual(list.scrollTop + list.height);
    };
    for (const [height, width] of [[24, 80], [12, 60], [48, 100], [8, 30], [3, 20], [24, 80]]) {
      h.resize(height, width); verify(height, width);
      for (let i = 0; i < 42; i++) { h.press('down'); verify(height, width); }
      for (let i = 0; i < 42; i++) { h.press('up'); verify(height, width); }
      const input = h.nodes().find(n => n.listeners.input)!;
      input.value = 'Row 36'; input.listeners.input(); h.layout(); verify(height, width);
      input.value = ''; input.listeners.input(); h.layout(); verify(height, width);
    }
    h.press('escape'); await pending;
  });
  it.each([12, 24, 48, 100])('pins install controls and reveals every expanded row at %i rows, including resize/folds/bulk selection', async height => {
    const h = harness(height); const pending = h.ui.installPreview!({ ...preview, entry: {
      id: 'kit', source: { type: 'local', path: '/skills' }, options: {},
      skillChoices: Array.from({ length: 37 }, (_, i) => ({ id: `skill-${i}`, name: `skill-${i}`, category: `group-${i % 7}`, excluded: false })),
    } });
    const list = () => h.nodes().find(n => n.id === 'skillz-list')!;
    const verify = (rows: number) => {
      expect(h.root().height).toBeLessThanOrEqual(rows - 3);
      expect(list().height).toBeGreaterThanOrEqual(1);
      expect(list().children.some(n => n.id === 'skillz-row-0' || n.id === 'skillz-row-1')).toBe(false);
      expect(h.root().children).toContain(h.nodes().find(n => n.id === 'skillz-choices'));
      expect(h.root().children).toContain(h.nodes().find(n => typeof n.content === 'string' && n.content.startsWith('The following skills')));
      expect(h.root().children).toContain(h.nodes().find(n => n.id === 'skillz-actions'));
      expect(String(h.root().children.at(-1)?.content)).toContain('Esc: cancel');
      const index = list().children.findIndex(n => typeof n.children[0]?.content === 'object' && n.children[0].content.chunks[0].text.startsWith('›'));
      if (index < 0) return;
      const start = list().children.slice(0, index).reduce((n, row) => n + row.height, 0);
      expect(start).toBeGreaterThanOrEqual(list().scrollTop);
      expect(start + list().children[index].height).toBeLessThanOrEqual(list().scrollTop + list().height);
    };
    h.press('e'); verify(height);
    for (let i = 0; i < 46; i++) { h.press('down'); verify(height); }
    for (let i = 0; i < 46; i++) { h.press('up'); verify(height); }
    h.press('down'); h.press('down'); h.press('right'); h.press('right');
    h.resize(12); verify(12); h.press('n'); verify(12); h.press('a'); verify(12);
    h.press('left'); verify(12); h.press('c'); verify(12); h.press('e'); verify(12);
    h.resize(48, 90); verify(48);
    h.resize(3, 20); expect(h.nodes().every(n => n.height >= 0)).toBe(true);
    h.press('escape'); await pending;
  });
  it.each(['Skills', 'Discover', 'Sources', 'Installed sources', 'Errors', 'Details', 'Removal'])('shares the responsive budget with long %s dialogs', async title => {
    const h = harness(24);
    const message = Array.from({ length: 100 }, (_, i) => `Long detail ${i}`).join('\n');
    const pending = title === 'Details' ? h.ui.dialog.alert({ title, message }) : title === 'Removal'
      ? h.ui.removalChoice({ title, message, count: 100 }) : h.ui.dialog.select({ title,
        options: Array.from({ length: 100 }, (_, i) => ({ title: `Row ${i}`, value: i, description: 'Description', footer: '[enabled]' })) });
    expect(h.root().height).toBeLessThanOrEqual(21);
    h.resize(12); expect(h.root().height).toBeLessThanOrEqual(9);
    expect(String(h.root().children.at(-1)?.content)).toContain('Esc:');
    h.press('down'); h.press('escape'); await pending;
  });
  it('keeps prompt input, buttons and hints outside a long description viewport on resize', async () => {
    const h = harness(24); const pending = h.ui.dialog.prompt({ title: 'Source', description: 'Long description\n'.repeat(100), value: 'typed' });
    expect(h.root().height).toBeLessThanOrEqual(21);
    h.resize(12); expect(h.root().height).toBeLessThanOrEqual(9);
    expect(h.root().children.some(n => n.value === 'typed')).toBe(true);
    expect(String(h.root().children.at(-1)?.content)).toContain('Esc: cancel');
    h.press('pagedown'); expect(h.nodes().some(n => n.scrollTop === 5)).toBe(true);
    h.press('down'); h.press('return'); expect(await pending).toBeUndefined();
  });
  it('reaches checklist bulk actions using arrows and Enter, without letter shortcuts', async () => {
    const h = harness(); const pending = h.ui.installPreview!({ ...preview, entry: { id: 'kit', source: { type: 'local', path: '/skills' }, options: {},
      skillChoices: [{ id: 'one', name: 'one', category: 'alpha', excluded: false }, { id: 'two', name: 'two', category: 'beta', excluded: false }] } });
    const activate = (title: string) => {
      for (let i = 0; i < 20 && !h.nodes().some(n => n.content === `› [ ${title} ]`); i++) h.press('down');
      expect(h.nodes().some(n => n.content === `› [ ${title} ]`)).toBe(true); h.press('return');
    };
    activate('Select no skills'); expect(h.chunks().every(c => !c.text.includes('[x]'))).toBe(true);
    const before = h.chunks(); h.press('space'); h.press('left'); h.press('right'); expect(h.chunks()).toEqual(before);
    activate('Select all skills'); expect(h.chunks().some(c => c.text.includes('[x] alpha'))).toBe(true);
    activate('Expand all categories'); expect(h.chunks().some(c => c.text.includes('[x] one'))).toBe(true);
    activate('Collapse all categories'); expect(h.chunks().some(c => c.text.includes('[x] one'))).toBe(false);
    h.press('down'); expect(h.chunks()[0].text).toBe('› [ Yes, install ]'); h.press('return'); expect(await pending).toEqual([]);
  });
  it.each(['Skills', 'Discover', 'Installed sources', 'Sources', 'Errors'])('reaches every %s main-menu action with arrows and switches tabs from every zone', async tab => {
    const h = harness(); const previous = vi.fn(); const next = vi.fn();
    const titles = tab === 'Installed sources' || tab === 'Skills' ? ['Check updates'] : tab === 'Errors' ? ['Refresh', 'Clear errors'] : ['Refresh', 'Add source'];
    const triggers = titles.map(() => vi.fn());
    const pending = h.ui.dialog.select({ title: `Skillz · [${tab}]`, options: [{ title: 'First', value: 'first' }, { title: 'Second', value: 'second' }], actions: [
      { bind: 'left', title: 'Previous tab', selection: 'none', onTrigger: previous },
      { bind: 'right', title: 'Next tab', selection: 'none', onTrigger: next },
      ...titles.map((title, i) => ({ bind: i ? 'ctrl+a' : 'ctrl+r', title, selection: 'none' as const, onTrigger: triggers[i] })),
    ] });
    for (const alias of ['ctrl+p', 'ctrl+n', 'ctrl+t', 'h', 'j', 'k', 'l']) expect(h.binds()).not.toContain(alias);
    h.press('up'); expect(h.nodes().some(n => n.content === `› Skillz · [${tab}]`)).toBe(true);
    h.press('return'); // The tab strip is not an action.
    h.press('left'); h.press('right');
    h.press('down'); expect(h.chunks()[0].text).toBe('› First');
    h.press('left'); h.press('right');
    h.press('down'); expect(h.chunks()[1].text).toBe('› Second');
    h.press('left'); h.press('right');
    for (let i = 0; i < titles.length; i++) {
      h.press('down'); expect(h.nodes().some(n => n.content === `› [ ${titles[i]} ]`)).toBe(true);
      const before = h.chunks();
      for (const modifier of ['ctrl', 'meta', 'shift', 'option', 'super', 'hyper']) {
        for (const key of ['up', 'down', 'left', 'right', 'return', 'escape']) h.press(key, { [modifier]: true });
      }
      expect(h.chunks()).toEqual(before); expect(triggers[i]).not.toHaveBeenCalled();
      h.press('left'); h.press('right'); h.press('return'); expect(triggers[i]).toHaveBeenCalledOnce();
    }
    expect(previous).toHaveBeenCalledTimes(3 + titles.length); expect(next).toHaveBeenCalledTimes(3 + titles.length);
    h.press('down'); expect(h.nodes().some(n => n.content === `› Skillz · [${tab}]`)).toBe(true);
    h.press('down'); h.press('return'); expect(await pending).toBe('first');
  });
  it.each([{ options: [] }, { options: [{ title: 'Hidden', value: 'hidden' }] }])('keeps tabs and actions reachable with an empty/filtered list', async ({ options }) => {
    const h = harness(); const add = vi.fn();
    const pending = h.ui.dialog.select({ title: 'Skillz', options, actions: [
      { bind: 'left', title: 'Previous', selection: 'none', onTrigger: vi.fn() },
      { bind: 'right', title: 'Next', selection: 'none', onTrigger: vi.fn() },
      { bind: 'ctrl+a', title: 'Add source', selection: 'none', onTrigger: add },
    ] });
    const input = h.nodes().find(n => n.listeners.input)!; input.value = 'hjkl'; input.listeners.input();
    expect(h.nodes().some(n => n.content === '› Skillz')).toBe(true);
    h.press('down'); h.press('return'); expect(add).toHaveBeenCalledOnce();
    h.press('up'); expect(h.nodes().some(n => n.content === '› Skillz')).toBe(true);
    h.press('escape'); await pending;
  });
  it.each([
    ['Source actions', ['Disable source', 'Update source', 'Remove installed entry', 'Remove one skill…', 'Enable / disable one skill…']],
    ['Abandoned source actions', ['Enable source', 'Remove installed entry', 'Remove one skill…', 'Enable / disable one skill…']],
    ['Source menu', ['Inspect source', 'Refresh catalogs', 'Inspect / install skills', 'Remove source']],
    ['Marketplace menu', ['Inspect source', 'Refresh catalogs', 'Remove source']],
    ['Add source', ['Marketplace', 'Direct source']],
    ['HTTP auth transport', ['Bearer', 'Custom header', 'Query parameter']],
    ['Remove one installed skill', ['one', 'two']],
    ['Enable / disable one installed skill', ['Disable one', 'Enable two']],
  ])('reaches all stacked choices in %s without modifiers or Tab', async (title, titles) => {
    for (let i = 0; i < titles.length; i++) {
      const h = harness(); const pending = h.ui.dialog.select({ title, options: titles.map(value => ({ title: value, value })) });
      for (const modifier of ['ctrl', 'meta', 'shift', 'option', 'super', 'hyper']) {
        for (const key of ['up', 'down', 'return', 'escape']) h.press(key, { [modifier]: true });
      }
      expect(h.chunks()[0].text).toBe(`› ${titles[0]}`);
      h.press('up'); expect(h.chunks().at(-1)?.text).toBe(`› ${titles.at(-1)}`);
      h.press('down'); for (let step = 0; step < i; step++) h.press('down');
      h.press('return'); expect(await pending).toBe(titles[i]);
    }
  });
  it.each(['Installed source', 'Source details', 'Error details', 'Cannot override'])('scrolls %s with arrows and goes back with Enter/Esc', async title => {
    const h = harness(); const pending = h.ui.dialog.alert({ title, message: 'Read-only details' });
    const before = h.nodes().map(n => n.scrollTop);
    h.press('down'); expect(h.nodes().map(n => n.scrollTop)).not.toEqual(before);
    h.press('up'); expect(h.nodes().map(n => n.scrollTop)).toEqual(before);
    for (const modifier of ['ctrl', 'meta', 'shift', 'option', 'super', 'hyper']) {
      for (const key of ['up', 'down', 'return', 'escape']) h.press(key, { [modifier]: true });
    }
    expect(h.nodes().map(n => n.scrollTop)).toEqual(before);
    expect(h.nodes().some(n => n.content === '↑/↓: scroll · Enter/Esc: back')).toBe(true);
    h.press('return'); await pending;
  });
  it.each(['Override skill?', 'Remove installed source?', 'Remove installed skill?', 'Remove empty source?', 'Clear all errors?'])('keeps %s on No until an unmodified choice is made', async title => {
    const h = harness(); const pending = h.ui.confirmation({ ...preview, title });
    for (const modifier of ['ctrl', 'meta', 'shift', 'option', 'super', 'hyper']) {
      for (const key of ['up', 'down', 'return', 'escape']) h.press(key, { [modifier]: true });
      if (modifier !== 'shift') h.press('tab', { [modifier]: true });
    }
    expect(h.chunks()[1].text).toBe('› [ No, cancel ]');
    h.press('return'); expect(await pending).toBe(false);
    const c = harness(); const confirmed = c.ui.confirmation({ ...preview, title });
    c.press('up'); c.press('return'); expect(await confirmed).toBe(true);
  });
  it.each(['Source URL', 'Marketplace URL', 'Optional HTTP auth env-var NAME', 'Header name', 'Query parameter name'])('owns arrow-only %s prompt navigation with Cancel default', async title => {
    const h = harness(); const pending = h.ui.dialog.prompt({ title, value: 'initial' });
    const input = h.nodes().find(n => n.value === 'initial')!;
    input.value = 'typed';
    for (const modifier of ['ctrl', 'meta', 'shift', 'option', 'super', 'hyper']) {
      for (const key of ['up', 'down', 'left', 'right', 'return', 'escape']) h.press(key, { [modifier]: true });
    }
    expect(h.nodes().some(n => n.content === '› [ Cancel ]')).toBe(false);
    h.press('down'); expect(h.nodes().some(n => n.content === '› [ Cancel ]')).toBe(true);
    h.press('left'); expect(h.nodes().some(n => n.content === '› [ Continue ]')).toBe(true);
    h.press('right'); expect(h.nodes().some(n => n.content === '› [ Cancel ]')).toBe(true);
    h.press('up'); h.press('down'); h.press('left'); h.press('return'); expect(await pending).toBe('typed');
    const c = harness(); const cancelled = c.ui.dialog.prompt({ title }); c.press('down'); c.press('return'); expect(await cancelled).toBeUndefined();
    const e = harness(); const escaped = e.ui.dialog.prompt({ title }); e.press('escape'); expect(await escaped).toBeUndefined();
  });
  it('uses only plain checklist keys and flows between choices and skills without Tab', async () => {
    const h = harness(); const pending = h.ui.installPreview!({ ...preview, entry: { id: 'kit', source: { type: 'local', path: '/skills' }, options: {},
      skillChoices: [{ id: 'root', name: 'root', excluded: false }, { id: 'one', name: 'one', category: 'alpha', excluded: false },
        { id: 'two', name: 'two', category: 'beta', excluded: false }] } });
    for (const alias of ['h', 'l']) expect(h.binds()).not.toContain(alias);
    expect(h.binds().filter(bind => typeof bind === 'string' && bind.includes('+'))).toEqual(['shift+tab']);
    h.press('left'); h.press('right');
    expect(h.chunks()[0].text).toBe('› [ Yes, install ]');
    h.press('down'); expect(h.chunks()[1].text).toBe('› [ No, cancel ]');
    h.press('down'); expect(h.chunks()[2].text).toBe('› [x] root');
    h.press('left'); h.press('right'); expect(h.chunks()[2].text).toBe('› [x] root');
    h.press('down'); h.press('left'); expect(h.chunks()[3].text).toBe('› ▸ [x] alpha (1/1)');
    h.press('right'); expect(h.chunks()[3].text).toBe('› ▾ [x] alpha (1/1)');
    h.press('right'); expect(h.chunks()[4].text).toBe('›   [x] one');
    h.press('right'); expect(h.chunks()[4].text).toBe('›   [x] one');
    h.press('left'); expect(h.chunks()[3].text).toBe('› ▾ [x] alpha (1/1)');
    h.press('left'); expect(h.chunks()[3].text).toBe('› ▸ [x] alpha (1/1)');
    h.press('up'); h.press('up'); h.press('up'); expect(h.chunks()[0].text).toBe('› [ Yes, install ]');
    h.press('return'); expect(await pending).toEqual([]);
  });
  it.each(['ctrl', 'meta', 'shift', 'option', 'super', 'hyper'] as const)('ignores checklist events with %s', async modifier => {
    const h = harness(); const pending = h.ui.installPreview!({ ...preview, entry: { id: 'kit', source: { type: 'local', path: '/skills' }, options: {},
      skillChoices: [{ id: 'one', name: 'one', category: 'alpha', excluded: false }] } });
    const before = h.chunks();
    for (const key of ['up', 'down', 'left', 'right', 'space', 'return', 'escape', 'a', 'n', 'e', 'c']) h.press(key, { [modifier]: true });
    if (modifier !== 'shift') h.press('tab', { [modifier]: true });
    expect(h.chunks()).toEqual(before);
    h.press('down'); h.press('down');
    const header = h.chunks();
    for (const key of ['left', 'right', 'space', 'return', 'e', 'c', 'a', 'n']) h.press(key, { [modifier]: true });
    expect(h.chunks()).toEqual(header);
    h.press('escape'); expect(await pending).toBeUndefined();
  });
  it('keeps list typing and arrow-only footer access, ignoring modified tab arrows', async () => {
    const h = harness(); const action = vi.fn();
    const pending = h.ui.dialog.select({ title: 'Sources', options: [{ title: 'hello', value: 'hello' }, { title: 'other', value: 'other' }],
      actions: [{ bind: 'right', title: 'Next tab', selection: 'none', onTrigger: action }] });
    for (const alias of ['ctrl+p', 'ctrl+n', 'h', 'j', 'k', 'l']) expect(h.binds()).not.toContain(alias);
    for (const modifier of ['ctrl', 'meta', 'shift', 'option', 'super', 'hyper']) {
      h.press('down', { [modifier]: true }); h.press('right', { [modifier]: true }); h.press('return', { [modifier]: true });
    }
    expect(h.chunks()[0].text).toBe('› hello'); expect(action).not.toHaveBeenCalled();
    h.press('right'); expect(action).toHaveBeenCalledOnce();
    const input = h.nodes().find(n => n.listeners.input)!;
    input.value = 'h l'; input.listeners.input(); expect(h.chunks()).toHaveLength(0);
    input.value = 'hello'; input.listeners.input();
    h.press('down'); h.press('return'); expect(action).toHaveBeenCalledTimes(2);
    h.press('up'); h.press('return'); expect(await pending).toBe('hello');
  });
  it('ignores modified removal navigation and activation', async () => {
    const h = harness(); const pending = h.ui.removalChoice({ title: 'Remove?', message: 'Source: /skills', count: 1 });
    const before = h.chunks();
    for (const modifier of ['ctrl', 'meta', 'shift', 'option', 'super', 'hyper']) {
      for (const key of ['up', 'down', 'return', 'escape']) h.press(key, { [modifier]: true });
    }
    expect(h.chunks()).toEqual(before);
    h.press('up'); h.press('return'); expect(await pending).toBe('keep');
  });
  it('defaults installation to Yes with all skills selected below the choices', async () => {
    const h = harness(); const pending = h.ui.installPreview!({ ...preview, entry: { id: 'kit', source: { type: 'local', path: '/skills' }, options: {}, skills: ['one', 'two'] } });
    expect(h.chunks().map(c => c.text)).toEqual(['› [ Yes, install ]', '  [ No, cancel ]', '  [x] one', '  [x] two']);
    expect(h.chunks().map(c => c.fg)).toEqual(['theme-green', 'theme-red', 'theme-green', 'theme-green']);
    const description = h.nodes().find(n => n.content === 'The following skills will be installed:')!;
    expect(h.root().children).toContain(description);
    expect(h.root().children[h.root().children.indexOf(description) - 1].content).toBe('');
    expect(description.fg).toBe('theme-muted');
    h.press('return'); expect(await pending).toEqual([]);
  });
  it('toggles category and skill markers with semantic colours, refusing an empty Yes', async () => {
    const h = harness(); const pending = h.ui.installPreview!({ ...preview, entry: { id: 'kit', source: { type: 'local', path: '/skills' }, options: {},
      skillChoices: [{ id: 'one', name: 'one', category: 'alpha', excluded: false }, { id: 'two', name: 'two', category: 'alpha', excluded: false }] } });
    h.press('down'); h.press('down'); h.press('down'); h.press('space');
    expect(h.chunks().find(c => c.text.includes('[-] alpha'))?.fg).toBe('theme-yellow');
    expect(h.chunks().find(c => c.text.includes('[ ] one'))?.fg).toBe('theme-red');
    expect(h.chunks().some(c => c.text.includes('alpha (1/2)'))).toBe(true);
    expect(h.nodes().find(n => n.content === 'The following skills will be installed (1 of 2 selected):')?.fg).toBe('theme-muted');
    h.press('up'); h.press('space'); expect(h.chunks().find(c => c.text.includes('[x] alpha'))?.fg).toBe('theme-green');
    h.press('n'); h.press('up'); h.press('up'); h.press('return');
    expect(h.nodes().some(n => n.content === 'Select at least one skill')).toBe(true);
    h.press('a'); h.press('down'); h.press('down'); h.press('space'); h.press('up'); h.press('up'); h.press('return');
    expect(h.nodes().some(n => n.content === 'Select at least one skill')).toBe(true);
    h.press('a'); h.press('return'); expect(await pending).toEqual([]);
  });
  it('installs only the checked skills and cancels safely with Escape or No, cancel', async () => {
    const entry = { id: 'kit', source: { type: 'local' as const, path: '/skills' }, options: {}, skills: ['one', 'two'] };
    const h = harness(); const pending = h.ui.installPreview!({ ...preview, entry });
    h.press('down'); h.press('down'); h.press('space'); h.press('up'); h.press('up'); h.press('return');
    expect(await pending).toEqual(['one']);
    for (const cancel of ['escape', 'No, cancel']) {
      const c = harness(); const cancelled = c.ui.installPreview!({ ...preview, entry });
      if (cancel === 'No, cancel') { c.press('down'); c.press('return'); } else c.press(cancel);
      expect(await cancelled).toBeUndefined();
    }
  });
  it('navigates visible categories, folds headers without selecting and repairs child focus', async () => {
    const h = harness(); const pending = h.ui.installPreview!({ ...preview, entry: { id: 'kit', source: { type: 'local', path: '/skills' }, options: {},
      skillChoices: [{ id: 'one', name: 'one', category: 'alpha', excluded: false }, { id: 'two', name: 'two', category: 'alpha', excluded: false },
        { id: 'three', name: 'three', category: 'beta', excluded: false }] } });
    expect(h.chunks().map(c => c.text)).toEqual(['› [ Yes, install ]', '  [ No, cancel ]', '  ▸ [x] alpha (2/2)', '  ▸ [x] beta (1/1)']);
    h.press('down'); h.press('down'); h.press('down');
    expect(h.chunks().some(c => c.text === '› ▸ [x] beta (1/1)')).toBe(true);
    h.press('up'); h.press('space');
    expect(h.chunks().find(c => c.text === '› ▸ [ ] alpha (0/2)')?.fg).toBe('theme-red');
    h.press('return');
    expect(h.chunks().some(c => c.text === '› ▾ [ ] alpha (0/2)')).toBe(true);
    expect(h.chunks().some(c => c.text === '    [ ] one')).toBe(true);
    h.press('down'); h.press('left');
    expect(h.chunks().some(c => c.text === '› ▾ [ ] alpha (0/2)')).toBe(true);
    expect(h.chunks().some(c => c.text.includes('[ ] one'))).toBe(true);
    h.press('left');
    expect(h.chunks().some(c => c.text === '› ▸ [ ] alpha (0/2)')).toBe(true);
    expect(h.chunks().some(c => c.text.includes('[ ] one'))).toBe(false);
    h.press('right'); h.press('right'); h.press('space');
    expect(h.chunks().find(c => c.text.includes('[-] alpha (1/2)'))?.fg).toBe('theme-yellow');
    h.press('e');
    expect(h.chunks().some(c => c.text === '›   [x] one')).toBe(true);
    expect(h.chunks().some(c => c.text.includes('[x] three'))).toBe(true);
    h.press('c');
    expect(h.chunks().some(c => c.text === '› ▸ [-] alpha (1/2)')).toBe(true);
    h.press('space'); h.press('right'); h.press('return');
    expect(h.chunks().some(c => c.text === '› ▸ [x] alpha (2/2)')).toBe(true);
    h.press('up'); h.press('up'); h.press('return'); expect(await pending).toEqual([]);
  });
  it.each(['return', 'escape', 'dismiss'])('defaults the three stacked removal choices to Cancel (%s)', async key => {
    const h = harness(); const pending = h.ui.removalChoice({ title: 'Remove source?', message: 'Source: /skills\nInstalled skills: 2\norigin / a\norigin / b', count: 2 });
    expect(h.chunks().map(c => c.text)).toEqual(['  [ Remove source AND its 2 installed skills ]', '  [ Remove source only — keep the skills (they become abandoned) ]', '› [ Cancel ]']);
    expect(h.chunks().map(c => c.fg)).toEqual(['theme-red', 'theme-yellow', 'theme-info']);
    expect(h.nodes().filter(n => n.onMouseDown)).toHaveLength(3);
    expect(h.nodes().some(n => n.listeners.input)).toBe(false);
    if (key === 'dismiss') h.dismiss(); else h.press(key);
    expect(await pending).toBeUndefined();
  });
  it.each(['remove', 'keep'] as const)('requires explicit selection of removal branch %s', async choice => {
    const h = harness(); const pending = h.ui.removalChoice({ title: 'Remove source?', message: 'Source: /skills', count: 1 });
    h.press('up'); if (choice === 'remove') h.press('up');
    h.press('return'); expect(await pending).toBe(choice);
  });
  it('distinguishes abandoned badges from the dim source-removed hint', async () => {
    const h = harness(); const pending = h.ui.dialog.select({ title: 'Installed sources', options: [{ title: 'Kept skill', value: 'kept', footer: '[enabled] [abandoned] · source removed' }] });
    expect(h.chunks().find(c => c.text === '[abandoned]')?.fg).toBe('theme-yellow');
    expect(h.chunks().find(c => c.text === ' · source removed')?.fg).toBe('theme-muted');
    h.press('escape'); await pending;
  });
  it('updates rows in place, preserving input, selected identity, action focus and scroll position', async () => {
    const h = harness(); const action = vi.fn();
    const pending = h.ui.dialog.select({ title: 'Installed sources', options: [
      { title: 'Kit alpha', value: 'a' }, { title: 'Kit beta', value: 'b' },
    ], actions: [{ bind: 'ctrl+r', title: 'Check updates', selection: 'none', onTrigger: action }] });
    const input = h.nodes().find(n => n.listeners.input)!;
    input.value = 'kit'; input.listeners.input(); h.press('down');
    const list = h.nodes().find(n => n.children.some(child => child.onMouseDown))!;
    list.scrollTop = 7;
    h.ui.updateSelect!({ title: 'Installed sources', hint: 'checked just now', options: [
      { title: 'Kit beta', value: 'b', footer: '[update available]' }, { title: 'Kit alpha', value: 'a' },
    ] });
    expect(h.nodes().find(n => n.listeners.input)).toBe(input);
    expect(input.value).toBe('kit');
    expect(list.scrollTop).toBe(7);
    expect(h.chunks().some(c => c.text === '› Kit beta')).toBe(true);
    expect(h.nodes().find(n => n.content === 'checked just now')?.fg).toBe('theme-muted');
    h.press('down'); h.press('down');
    h.ui.updateSelect!({ title: 'Installed sources', hint: 'checking…', options: [{ title: 'Kit beta', value: 'b' }] });
    h.press('return'); expect(action).toHaveBeenCalledOnce();
    h.press('up'); h.press('return'); expect(await pending).toBe('b');
    h.ui.updateSelect!({ title: 'Must not reopen', hint: '', options: [] });
    expect(h.nodes().some(n => n.content === 'Must not reopen')).toBe(false);
  });
  it('shows a loading row and muted failure badges', async () => {
    const h = harness(); const pending = h.ui.dialog.select({ title: 'Discover', options: [] });
    h.ui.updateSelect!({ title: 'Discover', hint: 'loading…', options: [] });
    expect(h.nodes().filter(n => n.content === 'loading…')).toHaveLength(2);
    h.ui.updateSelect!({ title: 'Installed sources', hint: 'check failed · see Errors', options: [{ title: 'Kit', value: 'kit', footer: '[update check failed]' }] });
    expect(h.chunks().find(c => c.text === '[update check failed]')?.fg).toBe('theme-muted');
    h.press('escape'); await pending;
  });
  it('renders only two stacked choices, read-only preview and No, cancel focused by default', async () => {
    const h = harness();
    const pending = h.ui.confirmation(preview);
    expect(h.chunks().map(c => c.text)).toEqual(['  [ Yes, install ]', '› [ No, cancel ]']);
    expect(h.chunks().map(c => c.fg)).toEqual(['theme-green', 'theme-red']);
    expect(h.nodes().filter(n => n.onMouseDown)).toHaveLength(2);
    expect(h.nodes().find(n => n.content === 'Trusted — you added this source')?.fg).toBe('theme-green');
    expect(h.nodes().some(n => n.backgroundColor === 'theme-selected')).toBe(true);
    h.press('return');
    expect(await pending).toBe(false);
  });
  it.each(['escape', 'dismiss'])('treats %s as No', async key => {
    const h = harness(); const pending = h.ui.confirmation(preview);
    if (key === 'dismiss') h.dismiss(); else h.press(key);
    expect(await pending).toBe(false);
  });
  it.each(['up', 'down', 'tab'])('requires explicit navigation with %s before Enter authorizes', async key => {
    const h = harness(); const pending = h.ui.confirmation(preview);
    h.press(key); expect(h.chunks()[0].text).toBe('› [ Yes, install ]');
    h.press('return'); expect(await pending).toBe(true);
  });
  it('uses warning/destructive tokens, including marketplace provenance', async () => {
    const h = harness(); const pending = h.ui.confirmation({ ...preview, message: 'Not added by you — from marketplace Catalog', yes: 'Yes, remove', tone: 'error' });
    expect(h.nodes().find(n => typeof n.content === 'string' && n.content.startsWith('Not added'))?.fg).toBe('theme-yellow');
    expect(h.chunks()[0].fg).toBe('theme-red');
    h.nodes().filter(n => n.onMouseDown)[0].onMouseDown!();
    expect(await pending).toBe(true);
  });
  it('colours badges independently, filters and preserves footer keyboard/Tab actions', async () => {
    const h = harness(); const action = vi.fn();
    const pending = h.ui.dialog.select({ title: 'Installed sources', options: [
      { title: 'Kit', value: 'kit', footer: '[disabled] [update available] [overrides]' },
      { title: 'Other', value: 'other' },
    ], actions: [{ bind: 'ctrl+r', title: 'Update source', selection: 'none', onTrigger: action }] });
    expect(h.chunks().filter(c => c.text.startsWith('[')).map(c => c.fg)).toEqual(['theme-red', 'theme-yellow', 'theme-yellow']);
    h.press('ctrl+r'); expect(action).toHaveBeenCalledTimes(1);
    h.press('down'); h.press('down'); h.press('return'); expect(action).toHaveBeenCalledTimes(2);
    const input = h.nodes().find(n => n.listeners.input)!;
    input.value = 'other'; input.listeners.input(); h.press('return');
    expect(await pending).toBe('other');
  });
});
