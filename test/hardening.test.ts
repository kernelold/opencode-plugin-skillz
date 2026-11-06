import { readFile, readdir, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { gzipSync } from 'node:zlib';
import * as tar from 'tar';
import { describe, it, expect, vi } from 'vitest';
import { download } from '../src/fetch/http.js';
import { fetchHttpIndex } from '../src/fetch/http-index.js';
import { extractArchive } from '../src/fetch/archive.js';
import { fetchGit } from '../src/fetch/git.js';
import { findSkills } from '../src/discover.js';
import { Store } from '../src/store.js';
import { temp, file, server, gitRepo, commit, skillText } from './helpers.js';

describe('M4 adversarial security regression tests', () => {
  it('preserves licences and bytes/modes, and never executes downloaded scripts', async () => {
    const marker = path.join(await temp(), 'EXECUTED');
    const script = `#!/bin/sh\ntouch ${marker}\n`;
    const skill = skillText('Untouched', 'Description', '  Content\r\n');
    const bytes = Buffer.from(zipSync({ 'a/SKILL.md': strToU8(skill), 'a/LICENSE': strToU8('Upstream copyright\r\n'), 'a/scripts/run.sh': [strToU8(script), { os: 3, attrs: (0o100755 << 16) >>> 0 }] }));
    const url = await server((_req, res) => res.end(bytes)); const store = new Store({ dataDir: await temp() });
    const source = await store.addSource(`${url}/a.zip`); const active = await store.install(source.id);
    expect(await readFile(active.skills[0].skillFile, 'utf8')).toBe(skill);
    expect(await readFile(path.join(active.current, 'a/LICENSE'), 'utf8')).toBe('Upstream copyright\r\n');
    expect(await readFile(path.join(active.current, 'a/scripts/run.sh'), 'utf8')).toBe(script);
    expect((await stat(path.join(active.current, 'a/scripts/run.sh'))).mode & 0o777).toBe(0o755);
    await expect(stat(marker)).rejects.toThrow();
  });
  it.each(['zip', 'index'] as const)('rejects internal destination symlink aliases for %s (not just escapes)', async kind => {
    const root = await temp(); await file(root, 'real/keep', 'original'); await symlink('real', path.join(root, 'a'));
    if (kind === 'zip') await expect(extractArchive(Buffer.from(zipSync({ 'a/keep': strToU8('overwrite') })), 'zip', root)).rejects.toThrow('symlinks');
    else {
      const url = await server((_req, res) => res.end(JSON.stringify({ skills: [{ name: 'a', files: ['keep'] }] })));
      await expect(fetchHttpIndex(`${url}/`, root)).rejects.toThrow('symlinks');
    }
    expect(await readFile(path.join(root, 'real/keep'), 'utf8')).toBe('original');
  });
  it('rejects a local explicit SKILL.md symlink and supporting-file escape', async () => {
    const root = await temp(); const outside = await file(await temp(), 'SKILL.md');
    await file(root, 'a/keep', ''); await symlink(outside, path.join(root, 'a/SKILL.md'));
    expect((await findSkills(root, { skills: ['a'] })).skills).toEqual([]);
    expect((await findSkills(root, { skills: ['a'] })).issues[0].message).toContain('Symlink escapes');
  });
  it('bounds decompression even for a tar stream made entirely of uncounted metadata/zeros', async () => {
    const bomb = gzipSync(Buffer.alloc(2 * 1024 * 1024));
    await expect(extractArchive(bomb, 'tgz', await temp(), { limits: { extractedBytes: 16, files: 1 } })).rejects.toThrow('size limit');
  });
  it('disables user git filters referenced by downloaded .gitattributes', async () => {
    const repo = await gitRepo(); await file(repo, 'SKILL.md'); await file(repo, '.gitattributes', '* filter=evil'); await commit(repo);
    const marker = path.join(await temp(), 'executed');
    vi.stubEnv('GIT_CONFIG_COUNT', '2'); vi.stubEnv('GIT_CONFIG_KEY_0', 'filter.evil.smudge'); vi.stubEnv('GIT_CONFIG_VALUE_0', `touch ${marker}; cat`);
    vi.stubEnv('GIT_CONFIG_KEY_1', 'filter.evil.required'); vi.stubEnv('GIT_CONFIG_VALUE_1', 'true');
    try { await fetchGit({ type: 'git', url: repo }, path.join(await temp(), 'out')); await expect(stat(marker)).rejects.toThrow(); }
    finally { vi.unstubAllEnvs(); }
  });
  it('fails invalid/unavailable full sha pins instead of silently checking out HEAD', async () => {
    const repo = await gitRepo(); await file(repo, 'SKILL.md'); await commit(repo);
    await expect(fetchGit({ type: 'git', url: repo, sha: '0'.repeat(40) }, path.join(await temp(), 'out'))).rejects.toThrow();
  });
  it.each(['..', '%2e%2e', '%2foutside', '..%2foutside', 'a?query', 'a#hash'])('rejects unsafe index skill names %s', async name => {
    const url = await server((_req, res) => res.end(JSON.stringify({ skills: [{ name, files: ['SKILL.md'] }] })));
    await expect(fetchHttpIndex(`${url}/`, await temp())).rejects.toThrow();
  });
  it('uses HTTPS-only bounded redirects, strips credentials cross-origin, and rejects other-origin index files', async () => {
    vi.stubEnv('SKILLZ_HARDEN_TOKEN', 'sentinel-secret-12345');
    const requests: { url: string; auth?: string }[] = [];
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input)); requests.push({ url: url.href, auth: (init?.headers as Record<string, string>)?.Authorization });
      if (url.pathname === '/start') return new Response(null, { status: 302, headers: { location: `https://other.invalid/end${url.search ? '?key=sentinel-secret-12345' : ''}` } });
      if (url.pathname === '/downgrade') return new Response(null, { status: 302, headers: { location: 'http://localhost/end' } });
      if (url.pathname === '/loop') return new Response(null, { status: 302, headers: { location: '/loop' } });
      return new Response('ok');
    });
    try {
      const auth = { authEnv: 'SKILLZ_HARDEN_TOKEN', query: 'key' };
      expect((await download('https://own.invalid/start', { auth })).toString()).toBe('ok');
      expect(requests.slice(0, 2).map(r => r.url)).toEqual(['https://own.invalid/start?key=sentinel-secret-12345', 'https://other.invalid/end']);
      requests.length = 0;
      await download('https://own.invalid/start', { auth: { authEnv: 'SKILLZ_HARDEN_TOKEN', prefix: 'Bearer ' } });
      expect(requests[0].auth).toBe('Bearer sentinel-secret-12345'); expect(requests[1].auth).toBeUndefined();
      await expect(download('https://own.invalid/downgrade')).rejects.toThrow('HTTPS');
      await expect(download('https://own.invalid/start', { auth, sameOrigin: 'https://own.invalid' })).rejects.toThrow('Cross-origin');
      await expect(download('https://own.invalid/loop', { limits: { redirects: 2 } })).rejects.toThrow('Too many redirects');
    } finally { mock.mockRestore(); vi.unstubAllEnvs(); }
  });
  it('never persists auth values in cache, staging, state or errors, including echoed bodies and transport errors', async () => {
    const token = 'SENTINEL_TOKEN_M4_938471'; vi.stubEnv('SKILLZ_HARDEN_TOKEN', token);
    let echo = false;
    const url = await server((_req, res) => res.end(echo ? skillText('Leak', 'Description', token) : skillText()));
    const dataDir = await temp(); const store = new Store({ dataDir });
    try {
      const source = await store.addSource(`${url}/a.md`, { auth: { authEnv: 'SKILLZ_HARDEN_TOKEN', query: 'key' } });
      await store.install(source.id); echo = true;
      await expect(store.update(source.id)).rejects.toThrow('contains auth');
      await store.reportIssues([{ code: 'test', message: `Failure with ${token}` }], source.id);
      const mock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(`request failed at ?key=${token}`));
      try { await expect(store.update(source.id)).rejects.toThrow('HTTP transport failed'); } finally { mock.mockRestore(); }
      await expect(store.addSource(`${url}/b.md`, { auth: { authEnv: 'SKILLZ_HARDEN_TOKEN', prefix: token } })).rejects.toThrow('must not be stored');
      const contents: string[] = [];
      async function grep(dir: string): Promise<void> {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) await grep(file); else contents.push(await readFile(file, 'utf8'));
        }
      }
      await grep(dataDir); expect(contents.length).toBeGreaterThan(2); expect(contents.join('\n')).not.toContain(token);
      expect((await store.listErrors()).some(e => e.message.includes('[REDACTED]'))).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });
  it.each(['zip', 'tgz'] as const)('rejects compressed auth echoes before installing %s content', async format => {
    const token = 'SENTINEL_COMPRESSED_TOKEN_782136'; vi.stubEnv('SKILLZ_HARDEN_TOKEN', token);
    const input = await temp(); await file(input, 'SKILL.md', skillText('Echo', 'Description', token));
    let bytes: Buffer;
    if (format === 'zip') bytes = Buffer.from(zipSync({ 'SKILL.md': strToU8(skillText('Echo', 'Description', token)) }));
    else {
      const archive = path.join(await temp(), 'a.tgz'); await tar.c({ gzip: true, cwd: input, file: archive }, ['SKILL.md']); bytes = await readFile(archive);
    }
    const url = await server((_req, res) => res.end(bytes)); const dataDir = await temp(); const store = new Store({ dataDir });
    try {
      const source = await store.addSource(`${url}/a.${format}`, { auth: { authEnv: 'SKILLZ_HARDEN_TOKEN' } });
      await expect(store.install(source.id)).rejects.toThrow('contains auth');
      expect(await store.listInstalled()).toEqual([]);
      expect((await readdir(dataDir)).sort()).toEqual(['errors.json', 'sources.json']);
      expect(await readFile(path.join(dataDir, 'errors.json'), 'utf8')).not.toContain(token);
    } finally { vi.unstubAllEnvs(); }
  });
});
