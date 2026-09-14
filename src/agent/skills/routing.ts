import type { AgentRuntimeRequest } from "../types";
import {
  isSkillContextEligible,
  type SkillRoutingRequest,
} from "./contextEligibility";
import type { AgentSkill } from "./skillLoader";

export type SkillRoutingResolution = {
  matchedSkillIds: string[];
  explicitSkillIds: string[];
  contextForcedSkillIds: string[];
};

export type SkillDirectiveTextResolution = {
  text: string;
  forcedSkillId?: string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function hasSkill(skills: ReadonlyArray<AgentSkill>, id: string): boolean {
  return skills.some((skill) => skill.id === id);
}

export function resolveSkillRouting(
  request: SkillRoutingRequest & Pick<AgentRuntimeRequest, "forcedSkillIds">,
  skills: ReadonlyArray<AgentSkill>,
  classifiedIds?: ReadonlyArray<string>,
): SkillRoutingResolution {
  const forcedIds = new Set(request.forcedSkillIds || []);
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
  const explicitSkillIds = Array.from(
    new Set((request.forcedSkillIds || []).filter((id) => skillsById.has(id))),
  );
  const automatic = Array.from(new Set(classifiedIds || [])).filter((id) => {
    const skill = skillsById.get(id);
    if (!skill || forcedIds.has(id)) return false;
    return isSkillContextEligible(skill, request);
  });
  const automaticSet = new Set(automatic);
  for (const skill of skills) {
    if (!automaticSet.has(skill.id)) continue;
    for (const supersededId of skill.supersedes || []) {
      if (!forcedIds.has(supersededId)) automaticSet.delete(supersededId);
    }
  }
  const automaticSkillIds = automatic
    .filter((id) => automaticSet.has(id))
    .slice(0, 3)
    .map((id) => id);

  return {
    matchedSkillIds: [...explicitSkillIds, ...automaticSkillIds],
    explicitSkillIds,
    contextForcedSkillIds: [],
  };
}

export function resolveSkillDirectiveText(
  text: string,
  skills: ReadonlyArray<AgentSkill>,
): SkillDirectiveTextResolution {
  const trimmed = text.trim();
  const nativeMatch = /^\$([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(
    trimmed,
  );
  if (nativeMatch) {
    const skillId = nativeMatch[1];
    if (!hasSkill(skills, skillId)) {
      return { text };
    }
    return { text: trimmed, forcedSkillId: skillId };
  }
  const slashMatch = /^\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(
    trimmed,
  );
  if (slashMatch) {
    const skillId = slashMatch[1];
    if (!hasSkill(skills, skillId)) {
      return { text };
    }
    const rest = (slashMatch[2] || "").trim();
    return {
      text: rest ? `$${skillId}\n\n${rest}` : `$${skillId}`,
      forcedSkillId: skillId,
    };
  }

  return { text };
}

export function prependNativeSkillMention(
  question: string,
  skillId: string,
): string {
  const trimmedQuestion = question.trim();
  const nativeSkillPrefix = new RegExp(`^\\$${escapeRegExp(skillId)}(?:\\s|$)`);
  if (nativeSkillPrefix.test(trimmedQuestion)) return question;
  return trimmedQuestion ? `$${skillId}\n\n${question}` : `$${skillId}`;
}
