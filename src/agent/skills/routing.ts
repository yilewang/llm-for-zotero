import {
  isNotesDirectoryConfigured,
  getNotesDirectoryNickname,
} from "../../utils/notesDirectoryConfig";
import type { AgentRuntimeRequest } from "../types";
import {
  resolveSkillRequestContext,
  type SkillRoutingRequest,
} from "./contextEligibility";
import { matchesSkill, type AgentSkill } from "./skillLoader";

const SIMPLE_PAPER_QA_SKILL_ID = "simple-paper-qa";
const EVIDENCE_BASED_QA_SKILL_ID = "evidence-based-qa";
const LIBRARY_ANALYSIS_SKILL_ID = "library-analysis";
const SIMPLE_PAPER_QA_INTENT_PATTERN =
  /\b(understand|explain|walk me through|help me understand)\b.*\b(paper|ppaer|article|study)\b/i;
const COLLECTION_ANALYSIS_INTENT_PATTERN =
  /\b(summarize|summarise|summary|overview|statistics|stats|analy[sz]e|breakdown|survey|audit)\b/i;
const LIBRARY_SCOPE_TARGET_PATTERN =
  /\b(?:my|the|whole|entire|current|selected)\s+(?:library|collection|tag)\b|\b(?:this|the|current|selected)\s+(?:collection|tag)\b|\ball\s+(?:papers?|items?)\b|\b(?:library|collection|tag)\s+(?:summary|overview|statistics|stats|analysis|breakdown)\b/i;

export type SkillRoutingResolution = {
  matchedSkillIds: string[];
  explicitSkillIds: string[];
  contextForcedSkillIds: string[];
};

export type SkillDirectiveTextResolution = {
  text: string;
  forcedSkillId?: string;
};

type NaturalLanguageSkillDirective = {
  skillPhrase: string;
  rest: string;
};

type SkillCandidateScore = {
  skill: AgentSkill;
  score: number;
};

const NATURAL_SKILL_DIRECTIVE_PATTERN =
  /^(?:(?:please|pls)\s+)?(?:(?:can|could|would)\s+you\s+)?(?:(?:please|pls)\s+)?(?:use|using|with|activate|run|invoke)\s+(?:the\s+|a\s+|an\s+)?(.+?)\s+skill\b([\s\S]*)$/i;

const NATURAL_SKILL_MIN_SCORE = 70;
const NATURAL_SKILL_MIN_MARGIN = 10;
const DESCRIPTION_TOKEN_SCORE = 62;
const SKILL_TOKEN_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "by",
  "can",
  "could",
  "for",
  "from",
  "help",
  "i",
  "in",
  "into",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "please",
  "skill",
  "that",
  "the",
  "these",
  "this",
  "those",
  "to",
  "use",
  "using",
  "with",
  "would",
  "you",
  "your",
]);

