import type {
  AgentModelMessage,
  AgentRuntimeRequest,
  AgentToolDefinition,
} from "../types";
import { AGENT_PERSONA_INSTRUCTIONS } from "./agentPersona";
import { buildAgentMemoryBlock } from "../store/conversationMemory";
import { getAllSkills } from "../skills";

import { isTextOnlyModel } from "../../providers";
import {
  isNotesDirectoryConfigured,
  getNotesDirectoryPath,
  getNotesDirectoryFolder,
  getNotesDirectoryAttachmentsFolder,
  getNotesDirectoryNickname,
} from "../../utils/notesDirectoryConfig";
import { joinLocalPath } from "../../utils/localPath";
import { buildRuntimePlatformGuidanceText } from "../../utils/runtimePlatform";

export function isMultimodalRequestSupported(
  request: AgentRuntimeRequest,
): boolean {
  return !isTextOnlyModel(request.model || "");
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
  const fullTextPaperKeySet = new Set(
    (request.fullTextPaperContexts || []).map(
      (entry) => `${entry.itemId}:${entry.contextItemId}`,
    ),
  );
  const retrievalOnlyPapers = (request.selectedPaperContexts || []).filter(
    (entry) =>
      !fullTextPaperKeySet.has(`${entry.itemId}:${entry.contextItemId}`),
  );
  const contextLines: string[] = [
    "Current Zotero context summary:",
    `- Conversation key: ${request.conversationKey}`,
  ];
  if (request.activeItemId) {
    contextLines.push(`- Active item ID: ${request.activeItemId}`);
  }
  const hasActiveNoteEditingFocus = Array.isArray(request.selectedTextSources)
    ? request.selectedTextSources.some((source) => source === "note-edit")
    : false;
  if (request.activeNoteContext && hasActiveNoteEditingFocus) {
    const note = request.activeNoteContext;
    contextLines.push(
      `- Active note: ${note.title} [noteId=${note.noteId}, kind=${note.noteKind}]`,
    );
    if (note.parentItemId) {
      contextLines.push(`- Active note parent item ID: ${note.parentItemId}`);
    }
    contextLines.push(`Current note content for this turn:\n"""\n${note.noteText}\n"""`);
    if (note.noteHtml) {
      contextLines.push(`Original note HTML:\n"""\n${note.noteHtml}\n"""`);
    }
  }
  if (Array.isArray(request.selectedTexts) && request.selectedTexts.length) {
    const selectedTextBlock = request.selectedTexts
      .map((entry, index) => {
        const source = request.selectedTextSources?.[index];
        const sourceLabel =
          source === "model"
            ? "model response"
            : source === "note"
              ? "Zotero note"
            : source === "note-edit"
              ? "active note editing focus"
              : "PDF reader";
        return `Selected text ${index + 1} [source=${sourceLabel}]:\n"""\n${entry}\n"""`;
      })
      .join("\n\n");
    contextLines.push(selectedTextBlock);
  }
  if (retrievalOnlyPapers.length) {
    contextLines.push(
      "Retrieval-only paper refs:",
      ...retrievalOnlyPapers.map(
        (entry, index) =>
          `- Retrieval paper ${index + 1}: ${entry.title} [itemId=${entry.itemId}, contextItemId=${entry.contextItemId}${entry.mineruCacheDir ? `, mineruCacheDir=${entry.mineruCacheDir}` : ""}]`,
      ),
    );
  }
  if (
    Array.isArray(request.fullTextPaperContexts) &&
    request.fullTextPaperContexts.length
  ) {
    contextLines.push(
      "Full-text paper refs for this turn:",
      ...request.fullTextPaperContexts.map(
        (entry, index) =>
          `- Full-text paper ${index + 1}: ${entry.title} [itemId=${entry.itemId}, contextItemId=${entry.contextItemId}${entry.mineruCacheDir ? `, mineruCacheDir=${entry.mineruCacheDir}` : ""}]`,
      ),
    );
  }
  const pdfAttachments = (request.attachments || []).filter(
    (a) => a.category === "pdf" && typeof a.storedPath === "string" && a.storedPath.trim(),
  );
  const nonPdfAttachments = (request.attachments || []).filter(
    (a) => a.category !== "pdf",
  );
  if (nonPdfAttachments.length) {
    contextLines.push(
      "Current uploaded attachments are available through the registered document tools.",
    );
  }

  const promptText = `${contextLines.join("\n")}\n\nUser request:\n${request.userText}`;
  const screenshots = Array.isArray(request.screenshots)
    ? request.screenshots.filter((entry) => Boolean(entry))
    : [];
  const hasInlineMedia = screenshots.length > 0 || pdfAttachments.length > 0;
  if (!hasInlineMedia || !isMultimodalRequestSupported(request)) {
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
      ...pdfAttachments.map((a) => ({
        type: "file_ref" as const,
        file_ref: {
          name: a.name,
          mimeType: a.mimeType || "application/pdf",
          storedPath: a.storedPath as string,
          contentHash: a.contentHash,
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
  matchedSkillIds: ReadonlyArray<string>,
): string[] {
  const instructions = new Set<string>();
  for (const tool of tools) {
    const guidance = tool.guidance;
    if (!guidance) continue;
    if (!guidance.matches(request)) continue;
    const instruction = guidance.instruction.trim();
    if (instruction) instructions.add(instruction);
  }

  // Inject only the skills that the caller (runtime.ts) pre-selected for
  // this user turn. Skill selection happens once in getMatchedSkillIds,
  // before this function is called — its result gates which instruction
  // bodies ship in the system prompt so unrelated skills don't flood the
  // context.
  const activeSkillIds = new Set(matchedSkillIds);
  for (const skill of getAllSkills()) {
    if (!activeSkillIds.has(skill.id)) continue;
    const instruction = skill.instruction.trim();
    if (instruction) instructions.add(instruction);
  }
  if (!instructions.size) return [];
  return [
    "The following tool guidance is provided because the user's message may be relevant to these capabilities. " +
      "Use your judgement: only invoke a tool if it directly addresses what the user is asking for. " +
      "Do NOT invoke a tool just because its guidance appears here — the user's actual intent takes priority.",
    ...instructions,
  ];
}

function buildAutoReadInstruction(request: AgentRuntimeRequest): string {
  const fullTextPapers = request.fullTextPaperContexts || [];
  if (!fullTextPapers.length) return "";
  const allHaveMineruCache = fullTextPapers.every(
    (entry) => Boolean(entry.mineruCacheDir),
  );
  if (allHaveMineruCache) {
    return (
      "TURN RULE: Because the user marked specific paper(s) for full-text use on this turn, " +
      "your very first action MUST be to read the paper content. " +
      "All marked papers have MinerU cache — start by reading `file_io(read, '{mineruCacheDir}/manifest.json')` for each paper " +
      "to see the section structure, then read the relevant sections from full.md using offset/length. " +
      "Do this before answering, even if the answer seems obvious."
    );
  }
  return (
    "TURN RULE: Because the user marked specific paper(s) for full-text use on this turn, " +
    "your very first action MUST be to call `read_paper` targeting only those full-text papers. " +
    "Do this before answering, even if the answer seems obvious. " +
    "Do not include retrieval-only papers in that mandatory first read."
  );
}

function buildNotesDirectorySection(): string {
  if (!isNotesDirectoryConfigured()) return "";
  const dirPath = getNotesDirectoryPath();
  const targetFolder = getNotesDirectoryFolder();
  const attachmentsFolder = getNotesDirectoryAttachmentsFolder();
  const nickname = getNotesDirectoryNickname().trim();
  const defaultTargetPath = targetFolder
    ? joinLocalPath(dirPath, targetFolder)
    : dirPath;
  const lines = [
    "Notes directory configuration (user-configured):",
  ];
  if (nickname) {
    lines.push(`- Nickname: ${nickname}`);
  }
  const attachmentsPath = attachmentsFolder
    ? joinLocalPath(dirPath, attachmentsFolder)
    : "";
  lines.push(
    `- Directory path: ${dirPath}`,
    `- Default folder: ${targetFolder}`,
    `- Default target path: ${defaultTargetPath}`,
    `- Attachments folder: ${attachmentsFolder} (relative to notes directory root)`,
  );
  if (attachmentsPath) {
    lines.push(
      `- Attachments path: ${attachmentsPath} (resolved absolute path for copying images)`,
    );
  }
  if (nickname) {
    lines.push(
      `When the user mentions "${nickname}" in the context of notes, write to this directory.`,
    );
  }
  return lines.join("\n");
}

function buildRuntimePlatformSection(): string {
  return buildRuntimePlatformGuidanceText();
}

export async function buildAgentInitialMessages(
  request: AgentRuntimeRequest,
  tools: AgentToolDefinition<any, any>[],
  matchedSkillIds: ReadonlyArray<string>,
): Promise<AgentModelMessage[]> {
  const memoryBlock = await buildAgentMemoryBlock(request.conversationKey);
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
      id: "runtime-platform",
      lines: [buildRuntimePlatformSection()],
    },
    {
      id: "custom-instructions",
      lines: [(request.customInstructions || "").trim()],
    },
    {
      id: "notes-directory-config",
      lines: [buildNotesDirectorySection()],
    },
    {
      id: "tool-guidance",
      lines: collectGuidanceInstructions(request, tools, matchedSkillIds),
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
