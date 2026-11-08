import type { AgentToolGuidance } from "../types";

type GuidanceRequest = Parameters<AgentToolGuidance["matches"]>[0];

type UserTextSignals = NonNullable<GuidanceRequest["userTextSignals"]>;

/** A turn selects this guidance by a cheap signal in the user's own text. */
export function userTextSignal(
  request: GuidanceRequest,
  signal: (signals: UserTextSignals) => boolean,
): boolean {
  return Boolean(request.userTextSignals && signal(request.userTextSignals));
}

/**
 * Selects nothing. Guidance the classifier's intent used to select keeps its
 * text with this matcher: that intent is gone, so no turn selects it until it
 * is given a trigger of its own or removed.
 */
export function neverSelected(): boolean {
  return false;
}

/**
 * A tool's guidance as a list: a tool may carry one guidance or several, each
 * matched and rendered alone (for example one item per skill it serves).
 */
export function toolGuidanceItems(
  guidance: AgentToolGuidance | ReadonlyArray<AgentToolGuidance> | undefined,
): ReadonlyArray<AgentToolGuidance> {
  if (!guidance) return [];
  return Array.isArray(guidance)
    ? (guidance as ReadonlyArray<AgentToolGuidance>)
    : [guidance as AgentToolGuidance];
}

/**
 * Matches while `skillId` is active this turn: matched by the host or forced
 * by the user (`$skill`), as note_write's write-note guidance does.
 */
export function skillGuidance(
  skillId: string,
  instruction: string,
): AgentToolGuidance {
  return {
    matches: (request, context) =>
      Boolean(
        context?.matchedSkillIds.includes(skillId) ||
        request.forcedSkillIds?.includes(skillId),
      ),
    instruction,
  };
}
