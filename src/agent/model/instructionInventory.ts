import { estimateTextTokens } from "../../utils/modelInputCap";
import type { AgentModelMessage, AgentToolDefinition } from "../types";

export type InstructionInventoryInput = {
  fixed?: string | ReadonlyArray<string>;
  tools?: ReadonlyArray<AgentToolDefinition<any, any>>;
  matchedSkills?: ReadonlyArray<string>;
  dynamicGuidance?: string | ReadonlyArray<string>;
  stableResource?: string;
  turnResource?: string;
  providerMessages?: ReadonlyArray<AgentModelMessage>;
};

export type InstructionInventory = {
  fixedTokens: number;
  toolTokens: number;
  matchedSkillTokens: number;
  dynamicGuidanceTokens: number;
  stableResourceTokens: number;
  turnResourceTokens: number;
  categorizedTotalTokens: number;
  providerBoundTokens: number;
  promptHash: string;
};

function joinText(value: string | ReadonlyArray<string> | undefined): string {
  if (!value) return "";
  return typeof value === "string" ? value : value.filter(Boolean).join("\n\n");
}

function renderToolInstructionSurface(
  tools: ReadonlyArray<AgentToolDefinition<any, any>>,
): string {
  return tools
    .map((tool) =>
      [
        tool.spec.name,
        tool.spec.description,
        JSON.stringify(tool.spec.inputSchema || {}),
      ].join("\n"),
    )
    .join("\n\n");
}

function renderMessageInstructionSurface(
  messages: ReadonlyArray<AgentModelMessage>,
): string {
  return messages
    .map((message) => {
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content
              .map((part) =>
                part.type === "text"
                  ? part.text
                  : part.type === "image_url"
                    ? "[image]"
                    : "[file]",
              )
              .join("\n");
      return `${message.role}\n${content}`;
    })
    .join("\n\n");
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Provider-independent estimate of the instruction surface sent to a model.
 * Keeping categories separate prevents prompt reductions from being hidden by
 * moving the same prose between the persona, tool schemas, skills, and turn
 * context. The hash covers the serialized messages and tool surface but never
 * records their contents.
 */
export function buildInstructionInventory(
  input: InstructionInventoryInput,
): InstructionInventory {
  const fixedText = joinText(input.fixed);
  const toolText = renderToolInstructionSurface(input.tools || []);
  const matchedSkillText = joinText(input.matchedSkills);
  const dynamicGuidanceText = joinText(input.dynamicGuidance);
  const stableResourceText = input.stableResource || "";
  const turnResourceText = input.turnResource || "";
  const fixedTokens = estimateTextTokens(fixedText);
  const toolTokens = estimateTextTokens(toolText);
  const matchedSkillTokens = estimateTextTokens(matchedSkillText);
  const dynamicGuidanceTokens = estimateTextTokens(dynamicGuidanceText);
  const stableResourceTokens = estimateTextTokens(stableResourceText);
  const turnResourceTokens = estimateTextTokens(turnResourceText);
  const categorizedTotalTokens =
    fixedTokens +
    toolTokens +
    matchedSkillTokens +
    dynamicGuidanceTokens +
    stableResourceTokens +
    turnResourceTokens;
  const providerSurface = [
    input.providerMessages?.length
      ? renderMessageInstructionSurface(input.providerMessages)
      : [
          fixedText,
          matchedSkillText,
          dynamicGuidanceText,
          stableResourceText,
          turnResourceText,
        ]
          .filter(Boolean)
          .join("\n\n"),
    toolText,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    fixedTokens,
    toolTokens,
    matchedSkillTokens,
    dynamicGuidanceTokens,
    stableResourceTokens,
    turnResourceTokens,
    categorizedTotalTokens,
    providerBoundTokens: estimateTextTokens(providerSurface),
    promptHash: hashText(providerSurface),
  };
}
