import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { devNull } from 'node:os';
import { assertSafeTree, isInside, safeJoin } from '../security.js';
import type { Source } from '../source.js';

const exec = promisify(execFile);
export async function runGit(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'credential.interactive=false', '-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: `${process.env.GIT_SSH_COMMAND ?? 'ssh'} -o BatchMode=yes` }, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}
export async function fetchGit(source: Extract<Source, { type: 'git' }>, dir: string): Promise<{ version: string }> {
  if (source.sha && !/^[a-f0-9]{40}$/.test(source.sha)) throw new Error('Invalid commit sha');
  const pinnedSha = source.sha ?? (source.ref && /^[a-f0-9]{40}$/.test(source.ref) ? source.ref : undefined);
  if (source.ref?.startsWith('-')) throw new Error('Invalid ref');
  if (source.url.startsWith('-') || /^ext::/.test(source.url)) throw new Error('Unsafe git URL');
  if (/^[a-z][a-z\d+.-]*::/i.test(source.url) || (/^[a-z][a-z\d+.-]*:\/\//i.test(source.url) && !/^(https?|ssh|git|file):\/\//i.test(source.url))) throw new Error('Unsafe git URL protocol');
  await mkdir(path.dirname(dir), { recursive: true });
  const tmp = await mkdtemp(path.join(path.dirname(dir), '.git-fetch-'));
  const repo = path.join(tmp, 'repo');
  try {
    const args = ['clone', '--no-checkout'];
    if (!pinnedSha) args.push('--depth', '1');
    if (source.subpath) args.push('--filter=blob:none', '--sparse');
    if (source.ref && !pinnedSha) args.push('--branch', source.ref);
    args.push('--', source.url, repo);
    await runGit(args);
    if (source.subpath) { safeJoin(repo, source.subpath); await runGit(['sparse-checkout', 'set', '--', source.subpath], repo); }
    if (pinnedSha) {
      try { await runGit(['cat-file', '-e', `${pinnedSha}^{commit}`], repo); }
      catch { await runGit(['fetch', '--depth', '1', 'origin', pinnedSha], repo); }
    }
    // Tracked .gitattributes must not invoke a user's configured smudge/process
    // filters. They execute code and can rewrite content. Keep git auth config.
    let filters = '';
    try { filters = await runGit(['config', '--get-regexp', '^filter\\..*\\.(smudge|process|required)$'], repo); } catch { /* No configured filters. */ }
    const disabled = [...new Set(filters.split('\n').map(line => line.split(/\s/)[0]).filter(Boolean))]
      .flatMap(key => ['-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`]);
    await runGit([...disabled, 'checkout', '--detach', pinnedSha ?? source.ref ?? 'HEAD'], repo);
    const version = await runGit(['rev-parse', 'HEAD'], repo);
    if (pinnedSha && version !== pinnedSha) throw new Error('Commit sha mismatch');
    const tree = source.subpath ? safeJoin(repo, source.subpath) : repo;
    if (!isInside(repo, await realpath(tree))) throw new Error('Git subpath escapes repository');
    await assertSafeTree(tree);
    await mkdir(dir, { recursive: true });
    await cp(tree, dir, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, filter: file => path.basename(file) !== '.git' });
    return { version };
  } finally { await rm(tmp, { recursive: true, force: true }); }
}
