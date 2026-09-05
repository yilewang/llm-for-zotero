import { renderLibraryOverviewSection } from "../context/libraryOverview";

import type {
  AgentContentInputCapabilities,
  AgentActionObligation,
  AgentModelContentPart,
  AgentModelMessage,
  AgentRuntimeRequest,
  AgentSystemMessage,
  AgentToolDefinition,
  AgentUserMessage,
} from "../types";
import { actionToolGuidanceForCapabilities } from "../contracts/actionEvaluation";
import { AGENT_PERSONA_INSTRUCTIONS } from "./agentPersona";
import { buildAgentMemoryBlock } from "../store/conversationMemory";
import { getAllSkills } from "../skills";
import type { AgentSkill } from "../skills";
import { getSkillCustomizationNotice } from "../skills/managedBlock";
import { classifyWriteNoteDestination } from "../writeNoteDestination";
import { WRITE_NOTE_SKILL_ID } from "../skills/noteIntent";

import { resolveProviderCapabilities } from "../../providers";
import type { ProviderCapabilities } from "../../providers";
import {
  buildNotesDirectoryConfigSection,
  getNotesDirectoryNickname,
} from "../../utils/notesDirectoryConfig";
import { NOTE_EDITING_QUOTE_BLOCK_GUIDANCE } from "../../shared/quoteGuidance";
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
import { getSelectedPassagePaper } from "../context/turnPaperScope";
import {
  hasAgentContentInputs,
  normalizeAgentContentInputs,
} from "./contentCapabilities";
import { detectExplicitFullReadIntent } from "../../modules/contextPanel/retrievalQueryPlan";
import { synthesizeSelectedTextContexts } from "../../modules/contextPanel/normalizers";
import {
  formatSelectedTextLocator,
  renderSelectedTextAnchorContext,
} from "../../modules/contextPanel/selectedTextAnchorFormatting";
import {
  buildInstructionInventory,
  type InstructionInventory,
} from "./instructionInventory";

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

