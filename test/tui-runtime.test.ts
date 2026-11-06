import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { it, expect } from 'vitest';
import { Store } from '../src/store.js';
import { server, skillText } from './helpers.js';

const exec = promisify(execFile);
it.skipIf(process.env.OPENCODE_TUI_SMOKE !== '1')('pins every main tab and reveals multiline focus in short and narrow terminals', async () => {
  expect((await exec('opencode', ['--version'])).stdout.trim()).toBe('opencode v2.0.24');
  const root = await mkdtemp(path.join(tmpdir(), 'skillz-main-test-'));
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const socket = `skillz-main-${process.pid}`;
  const dataDir = path.join(root, 'skillz');
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    XDG_STATE_HOME: path.join(root, 'state'), XDG_CACHE_HOME: path.join(root, 'cache'), OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_CONFIG: path.join(root, 'project/opencode.json') };
  const tmux = async (...args: string[]) => (await exec('tmux', ['-L', socket, ...args], { env })).stdout;
  const keys = (...args: string[]) => tmux('send-keys', '-t', 'probe', ...args);
  const screen = () => tmux('capture-pane', '-p', '-t', 'probe');
  const wait = async (pattern: RegExp) => {
    let output = '';
    for (let i = 0; i < 160; i++) { output = await screen(); if (pattern.test(output)) return output; await delay(100); }
    throw new Error(`TUI did not show ${pattern}:\n${output}`);
  };
  try {
    for (const dir of ['project', 'config/opencode']) await mkdir(path.join(root, dir), { recursive: true });
    const fixture = new Store({ dataDir });
    for (let i = 0; i < 37; i++) {
      const dir = path.join(root, `entry-${String(i).padStart(2, '0')}`, `skill-${String(i).padStart(2, '0')}`);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'SKILL.md'), `---\nname: Skill${String(i).padStart(2, '0')}\ndescription: A long description that wraps across several terminal lines while preserving the footer and selected skill name.\n---\nBody\n`);
      const source = await fixture.addSource(path.dirname(dir)); await fixture.install(source.id);
      await fixture.reportIssues([{ code: 'probe', message: `Error${String(i).padStart(2, '0')} long error text that wraps across lines in the scrolling list` }], source.id);
    }
    const config = JSON.stringify({ plugins: [{ package: repository, options: { dataDir, automaticUpdates: false } }] });
    await writeFile(path.join(root, 'project/opencode.json'), config); await writeFile(path.join(root, 'config/opencode/opencode.json'), config);
    await tmux('new-session', '-d', '-s', 'probe', '-x', '80', '-y', '24', `opencode --standalone ${path.join(root, 'project')}`);
    await wait(/Ask anything/); await keys('-l', '/skillz'); await wait(/Manage skills \(Skillz\)/); await keys('Enter');
    for (const tab of ['Skills', 'Discover', 'Installed sources', 'Sources', 'Errors']) {
      await wait(new RegExp(`\\[${tab}\\]`));
      const rowName = (index: number) => tab === 'Skills' ? `Skill${String(index).padStart(2, '0')}`
        : tab === 'Errors' ? `[probe] Error${String(36 - index).padStart(2, '0')}` : `entry-${String(index).padStart(2, '0')}`;
      const pinned = async (focused?: string) => {
        const output = await screen();
        expect(output).toContain(`[${tab}]`); expect(output).toContain('Esc:');
        expect(output).toContain(tab === 'Skills' || tab === 'Installed sources' ? 'Check updates' : 'Refresh');
        if (tab === 'Discover' || tab === 'Sources') expect(output).toContain('Add source');
        if (tab === 'Errors') expect(output).toContain('Clear errors');
        expect(output).toMatch(/›/);
        if (focused) expect(output).toContain(`› ${focused}`);
        return output;
      };
      // Tab bypasses 37 rows at 24x80, without disturbing the visible list.
      await keys('Down', 'Down', 'Down'); await delay(100);
      const previous = await pinned(rowName(3));
      await keys('Tab'); await wait(new RegExp(`› \\[ ${tab === 'Skills' || tab === 'Installed sources' ? 'Check updates' : 'Refresh'} \\]`));
      const footerFocused = await pinned();
      expect(footerFocused).toContain(rowName(3));
      // Compare the list text, excluding only its focus marker.
      const listText = (capture: string) => capture.split('\n').filter(line => line.includes(tab === 'Skills' ? 'Skill0' : tab === 'Errors' ? 'Error3' : 'entry-0')).map(line => line.replace('› ', '  '));
      expect(listText(footerFocused)).toEqual(listText(previous));
      await keys('Tab'); await wait(/› Skillz:/); await pinned();
      await keys('Tab'); await wait(new RegExp(`› ${rowName(3).replace(/[\[\]]/g, '\\$&')}`)); await pinned(rowName(3));
      await keys('BTab'); await wait(/› Skillz:/);
      await keys('BTab'); await wait(new RegExp(`› \\[ ${tab === 'Skills' || tab === 'Installed sources' ? 'Check updates' : 'Refresh'} \\]`));
      await keys('BTab'); await wait(new RegExp(`› ${rowName(3).replace(/[\[\]]/g, '\\$&')}`));
      await keys('Home'); await wait(new RegExp(`› ${rowName(0).replace(/[\[\]]/g, '\\$&')}`));
      await keys('NPage'); await delay(100); expect(await screen()).not.toContain(`› ${rowName(0)}`);
      await keys('Home'); await wait(new RegExp(`› ${rowName(0).replace(/[\[\]]/g, '\\$&')}`));
      // First row -> strip -> last action -> strip -> list, then every row.
      await keys('Up'); await delay(80); await pinned(); await keys('Up'); await delay(80); await pinned();
      await keys('Down', 'Down'); await delay(80);
      for (let i = 0; i < 37; i++) { await wait(new RegExp(`› ${rowName(i).replace(/[\[\]]/g, '\\$&')}`)); await pinned(rowName(i)); await keys('Down'); await delay(35); }
      await keys('Up'); await delay(80); await pinned(rowName(36));
      for (const [height, width] of [[12, 60], [48, 100], [24, 80]]) {
        await tmux('resize-window', '-t', 'probe', '-x', String(width), '-y', String(height)); await delay(400);
        await wait(new RegExp(`› ${rowName(36).replace(/[\[\]]/g, '\\$&')}`)); await pinned(rowName(36));
      }
      await keys('Right'); await delay(150); await keys('Left');
      await wait(new RegExp(`\\[${tab}\\]`));
      await wait(new RegExp(`› ${rowName(36).replace(/[\[\]]/g, '\\$&')}`)); await pinned(rowName(36));
      await keys('-l', tab === 'Skills' ? 'Skill36' : tab === 'Errors' ? 'Error00' : 'entry-36');
      await delay(200); await pinned(rowName(36));
      await writeFile(path.join(tmpdir(), `skillz-main-${tab.toLowerCase().replace(/ /g, '-')}.txt`), await screen());
      await keys('Right');
    }
  } finally {
    await tmux('kill-server').catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 90000);
