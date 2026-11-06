import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach } from 'vitest';
import { runGit } from '../src/fetch/git.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
export async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'skillz-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true })); return dir;
}
export const skillText = (name = 'Example', description = 'A useful skill', body = 'Body\n') => `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  version: "1"\nlicense: MIT\nunknown: allowed\n---\n${body}`;
export async function file(root: string, relative: string, content = skillText(), mode?: number): Promise<string> {
  const target = path.join(root, relative); await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, { mode }); return target;
}
export async function server(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const http = createServer(handler);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { http.close(error => error ? reject(error) : resolve()); http.closeAllConnections(); }));
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No server address');
  return `http://127.0.0.1:${address.port}`;
}
export async function gitRepo(): Promise<string> {
  const repo = await temp(); await runGit(['init', '-b', 'main', repo]);
  await runGit(['config', 'user.email', 'test@example.invalid'], repo);
  await runGit(['config', 'user.name', 'Test'], repo); return repo;
}
export async function commit(repo: string, message = 'test'): Promise<string> {
  await runGit(['add', '.'], repo); await runGit(['commit', '-m', message], repo);
  return runGit(['rev-parse', 'HEAD'], repo);
}