function describeFrozenTargets(obligation: AgentActionObligation): string {
  const boundary = obligation.targetBoundary;
  if (!boundary) return "";
  if (boundary.frozenTargetIds.length <= 50) {
    return `frozen item IDs [${boundary.frozenTargetIds.join(", ")}]`;
  }
  return `${boundary.frozenTargetIds.length} frozen targets (scope digest ${boundary.scopeDigest})`;
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
): AgentUserMessage {
  const contextLines: string[] = [];
  // Volatile by nature (collection ids and counts change as the agent works),
  // so it lives here rather than in the cached system prefix.
  const libraryOverview = renderLibraryOverviewSection(request.libraryID);
  if (libraryOverview) {
    contextLines.push(libraryOverview);
  }
  const visibleTurnContext = buildVisibleTurnContextBlock(request);
  if (visibleTurnContext) {
    contextLines.push(visibleTurnContext);
  }
  if (request.actionContract?.obligations.length) {
    const obligations = request.actionContract.obligations.map((obligation) => {
      const scope = obligation.scope
        ? obligation.scopeRole === "destination"
          ? ` exact destination collection "${obligation.scope.collectionPath}" (ID ${obligation.scope.collectionId})`
          : ` exact source collection "${obligation.scope.collectionPath}", direct members only, ${describeFrozenTargets(obligation)}`
        : obligation.targetBoundary?.kind === "library"
          ? ` frozen whole-library scope, ${describeFrozenTargets(obligation)}`
          : obligation.targetBoundary?.kind === "selection"
            ? ` frozen selected scope, ${describeFrozenTargets(obligation)}`
            : "";
      const constraint = obligation.constraints?.tagPrefix
        ? `, required tag prefix "${obligation.constraints.tagPrefix}"`
        : "";
      return `- ${obligation.capability}; coverage=${obligation.coverage}; targets=${obligation.targetKind};${scope}${constraint}`;
    });
    contextLines.push(
      [
        "Action contract for this turn:",
        ...obligations,
        `Tool guidance: ${actionToolGuidanceForCapabilities(
          request.actionContract.obligations.map(
            (obligation) => obligation.capability,
          ),
        )}`,
        "Do not widen an exact collection to its parent or descendants. A completion claim requires a verified tool receipt covering this contract; already-satisfied targets count, but prose and opaque script/command output do not.",
      ].join("\n"),
    );
  }
  if (request.activeNoteContext) {
    const note = request.activeNoteContext;
    contextLines.push(
      `Current note content for this turn:\n"""\n${note.noteText}\n"""`,
    );
    contextLines.push(NOTE_EDITING_QUOTE_BLOCK_GUIDANCE);
    if (note.noteHtml) {
      contextLines.push(`Original note HTML:\n"""\n${note.noteHtml}\n"""`);
    }
  }
  const selectedTextContexts = synthesizeSelectedTextContexts({
    selectedTextContexts: request.selectedTextContexts,
    selectedTexts: request.selectedTexts,
    selectedTextSources: request.selectedTextSources,
    selectedTextPaperContexts: (request.selectedTextContexts || []).map(
      (_context, index) =>
        getSelectedPassagePaper(request.turnPaperScope, index),
    ),
    selectedTextNoteContexts: request.selectedTextNoteContexts,
  });
  const selectedTexts = selectedTextContexts.map((context) => context.text);
  const selectedTextSources = selectedTextContexts.map(
    (context) => context.source,
  );
  const selectedTextPaperContexts = selectedTextContexts.map(
    (_context, index) => getSelectedPassagePaper(request.turnPaperScope, index),
  );
  const anchorsByIndex = new Map(
    (request.resolvedSelectedTextAnchors || []).map((anchor) => [
      anchor.contextIndex,
      anchor,
    ]),
  );
  if (selectedTexts.length) {
    const selectedTextQuoteAnchors = buildQuoteAnchorPromptBlock(
      buildSelectedTextQuoteCitations(
        selectedTexts,
        selectedTextSources,
        selectedTextPaperContexts,
      ),
    );
    const selectedTextBlock = selectedTexts
      .map((entry, index) => {
        const source = selectedTextSources[index];
        const paperContext = selectedTextPaperContexts[index];
        const sourceLabel =
          source === "model"
            ? "model response"
            : source === "note"
              ? "Zotero note"
              : source === "note-edit"
                ? "active note editing focus"
                : "PDF reader";
        const noteContext = selectedTextContexts[index]?.noteContext;
        const sourceMeta =
          source === "pdf" && paperContext
            ? `, paper=${paperContext.title}, source_label=${formatPaperSourceLabel(paperContext)}`
            : source === "note-edit" && noteContext
              ? [
                  `, note=${noteContext.title}`,
                  noteContext.noteItemId
                    ? `note_id=${noteContext.noteItemId}`
                    : "",
                  `note_kind=${noteContext.noteKind}`,
                  noteContext.parentItemId
                    ? `parent_item_id=${noteContext.parentItemId}`
                    : "",
                ]
                  .filter(Boolean)
                  .join(", ")
              : "";
        const locator = formatSelectedTextLocator(
          selectedTextContexts[index],
          anchorsByIndex.get(index),
        );
        return `Selected text ${index + 1} [source=${sourceLabel}${sourceMeta}]${locator ? ` ${locator}` : ""}:\n"""\n${entry}\n"""`;
      })
      .join("\n\n");
    contextLines.push(
      [...selectedTextQuoteAnchors, selectedTextBlock]
        .filter(Boolean)
        .join("\n\n"),
    );
    const anchorContext = renderSelectedTextAnchorContext({
      selectedTextContexts,
      anchors: [...(request.resolvedSelectedTextAnchors || [])],
    });
    if (anchorContext) contextLines.push(anchorContext);
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
): AgentUserMessage {
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

export type AgentPromptEnvelope = Readonly<{
  systemMessages: readonly Readonly<AgentSystemMessage>[];
  turnMessage: Readonly<AgentUserMessage>;
}>;

type AgentPromptInventoryState = Readonly<{
  fixedPrompt: string;
  tools: readonly AgentToolDefinition<any, any>[];
  matchedSkillInstructions: readonly string[];
  dynamicGuidance: string;
  stableResourceBlock: string;
  turnResource: string;
}>;

export type RenderedAgentPromptEnvelope = Readonly<{
  envelope: AgentPromptEnvelope;
  inventory: AgentPromptInventoryState;
}>;

function cloneContentPart(part: AgentModelContentPart): AgentModelContentPart {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  if (part.type === "image_url") {
    return {
      type: "image_url",
      image_url: {
        url: part.image_url.url,
        detail: part.image_url.detail,
      },
    };
  }
  return {
    type: "file_ref",
    file_ref: {
      name: part.file_ref.name,
      mimeType: part.file_ref.mimeType,
      storedPath: part.file_ref.storedPath,
      contentHash: part.file_ref.contentHash,
    },
  };
}

function cloneModelMessage(message: AgentModelMessage): AgentModelMessage {
  const content =
    typeof message.content === "string"
      ? message.content
      : message.content.map(cloneContentPart);
  if (message.role === "assistant") {
    return {
      ...message,
      content,
      tool_calls: message.tool_calls?.map((call) => ({ ...call })),
    };
  }
  return { ...message, content } as AgentModelMessage;
}

function freezeEnvelopeMessage<
  TMessage extends AgentSystemMessage | AgentUserMessage,
>(message: TMessage): Readonly<TMessage> {
  const cloned = cloneModelMessage(message) as TMessage;
  if (typeof cloned.content !== "string") {
    for (const part of cloned.content) {
      if (part.type === "image_url") Object.freeze(part.image_url);
      if (part.type === "file_ref") Object.freeze(part.file_ref);
      Object.freeze(part);
    }
    Object.freeze(cloned.content);
  }
  return Object.freeze(cloned);
}

function buildSystemPrompt(sections: PromptSection[]): string {
  return sections
    .flatMap(({ lines }) => lines)
    .filter(Boolean)
    .join("\n\n");
}

function collectToolGuidanceInstructions(
  request: AgentRuntimeRequest,
  tools: AgentToolDefinition<any, any>[],
  matchedSkillIds: ReadonlyArray<string>,
): string[] {
  const instructions = new Set<string>();
  for (const tool of tools) {
    const guidance = tool.guidance;
    if (!guidance) continue;
    if (!guidance.matches(request, { matchedSkillIds })) continue;
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
  const customizationNotice = getSkillCustomizationNotice(skill.instruction);
  const lines = [
    `### Skill: ${skill.id}`,
    customizationNotice || "",
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
  const fullTextPapers = request.turnPaperScope.papers
    .filter((entry) => entry.roles.includes("full_text"))
    .map((entry) => entry.paper);
  if (!fullTextPapers.length) return "";
  if (detectExplicitFullReadIntent(request.userText || "")) {
    return (
      "TURN RULE: The user explicitly requested exhaustive full-text reading. " +
      "Your very first action MUST be to call `paper_read({ mode:'full' })` targeting only the requested paper(s). " +
      "Overview and targeted retrieval do not satisfy this request. Preserve the coverage receipt and do not claim complete reading when it is partial or unreadable."
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
  return request.turnPaperScope.papers.map((entry) => entry.paper);
}

function hasFigureTaskIntent(
  request: AgentRuntimeRequest,
  matchedSkillIds: ReadonlyArray<string>,
): boolean {
  const activeSkillIds = new Set([
    ...matchedSkillIds,
    ...(request.forcedSkillIds || []),
  ]);
  if (activeSkillIds.has("analyze-figures")) return true;
  const text = request.userText || "";
  if (
    /\b(?:figure|fig\.?|table|diagram|chart|graph|plot|schematic|image|panel)\s*(?:[a-z]?\d+[a-z]?|[ivx]+)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:analy[sz]e|interpret|inspect|describe|walk\s+me\s+through|explain)\s+(?:this|that|the)\s+(?:figure|fig\.?|table|diagram|chart|graph|plot|schematic|image|panel)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  return /\b(?:this|that|the)\s+(?:figure|fig\.?|table|diagram|chart|graph|plot|schematic|image|panel)\b.{0,80}\b(?:show|mean|indicate|depict|demonstrate)\b/i.test(
    text,
  );
}

function buildFigureMineruInstruction(
  request: AgentRuntimeRequest,
  matchedSkillIds: ReadonlyArray<string>,
): string {
  if (!hasFigureTaskIntent(request, matchedSkillIds)) return "";
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
  if (!activeSkillIds.has(WRITE_NOTE_SKILL_ID)) return "";
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
  if (destination === "both") {
    return (
      "TURN RULE: The user explicitly requested both a Zotero note and a filesystem export. " +
      'Use `note_write` for the Zotero note and `file_io` with `action: "write"` for the external Markdown file. Both independently verified results are required before finishing.'
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
    request.turnPaperScope.papers.length ||
    request.turnPaperScope.collections.length ||
    request.turnPaperScope.tags.length ||
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

function buildTextOnlyModelInstruction(
  request: AgentRuntimeRequest,
  matchedSkillIds: ReadonlyArray<string>,
): string {
  if (isMultimodalRequestSupported(request)) return "";
  const modelLabel = (request.model || "selected model").trim();
  if (!hasFigureTaskIntent(request, matchedSkillIds)) {
    return request.screenshots?.length
      ? `MODEL LIMITATION: ${modelLabel} is text-only and cannot inspect the supplied screenshots.`
      : "";
  }
  return (
    `MODEL LIMITATION: ${modelLabel} is treated as text-only in this plugin. ` +
    "Do not rely on screenshots, PDF page images, or image-file visual inspection. " +
    "For MinerU-cached papers, prefer `manifest.json`, `full.md` section offsets, captions, tables, formulas, and surrounding extracted text. " +
    "For figure workflows, you may still call `paper_read({ mode:'figures' })` to obtain extracted crop paths, captions, warnings, and provenance for note embedding. Treat that result as the authority for figure crop cache reuse/regeneration; do not inspect or validate `figure_crops` metadata before analysis or writing. Do not make unsupported visual claims unless an image-capable model inspected the crop."
  );
}

export async function renderAgentPromptEnvelope(
  request: AgentRuntimeRequest,
  tools: AgentToolDefinition<any, any>[],
  matchedSkillIds: ReadonlyArray<string>,
  resourceContextPlan?: AgentResourceContextPlan,
  options: {
    contentInputs?: AgentContentInputCapabilities;
  } = {},
): Promise<RenderedAgentPromptEnvelope> {
  const memoryBlock = await buildAgentMemoryBlock(request.conversationKey);
  const autoReadInstruction = buildAutoReadInstruction(request);
  const workflowParityInstructions = [
    buildFigureMineruInstruction(request, matchedSkillIds),
    buildWriteNoteFileInstruction(request, matchedSkillIds),
    buildForcedSkillWholeLibraryInstruction(request),
  ].filter(Boolean);
  const dynamicGuidanceInstructions = [
    autoReadInstruction,
    ...workflowParityInstructions,
    ...collectToolGuidanceInstructions(request, tools, matchedSkillIds),
  ];
  const matchedSkillInstructions = collectSkillGuidanceInstructions(
    request,
    matchedSkillIds,
  );
  const turnGuidanceBlock = buildTurnGuidanceBlock([
    ...dynamicGuidanceInstructions,
    ...matchedSkillInstructions,
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
      lines: [buildTextOnlyModelInstruction(request, matchedSkillIds)],
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
  // The library overview is deliberately NOT a system section.
  //
  // The cache breakpoint sits at the last "stable-prefix" block, so every
  // system section is inside the cached prefix. This section names collection
  // ids and a collection count, both of which change the moment the agent
  // creates a folder — which would invalidate the prompt cache on the next
  // turn, for Anthropic's explicit caching and for the automatic prefix
  // caching DeepSeek and Kimi do. It belongs with the other volatile
  // per-turn context instead; see buildAgentTurnUserMessage.
  const stableResourceBlock =
    resourceContextPlan?.stableContextBlock ||
    buildAgentStableResourceContextBlock(request);

  const fixedPrompt = buildSystemPrompt(sections);
  const turnMessage = buildUserMessage(request, resourceContextPlan, {
    coverageBlock,
    memoryBlock,
    turnGuidanceBlock,
    contentInputs: options.contentInputs,
  });
  const systemMessages = [
    freezeEnvelopeMessage<AgentSystemMessage>({
      role: "system",
      content: fixedPrompt,
    }),
    ...(stableResourceBlock
      ? [
          freezeEnvelopeMessage<AgentSystemMessage>({
            role: "system",
            content: stableResourceBlock,
            cachePolicy: "stable-prefix",
          }),
        ]
      : []),
  ];
  const frozenTurnMessage = freezeEnvelopeMessage(turnMessage);
  const turnText = stringifyMessageContent(turnMessage.content);
  return Object.freeze({
    envelope: Object.freeze({
      systemMessages: Object.freeze(systemMessages),
      turnMessage: frozenTurnMessage,
    }),
    inventory: Object.freeze({
      fixedPrompt,
      tools: Object.freeze([...tools]),
      matchedSkillInstructions: Object.freeze([...matchedSkillInstructions]),
      dynamicGuidance: buildTurnGuidanceBlock(dynamicGuidanceInstructions),
      stableResourceBlock,
      turnResource: turnGuidanceBlock
        ? turnText.replace(turnGuidanceBlock, "").trim()
        : turnText,
    }),
  });
}

export function composeAgentModelInput(
  envelope: AgentPromptEnvelope,
  options: {
    transcriptMessages?: readonly AgentModelMessage[];
    postTurnMessages?: readonly AgentModelMessage[];
  } = {},
): AgentModelMessage[] {
  return [
    ...envelope.systemMessages.map((message) =>
      cloneModelMessage(message as AgentSystemMessage),
    ),
    ...(options.transcriptMessages || []).map(cloneModelMessage),
    cloneModelMessage(envelope.turnMessage as AgentUserMessage),
    ...(options.postTurnMessages || []).map(cloneModelMessage),
  ];
}

export function buildAgentPromptInstructionInventory(
  rendered: RenderedAgentPromptEnvelope,
  providerMessages: readonly AgentModelMessage[],
): InstructionInventory {
  return buildInstructionInventory({
    fixed: rendered.inventory.fixedPrompt,
    tools: rendered.inventory.tools,
    matchedSkills: rendered.inventory.matchedSkillInstructions,
    dynamicGuidance: rendered.inventory.dynamicGuidance,
    stableResource: rendered.inventory.stableResourceBlock,
    turnResource: rendered.inventory.turnResource,
    providerMessages,
  });
}

export async function buildAgentInitialMessages(
  request: AgentRuntimeRequest,
  tools: AgentToolDefinition<any, any>[],
  matchedSkillIds: ReadonlyArray<string>,
  resourceContextPlan?: AgentResourceContextPlan,
  options: {
    transcriptMessages?: AgentModelMessage[];
    contentInputs?: AgentContentInputCapabilities;
    onInstructionInventory?: (inventory: InstructionInventory) => void;
  } = {},
): Promise<AgentModelMessage[]> {
  const rendered = await renderAgentPromptEnvelope(
    request,
    tools,
    matchedSkillIds,
    resourceContextPlan,
    { contentInputs: options.contentInputs },
  );
  const transcriptMessages =
    options.transcriptMessages === undefined
      ? normalizeHistoryMessages(request)
      : options.transcriptMessages;
  const messages = composeAgentModelInput(rendered.envelope, {
    transcriptMessages,
  });
  if (options.onInstructionInventory) {
    options.onInstructionInventory(
      buildAgentPromptInstructionInventory(rendered, messages),
    );
  }
  return messages;
}
