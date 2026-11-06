export interface Region { name: 'tabs' | 'list' | 'choices' | 'actions'; start: number; count: number }

// Indices match the existing arrow sequence. Tab skips regions, not rows.
export function regions(hasTabs: boolean, checklist: boolean, rows: number, actions: number): Region[] {
  const offset = hasTabs ? 1 : 0;
  return [
    ...(hasTabs ? [{ name: 'tabs' as const, start: 0, count: 1 }] : []),
    ...(checklist ? [{ name: 'choices' as const, start: offset, count: Math.min(2, rows) }] : []),
    { name: 'list' as const, start: offset + (checklist ? 2 : 0), count: rows - (checklist ? 2 : 0) },
    { name: 'actions' as const, start: offset + rows, count: actions },
  ].filter(region => region.count > 0);
}

export class RegionFocus {
  private readonly last = new Map<Region['name'], number>();
  remember(order: Region[], index: number): void {
    const region = order.find(r => index >= r.start && index < r.start + r.count);
    if (region) this.last.set(region.name, index - region.start);
  }
  row(region: Region): number { return region.start + Math.min(this.last.get(region.name) ?? 0, region.count - 1); }
  jump(order: Region[], index: number, direction: number): number {
    this.remember(order, index);
    if (!order.length) return index;
    if (order.length === 1) {
      const region = order[0];
      return region.start + (index - region.start + direction + region.count) % region.count;
    }
    const current = order.findIndex(r => index >= r.start && index < r.start + r.count);
    const next = order[(current + direction + order.length) % order.length];
    // Actions are a group; always land on its first button.
    return next.name === 'actions' ? next.start : this.row(next);
  }
}

export function pageRow(heights: readonly number[], selected: number, viewport: number, direction: number): number {
  let index = selected, distance = 0;
  while (index + direction >= 0 && index + direction < heights.length) {
    distance += Math.max(1, heights[direction > 0 ? index : index - 1]);
    index += direction;
    if (distance >= Math.max(1, viewport)) break;
  }
  return index;
}
