// The host adds one top-padding row. Reserve that and a small screen margin;
// dialog size presets control width, not height.
export function dialogViewport(rows: number, fixed: number, panes: readonly number[]) {
  const height = Math.max(1, Math.floor(rows) - 3);
  const available = Math.max(0, height - fixed);
  const sizes = panes.map(() => 0);
  let remaining = available;
  // The last pane is the primary list. Metadata shares the spare space rather
  // than taking the checklist's minimum viewport away on short terminals.
  for (let i = panes.length - 1; i >= 0; i--) {
    sizes[i] = Math.min(panes[i], remaining, i ? Math.max(3, remaining - Math.min(panes[0], Math.floor(available / 3))) : remaining);
    remaining -= sizes[i];
  }
  return { height: Math.min(height, fixed + sizes.reduce((a, b) => a + b, 0)), sizes };
}

export function revealViewport(top: number, height: number, start: number, end: number) {
  if (start < top || end - start >= height) return Math.max(0, start);
  return Math.max(0, end > top + height ? end - height : top);
}

// When the terminal cannot fit even the chrome, retain its first controls
// (title, hints, actions) before search/status. Never give Yoga negative sizes.
export function fitChrome(rows: number, heights: readonly number[]) {
  let remaining = Math.max(1, Math.floor(rows) - 3);
  return heights.map(height => {
    const size = Math.min(Math.max(0, height), remaining);
    remaining -= size;
    return size;
  });
}

export function wrappedRows(value: string, columns: number) {
  const width = Math.max(1, columns);
  return value.split('\n').reduce((total, line) => {
    let rows = 1, used = 0;
    for (const word of line.trim().split(/\s+/).filter(Boolean)) {
      if (used && used + 1 + word.length > width) { rows++; used = 0; }
      else if (used) used++;
      rows += Math.floor((used + word.length - 1) / width);
      used = (used + word.length - 1) % width + 1;
    }
    return total + rows;
  }, 0);
}
