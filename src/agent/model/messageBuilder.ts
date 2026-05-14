import type {
  AgentModelMessage,
  AgentRuntimeRequest,
  AgentToolDefinition,
} from "../types";
import { AGENT_PERSONA_INSTRUCTIONS } from "./agentPersona";
import { buildAgentMemoryBlock } from "../store/conversationMemory";
import { getAllSkills } from "../skills";

import { resolveProviderCapabilities } from "../../providers";
import type { ProviderCapabilities } from "../../providers";
import { buildNotesDirectoryConfigSection } from "../../utils/notesDirectoryConfig";
import { buildRuntimePlatformGuidanceText } from "../../utils/runtimePlatform";
import {
  buildPaperQuoteCitationGuidance,
  formatPaperCitationLabel,
  formatPaperSourceLabel,
} from "../../modules/contextPanel/paperAttribution";
import type { PaperContextRef } from "../../shared/types";
import {
  renderAgentResourceContextPlan,
  type AgentResourceContextPlan,
} from "../context/resourceLifecycle";

export function isMultimodalRequestSupported(
  request: AgentRuntimeRequest,
): boolean {
  return resolveRequestProviderCapabilities(request).multimodal;
}

function resolveRequestProviderCapabilities(
  request: AgentRuntimeRequest,
): ProviderCapabilities {
  return resolveProviderCapabilities({
    model: request.model || "",
    protocol: request.providerProtocol,
    authMode: request.authMode,
    apiBase: request.apiBase,
  });
}

function formatPaperRefLine(
  prefix: string,
  entry: PaperContextRef,
  index: number,
): string {
  const metadata = [
    `itemId=${entry.itemId}`,
    `contextItemId=${entry.contextItemId}`,
    `citationLabel=${formatPaperCitationLabel(entry)}`,
    `sourceLabel=${formatPaperSourceLabel(entry)}`,
    entry.citationKey ? `citationKey=${entry.citationKey}` : "",
    entry.mineruCacheDir ? `mineruCacheDir=${entry.mineruCacheDir}` : "",
  ].filter(Boolean);
  return `- ${prefix} ${index + 1}: ${entry.title} [${metadata.join(", ")}]`;
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
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .map((message) => ({
      role: message.role,
      content: stringifyMessageContent(message.content),
    }));
}

