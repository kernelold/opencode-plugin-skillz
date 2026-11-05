import type { Plugin } from '@opencode/plugin/tui';
import type { DialogSelectOptions, DialogSelectOption } from '@opencode/plugin/tui/context';
import { BoxRenderable, TextRenderable, InputRenderable, ScrollBoxRenderable, StyledText, fg, bold } from '@opentui/core';
import { createEffect, onCleanup } from 'solid-js';
import { actionTone, badgeTone, type Tone, type Confirmation } from './model.js';
import type { ManagerUI } from './controller.js';

// OpenCode 2.0.24 hosts OpenTUI 0.5.14. A renderable is a supported Solid
// child: imperative OpenTUI components avoid shipping a second JSX runtime.
// Only this adapter knows about rendering; the controller remains RPC-only.
export function createManagerUI(context: Plugin.Context): ManagerUI {
  const { dialog } = context.ui;
  let updateSelect: ManagerUI['updateSelect'];
  let latestUpdate: Parameters<NonNullable<ManagerUI['updateSelect']>>[0] | undefined;
  const color = (tone: Tone) => tone === 'base' ? context.theme.text.base : tone === 'muted'
    ? context.theme.text.muted : context.theme.text.feedback[tone].base;
  const lineTone = (line: string): Tone => line.startsWith('Trusted —') ? 'success'
    : line.startsWith('Not added by you') ? 'warning' : 'muted';
  const styled = (value: string, tone: Tone = 'muted') => new StyledText(value.split(/(\[[^\]]+\])/g).filter(Boolean).map(part =>
    fg(color(part.startsWith('[') ? badgeTone(part.slice(1, -1)) : tone))(part)));

  function choose<Value>(options: DialogSelectOptions<Value>, confirmation?: Confirmation, detailsOnly = false, removal = false): Promise<Value | undefined> {
    updateSelect = undefined; latestUpdate = undefined;
    return new Promise(resolve => {
      let settled = false;
      const finish = (value?: Value) => {
        if (settled) return;
        settled = true;
        resolve(value);
        dialog.clear();
      };
      dialog.show(() => {
        const renderer = context.renderer;
        const root = new BoxRenderable(renderer, { flexDirection: 'column', paddingX: 2, paddingBottom: 1, gap: 1 });
        const title = new TextRenderable(renderer, { content: options.title, fg: color('base'), wrapMode: 'word' });
        root.add(title);
        const status = new TextRenderable(renderer, { content: '', fg: color('muted'), wrapMode: 'word', height: 0 });
        root.add(status);
        const contentWidth = Math.max(20, Math.min(110, renderer.width - 12));
        const wrappedHeight = (value: string) => value.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / contentWidth)), 0);
        const body = new ScrollBoxRenderable(renderer, { height: confirmation
          ? Math.min(wrappedHeight(confirmation.message), Math.max(3, renderer.height - 22)) : 0, flexShrink: 0, scrollY: true });
        if (confirmation) root.add(body);
        const detailLines: TextRenderable[] = [];
        if (confirmation) {
          for (const line of confirmation.message.split('\n')) {
            const node = new TextRenderable(renderer, { content: line, fg: color(lineTone(line)), wrapMode: 'word', flexShrink: 0 });
            detailLines.push(node); body.add(node);
          }
        }
        let query = '';
        let selected = Math.max(0, options.options.findIndex(o => o.value === options.current));
        let actionFocus = -1;
        const actions = options.actions ?? [];
        let visible: readonly DialogSelectOption<Value>[] = [];
        let revealSelection = true;
        let emptyMessage = 'No items available';
        const list = new ScrollBoxRenderable(renderer, { height: 2, flexShrink: 0, scrollY: true,
          // Newly created rows have no Yoga positions until layout. Reveal the
          // focused row after layout, not while rebuilding the list. Only do it
          // after navigation/filtering so manual detail/list scrolling sticks.
          renderBefore: () => { if (revealSelection) { revealSelection = false; list.scrollChildIntoView(`skillz-row-${selected}`); } } });
        let search: InputRenderable | undefined;
        if (!confirmation) {
          search = new InputRenderable(renderer, { placeholder: options.placeholder ?? 'Search…', textColor: color('base'),
            focusedTextColor: color('base'), backgroundColor: context.theme.background.formfield.base,
            focusedBackgroundColor: context.theme.background.formfield.base });
          root.add(search);
          search.on('input', () => { query = search!.value; selected = 0; actionFocus = -1; draw(); });
        }
        root.add(list);
        const footer = new BoxRenderable(renderer, { flexDirection: 'row', flexWrap: 'wrap', gap: 1 });
        root.add(footer);
        const hints = new TextRenderable(renderer, { content: detailsOnly ? 'PgUp/PgDn or mouse wheel: scroll · Enter/Esc: back' : confirmation
          ? removal ? '↑/↓ or Tab: choose · Enter: confirm · Esc: cancel · Default: Cancel' : '↑/↓ or Tab: choose · Enter: confirm · Esc: No · Default: No'
          : '↑/↓: select · Enter: open · Type: filter · Tab: actions · Esc: back', fg: color('muted'), wrapMode: 'word' });
        root.add(hints);
        const clearChildren = (box: BoxRenderable) => { for (const child of [...box.getChildren()]) { box.remove(child); child.destroyRecursively(); } };
        const draw = () => {
          title.content = options.title;
          const enabled = options.options.filter(o => !o.disabled);
          visible = confirmation ? enabled : options.search ? options.search(query, enabled)
            : enabled.filter(o => `${o.title} ${o.description ?? ''} ${o.footer ?? ''}`.toLowerCase().includes(query.toLowerCase()));
          selected = Math.max(0, Math.min(selected, visible.length - 1));
          list.height = Math.min(Math.max(1, visible.reduce((n, o) => n + wrappedHeight(o.title) +
            (o.category ? wrappedHeight(o.category) : 0) + (o.description ? wrappedHeight(o.description) : 0) +
            (o.footer ? wrappedHeight(o.footer) : 0), 0)), Math.max(3, Math.min(20, renderer.height - 18)));
          clearChildren(list); clearChildren(footer);
          title.fg = color('base'); hints.fg = color('muted');
          detailLines.forEach((node, i) => { node.fg = color(lineTone(confirmation!.message.split('\n')[i])); });
          visible.forEach((option, i) => {
            const tone = confirmation && option.value === true ? confirmation.tone : actionTone(option.title);
            const focused = selected === i && actionFocus === -1;
            const row = new BoxRenderable(renderer, { id: `skillz-row-${i}`, flexDirection: 'column', paddingX: 1, flexShrink: 0,
              // Migrated V1 themes deliberately make action.primary.selected
              // transparent. A raised surface keeps semantic text readable and
              // the focused row visibly highlighted in those themes too.
              backgroundColor: focused ? context.theme.background.raised.high : context.theme.background.raised.base,
              onMouseDown: () => { selected = i; finish(option.value); } });
            const label = `${focused ? '›' : ' '} ${confirmation ? `[ ${option.title} ]` : option.title}`;
            row.add(new TextRenderable(renderer, { content: new StyledText([bold(fg(color(tone))(label))]), wrapMode: 'word' }));
            if (option.category) row.add(new TextRenderable(renderer, { content: option.category, fg: color('muted'), wrapMode: 'word' }));
            if (option.description) row.add(new TextRenderable(renderer, { content: option.description, fg: color('muted'), wrapMode: 'word' }));
            if (option.footer) row.add(new TextRenderable(renderer, { content: styled(option.footer, lineTone(option.footer)), wrapMode: 'word' }));
            list.add(row);
          });
          if (!visible.length) list.add(new TextRenderable(renderer, { content: emptyMessage, fg: color('muted') }));
          actions.forEach((action, i) => {
            footer.add(new TextRenderable(renderer, { content: `[ ${action.bind} ${action.title} ]`, fg: color(actionTone(action.title)),
              bg: actionFocus === i ? context.theme.background.raised.high : context.theme.background.raised.base,
              wrapMode: 'word', onMouseDown: () => trigger(i) }));
          });
          revealSelection = true;
        };
        const update: NonNullable<ManagerUI['updateSelect']> = next => {
          if (settled || root.isDestroyed) return;
          const value = visible[selected]?.value;
          const scrollTop = list.scrollTop;
          options = { ...options, title: next.title, options: next.options as unknown as DialogSelectOption<Value>[] };
          const enabled = options.options.filter(o => !o.disabled);
          const filtered = options.search ? options.search(query, enabled) : enabled.filter(o => `${o.title} ${o.description ?? ''} ${o.footer ?? ''}`.toLowerCase().includes(query.toLowerCase()));
          const index = filtered.findIndex(o => o.value === value);
          if (index >= 0) selected = index;
          status.content = next.hint; status.height = next.hint ? 1 : 0;
          emptyMessage = next.hint.includes('loading…') ? 'loading…' : 'No items available';
          draw();
          // A background repaint must not reveal/re-focus a manually scrolled row.
          revealSelection = false; list.scrollTop = scrollTop;
        };
        if (!confirmation) updateSelect = update;
        const trigger = (i: number) => {
          const action = actions[i];
          if (action.selection === 'none') action.onTrigger();
          else if (visible[selected]) action.onTrigger(visible[selected].value);
        };
        const move = (delta: number) => { actionFocus = -1; selected = (selected + delta + visible.length) % (visible.length || 1); draw(); };
        context.keymap.layer(() => ({ mode: 'global', priority: 1000, commands: [
          { bind: 'up', run: () => move(-1) }, { bind: 'down', run: () => move(1) },
          { bind: 'ctrl+p', run: () => move(-1) }, { bind: 'ctrl+n', run: () => move(1) },
          { bind: 'tab', run: () => { if (confirmation) move(1); else { actionFocus = (actionFocus + 2) % (actions.length + 1) - 1; draw(); } } },
          { bind: 'shift+tab', run: () => { if (confirmation) move(-1); else { actionFocus = (actionFocus + actions.length + 1) % (actions.length + 1) - 1; draw(); } } },
          { bind: 'return', run: () => { if (actionFocus >= 0) trigger(actionFocus); else if (visible[selected]) finish(visible[selected].value); } },
          { bind: 'escape', run: () => finish() },
          { bind: 'pageup', run: () => { body.scrollBy(-5); list.scrollBy(-5); } },
          { bind: 'pagedown', run: () => { body.scrollBy(5); list.scrollBy(5); } },
          ...actions.map((action, i) => ({ bind: action.bind, run: () => trigger(i) })),
        ] }));
        createEffect(draw);
        if (!confirmation && latestUpdate) update(latestUpdate);
        if (search) search.focus(); else { root.focusable = true; root.focus(); }
        onCleanup(() => { if (updateSelect === update) updateSelect = undefined; if (!root.isDestroyed) root.destroyRecursively(); if (!body.isDestroyed) body.destroyRecursively(); });
        return root;
      }, () => { if (!settled) { settled = true; resolve(undefined); } });
      dialog.set({ size: 'xlarge' });
    });
  }
  return {
    toast: context.ui.toast,
    removalChoice: async options => await choose<'remove' | 'keep' | undefined>({ title: options.title, current: undefined, options: [
      { title: `Remove source AND its ${options.count} installed skills`, value: 'remove' },
      { title: 'Remove source only — keep the skills (they become abandoned)', value: 'keep' },
      { title: 'Cancel', value: undefined },
    ] }, { ...options, yes: '', tone: 'error' }, false, true),
    updateSelect: options => { latestUpdate = options; updateSelect?.(options); },
    confirmation: async options => await choose({ title: options.title, current: false, options: [
      { title: options.yes, value: true }, { title: 'No', value: false },
    ] }, options) === true,
    dialog: {
      select: options => choose(options),
      // Detail-only screens share the scrollable read-only layout; no faux
      // selectable source/skill metadata in confirmations.
      alert: async options => { await choose({ title: options.title, options: [{ title: 'Back', value: false }] },
        { ...options, yes: 'Back', tone: 'info' }, true); },
      confirm: options => choose({ title: options.title, current: false, options: [
        { title: options.label?.confirm ?? 'Yes', value: true }, { title: options.label?.cancel ?? 'No', value: false },
      ] }, { ...options, yes: options.label?.confirm ?? 'Yes', tone: 'warning' }),
      prompt: options => dialog.prompt(options),
      clear: () => dialog.clear(), set: options => dialog.set(options), show: (render, onClose) => dialog.show(render, onClose),
    },
  };
}
