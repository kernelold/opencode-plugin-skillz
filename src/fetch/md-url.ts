import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { download, type HttpOptions } from './http.js';
import { safeJoin } from '../security.js';
export async function fetchMd(url: string, dir: string, opts: HttpOptions = {}): Promise<string> {
  await mkdir(dir, { recursive: true });
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'skill.md');
  const file = safeJoin(dir, name);
  await writeFile(file, await download(url, opts));
  return file;
}
