import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { DEFAULT_LIMITS, safeJoin, assertSafeTree } from '../security.js';
import { parseSource } from '../source.js';
import { download, HttpError, type HttpOptions } from './http.js';
import { fetchArchive } from './archive.js';

export async function fetchHttpIndex(input: string, dir: string, options: HttpOptions = {}): Promise<{ plainFiles: string[]; version?: string }> {
  const base = new URL(input);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  base.hash = '';
  const opts: HttpOptions = { ...options, sameOrigin: base.origin };
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const seen = new Set<string>(); let files = 0; let bytes = 0;
  const plainFiles: string[] = [];
  const declaredVersions: [string, string][] = [];
  let allVersioned = true;
  function relativeUrl(relative: string, root: URL): URL {
    safeJoin('/root', decodeURIComponent(relative));
    if (/^[a-z][a-z\d+.-]*:/i.test(relative) || relative.startsWith('//') || /[?#]/.test(relative)) throw new Error(`Unsafe index path: ${relative}`);
    const url = new URL(relative, root);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error('Index path escapes source');
    return url;
  }
  async function save(url: URL, file: string): Promise<void> {
    if (++files > limits.files) throw new Error('HTTP index file limit exceeded');
    const content = await download(url.href, opts);
    if ((bytes += content.length) > limits.extractedBytes) throw new Error('HTTP index total size limit exceeded');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  async function folder(url: URL, target: string, depth: number): Promise<void> {
    if (depth > 6) throw new Error('HTTP index depth limit exceeded');
    if (seen.has(url.href)) return;
    seen.add(url.href);
    if (seen.size > limits.files) throw new Error('HTTP index folder limit exceeded');
    let text: string | undefined; let index = '';
    for (const candidate of ['index.json', 'index.yaml', 'index.yml', 'index.html']) {
      try { text = (await download(new URL(candidate, url).href, opts)).toString('utf8'); index = candidate; break; }
      catch (error) { if (!(error instanceof HttpError) || ![404, 410].includes(error.status)) throw error; }
    }
    if (text === undefined) throw new Error(`No HTTP index found at ${url.href}`);
    if (index !== 'index.html') {
      const parsed = (index === 'index.json' ? JSON.parse(text) : parse(text, { maxAliasCount: 50 })) as { skills?: unknown };
      if (!parsed || !Array.isArray(parsed.skills)) throw new Error('HTTP index requires skills[]');
      for (const skill of parsed.skills as { name?: unknown; version?: unknown; files?: unknown }[]) {
        if (typeof skill.name !== 'string' || !skill.name || skill.name.includes('/') || !Array.isArray(skill.files) || !skill.files.every(f => typeof f === 'string')) throw new Error('Invalid HTTP index skill');
        if (skill.version !== undefined && typeof skill.version !== 'string' && typeof skill.version !== 'number') throw new Error('Invalid HTTP index version');
        if (skill.version != null && String(skill.version)) declaredVersions.push([new URL(skill.name, url).pathname, String(skill.version)]);
        else allVersioned = false;
        const skillDir = safeJoin(target, skill.name);
        for (const file of skill.files as string[]) {
          relativeUrl(file, url);
          const dest = safeJoin(skillDir, file);
          await save(relativeUrl(`${skill.name}/${file}`, url), dest);
        }
      }
      return;
    }
    allVersioned = false;
    const links = [...text.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].map(m => m[1] ?? m[2] ?? m[3]);
    for (const link of links) {
      if (!/\.(md|zip|tgz|tar\.gz)$/i.test(link) && !link.endsWith('/')) continue;
      const next = relativeUrl(link, url);
      const dest = safeJoin(target, decodeURIComponent(link));
      if (link.endsWith('/')) await folder(next, dest, depth + 1);
      else if (/\.md$/i.test(link)) {
        await save(next, dest);
        if (path.basename(dest) !== 'SKILL.md') plainFiles.push(dest);
      }
      else {
        const source = parseSource(next.href);
        if (source.type !== 'archive-url') throw new Error('Invalid archive link');
        const extracted = dest.replace(/\.(zip|tgz|tar\.gz)$/i, '');
        await fetchArchive(source, extracted, { ...opts, limits: { ...limits, files: limits.files - files, extractedBytes: limits.extractedBytes - bytes } });
        async function count(dir: string): Promise<void> {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (++files > limits.files) throw new Error('HTTP index file limit exceeded');
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) await count(file);
            else if ((bytes += (await stat(file)).size) > limits.extractedBytes) throw new Error('HTTP index total size limit exceeded');
          }
        }
        await count(extracted);
      }
    }
  }
  await mkdir(dir, { recursive: true });
  await assertSafeTree(dir, true);
  await folder(base, dir, 0);
  const version = allVersioned && declaredVersions.length ? declaredVersions.length === 1 ? declaredVersions[0][1] : `index-${createHash('sha256').update(JSON.stringify(declaredVersions.sort(([a], [b]) => a.localeCompare(b)))).digest('hex')}` : undefined;
  return { plainFiles, version };
}
