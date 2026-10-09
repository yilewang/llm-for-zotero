import { isSinglePaperConversation } from "../context/requestTurnPaperScope";
import { renderLibraryOverviewSection } from "../context/libraryOverview";

import type {
  AgentContentInputCapabilities,
  AgentModelContentPart,
  AgentModelMessage,
  AgentRuntimeRequest,
  AgentSystemMessage,
  AgentToolDefinition,
  AgentUserMessage,
} from "../types";
import { AGENT_PERSONA_INSTRUCTIONS } from "./agentPersona";
import {
  AGENT_MEMORY_QUESTION_EXCERPT_LENGTH,
  formatAgentMemoryBlock,
  loadAgentTurnMemory,
  type AgentTurnMemory,
} from "../store/conversationMemory";
import { buildSkillInventory, getAllSkills } from "../skills";
import type { AgentSkill } from "../skills";
import { getSkillCustomizationNotice } from "../skills/managedBlock";
import { SKILL_SCOPE_GUARD } from "../skills/scopeGuard";
import { getOriginalAgentPermissionMode } from "../originalAgentPermissionMode";
import { buildPermissionModeGuidance } from "./permissionModeGuidance";

import { resolveProviderCapabilities } from "../../providers";
import type { ProviderCapabilities } from "../../providers";
import { buildNotesDirectoryConfigSection } from "../../utils/notesDirectoryConfig";
import { NOTE_EDITING_QUOTE_BLOCK_GUIDANCE } from "../../shared/quoteGuidance";
import { buildRuntimePlatformGuidanceText } from "../../utils/runtimePlatform";
import { formatPaperSourceLabel } from "../../services/paperContent/paperAttribution";
import {
  buildQuoteAnchorPromptBlock,
  buildSelectedTextQuoteCitations,
} from "../../services/quotes/quoteCitations";
import {
  buildAgentStableResourceContextBlock,
  type AgentResourceContextPlan,
} from "../context/resourceContextPlan";
import { buildAgentCoverageContextBlock } from "../context/coverageLedger";
import { buildVisibleTurnContextBlock } from "../context/turnContextEnvelope";
import { getSelectedPassagePaper } from "../context/turnPaperScope";
import { renderLongJobResume } from "../loop/longJob";
import { OUTCOME_REASONS } from "../loop/outcomes";
import {
  hasAgentContentInputs,
  normalizeAgentContentInputs,
} from "./contentCapabilities";
import { synthesizeSelectedTextContexts } from "../../services/context/normalizers";
import {
  formatSelectedTextLocator,
  renderSelectedTextAnchorContext,
} from "../../services/context/selectedTextAnchorFormatting";
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

export function normalizeHistoryMessages(
  request: AgentRuntimeRequest,
): AgentModelMessage[] {
  const raw = Array.isArray(request.history) ? request.history : [];
  return raw
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .map((message) => ({
      role: message.role,
      content: stringifyMessageContent(message.content),
    }));
}