function buildFullUserMessage(
  request: AgentRuntimeRequest,
  options: { priorReadBlock?: string } = {},
): AgentModelMessage {
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
  if (request.activeNoteContext) {
    const note = request.activeNoteContext;
    contextLines.push(
      `- Active note: ${note.title} [noteId=${note.noteId}, kind=${note.noteKind}]`,
    );
    if (note.parentItemId) {
      contextLines.push(`- Active note parent item ID: ${note.parentItemId}`);
    }
    contextLines.push(
      `Current note content for this turn:\n"""\n${note.noteText}\n"""`,
    );
    if (note.noteHtml) {
      contextLines.push(`Original note HTML:\n"""\n${note.noteHtml}\n"""`);
    }
  }
  if (Array.isArray(request.selectedTexts) && request.selectedTexts.length) {
    const selectedTextBlock = request.selectedTexts
      .map((entry, index) => {
        const source = request.selectedTextSources?.[index];
        const paperContext = request.selectedTextPaperContexts?.[index];
        const sourceLabel =
          source === "model"
            ? "model response"
            : source === "note"
              ? "Zotero note"
              : source === "note-edit"
                ? "active note editing focus"
                : "PDF reader";
        const sourceMeta =
          source === "pdf" && paperContext
            ? `, paper=${paperContext.title}, source_label=${formatPaperSourceLabel(paperContext)}`
            : "";
        return `Selected text ${index + 1} [source=${sourceLabel}${sourceMeta}]:\n"""\n${entry}\n"""`;
      })
      .join("\n\n");
    contextLines.push(selectedTextBlock);
  }
  const citationPaperRefs = [
    ...(request.selectedTextPaperContexts || []).filter(
      (entry): entry is PaperContextRef => Boolean(entry),
    ),
    ...retrievalOnlyPapers,
    ...(request.fullTextPaperContexts || []),
  ];
  if (citationPaperRefs.length) {
    contextLines.push(
      "Citation/source label rule: for direct quotes and substantive paper-grounded claims, use the exact sourceLabel shown for the relevant paper.",
    );
  }
  if (retrievalOnlyPapers.length) {
    contextLines.push(
      "Retrieval-only paper refs:",
      ...retrievalOnlyPapers.map((entry, index) =>
        formatPaperRefLine("Retrieval paper", entry, index),
      ),
    );
  }
  if (
    Array.isArray(request.fullTextPaperContexts) &&
    request.fullTextPaperContexts.length
  ) {
    contextLines.push(
      "Full-text paper refs for this turn:",
      ...request.fullTextPaperContexts.map((entry, index) =>
        formatPaperRefLine("Full-text paper", entry, index),
      ),
      ...request.fullTextPaperContexts
        .flatMap((entry) => buildPaperQuoteCitationGuidance(entry))
        .filter(Boolean),
    );
  }
  if (
    Array.isArray(request.selectedCollectionContexts) &&
    request.selectedCollectionContexts.length
  ) {
    contextLines.push(
      "Selected Zotero collection scopes:",
      ...request.selectedCollectionContexts.map(
        (entry, index) =>
          `- Collection ${index + 1}: ${entry.name} [collectionId=${entry.collectionId}, libraryID=${entry.libraryID}]`,
      ),
      "Treat these collections as scoped candidate sets. Use library_search({ entity:'items', mode:'list', filters:{ collectionId:<collectionId> } }) or collection-scoped actions when the user asks to inspect or operate on them. Do not assume all full text has already been read.",
      "If the user explicitly asks to read or analyze the full text of every paper in a collection, plan a batch workflow: enumerate papers, read/process them in bounded batches, create compact per-paper digests with evidence, then synthesize.",
    );
  }
  const pdfAttachments = (request.attachments || []).filter(
    (a) =>
      a.category === "pdf" &&
      typeof a.storedPath === "string" &&
      a.storedPath.trim(),
  );
  const nonPdfAttachments = (request.attachments || []).filter(
    (a) => a.category !== "pdf",
  );
  if (nonPdfAttachments.length) {
    contextLines.push(
      "Current uploaded attachments are available through the registered document tools.",
    );
  }
  if (options.priorReadBlock) {
    contextLines.push(options.priorReadBlock);
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

function buildUserMessage(
  request: AgentRuntimeRequest,
  resourceContextPlan?: AgentResourceContextPlan,
): AgentModelMessage {
  if (
    resourceContextPlan &&
    (resourceContextPlan.injection === "thin" ||
      resourceContextPlan.injection === "delta")
  ) {
    return renderAgentResourceContextPlan(resourceContextPlan, request);
  }
  return buildFullUserMessage(request, {
    priorReadBlock: resourceContextPlan?.priorReadBlock,
  });
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

function buildAutoReadInstruction(
  request: AgentRuntimeRequest,
  resourceContextPlan?: AgentResourceContextPlan,
): string {
  const fullTextPapers = request.fullTextPaperContexts || [];
  if (!fullTextPapers.length) return "";
  if (
    resourceContextPlan?.lifecycleState === "thin-followup" &&
    resourceContextPlan.injection === "thin"
  ) {
    return (
      "TURN RULE: The same full-text paper resources remain in this conversation. " +
      "Reuse the prior paper_read context already in the conversation when it is sufficient. " +
      "Call paper_read({ mode:'targeted', query:'...' }) only if the follow-up asks for evidence that has not already been read."
    );
  }
  const allHaveMineruCache = fullTextPapers.every((entry) =>
    Boolean(entry.mineruCacheDir),
  );
  if (allHaveMineruCache) {
    return (
      "TURN RULE: Because the user marked specific paper(s) for full-text use on this turn, " +
      "your very first action MUST be to call `paper_read({ mode:'overview' })` targeting only those full-text papers. " +
      "The paper_read facade dispatches to the available MinerU or PDF text path; use `paper_read({ mode:'targeted', query:'...' })` only for a specific missing claim. " +
      "Do this before answering, even if the answer seems obvious."
    );
  }
  return (
    "TURN RULE: Because the user marked specific paper(s) for full-text use on this turn, " +
    "your very first action MUST be to call `paper_read({ mode:'overview' })` targeting only those full-text papers. " +
    "Do this before answering, even if the answer seems obvious. " +
    "Do not include retrieval-only papers in that mandatory first read."
  );
}

function getInScopePaperContexts(request: AgentRuntimeRequest) {
  return [
    ...(request.selectedPaperContexts || []),
    ...(request.fullTextPaperContexts || []),
    ...(request.pinnedPaperContexts || []),
  ];
}

function buildFigureMineruInstruction(
  request: AgentRuntimeRequest,
  matchedSkillIds: ReadonlyArray<string>,
): string {
  const activeSkillIds = new Set([
    ...matchedSkillIds,
    ...(request.forcedSkillIds || []),
  ]);
  if (!activeSkillIds.has("analyze-figures")) return "";
  const mineruPapers = getInScopePaperContexts(request).filter((entry) =>
    Boolean(entry.mineruCacheDir),
  );
  if (!mineruPapers.length) return "";
  const cacheHints = mineruPapers
    .map((entry, index) => {
      const label = entry.title?.trim() || `paper ${index + 1}`;
      return `- ${label}: ${entry.mineruCacheDir}`;
    })
    .join("\n");
  return (
    "TURN RULE: This is a figure/table interpretation task and MinerU cache is available for at least one in-scope paper. " +
    "Prefer the semantic `paper_read` path: use `paper_read({ mode:'visual', query:'<figure/table label>' })` for rendered page inspection and `paper_read({ mode:'targeted', query:'<figure/table label and surrounding discussion>' })` for text around the figure. " +
    "If a MinerU image path is explicitly needed for note embedding, inspect the cache with `file_io({ action:'read', filePath:'{mineruCacheDir}/manifest.json' })` and read only the relevant image/section.\n" +
    `Available MinerU cache directories:\n${cacheHints}`
  );
}

function buildWriteNoteFileInstruction(
  request: AgentRuntimeRequest,
  matchedSkillIds: ReadonlyArray<string>,
): string {
  const activeSkillIds = new Set([
    ...matchedSkillIds,
    ...(request.forcedSkillIds || []),
  ]);
  if (!activeSkillIds.has("write-note")) return "";
  const text = request.userText || "";
  if (/\b(zotero\s+note|current\s+zotero\s+note|active\s+note)\b/i.test(text)) {
    return "TURN RULE: The user is asking for a Zotero note edit. Use `note_write` for the Zotero note workflow rather than writing an external Markdown file.";
  }
  if (
    !/\b(obsidian|vault|markdown\s+file|md\s+file|file|folder|directory|disk|export|save|write\s+(?:it|this|that)?\s*(?:to|into))\b/i.test(
      text,
    )
  ) {
    return "";
  }
  return (
    'TURN RULE: The user is asking for an Obsidian/file-based note. Successful completion requires calling `file_io` with `action: "write"` and Markdown content. ' +
    "Do not finish by placing the full note body in chat. If the notes directory is not configured or the target path cannot be resolved, give a brief setup error instead of dumping the note body."
  );
}

function buildRuntimePlatformSection(): string {
  return buildRuntimePlatformGuidanceText();
}

function buildTextOnlyModelInstruction(request: AgentRuntimeRequest): string {
  if (resolveRequestProviderCapabilities(request).multimodal) return "";
  const modelLabel = (request.model || "selected model").trim();
  return (
    `MODEL LIMITATION: ${modelLabel} is treated as text-only in this plugin. ` +
    "Do not rely on screenshots, PDF page images, or image-file visual inspection. " +
    "For MinerU-cached papers, prefer `manifest.json`, `full.md` section offsets, captions, tables, formulas, and surrounding extracted text. " +
    "If the user asks for information that requires direct visual inspection and only an image is available, state that this model cannot inspect the image directly and answer only from extracted text/captions."
  );
}

export async function buildAgentInitialMessages(
  request: AgentRuntimeRequest,
  tools: AgentToolDefinition<any, any>[],
  matchedSkillIds: ReadonlyArray<string>,
  resourceContextPlan?: AgentResourceContextPlan,
): Promise<AgentModelMessage[]> {
  const memoryBlock = await buildAgentMemoryBlock(request.conversationKey);
  const autoReadInstruction = buildAutoReadInstruction(
    request,
    resourceContextPlan,
  );
  const workflowParityInstructions = [
    buildFigureMineruInstruction(request, matchedSkillIds),
    buildWriteNoteFileInstruction(request, matchedSkillIds),
  ].filter(Boolean);

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
      id: "model-limitations",
      lines: [buildTextOnlyModelInstruction(request)],
    },
    {
      id: "custom-instructions",
      lines: [(request.customInstructions || "").trim()],
    },
    {
      id: "notes-directory-config",
      lines: [buildNotesDirectoryConfigSection()],
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
    {
      id: "workflow-parity",
      lines: workflowParityInstructions,
    },
  ];

  return [
    {
      role: "system",
      content: buildSystemPrompt(sections),
    },
    ...normalizeHistoryMessages(request),
    buildUserMessage(request, resourceContextPlan),
  ];
}
