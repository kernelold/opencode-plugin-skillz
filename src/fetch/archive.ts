import { createHash } from 'node:crypto';
import { mkdir, writeFile, mkdtemp, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import yauzl from 'yauzl';
import * as tar from 'tar';
import { gunzipSync } from 'node:zlib';
import { DEFAULT_LIMITS, safeJoin, assertSafeTree } from '../security.js';
import { download, type HttpOptions } from './http.js';
import type { Source } from '../source.js';

export async function extractArchive(bytes: Buffer, format: 'zip' | 'tar.gz' | 'tgz', dir: string, opts: HttpOptions = {}): Promise<void> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  if (bytes.length > limits.downloadBytes) throw new Error('Archive download size limit exceeded');
  let count = 0; let total = 0;
  const secret = opts.auth && process.env[opts.auth.authEnv];
  const rejectSecret = (content: Buffer) => { if (secret && content.includes(Buffer.from(secret))) throw new Error('Archive contains auth value; refusing to cache'); };
  function check(name: string, size: number): void {
    safeJoin(dir, name);
    if (++count > limits.files || (total += size) > limits.extractedBytes) throw new Error('Archive extraction size/file limit exceeded');
  }
  await mkdir(dir, { recursive: true });
  await assertSafeTree(dir, true);
  if (format === 'zip') {
    const directories: { file: string; mode: number }[] = [];
    await new Promise<void>((resolve, reject) => {
      yauzl.fromBuffer(bytes, { lazyEntries: true, strictFileNames: true }, (error, zip) => {
        if (error || !zip) { reject(error ?? new Error('Invalid zip')); return; }
        const fail = (error: unknown) => { zip.close(); reject(error); };
        zip.on('error', fail);
        zip.on('end', resolve);
        zip.on('entry', (entry: yauzl.Entry) => {
          void (async () => {
            check(entry.fileName, entry.uncompressedSize);
            const mode = entry.externalFileAttributes >>> 16;
            if ((mode & 0o170000) === 0o120000) throw new Error('Archive symlinks are not supported');
            if (mode && ![0, 0o100000, 0o040000].includes(mode & 0o170000)) throw new Error('Unsafe archive file type');
            const file = safeJoin(dir, entry.fileName);
            if (entry.fileName.endsWith('/')) { await mkdir(file, { recursive: true }); if (mode) directories.push({ file, mode: mode & 0o777 }); }
            else {
              await mkdir(path.dirname(file), { recursive: true });
              const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => zip.openReadStream(entry, (error, stream) => error || !stream ? reject(error) : resolve(stream)));
              let tail = Buffer.alloc(0);
              const guard = new Transform({ transform(chunk: Buffer, _encoding, callback) {
                try {
                  const content = Buffer.concat([tail, chunk]); rejectSecret(content);
                  // Hold a token-length suffix, so a value crossing chunk boundaries
                  // cannot reach a plaintext cache/staging file before it is detected.
                  const keep = secret ? Math.min(content.length, Buffer.byteLength(secret)) : 0;
                  tail = content.subarray(content.length - keep);
                  callback(null, content.subarray(0, content.length - keep));
                } catch (error) { callback(error as Error); }
              }, flush(callback) { callback(null, tail); } });
              await pipeline(stream, guard, createWriteStream(file, { mode: mode ? mode & 0o777 : 0o644 }));
              if (mode) await chmod(file, mode & 0o777);
            }
            zip.readEntry();
          })().catch(fail);
        });
        zip.readEntry();
      });
    });
    for (const directory of directories.reverse()) await chmod(directory.file, directory.mode);
  } else {
    const tmp = await mkdtemp(path.join(path.dirname(dir), '.archive-'));
    const archive = path.join(tmp, 'archive.tgz');
    try {
      // Bound the *whole* tar stream, including PAX/GNU metadata that tar's entry
      // callbacks do not count. Stop zip bombs before an unbounded inflate/scan.
      const maxOutputLength = limits.extractedBytes + limits.files * 1024 + 1024 * 1024;
      let expanded: Buffer;
      try { expanded = gunzipSync(bytes, { maxOutputLength }); }
      catch (error) { throw new Error('Archive invalid or expanded size limit exceeded', { cause: error }); }
      rejectSecret(expanded);
      await writeFile(archive, expanded);
      let failure: Error | undefined;
      await tar.t({ file: archive, strict: true, onReadEntry: entry => {
        try {
          check(entry.path, entry.size);
          if (!['File', 'Directory', 'OldFile'].includes(entry.type)) throw new Error('Archive links/special files are not supported');
        } catch (error) { failure = error as Error; }
      } });
      if (failure) throw failure;
      await tar.x({ file: archive, cwd: dir, strict: true, preservePaths: false, noChmod: false, noMtime: false, filter: (_name, entry) => { if (entry.mode != null) entry.mode &= 0o777; return true; } });
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }
}
export async function fetchArchive(source: Extract<Source, { type: 'archive-url' }>, dir: string, opts: HttpOptions = {}): Promise<{ version: string }> {
  const bytes = await download(source.url, opts);
  const version = createHash('sha256').update(bytes).digest('hex');
  if (source.sha256 && source.sha256.toLowerCase() !== version) throw new Error('Archive sha256 mismatch');
  await extractArchive(bytes, source.format, dir, opts);
  return { version };
}
