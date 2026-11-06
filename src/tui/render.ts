import type { Plugin } from '@opencode/plugin/tui';
import type { DialogSelectOptions, DialogSelectOption, DialogPromptOptions, KeymapCommand } from '@opencode/plugin/tui/context';
import { BoxRenderable, TextRenderable, InputRenderable, ScrollBoxRenderable, StyledText, fg, bold } from '@opentui/core';
import { createEffect, onCleanup } from 'solid-js';
import { actionTone, badgeTone, InstallChecklist, text, tabs, tabStrip, type Tone, type Confirmation } from './model.js';
import type { ManagerUI } from './controller.js';
import { dialogViewport, revealViewport, wrappedRows, fitChrome } from './viewport.js';
import { regions, RegionFocus, pageRow } from './navigation.js';

const plain = (command: KeymapCommand): KeymapCommand => ({ ...command, run: (input, event) => {
  if (event && (event.ctrl || event.meta || event.shift || event.option || event.super || event.hyper)) return;
  return command.run(input, event);
} });
// Named commands receive KeyEvent in 2.0.24; inline bindings do not.
const sectionKeys = (jump: (direction: number) => void): KeymapCommand[] => ['tab', 'shift+tab'].map(bind => ({ id: `skillz.section.${bind === 'tab' ? 'next' : 'previous'}`, bind, run: (_input, event) => {
  if (event && (event.ctrl || event.meta || event.option || event.super || event.hyper)) return;
  event?.preventDefault(); event?.stopPropagation();
  jump(bind === 'shift+tab' || event?.shift ? -1 : 1);
} }));

