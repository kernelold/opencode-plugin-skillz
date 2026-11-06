import { createHash } from 'node:crypto';
import { readFile, readdir, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { gzipSync } from 'node:zlib';
import * as tar from 'tar';
import { describe, it, expect, vi } from 'vitest';
import { fetchGit, runGit } from '../src/fetch/git.js';
import { extractArchive, fetchArchive } from '../src/fetch/archive.js';
import { fetchHttpIndex } from '../src/fetch/http-index.js';
import { fetchMd } from '../src/fetch/md-url.js';
import { download } from '../src/fetch/http.js';
import { findSkills } from '../src/discover.js';
import { temp, file, server, gitRepo, commit, skillText } from './helpers.js';

describe('git fetch', () => {
  it('fetches a ref, preserves supporting files/modes, and returns HEAD', async () => {
    const repo = await gitRepo(); await file(repo, 'skills/commit/SKILL.md'); await file(repo, 'skills/commit/scripts/run.sh', '#!/bin/sh\nexit 0', 0o755);
    const sha = await commit(repo); await runGit(['tag', 'v1'], repo);
    const root = await temp(); const dir = path.join(root, 'out');
    expect(await fetchGit({ type: 'git', url: pathToFileURL(repo).href, ref: 'v1' }, dir)).toEqual({ version: sha });
    expect((await findSkills(dir)).skills[0].id).toBe('commit');
    expect((await stat(path.join(dir, 'skills/commit/scripts/run.sh'))).mode & 0o777).toBe(0o755);
    expect(await readdir(dir)).not.toContain('.git');
  });
  it('honors an old sha pin and a subpath', async () => {
    const repo = await gitRepo(); await file(repo, 'skills/a/SKILL.md', skillText('old')); const old = await commit(repo);
    await file(repo, 'skills/a/SKILL.md', skillText('new')); await file(repo, 'skills/b/SKILL.md'); await commit(repo, 'new');
    const dir = path.join(await temp(), 'out');
    expect(await fetchGit({ type: 'git', url: pathToFileURL(repo).href, sha: old, subpath: 'skills/a' }, dir)).toEqual({ version: old });
    expect(await readFile(path.join(dir, 'SKILL.md'), 'utf8')).toContain('name: old');
    expect(await readdir(dir)).toEqual(['SKILL.md']);
  });
  it('accepts a SHA in the #ref position', async () => {
    const repo = await gitRepo(); await file(repo, 'SKILL.md', skillText('old')); const sha = await commit(repo);
    await file(repo, 'SKILL.md', skillText('new')); await commit(repo, 'second');
    expect((await fetchGit({ type: 'git', url: repo, ref: sha }, path.join(await temp(), 'out'))).version).toBe(sha);
  });
  it('rejects symlink escape, traversal, and option injection', async () => {
    const repo = await gitRepo(); await file(repo, 'SKILL.md'); await symlink('/etc/passwd', path.join(repo, 'escape')); await commit(repo);
    await expect(fetchGit({ type: 'git', url: repo }, path.join(await temp(), 'out'))).rejects.toThrow('Symlink escapes');
    await expect(fetchGit({ type: 'git', url: repo, subpath: '../escape' }, path.join(await temp(), 'out'))).rejects.toThrow('Unsafe path');
    await expect(fetchGit({ type: 'git', url: '--upload-pack=bad' }, '/unused')).rejects.toThrow('Unsafe');
  });
});

describe('archives', () => {
  it('extracts zip including executable modes', async () => {
    const bytes = Buffer.from(zipSync({ 'skill/SKILL.md': strToU8(skillText()), 'skill/scripts/run.sh': [strToU8('#!/bin/sh\n'), { os: 3, attrs: (0o100755 << 16) >>> 0 }] }));
    const dir = await temp(); await extractArchive(bytes, 'zip', dir);
    expect((await findSkills(dir)).skills).toHaveLength(1);
    expect((await stat(path.join(dir, 'skill/scripts/run.sh'))).mode & 0o777).toBe(0o755);
  });
  it('extracts tar.gz with modes and supporting files', async () => {
    const input = await temp(); await file(input, 'skill/SKILL.md'); await file(input, 'skill/scripts/run.sh', '#!/bin/sh\n', 0o755);
    const archive = path.join(await temp(), 'a.tgz'); await tar.c({ gzip: true, cwd: input, file: archive }, ['skill']);
    const output = await temp(); await extractArchive(await readFile(archive), 'tar.gz', output);
    expect((await findSkills(output)).skills).toHaveLength(1);
    expect((await stat(path.join(output, 'skill/scripts/run.sh'))).mode & 0o777).toBe(0o755);
  });
  it('verifies sha256 before extracting', async () => {
    const bytes = Buffer.from(zipSync({ 'SKILL.md': strToU8(skillText()) }));
    const hash = createHash('sha256').update(bytes).digest('hex');
    const url = await server((_req, res) => res.end(bytes));
    const root = await temp();
    expect(await fetchArchive({ type: 'archive-url', url, format: 'zip', sha256: hash }, path.join(root, 'good'))).toEqual({ version: hash });
    await expect(fetchArchive({ type: 'archive-url', url, format: 'zip', sha256: '0'.repeat(64) }, path.join(root, 'bad'))).rejects.toThrow('sha256 mismatch');
    await expect(stat(path.join(root, 'bad'))).rejects.toThrow();
  });
  it.each(['../escape', '/absolute', 'folder/../../escape', 'C:/windows'])('rejects zip traversal %s', async name => {
    const bytes = Buffer.from(zipSync({ [name]: strToU8('bad') }));
    await expect(extractArchive(bytes, 'zip', await temp())).rejects.toThrow();
  });
  it('rejects zip symlink entries', async () => {
    const bytes = Buffer.from(zipSync({ escape: [strToU8('../../outside'), { os: 3, attrs: (0o120777 << 16) >>> 0 }], 'escape/SKILL.md': strToU8(skillText()) }));
    await expect(extractArchive(bytes, 'zip', await temp())).rejects.toThrow('symlinks');
  });
  it('rejects tar symlink entries', async () => {
    const input = await temp(); await file(input, 'SKILL.md'); await symlink('/etc', path.join(input, 'escape'));
    const archive = path.join(await temp(), 'a.tgz'); await tar.c({ gzip: true, cwd: input, file: archive }, ['escape']);
    await expect(extractArchive(await readFile(archive), 'tgz', await temp())).rejects.toThrow('links/special');
  });
  it.each(['../escape', '/absolute', 'folder/../../escape'])('rejects tar traversal %s', async entryPath => {
    const header = new tar.Header({ path: entryPath, type: 'File', size: 3, mode: 0o644 }); header.encode();
    const content = Buffer.alloc(512); content.write('bad');
    const archive = gzipSync(Buffer.concat([header.block!, content, Buffer.alloc(1024)]));
    await expect(extractArchive(archive, 'tgz', await temp())).rejects.toThrow('Unsafe path');
  });
  it('rejects tar hardlinks', async () => {
    const header = new tar.Header({ path: 'escape', type: 'Link', linkpath: '/etc/passwd', size: 0, mode: 0o644 }); header.encode();
    await expect(extractArchive(gzipSync(Buffer.concat([header.block!, Buffer.alloc(1024)])), 'tgz', await temp())).rejects.toThrow('links/special');
  });
  it('rejects an existing target symlink escape', async () => {
    const root = await temp(); const outside = await temp(); await symlink(outside, path.join(root, 'escape'));
    const bytes = Buffer.from(zipSync({ 'escape/SKILL.md': strToU8(skillText()) }));
    await expect(extractArchive(bytes, 'zip', root)).rejects.toThrow('Symlink escapes');
  });
  it('limits compressed size, expanded size, and file count', async () => {
    const bytes = Buffer.from(zipSync({ a: strToU8('a'.repeat(10000)), b: strToU8('b') }));
    for (const limits of [{ downloadBytes: 1 }, { extractedBytes: 100 }, { files: 1 }]) await expect(extractArchive(bytes, 'zip', await temp(), { limits })).rejects.toThrow('limit');
    const input = await temp(); await file(input, 'large', 'x'.repeat(10000)); const archive = path.join(await temp(), 'a.tgz'); await tar.c({ gzip: true, cwd: input, file: archive }, ['large']);
    await expect(extractArchive(await readFile(archive), 'tgz', await temp(), { limits: { extractedBytes: 5 } })).rejects.toThrow('limit');
  });
});

describe('HTTP indexes and markdown', () => {
  it.each(['index.json', 'index.yaml', 'index.yml'])('uses %s and fetches supporting files', async index => {
    const requests: string[] = [];
    const url = await server((req, res) => {
      requests.push(req.url!);
      if (req.url === `/catalog/${index}`) res.end(index.endsWith('json') ? JSON.stringify({ skills: [{ name: 'commit', version: '3', files: ['SKILL.md', 'references/policy.md'] }] }) : 'skills:\n  - name: commit\n    version: "3"\n    files: [SKILL.md, references/policy.md]\n');
      else if (req.url === '/catalog/commit/SKILL.md') res.end(skillText());
      else if (req.url === '/catalog/commit/references/policy.md') res.end('Policy');
      else { res.statusCode = 404; res.end(); }
    });
    const root = await temp(); await fetchHttpIndex(`${url}/catalog/`, root);
    expect((await findSkills(root)).skills[0].id).toBe('commit');
    expect(await readFile(path.join(root, 'commit/references/policy.md'), 'utf8')).toBe('Policy');
    expect(requests.slice(0, ['index.json', 'index.yaml', 'index.yml'].indexOf(index) + 1)).toEqual(['index.json', 'index.yaml', 'index.yml'].slice(0, ['index.json', 'index.yaml', 'index.yml'].indexOf(index) + 1).map(i => `/catalog/${i}`));
  });
  it('supports HTML subfolders, SKILL.md, and archives', async () => {
    const bytes = Buffer.from(zipSync({ 'SKILL.md': strToU8(skillText('archive-skill')) }));
    const url = await server((req, res) => {
      if (req.url === '/index.html') res.end('<a href="one/">One</a><a href="two.zip">Two</a>');
      else if (req.url === '/one/index.html') res.end("<a href='SKILL.md'>Skill</a>");
      else if (req.url === '/one/SKILL.md') res.end(skillText());
      else if (req.url === '/two.zip') res.end(bytes);
      else { res.statusCode = 404; res.end(); }
    });
    const root = await temp(); await fetchHttpIndex(`${url}/`, root);
    expect((await findSkills(root)).skills.map(s => s.id)).toEqual(['one', 'two']);
  });
  it.each(['../escape', '/absolute', 'https://other.invalid/a.md', '%2e%2e/escape', 'nested/../../escape'])('rejects unsafe JSON paths %s', async unsafe => {
    const url = await server((_req, res) => res.end(JSON.stringify({ skills: [{ name: 'a', files: [unsafe] }] })));
    await expect(fetchHttpIndex(`${url}/`, await temp())).rejects.toThrow();
  });
  it('rejects unsafe HTML paths and missing indexes', async () => {
    const url = await server((req, res) => { if (req.url === '/index.html') res.end('<a href="../escape.md">Bad</a>'); else { res.statusCode = 404; res.end(); } });
    await expect(fetchHttpIndex(`${url}/`, await temp())).rejects.toThrow('Unsafe path');
    await expect(fetchHttpIndex(`${url}/missing/`, await temp())).rejects.toThrow('No HTTP index');
  });
  it('rejects existing index destination symlink escapes', async () => {
    const root = await temp(); const outside = await temp(); await symlink(outside, path.join(root, 'a'));
    const url = await server((_req, res) => res.end(JSON.stringify({ skills: [{ name: 'a', files: ['SKILL.md'] }] })));
    await expect(fetchHttpIndex(`${url}/`, root)).rejects.toThrow('Symlink escapes');
    expect(await readdir(outside)).toEqual([]);
  });
  it('downloads a single .md skill', async () => {
    const url = await server((_req, res) => res.end(skillText('plain')));
    const file = await fetchMd(`${url}/plain.md`, await temp());
    expect(path.basename(file)).toBe('plain.md'); expect((await findSkills(file)).skills[0].id).toBe('plain');
  });
  it('does not forward header auth cross-origin; same-origin redirect retains it', async () => {
    process.env.SKILLZ_TEST_AUTH = 'test-secret';
    const received: (string | undefined)[] = [];
    const other = await server((req, res) => { received.push(req.headers.authorization); res.end('cross-origin'); });
    const own: (string | undefined)[] = [];
    const url = await server((req, res) => {
      own.push(req.headers.authorization);
      if (req.url === '/cross') { res.writeHead(302, { location: `${other}/end` }); res.end(); }
      else if (req.url === '/same') { res.writeHead(302, { location: '/end' }); res.end(); }
      else res.end('same-origin');
    });
    try {
      const opts = { auth: { authEnv: 'SKILLZ_TEST_AUTH', prefix: 'Bearer ' } };
      await expect(download(`${url}/cross`, opts)).rejects.toThrow('HTTPS');
      await expect(download(`${url}/same`, opts)).rejects.toThrow('HTTPS');
      expect((await download(`${url}/end`, opts)).toString()).toBe('same-origin');
      expect(received).toEqual([]); expect(own).toEqual(['Bearer test-secret', 'Bearer test-secret', 'Bearer test-secret']);
    } finally { delete process.env.SKILLZ_TEST_AUTH; }
  });
  it('resolves query authentication from env without persisting it and strips it on redirect', async () => {
    process.env.SKILLZ_TEST_KEY = 'secret-key'; const paths: string[] = [];
    const other = await server((req, res) => { paths.push(req.url!); res.end('ok'); });
    const url = await server((req, res) => { paths.push(req.url!); res.writeHead(302, { location: `${other}/end?key=secret-key` }); res.end(); });
    try {
      await expect(download(`${url}/start`, { auth: { authEnv: 'SKILLZ_TEST_KEY', query: 'key' } })).rejects.toThrow('HTTPS');
      expect(paths).toEqual(['/start?key=secret-key']);
    } finally { delete process.env.SKILLZ_TEST_KEY; }
  });
  it('rejects cross-origin index redirects and missing auth variables', async () => {
    const other = await server((_req, res) => res.end('{}'));
    const url = await server((_req, res) => { res.writeHead(302, { location: `${other}/index.json` }); res.end(); });
    await expect(fetchHttpIndex(`${url}/`, await temp())).rejects.toThrow('Cross-origin');
    await expect(download(url, { auth: { authEnv: 'SKILLZ_NOT_DEFINED' } })).rejects.toThrow('Missing auth');
  });
  it('enforces download size and redirect limits', async () => {
    const url = await server((req, res) => { if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); } else res.end('x'.repeat(100)); });
    await expect(download(url, { limits: { downloadBytes: 10 } })).rejects.toThrow('size limit');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://example.invalid/loop' } }));
    try { await expect(download('https://example.invalid/loop', { limits: { redirects: 1 } })).rejects.toThrow('Too many redirects'); }
    finally { fetch.mockRestore(); }
  });
});
