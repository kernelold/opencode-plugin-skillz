import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSource, sourceId, hasMarketplace } from '../src/source.js';
import { parseFrontmatter, stripFrontmatter } from '../src/frontmatter.js';

describe('parseSource', () => {
  it.each([
    ['https://host/one.md', { type: 'md-url', url: 'https://host/one.md' }],
    ['https://host/x.zip', { type: 'archive-url', url: 'https://host/x.zip', format: 'zip' }],
    ['https://host/x.tar.gz', { type: 'archive-url', url: 'https://host/x.tar.gz', format: 'tar.gz' }],
    ['https://host/x.tgz', { type: 'archive-url', url: 'https://host/x.tgz', format: 'tgz' }],
    ['https://host/folder/', { type: 'http-folder', url: 'https://host/folder/' }],
    ['git@host:org/repo.git', { type: 'git', url: 'git@host:org/repo.git' }],
    ['https://host/org/repo.git#v1:skills/a', { type: 'git', url: 'https://host/org/repo.git', ref: 'v1', subpath: 'skills/a' }],
    ['ssh://git@host/org/repo#main', { type: 'git', url: 'ssh://git@host/org/repo', ref: 'main' }],
    ['https://github.com/org/repo/tree/main/skills/a', { type: 'git', url: 'https://github.com/org/repo.git', ref: 'main', subpath: 'skills/a' }],
    ['https://host/.claude-plugin/marketplace.json', { type: 'marketplace-url', url: 'https://host/.claude-plugin/marketplace.json' }],
    ['/tmp/skill', { type: 'local', path: '/tmp/skill' }],
    ['file:///tmp/skill', { type: 'local', path: '/tmp/skill' }],
    ['./skill', { type: 'local', path: path.resolve('skill') }],
    ['file:///tmp/repo.git#main', { type: 'git', url: 'file:///tmp/repo.git', ref: 'main' }],
  ])('%s', (input, expected) => expect(parseSource(input)).toEqual(expected));
  it('accepts an archive checksum fragment', () => expect(parseSource(`https://host/a.zip#sha256=${'a'.repeat(64)}`)).toMatchObject({ sha256: 'a'.repeat(64) }));
  it('rejects empty input and inline HTTP secrets', () => {
    for (const input of ['', 'https://u:secret@host/a.md', 'https://host/a.md?key=secret']) expect(() => parseSource(input)).toThrow();
  });
  it('has stable, path-safe, ref-sensitive ids', () => {
    expect(sourceId('git@host:a/repo.git#one')).toMatch(/^repo-[a-f0-9]{12}$/);
    expect(sourceId('git@host:a/repo.git#one')).toBe(sourceId({ ref: 'one', url: 'git@host:a/repo.git', type: 'git' }));
    expect(sourceId('git@host:a/repo.git#one')).not.toBe(sourceId('git@host:a/repo.git#two'));
  });
  it('detects marketplace paths without I/O', () => {
    expect(hasMarketplace(['./.claude-plugin/marketplace.json'])).toBe(true);
    expect(hasMarketplace(['SKILL.md'])).toBe(false);
  });
});
describe('frontmatter', () => {
  it.each([
    ['---\nname: hello\nunknown: 3\n---\nBody\n---\nTail', 'Body\n---\nTail'],
    ['---\r\ndescription: test\r\n---\r\nBody', 'Body'],
    ['Plain\n---\nBody', 'Plain\n---\nBody'],
    ['---\nunterminated', '---\nunterminated'],
    ['---\ninvalid: [\n---\nBody', 'Body'],
    ['---\n- array\n---\nBody', 'Body'],
    ['\uFEFF---\nname: name\n...\nBody', 'Body'],
  ])('strips only a leading complete block: %j', (input, body) => expect(stripFrontmatter(input)).toBe(body));
  it('preserves unknown fields', () => expect(parseFrontmatter('---\nx-custom: yes\n---\nx').data).toEqual({ 'x-custom': 'yes' }));
});
