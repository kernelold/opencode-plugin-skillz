import path from 'node:path';
import { chmod, lstat, readdir, realpath, rm } from 'node:fs/promises';

export interface Limits { downloadBytes: number; extractedBytes: number; files: number; redirects: number }
export const DEFAULT_LIMITS: Limits = { downloadBytes: 32 * 1024 * 1024, extractedBytes: 128 * 1024 * 1024, files: 10000, redirects: 5 };
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export function safeJoin(root: string, relative: string): string {
  if (!relative || relative.includes('\0') || relative.includes('\\') || path.posix.isAbsolute(relative) || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(relative) || relative.split('/').includes('..')) throw new Error(`Unsafe path: ${relative}`);
  const result = path.resolve(root, relative);
  if (!isInside(root, result)) throw new Error(`Path escapes root: ${relative}`);
  return result;
}
// Used before copying a local tree: an otherwise harmless copy can follow an external symlink.
export async function assertSafeTree(root: string, rejectSymlinks = false): Promise<void> {
  if (rejectSymlinks && (await lstat(root)).isSymbolicLink()) throw new Error('Destination symlinks are not supported');
  const base = await realpath(root);
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir)) {
      const file = path.join(dir, entry);
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) {
        if (!isInside(base, await realpath(file))) throw new Error(`Symlink escapes source: ${file}`);
        if (rejectSymlinks) throw new Error('Destination symlinks are not supported');
      } else if (stat.isDirectory() && entry !== '.git') await visit(file);
    }
  }
  await visit(root);
}
// Only for our own staging/cache trees, NEVER linked local sources. Archives may
// contain read-only directories; make cleanup possible without following links.
export async function removeManagedTree(root: string): Promise<void> {
  async function writable(dir: string): Promise<void> {
    let info;
    try { info = await lstat(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    await chmod(dir, (info.mode & 0o777) | 0o700);
    for (const entry of await readdir(dir)) await writable(path.join(dir, entry));
  }
  await writable(root);
  await rm(root, { recursive: true, force: true });
}
