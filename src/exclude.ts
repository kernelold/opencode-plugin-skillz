export interface ExcludableSkill { id: string; name: string; category?: string }
export function isExcluded(skill: ExcludableSkill, exclude: readonly string[] = []): boolean {
  return exclude.some(entry => {
    if (entry.endsWith('/')) return !!skill.category && `${skill.category}/`.startsWith(entry);
    const pattern = new RegExp(`^${entry.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return pattern.test(skill.id) || pattern.test(skill.name) || pattern.test([skill.category, skill.id].filter(Boolean).join('/'));
  });
}
