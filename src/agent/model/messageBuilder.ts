import type {
  AgentContentInputCapabilities,
  AgentModelMessage,
  AgentRuntimeRequest,
  AgentToolDefinition,
} from "../types";
import { AGENT_PERSONA_INSTRUCTIONS } from "./agentPersona";
import { buildAgentMemoryBlock } from "../store/conversationMemory";
import { getAllSkills } from "../skills";
import type { AgentSkill } from "../skills";
import { classifyWriteNoteDestination } from "../writeNoteDestination";

import { resolveProviderCapabilities } from "../../providers";
import type { ProviderCapabilities } from "../../providers";
import {
  buildNotesDirectoryConfigSection,
  getNotesDirectoryNickname,
} from "../../utils/notesDirectoryConfig";
import { buildRuntimePlatformGuidanceText } from "../../utils/runtimePlatform";
import { formatPaperSourceLabel } from "../../modules/contextPanel/paperAttribution";
import {
  buildQuoteAnchorPromptBlock,
  buildSelectedTextQuoteCitations,
} from "../../modules/contextPanel/quoteCitations";
import {
  buildAgentStableResourceContextBlock,
  type AgentResourceContextPlan,
} from "../context/resourceContextPlan";
import { buildAgentCoverageContextBlock } from "../context/coverageLedger";
import { buildVisibleTurnContextBlock } from "../context/turnContextEnvelope";
import {
  hasAgentContentInputs,
  normalizeAgentContentInputs,
} from "./contentCapabilities";

export function isMultimodalRequestSupported(
  request: AgentRuntimeRequest,
): boolean {
  return hasAgentContentInputs(resolveRequestContentInputs(request));
}

function resolveRequestProviderCapabilities(
  request: AgentRuntimeRequest,
): ProviderCapabilities {
  return resolveProviderCapabilities({
    model: request.model || "",
    protocol: request.providerProtocol,
    authMode: request.authMode,
    apiBase: request.apiBase,
    inputMode: request.advanced?.inputMode,
  });
}