function normalizeSkillAliasText(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[`'"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function getMeaningfulSkillTokens(value: string): string[] {
  const normalized = normalizeSkillAliasText(value);
  if (!normalized) return [];
  return normalized
    .split(" ")
    .filter((token) => token && !SKILL_TOKEN_STOPWORDS.has(token));
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + substitutionCost,
      );
    }
    for (let j = 0; j <= b.length; j++) {
      previous[j] = current[j];
    }
  }

  return previous[b.length];
}

function scoreTokenMatch(queryToken: string, targetToken: string): number {
  if (!queryToken || !targetToken) return 0;
  if (queryToken === targetToken) return 1;
  if (
    queryToken.length >= 4 &&
    targetToken.length >= 4 &&
    (queryToken.startsWith(targetToken) || targetToken.startsWith(queryToken))
  ) {
    return 0.9;
  }
  const maxLength = Math.max(queryToken.length, targetToken.length);
  if (maxLength >= 4 && levenshteinDistance(queryToken, targetToken) <= 1) {
    return 0.85;
  }
  return 0;
}

function scoreIdAliasMatch(skill: AgentSkill, phraseTokens: string[]): number {
  const idTokens = getMeaningfulSkillTokens(skill.id);
  if (!phraseTokens.length || !idTokens.length) return 0;

  if (phraseTokens.join("") === idTokens.join("")) return 100;

  if (phraseTokens.length < 2 || phraseTokens.length > idTokens.length) {
    return 0;
  }

  const tokenScores = phraseTokens.map((token, index) =>
    scoreTokenMatch(token, idTokens[index] || ""),
  );
  if (tokenScores.some((score) => score <= 0)) return 0;

  const average =
    tokenScores.reduce((total, score) => total + score, 0) / tokenScores.length;
  return 78 + average * 12 + phraseTokens.length;
}

function scoreDescriptionMatch(
  skill: AgentSkill,
  phraseTokens: string[],
): number {
  if (phraseTokens.length < 2) return 0;
  const descriptionTokens = getMeaningfulSkillTokens(skill.description);
  if (!descriptionTokens.length) return 0;

  const matchedScores = phraseTokens
    .map((token) =>
      Math.max(
        0,
        ...descriptionTokens.map((descriptionToken) =>
          scoreTokenMatch(token, descriptionToken),
        ),
      ),
    )
    .filter((score) => score > 0);
  if (matchedScores.length < 2) return 0;

  return (
    DESCRIPTION_TOKEN_SCORE +
    matchedScores.reduce((total, score) => total + score, 0) * 4
  );
}

function parseNaturalLanguageSkillDirective(
  text: string,
): NaturalLanguageSkillDirective | null {
  const match = NATURAL_SKILL_DIRECTIVE_PATTERN.exec(text.trim());
  if (!match) return null;

  const skillPhrase = (match[1] || "").trim();
  if (!skillPhrase) return null;

  const rest = (match[2] || "")
    .trim()
    .replace(/^[,:;-]\s*/u, "")
    .replace(/^to\s+/i, "")
    .trim();
  return { skillPhrase, rest };
}

function resolveNaturalLanguageSkillId(
  skillPhrase: string,
  skills: ReadonlyArray<AgentSkill>,
): string | undefined {
  const phraseTokens = getMeaningfulSkillTokens(skillPhrase);
  if (!phraseTokens.length) return undefined;

  const scored = skills
    .map(
      (skill): SkillCandidateScore => ({
        skill,
        score: Math.max(
          scoreIdAliasMatch(skill, phraseTokens),
          scoreDescriptionMatch(skill, phraseTokens),
        ),
      }),
    )
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top || top.score < NATURAL_SKILL_MIN_SCORE) return undefined;

  const runnerUp = scored[1];
  if (runnerUp && top.score - runnerUp.score < NATURAL_SKILL_MIN_MARGIN) {
    return undefined;
  }

  return top.skill.id;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasSkill(skills: ReadonlyArray<AgentSkill>, skillId: string): boolean {
  return skills.some((skill) => skill.id === skillId);
}

function hasPaperTarget(request: SkillRoutingRequest): boolean {
  const context = resolveSkillRequestContext(request);
  return Boolean(
    context.hasSinglePaper ||
      context.hasPaperSet ||
      context.singlePaperTargetedByText,
  );
}

function hasLibraryScopeTarget(request: SkillRoutingRequest): boolean {
  return Boolean(
    request.selectedCollectionContexts?.length ||
      request.selectedTagContexts?.length ||
      LIBRARY_SCOPE_TARGET_PATTERN.test(request.userText || ""),
  );
}

function computeContextForcedSkillIds(
  request: SkillRoutingRequest,
): Set<string> {
  const forced = new Set<string>();
  const nickname = getNotesDirectoryNickname().trim();
  if (nickname && isNotesDirectoryConfigured() && request.userText) {
    const escaped = nickname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const isAscii = /^[\x20-\x7E]+$/.test(nickname);
    const pattern = isAscii
      ? new RegExp(`\\b${escaped}\\b`, "i")
      : new RegExp(escaped, "i");
    if (pattern.test(request.userText)) {
      forced.add("write-note");
    }
  }
  if (
    SIMPLE_PAPER_QA_INTENT_PATTERN.test(request.userText || "") &&
    hasPaperTarget(request) &&
    !hasLibraryScopeTarget(request)
  ) {
    forced.add(SIMPLE_PAPER_QA_SKILL_ID);
  }
  if (
    (request.selectedCollectionContexts?.length ||
      request.selectedTagContexts?.length) &&
    COLLECTION_ANALYSIS_INTENT_PATTERN.test(request.userText || "")
  ) {
    forced.add(LIBRARY_ANALYSIS_SKILL_ID);
  }
  return forced;
}

function shouldSuppressAutomaticSkill(params: {
  skillId: string;
  request: SkillRoutingRequest;
  forcedIds: ReadonlySet<string>;
}): boolean {
  const { skillId, request, forcedIds } = params;
  if (forcedIds.has(skillId)) return false;
  if (skillId !== SIMPLE_PAPER_QA_SKILL_ID) return false;
  if (!hasPaperTarget(request)) return true;
  return hasLibraryScopeTarget(request) && !resolveSkillRequestContext(request).singlePaperTargetedByText;
}

export function resolveSkillRouting(
  request: SkillRoutingRequest & Pick<AgentRuntimeRequest, "forcedSkillIds">,
  skills: ReadonlyArray<AgentSkill>,
  classifiedIds?: ReadonlyArray<string>,
): SkillRoutingResolution {
  const forcedIds = new Set(request.forcedSkillIds || []);
  const contextForced = computeContextForcedSkillIds(request);
  const baseMatched =
    classifiedIds !== undefined
      ? new Set(classifiedIds)
      : new Set(
          skills
            .filter((skill) => matchesSkill(skill, request))
            .map((skill) => skill.id),
        );
  const matchedSkillIds = skills
    .filter((skill) => {
      if (forcedIds.has(skill.id)) {
        return true;
      }
      const isAutoMatched =
        contextForced.has(skill.id) || baseMatched.has(skill.id);
      if (!isAutoMatched || skill.activation === "manual") return false;
      return !shouldSuppressAutomaticSkill({
        skillId: skill.id,
        request,
        forcedIds,
      });
    })
    .map((skill) => skill.id);

  const withoutRedundantSimplePaperQa =
    matchedSkillIds.includes(EVIDENCE_BASED_QA_SKILL_ID) &&
    matchedSkillIds.includes(SIMPLE_PAPER_QA_SKILL_ID) &&
    !forcedIds.has(SIMPLE_PAPER_QA_SKILL_ID)
      ? matchedSkillIds.filter((id) => id !== SIMPLE_PAPER_QA_SKILL_ID)
      : matchedSkillIds;

  return {
    matchedSkillIds: withoutRedundantSimplePaperQa,
    explicitSkillIds: Array.from(forcedIds).filter((skillId) =>
      hasSkill(skills, skillId),
    ),
    contextForcedSkillIds: Array.from(contextForced).filter((skillId) =>
      hasSkill(skills, skillId),
    ),
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

  const directive = parseNaturalLanguageSkillDirective(trimmed);
  if (!directive) return { text };

  const naturalSkillId = resolveNaturalLanguageSkillId(
    directive.skillPhrase,
    skills,
  );
  if (!naturalSkillId) return { text };

  return {
    text: directive.rest
      ? `$${naturalSkillId}\n\n${directive.rest}`
      : `$${naturalSkillId}`,
    forcedSkillId: naturalSkillId,
  };
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