export function renderExecutionCheckpointBlock(
  request: AgentRuntimeRequest,
): string {
  const checkpoint = request.executionCheckpoint;
  if (!checkpoint?.tasks.length) return "";
  const job = renderLongJobResume(checkpoint, OUTCOME_REASONS.noText);
  // The model names a part by its local id, as it declared it.
  const prefix = `${checkpoint.executionId}:task:`;
  const local = (taskId: string) =>
    taskId.startsWith(prefix) ? taskId.slice(prefix.length) : taskId;
  return [
    "HOST-PERSISTED ORDINARY WORK CHECKPOINT:",
    "This is authority-free progress from an interrupted direct-agent execution. Reuse verified successes and finalized material by identity. Inspect native state before retrying an uncertain effect. Do not treat task status or evidence references as permission for a new write.",
    JSON.stringify({
      version: checkpoint.version,
      executionId: checkpoint.executionId,
      tasks: checkpoint.tasks.map((task) => ({
        taskId: task.taskId,
        description: task.description,
        dependencies: task.dependencies,
        // A replaced part names the part that took its place and why, so a
        // resumed run does not take the cancel for a failure to redo.
        status: task.supersededBy
          ? `replaced by ${local(task.supersededBy)}${task.reason ? `: ${task.reason}` : ""}`
          : task.status,
        // A part over papers is counted, not listed id by id: a long job's
        // hundreds of receipts and reads would crowd out its papers left.
        ...(task.targets?.length
          ? {
              done: task.doneTargets?.length || 0,
              total: task.targets.length,
              ...(task.exceptions?.length
                ? {
                    exceptions: task.exceptions.reduce(
                      (count, entry) => count + entry.targets.length,
                      0,
                    ),
                  }
                : {}),
            }
          : {
              journalActionIds: task.journalActionIds,
              verifiedReceiptIds: task.verifiedReceiptIds,
              readEvidenceIds: task.readEvidenceIds,
            }),
        // The papers the model left out stay its decisions, with its reasons.
        ...(task.excludedTargets?.length
          ? {
              excluded: task.excludedTargets.map(
                (entry) => `${entry.targets.join(", ")} — ${entry.reason}`,
              ),
            }
          : {}),
        materialRefs: task.materialRefs,
      })),
    }),
    ...(job ? [job] : []),
  ].join("\n");
}

