import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { it, expect } from 'vitest';

const exec = promisify(execFile);

// No account or real model: capture the actual provider requests from the pinned
// server and answer locally. HOME/XDG, tmux socket, sessions and files are private.
it.skipIf(process.env.OPENCODE_SESSION_SMOKE !== '1')('refreshes skill guidance on the next turn of an existing real session across locations', async () => {
  expect((await exec('opencode', ['--version'])).stdout.trim()).toBe('opencode v2.0.24');
  const root = await mkdtemp('/tmp/opencode/skillz-session-test-');
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const socket = `skillz-session-${process.pid}`;
  const requests: Record<string, unknown>[] = [];
  const provider = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = { id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model: 'probe', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] };
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerPort = (provider.address() as { port: number }).port;
  // Reserve a free port, then hand it to the private OpenCode process.
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    XDG_STATE_HOME: path.join(root, 'state'), XDG_CACHE_HOME: path.join(root, 'cache'), OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_CONFIG: path.join(root, 'empty.json') };
  const tmux = async (...args: string[]) => exec('tmux', ['-L', socket, ...args], { env });
  const keys = async (...args: string[]) => { await tmux('send-keys', '-t', 'probe:tui', ...args); };
  const waitScreen = async (pattern: RegExp) => {
    let screen = '';
    for (let i = 0; i < 160; i++) {
      screen = (await tmux('capture-pane', '-p', '-t', 'probe:tui')).stdout;
      if (pattern.test(screen)) return;
      await delay(100);
    }
    throw new Error(`TUI did not show ${pattern}:\n${screen}`);
  };
  const enter = async () => { await keys('Enter'); await delay(150); };
  let password = '';
  const api = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method,
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    const text = await response.text();
    const output = text ? JSON.parse(text) : undefined;
    if (!response.ok) throw new Error(`${method} ${route}: ${JSON.stringify(output)}`);
    return output;
  };
  const directory = path.join(root, 'project');
  const elsewhere = path.join(root, 'other');
  const at = (route: string, location = directory) => `${route}?location[directory]=${encodeURIComponent(location)}`;
  const rpc = async (method: string, input?: unknown, location = directory) => (await api('POST', at(`/api/rpc/skillz/${method}`, location), input === undefined ? {} : { input })).output;
  const turn = async (sessionID: string) => {
    const count = requests.length;
    await api('POST', `/api/session/${sessionID}/prompt`, { text: 'Reply OK.' });
    await api('POST', `/api/experimental/session/${sessionID}/wait`, {});
    expect(requests.length).toBeGreaterThan(count);
    const messages = requests.at(-1)!.messages as { role: string; content: unknown }[];
    // Check the newest guidance, not an earlier reminder retained in history.
    return messages.map(message => JSON.stringify(message)).filter(message =>
      /No skills are currently available|New skills are available|available skills have changed|no longer available and must not be used/.test(message)).at(-1) ?? '';
  };
  try {
    for (const dir of ['project', 'other', 'config/opencode', 'source/fresh']) await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, 'empty.json'), '{}');
    await writeFile(path.join(root, 'source/fresh/SKILL.md'), '---\nname: Fresh\ndescription: Freshly installed runtime probe\n---\nFresh body\n');
    await writeFile(path.join(root, 'config/opencode/opencode.json'), JSON.stringify({
      plugins: [{ package: repository, options: { dataDir: path.join(root, 'skillz'), automaticUpdates: false } }],
      model: 'probe/probe', providers: { probe: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'not-a-secret-test-fixture' }, models: { probe: { capabilities: { tools: true }, limit: { context: 32000, output: 100 } } } } },
    }));
    await tmux('new-session', '-d', '-s', 'probe', '-x', '150', '-y', '48', `opencode serve --hostname 127.0.0.1 --port ${port} > '${path.join(root, 'server.log')}' 2>&1`);
    for (let i = 0; i < 200; i++) {
      password = (await readFile(path.join(root, 'server.log'), 'utf8').catch(() => '')).match(/server password (\S+)/)?.[1] ?? '';
      if (password) { try { await api('GET', '/api/info'); break; } catch {} }
      await delay(100);
    }
    expect(password).not.toBe('');
    const session = (await api('POST', '/api/session', { title: 'Private skill refresh probe', location: { directory }, model: { providerID: 'probe', id: 'probe' } })).data;
    expect(await turn(session.id)).not.toContain('Freshly installed runtime probe');
    // Load a second location before installing, just like /skillz on another tab.
    await api('GET', at('/api/skill', elsewhere));
    const source = await rpc('addSource', { input: path.join(root, 'source') }, elsewhere);
    // The TUI is a different process but its context.client reaches this same
    // server. Install from /skillz while the existing session is on screen.
    await tmux('set-environment', 'OPENCODE_PASSWORD', password).catch(() => {
      // execFile errors include argv; never expose even this disposable password.
      throw new Error('Could not configure private TUI authentication');
    });
    await tmux('new-window', '-t', 'probe', '-n', 'tui', `opencode --server http://127.0.0.1:${port} --session ${session.id} '${directory}'`);
    await waitScreen(/Reply OK/);
    await keys('-l', '/skillz'); await delay(300); await enter();
    await waitScreen(/Skillz · \[Discover\]/);
    await enter(); await waitScreen(/Skills: fresh/);
    await waitScreen(/Install skill\?/);
    await waitScreen(/Default: No/); await keys('Up'); await enter();
    await waitScreen(/Skillz · \[Discover\]/);
    await keys('Escape');
    expect((await api('GET', at('/api/skill'))).data).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'fresh' })]));
    const added = await turn(session.id);
    expect(added).toContain('New skills are available');
    expect(added).toContain('Freshly installed runtime probe');
    await rpc('setEnabled', { sourceId: source.id, enabled: false }, elsewhere);
    expect(await turn(session.id)).toContain('no longer available and must not be used: fresh');
    await rpc('setEnabled', { sourceId: source.id, enabled: true }, elsewhere);
    expect(await turn(session.id)).toContain('Freshly installed runtime probe');
    await writeFile(path.join(root, 'source/fresh/SKILL.md'), '---\nname: Fresh\ndescription: Updated runtime probe\n---\nUpdated body\n');
    await rpc('update', { sourceId: source.id }, elsewhere);
    expect(await turn(session.id)).toContain('Updated runtime probe');
    await rpc('remove', { sourceId: source.id }, elsewhere);
    expect(await turn(session.id)).toContain('no longer available and must not be used: fresh');
  } finally {
    await tmux('kill-server').catch(() => {});
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 90000);