// OpenCode 2.0.24 hosts OpenTUI 0.5.14. A renderable is a supported Solid
// child: imperative OpenTUI components avoid shipping a second JSX runtime.
// Only this adapter knows about rendering; the controller remains RPC-only.
export function createManagerUI(context: Plugin.Context): ManagerUI {
  const { dialog } = context.ui;
  let updateSelect: ManagerUI['updateSelect'];
  let latestUpdate: Parameters<NonNullable<ManagerUI['updateSelect']>>[0] | undefined;
  const tabMemory = new Map<string, { query: string; selected: number; value: unknown; scrollTop: number }>();
  const color = (tone: Tone) => tone === 'base' ? context.theme.text.base : tone === 'muted'
    ? context.theme.text.muted : context.theme.text.feedback[tone].base;
  const lineTone = (line: string): Tone => line.startsWith('Trusted —') ? 'success'
    : line.startsWith('Not added by you') ? 'warning' : 'muted';
  const styled = (value: string, tone: Tone = 'muted') => new StyledText(value.split(/(\[[^\]]+\])/g).filter(Boolean).map(part =>
    fg(color(part.startsWith('[') ? badgeTone(part.slice(1, -1)) : tone))(part)));

  function choose<Value>(options: DialogSelectOptions<Value>, confirmation?: Confirmation, detailsOnly = false, removal = false, checklist?: InstallChecklist): Promise<Value | undefined> {
    updateSelect = undefined; latestUpdate = undefined;
    return new Promise(resolve => {
      let settled = false;
      let remember = () => {};
      const finish = (value?: Value) => {
        if (settled) return;
        settled = true;
        remember();
        resolve(value);
        dialog.clear();
      };
      dialog.show(() => {
        const renderer = context.renderer;
        const root = new BoxRenderable(renderer, { flexDirection: 'column', paddingX: 2, flexShrink: 0, overflow: 'hidden' });
        const title = new TextRenderable(renderer, { content: options.title, fg: color('base'), wrapMode: 'word', flexShrink: 0 });
        root.add(title);
        const status = new TextRenderable(renderer, { content: '', fg: color('muted'), wrapMode: 'word', height: 0, flexShrink: 0 });
        root.add(status);
        const contentWidth = () => Math.max(1, Math.min(109, renderer.width - 9));
        const wrappedHeight = (value: string) => wrappedRows(value, contentWidth());
        const scrollbar = { showArrows: true, trackOptions: { foregroundColor: color('muted'), backgroundColor: context.theme.background.raised.base } };
        const body = new ScrollBoxRenderable(renderer, { id: 'skillz-details', height: 0, flexShrink: 0, scrollY: true, verticalScrollbarOptions: scrollbar });
        if (confirmation) root.add(body);
        const detailLines: TextRenderable[] = [];
        if (confirmation) {
          for (const line of confirmation.message.split('\n')) {
            const node = new TextRenderable(renderer, { content: line, fg: color(lineTone(line)), wrapMode: 'word', flexShrink: 0 });
            detailLines.push(node); body.add(node);
          }
        }
        // The controller supplies both tab bindings. They apply from anywhere,
        // but are not duplicate footer buttons in the vertical focus sequence.
        const tabActions = (options.actions ?? []).filter(action => action.bind === 'left' || action.bind === 'right');
        const hasTabs = tabActions.length === 2;
        const tabKey = hasTabs ? tabs.find(tab => options.title.includes(`[${tab}]`)) : undefined;
        const saved = tabKey ? tabMemory.get(tabKey) : undefined;
        let query = saved?.query ?? '';
        let restoreSaved = !!saved;
        let selectionError = false;
        let statusHeight = 0;
        let selected = saved ? Math.max(0, options.options.findIndex(o => o.value === saved.value))
          : Math.max(0, options.options.findIndex(o => o.value === options.current));
        // -1 is list focus, -2 is the main-menu tab strip; nonnegative is an action.
        let actionFocus = -1;
        const focus = new RegionFocus();
        const order = () => regions(hasTabs, !!checklist, visible.length, actions.length);
        const focusIndex = () => actionFocus === -2 ? 0 : (hasTabs ? 1 : 0) + (actionFocus >= 0 ? visible.length + actionFocus : selected);
        const spaceAction = (options.actions ?? []).find(action => action.bind === 'space');
        const actions = checklist ? [
          { bind: 'a', title: 'Select all skills', selection: 'none' as const, onTrigger: () => { checklist.selectAll(true); draw(); } },
          { bind: 'n', title: 'Select no skills', selection: 'none' as const, onTrigger: () => { checklist.selectAll(false); draw(); } },
          ...(checklist.skills.some(skill => skill.category) ? [
            { bind: 'e', title: 'Expand all categories', selection: 'none' as const, onTrigger: () => fold(true, true) },
            { bind: 'c', title: 'Collapse all categories', selection: 'none' as const, onTrigger: () => fold(false, true) },
          ] : []),
        ] : (options.actions ?? []).filter(action => !hasTabs || !tabActions.includes(action));
        let visible: readonly DialogSelectOption<Value>[] = [];
        let revealSelection = true;
        let laidOutSelection = false;
        let initialScroll = saved?.scrollTop;
        let trackLayout = true;
        let lastGeometry = '';
        let emptyMessage = 'No items available';
        const list = new ScrollBoxRenderable(renderer, { id: 'skillz-list', height: 2, flexShrink: 0, scrollY: true, verticalScrollbarOptions: scrollbar,
          // Newly created rows have no Yoga positions until layout. Reveal the
          // focused row after layout, not while rebuilding the list. Only do it
          // after navigation/filtering so manual detail/list scrolling sticks.
          renderBefore: () => {
            const row = actionFocus === -1 ? list.getRenderable(`skillz-row-${selected}`) : undefined;
            if (!row || !list.viewport.height || !row.height) return;
            // Use content-relative coordinates, not scrollTop plus screen y:
            // screen translations can still reflect the previous frame.
            const start = row.y - list.content.y;
            // Wrapping and scrollbar bounds settle over successive Yoga passes
            // on resize; reveal again when geometry changes, not just once.
            const geometry = `${selected}:${start}:${row.height}:${list.viewport.height}:${list.viewport.width}:${list.content.height}`;
            const changed = geometry !== lastGeometry;
            lastGeometry = geometry;
            if (!revealSelection && !(trackLayout && changed)) return;
            revealSelection = false;
            if (initialScroll !== undefined) { list.scrollTop = initialScroll; initialScroll = undefined; }
            list.scrollTop = revealViewport(list.scrollTop, list.viewport.height, start, start + row.height);
            laidOutSelection = true;
          } });
        let search: InputRenderable | undefined;
        if (!confirmation) {
          search = new InputRenderable(renderer, { placeholder: options.placeholder ?? 'Search…', textColor: color('base'),
            value: query,
            focusedTextColor: color('base'), backgroundColor: context.theme.background.formfield.base,
            focusedBackgroundColor: context.theme.background.formfield.base });
          root.add(search);
          search.on('input', () => { query = search!.value; selected = 0; actionFocus = -1; draw(); });
        }
        const choices = new BoxRenderable(renderer, { id: 'skillz-choices', flexDirection: 'column', flexShrink: 0 });
        if (confirmation) root.add(choices);
        const spacer = new TextRenderable(renderer, { content: '', height: 1, flexShrink: 0 });
        const descriptionNode = new TextRenderable(renderer, { content: '', fg: color('muted'), wrapMode: 'word', flexShrink: 0 });
        if (checklist) { root.add(spacer); root.add(descriptionNode); }
        if (!confirmation || checklist) root.add(list);
        const footer = new BoxRenderable(renderer, { id: 'skillz-actions', flexDirection: 'column', flexShrink: 0 });
        root.add(footer);
        const hintsLabel = detailsOnly ? '↑/↓: scroll · Enter/Esc: back' : confirmation
          ? checklist ? `Tab: next section · Esc: cancel · ↑/↓${checklist.skills.some(skill => skill.category) ? ' · ←/→' : ''} · Space · Enter · Default: Yes`
            : removal ? '↑/↓: choose · Enter: confirm · Esc: cancel · Default: Cancel' : '↑/↓: choose · Enter: confirm · Esc: cancel · Default: No, cancel'
          : `Tab: next section · Esc: back · ↑/↓${hasTabs ? ' · ←/→: tabs' : ''}${spaceAction ? ' · Space' : ''} · Enter`;
        const hints = new TextRenderable(renderer, { content: hintsLabel, fg: color('muted'), wrapMode: 'word', flexShrink: 0 });
        root.add(hints);
        const clearChildren = (box: BoxRenderable) => { for (const child of [...box.getChildren()]) { box.remove(child); child.destroyRecursively(); } };
        const draw = () => {
          if (checklist?.selected.size && selectionError) { selectionError = false; status.content = ''; statusHeight = 0; status.height = 0; }
          const enabled = options.options.filter(o => !o.disabled);
          const checklistRows = checklist?.rows() ?? [];
          enabled.push(...checklistRows.map(row => ({ title: `${row.header ? row.expanded ? '▾ ' : '▸ ' : row.category ? '  ' : ''}[${row.state === 'all' ? 'x' : row.state === 'some' ? '-' : ' '}] ${text(row.title)}${row.header ? ` (${row.ids.filter(id => checklist!.selected.has(id)).length}/${row.ids.length})` : ''}`, value: undefined as Value })));
          visible = confirmation ? enabled : options.search ? options.search(query, enabled)
            : enabled.filter(o => `${o.title} ${o.description ?? ''} ${o.footer ?? ''}`.toLowerCase().includes(query.toLowerCase()));
          if (restoreSaved) {
            const index = visible.findIndex(o => o.value === saved!.value);
            selected = index >= 0 ? index : saved!.selected;
            restoreSaved = false;
          }
          if (hasTabs && !visible.length && actionFocus === -1) actionFocus = -2;
          const activeTab = hasTabs && options.title.startsWith('Skillz: ') ? tabs.find(tab => options.title.includes(`[${tab}]`)) : undefined;
          const marker = actionFocus === -2 ? contentWidth() >= 2 ? '› ' : '›' : '';
          const prefix = activeTab && contentWidth() < activeTab.length + 11 ? '' : 'Skillz: ';
          const titleLabel = marker + (activeTab ? prefix + tabStrip(activeTab, contentWidth() - prefix.length - marker.length) : options.title);
          title.content = titleLabel;
          title.bg = actionFocus === -2 ? context.theme.background.raised.high : context.theme.background.raised.base;
          selected = Math.max(0, Math.min(selected, visible.length - 1));
          focus.remember(order(), focusIndex());
          const description = checklist ? `The following skills will be installed${checklist.selected.size === checklist.skills.length ? '' : ` (${checklist.selected.size} of ${checklist.skills.length} selected)`}:` : '';
          const compact = renderer.height < 24 || renderer.width < 70;
          const hintText = compact && (checklist || hasTabs) ? `Tab: next section · Esc: ${checklist ? 'cancel' : 'back'} · Enter · ↑/↓ · ←/→${checklist || spaceAction ? ' · Space' : ''}` : hintsLabel;
          hints.content = hintText;
          const measure = (value: string) => compact ? 1 : wrappedHeight(value);
          const gap = renderer.height >= 32 ? 1 : 0;
          root.gap = gap;
          const wrapHints = !compact || hasTabs && renderer.height >= 10
            && wrappedHeight(hintText) <= Math.max(1, renderer.height - 7 - actions.length);
          const titleHeight = hasTabs ? 1 : measure(titleLabel), hintsHeight = wrapHints ? wrappedHeight(hintText) : 1;
          title.height = titleHeight; title.wrapMode = compact || hasTabs ? 'none' : 'word';
          hints.height = hintsHeight; hints.wrapMode = wrapHints ? 'word' : 'none';
          const descriptionHeight = checklist ? measure(description) : 0, spacerHeight = compact ? 0 : 1;
          descriptionNode.content = description; descriptionNode.height = descriptionHeight;
          descriptionNode.wrapMode = compact ? 'none' : 'word';
          spacer.height = spacerHeight;
          clearChildren(list); clearChildren(choices); clearChildren(footer);
          title.fg = color('base'); hints.fg = color('muted');
          detailLines.forEach((node, i) => { node.fg = color(lineTone(confirmation!.message.split('\n')[i])); });
          visible.forEach((option, i) => {
            const checkRow = checklistRows[i - 2];
            const tone = checkRow ? checkRow.state === 'all' ? 'success' : checkRow.state === 'some' ? 'warning' : 'error'
              : confirmation && option.value === true ? confirmation.tone : actionTone(option.title);
            const focused = selected === i && actionFocus === -1;
            const row = new BoxRenderable(renderer, { id: `skillz-row-${i}`, flexDirection: 'column', paddingX: 1, flexShrink: 0,
              // Migrated V1 themes deliberately make action.primary.selected
              // transparent. A raised surface keeps semantic text readable and
              // the focused row visibly highlighted in those themes too.
              backgroundColor: focused ? context.theme.background.raised.high : context.theme.background.raised.base,
              onMouseDown: () => { selected = i; actionFocus = -1; activate(); } });
            const label = `${focused ? '›' : ' '} ${confirmation && !checkRow ? `[ ${option.title} ]` : option.title}`;
            row.add(new TextRenderable(renderer, { content: new StyledText([bold(fg(color(tone))(label))]), wrapMode: confirmation && !checkRow && compact ? 'none' : 'word', flexShrink: 0 }));
            if (option.category) row.add(new TextRenderable(renderer, { content: option.category, fg: color('muted'), wrapMode: 'word' }));
            if (option.description) row.add(new TextRenderable(renderer, { content: option.description, fg: color('muted'), wrapMode: 'word' }));
            if (option.footer) row.add(new TextRenderable(renderer, { content: styled(option.footer, lineTone(option.footer)), wrapMode: 'word' }));
            (confirmation && !checkRow ? choices : list).add(row);
          });
          if (!visible.length) list.add(new TextRenderable(renderer, { content: query ? 'No matching items' : emptyMessage, fg: color('muted') }));
          const inlineActions = !!(compact && checklist) || hasTabs && renderer.height < 10;
          footer.flexDirection = inlineActions ? 'row' : 'column';
          footer.overflow = 'hidden';
          actions.forEach((action, i) => {
            const label = compact && checklist ? ['All', 'None', 'Expand', 'Collapse'][i] : action.title;
            footer.add(new TextRenderable(renderer, { fg: color(actionTone(action.title)),
              bg: actionFocus === i ? context.theme.background.raised.high : context.theme.background.raised.base,
              height: measure(`  [ ${label} ]`), content: `${actionFocus === i ? '›' : ' '} [ ${label} ]`, flexShrink: 0,
              ...(inlineActions && hasTabs ? { width: Math.max(1, Math.floor(contentWidth() / actions.length)), height: 1 } : {}),
              wrapMode: compact ? 'none' : 'word', onMouseDown: () => trigger(i) }));
          });
          const choiceHeight = confirmation ? enabled.slice(0, checklist ? 2 : enabled.length).reduce((n, o) => n + measure(`  [ ${o.title} ]`), 0) : 0;
          choices.height = choiceHeight;
          const footerHeight = inlineActions && actions.length ? 1 : actions.reduce((n, a) => n + measure(`  [ ${a.title} ]`), 0);
          footer.height = footerHeight;
          const chromeSizes = hasTabs ? fitChrome(renderer.height, [titleHeight, hintsHeight, footerHeight, search ? 1 : 0, statusHeight]) : undefined;
          if (chromeSizes) {
            title.height = chromeSizes[0]; hints.height = chromeSizes[1]; footer.height = chromeSizes[2];
            if (search) search.height = chromeSizes[3];
            status.height = chromeSizes[4]; status.wrapMode = 'none';
          }
          // Renderable.height is the last computed layout, not its requested
          // Yoga height. Budget with these values before the next layout pass.
          const chrome = chromeSizes ? chromeSizes.reduce((n, height) => n + height, 0)
            : titleHeight + statusHeight + footerHeight + hintsHeight + (search ? 1 : 0);
          const fixed = chrome + choiceHeight + (checklist ? spacerHeight + descriptionHeight : 0)
            + gap * Math.max(0, root.getChildren().length - 1);
          const rowHeight = (value: string) => wrappedRows(value, contentWidth() - 2);
          const listHeight = Math.max(1, visible.slice(checklist ? 2 : 0).reduce((n, o) => n + rowHeight(`› ${o.title}`) +
            (o.category ? rowHeight(o.category) : 0) + (o.description ? rowHeight(o.description) : 0) +
            (o.footer ? rowHeight(o.footer) : 0), 0));
          const layout = dialogViewport(renderer.height, fixed, confirmation
            ? checklist ? [wrappedHeight(confirmation.message), listHeight] : [wrappedHeight(confirmation.message)] : [listHeight]);
          if (confirmation) body.height = layout.sizes[0];
          list.height = confirmation ? checklist ? layout.sizes[1] : 0 : layout.sizes[0];
          root.height = layout.height;
          revealSelection = true; trackLayout = true;
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
          status.content = next.hint; statusHeight = next.hint ? 1 : 0; status.height = statusHeight;
          emptyMessage = next.hint.includes('loading…') ? 'loading…' : next.emptyMessage ?? 'No items available';
          draw();
          // A refresh can reorder rows while focus is in another section.
          if (index >= 0) focus.remember(order(), (hasTabs ? 1 : 0) + selected);
          // A background repaint must not reveal/re-focus a manually scrolled row.
          if (laidOutSelection) { revealSelection = false; trackLayout = false; list.scrollTop = scrollTop; }
        };
        if (!confirmation) updateSelect = update;
        const trigger = (i: number) => {
          const action = actions[i];
          if (action.selection === 'none') action.onTrigger();
          else if (visible[selected]) action.onTrigger(visible[selected].value);
        };
        const move = (delta: number) => {
          if (detailsOnly) { body.scrollBy(delta); return; }
          const offset = hasTabs ? 1 : 0;
          const count = offset + visible.length + actions.length;
          const current = actionFocus === -2 ? 0 : offset + (actionFocus >= 0 ? visible.length + actionFocus : selected);
          const index = (current + delta + count) % (count || 1);
          actionFocus = hasTabs && index === 0 ? -2 : index >= offset + visible.length && actions.length ? index - offset - visible.length : -1;
          if (actionFocus === -1) selected = index - offset;
          draw();
        };
        const jump = (direction: number) => {
          if (detailsOnly) return;
          const index = focus.jump(order(), focusIndex(), direction);
          const offset = hasTabs ? 1 : 0;
          actionFocus = hasTabs && index === 0 ? -2 : index >= offset + visible.length && actions.length ? index - offset - visible.length : -1;
          if (actionFocus === -1) selected = index - offset;
          draw();
        };
        const page = (key: 'pageup' | 'pagedown' | 'home' | 'end') => {
          if (detailsOnly || confirmation && !checklist) {
            if (key === 'pageup' || key === 'pagedown') body.scrollBy(key === 'pageup' ? -5 : 5);
            return;
          }
          const start = checklist ? 2 : 0;
          if (actionFocus !== -1 || selected < start || visible.length <= start) return;
          selected = key === 'home' ? start : key === 'end' ? visible.length - 1 : start + pageRow(
            visible.slice(start).map((_, i) => list.getRenderable(`skillz-row-${i + start}`)?.height ?? 1),
            selected - start, list.viewport.height, key === 'pageup' ? -1 : 1);
          draw();
        };
        const toggle = () => { const row = actionFocus === -1 ? checklist?.rows()[selected - 2] : undefined; if (row) { checklist!.toggle(row); draw(); } };
        const fold = (expanded?: boolean, all = false) => {
          const region = order().find(r => r.name === 'list');
          const index = region && (actionFocus !== -1 || selected < 2) ? focus.row(region) : selected;
          const row = checklist?.rows()[index - 2];
          if (!checklist || (!all && !row?.category)) return;
          if (all) checklist.expandAll(expanded!);
          else if (row!.header || expanded === false) checklist.setExpanded(row!.category!, expanded ?? !row!.expanded);
          // Preserve row identity across folds; a hidden child falls back to its header.
          if (row) {
            const rows = checklist.rows();
            const index = rows.findIndex(r => r.header === row.header && r.title === row.title && r.category === row.category);
            const restored = 2 + (index >= 0 ? index : rows.findIndex(r => r.header && r.category === row.category));
            focus.remember(regions(hasTabs, true, rows.length + 2, actions.length), restored);
            if (actionFocus === -1 && selected >= 2) selected = restored;
          }
          draw();
        };
        const horizontal = (expanded: boolean) => {
          if (actionFocus !== -1) return;
          const rows = checklist?.rows(); const row = rows?.[selected - 2];
          if (!row?.category) return;
          if (!expanded && !row.header) {
            selected = 2 + rows!.findIndex(r => r.header && r.category === row.category); draw();
          } else if (expanded && row.header && row.expanded) {
            move(1);
          } else if (row.header) fold(expanded);
        };
        const activate = () => {
          if (checklist && selected >= 2) { if (checklist.rows()[selected - 2]?.header) fold(); else toggle(); return; }
          if (checklist && visible[selected]?.value === true && !checklist.selected.size) {
            selectionError = true; status.content = 'Select at least one skill'; statusHeight = 1; status.height = 1; draw(); return;
          }
          if (visible[selected]) finish(visible[selected].value);
        };
        context.keymap.layer(() => ({ mode: 'global', priority: 1000, commands: [
          { bind: 'up', run: () => move(-1) }, { bind: 'down', run: () => move(1) },
          { bind: 'return', run: () => { if (actionFocus >= 0) trigger(actionFocus); else if (actionFocus !== -2) activate(); } },
          ...(checklist ? [
            { bind: 'space', run: toggle },
            { bind: 'left', run: () => horizontal(false) },
            { bind: 'right', run: () => horizontal(true) },
          ] : hasTabs ? tabActions.map(action => ({ bind: action.bind, run: () => { if (action.selection === 'none') action.onTrigger(); } })) : []),
          { bind: 'escape', run: () => finish() },
          ...(spaceAction ? [{ bind: 'space', run: () => { if (actionFocus === -1) trigger(actions.indexOf(spaceAction)); } }] : []),
          ...(['pageup', 'pagedown', 'home', 'end'] as const).map(key => ({ bind: key, run: () => page(key) })),
        ].map(plain).concat(sectionKeys(jump), actions.flatMap((action, i) => {
          if (action.bind === 'space') return [];
          const command = { bind: action.bind, run: () => trigger(i) };
          return action.bind.includes('+') ? command : plain(command);
        })) }));
        createEffect(draw);
        if (saved && hasTabs) {
          // Solid effects run after mounting; restore inside draw, not by
          // reading visible before that initial effect has run.
          draw();
        }
        remember = () => { if (hasTabs && tabKey) tabMemory.set(tabKey, { query, selected, value: visible[selected]?.value, scrollTop: list.scrollTop }); };
        renderer.on('resize', draw);
        if (!confirmation && latestUpdate) update(latestUpdate);
        if (search) search.focus(); else { root.focusable = true; root.focus(); }
        onCleanup(() => {
          renderer.off('resize', draw);
          if (updateSelect === update) updateSelect = undefined;
          for (const node of [root, body, list, choices, spacer, descriptionNode]) if (!node.isDestroyed) node.destroyRecursively();
        });
        return root;
      }, () => { if (!settled) { remember(); settled = true; resolve(undefined); } });
      dialog.set({ size: 'xlarge', centered: true });
    });
  }
  function prompt(options: DialogPromptOptions): Promise<string | undefined> {
    updateSelect = undefined; latestUpdate = undefined;
    return new Promise(resolve => {
      let settled = false;
      const finish = (value?: string) => { if (!settled) { settled = true; resolve(value); dialog.clear(); } };
      dialog.show(() => {
        const renderer = context.renderer;
        const root = new BoxRenderable(renderer, { flexDirection: 'column', paddingX: 2, flexShrink: 0, overflow: 'hidden' });
        root.add(new TextRenderable(renderer, { content: options.title, height: 1, fg: color('base'), wrapMode: 'none', flexShrink: 0 }));
        const description = new ScrollBoxRenderable(renderer, { height: 0, flexShrink: 0, scrollY: true, verticalScrollbarOptions: { showArrows: true } });
        if (options.description) {
          root.add(description);
          description.add(new TextRenderable(renderer, { content: options.description, fg: color('muted'), wrapMode: 'word', flexShrink: 0 }));
        }
        const input = new InputRenderable(context.renderer, { value: options.value ?? '', placeholder: options.placeholder,
          textColor: color('base'), focusedTextColor: color('base'), backgroundColor: context.theme.background.formfield.base,
          focusedBackgroundColor: context.theme.background.formfield.base });
        root.add(input);
        const buttons = new BoxRenderable(context.renderer, { flexDirection: 'row', gap: 2, height: 1, flexShrink: 0 }); root.add(buttons);
        // Input starts focused for typing; entering the button row defaults to Cancel.
        let button = -1;
        const hints = new TextRenderable(context.renderer, { content: '', height: 1, fg: color('muted'), wrapMode: 'none', flexShrink: 0 }); root.add(hints);
        const draw = () => {
          for (const child of [...buttons.getChildren()]) { buttons.remove(child); child.destroyRecursively(); }
          ['Continue', 'Cancel'].forEach((label, i) => buttons.add(new TextRenderable(context.renderer, {
            content: `${button === i ? '›' : ' '} [ ${label} ]`, fg: color(i ? 'error' : 'success'),
            bg: button === i ? context.theme.background.raised.high : context.theme.background.raised.base,
            onMouseDown: () => finish(i ? undefined : input.value) })));
          hints.content = `Tab: next section · Esc: cancel · ↑/↓ · ←/→ · Enter`;
          const gap = renderer.height >= 16 ? 1 : 0;
          root.gap = gap;
          const width = Math.max(1, Math.min(111, renderer.width - 6));
          const lines = options.description ? wrappedRows(options.description, width) : 0;
          const layout = dialogViewport(renderer.height, 4 + gap * (root.getChildren().length - 1), [lines]);
          root.height = layout.height; description.height = layout.sizes[0];
          if (button < 0) input.focus(); else { input.blur(); root.focusable = true; root.focus(); }
        };
        context.keymap.layer(() => ({ mode: 'global', priority: 1000, commands: [
          { bind: 'up', run: () => { button = button < 0 ? 1 : -1; draw(); } },
          { bind: 'down', run: () => { button = button < 0 ? 1 : -1; draw(); } },
          { bind: 'left', run: () => { if (button < 0) return false; button = (button + 1) % 2; draw(); } },
          { bind: 'right', run: () => { if (button < 0) return false; button = (button + 1) % 2; draw(); } },
          { bind: 'return', run: () => finish(button === 1 ? undefined : input.value) },
          { bind: 'escape', run: () => finish() },
          { bind: 'pageup', run: () => description.scrollBy(-5) },
          { bind: 'pagedown', run: () => description.scrollBy(5) },
        ].map(plain).concat(sectionKeys(() => { button = button < 0 ? 1 : -1; draw(); })) }));
        draw();
        renderer.on('resize', draw);
        onCleanup(() => { renderer.off('resize', draw); if (!root.isDestroyed) root.destroyRecursively(); if (!description.isDestroyed) description.destroyRecursively(); });
        return root;
      }, () => { if (!settled) { settled = true; resolve(undefined); } });
      dialog.set({ size: 'xlarge', centered: true });
    });
  }
  return {
    toast: context.ui.toast,
    installPreview: async options => {
      const checklist = new InstallChecklist(options.entry);
      const confirmed = await choose({ title: options.title, current: true, options: [
        { title: options.yes, value: true }, { title: 'No, cancel', value: false },
      ] }, options, false, false, checklist);
      return confirmed === true ? checklist.exclusions() : undefined;
    },
    removalChoice: async options => await choose<'remove' | 'keep' | undefined>({ title: options.title, current: undefined, options: [
      { title: `Remove source AND its ${options.count} installed skills`, value: 'remove' },
      { title: 'Remove source only — keep the skills (they become abandoned)', value: 'keep' },
      { title: 'Cancel', value: undefined },
    ] }, { ...options, yes: '', tone: 'error' }, false, true),
    updateSelect: options => { latestUpdate = options; updateSelect?.(options); },
    confirmation: async options => await choose({ title: options.title, current: false, options: [
      { title: options.yes, value: true }, { title: 'No, cancel', value: false },
    ] }, options) === true,
    dialog: {
      select: options => choose(options),
      // Detail-only screens share the scrollable read-only layout; no faux
      // selectable source/skill metadata in confirmations.
      alert: async options => { await choose({ title: options.title, options: [{ title: 'Back', value: false }] },
        { ...options, yes: 'Back', tone: 'info' }, true); },
      confirm: options => choose({ title: options.title, current: false, options: [
        { title: options.label?.confirm ?? 'Yes', value: true }, { title: options.label?.cancel ?? 'No, cancel', value: false },
      ] }, { ...options, yes: options.label?.confirm ?? 'Yes', tone: 'warning' }),
      prompt,
      clear: () => dialog.clear(), set: options => dialog.set(options), show: (render, onClose) => dialog.show(render, onClose),
    },
  };
}
