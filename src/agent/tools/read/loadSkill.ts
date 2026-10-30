import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import {
  getAllSkills,
  getBuiltinSkillInstructionById,
  loadSkill,
} from "../../skills";
import type { AgentSkill, LoadedSkill } from "../../skills";
import { SKILL_SCOPE_GUARD } from "../../skills/scopeGuard";
import type { AgentRuntimeRequest, AgentToolDefinition } from "../../types";
import { fail, ok, validateObject } from "../shared";
import { toolGuidanceItems } from "../guidance";
import { isSkillWithheldForEphemeralRequest } from "../../skills/sideChatScope";

export type LoadSkillInput = { id: string };

export type LoadSkillResult =
  | ({
      found: true;
      /** The request-scope rule; customized templates cannot widen scope. */
      scopeGuard: string;
      toolGuidance?: string;
    } & LoadedSkill)
  | {
      found: false;
      error: string;
      availableSkillIds: string[];
    };

export type LoadSkillToolOptions = {
  getSkills?: () => ReadonlyArray<AgentSkill>;
  getShippedInstruction?: (id: string) => string | undefined;
  /** The tools offered on this request, for guidance tied to a skill. */
  getToolDefinitions?: (
    request: AgentRuntimeRequest,
  ) => ReadonlyArray<AgentToolDefinition<any, any>>;
};

/**
 * Tool guidance the model gains by loading `skillId`. The prompt's guidance
 * block is rendered once per turn, so this is how a skill loaded mid-turn
 * brings the tool rules tied to it.
 *
 * When the host recorded what it already delivered this turn
 * (`deliveredToolGuidance`: the rendered guidance plus earlier load_skill
 * returns), every instruction that matches with the loaded skill active is
 * returned minus that set; this also covers guidance that became applicable
 * after the render. Without a record (an MCP call) only guidance tied to the
 * skill is returned: it matches with the skill and not with the skills
 * active before the load.
 */
function collectSkillToolGuidance(
  skillId: string,
  request: AgentRuntimeRequest,
  activeSkillIds: ReadonlyArray<string>,
  tools: ReadonlyArray<AgentToolDefinition<any, any>>,
): string[] {
  const delivered = request.deliveredToolGuidance
    ? new Set(request.deliveredToolGuidance)
    : undefined;
  const withSkill = [...new Set([...activeSkillIds, skillId])];
  const instructions = new Set<string>();
  for (const tool of tools) {
    for (const guidance of toolGuidanceItems(tool.guidance)) {
      const instruction = guidance.instruction.trim();
      if (!instruction) continue;
      if (!guidance.matches(request, { matchedSkillIds: withSkill })) continue;
      if (delivered) {
        if (delivered.has(instruction)) continue;
      } else {
        if (!guidance.matches(request, { matchedSkillIds: [skillId] }))
          continue;
        if (guidance.matches(request, { matchedSkillIds: activeSkillIds }))
          continue;
      }
      instructions.add(instruction);
    }
  }
  return [...instructions];
}

/**
 * Read one installed skill into the active agent workflow. The initial prompt
 * can carry only the metadata inventory; this tool returns the exact body and
 * its stable identity without invoking another model.
 */
export function createLoadSkillTool(
  options: LoadSkillToolOptions = {},
): AgentToolDefinition<LoadSkillInput, LoadSkillResult> {
  const getSkills = options.getSkills || getAllSkills;
  const getShippedInstruction =
    options.getShippedInstruction || getBuiltinSkillInstructionById;
  return {
    spec: {
      name: "load_skill",
      description:
        "Load the full instructions for one installed skill by exact ID. Use this when a skill in the supplied inventory matches the current work and its workflow guidance is needed. Loading guidance does not authorize actions or override the user's current request.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: {
            type: "string",
            description: "Exact ID from the installed skill inventory.",
          },
        },
      },
      executionClass: "read",
      workCategory: "retrieval",
    },
    validate(args) {
      if (
        !validateObject<Record<string, unknown>>(args) ||
        Object.keys(args).some((key) => key !== "id") ||
        typeof args.id !== "string" ||
        !args.id.trim()
      ) {
        return fail("id must be a non-empty installed skill ID");
      }
      return ok({ id: args.id.trim() });
    },
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: [],
        reason: "Skill loading reads host-owned in-memory guidance.",
      }),
    async execute(input, context) {
      const skills = getSkills();
      const skill = skills.find((candidate) => candidate.id === input.id);
      if (
        skill &&
        context?.request &&
        isSkillWithheldForEphemeralRequest(skill.id, context.request)
      ) {
        return {
          found: false,
          error: `Skill "${input.id}" changes the library, and this side chat is read-only. The main chat can run it.`,
          availableSkillIds: skills
            .map((candidate) => candidate.id)
            .filter(
              (id) => !isSkillWithheldForEphemeralRequest(id, context.request!),
            )
            .sort((left, right) => left.localeCompare(right)),
        };
      }
      if (!skill) {
        return {
          found: false,
          error: `Skill "${input.id}" is not installed.`,
          availableSkillIds: skills
            .map((candidate) => candidate.id)
            .sort((left, right) => left.localeCompare(right)),
        };
      }
      const loaded = await loadSkill(skill, getShippedInstruction(skill.id));
      let toolGuidance: string | undefined;
      if (context?.request) {
        const records = context.request.loadedSkillRecords || [];
        if (options.getToolDefinitions) {
          const isToolVisible = context.isToolVisible;
          const instructions = collectSkillToolGuidance(
            skill.id,
            context.request,
            records.map((record) => record.id),
            options
              .getToolDefinitions(context.request)
              .filter((tool) => !isToolVisible || isToolVisible(tool.spec)),
          );
          if (instructions.length) {
            toolGuidance = [
              "Tool guidance for this skill:",
              ...instructions,
            ].join("\n\n");
            if (context.request.deliveredToolGuidance) {
              context.request.deliveredToolGuidance = [
                ...context.request.deliveredToolGuidance,
                ...instructions,
              ];
            }
          }
        }
        const alreadyLoaded = records.some(
          (record) =>
            record.id === loaded.loadedSkill.id &&
            record.instructionFingerprint ===
              loaded.loadedSkill.instructionFingerprint,
        );
        context.request.loadedSkillRecords = [
          ...records.filter((record) => record.id !== loaded.loadedSkill.id),
          loaded.loadedSkill,
        ];
        if (!alreadyLoaded) await context.publishSkillActivation?.(skill.id);
      }
      return {
        found: true,
        ...loaded,
        scopeGuard: SKILL_SCOPE_GUARD,
        ...(toolGuidance ? { toolGuidance } : {}),
      };
    },
  };
}