export function resolveRequestContentInputs(
  request: AgentRuntimeRequest,
): AgentContentInputCapabilities {
  const capabilities = resolveRequestProviderCapabilities(request);
  return {
    images: capabilities.images,
    pdfDocuments: capabilities.pdf === "native",
    nativeFiles:
      capabilities.tier === "native" &&
      request.providerProtocol === "responses_api" &&
      capabilities.pdf === "native",
  };
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

export function normalizeHistoryMessages(
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
  options: {
    priorReadBlock?: string;
    coverageBlock?: string;
    memoryBlock?: string;
    turnGuidanceBlock?: string;
    contentInputs?: AgentContentInputCapabilities;
  } = {},
): AgentModelMessage {
  const contextLines: string[] = [];
  const visibleTurnContext = buildVisibleTurnContextBlock(request);
  if (visibleTurnContext) {
    contextLines.push(visibleTurnContext);
  }
  if (request.activeNoteContext) {
    const note = request.activeNoteContext;
    contextLines.push(
      `Current note content for this turn:\n"""\n${note.noteText}\n"""`,
    );
    if (note.noteHtml) {
      contextLines.push(`Original note HTML:\n"""\n${note.noteHtml}\n"""`);
    }
  }
  if (Array.isArray(request.selectedTexts) && request.selectedTexts.length) {
    const selectedTextQuoteAnchors = buildQuoteAnchorPromptBlock(
      buildSelectedTextQuoteCitations(
        request.selectedTexts,
        request.selectedTextSources,
        request.selectedTextPaperContexts,
      ),
    );
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
    contextLines.push(
      [...selectedTextQuoteAnchors, selectedTextBlock]
        .filter(Boolean)
        .join("\n\n"),
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
  if (options.coverageBlock) {
    contextLines.push(options.coverageBlock);
  }
  if (options.memoryBlock) {
    contextLines.push(options.memoryBlock);
  }
  if (options.turnGuidanceBlock) {
    contextLines.push(options.turnGuidanceBlock);
  }

  const promptText = `${
    contextLines.length ? `${contextLines.join("\n")}\n\n` : ""
  }User request:\n${request.userText}`;
  const screenshots = Array.isArray(request.screenshots)
    ? request.screenshots.filter((entry) => Boolean(entry))
    : [];
  const contentInputs = normalizeAgentContentInputs(
    options.contentInputs || resolveRequestContentInputs(request),
  );
  const imageParts = contentInputs.images
    ? screenshots.map((url) => ({
        type: "image_url" as const,
        image_url: {
          url,
          detail: "high" as const,
        },
      }))
    : [];
  const pdfParts =
    contentInputs.pdfDocuments || contentInputs.nativeFiles
      ? pdfAttachments.map((a) => ({
          type: "file_ref" as const,
          file_ref: {
            name: a.name,
            mimeType: a.mimeType || "application/pdf",
            storedPath: a.storedPath as string,
            contentHash: a.contentHash,
          },
        }))
      : [];
  if (!imageParts.length && !pdfParts.length) {
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
      ...imageParts,
      ...pdfParts,
    ],
  };
}

function buildUserMessage(
  request: AgentRuntimeRequest,
  resourceContextPlan?: AgentResourceContextPlan,
  options: {
    coverageBlock?: string;
    memoryBlock?: string;
    turnGuidanceBlock?: string;
    contentInputs?: AgentContentInputCapabilities;
  } = {},
): AgentModelMessage {
  return buildFullUserMessage(request, {
    priorReadBlock: resourceContextPlan?.priorReadBlock,
    coverageBlock: options.coverageBlock,
    memoryBlock: options.memoryBlock,
    turnGuidanceBlock: options.turnGuidanceBlock,
    contentInputs: options.contentInputs,
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

function collectToolGuidanceInstructions(
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

  if (!instructions.size) return [];
  return [
    "The following stable tool guidance is provided because the user's message may be relevant to these capabilities. " +
      "Use your judgement: only invoke a tool if it directly addresses what the user is asking for. " +
      "Do NOT invoke a tool just because its guidance appears here — the user's actual intent takes priority.",
    ...instructions,
  ];
}

function formatSkillGuidanceBlock(
  skill: AgentSkill,
  activationSource: string,
): string {
  const lines = [
    `### Skill: ${skill.id}`,
    `Description: ${skill.description || "No description provided."}`,
    `Activation: ${activationSource}`,
    "Instructions:",
    skill.instruction.trim(),
  ];
  return lines.filter(Boolean).join("\n");
}

function collectSkillGuidanceInstructions(
  request: AgentRuntimeRequest,
  matchedSkillIds: ReadonlyArray<string>,
): string[] {
  const blocks: string[] = [];
  const activeSkillIds = new Set(matchedSkillIds);
  const forcedSkillIds = new Set(request.forcedSkillIds || []);
  for (const skill of getAllSkills()) {
    if (!activeSkillIds.has(skill.id)) continue;
    const instruction = skill.instruction.trim();
    if (!instruction) continue;
    blocks.push(
      formatSkillGuidanceBlock(
        skill,
        forcedSkillIds.has(skill.id)
          ? "explicit slash selection"
          : "automatic match",
      ),
    );
  }
  if (!blocks.length) return [];
  return [
    "Active skills for this turn:",
    "Treat each skill below as a separate workflow module. If multiple skills are active, first decide which part of the user's request each skill covers. Prefer explicitly selected slash skills when they are relevant. If skill instructions conflict, follow the user's explicit request and the available tool/safety constraints.",
    ...blocks,
  ];
}

function buildTurnGuidanceBlock(instructions: string[]): string {
  const lines = instructions.map((entry) => entry.trim()).filter(Boolean);
  if (!lines.length) return "";
  return ["Current-turn dynamic agent guidance:", ...lines].join("\n\n");
}

function buildAutoReadInstruction(request: AgentRuntimeRequest): string {
  const fullTextPapers = request.fullTextPaperContexts || [];
  if (!fullTextPapers.length) return "";
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
    "For figure/image questions, call `paper_read({ mode:'figures', query:'<figure label or all figures>' })` first. This returns precise PDF crops plus captions/provenance. Treat that result as the authority for figure crop cache reuse/regeneration; use returned crop paths/artifacts as-is and do not inspect or validate `figure_crops` metadata before analysis or writing. " +
    "If figure extraction fails or returns no crops, switch to text-only mode for analysis, note taking, and follow-up artifacts: do not include figure images, rendered PDF page screenshots, MinerU source images, or extracted-image placeholders; explicitly state that extraction failed or no extracted crops are available and base explanations on captions, figure legends, and surrounding paper text. Manual user-provided image inputs are unaffected. " +
    "For table questions, call `paper_read({ mode:'targeted', query:'<table label and surrounding discussion>' })` because MinerU table evidence is text/structure, not figure crops. " +
    "Use `full.md`/manifest text for captions and surrounding textual evidence, but do not read or embed MinerU image paths for ordinary figure interpretation. " +
    "For explicit panel requests, inspect the whole extracted figure crop and treat panel suffixes as hints. " +
    "Use `paper_read({ mode:'visual', query:'<page/layout request>' })` only when the user explicitly asks for rendered/raw PDF pages, page screenshots, page layout, exact pages, or visible-reader inspection.\n" +
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
  const destination = classifyWriteNoteDestination(
    request.userText,
    getNotesDirectoryNickname(),
  );
  if (destination === "zotero") {
    return (
      "TURN RULE: The user is asking for a Zotero note workflow. Use `note_write` rather than writing an external Markdown file. " +
      "After `note_write` succeeds, do not also call `file_io` or `run_command` unless the user explicitly requested a filesystem output."
    );
  }
  if (destination === "file") {
    return (
      'TURN RULE: The user is asking for an Obsidian/file-based note. Successful completion requires calling `file_io` with `action: "write"` and Markdown content. ' +
      "Do not finish by placing the full note body in chat. If the notes directory is not configured or the target path cannot be resolved, give a brief setup error instead of dumping the note body."
    );
  }
  return "";
}

function buildForcedSkillWholeLibraryInstruction(
  request: AgentRuntimeRequest,
): string {
  if (!request.forcedSkillIds?.length) return "";
  if (request.conversationKind === "paper") return "";
  const hasExplicitContext = Boolean(
    request.selectedPaperContexts?.length ||
    request.fullTextPaperContexts?.length ||
    request.pinnedPaperContexts?.length ||
    request.selectedCollectionContexts?.length ||
    request.selectedTagContexts?.length ||
    request.selectedTextSources?.length ||
    request.attachments?.length ||
    request.screenshots?.length,
  );
  if (hasExplicitContext) return "";
  return (
    "TURN RULE: The user explicitly selected a skill in library chat without selecting a narrower context. " +
    "Treat the intended context as the whole Zotero library, and use library-scoped tools or searches accordingly."
  );
}

function buildRuntimePlatformSection(): string {
  return buildRuntimePlatformGuidanceText();
}

function buildTextOnlyModelInstruction(request: AgentRuntimeRequest): string {
  if (isMultimodalRequestSupported(request)) return "";
  const modelLabel = (request.model || "selected model").trim();
  return (
    `MODEL LIMITATION: ${modelLabel} is treated as text-only in this plugin. ` +
    "Do not rely on screenshots, PDF page images, or image-file visual inspection. " +
    "For MinerU-cached papers, prefer `manifest.json`, `full.md` section offsets, captions, tables, formulas, and surrounding extracted text. " +
    "For figure workflows, you may still call `paper_read({ mode:'figures' })` to obtain extracted crop paths, captions, warnings, and provenance for note embedding. Treat that result as the authority for figure crop cache reuse/regeneration; do not inspect or validate `figure_crops` metadata before analysis or writing. Do not make unsupported visual claims unless an image-capable model inspected the crop."
  );
}

export async function buildAgentInitialMessages(
  request: AgentRuntimeRequest,
  tools: AgentToolDefinition<any, any>[],
  matchedSkillIds: ReadonlyArray<string>,
  resourceContextPlan?: AgentResourceContextPlan,
  options: {
    transcriptMessages?: AgentModelMessage[];
    contentInputs?: AgentContentInputCapabilities;
  } = {},
): Promise<AgentModelMessage[]> {
  const memoryBlock = await buildAgentMemoryBlock(request.conversationKey);
  const autoReadInstruction = buildAutoReadInstruction(request);
  const workflowParityInstructions = [
    buildFigureMineruInstruction(request, matchedSkillIds),
    buildWriteNoteFileInstruction(request, matchedSkillIds),
    buildForcedSkillWholeLibraryInstruction(request),
  ].filter(Boolean);
  const turnGuidanceBlock = buildTurnGuidanceBlock([
    autoReadInstruction,
    ...workflowParityInstructions,
    ...collectToolGuidanceInstructions(request, tools),
    ...collectSkillGuidanceInstructions(request, matchedSkillIds),
  ]);
  const coverageBlock = buildAgentCoverageContextBlock({
    conversationKey: request.conversationKey,
    request,
  });

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
  ];
  const stableResourceBlock =
    resourceContextPlan?.stableContextBlock ||
    buildAgentStableResourceContextBlock(request);

  return [
    {
      role: "system",
      content: buildSystemPrompt(sections),
    },
    ...(stableResourceBlock
      ? [
          {
            role: "system" as const,
            content: stableResourceBlock,
            cachePolicy: "stable-prefix" as const,
          },
        ]
      : []),
    ...(options.transcriptMessages?.length
      ? options.transcriptMessages
      : normalizeHistoryMessages(request)),
    buildUserMessage(request, resourceContextPlan, {
      coverageBlock,
      memoryBlock,
      turnGuidanceBlock,
      contentInputs: options.contentInputs,
    }),
  ];
}
