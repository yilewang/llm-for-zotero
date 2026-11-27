import type {
  AgentRuntimeRequest,
  AgentToolDefinition,
  AgentToolGuidance,
} from "../types";

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

/** The guidance of the given tools that matches this turn. */
export function collectMatchingToolGuidance(
  request: AgentRuntimeRequest,
  tools: readonly Pick<AgentToolDefinition<any, any>, "guidance">[],
  matchedSkillIds: ReadonlyArray<string>,
): string[] {
  const instructions = new Set<string>();
  const {
    userText: _userText,
    history: _history,
    clarificationHistory: _clarifications,
    ...guidanceContext
  } = request;
  for (const tool of tools) {
    for (const guidance of toolGuidanceItems(tool.guidance)) {
      if (!guidance.matches(guidanceContext, { matchedSkillIds })) continue;
      const instruction = guidance.instruction.trim();
      if (instruction) instructions.add(instruction);
    }
  }
  return [...instructions];
}

export function renderToolGuidanceLines(
  instructions: readonly string[],
): string[] {
  if (!instructions.length) return [];
  return [
    "Tool guidance for this turn: call a tool only when it serves the user's request, never just because its guidance appears here.",
    ...instructions,
  ];
}
