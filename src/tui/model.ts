import type { MethodOutput } from '../rpc.js';
import { isExcluded } from '../exclude.js';

export const tabs = ['Skills', 'Discover', 'Installed sources', 'Sources', 'Errors'] as const;
export type Tab = typeof tabs[number];
export type Source = MethodOutput<'listSources'>[number];
export type Available = MethodOutput<'listAvailable'>[number];
export type Installed = MethodOutput<'listInstalled'>[number];
export type Update = MethodOutput<'checkUpdates'>[number];
export interface Snapshot {
  sources: Source[];
  available: Available[];
  installed: Installed[];
  errors: MethodOutput<'listErrors'>;
  updates: Update[];
  checkedAt?: string | null;
  checking?: boolean;
  checkFailed?: boolean;
}
export const UPDATE_STALE_MS = 10 * 60 * 1000;
export function updateStatusStale(checkedAt?: string | null, now = Date.now()): boolean {
  const checked = checkedAt ? Date.parse(checkedAt) : NaN;
  return !Number.isFinite(checked) || now - checked >= UPDATE_STALE_MS;
}
export function checkedHint(checkedAt?: string | null, now = Date.now()): string {
  if (!checkedAt || !Number.isFinite(Date.parse(checkedAt))) return 'never checked';
  const minutes = Math.max(0, Math.floor((now - Date.parse(checkedAt)) / 60000));
  return minutes < 1 ? 'checked just now' : minutes < 60 ? `checked ${minutes}m ago`
    : minutes < 1440 ? `checked ${Math.floor(minutes / 60)}h ago` : `checked ${Math.floor(minutes / 1440)}d ago`;
}
export interface Row { title: string; value: string; description?: string; footer?: string; category?: string; searchText?: string }
export type Tone = 'base' | 'muted' | 'success' | 'warning' | 'error' | 'info';
export interface Confirmation { title: string; message: string; yes: string; tone: Tone }
export interface RemovalChoice { title: string; message: string; count: number }
export interface InstallPreview extends Confirmation { entry: Available }
export interface ChecklistRow { title: string; ids: string[]; category?: string; state: 'all' | 'some' | 'none'; header: boolean; expanded?: boolean }
export class InstallChecklist {
  readonly skills: NonNullable<Available['skillChoices']>;
  readonly selected: Set<string>;
  private readonly expanded = new Set<string>();
  private readonly exclude: string[];
  constructor(entry: Available) {
    this.skills = entry.skillChoices ?? (entry.skills ?? []).map(id => ({ id, name: id, excluded: isExcluded({ id, name: id }, entry.options.exclude) }));
    this.selected = new Set(this.skills.filter(s => !s.excluded).map(s => s.id));
    this.exclude = entry.options.exclude ?? [];
    const categories = new Set(this.skills.map(s => s.category).filter((s): s is string => !!s));
    if (categories.size === 1 && this.skills.length <= 8) for (const category of categories) this.expanded.add(category);
  }
  rows(): ChecklistRow[] {
    const categories = [...new Set(this.skills.map(s => s.category).filter((s): s is string => !!s))].sort();
    const state = (ids: string[]) => ids.every(id => this.selected.has(id)) ? 'all' : ids.some(id => this.selected.has(id)) ? 'some' : 'none';
    const skillRow = (s: typeof this.skills[number]): ChecklistRow => ({ title: s.id, ids: [s.id], category: s.category, state: state([s.id]), header: false });
    return [...this.skills.filter(s => !s.category).map(skillRow), ...categories.flatMap(category => {
      const skills = this.skills.filter(s => s.category === category); const ids = skills.map(s => s.id);
      return [{ title: category, ids, category, state: state(ids), header: true, expanded: this.expanded.has(category) } as ChecklistRow,
        ...(this.expanded.has(category) ? skills.map(skillRow) : [])];
    })];
  }
  setExpanded(category: string, expanded: boolean): void { if (expanded) this.expanded.add(category); else this.expanded.delete(category); }
  expandAll(expanded: boolean): void { for (const s of this.skills) if (s.category) this.setExpanded(s.category, expanded); }
  toggle(row: ChecklistRow): void {
    const remove = row.ids.every(id => this.selected.has(id));
    for (const id of row.ids) { if (remove) this.selected.delete(id); else this.selected.add(id); }
  }
  selectAll(selected: boolean): void { this.selected.clear(); if (selected) for (const s of this.skills) this.selected.add(s.id); }
  exclusions(): string[] {
    const groups = [...new Set(this.skills.map(s => s.category).filter((s): s is string => !!s))];
    const excludedGroups = groups.filter(category => this.skills.filter(s => s.category === category || s.category?.startsWith(`${category}/`)).every(s => !this.selected.has(s.id)));
    const patterns = this.exclude.filter(entry => !this.skills.some(s => this.selected.has(s.id) && isExcluded(s, [entry])));
    for (const category of excludedGroups) if (!excludedGroups.some(parent => category.startsWith(`${parent}/`))) patterns.push(`${category}/`);
    return [...new Set([...patterns, ...this.skills.filter(s => !this.selected.has(s.id) && !isExcluded(s, patterns)).map(s => s.id)])];
  }
}
// Presentation only: provenance is already persisted as parentId. No trust flag,
// execution permission or new trust-management state is introduced.
export function sourceTrust(source: Source, sources: readonly Source[] = []): { label: string; tone: Tone } {
  // Compare raw source identity (including type/pins), never sanitized display
  // text: two distinct locations must not acquire trust by rendering alike.
  const identity = (s: Source) => JSON.stringify(Object.entries(s.source).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)));
  const explicitlyAdded = !source.parentId || sources.some(s => !s.parentId && identity(s) === identity(source));
  if (explicitlyAdded) return { label: 'Trusted — you added this source', tone: 'success' };
  const parent = sources.find(s => s.id === source.parentId);
  return { label: `Not added by you — from marketplace ${parent ? sourceName(parent) : text(source.parentId!)}`, tone: 'warning' };
}
export function installConfirmation(entry: Available, sources: readonly Source[]): Confirmation {
  return { title: `Install skill? · ${sourceName(entry)}`, yes: 'Yes, install', tone: 'success',
    message: [ `Source: ${sourceLocation(entry)}`, sourceTrust(entry, sources).label,
      `Skills: ${entry.skills?.map(text).join(', ') || 'none found'} (${entry.skills?.length ?? 0})`,
      `Version: ${version(entry.version)}    Licence: ${text(entry.license ?? 'not declared')}`,
      ...(entry.description ? [text(entry.description)] : []), 'Nothing is executed during install.' ].join('\n') };
}
export function actionTone(title: string): Tone {
  if (/^Remove source only/.test(title)) return 'warning';
  if (/^(No(?:$|,)|Remove|Disable)/i.test(title)) return 'error';
  if (/^(Yes|Enable|Install|Inspect \/ install|Add|Marketplace|Direct source)/i.test(title)) return 'success';
  if (/^(Update|Refresh|Clear)/i.test(title)) return 'warning';
  return 'info';
}
export function badgeTone(badge: string): Tone {
  if (/check failed|checking/.test(badge)) return 'muted';
  if (/^(enabled|up to date)$/.test(badge)) return 'success';
  if (/^(disabled)$/.test(badge)) return 'error';
  if (/update available|failed|override|abandoned/.test(badge)) return 'warning';
  return 'muted';
}
export function nextTab(tab: Tab, direction: number): Tab {
  return tabs[(tabs.indexOf(tab) + direction % tabs.length + tabs.length) % tabs.length];
}
export function tabStrip(tab: Tab, columns = Infinity): string {
  const labels = tabs.map(t => t === tab ? `[${t}]` : t);
  const full = labels.join(' · ');
  if (full.length <= columns) return full;
  let start = tabs.indexOf(tab), end = start + 1;
  const window = () => `${start ? '‹ · ' : ''}${labels.slice(start, end).join(' · ')}${end < tabs.length ? ' · ›' : ''}`;
  // Keep the active label intact and show neighbours only when they fit.
  while (start > 0 || end < tabs.length) {
    if (start > 0) { start--; if (window().length <= columns) continue; start++; }
    if (end < tabs.length) { end++; if (window().length <= columns) continue; end--; }
    break;
  }
  if (window().length <= columns) return window();
  const active = `[${tab}]`;
  const width = Math.max(0, Math.floor(columns));
  return active.length <= width ? active : width >= 3 ? `[${tab.slice(0, width - 3)}…]` : active.slice(0, width);
}
// Render terminal control characters as spaces; upstream metadata is untrusted.
export function text(value: string): string { return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '); }
export function sourceLocation(record: Source): string {
  const s = record.source;
  if (s.type === 'local') return text(s.path);
  return text(s.url + (s.type === 'git' ? `${s.sha || s.ref ? `#${s.sha ?? s.ref}` : ''}${s.subpath ? ` (${s.subpath})` : ''}` : ''));
}
export function sourceName(record: Source): string {
  if (record.name) return text(record.name);
  const s = record.source;
  let location = s.type === 'local' ? s.path : s.url;
  try { const url = new URL(location); location = url.pathname.replace(/\/$/, '') || url.hostname; } catch { /* Local or SCP-style path. */ }
  return text(location.replace(/\/$/, '').split(/[/\\]/).at(-1) || location);
}
export function version(value?: string): string { return value ? text(value) : 'unknown'; }
export function badges(installed: Installed, update?: Update): string[] {
  return [installed.enabled ? 'enabled' : 'disabled',
    ...(installed.abandoned ? ['abandoned'] : update?.issues.length ? ['update check failed'] : update?.updateAvailable ? ['update available'] : update ? ['up to date'] : ['update not checked']),
    ...(installed.overrides.length ? ['overrides'] : [])];
}
export function filterRows<T extends Row>(query: string, rows: readonly T[]): T[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return rows.filter(r => terms.every(t => `${r.title} ${r.description ?? ''} ${r.footer ?? ''} ${r.category ?? ''} ${r.searchText ?? ''}`.toLowerCase().includes(t)));
}
export function entryDetails(entry: Available): string {
  return [`Source: ${sourceLocation(entry)}`, `Skills: ${entry.skills?.map(text).join(', ') || 'none found'}`,
    ...(entry.options.exclude?.length ? [`Excluded: ${entry.options.exclude.map(text).join(', ')}`] : []),
    `Version: ${version(entry.version)}`, `Licence: ${text(entry.license ?? 'not declared')}`,
    ...(entry.description ? [text(entry.description)] : [])].join('\n');
}
export function installedDetails(item: Installed, source?: Source, update?: Update): string {
  source ??= item.formerSource ?? item.upstream;
  return [source ? `Source: ${sourceLocation(source)}` : `Source ID: ${text(item.sourceId)}`,
    `Version: ${version(item.version)}`, `Status: ${badges(item, update).join(' · ')}`, ...(item.abandoned ? ['source removed · no updates; re-add the same source to re-adopt'] : []), `Scope: ${item.scope}`,
    'Skills:', ...item.skills.map(s => `  ${text(s.id)}${item.disabledSkills?.includes(s.id) ? ' [disabled]' : ''} — ${text(s.description)}`),
    ...item.overrides.map(origin => text(origin)),
    ...(update?.updateAvailable ? [`Available version: ${version(update.availableVersion)}`] : []),
    ...(update?.issues.map(i => text(i.message)) ?? [])].join('\n');
}
export function skillValue(sourceId: string, skillId: string): string { return JSON.stringify([sourceId, skillId]); }
export function defaultTab(state: Snapshot): Tab { return rowsFor('Skills', state).length ? 'Skills' : 'Discover'; }
export function emptyHint(tab: Tab): string {
  return tab === 'Skills' ? 'No installed skills. Find skills in Discover or add a source in Sources.'
    : tab === 'Installed sources' ? 'No installed source entries. Install skills from an entry in Discover.'
      : tab === 'Sources' ? 'No configured marketplaces or direct sources. Add a source to discover skills.' : 'No items available';
}
export function skillBadges(item: Installed, skillId: string, update?: Update): string[] {
  return [item.enabled && !item.disabledSkills?.includes(skillId) ? 'enabled' : 'disabled',
    ...(!item.enabled ? ['source disabled'] : []), ...badges(item, update).slice(1)];
}
export function skillDetails(item: Installed, skill: Installed['skills'][number], source?: Source, update?: Update): string {
  source ??= item.formerSource ?? item.upstream;
  return [`Skill: ${text(skill.name || skill.id)} (${text(skill.id)})`, text(skill.description),
    ...(skill.category ? [`Category: ${text(skill.category)}`] : []), `Path: ${text(skill.skillFile)}`,
    `Entry: ${text(item.sourceId)}`, ...(source ? [`Source: ${sourceName(source)}`, sourceLocation(source)] : []),
    `Status: ${skillBadges(item, skill.id, update).join(' · ')}`, `Version: ${version(item.version)}`,
    ...(!item.enabled ? ['Source disabled: enabling this skill alone does not enable the source.'] : []),
    ...(item.abandoned ? ['Source removed · no updates; re-add the same source to re-adopt.'] : []),
    ...(update?.updateAvailable && !item.abandoned ? [`Available version: ${version(update.availableVersion)}`] : [])].join('\n');
}
export function rowsFor(tab: Tab, state: Snapshot): Row[] {
  const names = new Map(state.sources.map(s => [s.id, sourceName(s)]));
  switch (tab) {
    case 'Skills': return state.installed.flatMap(item => {
      const source = state.sources.find(s => s.id === item.sourceId) ?? item.formerSource ?? item.upstream;
      const update = state.updates.find(u => u.sourceId === item.sourceId);
      return item.skills.filter(skill => !item.excludedSkills?.includes(skill.id)).map(skill => ({
        title: text(skill.name || skill.id), value: skillValue(item.sourceId, skill.id),
        description: skill.description ? text(skill.description).split(/(?<=[.!?])\s/)[0].slice(0, 160) : undefined,
        footer: `${source ? sourceName(source) : text(item.sourceId)} · ${text(item.sourceId)}${skill.category ? ` · ${text(skill.category)}` : ''} · [${skillBadges(item, skill.id, update).join('] [')}]`,
        searchText: skillDetails(item, skill, source, update),
      }));
    }).sort((a, b) => a.title.localeCompare(b.title) || a.value.localeCompare(b.value));
    case 'Discover': return state.available.map(s => ({ title: sourceName(s), value: s.id,
      category: s.parentId ? names.get(s.parentId) ?? 'Marketplace' : 'Direct sources',
      description: text(s.description ?? s.skills?.join(', ') ?? 'Enter to inspect skills'),
      footer: `Version: ${version(s.version)} · Licence: ${text(s.license ?? 'not declared')}`,
      searchText: `${sourceLocation(s)} ${s.skills?.map(text).join(' ') ?? ''}` }));
    case 'Installed sources': return state.installed.map(s => ({ title: names.get(s.sourceId) ?? (s.formerSource ? sourceName(s.formerSource) : text(s.sourceId)), value: s.sourceId,
      description: s.skills.map(k => text(k.id)).join(', '),
      footer: `[${badges(s, state.updates.find(u => u.sourceId === s.sourceId)).join('] [')}] · ${s.abandoned ? 'source removed' : checkedHint(state.checkedAt)}${!s.abandoned && state.checking ? ' · checking…' : !s.abandoned && state.checkFailed ? ' · [check failed]' : ''}`,
      searchText: installedDetails(s, state.sources.find(r => r.id === s.sourceId), state.updates.find(u => u.sourceId === s.sourceId)) }));
    case 'Sources': return state.sources.map(s => ({ title: sourceName(s), value: s.id,
      category: s.catalog || s.source.type === 'marketplace-url' ? 'Marketplaces' : s.parentId ? 'Marketplace entries' : 'Direct sources',
      description: sourceLocation(s), footer: `${sourceTrust(s, state.sources).label} · ${s.options.auth ? `Auth env: ${text(s.options.auth.authEnv)}` : 'Public / existing git credentials'}` }));
    case 'Errors': return [...state.errors].reverse().map(e => ({ title: `[${text(e.code)}] ${text(e.message)}`, value: e.id,
      description: text(e.created), footer: [e.sourceId, e.entry, e.path].filter(Boolean).map(s => text(s!)).join(' · ') }));
  }
}
