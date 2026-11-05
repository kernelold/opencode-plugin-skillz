import path from 'node:path';
import { safeJoin } from './security.js';
import { assertNoInlineCredentials, parseSource, type Issue, type Source } from './source.js';

export interface MarketplaceEntry { name: string; source: Source; skills?: string[]; version?: string; description?: string; manifest: Record<string, unknown> }
export interface Marketplace { name: string; owner: { name: string }; entries: MarketplaceEntry[]; issues: Issue[]; manifest: Record<string, unknown> }
export type MarketplaceContext = { rootDir: string } | { url: string };
export function parseMarketplace(input: string | unknown, context: MarketplaceContext): Marketplace {
  const raw: unknown = typeof input === 'string' ? JSON.parse(input) : input;
  if (!raw || typeof raw !== 'object') throw new Error('Invalid marketplace');
  const manifest = raw as Record<string, unknown>;
  const owner = manifest.owner as { name?: unknown } | undefined;
  if (typeof manifest.name !== 'string' || typeof owner?.name !== 'string' || !Array.isArray(manifest.plugins)) throw new Error('Marketplace requires name, owner.name and plugins[]');
  const result: Marketplace = { name: manifest.name, owner: { name: owner.name }, entries: [], issues: [], manifest };
  for (const rawEntry of manifest.plugins) {
    const entry = rawEntry as Record<string, unknown>;
    try {
      if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) throw new Error('Entry requires a name');
      for (const component of ['commands', 'agents', 'hooks', 'mcpServers', 'lspServers', 'outputStyles']) {
        if (entry[component] !== undefined) result.issues.push({ code: 'unsupported-component', message: `${component} is not supported`, entry: entry.name });
      }
      let source: Source;
      if (typeof entry.source === 'string') {
        if (!('rootDir' in context)) throw new Error('A URL marketplace cannot resolve relative paths');
        source = { type: 'local', path: safeJoin(path.resolve(context.rootDir), entry.source) };
      } else {
        const s = entry.source as Record<string, unknown> | undefined;
        if (!s || typeof s.source !== 'string') throw new Error('Entry requires a supported source');
        if (s.sha !== undefined && (typeof s.sha !== 'string' || !/^[a-f0-9]{40}$/.test(s.sha))) throw new Error('sha must be 40 lowercase hex characters');
        if (s.ref !== undefined && typeof s.ref !== 'string') throw new Error('ref must be a string');
        if (s.source === 'archive') {
          if (typeof s.url !== 'string') throw new Error('archive requires url');
          source = parseSource(s.url);
          if (source.type !== 'archive-url') throw new Error('Archive URL must end in .zip, .tar.gz or .tgz');
          if (s.sha256 !== undefined) {
            if (typeof s.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(s.sha256)) throw new Error('sha256 must be 64 hex characters');
            source.sha256 = s.sha256.toLowerCase();
          }
        } else if (['github', 'url', 'git-subdir'].includes(s.source)) {
          const url = s.source === 'github' ? typeof s.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(s.repo) ? `https://github.com/${s.repo}.git` : undefined : s.url;
          if (typeof url !== 'string') throw new Error('Git source requires a valid repo or url');
          assertNoInlineCredentials(url);
          source = { type: 'git', url, ...(s.ref ? { ref: s.ref as string } : {}), ...(s.sha ? { sha: s.sha as string } : {}) };
          if (s.source === 'git-subdir') {
            if (typeof s.path !== 'string') throw new Error('git-subdir requires path');
            safeJoin('/root', s.path);
            source.subpath = s.path;
          }
        } else {
          result.issues.push({ code: 'unsupported-source', message: `Source type ${s.source} is not supported`, entry: entry.name }); continue;
        }
      }
      if (entry.skills !== undefined && (!Array.isArray(entry.skills) || !entry.skills.every(s => typeof s === 'string'))) throw new Error('skills must be a string array');
      result.entries.push({ name: entry.name, source, manifest: entry, ...(entry.skills ? { skills: entry.skills as string[] } : {}), ...(entry.version != null ? { version: String(entry.version) } : {}), ...(typeof entry.description === 'string' ? { description: entry.description } : {}) });
    } catch (error) { result.issues.push({ code: 'invalid-entry', message: String(error), entry: entry?.name as string | undefined }); }
  }
  return result;
}
