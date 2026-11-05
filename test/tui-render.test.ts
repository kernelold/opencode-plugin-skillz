import { describe, expect, it, vi } from 'vitest';
import type { Plugin } from '@opencode/plugin/tui';
import { createManagerUI } from '../src/tui/render.js';

// Test the renderer's input/focus contract without loading native Zig bindings
// into Node. The separate real-CLI smoke verifies these actual OpenTUI classes.
vi.mock('@opentui/core', () => {
  class Node {
    children: Node[] = [];
    isDestroyed = false;
    content?: unknown;
    value = '';
    scrollTop = 0;
    listeners: Record<string, () => void> = {};
    constructor(_renderer: unknown, options: object) { Object.assign(this, options); }
    add(child: Node) { this.children.push(child); }
    remove(child: Node) { this.children = this.children.filter(n => n !== child); }
    getChildren() { return this.children; }
    destroyRecursively() { this.isDestroyed = true; this.children.forEach(n => n.destroyRecursively()); }
    scrollChildIntoView() {}
    scrollBy() {}
    focus() {}
    on(name: string, handler: () => void) { this.listeners[name] = handler; }
  }
  return { BoxRenderable: Node, TextRenderable: Node, InputRenderable: Node, ScrollBoxRenderable: Node,
    StyledText: class { constructor(public chunks: unknown[]) {} },
    fg: (color: unknown) => (text: string) => ({ text, fg: color }), bold: (chunk: unknown) => chunk };
});
vi.mock('solid-js', () => ({ createEffect: (draw: () => void) => draw(), onCleanup: vi.fn() }));

type Node = { content?: string | { chunks: { text: string; fg: string }[] }; children: Node[];
  listeners: Record<string, () => void>; value: string; scrollTop: number; backgroundColor?: string; fg?: string; onMouseDown?: () => void };
function harness() {
  let root!: Node;
  let close: (() => void) | undefined;
  let commands: { bind?: string | false; run: () => void }[] = [];
  const context = {
    renderer: { width: 150, height: 48 },
    theme: { text: { base: 'theme-text', muted: 'theme-muted', feedback: {
      success: { base: 'theme-green' }, error: { base: 'theme-red' }, warning: { base: 'theme-yellow' }, info: { base: 'theme-info' },
    } }, background: { raised: { base: 'theme-raised', high: 'theme-selected' }, formfield: { base: 'theme-input' } } },
    ui: { dialog: { show: (render: () => Node, onClose?: () => void) => { root = render(); close = onClose; },
      clear: () => close?.(), set: vi.fn(), prompt: vi.fn() }, toast: { show: vi.fn() } },
    keymap: { layer: (factory: () => { commands: typeof commands }) => { commands = [...factory().commands]; } },
  };
  const nodes = (): Node[] => { const walk = (n: Node): Node[] => [n, ...n.children.flatMap(walk)]; return walk(root); };
  const chunks = () => nodes().flatMap(n => typeof n.content === 'object' ? n.content.chunks : []);
  return { ui: createManagerUI(context as unknown as Plugin.Context), nodes, chunks,
    press: (bind: string) => { const command = commands.find(c => c.bind === bind); expect(command).toBeDefined(); command!.run(); },
    dismiss: () => close?.() };
}
const preview = { title: 'Install skill? · Kit', message: 'Source: /skills\nTrusted — you added this source\nSkills: a, b (2)\nVersion: v1    Licence: MIT', yes: 'Yes, install', tone: 'success' as const };

describe('theme-aware custom dialog adapter', () => {
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
    const h = harness(); const pending = h.ui.dialog.select({ title: 'Installed', options: [{ title: 'Kept skill', value: 'kept', footer: '[enabled] [abandoned] · source removed' }] });
    expect(h.chunks().find(c => c.text === '[abandoned]')?.fg).toBe('theme-yellow');
    expect(h.chunks().find(c => c.text === ' · source removed')?.fg).toBe('theme-muted');
    h.press('escape'); await pending;
  });
  it('updates rows in place, preserving input, selected identity, action focus and scroll position', async () => {
    const h = harness(); const action = vi.fn();
    const pending = h.ui.dialog.select({ title: 'Installed', options: [
      { title: 'Kit alpha', value: 'a' }, { title: 'Kit beta', value: 'b' },
    ], actions: [{ bind: 'ctrl+r', title: 'Check updates', selection: 'none', onTrigger: action }] });
    const input = h.nodes().find(n => n.listeners.input)!;
    input.value = 'kit'; input.listeners.input(); h.press('down');
    const list = h.nodes().find(n => n.children.some(child => child.onMouseDown))!;
    list.scrollTop = 7;
    h.ui.updateSelect!({ title: 'Installed', hint: 'checked just now', options: [
      { title: 'Kit beta', value: 'b', footer: '[update available]' }, { title: 'Kit alpha', value: 'a' },
    ] });
    expect(h.nodes().find(n => n.listeners.input)).toBe(input);
    expect(input.value).toBe('kit');
    expect(list.scrollTop).toBe(7);
    expect(h.chunks().some(c => c.text === '› Kit beta')).toBe(true);
    expect(h.nodes().find(n => n.content === 'checked just now')?.fg).toBe('theme-muted');
    h.press('tab');
    h.ui.updateSelect!({ title: 'Installed', hint: 'checking…', options: [{ title: 'Kit beta', value: 'b' }] });
    h.press('return'); expect(action).toHaveBeenCalledOnce();
    h.press('shift+tab'); h.press('return'); expect(await pending).toBe('b');
    h.ui.updateSelect!({ title: 'Must not reopen', hint: '', options: [] });
    expect(h.nodes().some(n => n.content === 'Must not reopen')).toBe(false);
  });
  it('shows a loading row and muted failure badges', async () => {
    const h = harness(); const pending = h.ui.dialog.select({ title: 'Discover', options: [] });
    h.ui.updateSelect!({ title: 'Discover', hint: 'loading…', options: [] });
    expect(h.nodes().filter(n => n.content === 'loading…')).toHaveLength(2);
    h.ui.updateSelect!({ title: 'Installed', hint: 'check failed · see Errors', options: [{ title: 'Kit', value: 'kit', footer: '[update check failed]' }] });
    expect(h.chunks().find(c => c.text === '[update check failed]')?.fg).toBe('theme-muted');
    h.press('escape'); await pending;
  });
  it('renders only two stacked choices, read-only preview and No focused by default', async () => {
    const h = harness();
    const pending = h.ui.confirmation(preview);
    expect(h.chunks().map(c => c.text)).toEqual(['  [ Yes, install ]', '› [ No ]']);
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
  it.each(['up', 'down', 'tab', 'shift+tab'])('requires explicit navigation with %s before Enter authorizes', async key => {
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
    const pending = h.ui.dialog.select({ title: 'Installed', options: [
      { title: 'Kit', value: 'kit', footer: '[disabled] [update available] [overrides]' },
      { title: 'Other', value: 'other' },
    ], actions: [{ bind: 'ctrl+r', title: 'Update source', selection: 'none', onTrigger: action }] });
    expect(h.chunks().filter(c => c.text.startsWith('[')).map(c => c.fg)).toEqual(['theme-red', 'theme-yellow', 'theme-yellow']);
    h.press('ctrl+r'); expect(action).toHaveBeenCalledTimes(1);
    h.press('tab'); h.press('return'); expect(action).toHaveBeenCalledTimes(2);
    const input = h.nodes().find(n => n.listeners.input)!;
    input.value = 'other'; input.listeners.input(); h.press('return');
    expect(await pending).toBe('other');
  });
});
