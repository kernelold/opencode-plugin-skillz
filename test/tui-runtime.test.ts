import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { it, expect } from 'vitest';
import { Store } from '../src/store.js';
import { server, skillText } from './helpers.js';

const exec = promisify(execFile);
// Opt-in: needs the real pinned CLI, tmux, and `npm run build` first. Every
// file/service/socket belongs to this test; the user's config/state is untouched.
it.skipIf(process.env.OPENCODE_TUI_SMOKE !== '1')('loads /skillz on the real 2.0.24 home screen and manages a colliding local source', async () => {
  expect((await exec('opencode', ['--version'])).stdout.trim()).toBe('opencode v2.0.24');
  await mkdir('/tmp/opencode', { recursive: true });
  const root = await mkdtemp('/tmp/opencode/skillz-tui-test-');
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const socket = `skillz-tui-${process.pid}`;
  const dataDir = path.join(root, 'skillz');
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    XDG_STATE_HOME: path.join(root, 'state'), XDG_CACHE_HOME: path.join(root, 'cache'), OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_CONFIG: path.join(root, 'project/opencode.json') };
  const tmux = async (...args: string[]) => (await exec('tmux', ['-L', socket, ...args], { env })).stdout;
  const keys = async (...args: string[]) => { await tmux('send-keys', '-t', 'probe', ...args); };
  const literal = async (value: string) => { await keys('-l', value); };
  const screen = () => tmux('capture-pane', '-p', '-t', 'probe');
  const wait = async (pattern: RegExp) => {
    let output = '';
    for (let i = 0; i < 160; i++) {
      output = await screen();
      if (pattern.test(output)) return output;
      await delay(100);
    }
    throw new Error(`TUI did not show ${pattern}:\n${output}`);
  };
  const enter = async () => { await keys('Enter'); await delay(150); };
  const skill = '---\nname: Probe\ndescription: Isolated TUI probe\n---\nProbe body\n';
  try {
    for (const dir of ['project', 'config/opencode/skills/probe', 'source/probe']) await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, 'source/probe/SKILL.md'), skill);
    await writeFile(path.join(root, 'config/opencode/skills/probe/SKILL.md'), skill);
    const config = JSON.stringify({ plugins: [{ package: repository, options: { dataDir } }] });
    await writeFile(path.join(root, 'project/opencode.json'), config);
    await writeFile(path.join(root, 'config/opencode/opencode.json'), config);
    await tmux('new-session', '-d', '-s', 'probe', '-x', '150', '-y', '48', `opencode --standalone ${path.join(root, 'project')}`);
    await wait(/Ask anything/);
    await literal('/skillz'); await wait(/Manage skills \(Skillz\)/); await delay(150); await enter();
    await wait(/Skillz · \[Discover\]/);
    await keys('C-a'); await wait(/Add source/); await keys('Down'); await enter();
    await wait(/Source URL/); await literal(path.join(root, 'source')); await enter();
    await wait(/Optional HTTP auth env-var NAME/); await enter();
    await wait(/Skillz · \[Discover\]/);
    await enter(); await wait(/Install skill\?/);
    expect(await wait(/Default: No/)).toContain('Skills: probe (1)');
    expect(await screen()).toContain('Trusted — you added this source');
    await writeFile('/tmp/opencode/skillz-install.txt', await screen());
    const installAnsi = await tmux('capture-pane', '-e', '-p', '-t', 'probe');
    await writeFile('/tmp/opencode/skillz-install.ansi.txt', installAnsi);
    // Theme values vary; assert that real rendering emitted distinct colour
    // sequences for the positive/negative choices, not particular RGB values.
    const choiceColors = installAnsi.split('\n').filter(line => /\[ (?:Yes, install|No) \]/.test(line))
      .map(line => [...line.matchAll(/\x1b\[38;[^m]+m/g)].map(match => match[0]));
    expect(choiceColors).toHaveLength(2);
    expect(choiceColors[0]).not.toEqual(choiceColors[1]);
    await enter(); // default No must not install
    await wait(/Skillz · \[Discover\]/);
    await expect(readFile(path.join(dataDir, 'installed.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await enter(); await wait(/Install skill\?/); await keys('Escape');
    await wait(/Skillz · \[Discover\]/);
    await expect(readFile(path.join(dataDir, 'installed.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    // Install again: explicitly approve install, then decline collision by default.
    await enter(); await wait(/Install skill\?/);
    await wait(/Default: No/); await keys('Up'); await enter();
    expect(await wait(/Override skill\?/)).toContain('already exists');
    await enter(); await wait(/Skillz · \[Discover\]/);
    await expect(readFile(path.join(dataDir, 'installed.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    // Explicit Yes is the only path that sets confirmOverride on retry.
    await enter(); await wait(/Install skill\?/);
    await wait(/Default: No/); await keys('Up'); await enter();
    await wait(/Override skill\?/); await wait(/Default: No/); await keys('Up'); await enter();
    await wait(/Skillz · \[Discover\]/);
    const installed = JSON.parse(await readFile(path.join(dataDir, 'installed.json'), 'utf8'));
    expect(Object.values(installed)).toEqual([expect.objectContaining({ enabled: true, overrides: [expect.stringContaining('probe overrides')] })]);
    // A real loopback response is held open, not an artificial UI timer. This
    // also catches cached listAvailable queuing behind the server's state lock.
    let blocked = false;
    let releaseCheck: (() => void) | undefined;
    const url = await server((_req, res) => {
      const respond = () => res.end(skillText('Remote probe'));
      if (blocked) releaseCheck = respond; else respond();
    });
    const fixture = new Store({ dataDir });
    const remote = await fixture.addSource(`${url}/remote.md`); await fixture.install(remote.id);
    blocked = true;
    await keys('C-Right');
    const immediateScreen = await wait(/Skillz · Discover · \[Installed\]/);
    expect(immediateScreen).toContain('probe');
    expect(immediateScreen).toContain('checking…');
    // No badge result can arrive while the actual check is pending.
    for (let i = 0; i < 50 && !releaseCheck; i++) await delay(50);
    expect(releaseCheck).toBeTypeOf('function');
    expect(await screen()).toContain('checking…');
    releaseCheck!(); blocked = false;
    const installedScreen = await wait(/\[up to date\]/);
    expect(installedScreen).toContain('[up to date]');
    expect(installedScreen).toContain('checked just now');
    await fixture.removeSource(remote.id, 'remove');
    await writeFile('/tmp/opencode/skillz-installed.txt', installedScreen);
    await writeFile('/tmp/opencode/skillz-installed.ansi.txt', await tmux('capture-pane', '-e', '-p', '-t', 'probe'));
    await enter(); expect(await wait(/Installed source/)).toContain('probe overrides');
    await enter(); await wait(/Source actions/); await enter(); // disable
    await wait(/\[disabled\]/);
    expect(Object.values(JSON.parse(await readFile(path.join(dataDir, 'installed.json'), 'utf8')))).toEqual([expect.objectContaining({ enabled: false })]);
    await writeFile(path.join(root, 'source/probe/SKILL.md'), skill + 'Updated body\n');
    await keys('C-r'); await wait(/\[update available\]/);
    await enter(); await wait(/Available version:/); await enter(); await wait(/Source actions/); await keys('Down'); await enter();
    await wait(/\[disabled\]/);
    const updated = JSON.parse(await readFile(path.join(dataDir, 'installed.json'), 'utf8'));
    expect(Object.values(updated)).toEqual([expect.objectContaining({ enabled: false })]);
    expect(Object.values(updated)[0]).not.toMatchObject({ version: Object.values(installed)[0] && (Object.values(installed)[0] as { version: string }).version });
    await enter(); await wait(/Installed source/); await enter(); await wait(/Source actions/); await enter();
    await wait(/\[enabled\]/);
    await keys('C-Right'); await wait(/Skillz · Discover · Installed · \[Sources\]/);
    const removeSource = async () => {
      await enter(); await wait(/Inspect source/); await keys('Down', 'Down', 'Down'); await enter();
      expect(await wait(/Default: Cancel/)).toContain('Installed skills: 1');
      expect(await screen()).toContain(' / probe');
      expect(await screen()).toContain('Remove source AND its 1 installed skills');
      expect(await screen()).toContain('Remove source only');
    };
    await removeSource(); await enter(); // safe default Cancel
    await wait(/Skillz · Discover · Installed · \[Sources\]/);
    expect(Object.values(JSON.parse(await readFile(path.join(dataDir, 'installed.json'), 'utf8')))).toHaveLength(1);
    await removeSource(); await keys('Escape');
    await wait(/Skillz · Discover · Installed · \[Sources\]/);
    await removeSource(); await keys('Up'); await enter(); // yellow keep branch
    await wait(/No items available/);
    expect(Object.values(JSON.parse(await readFile(path.join(dataDir, 'installed.json'), 'utf8')))).toEqual([expect.objectContaining({ abandoned: true, enabled: true })]);
    await keys('C-Left'); await wait(/\[abandoned\]/); expect(await screen()).toContain('source removed');
    await keys('C-Right'); await wait(/Skillz · Discover · Installed · \[Sources\]/);
    // Re-add through the real RPC/TUI path: no reinstall or collision approval.
    await keys('C-a'); await wait(/Add source/); await keys('Down'); await enter();
    await wait(/Source URL/); await literal(path.join(root, 'source')); await enter();
    await wait(/Optional HTTP auth env-var NAME/); await enter();
    await wait(/Skillz · Discover · Installed · \[Sources\]/);
    expect(Object.values(JSON.parse(await readFile(path.join(dataDir, 'installed.json'), 'utf8')))[0]).not.toHaveProperty('abandoned');
    await removeSource(); await keys('Up', 'Up'); await enter(); // red remove branch
    await wait(/No items available/);
    await expect(readFile(path.join(dataDir, 'installed.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(root, 'source/probe/SKILL.md'), 'utf8')).toContain('Updated body');
    expect(await readFile(path.join(root, 'config/opencode/skills/probe/SKILL.md'), 'utf8')).toBe(skill);
    await keys('C-Right'); await wait(/Skillz · Discover · Installed · Sources · \[Errors\]/);
    await wait(/\[collision\]/);
    await keys('C-x'); await wait(/Clear all errors/); await wait(/Default: No/); await keys('Up'); await enter();
    await wait(/No items available/);
    await keys('Escape'); await wait(/Ask anything/);
  } finally {
    await tmux('kill-server').catch(() => {});
    // tmux exits before the child finishes flushing its isolated runtime state.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 90000);