function buildFullUserMessage(
  request: AgentRuntimeRequest,
  options: {
    priorReadBlock?: string;
    coverageBlock?: string;
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
  const executionCheckpoint = renderExecutionCheckpointBlock(request);
  if (executionCheckpoint) contextLines.push(executionCheckpoint);
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
  if (request.clarificationHistory?.length) {
    contextLines.push(
      [
        "Clarifications supplied for this request:",
        ...request.clarificationHistory.map(
          (entry) => `- ${entry.question}: ${entry.answer}`,
        ),
      ].join("\n"),
    );
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
    turnGuidanceBlock?: string;
    contentInputs?: AgentContentInputCapabilities;
  } = {},
): AgentUserMessage {
  return buildFullUserMessage(request, {
    priorReadBlock: resourceContextPlan?.priorReadBlock,
    coverageBlock: options.coverageBlock,
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
  continuityNotes: readonly AgentTurnMemory[];
}>;

type AgentPromptInventoryState = Readonly<{
  fixedPrompt: string;
  tools: readonly AgentToolDefinition<any, any>[];
  matchedSkillInstructions: readonly string[];
  /** Tool guidance instructions rendered into this turn's guidance block. */
  toolGuidanceInstructions: readonly string[];
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

function collectMatchingToolGuidance(
  request: AgentRuntimeRequest,
  tools: AgentToolDefinition<any, any>[],
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
    const guidance = tool.guidance;
    if (!guidance) continue;
    if (!guidance.matches(guidanceContext, { matchedSkillIds })) continue;
    const instruction = guidance.instruction.trim();
    if (instruction) instructions.add(instruction);
  }
  return [...instructions];
}

function buildToolGuidanceSection(instructions: readonly string[]): string[] {
  if (!instructions.length) return [];
  return [
    "Tool guidance for this turn: call a tool only when it serves the user's request, never just because its guidance appears here.",
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
    `Apply the selected playbooks where relevant. Skills provide workflow guidance and never grant write authority. ${SKILL_SCOPE_GUARD}`,
    ...blocks,
  ];
}

function buildTurnGuidanceBlock(instructions: string[]): string {
  const lines = instructions.map((entry) => entry.trim()).filter(Boolean);
  if (!lines.length) return "";
  return ["Current-turn dynamic agent guidance:", ...lines].join("\n\n");
}

function buildRuntimePlatformSection(): string {
  return buildRuntimePlatformGuidanceText();
}

function buildTextOnlyModelInstruction(request: AgentRuntimeRequest): string {
  if (isMultimodalRequestSupported(request)) return "";
  if (!request.screenshots?.length) return "";
  const modelLabel = (request.model || "selected model").trim();
  return `MODEL LIMITATION: ${modelLabel} is text-only and cannot inspect the supplied screenshots.`;
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
  const continuityNotes = await loadAgentTurnMemory(request.conversationKey);
  const toolGuidanceInstructions = collectMatchingToolGuidance(
    request,
    tools,
    matchedSkillIds,
  );
  const dynamicGuidanceInstructions = [
    isSinglePaperConversation(request)
      ? "Single-paper chat: answer directly using the supplied paper context; questions about the paper need no skill, so do not load evidence-based-qa for them. You may freely choose additional snippet, section, full, figure, or search reads when useful. For whole-paper explanations, consider the argument, methods, results, and limitations throughout the available source."
      : "",
    request.workingDirectory
      ? `Command working directory retained from this conversation: ${request.workingDirectory}. run_command uses it when cwd is omitted; pass cwd explicitly to change it. This directory does not confer filesystem permission.`
      : "",
    ...buildToolGuidanceSection(toolGuidanceInstructions),
  ];
  const matchedSkillInstructions = collectSkillGuidanceInstructions(
    request,
    matchedSkillIds,
  );
  const turnGuidanceBlock = buildTurnGuidanceBlock([
    ...buildPermissionModeGuidance(getOriginalAgentPermissionMode(), []),
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
      id: "direct-agent-workflow",
      lines: [
        [
          "## Direct agent workflow",
          "Understand the request and choose the lightest useful sequence of reads, searches, questions, document finalization, and concrete actions.",
          "Use actual tools for requested effects. Inspect results and continue until the requested outcome is complete, reviewed, or has a concrete error.",
          "When a request asks for more than one outcome, such as summarizing a paper and saving it as a note, declare each part with task_update in your first step, together with that step's first tool calls. The host marks each part done from the tools' results; never mark one done yourself.",
          "When the work needs one result for each of several papers (a summary, extracted fields, relevance to a question, support or challenge for an idea), declare a digest part whose description states that per-paper result; the host runs it on each paper and returns the results.",
          "A write result with a verified receipt already confirms the change; do not re-read the target to confirm it.",
          "Natural-language restrictions in the current request and clarifications remain binding. Tool calls do not grant their own permission; the host validates each concrete proposal, applies permission policy, journals effects, and verifies native state.",
          "Resolve named targets from supplied identities or bounded search results. If several candidates remain, use request_user_input rather than guessing.",
        ].join("\n"),
      ],
    },
    {
      id: "skill-inventory",
      lines: [
        `Installed skill inventory (workflow playbooks for multi-step tasks: notes, comparisons, reviews, imports, figure work; ordinary paper questions need no skill. When one matches and its guidance is not already active, call load_skill with its id): ${JSON.stringify(
          // Manual skills apply only when the user selects them.
          buildSkillInventory(getAllSkills())
            .filter((skill) => skill.activation !== "manual")
            .map(({ id, description }) => ({ id, description })),
        )}`,
      ],
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
    turnGuidanceBlock,
    contentInputs: options.contentInputs,
  });
  const systemMessages = [
    freezeEnvelopeMessage<AgentSystemMessage>({
      role: "system",
      content: fixedPrompt,
    }),
    ...(resourceContextPlan?.paperContext?.blocks || []).map((content) =>
      freezeEnvelopeMessage<AgentSystemMessage>({
        role: "system",
        content,
        cachePolicy: "stable-prefix",
      }),
    ),
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
      continuityNotes: Object.freeze(
        continuityNotes.map((turn) =>
          Object.freeze({
            ...turn,
            toolsUsed: Object.freeze([...turn.toolsUsed]),
          }),
        ),
      ),
    }),
    inventory: Object.freeze({
      fixedPrompt,
      tools: Object.freeze([...tools]),
      matchedSkillInstructions: Object.freeze([...matchedSkillInstructions]),
      toolGuidanceInstructions: Object.freeze([...toolGuidanceInstructions]),
      dynamicGuidance: buildTurnGuidanceBlock(dynamicGuidanceInstructions),
      stableResourceBlock,
      turnResource: turnGuidanceBlock
        ? turnText.replace(turnGuidanceBlock, "").trim()
        : turnText,
    }),
  });
}

