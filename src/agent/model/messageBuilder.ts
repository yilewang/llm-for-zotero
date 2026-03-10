import type {
  AgentModelMessage,
  AgentRuntimeRequest,
  AgentToolDefinition,
} from "../types";
import { AGENT_PERSONA_INSTRUCTIONS } from "./agentPersona";
import { buildAgentMemoryBlock } from "../store/conversationMemory";

export function isMultimodalRequestSupported(
  request: AgentRuntimeRequest,
): boolean {
  const model = (request.model || "").trim().toLowerCase();
  if (!model) return true;
  return !(
    model.includes("reasoner") ||
    model.includes("text-only") ||
    model.includes("embedding")
  );
}

export function stringifyMessageContent(
  content: AgentModelMessage["content"],
): string {
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      part.type === "text"
        ? part.text
        : part.type === "image_url"
          ? "[image]"
          : "[file]",
    )
    .join("\n");
}

/**
 * Keeps the first Q&A pair (for topic continuity) plus the most recent turns.
 * This prevents important first-turn context from being silently dropped when
 * the conversation grows long, while still respecting the total cap.
 */
function selectAgentHistoryWindow(
  history: import("../../utils/llmClient").ChatMessage[],
  maxTotal = 10,
): import("../../utils/llmClient").ChatMessage[] {
  if (history.length <= maxTotal) return history;
  // First pair anchors the conversation topic.
  const firstPair = history.slice(0, 2);
  const tail = history.slice(-(maxTotal - 2));
  // Avoid duplicating the first pair if history is very short.
  const tailStartIndex = history.length - (maxTotal - 2);
  if (tailStartIndex <= 2) return history.slice(-maxTotal);
  return [...firstPair, ...tail];
}

function normalizeHistoryMessages(
  request: AgentRuntimeRequest,
): AgentModelMessage[] {
  const raw = Array.isArray(request.history) ? request.history : [];
  const windowed = selectAgentHistoryWindow(raw, 10);
  return windowed
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role,
      content: stringifyMessageContent(message.content),
    }));
}

function buildUserMessage(request: AgentRuntimeRequest): AgentModelMessage {
  const contextLines: string[] = [
    "Current Zotero context summary:",
    `- Conversation key: ${request.conversationKey}`,
  ];
  if (Array.isArray(request.selectedTexts) && request.selectedTexts.length) {
    const selectedTextBlock = request.selectedTexts
      .map((entry, index) => `Selected text ${index + 1}:\n"""\n${entry}\n"""`)
      .join("\n\n");
    contextLines.push(selectedTextBlock);
  }
  if (
    Array.isArray(request.selectedPaperContexts) &&
    request.selectedPaperContexts.length
  ) {
    contextLines.push(
      "Selected paper refs:",
      ...request.selectedPaperContexts.map(
        (entry, index) =>
          `- Selected paper ${index + 1}: ${entry.title} [itemId=${entry.itemId}, contextItemId=${entry.contextItemId}]`,
      ),
    );
  }
  if (
    Array.isArray(request.pinnedPaperContexts) &&
    request.pinnedPaperContexts.length
  ) {
    contextLines.push(
      "Pinned paper refs:",
      ...request.pinnedPaperContexts.map(
        (entry, index) =>
          `- Pinned paper ${index + 1}: ${entry.title} [itemId=${entry.itemId}, contextItemId=${entry.contextItemId}]`,
      ),
    );
  }
  if (Array.isArray(request.attachments) && request.attachments.length) {
    contextLines.push(
      "Current uploaded attachments are available through the registered document tools.",
    );
  }

  const promptText = `${contextLines.join("\n")}\n\nUser request:\n${request.userText}`;
  const screenshots = Array.isArray(request.screenshots)
    ? request.screenshots.filter((entry) => Boolean(entry))
    : [];
  if (!screenshots.length || !isMultimodalRequestSupported(request)) {
    return {
      role: "user",
      content: promptText,
    };
  }
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: promptText,
      },
      ...screenshots.map((url) => ({
        type: "image_url" as const,
        image_url: {
          url,
        },
      })),
    ],
  };
}

type PromptSection = {
  /** Identifies the section in code; not emitted into the prompt text */
  id: string;
  lines: string[];
};

function buildSystemPrompt(sections: PromptSection[]): string {
  return sections
    .flatMap(({ lines }) => lines)
    .filter(Boolean)
    .join("\n\n");
}

function collectGuidanceInstructions(
  request: AgentRuntimeRequest,
  tools: AgentToolDefinition<any, any>[],
): string[] {
  const instructions = new Set<string>();
  for (const tool of tools) {
    const guidance = tool.guidance;
    if (!guidance) continue;
    if (!guidance.matches(request)) continue;
    const instruction = guidance.instruction.trim();
    if (instruction) instructions.add(instruction);
  }
  return Array.from(instructions);
}

function buildAutoReadInstruction(request: AgentRuntimeRequest): string {
  const isFirstTurn = !Array.isArray(request.history) || request.history.length === 0;
  if (!isFirstTurn) return "";
  const hasPapers =
    (request.selectedPaperContexts?.length ?? 0) > 0 ||
    (request.pinnedPaperContexts?.length ?? 0) > 0;
  if (!hasPapers) return "";
  return (
    "FIRST-TURN RULE: Because this is the start of the conversation and paper(s) are attached, " +
    "your very first action MUST be to call `read_paper_front_matter` to load the title, abstract, " +
    "and authors. Do this before answering, even if the answer seems obvious. " +
    "This grounds your response in the actual paper content."
  );
}

export function buildAgentInitialMessages(
  request: AgentRuntimeRequest,
  tools: AgentToolDefinition<any, any>[],
): AgentModelMessage[] {
  const memoryBlock = buildAgentMemoryBlock(request.conversationKey);
  const autoReadInstruction = buildAutoReadInstruction(request);

  const sections: PromptSection[] = [
    {
      id: "system-override",
      lines: [(request.systemPrompt || "").trim()],
    },
    {
      id: "persona",
      lines: AGENT_PERSONA_INSTRUCTIONS,
    },
    {
      id: "custom-instructions",
      lines: [(request.customInstructions || "").trim()],
    },
    {
      id: "tool-guidance",
      lines: collectGuidanceInstructions(request, tools),
    },
    {
      id: "agent-memory",
      lines: [memoryBlock],
    },
    {
      id: "auto-read",
      lines: [autoReadInstruction],
    },
  ];

  return [
    {
      role: "system",
      content: buildSystemPrompt(sections),
    },
    ...normalizeHistoryMessages(request),
    buildUserMessage(request),
  ];
}
