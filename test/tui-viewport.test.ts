import { describe, expect, it } from 'vitest';
import { dialogViewport, revealViewport, wrappedRows, fitChrome } from '../src/tui/viewport.js';
import { tabs, tabStrip, emptyHint } from '../src/tui/model.js';

describe('responsive dialog viewport', () => {
  it.each(tabs)('keeps the active %s tab visible without wrapping', tab => {
    for (const width of [1, 3, 10, 20, 30, 50, 70, 80, 150]) {
      const strip = tabStrip(tab, width);
      expect(strip.length).toBeLessThanOrEqual(width);
      if (width >= tab.length + 2) expect(strip).toContain(`[${tab}]`);
    }
  });
  it.each([1, 3, 5, 8, 12, 24, 48])('fits main-menu chrome without overflowing at %i rows', rows => {
    const sizes = fitChrome(rows, [1, 1, 2, 1, 1]);
    expect(sizes.every(size => size >= 0)).toBe(true);
    expect(sizes.reduce((n, size) => n + size, 0)).toBeLessThanOrEqual(Math.max(1, rows - 3));
  });
  it('distinguishes individual skills, installed entries and configured sources in empty states', () => {
    expect(emptyHint('Skills')).toContain('No installed skills');
    expect(emptyHint('Installed sources')).toContain('No installed source entries');
    expect(emptyHint('Sources')).toContain('No configured marketplaces or direct sources');
  });
  it.each([1, 5, 10, 12, 24, 48, 100])('never budgets negative panes at %i rows', rows => {
    const layout = dialogViewport(rows, 9, [100, 44]);
    expect(layout.height).toBeLessThanOrEqual(Math.max(1, rows - 3));
    expect(layout.sizes.every(size => size >= 0)).toBe(true);
    if (rows >= 24) expect(layout.sizes[1]).toBeGreaterThanOrEqual(3);
  });
  it('grows, shrinks and returns spare metadata space to the checklist', () => {
    expect(dialogViewport(24, 9, [4, 44]).sizes).toEqual([4, 8]);
    expect(dialogViewport(48, 9, [4, 44]).sizes).toEqual([4, 32]);
    expect(dialogViewport(12, 7, [4, 44]).sizes).toEqual([0, 2]);
  });
  it('reveals focus in either direction, after resize and for one-row/oversized rows', () => {
    expect(revealViewport(0, 5, 8, 9)).toBe(4);
    expect(revealViewport(4, 5, 2, 3)).toBe(2);
    expect(revealViewport(4, 2, 8, 9)).toBe(7);
    expect(revealViewport(0, 1, 8, 9)).toBe(8);
    expect(revealViewport(0, 2, 8, 13)).toBe(8);
    expect(revealViewport(4, 5, 5, 6)).toBe(4);
  });
  it('budgets word wrapping rather than only dividing the character count', () => {
    expect(wrappedRows('aaaaaa bbbbbb cccccc', 10)).toBe(3);
    expect(wrappedRows('123456789012345', 10)).toBe(2);
    expect(wrappedRows('\nshort\n', 10)).toBe(3);
    expect(wrappedRows('long', 0)).toBe(4);
  });
});
