import type { MethodOutput } from '../rpc.js';

export const tabs = ['Discover', 'Installed', 'Sources', 'Errors'] as const;
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
  if (/^(No$|Remove|Disable)/i.test(title)) return 'error';
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
export function tabStrip(tab: Tab): string {
  return tabs.map(t => t === tab ? `[${t}]` : t).join(' · ');
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
export function rowsFor(tab: Tab, state: Snapshot): Row[] {
  const names = new Map(state.sources.map(s => [s.id, sourceName(s)]));
  switch (tab) {
    case 'Discover': return state.available.map(s => ({ title: sourceName(s), value: s.id,
      category: s.parentId ? names.get(s.parentId) ?? 'Marketplace' : 'Direct sources',
      description: text(s.description ?? s.skills?.join(', ') ?? 'Enter to inspect skills'),
      footer: `Version: ${version(s.version)} · Licence: ${text(s.license ?? 'not declared')}`,
      searchText: `${sourceLocation(s)} ${s.skills?.map(text).join(' ') ?? ''}` }));
    case 'Installed': return state.installed.map(s => ({ title: names.get(s.sourceId) ?? (s.formerSource ? sourceName(s.formerSource) : text(s.sourceId)), value: s.sourceId,
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
