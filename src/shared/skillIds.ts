const SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function normalizeForcedSkillIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const skillId = entry.trim();
    if (!skillId || !SKILL_ID_PATTERN.test(skillId) || seen.has(skillId)) {
      continue;
    }
    seen.add(skillId);
    normalized.push(skillId);
  }
  return normalized;
}

export function parseForcedSkillIdsJson(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    return normalizeForcedSkillIds(JSON.parse(value) as unknown);
  } catch {
    return [];
  }
}

export function serializeForcedSkillIds(value: unknown): string | null {
  const normalized = normalizeForcedSkillIds(value);
  return normalized.length ? JSON.stringify(normalized) : null;
}
