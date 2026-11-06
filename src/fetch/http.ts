import { DEFAULT_LIMITS, type Limits } from '../security.js';
import type { AuthReference } from '../source.js';
import { assertNoInlineCredentials } from '../source.js';

export interface HttpOptions { auth?: AuthReference; limits?: Partial<Limits>; sameOrigin?: string }
export class HttpError extends Error { constructor(public status: number, url: string) { super(`HTTP ${status}: ${url}`); } }
export async function download(input: string, opts: HttpOptions = {}): Promise<Buffer> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const origin = new URL(input).origin;
  let url = new URL(input);
  assertNoInlineCredentials(input);
  for (let redirects = 0; ; redirects++) {
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) downloads are supported');
    if (opts.sameOrigin && url.origin !== opts.sameOrigin) throw new Error('Cross-origin download rejected');
    const headers: Record<string, string> = {};
    const requestUrl = new URL(url);
    if (opts.auth && url.origin === origin) {
      const value = process.env[opts.auth.authEnv];
      if (value === undefined) throw new Error(`Missing auth environment variable ${opts.auth.authEnv}`);
      if (opts.auth.query) requestUrl.searchParams.set(opts.auth.query, `${opts.auth.prefix ?? ''}${value}`);
      else headers[opts.auth.header ?? 'Authorization'] = `${opts.auth.prefix ?? ''}${value}`;
    }
    // Transport errors may contain the authenticated URL. Do not retain their
    // message/cause in state, logs, or the RPC error returned to clients.
    let response: Response;
    try { response = await fetch(requestUrl, { headers, redirect: 'manual', signal: AbortSignal.timeout(30000) }); }
    catch { throw new Error(`HTTP transport failed: ${url.origin}${url.pathname}`); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      if (redirects >= limits.redirects) throw new Error('Too many redirects');
      const location = response.headers.get('location');
      if (!location) throw new Error('Redirect missing location');
      const next = new URL(location, url);
      if (opts.auth?.query) next.searchParams.delete(opts.auth.query);
      const secret = opts.auth && process.env[opts.auth.authEnv];
      if (secret && decodeURIComponent(next.href).includes(secret)) throw new Error('Redirect contains auth value');
      if (opts.sameOrigin && next.origin !== opts.sameOrigin) throw new Error('Cross-origin download rejected');
      if (next.protocol !== 'https:') throw new Error('Redirect must use HTTPS');
      assertNoInlineCredentials(next.href);
      url = next;
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status, url.origin + url.pathname); }
    const length = Number(response.headers.get('content-length'));
    if (length > limits.downloadBytes) { await response.body?.cancel(); throw new Error('Download size limit exceeded'); }
    const chunks: Buffer[] = [];
    let bytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > limits.downloadBytes) throw new Error('Download size limit exceeded');
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel(); }
    }
    const result = Buffer.concat(chunks);
    const secret = opts.auth && process.env[opts.auth.authEnv];
    // A server can echo an Authorization value into its response. Reject before
    // writing even a staging file; downloaded content is otherwise unmodified.
    if (secret && result.includes(Buffer.from(secret))) throw new Error('HTTP response contains auth value; refusing to cache');
    return result;
  }
}
