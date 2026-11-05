import { parse } from 'yaml';

export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = text.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  if (!match) return { data: {}, body: text };
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = parse(match[1], { maxAliasCount: 50 });
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch { /* Malformed metadata does not make the body unreadable. */ }
  return { data, body: text.slice(match[0].length) };
}
export function stripFrontmatter(text: string): string { return parseFrontmatter(text).body; }
