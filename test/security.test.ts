import { describe, expect, it } from 'vitest';
import { safeJoin, isInside, DEFAULT_LIMITS } from '../src/security.js';

describe('shared security guards', () => {
  it.each(['../outside', '/absolute', 'a/../outside', '..', 'a\\b', 'C:/file', 'https://other.invalid/file', 'a\0b'])('rejects unsafe path %j', relative => {
    expect(() => safeJoin('/tmp/root', relative)).toThrow('Unsafe path');
  });
  it('joins safe paths and distinguishes sibling prefixes', () => {
    expect(safeJoin('/tmp/root', './scripts/run.sh')).toBe('/tmp/root/scripts/run.sh');
    expect(isInside('/tmp/root', '/tmp/root')).toBe(true);
    expect(isInside('/tmp/root', '/tmp/root/file')).toBe(true);
    expect(isInside('/tmp/root', '/tmp/root-other/file')).toBe(false);
    expect(isInside('/tmp/root', '/tmp/outside')).toBe(false);
  });
  it('has finite positive default limits', () => {
    for (const limit of Object.values(DEFAULT_LIMITS)) { expect(limit).toBeGreaterThan(0); expect(Number.isFinite(limit)).toBe(true); }
  });
});