it.skipIf(process.env.OPENCODE_TUI_SMOKE !== '1')('keeps install buttons and hints visible with 37 expanded skills in a short, resized terminal', async () => {
  expect((await exec('opencode', ['--version'])).stdout.trim()).toBe('opencode v2.0.24');
  const root = await mkdtemp(path.join(tmpdir(), 'skillz-viewport-test-'));
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const socket = `skillz-viewport-${process.pid}`;
  const dataDir = path.join(root, 'skillz');
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    XDG_STATE_HOME: path.join(root, 'state'), XDG_CACHE_HOME: path.join(root, 'cache'), OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_CONFIG: path.join(root, 'project/opencode.json') };
  const tmux = async (...args: string[]) => (await exec('tmux', ['-L', socket, ...args], { env })).stdout;
  const keys = (...args: string[]) => tmux('send-keys', '-t', 'probe', ...args);
  const screen = () => tmux('capture-pane', '-p', '-t', 'probe');
  const wait = async (pattern: RegExp) => {
    let output = '';
    for (let i = 0; i < 160; i++) {
      output = await screen(); if (pattern.test(output)) return output;
      await delay(100);
    }
    throw new Error(`TUI did not show ${pattern}:\n${output}`);
  };
  const pinned = async () => {
    const output = await screen();
    expect(output).toContain('[ Yes, install ]'); expect(output).toContain('[ No, cancel ]');
    expect(output).toContain('The following skills will be installed'); expect(output).toContain('Esc: cancel');
    return output;
  };
  try {
    for (const dir of ['project', 'config/opencode']) await mkdir(path.join(root, dir), { recursive: true });
    for (let i = 0; i < 37; i++) {
      const dir = path.join(root, 'source', `group-${i % 7}`, `skill-${String(i).padStart(2, '0')}`);
      await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'SKILL.md'), skillText(`Skill${i}`));
    }
    const fixture = new Store({ dataDir }); await fixture.addSource(path.join(root, 'source'));
    const config = JSON.stringify({ plugins: [{ package: repository, options: { dataDir, automaticUpdates: false } }] });
    await writeFile(path.join(root, 'project/opencode.json'), config); await writeFile(path.join(root, 'config/opencode/opencode.json'), config);
    await tmux('new-session', '-d', '-s', 'probe', '-x', '150', '-y', '24', `opencode --standalone ${path.join(root, 'project')}`);
    await wait(/Ask anything/); await keys('-l', '/skillz'); await wait(/Manage skills \(Skillz\)/); await keys('Enter');
    await wait(/Skills · \[Discover\]/); await wait(/› source/); await keys('Enter'); await wait(/Default: Yes/);
    await keys('e'); await wait(/▾ \[x\] group-0/); await pinned();
    await keys('Tab'); await wait(/› ▾ \[x\] group-0/);
    await keys('End'); await wait(/›\s+\[x\] skill-34/);
    await keys('Tab'); await wait(/› \[ Select all skills \]/); await pinned();
    await keys('Tab'); await wait(/› \[ Yes, install \]/);
    await keys('Tab'); await wait(/›\s+\[x\] skill-34/);
    await keys('BTab'); await wait(/› \[ Yes, install \]/);
    // Traverse the whole expanded checklist, not just the initially visible rows.
    for (let i = 0; i < 45; i++) { await keys('Down'); await delay(35); await pinned(); }
    await wait(/›\s+\[x\] skill-34/);
    await writeFile(path.join(tmpdir(), 'skillz-expanded-short.txt'), await pinned());
    await tmux('resize-window', '-t', 'probe', '-x', '150', '-y', '12');
    await delay(400); await wait(/›\s+\[x\] skill-34/); await pinned();
    await keys('Left'); await wait(/› ▾ \[x\] group-6/); await pinned();
    await keys('c'); await wait(/› ▸ \[x\] group-6/); await pinned();
    await keys('e'); await wait(/› ▾ \[x\] group-6/); await pinned();
    await tmux('resize-window', '-t', 'probe', '-x', '90', '-y', '48'); await delay(400); await pinned();
    await keys('n'); await wait(/0 of 37 selected/); await pinned(); await keys('a');
    await keys('Escape'); await wait(/Skills · \[Discover\]/);
    await expect(readFile(path.join(dataDir, 'installed.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await tmux('kill-server').catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60000);
it.skipIf(process.env.OPENCODE_TUI_SMOKE !== '1')('refreshes the native skill picker immediately after install without /reload', async () => {
  expect((await exec('opencode', ['--version'])).stdout.trim()).toBe('opencode v2.0.24');
  const root = await mkdtemp(path.join(tmpdir(), 'skillz-inventory-test-'));
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const socket = `skillz-inventory-${process.pid}`;
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    XDG_STATE_HOME: path.join(root, 'state'), XDG_CACHE_HOME: path.join(root, 'cache'), OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_CONFIG: path.join(root, 'project/opencode.json') };
  const tmux = async (...args: string[]) => (await exec('tmux', ['-L', socket, ...args], { env })).stdout;
  const keys = (...args: string[]) => tmux('send-keys', '-t', 'probe', ...args);
  const wait = async (pattern: RegExp) => {
    let screen = '';
    for (let i = 0; i < 160; i++) {
      screen = await tmux('capture-pane', '-p', '-t', 'probe');
      if (pattern.test(screen)) return screen;
      await delay(100);
    }
    throw new Error(`TUI did not show ${pattern}:\n${screen}`);
  };
  const enter = async () => { await keys('Enter'); await delay(150); };
  const action = async (title: string) => {
    for (let i = 0; i < 20; i++) {
      if ((await tmux('capture-pane', '-p', '-t', 'probe')).includes(`› [ ${title} ]`)) { await enter(); return; }
      await keys('Down'); await delay(100);
    }
    throw new Error(`Arrow navigation did not reach ${title}`);
  };
  try {
    for (const dir of ['project', 'config/opencode', 'source/group/inventory-probe']) await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, 'source/group/inventory-probe/SKILL.md'), '---\nname: InventoryProbe\ndescription: Fresh native inventory probe\n---\nProbe body\n');
    const config = JSON.stringify({ plugins: [{ package: repository, options: { dataDir: path.join(root, 'skillz') } }] });
    await writeFile(path.join(root, 'project/opencode.json'), config);
    await writeFile(path.join(root, 'config/opencode/opencode.json'), config);
    await tmux('new-session', '-d', '-s', 'probe', '-x', '150', '-y', '48', `opencode --standalone ${path.join(root, 'project')}`);
    await wait(/Ask anything/);
    // Prime OpenCode's own inventory before installing a new ID.
    await keys('-l', '/skills'); await wait(/Skills/); await enter(); await wait(/Skills\s+esc/); await keys('Escape'); await delay(200);
    await keys('-l', '/skillz'); await wait(/Manage skills \(Skillz\)/); await enter(); await wait(/Skills · \[Discover\]/);
    await action('Refresh'); await keys('Up'); await wait(/› Skillz/); await keys('Down');
    await keys('Right'); await wait(/\[Installed sources\]/); await keys('Right'); await wait(/\[Sources\]/);
    await keys('Right'); await wait(/\[Errors\]/); await keys('Right'); await wait(/\[Skills\]/);
    expect(await wait(/No installed skills/)).toContain('Discover');
    await keys('Right'); await wait(/Skills · \[Discover\]/);
    await action('Add source'); await wait(/Add source/); await keys('Down'); await enter();
    await wait(/Source URL/); await keys('-l', path.join(root, 'source'));
    await keys('Tab'); await wait(/› \[ Cancel \]/);
    await keys('BTab'); await delay(100); expect(await tmux('capture-pane', '-p', '-t', 'probe')).not.toContain('› [ Cancel ]');
    await enter();
    await wait(/Optional HTTP auth env-var NAME/); await enter(); await wait(/Skills · \[Discover\]/);
    await enter(); await wait(/Install skill\?/); await wait(/Default: Yes/);
    await keys('Down', 'Down'); await wait(/› ▾ \[x\] group/);
    await keys('Left'); await wait(/› ▸ \[x\] group/);
    await keys('Right'); await wait(/› ▾ \[x\] group/);
    await keys('Right'); await wait(/›\s+\[x\] inventory-probe/);
    await keys('Left'); await wait(/› ▾ \[x\] group/);
    await keys('Left'); await wait(/› ▸ \[x\] group/);
    await keys('Up', 'Up'); await wait(/› \[ Yes, install \]/); await enter();
    await wait(/Skills · \[Discover\]/); await keys('Escape'); await wait(/Ask anything/);
    await keys('-l', '/skills'); await wait(/Skills/); await enter();
    expect(await wait(/InventoryProbe/)).toContain('Fresh native inventory probe');
    await keys('Escape'); await delay(200); await keys('-l', '@inventory-probe');
    expect(await wait(/@inventory-probe\s+Fresh native inventory probe/)).toContain('@inventory-probe');
    await keys('Escape'); await delay(200); await keys(...Array.from('@inventory-probe', () => 'BSpace')); await delay(200);
    const manager = async () => {
      await keys('-l', '/skillz'); await wait(/Manage skills \(Skillz\)/); await enter();
    };
    const picker = async () => {
      await keys('Escape'); await delay(200);
      await keys('-l', '/skills'); await wait(/Skills/); await enter(); await wait(/Skills\s+esc/);
      return wait(/OpenCode\s+Use this skill/);
    };
    await manager(); await wait(/\[Skills\]/);
    expect(await wait(/› InventoryProbe/)).toContain('Fresh native inventory probe');
    expect(await wait(/› InventoryProbe/)).toContain('group');
    await keys('Up'); await wait(/› Skillz/); await keys('Down'); await wait(/› InventoryProbe/);
    await keys('C-Down', 'M-Down', 'S-Down', 'C-Right', 'M-Right', 'S-Right'); await delay(150);
    expect(await tmux('capture-pane', '-p', '-t', 'probe')).toContain('› InventoryProbe');
    expect(await tmux('capture-pane', '-p', '-t', 'probe')).toContain('Skillz: [Skills]');
    await enter(); await wait(/Skill actions · InventoryProbe/); await keys('Down'); await enter();
    await wait(/\[disabled\]/);
    expect(await picker()).not.toContain('InventoryProbe');
    await keys('Escape'); await delay(200); await manager(); await wait(/\[Skills\]/);
    await keys('Space');
    await wait(/\[enabled\]/);
    expect(await picker()).toContain('InventoryProbe');
    await keys('Escape'); await delay(200); await manager(); await wait(/\[Skills\]/);
    await enter(); await wait(/Skill actions · InventoryProbe/); await keys('Down', 'Down'); await enter();
    await wait(/Remove installed skill\?/); await wait(/Default: No/); await enter();
    await wait(/\[Skills\]/); // Default No leaves the skill installed.
    await enter(); await wait(/Skill actions · InventoryProbe/); await keys('Down', 'Down'); await enter();
    await wait(/Remove installed skill\?/); await wait(/Default: No/); await keys('Up'); await enter();
    await wait(/No installed skills/);
    expect(await picker()).not.toContain('InventoryProbe');
  } finally {
    await tmux('kill-server').catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60000);
// Opt-in: needs the real pinned CLI, tmux, and `npm run build` first. Every
// file/service/socket belongs to this test; the user's config/state is untouched.
it.skipIf(process.env.OPENCODE_TUI_SMOKE !== '1')('loads /skillz on the real 2.0.24 home screen and manages a colliding local source', async () => {
  expect((await exec('opencode', ['--version'])).stdout.trim()).toBe('opencode v2.0.24');
  const root = await mkdtemp(path.join(tmpdir(), 'skillz-tui-test-'));
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
  const action = async (title: string) => {
    for (let i = 0; i < 20; i++) {
      if ((await screen()).includes(`› [ ${title} ]`)) { await enter(); return; }
      await keys('Down'); await delay(100);
    }
    throw new Error(`Arrow navigation did not reach ${title}:\n${await screen()}`);
  };
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
    await wait(/Skills · \[Discover\]/);
    await action('Refresh'); await action('Add source'); await wait(/Add source/); await keys('Down'); await enter();
    await wait(/Source URL/); await literal(path.join(root, 'source')); await enter();
    await wait(/Optional HTTP auth env-var NAME/); await enter();
    await wait(/Skills · \[Discover\]/);
    await enter(); await wait(/Install skill\?/);
    expect(await wait(/Default: Yes/)).toContain('Skills: probe (1)');
    expect(await screen()).toContain('Trusted — you added this source');
    expect(await screen()).toContain('The following skills will be installed:');
    await writeFile(path.join(tmpdir(), 'skillz-install.txt'), await screen());
    const installAnsi = await tmux('capture-pane', '-e', '-p', '-t', 'probe');
    await writeFile(path.join(tmpdir(), 'skillz-install.ansi.txt'), installAnsi);
    // Theme values vary; assert that real rendering emitted distinct colour
    // sequences for the positive/negative choices, not particular RGB values.
    const choiceColors = installAnsi.split('\n').filter(line => /\[ (?:Yes, install|No, cancel) \]/.test(line))
      .map(line => [...line.matchAll(/\x1b\[38;[^m]+m/g)].map(match => match[0]));
    expect(choiceColors).toHaveLength(2);
    expect(choiceColors[0]).not.toEqual(choiceColors[1]);
    await keys('C-Down', 'M-Down', 'S-Down'); await literal('hl'); await delay(150);
    expect(await screen()).toContain('› [ Yes, install ]');
    await keys('Down', 'Down'); await delay(150);
    expect(await screen()).toContain('› [x] probe');
    await keys('Space'); await delay(150);
    expect(await screen()).toContain('› [ ] probe');
    await keys('Space', 'Up', 'Up'); await delay(150);
    expect(await screen()).toContain('› [ Yes, install ]');
    await keys('Down'); await enter(); // explicit No, cancel must not install
    await wait(/Skills · \[Discover\]/);
    await expect(readFile(path.join(dataDir, 'installed.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await enter(); await wait(/Install skill\?/); await keys('Escape');
    await wait(/Skills · \[Discover\]/);
    await expect(readFile(path.join(dataDir, 'installed.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    // Install again: explicitly approve install, then decline collision by default.
    await enter(); await wait(/Install skill\?/);
    await wait(/Default: Yes/); await enter();
    expect(await wait(/Override skill\?/)).toContain('already exists');
    await enter(); await wait(/Skills · \[Discover\]/);
    await expect(readFile(path.join(dataDir, 'installed.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    // Explicit Yes is the only path that sets confirmOverride on retry.
    await enter(); await wait(/Install skill\?/);
    await wait(/Default: Yes/); await enter();
    await wait(/Override skill\?/); await wait(/Default: No, cancel/); await keys('Up'); await enter();
    await wait(/Skills · \[Discover\]/);
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
    await keys('Right');
    const immediateScreen = await wait(/Skills · Discover · \[Installed sources\]/);
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
    await writeFile(path.join(tmpdir(), 'skillz-installed.txt'), installedScreen);
    await writeFile(path.join(tmpdir(), 'skillz-installed.ansi.txt'), await tmux('capture-pane', '-e', '-p', '-t', 'probe'));
    await enter(); expect(await wait(/Installed source/)).toContain('probe overrides');
    await enter(); await wait(/Source actions/); await enter(); // disable
    await wait(/\[disabled\]/);
    expect(Object.values(JSON.parse(await readFile(path.join(dataDir, 'installed.json'), 'utf8')))).toEqual([expect.objectContaining({ enabled: false })]);
    await writeFile(path.join(root, 'source/probe/SKILL.md'), skill + 'Updated body\n');
    await action('Check updates'); await wait(/\[update available\]/); await keys('Up');
    await enter(); await wait(/Available version:/); await enter(); await wait(/Source actions/); await keys('Down'); await enter();
    await wait(/\[disabled\]/);
    const updated = JSON.parse(await readFile(path.join(dataDir, 'installed.json'), 'utf8'));
    expect(Object.values(updated)).toEqual([expect.objectContaining({ enabled: false })]);
    expect(Object.values(updated)[0]).not.toMatchObject({ version: Object.values(installed)[0] && (Object.values(installed)[0] as { version: string }).version });
    await enter(); await wait(/Installed source/); await enter(); await wait(/Source actions/); await enter();
    await wait(/\[enabled\]/);
    // Match the later Add source dialog's unspecified exclusion policy. Install
    // stores exclude: [], while readopt deliberately compares source options
    // exactly ([] and unspecified are different identities). Keep this fixture
    // about re-adopting an identical source, not changing its selection policy.
    await fixture.addSource(path.join(root, 'source'));
    await keys('Right'); await wait(/Skills · Discover · Installed sources · \[Sources\]/);
    const removeSource = async () => {
      await enter(); await wait(/Inspect source/); await keys('Down', 'Down', 'Down'); await enter();
      expect(await wait(/Default: Cancel/)).toContain('Installed skills: 1');
      expect(await screen()).toContain(' / probe');
      expect(await screen()).toContain('Remove source AND its 1 installed skills');
      expect(await screen()).toContain('Remove source only');
    };
    await removeSource(); await enter(); // safe default Cancel
    await wait(/Skills · Discover · Installed sources · \[Sources\]/);
    expect(Object.values(JSON.parse(await readFile(path.join(dataDir, 'installed.json'), 'utf8')))).toHaveLength(1);
    await removeSource(); await keys('Escape');
    await wait(/Skills · Discover · Installed sources · \[Sources\]/);
    await removeSource(); await keys('Up'); await enter(); // yellow keep branch
    await wait(/No configured marketplaces or direct sources/);
    expect(Object.values(JSON.parse(await readFile(path.join(dataDir, 'installed.json'), 'utf8')))).toEqual([expect.objectContaining({ abandoned: true, enabled: true })]);
    await keys('Left'); await wait(/\[abandoned\]/); expect(await screen()).toContain('source removed');
    await keys('Right'); await wait(/Skills · Discover · Installed sources · \[Sources\]/);
    // Re-add through the real RPC/TUI path: no reinstall or collision approval.
    await action('Add source'); await wait(/Add source/); await keys('Down'); await enter();
    await wait(/Source URL/); await literal(path.join(root, 'source')); await enter();
    await wait(/Optional HTTP auth env-var NAME/); await enter();
    await wait(/Source added; inspect it in Discover before installing/);
    await wait(/Skills · Discover · Installed sources · \[Sources\]/);
    await expect.poll(async () => Object.values(JSON.parse(await readFile(path.join(dataDir, 'installed.json'), 'utf8')))[0], { timeout: 10000 }).not.toHaveProperty('abandoned');
    await removeSource(); await keys('Up', 'Up'); await enter(); // red remove branch
    await wait(/No configured marketplaces or direct sources/);
    await expect(readFile(path.join(dataDir, 'installed.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(root, 'source/probe/SKILL.md'), 'utf8')).toContain('Updated body');
    expect(await readFile(path.join(root, 'config/opencode/skills/probe/SKILL.md'), 'utf8')).toBe(skill);
    await keys('Right'); await wait(/Skills · Discover · Installed sources · Sources · \[Errors\]/);
    await wait(/\[collision\]/);
    await action('Refresh'); await action('Clear errors'); await wait(/Clear all errors/); await wait(/Default: No/); await keys('Up'); await enter();
    await wait(/No items available/);
    await keys('Escape'); await wait(/Ask anything/);
  } finally {
    await tmux('kill-server').catch(() => {});
    // tmux exits before the child finishes flushing its isolated runtime state.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 90000);
