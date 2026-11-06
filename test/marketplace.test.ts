import { describe, it, expect } from 'vitest';
import { parseMarketplace } from '../src/marketplace.js';

const catalog = (plugins: unknown[]) => ({ name: 'example-catalog', owner: { name: 'Example' }, plugins });
describe('marketplaces', () => {
  it('parses git-subdir entries without changing SSH URLs', () => {
    const result = parseMarketplace(catalog([{ name: 'sample-one', description: 'Sample', version: '2', category: 'group-b', source: { source: 'git-subdir', url: 'git@github.com:org/repo.git', path: 'skills/group-a/nested/sample-one', ref: 'main', sha: 'a'.repeat(40) } }]), { url: 'https://example.test/marketplace.json' });
    expect(result.issues).toEqual([]);
    expect(result.entries[0]).toMatchObject({ name: 'sample-one', version: '2', source: { type: 'git', url: 'git@github.com:org/repo.git', subpath: 'skills/group-a/nested/sample-one', sha: 'a'.repeat(40) }, manifest: { category: 'group-b' } });
  });
  it('parses example-org/skills explicit lists and preserves strict/unknown fields', () => {
    const result = parseMarketplace(catalog([{ name: 'document-skills', source: './', strict: false, skills: ['./skills/pdf', './skills/docx'], keywords: ['documents'] }]), { rootDir: '/checkout' });
    expect(result.entries[0]).toMatchObject({ source: { type: 'local', path: '/checkout' }, skills: ['./skills/pdf', './skills/docx'], manifest: { strict: false, keywords: ['documents'] } });
  });
  it('supports github, url and archive sources', () => {
    const result = parseMarketplace(catalog([
      { name: 'github', source: { source: 'github', repo: 'org/repo', ref: 'v1' } },
      { name: 'url', source: { source: 'url', url: 'https://host/repo.git' } },
      { name: 'zip', source: { source: 'archive', url: 'https://host/a.zip', sha256: 'A'.repeat(64) } },
    ]), { rootDir: '/root' });
    expect(result.issues).toEqual([]); expect(result.entries).toHaveLength(3);
    expect(result.entries[0].source).toMatchObject({ type: 'git', url: 'https://github.com/org/repo.git', ref: 'v1' });
    expect(result.entries[2].source).toMatchObject({ sha256: 'a'.repeat(64) });
  });
  it('reports unsupported components and source types rather than aborting', () => {
    const result = parseMarketplace(catalog([
      { name: 'one', source: { source: 'url', url: 'https://host/a.git' }, commands: [], agents: [], hooks: {}, mcpServers: {}, lspServers: {}, outputStyles: [] },
      { name: 'two', source: { source: 'npm', package: 'nope' } },
    ]), { rootDir: '/root' });
    expect(result.entries).toHaveLength(1); expect(result.issues.filter(i => i.code === 'unsupported-component')).toHaveLength(6);
    expect(result.issues.at(-1)?.code).toBe('unsupported-source');
  });
  it.each([
    { source: 'github', repo: 'org/repo', sha: 'A'.repeat(40) },
    { source: 'github', repo: 'org/repo', sha: 'abc' },
    { source: 'archive', url: 'https://host/a.zip', sha256: 'bad' },
    { source: 'git-subdir', url: 'git@host:a.git', path: '../escape' },
  ])('reports bad pins/path: %j', source => {
    const result = parseMarketplace(catalog([{ name: 'bad', source }]), { rootDir: '/root' });
    expect(result.entries).toEqual([]); expect(result.issues[0].code).toBe('invalid-entry');
  });
  it('cannot resolve relative URL catalog entries', () => expect(parseMarketplace(catalog([{ name: 'bad', source: './' }]), { url: 'https://host/marketplace.json' }).issues[0].message).toContain('cannot resolve relative'));
  it('validates required catalog fields', () => expect(() => parseMarketplace('{}', { rootDir: '/root' })).toThrow('requires'));
});
