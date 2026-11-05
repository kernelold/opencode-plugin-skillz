import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Source =
  | { type: 'md-url'; url: string }
  | { type: 'archive-url'; url: string; format: 'zip' | 'tar.gz' | 'tgz'; sha256?: string }
  | { type: 'http-folder'; url: string }
  | { type: 'git'; url: string; ref?: string; sha?: string; subpath?: string }
  | { type: 'local'; path: string }
  | { type: 'marketplace-url'; url: string };
export interface AuthReference { authEnv: string; header?: string; prefix?: string; query?: string }
export interface SourceOptions { skills?: string[]; auth?: AuthReference; version?: string; sha256?: string }
export interface Issue { code: string; message: string; path?: string; entry?: string }

export function assertNoInlineCredentials(input: string): void {
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(input)) return;
  const url = new URL(input);
  if (url.password || (/^https?:$/.test(url.protocol) && url.username)) throw new Error('Use an environment auth reference, not URL credentials');
  if ([...url.searchParams.keys()].some(k => /(?:key|token|secret|password|signature|credential|authorization)/i.test(k))) throw new Error('Use an environment auth reference for query credentials');
}

export function parseSource(input: string): Source {
  input = input.trim();
  if (!input) throw new Error('Source must not be empty');
  assertNoInlineCredentials(input);
  if (/^git@[^:]+:/.test(input) || /^(ssh|git):\/\//.test(input) || /\.git(?:#.*)?$/.test(input)) {
    const [url, fragment] = input.split('#');
    const [ref, ...subpath] = fragment?.split(':') ?? [];
    return { type: 'git', url, ...(ref ? { ref } : {}), ...(subpath.length ? { subpath: subpath.join(':') } : {}) };
  }
  if (input.startsWith('file://')) return { type: 'local', path: fileURLToPath(input) };
  if (/^https?:\/\//.test(input)) {
    const url = new URL(input);
    const github = url.hostname === 'github.com' && url.pathname.match(/^\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.*))?$/);
    if (github) return { type: 'git', url: `https://github.com/${github[1]}/${github[2]}.git`, ref: decodeURIComponent(github[3]), ...(github[4] ? { subpath: decodeURIComponent(github[4]) } : {}) };
    const pathname = url.pathname.toLowerCase();
    if (pathname.endsWith('/marketplace.json')) return { type: 'marketplace-url', url: url.href };
    if (pathname.endsWith('.md')) return { type: 'md-url', url: url.href };
    const format = pathname.endsWith('.tar.gz') ? 'tar.gz' : pathname.endsWith('.tgz') ? 'tgz' : pathname.endsWith('.zip') ? 'zip' : undefined;
    if (format) {
      if (url.hash.startsWith('#sha256=') && !/^#sha256=[a-fA-F0-9]{64}$/.test(url.hash)) throw new Error('sha256 must be 64 hex characters');
      const sha256 = url.hash.match(/^#sha256=([a-fA-F0-9]{64})$/)?.[1]?.toLowerCase();
      url.hash = '';
      return { type: 'archive-url', url: url.href, format, ...(sha256 ? { sha256 } : {}) };
    }
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    url.hash = '';
    return { type: 'http-folder', url: url.href };
  }
  return { type: 'local', path: path.resolve(input) };
}
export function sourceId(source: Source | string): string {
  const value = typeof source === 'string' ? parseSource(source) : source;
  const location = value.type === 'local' ? value.path : value.url;
  const slug = path.basename(location.replace(/\/$/, '').split(/[?#]/)[0]).replace(/\.git$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase().slice(0, 40) || 'source';
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
  return `${slug}-${createHash('sha256').update(canonical).digest('hex').slice(0, 12)}`;
}
// Pure predicate; discovery/fetch callers provide the paths they found.
export function hasMarketplace(paths: readonly string[]): boolean {
  return paths.some(p => p.replaceAll('\\', '/').replace(/^\.\//, '') === '.claude-plugin/marketplace.json');
}
