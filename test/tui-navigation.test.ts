import { describe, expect, it } from 'vitest';
import { regions, RegionFocus, pageRow } from '../src/tui/navigation.js';
import { tabs } from '../src/tui/model.js';

describe('section navigation', () => {
  it.each(tabs)('orders %s as strip, whole list, whole footer', () => {
    expect(regions(true, false, 37, 3)).toEqual([
      { name: 'tabs', start: 0, count: 1 }, { name: 'list', start: 1, count: 37 }, { name: 'actions', start: 38, count: 3 },
    ]);
  });
  it('orders install choices, checklist, bulk actions', () => {
    expect(regions(false, true, 39, 4).map(r => r.name)).toEqual(['choices', 'list', 'actions']);
  });
  it('wraps forward/reverse, restores a row and lands on the first action', () => {
    const order = regions(true, false, 37, 3), focus = new RegionFocus();
    expect(focus.jump(order, 24, 1)).toBe(38);
    expect(focus.jump(order, 40, 1)).toBe(0);
    expect(focus.jump(order, 0, 1)).toBe(24);
    expect(focus.jump(order, 24, -1)).toBe(0);
    expect(focus.jump(order, 0, -1)).toBe(38);
    expect(focus.jump(order, 38, -1)).toBe(24);
    expect(focus.jump(regions(true, false, 2, 3), 0, 1)).toBe(2);
  });
  it('remembers install checklist separately from Yes/No and skips empty lists', () => {
    const focus = new RegionFocus(), order = regions(false, true, 39, 4);
    expect(focus.jump(order, 25, 1)).toBe(39);
    expect(focus.jump(order, 39, 1)).toBe(0);
    expect(focus.jump(order, 1, 1)).toBe(25);
    expect(focus.jump(order, 25, -1)).toBe(1);
    expect(focus.jump(regions(true, false, 0, 2), 0, 1)).toBe(1);
    expect(focus.jump(regions(false, false, 0, 0), 0, 1)).toBe(0);
  });
  it('keeps single-region row/button cycling in both directions', () => {
    const focus = new RegionFocus();
    expect(focus.jump(regions(false, false, 3, 0), 2, 1)).toBe(0);
    expect(focus.jump(regions(false, false, 3, 0), 0, -1)).toBe(2);
    expect(focus.jump(regions(false, false, 1, 0), 0, 1)).toBe(0);
  });
  it('moves one viewport by laid-out row heights, clamps and advances oversized rows', () => {
    expect(pageRow([2, 3, 4, 1, 5], 0, 5, 1)).toBe(2);
    expect(pageRow([2, 3, 4, 1, 5], 2, 5, -1)).toBe(0);
    expect(pageRow([20, 1], 0, 5, 1)).toBe(1);
    expect(pageRow([1, 1], 1, 10, 1)).toBe(1);
    expect(pageRow([1, 1], 0, 10, -1)).toBe(0);
  });
});