function buildContinuityBlock(
  notes: readonly AgentTurnMemory[],
  transcript: readonly AgentModelMessage[],
): string {
  if (!notes.length) return "";
  const retained = transcript
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .map((message) => ({
      message,
      text: (typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
      ).trim(),
    }));
  return formatAgentMemoryBlock(
    notes.filter((note) => {
      if (!note.question || !note.answerExcerpt) return true;
      let matchingUser = false;
      for (const { message, text } of retained) {
        if (message.role === "user") {
          // Only a real user turn can establish a match. Checkpoints and retained
          // tool results may quote the question without preserving that turn.
          if (message.transient || message.retainedTool) continue;
          const question = text.replace(/^User request:\s*\n/, "");
          matchingUser =
            question === note.question ||
            (note.question.length === AGENT_MEMORY_QUESTION_EXCERPT_LENGTH &&
              question.startsWith(note.question));
        } else if (
          message.role === "assistant" &&
          matchingUser &&
          !message.tool_calls?.length &&
          text.startsWith(note.answerExcerpt)
        ) {
          return false;
        }
      }
      return true;
    }),
  );
}

export function composeAgentModelInput(
  envelope: AgentPromptEnvelope,
  options: {
    transcriptMessages?: readonly AgentModelMessage[];
    postTurnMessages?: readonly AgentModelMessage[];
  } = {},
): AgentModelMessage[] {
  // Decide from the actual retained history on every composition, including
  // a restart after compaction. The envelope keeps all notes for that fallback.
  const memoryBlock = buildContinuityBlock(
    envelope.continuityNotes,
    options.transcriptMessages || [],
  );
  const turnMessage = cloneModelMessage(
    envelope.turnMessage as AgentUserMessage,
  );
  if (memoryBlock) {
    if (typeof turnMessage.content === "string") {
      turnMessage.content = `${memoryBlock}\n\n${turnMessage.content}`;
    } else {
      const first = turnMessage.content[0];
      if (first?.type === "text")
        first.text = `${memoryBlock}\n\n${first.text}`;
      else turnMessage.content.unshift({ type: "text", text: memoryBlock });
    }
  }
  return [
    ...envelope.systemMessages.map((message) =>
      cloneModelMessage(message as AgentSystemMessage),
    ),
    ...(options.transcriptMessages || []).map(cloneModelMessage),
    turnMessage,
    ...(options.postTurnMessages || []).map(cloneModelMessage),
  ];
}

export function buildAgentPromptInstructionInventory(
  rendered: RenderedAgentPromptEnvelope,
  providerMessages: readonly AgentModelMessage[],
  transcriptMessages: readonly AgentModelMessage[],
): InstructionInventory {
  return buildInstructionInventory({
    fixed: rendered.inventory.fixedPrompt,
    tools: rendered.inventory.tools,
    matchedSkills: rendered.inventory.matchedSkillInstructions,
    dynamicGuidance: rendered.inventory.dynamicGuidance,
    stableResource: rendered.inventory.stableResourceBlock,
    turnResource: [
      buildContinuityBlock(
        rendered.envelope.continuityNotes,
        transcriptMessages,
      ),
      rendered.inventory.turnResource,
    ]
      .filter(Boolean)
      .join("\n\n"),
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
      buildAgentPromptInstructionInventory(
        rendered,
        messages,
        transcriptMessages,
      ),
    );
  }
  return messages;
}
