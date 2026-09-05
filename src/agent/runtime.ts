import { AgentToolRegistry } from "./tools/registry";
import { readAttachmentBytes } from "../modules/contextPanel/attachmentStorage";
import { encodeBytesBase64 } from "./model/shared";
import { recordAgentTurn } from "./store/conversationMemory";
import {
  appendAgentTranscriptMessages,
  buildAgentTranscriptCompatibilityKey,
  loadLatestAgentTranscriptSegment,
  loadAgentTranscriptSegment,
  replaceAgentTranscriptSegment,
  type AgentTranscriptWriteResult,
} from "./store/transcriptStore";
import type {
  AgentInheritedApproval,
  AgentContentInputCapabilities,
  AgentModelCapabilities,
  AgentModelContentPart,
  AgentConfirmationResolution,
  AgentEvent,
  AgentAssistantMessage,
  AgentModelMessage,
  AgentModelStep,
  AgentPendingAction,
  AgentRuntimeOutcome,
  AgentRuntimeRequest,
  AgentRuntimeRequestInput,
  ResolvedAgentRuntimeRequest,
  AgentToolCall,
  AgentToolArtifact,
  AgentToolContext,
  AgentToolResult,
  AgentToolEffect,
  AgentToolMessage,
  AgentUserMessage,
  AgentRunRecord,
} from "./types";
import {
  resolveAgentRuntimeRequest,
  type AgentRequestPaperContextResolver,
} from "./context/resolvedAgentRequest";
import {
  getTurnPapersWithRoles,
  getTurnPaperScopeFromRequest,
} from "./context/requestTurnPaperScope";
import type { AgentModelAdapter } from "./model/adapter";
import type {
  AgentAdapterToolCallResult,
  AgentAdapterToolContentItem,
} from "./model/adapter";
import {
  normalizeAgentContentInputs,
  resolveCapabilitiesContentInputs,
} from "./model/contentCapabilities";
import { resolveAgentLimits } from "./model/limits";
import { classifyRequest } from "./model/requestClassifier";
import {
  buildAgentPromptInstructionInventory,
  composeAgentModelInput,
  normalizeHistoryMessages,
  renderAgentPromptEnvelope,
} from "./model/messageBuilder";
import { classifyWriteNoteDestination } from "./writeNoteDestination";
import { WRITE_NOTE_SKILL_ID } from "./skills/noteIntent";
import {
  detectTurnIntent,
  inferActionIntentsFromRequest,
} from "./model/skillClassifier";
import { reconcileNoteDestinationActionIntents } from "./model/actionIntent";
import { createUnverifiedReceipt } from "./contracts/actionEvaluation";
import {
  ActionContractRunSession,
  readLatestActionContractCheckpoint,
  type ActionContractCheckpoint,
} from "./contracts/actionContractRunSession";
import { AgentRunContinuationSession } from "./continuation/runContinuationSession";
import { AgentFinalAnswerController } from "./finalization/finalAnswerController";
import { getAllSkills, getMatchedSkillIds } from "./skills";
import {
  buildAgentResourceContextPlan,
  commitAgentReadActivities,
  hydrateAgentEvidenceCache,
  type AgentPendingReadActivity,
} from "./context/resourceContextPlan";
import {
  commitAgentCoverageActivities,
  hydrateAgentCoverageLedger,
} from "./context/coverageLedger";
import {
  getNotesDirectoryConfig,
  getNotesDirectoryNickname,
} from "../utils/notesDirectoryConfig";
import {
  buildAgentContextBudgetState,
  resolveAgentContextBudgetPolicy,
} from "./context/budgetPolicy";
import {
  buildAgentSemanticCheckpoint,
  compactAgentTranscript,
  readAgentSemanticCheckpointRootGoal,
} from "./context/transcriptCompactor";
import {
  AgentEventLocalDocumentStreamRedactor,
  acquireLocalDocumentPathLease,
  LocalDocumentPathStreamRedactor,
} from "./privacy/localDocumentPathRedaction";
import { validateLocalPdfDocumentBatch } from "./context/localDocumentBatch";
import { ensureModelCapabilities } from "../modelCapabilities";
import {
  AgentPromptBudgetError,
  enforceAgentPromptBudget,
  resolveAgentPromptBudgetLimits,
} from "./context/promptBudget";
import {
  appendAgentRunEvent,
  createAgentRun,
  finishAgentRun,
  getAgentRunTrace,
  getLatestAgentRunForConversation,
  INTERRUPTED_AGENT_RUN_MARKER,
} from "./store/traceStore";
import {
  listJournalActions,
  type JournalActionWithSteps,
} from "./store/changeJournal";
import {
  hasAgentToolResultHandles,
  hydrateAgentToolResultHandles,
  type AgentToolResultHandleRecord,
  upsertAgentToolResultHandles,
} from "./store/toolResultHandles";
import {
  areConversationWritesFrozen,
  isConversationWriteGenerationCurrent,
  withConversationWriteLock,
} from "../shared/conversationWriteFence";
import type { WebAttributionAssessment } from "../webAccess/attribution";
import { clearWebSourcesForRun } from "../webAccess/runSources";

const TOOL_RESULT_READ_TOOL_NAME = "tool_result_read";

type AgentRuntimeDeps = {
  registry: AgentToolRegistry;
  adapterFactory: (request: ResolvedAgentRuntimeRequest) => AgentModelAdapter;
  paperContextResolver?: AgentRequestPaperContextResolver;
  now?: () => number;
};

type PendingConfirmation = {
  resolve: (resolution: AgentConfirmationResolution) => void;
};

function createRunId(): string {
  return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createConfirmationRequestId(): string {
  return `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function toDataUrl(
  storedPath: string,
  mimeType: string,
): Promise<string> {
  const bytes = await readAttachmentBytes(storedPath);
  return `data:${mimeType};base64,${encodeBytesBase64(bytes)}`;
}

function summarizeArtifacts(artifacts: AgentToolArtifact[]): string {
  const imagePages = artifacts
    .filter(
      (artifact): artifact is Extract<AgentToolArtifact, { kind: "image" }> => {
        return artifact.kind === "image";
      },
    )
    .map(
      (artifact) =>
        artifact.pageLabel ||
        (Number.isFinite(artifact.pageIndex)
          ? `${artifact.pageIndex! + 1}`
          : ""),
    );
  const fileTitles = artifacts
    .filter(
      (
        artifact,
      ): artifact is Extract<AgentToolArtifact, { kind: "file_ref" }> => {
        return artifact.kind === "file_ref";
      },
    )
    .map((artifact) => artifact.title || artifact.name);
  const parts: string[] = [];
  if (imagePages.length) {
    parts.push(
      `Prepared PDF page image${imagePages.length === 1 ? "" : "s"} (${
        imagePages
          .filter(Boolean)
          .map((entry) => `p${entry}`)
          .join(", ") ||
        `${imagePages.length} page${imagePages.length === 1 ? "" : "s"}`
      }) for visual inspection.`,
    );
  }
  if (fileTitles.length) {
    parts.push(
      `Prepared the PDF file${fileTitles.length === 1 ? "" : "s"} ${fileTitles
        .map((entry) => `"${entry}"`)
        .join(", ")} for direct reading.`,
    );
  }
  parts.push(
    "Use the attached pages or PDF directly when answering. Do not ask the user to re-upload them.",
  );
  return parts.join(" ");
}

type OmittedContentInputCounts = {
  images: number;
  pdfDocuments: number;
  nativeFiles: number;
};

function hasOmittedContentInputs(counts: OmittedContentInputCounts): boolean {
  return counts.images > 0 || counts.pdfDocuments > 0 || counts.nativeFiles > 0;
}

function summarizeUnsupportedContentInputs(
  counts: OmittedContentInputCounts,
  modelName?: string,
): string {
  const omitted: string[] = [];
  const unsupportedKinds: string[] = [];
  if (counts.images) {
    omitted.push(
      `${counts.images} image input${counts.images === 1 ? "" : "s"}`,
    );
    unsupportedKinds.push("image input");
  }
  if (counts.pdfDocuments) {
    omitted.push(
      `${counts.pdfDocuments} PDF/document input${
        counts.pdfDocuments === 1 ? "" : "s"
      }`,
    );
    unsupportedKinds.push("PDF/document input");
  }
  if (counts.nativeFiles) {
    omitted.push(
      `${counts.nativeFiles} native file input${
        counts.nativeFiles === 1 ? "" : "s"
      }`,
    );
    unsupportedKinds.push("native file input");
  }
  const target = (modelName || "The selected model").trim();
  const omittedLabel = omitted.length ? omitted.join(" and ") : "artifacts";
  const unsupportedLabel = unsupportedKinds.length
    ? unsupportedKinds.join(" or ")
    : "that content type";
  return (
    `${omittedLabel} prepared by the tool were not attached because ${target} does not support ${unsupportedLabel}. ` +
    "Use the tool result text, MinerU manifest/full.md content, captions, and surrounding extracted text instead. " +
    "If direct visual or document inspection is required, say that a model with the needed content-input support is required."
  );
}

function isPdfFileRefPart(
  part: Extract<AgentModelContentPart, { type: "file_ref" }>,
): boolean {
  return part.file_ref.mimeType.trim().toLowerCase() === "application/pdf";
}

function supportsFileRefPart(
  part: Extract<AgentModelContentPart, { type: "file_ref" }>,
  contentInputs: AgentContentInputCapabilities,
): boolean {
  if (contentInputs.nativeFiles) return true;
  return isPdfFileRefPart(part) && contentInputs.pdfDocuments;
}

function countOmittedFileRefPart(
  part: Extract<AgentModelContentPart, { type: "file_ref" }>,
  counts: OmittedContentInputCounts,
): void {
  if (isPdfFileRefPart(part)) {
    counts.pdfDocuments += 1;
  } else {
    counts.nativeFiles += 1;
  }
}

async function buildArtifactFollowupMessage(
  result: AgentToolResult,
  options: {
    contentInputs?: AgentContentInputCapabilities;
    modelName?: string;
  } = {},
): Promise<AgentModelMessage | null> {
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
  if (!artifacts.length || !result.ok) return null;
  const contentInputs = normalizeAgentContentInputs(options.contentInputs);
  const parts: AgentModelContentPart[] = [];
  const attachedArtifacts: AgentToolArtifact[] = [];
  const omitted: OmittedContentInputCounts = {
    images: 0,
    pdfDocuments: 0,
    nativeFiles: 0,
  };
  for (const artifact of artifacts) {
    if (artifact.kind === "image") {
      if (!contentInputs.images) {
        omitted.images += 1;
        continue;
      }
      if (!artifact.storedPath || !artifact.mimeType) continue;
      try {
        const url = await toDataUrl(artifact.storedPath, artifact.mimeType);
        attachedArtifacts.push(artifact);
        parts.push({
          type: "image_url",
          image_url: {
            url,
            detail: "high",
          },
        });
      } catch (error) {
        ztoolkit.log(
          "LLM Agent: Failed to load image artifact",
          artifact,
          error,
        );
      }
      continue;
    }
    const fileRefPart: Extract<AgentModelContentPart, { type: "file_ref" }> = {
      type: "file_ref",
      file_ref: {
        name: artifact.name,
        mimeType: artifact.mimeType,
        storedPath: artifact.storedPath,
        contentHash: artifact.contentHash,
      },
    };
    if (!supportsFileRefPart(fileRefPart, contentInputs)) {
      countOmittedFileRefPart(fileRefPart, omitted);
      continue;
    }
    attachedArtifacts.push(artifact);
    parts.push(fileRefPart);
  }
  const textParts: string[] = [];
  if (attachedArtifacts.length) {
    textParts.push(summarizeArtifacts(attachedArtifacts));
  }
  if (hasOmittedContentInputs(omitted)) {
    textParts.push(
      summarizeUnsupportedContentInputs(omitted, options.modelName),
    );
  }
  if (textParts.length) {
    parts.unshift({
      type: "text",
      text: textParts.join("\n\n"),
    });
  }
  if (parts.length === 1 && parts[0].type === "text") {
    return {
      role: "user",
      content: parts[0].text,
    };
  }
  return parts.length
    ? {
        role: "user",
        content: parts,
      }
    : null;
}

function filterFollowupMessageForCapabilities(
  message: AgentModelMessage | null,
  capabilities: AgentModelCapabilities,
  modelName?: string,
): AgentModelMessage | null {
  if (!message) return null;
  if (message.role === "tool") return message;
  if (typeof message.content === "string") return message;

  const contentInputs = resolveCapabilitiesContentInputs(capabilities);
  const parts: AgentModelContentPart[] = [];
  const omitted: OmittedContentInputCounts = {
    images: 0,
    pdfDocuments: 0,
    nativeFiles: 0,
  };
  for (const part of message.content) {
    if (part.type === "text") {
      if (part.text.trim()) parts.push(part);
      continue;
    }
    if (part.type === "image_url") {
      if (contentInputs.images) {
        parts.push(part);
      } else {
        omitted.images += 1;
      }
      continue;
    }
    if (supportsFileRefPart(part, contentInputs)) {
      parts.push(part);
    } else {
      countOmittedFileRefPart(part, omitted);
    }
  }

  if (hasOmittedContentInputs(omitted)) {
    parts.push({
      type: "text",
      text: summarizeUnsupportedContentInputs(omitted, modelName),
    });
  }

  const hasNonTextPart = parts.some((part) => part.type !== "text");
  if (!hasNonTextPart) {
    return {
      ...message,
      content: parts
        .filter(
          (part): part is Extract<AgentModelContentPart, { type: "text" }> =>
            part.type === "text",
        )
        .map((part) => part.text)
        .filter(Boolean)
        .join("\n\n"),
    };
  }
  return parts.length
    ? {
        ...message,
        content: parts,
      }
    : null;
}

type ToolWorkflowDelivery = {
  callId: string;
  name: string;
  content: unknown;
  followupMessages: AgentModelMessage[];
};

type ToolWorkflowOutcome = {
  toolResult: AgentToolResult;
  delivery?: ToolWorkflowDelivery;
  stopRun?: boolean;
  finalText?: string;
};

function stringifyToolDeliveryContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content === null || content === undefined) {
    return "";
  }
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

function pushAdapterTextItem(
  target: AgentAdapterToolContentItem[],
  text: string,
): void {
  if (!text) return;
  target.push({ type: "inputText", text });
}

function pushAdapterMessageItems(
  target: AgentAdapterToolContentItem[],
  message: AgentModelMessage,
): void {
  if (typeof message.content === "string") {
    pushAdapterTextItem(target, message.content);
    return;
  }
  for (const part of message.content) {
    if (part.type === "text") {
      pushAdapterTextItem(target, part.text);
      continue;
    }
    if (part.type === "image_url") {
      target.push({
        type: "inputImage",
        imageUrl: part.image_url.url,
      });
      continue;
    }
    pushAdapterTextItem(target, `[Prepared file: ${part.file_ref.name}]`);
  }
}

function buildAdapterToolCallResult(
  outcome: ToolWorkflowOutcome,
): AgentAdapterToolCallResult {
  const contentItems: AgentAdapterToolContentItem[] = [];
  if (outcome.delivery) {
    pushAdapterTextItem(
      contentItems,
      stringifyToolDeliveryContent(outcome.delivery.content),
    );
    for (const followupMessage of outcome.delivery.followupMessages) {
      pushAdapterMessageItems(contentItems, followupMessage);
    }
  } else if (outcome.finalText) {
    pushAdapterTextItem(contentItems, outcome.finalText);
  } else {
    pushAdapterTextItem(
      contentItems,
      stringifyToolDeliveryContent(outcome.toolResult.content),
    );
  }
  if (!contentItems.length) {
    pushAdapterTextItem(
      contentItems,
      outcome.toolResult.ok ? "Tool completed successfully." : "Tool failed.",
    );
  }
  return {
    contentItems,
    success: outcome.toolResult.ok,
  };
}

function isManualCompactRequest(request: AgentRuntimeRequest): boolean {
  return /^\/compact(?:\s|$)/i.test((request.userText || "").trim());
}

function buildTranscriptUserMessage(
  request: AgentRuntimeRequest,
): AgentModelMessage {
  return {
    role: "user",
    content: `User request:\n${request.userText || ""}`,
  };
}

function transcriptContentToPlainText(
  content: AgentModelMessage["content"],
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

function normalizeTranscriptUserText(value: string): string {
  return value
    .replace(/^User request:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isCurrentTurnUserTranscriptMessage(
  message: AgentModelMessage | undefined,
  request: AgentRuntimeRequest,
): boolean {
  if (!message || message.role !== "user") return false;
  return (
    normalizeTranscriptUserText(
      transcriptContentToPlainText(message.content),
    ) === normalizeTranscriptUserText(request.userText || "")
  );
}

function readLatestTranscriptGoal(
  messages: readonly AgentModelMessage[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const checkpointGoal = readAgentSemanticCheckpointRootGoal(message);
    if (checkpointGoal) {
      return checkpointGoal.length > 600
        ? `${checkpointGoal.slice(0, 597)}...`
        : checkpointGoal;
    }
    const goal = normalizeTranscriptUserText(
      transcriptContentToPlainText(message.content),
    );
    if (!goal) continue;
    return goal.length > 600 ? `${goal.slice(0, 597)}...` : goal;
  }
  return undefined;
}

function buildInterruptedRunRecoveryMessage(params: {
  run: AgentRunRecord;
  actions: JournalActionWithSteps[];
  priorGoal?: string;
}): AgentModelMessage {
  const actions = [...params.actions].sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
      left.actionId.localeCompare(right.actionId),
  );
  const lines = [
    `Recovery note for interrupted run ${params.run.runId}.`,
    "Do not automatically repeat any prior write.",
  ];
  if (params.priorGoal) lines.push(`Prior goal: ${params.priorGoal}`);
  if (actions.length) {
    lines.push("Recorded journal actions:");
    for (const action of actions) {
      lines.push(
        `- actionId=${action.actionId}; status=${action.status}; affectedCount=${action.affectedCount}; reversibility=${action.reversibility}`,
      );
    }
  } else {
    lines.push("No journaled writes were recorded.");
  }
  lines.push(
    "Any unfinished confirmation was discarded and must be proposed and approved again.",
  );
  return {
    role: "user",
    content: lines.join("\n"),
  };
}

type ExecutedToolCall = {
  toolResult: AgentToolResult;
  toolDefinition?: import("./types").AgentToolDefinition<any, any>;
  input?: unknown;
};

function buildSyntheticToolCall(name: string, args: unknown): AgentToolCall {
  return {
    id: `synthetic-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    arguments: args,
  };
}

function readToolError(result: AgentToolResult): string {
  return result.content &&
    typeof result.content === "object" &&
    "error" in result.content
    ? String((result.content as { error: unknown }).error || "")
    : "";
}

function isUserDeniedToolResult(result: AgentToolResult): boolean {
  return readToolError(result).toLowerCase() === "user denied action";
}

function setToolResultReadAvailability(
  request: AgentRuntimeRequest,
  available: boolean,
): void {
  const metadata = { ...(request.metadata || {}) };
  if (available) {
    metadata.agentToolResultReadAvailable = true;
  } else {
    delete metadata.agentToolResultReadAvailable;
  }
  request.metadata = metadata;
}

function filterTransientRecoveryTool<T extends { name: string }>(
  tools: T[],
): T[] {
  return tools.filter((tool) => tool.name !== TOOL_RESULT_READ_TOOL_NAME);
}

function writeNoteDestinationForRequest(
  request: AgentRuntimeRequest,
  matchedSkills: ReadonlyArray<string>,
): import("./writeNoteDestination").WriteNoteDestination {
  const activeSkillIds = new Set([
    ...matchedSkills,
    ...(request.forcedSkillIds || []),
  ]);
  if (!activeSkillIds.has(WRITE_NOTE_SKILL_ID)) return "none";
  return classifyWriteNoteDestination(
    request.userText,
    getNotesDirectoryNickname(),
  );
}

function stabilizeProgressValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stabilizeProgressValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const stable: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined) {
      stable[key] = stabilizeProgressValue(record[key]);
    }
  }
  return stable;
}

function buildToolProgressFingerprint(record: {
  name: string;
  effect?: AgentToolEffect;
  input?: unknown;
  content?: unknown;
}): string {
  try {
    return JSON.stringify(
      stabilizeProgressValue({
        name: record.name,
        effect: record.effect,
        input: record.input,
        content: record.content,
      }),
    );
  } catch {
    return `${record.name}:${String(record.effect || "read")}:${String(
      record.input,
    )}:${String(record.content)}`;
  }
}

export class AgentRuntime {
  private readonly registry: AgentToolRegistry;
  private readonly adapterFactory: AgentRuntimeDeps["adapterFactory"];
  private readonly paperContextResolver?: AgentRequestPaperContextResolver;
  private readonly now: () => number;
  private readonly pendingConfirmations = new Map<
    string,
    PendingConfirmation
  >();

  constructor(deps: AgentRuntimeDeps) {
    this.registry = deps.registry;
    this.adapterFactory = deps.adapterFactory;
    this.paperContextResolver = deps.paperContextResolver;
    this.now = deps.now || (() => Date.now());
  }

  listTools() {
    return this.registry.listTools();
  }

  getToolDefinition(name: string) {
    return this.registry.getTool(name);
  }

  registerTool<TInput, TResult>(
    tool: import("./types").AgentToolDefinition<TInput, TResult>,
  ): void {
    this.registry.register(tool);
  }

  unregisterTool(name: string): boolean {
    return this.registry.unregister(name);
  }

  getCapabilities(request: AgentRuntimeRequestInput) {
    const resolved = resolveAgentRuntimeRequest(request, {
      resolvePaperContext: this.paperContextResolver,
    });
    return this.adapterFactory(resolved).getCapabilities(
      resolved as unknown as AgentRuntimeRequest,
    );
  }

  /**
   * Registers an external pending confirmation so that `resolveConfirmation`
   * can settle it.  Used by the action-picker UI to wire action HITL cards
   * into the same resolution path as agent-turn confirmations.
   */
  registerPendingConfirmation(
    requestId: string,
    resolve: (resolution: AgentConfirmationResolution) => void,
  ): void {
    this.pendingConfirmations.set(requestId, { resolve });
  }

  resolveConfirmation(
    requestId: string,
    approvedOrResolution: boolean | AgentConfirmationResolution,
    data?: unknown,
  ): boolean {
    const pending = this.pendingConfirmations.get(requestId);
    if (!pending) return false;
    this.pendingConfirmations.delete(requestId);
    const resolution =
      typeof approvedOrResolution === "boolean"
        ? {
            approved: approvedOrResolution,
            actionId: approvedOrResolution ? undefined : "cancel",
            data,
          }
        : {
            approved: Boolean(approvedOrResolution.approved),
            actionId: approvedOrResolution.actionId,
            data: approvedOrResolution.data,
          };
    pending.resolve(resolution);
    return true;
  }

  async getRunTrace(runId: string) {
    return getAgentRunTrace(runId);
  }

  async runTurn(params: {
    request: AgentRuntimeRequestInput;
    onEvent?: (event: AgentEvent) => void | Promise<void>;
    onStart?: (runId: string) => void | Promise<void>;
    signal?: AbortSignal;
  }): Promise<AgentRuntimeOutcome> {
    const request = resolveAgentRuntimeRequest(params.request, {
      resolvePaperContext: this.paperContextResolver,
    });
    const writeAllowed = () =>
      !areConversationWritesFrozen(request.conversationKey) &&
      (request.conversationGeneration === undefined ||
        isConversationWriteGenerationCurrent(
          request.conversationKey,
          request.conversationGeneration,
        ));
    const persistIfLive = async <T>(
      task: () => Promise<T>,
    ): Promise<T | undefined> => {
      if (!writeAllowed()) return undefined;
      return withConversationWriteLock(request.conversationKey, async () => {
        if (!writeAllowed()) return undefined;
        return task();
      });
    };
    try {
      await ensureModelCapabilities(
        {
          model: request.model || "",
          apiBase: request.apiBase,
          protocol: request.providerProtocol,
          authMode: request.authMode,
          apiKey: request.apiKey,
        },
        { timeoutMs: 5_000 },
      );
    } catch {
      // Capability discovery is advisory; the adapter retains its fallback
      // profile when a provider does not expose a catalog.
    }
    validateLocalPdfDocumentBatch({
      pdfPaperContexts: getTurnPapersWithRoles(request, ["raw_pdf"]),
      localDocuments: request.localDocuments?.map((entry) => entry.resource),
    });
    const pathLease = acquireLocalDocumentPathLease(
      request.conversationKey,
      request.localDocuments?.map((entry) => entry.resource),
    );
    let webSourceRunId: string | undefined;
    try {
      const latestPriorRun = await getLatestAgentRunForConversation(
        request.conversationKey,
      );
      const interruptedPriorRun =
        latestPriorRun?.status === "failed" &&
        latestPriorRun.finalText === INTERRUPTED_AGENT_RUN_MARKER
          ? latestPriorRun
          : null;
      const runId = createRunId();
      webSourceRunId = runId;
      const adapter = this.adapterFactory(request);
      const adapterCapabilities = adapter.getCapabilities(request);
      const eventStreamRedactor = new AgentEventLocalDocumentStreamRedactor(
        request.conversationKey,
      );
      const turnPathRedactor = new LocalDocumentPathStreamRedactor(
        request.conversationKey,
      );
      const persistToolResultHandles = async (
        records: AgentToolResultHandleRecord[],
      ): Promise<void> => {
        if (!records.length) return;
        const sanitized = turnPathRedactor.redactTerminalValue(records);
        await persistIfLive(() => upsertAgentToolResultHandles(sanitized));
      };
      let eventSeq = 0;
      let currentAnswerText = "";
      const item = request.item || null;
      await persistIfLive(() =>
        createAgentRun({
          runId,
          conversationKey: request.conversationKey,
          mode: "agent",
          model: request.model,
          status: "running",
          createdAt: this.now(),
        }),
      );
      // createAgentRun may have waited on the provider/DB.  Clear can commit
      // during that await and intentionally leave the conversation key live,
      // so a retired-key check alone is insufficient.  Never publish a late
      // run ID into the cleared generation's UI/cache.
      if (writeAllowed()) await params.onStart?.(runId);

      const emit = async (event: AgentEvent) => {
        if (!writeAllowed()) return;
        for (const redactedEvent of eventStreamRedactor.process(event)) {
          eventSeq += 1;
          await persistIfLive(() =>
            appendAgentRunEvent(runId, eventSeq, redactedEvent),
          );
          if (writeAllowed()) await params.onEvent?.(redactedEvent);
        }
      };
      const actionContractSession = new ActionContractRunSession({
        request,
        contracts: this.registry,
        emit,
      });

      if (!adapter.supportsTools(request)) {
        const reason =
          "Agent tools unavailable for this model; used direct response instead.";
        await emit({
          type: "fallback",
          reason,
        });
        await persistIfLive(() => finishAgentRun(runId, "completed"));
        return {
          kind: "fallback",
          runId,
          reason,
          usedFallback: true,
        };
      }

      const context: AgentToolContext = {
        request,
        runId,
        item,
        currentAnswerText,
        modelName: request.model || "unknown",
        modelProviderLabel: request.modelProviderLabel,
        signal: params.signal,
        checkpointActionProgress: () => actionContractSession.checkpoint(),
      };
      const toolsUsedThisTurn: string[] = [];
      const toolExecutionRecords: Array<{
        name: string;
        ok: boolean;
        mutability?: "read" | "write";
        effect?: AgentToolEffect;
        input?: unknown;
        content?: unknown;
      }> = [];
      const pendingReadActivities: AgentPendingReadActivity[] = [];
      await hydrateAgentToolResultHandles(request.conversationKey);
      let toolResultReadAvailable = hasAgentToolResultHandles(
        request.conversationKey,
      );
      setToolResultReadAvailability(request, false);
      const toolDefinitions =
        this.registry.listToolDefinitionsForRequest(request);
      const toolSpecs = filterTransientRecoveryTool(
        this.registry.listToolsForRequest(request),
      );
      await hydrateAgentEvidenceCache(request.conversationKey);
      await hydrateAgentCoverageLedger({
        conversationKey: request.conversationKey,
        request,
      });
      const resourceContextPlan = buildAgentResourceContextPlan(request);
      context.resourceSignature = resourceContextPlan.resourceSignature;
      request.contextCache = resourceContextPlan.contextCache;
      const transcriptCompatibilityKey = buildAgentTranscriptCompatibilityKey({
        request,
        resourceSignature: resourceContextPlan.resourceSignature,
        stableContextBlock: resourceContextPlan.stableContextBlock,
        tools: toolSpecs,
      });
      let transcriptSegment = await loadAgentTranscriptSegment({
        conversationKey: request.conversationKey,
        compatibilityKey: transcriptCompatibilityKey,
      });
      const hadCompatibleTranscript = transcriptSegment.messages.length > 0;
      let transcriptMessagesForPrompt = transcriptSegment.messages.length
        ? transcriptSegment.messages
        : normalizeHistoryMessages(request);
      let recoveryMessage: AgentModelMessage | null = null;
      let interruptedActionCheckpoint: ActionContractCheckpoint | null = null;
      if (interruptedPriorRun) {
        const [actions, latestTranscriptSegment, interruptedTrace] =
          await Promise.all([
            listJournalActions({
              runId: interruptedPriorRun.runId,
              limit: 50,
            }),
            loadLatestAgentTranscriptSegment(request.conversationKey),
            getAgentRunTrace(interruptedPriorRun.runId),
          ]);
        interruptedActionCheckpoint = readLatestActionContractCheckpoint(
          interruptedTrace.events.map((event) => event.payload),
        );
        const compatibilityMatches =
          latestTranscriptSegment?.compatibilityKey ===
          transcriptCompatibilityKey;
        recoveryMessage = buildInterruptedRunRecoveryMessage({
          run: interruptedPriorRun,
          actions,
          priorGoal: compatibilityMatches
            ? undefined
            : readLatestTranscriptGoal(latestTranscriptSegment?.messages || []),
        });
        transcriptMessagesForPrompt = compatibilityMatches
          ? [...transcriptMessagesForPrompt, recoveryMessage]
          : [recoveryMessage];
      }

      if (
        transcriptMessagesForPrompt.some(
          (message) => message.role === "assistant" || message.role === "tool",
        )
      ) {
        const legacyBudget = buildAgentContextBudgetState({
          messages: transcriptMessagesForPrompt,
          model: request.model,
          inputTokenCap: request.advanced?.inputTokenCap,
          apiBase: request.apiBase,
          providerProtocol: request.providerProtocol,
          authMode: request.authMode,
          profileOverride: request.advanced?.profileOverride,
          recentlyCompacted: false,
        });
        const semantic = buildAgentSemanticCheckpoint({
          messages: transcriptMessagesForPrompt,
          summaryTokens: legacyBudget.summaryTokens,
          conversationKey: request.conversationKey,
          resourceSignature: resourceContextPlan.resourceSignature,
        });
        const checkpoint: AgentUserMessage = {
          ...semantic.checkpoint,
          content: turnPathRedactor.redactTerminalText(
            semantic.checkpoint.content,
          ),
        };
        await persistToolResultHandles(semantic.handleRecords);
        transcriptMessagesForPrompt = [checkpoint];
        transcriptSegment = {
          ...transcriptSegment,
          messages: [checkpoint],
          compactedAt: this.now(),
        };
        await persistIfLive(() =>
          replaceAgentTranscriptSegment(transcriptSegment),
        );
      }

      if (isManualCompactRequest(request)) {
        const policy = resolveAgentContextBudgetPolicy();
        const budget = buildAgentContextBudgetState({
          messages: transcriptMessagesForPrompt,
          model: request.model,
          inputTokenCap: request.advanced?.inputTokenCap,
          apiBase: request.apiBase,
          providerProtocol: request.providerProtocol,
          authMode: request.authMode,
          profileOverride: request.advanced?.profileOverride,
          policy,
          forceCompact: true,
        });
        const compacted = compactAgentTranscript({
          messages: transcriptMessagesForPrompt,
          budget,
          force: true,
          conversationKey: request.conversationKey,
          resourceSignature: resourceContextPlan.resourceSignature,
        });
        const text = compacted.compacted
          ? "Conversation compacted"
          : "Nothing to compact yet";
        if (compacted.compacted) {
          transcriptSegment = {
            ...transcriptSegment,
            messages: compacted.messages,
            compactedAt: this.now(),
          };
          await persistToolResultHandles(compacted.handleRecords);
          if (compacted.handleRecords.length) toolResultReadAvailable = true;
          await persistIfLive(() =>
            replaceAgentTranscriptSegment(
              turnPathRedactor.redactTerminalValue(transcriptSegment),
            ),
          );
          await emit({ type: "context_compacted", automatic: false });
        }
        await emit({ type: "final", text });
        await persistIfLive(() => finishAgentRun(runId, "completed", text));
        return {
          kind: "completed",
          runId,
          text,
          usedFallback: false,
        };
      }

      const currentUserTranscriptMessage = buildTranscriptUserMessage(request);
      const turnStartTranscriptMessages: AgentModelMessage[] = transcriptSegment
        .messages.length
        ? recoveryMessage
          ? [recoveryMessage]
          : []
        : [...transcriptMessagesForPrompt];
      const transcriptTail =
        turnStartTranscriptMessages[turnStartTranscriptMessages.length - 1] ||
        transcriptSegment.messages[transcriptSegment.messages.length - 1];
      if (
        hadCompatibleTranscript ||
        !isCurrentTurnUserTranscriptMessage(transcriptTail, request)
      ) {
        turnStartTranscriptMessages.push(currentUserTranscriptMessage);
      }
      if (turnStartTranscriptMessages.length) {
        await persistIfLive(() =>
          appendAgentTranscriptMessages({
            conversationKey: request.conversationKey,
            compatibilityKey: transcriptCompatibilityKey,
            messages: turnPathRedactor.redactTerminalValue(
              turnStartTranscriptMessages,
            ),
          }),
        );
        if (writeAllowed()) {
          transcriptSegment = {
            ...transcriptSegment,
            messages: [
              ...transcriptSegment.messages,
              ...turnStartTranscriptMessages,
            ],
          };
        }
      }

      // Intent/skill selection runs ONCE per user turn, before the system
      // prompt is built. The flow:
      //   1. detectTurnIntent — one bounded LLM call against the primary
      //      model, returns which skills apply plus the language-independent
      //      retrieval intent (stored on request.classifiedIntent as a
      //      default for retrieval/routing). Falls back to regex `match:`
      //      patterns with a null intent on any error.
      //   2. getMatchedSkillIds — unions classifier output with explicit
      //      forcedSkillIds (slash menu) and runtime-context forces
      //      (e.g. notes-directory nickname mention).
      //   3. matchedSkills is threaded into renderAgentPromptEnvelope so
      //      only those skills' instructions ship in current-turn guidance,
      //      and emitted as trace events for UI visibility.
      // The resulting prompt package is reused across every model inference
      // inside the agent loop — no per-step classification cost.
      const preclassifiedIntent = request.classifiedIntent;
      const turnIntent = await detectTurnIntent(request, getAllSkills(), {
        signal: params.signal,
      });
      if (!preclassifiedIntent && turnIntent.classifiedIntent) {
        request.classifiedIntent = turnIntent.classifiedIntent;
      } else if (!preclassifiedIntent && !turnIntent.classifiedIntent) {
        const fallbackActions = inferActionIntentsFromRequest(request);
        if (fallbackActions.length) {
          request.classifiedIntent = {
            retrievalIntent: "none",
            wantedSections: [],
            writeDisposition: fallbackActions.some(
              (intent) => intent.operation !== "read_full",
            )
              ? "required"
              : "none",
            actionInterpretationSource: "deterministic_fallback",
            actionIntents: fallbackActions,
          };
        }
      }
      if (turnIntent.degraded) {
        // Surface the silent-regression case: a usable model config was
        // present but classification fell back to regex matching, reverting
        // every classifier-driven default for this turn.
        await emit({
          type: "provider_event",
          providerType: "turn_intent_classifier",
          payload: {
            status: "degraded_to_regex",
            reason: turnIntent.failureReason,
          },
        });
      }
      const matchedSkills = getMatchedSkillIds(request, turnIntent.skillIds);
      const requestIntent = classifyRequest(request);
      const noteDestination = writeNoteDestinationForRequest(
        request,
        matchedSkills,
      );
      if (noteDestination !== "none" && !request.classifiedIntent) {
        request.classifiedIntent = {
          retrievalIntent: "none",
          wantedSections: [],
          writeDisposition: "required",
          actionInterpretationSource: "deterministic_fallback",
          actionIntents: [],
        };
      }
      if (
        noteDestination !== "none" &&
        request.classifiedIntent!.actionInterpretationSource !== "classifier"
      ) {
        request.classifiedIntent!.actionIntents =
          reconcileNoteDestinationActionIntents(
            request.classifiedIntent!.actionIntents,
            noteDestination,
          );
        request.classifiedIntent!.writeDisposition = "required";
      }
      const requiresFileNoteWrite = Boolean(
        request.classifiedIntent?.actionIntents?.some(
          (intent) => intent.operation === "file_write",
        ),
      );
      const hasPaperReadScope =
        request.conversationKind === "paper" ||
        Boolean(request.activeItemId) ||
        request.turnPaperScope.papers.length > 0;
      if (requestIntent.requiresFullPaperRead && hasPaperReadScope) {
        if (!request.classifiedIntent) {
          request.classifiedIntent = {
            retrievalIntent: "none",
            wantedSections: [],
            writeDisposition: "none",
            actionInterpretationSource: "deterministic_fallback",
            actionIntents: [],
          };
        }
        if (
          !request.classifiedIntent.actionIntents.some(
            (action) => action.constraints?.readMode === "full",
          )
        ) {
          request.classifiedIntent.actionIntents.push({
            capability: "zotero.read",
            operation: "read_full",
            proofDomain: "zotero_state",
            coverage: "all",
            targetKind: "papers",
            constraints: { readMode: "full" },
          });
        }
      }
      const actionContractInitialization =
        await actionContractSession.initialize({
          checkpoint: interruptedActionCheckpoint,
        });
      if (actionContractInitialization.kind === "failed") {
        const text = actionContractInitialization.userMessage;
        await emit({ type: "final", text });
        await persistIfLive(() => finishAgentRun(runId, "failed", text));
        return {
          kind: "completed",
          runId,
          text,
          usedFallback: false,
        };
      }
      const noteWritePolicy = requiresFileNoteWrite
        ? getNotesDirectoryConfig()
        : null;
      if (noteWritePolicy) {
        request.metadata = {
          ...(request.metadata || {}),
          fileNoteWritePolicy: noteWritePolicy,
        };
      }
      await emit({
        type: "provider_event",
        providerType: "agent_context_envelope",
        payload: {
          resourceSignature: resourceContextPlan.resourceSignature,
          selectedPaperCount: getTurnPapersWithRoles(request, ["selected"])
            .length,
          fullTextPaperCount: getTurnPapersWithRoles(request, ["full_text"])
            .length,
          selectedCollectionCount: request.turnPaperScope.collections.length,
          selectedTagCount: request.turnPaperScope.tags.length,
          attachmentCount: request.attachments?.length || 0,
          screenshotCount: request.screenshots?.length || 0,
        },
      });
      const captureInstructionInventory =
        request.metadata?.instructionHarnessInventory === true;
      const renderedPrompt = await renderAgentPromptEnvelope(
        request,
        toolDefinitions,
        matchedSkills,
        resourceContextPlan,
        {
          contentInputs: resolveCapabilitiesContentInputs(adapterCapabilities),
        },
      );
      const messages = composeAgentModelInput(renderedPrompt.envelope, {
        transcriptMessages: transcriptMessagesForPrompt,
      });
      const instructionInventory = captureInstructionInventory
        ? buildAgentPromptInstructionInventory(renderedPrompt, messages)
        : undefined;
      if (captureInstructionInventory && instructionInventory) {
        await emit({
          type: "provider_event",
          providerType: "instruction_harness_inventory",
          payload: {
            model: request.model || "",
            protocol: request.providerProtocol || "",
            matchedSkillIds: matchedSkills,
            ...instructionInventory,
          },
        });
      }
      const continuationSession = new AgentRunContinuationSession(messages);

      const budgetState = buildAgentContextBudgetState({
        messages,
        model: request.model,
        inputTokenCap: request.advanced?.inputTokenCap,
        apiBase: request.apiBase,
        providerProtocol: request.providerProtocol,
        authMode: request.authMode,
        profileOverride: request.advanced?.profileOverride,
        recentlyCompacted: Boolean(transcriptSegment.compactedAt),
      });
      const providerReplaySoftLimit = resolveAgentPromptBudgetLimits({
        model: request.model,
        inputTokenCap: request.advanced?.inputTokenCap,
        apiBase: request.apiBase,
        providerProtocol: request.providerProtocol,
        authMode: request.authMode,
        profileOverride: request.advanced?.profileOverride,
      }).softLimitTokens;
      if (budgetState.shouldCompact && transcriptMessagesForPrompt.length) {
        await emit({ type: "status", text: "Compacting context…" });
        const compacted = compactAgentTranscript({
          messages: transcriptMessagesForPrompt,
          budget: budgetState,
          conversationKey: request.conversationKey,
          resourceSignature: resourceContextPlan.resourceSignature,
        });
        if (compacted.compacted) {
          transcriptMessagesForPrompt = compacted.messages;
          transcriptSegment = {
            ...transcriptSegment,
            messages:
              !hadCompatibleTranscript &&
              isCurrentTurnUserTranscriptMessage(
                compacted.messages[compacted.messages.length - 1],
                request,
              )
                ? compacted.messages
                : [...compacted.messages, currentUserTranscriptMessage],
            compactedAt: this.now(),
          };
          await persistToolResultHandles(compacted.handleRecords);
          if (compacted.handleRecords.length) toolResultReadAvailable = true;
          await persistIfLive(() =>
            replaceAgentTranscriptSegment(
              turnPathRedactor.redactTerminalValue(transcriptSegment),
            ),
          );
          await emit({ type: "context_compacted", automatic: true });
          messages.splice(
            0,
            messages.length,
            ...composeAgentModelInput(renderedPrompt.envelope, {
              transcriptMessages: transcriptMessagesForPrompt,
            }),
          );
        }
      }
      const newTranscriptMessages: AgentModelMessage[] = [];
      let latestProviderReplayTokens = 0;
      const commitSemanticCheckpoint = async (params: {
        sourceMessages: AgentModelMessage[];
        preservedHandleRecords?: AgentToolResultHandleRecord[];
        retryInstruction?: string;
      }): Promise<{
        checkpoint: AgentUserMessage;
        writeResult: AgentTranscriptWriteResult | undefined;
        handleCount: number;
      }> => {
        const semantic = buildAgentSemanticCheckpoint({
          messages: params.sourceMessages,
          summaryTokens: budgetState.summaryTokens,
          conversationKey: request.conversationKey,
          resourceSignature: resourceContextPlan.resourceSignature,
          preservedHandleRecords: params.preservedHandleRecords,
        });
        const checkpoint: AgentUserMessage = {
          ...semantic.checkpoint,
          content: [
            turnPathRedactor.redactTerminalText(semantic.checkpoint.content),
            params.retryInstruction
              ? turnPathRedactor.redactTerminalText(params.retryInstruction)
              : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        };
        await persistToolResultHandles(semantic.handleRecords);
        const nextSegment = {
          ...transcriptSegment,
          messages: [checkpoint],
          compactedAt: this.now(),
        };
        const writeResult = await persistIfLive(() =>
          replaceAgentTranscriptSegment(nextSegment),
        );
        if (
          writeAllowed() &&
          (writeResult === "persisted" || writeResult === "memory_only")
        ) {
          transcriptSegment = nextSegment;
        }
        return {
          checkpoint,
          writeResult,
          handleCount: semantic.handleRecords.length,
        };
      };
      const requireAcceptedCheckpointWrite = (
        result: AgentTranscriptWriteResult | undefined,
      ): void => {
        if (result === "persisted" || result === "memory_only") return;
        throw new Error(
          result === "failed"
            ? "Agent transcript checkpoint storage failed."
            : "Agent transcript checkpoint was skipped because the conversation is no longer writable.",
        );
      };
      const persistTranscriptCheckpoint = async (
        options: {
          requireAccepted?: boolean;
        } = {},
      ): Promise<AgentTranscriptWriteResult | undefined> => {
        if (!newTranscriptMessages.length) return "skipped";
        const committed = await commitSemanticCheckpoint({
          sourceMessages: [
            ...transcriptSegment.messages,
            ...newTranscriptMessages,
          ],
        });
        if (options.requireAccepted) {
          requireAcceptedCheckpointWrite(committed.writeResult);
        }
        if (
          committed.writeResult !== "persisted" &&
          committed.writeResult !== "memory_only"
        ) {
          return committed.writeResult;
        }
        newTranscriptMessages.splice(0, newTranscriptMessages.length);
        return committed.writeResult;
      };
      const restartFromSemanticCheckpoint = async (params: {
        sourceMessages: AgentModelMessage[];
        handleRecords?: AgentToolResultHandleRecord[];
        retryInstruction?: string;
      }): Promise<void> => {
        const committed = await commitSemanticCheckpoint({
          sourceMessages: params.sourceMessages,
          preservedHandleRecords: params.handleRecords,
          retryInstruction: params.retryInstruction,
        });
        requireAcceptedCheckpointWrite(committed.writeResult);
        if (committed.handleCount) {
          toolResultReadAvailable = true;
          setToolResultReadAvailability(request, true);
        }
        const restartMessages = composeAgentModelInput(
          renderedPrompt.envelope,
          {
            transcriptMessages: [],
            postTurnMessages: [committed.checkpoint],
          },
        );
        continuationSession.restartWithMessages(restartMessages);
        newTranscriptMessages.splice(0, newTranscriptMessages.length);
        latestProviderReplayTokens = 0;
        adapter.resetState?.();
      };

      for (const skillId of matchedSkills) {
        await emit({ type: "status", text: `Skill activated: ${skillId}` });
      }

      let consecutiveToolErrors = 0;
      const intent = requestIntent;
      const { maxRounds, maxToolCallsPerRound } = resolveAgentLimits(
        intent.isBulkOperation,
      );
      const finalAnswerController = new AgentFinalAnswerController(
        request,
        actionContractSession,
        transcriptMessagesForPrompt,
      );
      let toolCallOverflowCorrectionUsed = false;
      const shouldFlushStreamBuffer = (value: string): boolean => {
        if (!value) return false;
        if (value.length >= 8) return true;
        return /(?:\n|[.!?,:;]\s?)$/u.test(value);
      };
      const completeRun = async (
        finalText: string,
        status: "completed" | "failed" = "completed",
        options: {
          emitFinalEvent?: boolean;
          webAttribution?: WebAttributionAssessment;
        } = {},
      ): Promise<AgentRuntimeOutcome> => {
        const redactedFinalText =
          turnPathRedactor.redactTerminalText(finalText);
        if (options.emitFinalEvent !== false) {
          await emit({
            type: "final",
            text: redactedFinalText,
            ...(options.webAttribution?.status === "valid" &&
            options.webAttribution.anchors.length
              ? {
                  webSourceAnchors: options.webAttribution.anchors,
                }
              : {}),
          });
        }
        await persistIfLive(() =>
          finishAgentRun(runId, status, redactedFinalText),
        );
        // The transcript and the read/coverage ledgers record what this run
        // DID. Gating them on a clean finish meant a run that exhausted its
        // rounds -- or was failed by three cancellations -- threw away its own
        // memory *after* its library writes had already landed, so "continue"
        // started blind on a library that had already changed.
        //
        // recordAgentTurn stays gated below: it is the turn summary, and
        // summarising an unfinished turn as an answer would be its own lie.
        {
          await persistIfLive(() =>
            commitAgentReadActivities({
              conversationKey: request.conversationKey,
              activities: pendingReadActivities,
              resourceSignature: resourceContextPlan.resourceSignature,
            }),
          );
          await persistIfLive(() =>
            commitAgentCoverageActivities({
              conversationKey: request.conversationKey,
              activities: pendingReadActivities,
            }),
          );
          await persistTranscriptCheckpoint();
          if (status === "completed" && redactedFinalText) {
            await persistIfLive(() =>
              recordAgentTurn(
                request.conversationKey,
                turnPathRedactor.redactTerminalText(request.userText),
                toolsUsedThisTurn,
                redactedFinalText,
              ),
            );
          }
        }
        return {
          kind: "completed",
          runId,
          text: redactedFinalText,
          usedFallback: false,
        } as const;
      };
      const emitFinalStep = async (
        step: Extract<AgentModelStep, { kind: "final" }>,
        stepStreamedText: string,
        webAttribution: WebAttributionAssessment,
      ): Promise<AgentRuntimeOutcome> => {
        const modelFinalText = webAttribution.cleanText;
        const receiptStatus = actionContractSession.receiptStatus();
        const finalText = receiptStatus
          ? `${modelFinalText}\n\n${receiptStatus}`
          : modelFinalText;
        if (finalText) {
          if (!stepStreamedText) {
            currentAnswerText = finalText;
            await emit({
              type: "message_delta",
              text: finalText,
            });
          } else if (finalText.startsWith(stepStreamedText)) {
            const remainder = finalText.slice(stepStreamedText.length);
            if (remainder) {
              currentAnswerText += remainder;
              await emit({
                type: "message_delta",
                text: remainder,
              });
            }
          } else {
            currentAnswerText = finalText;
          }
        }
        newTranscriptMessages.push(
          step.assistantMessage
            ? { ...step.assistantMessage, content: finalText }
            : { role: "assistant", content: finalText },
        );
        return completeRun(finalText, "completed", { webAttribution });
      };
      const runModelStep = async (
        round: number,
        statusText: string,
      ): Promise<{ step: AgentModelStep; stepStreamedText: string }> => {
        if (params.signal?.aborted) {
          await persistIfLive(() =>
            finishAgentRun(
              runId,
              "cancelled",
              turnPathRedactor.redactTerminalText(currentAnswerText),
            ),
          );
          throw new Error("Aborted");
        }
        await emit({
          type: "status",
          text: statusText,
        });
        let stepStreamedText = "";
        let stepPendingDelta = "";
        const flushStepDelta = async () => {
          if (!stepPendingDelta) return;
          const text = stepPendingDelta;
          stepPendingDelta = "";
          currentAnswerText += text;
          await emit({
            type: "message_delta",
            text,
          });
        };
        const rollbackStepStreamedText = async () => {
          await flushStepDelta();
          if (!stepStreamedText) return;
          currentAnswerText = currentAnswerText.slice(
            0,
            Math.max(0, currentAnswerText.length - stepStreamedText.length),
          );
          await emit({
            type: "message_rollback",
            length: stepStreamedText.length,
            text: stepStreamedText,
          });
          stepStreamedText = "";
          stepPendingDelta = "";
        };
        if (latestProviderReplayTokens > providerReplaySoftLimit) {
          const replayTokens = latestProviderReplayTokens;
          await restartFromSemanticCheckpoint({ sourceMessages: messages });
          await emit({
            type: "provider_event",
            providerType: "agent_context_budget",
            payload: {
              action: "checkpoint_provider_replay_usage",
              providerReplayTokens: replayTokens,
              softLimitTokens: providerReplaySoftLimit,
            },
          });
        }
        const preflight = enforceAgentPromptBudget({
          messages,
          model: request.model,
          inputTokenCap: request.advanced?.inputTokenCap,
          apiBase: request.apiBase,
          providerProtocol: request.providerProtocol,
          authMode: request.authMode,
          profileOverride: request.advanced?.profileOverride,
          conversationKey: request.conversationKey,
          resourceSignature: resourceContextPlan.resourceSignature,
        });
        if (preflight.changed) {
          await restartFromSemanticCheckpoint({
            sourceMessages: preflight.messages,
            handleRecords: preflight.handleRecords,
          });
          await emit({
            type: "provider_event",
            providerType: "agent_context_budget",
            payload: {
              action: "compacted_model_prompt",
              beforeTokens: preflight.estimatedBeforeTokens,
              afterTokens: preflight.estimatedAfterTokens,
              softLimitTokens: preflight.softLimitTokens,
              contextWindow: preflight.contextWindow,
              reductions: preflight.reductions,
              handleCount: preflight.handleRecords.length,
            },
          });
        }
        const stepToolResultReadAvailable =
          toolResultReadAvailable || preflight.handleRecords.length > 0;
        setToolResultReadAvailability(request, stepToolResultReadAvailable);
        const stepToolSpecs = this.registry.listToolsForRequest(request);
        const stepContextWindow = preflight.contextWindow;
        const stepInputLimitIsUserAuthoritative =
          preflight.inputLimitSource === "advanced" ||
          preflight.inputLimitSource === "user";
        const stepContextTokens = preflight.estimatedAfterTokens;
        if (stepContextTokens > 0 && stepContextWindow > 0) {
          await emit({
            type: "usage",
            round,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            contextTokens: stepContextTokens,
            contextWindow: stepContextWindow,
          });
        }
        const modelInput = continuationSession.inputForNextStep();
        const step = await adapter.runStep({
          request,
          messages: modelInput.messages,
          continuationMessages: modelInput.continuationMessages,
          tools: stepToolSpecs,
          signal: params.signal,
          onTextDelta: async (delta) => {
            if (!delta) return;
            stepStreamedText += delta;
            stepPendingDelta += delta;
            if (shouldFlushStreamBuffer(stepPendingDelta)) {
              await flushStepDelta();
            }
          },
          onReasoning: async (reasoning) => {
            if (!reasoning.summary && !reasoning.details) return;
            await emit({
              type: "reasoning",
              round,
              stepId: reasoning.stepId,
              stepLabel: reasoning.stepLabel,
              summary: reasoning.summary,
              details: reasoning.details,
            });
          },
          onUsage: async (usage) => {
            const usageRecord = usage as unknown as Record<string, unknown>;
            const totalTokens = Math.max(0, usage.totalTokens || 0);
            const promptTokens = Math.max(0, usage.promptTokens || 0);
            const completionTokens = Math.max(0, usage.completionTokens || 0);
            const contextTokens =
              typeof usageRecord.contextTokens === "number" &&
              Number.isFinite(usageRecord.contextTokens)
                ? Math.max(0, usageRecord.contextTokens)
                : undefined;
            const providerContextWindow =
              typeof usageRecord.contextWindow === "number" &&
              Number.isFinite(usageRecord.contextWindow)
                ? Math.max(0, usageRecord.contextWindow)
                : undefined;
            const contextWindow = stepInputLimitIsUserAuthoritative
              ? stepContextWindow
              : providerContextWindow ||
                (typeof contextTokens === "number" && contextTokens > 0
                  ? stepContextWindow
                  : undefined);
            const contextWindowIsAuthoritative =
              !stepInputLimitIsUserAuthoritative &&
              usageRecord.contextWindowIsAuthoritative === true;
            const percentage =
              typeof usageRecord.percentage === "number" &&
              Number.isFinite(usageRecord.percentage)
                ? Math.max(0, Math.min(100, usageRecord.percentage))
                : undefined;
            const sessionId =
              typeof usageRecord.sessionId === "string" &&
              usageRecord.sessionId.trim()
                ? usageRecord.sessionId.trim()
                : undefined;
            const model =
              typeof usageRecord.model === "string" && usageRecord.model.trim()
                ? usageRecord.model.trim()
                : undefined;
            const cacheReadTokens =
              typeof usageRecord.cacheReadTokens === "number" &&
              Number.isFinite(usageRecord.cacheReadTokens)
                ? Math.max(0, usageRecord.cacheReadTokens)
                : undefined;
            const cacheWriteTokens =
              typeof usageRecord.cacheWriteTokens === "number" &&
              Number.isFinite(usageRecord.cacheWriteTokens)
                ? Math.max(0, usageRecord.cacheWriteTokens)
                : undefined;
            const cacheMissTokens =
              typeof usageRecord.cacheMissTokens === "number" &&
              Number.isFinite(usageRecord.cacheMissTokens)
                ? Math.max(0, usageRecord.cacheMissTokens)
                : undefined;
            const cacheHitRatio =
              typeof usageRecord.cacheHitRatio === "number" &&
              Number.isFinite(usageRecord.cacheHitRatio)
                ? Math.max(0, Math.min(1, usageRecord.cacheHitRatio))
                : undefined;
            const cacheProvider =
              typeof usageRecord.cacheProvider === "string" &&
              usageRecord.cacheProvider.trim()
                ? usageRecord.cacheProvider.trim()
                : undefined;
            latestProviderReplayTokens = Math.max(
              latestProviderReplayTokens,
              totalTokens,
              typeof contextTokens === "number" ? contextTokens : 0,
            );
            if (
              totalTokens <= 0 &&
              promptTokens <= 0 &&
              completionTokens <= 0 &&
              !(typeof contextTokens === "number" && contextTokens > 0) &&
              !(typeof contextWindow === "number" && contextWindow > 0)
            ) {
              return;
            }
            await emit({
              type: "usage",
              round,
              promptTokens,
              completionTokens,
              totalTokens,
              ...(typeof contextTokens === "number" ? { contextTokens } : {}),
              ...(typeof contextWindow === "number" ? { contextWindow } : {}),
              ...(contextWindowIsAuthoritative
                ? { contextWindowIsAuthoritative: true }
                : {}),
              ...(typeof percentage === "number" ? { percentage } : {}),
              ...(sessionId ? { sessionId } : {}),
              ...(model ? { model } : {}),
              ...(typeof cacheReadTokens === "number"
                ? { cacheReadTokens }
                : {}),
              ...(typeof cacheWriteTokens === "number"
                ? { cacheWriteTokens }
                : {}),
              ...(typeof cacheMissTokens === "number"
                ? { cacheMissTokens }
                : {}),
              ...(typeof cacheHitRatio === "number" ? { cacheHitRatio } : {}),
              ...(cacheProvider ? { cacheProvider } : {}),
            });
          },
          onToolCall: async (call) => {
            await rollbackStepStreamedText();
            const outcome = await executeToolWorkflow(call, round, {
              modelCallId: call.id,
            });
            newTranscriptMessages.push({
              role: "assistant",
              content: "",
              tool_calls: [call],
            });
            if (outcome.delivery) {
              newTranscriptMessages.push({
                role: "tool",
                tool_call_id: outcome.delivery.callId,
                name: outcome.delivery.name,
                content: JSON.stringify(
                  outcome.delivery.content ?? {},
                  null,
                  2,
                ),
              });
              newTranscriptMessages.push(...outcome.delivery.followupMessages);
            }
            if (outcome.stopRun && outcome.finalText) {
              newTranscriptMessages.push({
                role: "assistant",
                content: outcome.finalText,
              });
            }
            await persistTranscriptCheckpoint();
            return buildAdapterToolCallResult(outcome);
          },
        });
        continuationSession.commitProviderResponse();
        await flushStepDelta();
        return {
          step,
          stepStreamedText,
        };
      };
      const requestActionResolution = async (
        action: AgentPendingAction,
      ): Promise<{
        requestId: string;
        resolution: AgentConfirmationResolution;
      }> => {
        const requestId = createConfirmationRequestId();
        const resolution = new Promise<AgentConfirmationResolution>(
          (resolve) => {
            this.pendingConfirmations.set(requestId, { resolve });
          },
        );
        await emit({
          type: "confirmation_required",
          requestId,
          action,
        });
        const settled = await resolution;
        await emit({
          type: "confirmation_resolved",
          requestId,
          approved: settled.approved,
          actionId: settled.actionId,
          data: settled.data,
        });
        return {
          requestId,
          resolution: settled,
        };
      };
      const executePreparedToolCall = async (
        call: AgentToolCall,
        round: number,
        options: {
          inheritedApproval?: AgentInheritedApproval;
        } = {},
      ): Promise<ExecutedToolCall> => {
        const lifecycleError = (): ExecutedToolCall => ({
          toolResult: {
            callId: call.id,
            name: call.name,
            ok: false,
            actionReceipts: [
              createUnverifiedReceipt({
                reason: "Conversation lifecycle changed before execution.",
              }),
            ],
            content: {
              error:
                "Conversation lifecycle changed before this tool could execute.",
            },
          },
        });
        const executionAllowed = () =>
          !params.signal?.aborted && writeAllowed();
        if (!executionAllowed()) return lifecycleError();
        await emit({
          type: "tool_call",
          callId: call.id,
          name: call.name,
          args: call.arguments,
        });
        toolsUsedThisTurn.push(call.name);
        const execution = await this.registry.prepareExecution(
          call,
          {
            ...context,
            currentAnswerText,
          },
          {
            callerKind: options.inheritedApproval ? "action" : "model",
            inheritedApproval: options.inheritedApproval,
            isExecutionAllowed: executionAllowed,
            executeWithLock: (task) =>
              withConversationWriteLock(request.conversationKey, task),
          },
        );
        let executedCall: {
          toolResult: AgentToolResult;
          toolDefinition?: import("./types").AgentToolDefinition<any, any>;
          input?: unknown;
        };
        if (execution.kind === "confirmation") {
          const { resolution } = await requestActionResolution(
            execution.action,
          );
          if (!executionAllowed()) return lifecycleError();
          const confirmedExecution = resolution.approved
            ? await execution.execute(resolution.data)
            : execution.deny(resolution.data);
          executedCall = {
            toolResult: confirmedExecution.result,
            toolDefinition: confirmedExecution.tool,
            input: confirmedExecution.input,
          };
        } else {
          if (!executionAllowed()) return lifecycleError();
          executedCall = {
            toolResult: execution.execution.result,
            toolDefinition: execution.execution.tool,
            input: execution.execution.input,
          };
        }
        const { toolResult } = executedCall;
        toolExecutionRecords.push({
          name: toolResult.name,
          ok: toolResult.ok,
          mutability: executedCall.toolDefinition?.spec.mutability,
          effect: toolResult.effect,
          input: executedCall.input,
          content: toolResult.content,
        });
        if (toolResult.ok) {
          consecutiveToolErrors = 0;
          pendingReadActivities.push({
            toolName: toolResult.name,
            toolLabel:
              typeof executedCall.toolDefinition?.presentation?.label ===
              "string"
                ? executedCall.toolDefinition.presentation.label
                : undefined,
            input: executedCall.input,
            content: toolResult.content,
            artifacts: toolResult.artifacts,
            request,
            timestamp: this.now(),
          });
        } else {
          const rawError = readToolError(toolResult);
          const userDenied =
            !!rawError && rawError.toLowerCase() === "user denied action";
          // A denial is the user steering, not the tool failing. Counting it
          // meant three careful "Cancel" clicks failed the run outright and
          // -- because persistence is gated on completion -- discarded its
          // memory along with it.
          if (!userDenied) {
            consecutiveToolErrors += 1;
          }
          if (rawError && !userDenied) {
            await emit({
              type: "tool_error",
              callId: toolResult.callId,
              name: toolResult.name,
              error: rawError,
              round,
            });
          }
        }
        await emit({
          type: "tool_result",
          callId: toolResult.callId,
          name: toolResult.name,
          ok: toolResult.ok,
          effect: toolResult.effect,
          actionReceipts: toolResult.actionReceipts,
          content: toolResult.content,
          artifacts: toolResult.artifacts,
        });
        await actionContractSession.recordToolReceipts(
          toolResult.actionReceipts,
        );
        return executedCall;
      };
      const buildToolDelivery = async (
        toolResult: AgentToolResult,
        callId: string,
        toolDefinition?: import("./types").AgentToolDefinition<any, any>,
        contentOverride?: unknown,
        extraFollowupMessages: AgentModelMessage[] = [],
      ): Promise<ToolWorkflowDelivery> => {
        const followupMessage = toolDefinition?.buildFollowupMessage
          ? await toolDefinition.buildFollowupMessage(toolResult, {
              ...context,
              currentAnswerText,
            })
          : await buildArtifactFollowupMessage(toolResult, {
              contentInputs:
                resolveCapabilitiesContentInputs(adapterCapabilities),
              modelName: request.model,
            });
        const filteredFollowupMessage = filterFollowupMessageForCapabilities(
          followupMessage,
          adapterCapabilities,
          request.model,
        );
        const followupMessages = extraFollowupMessages
          .map((message) =>
            filterFollowupMessageForCapabilities(
              message,
              adapterCapabilities,
              request.model,
            ),
          )
          .filter((message): message is AgentModelMessage => Boolean(message));
        if (filteredFollowupMessage) {
          followupMessages.push(filteredFollowupMessage);
        }
        const rawContent = contentOverride ?? toolResult.content;
        const contentWithReceipt =
          rawContent &&
          typeof rawContent === "object" &&
          !Array.isArray(rawContent)
            ? {
                ...(rawContent as Record<string, unknown>),
                actionReceipts: toolResult.actionReceipts,
              }
            : {
                content: rawContent,
                actionReceipts: toolResult.actionReceipts,
              };
        return {
          callId,
          name: toolResult.name,
          content: contentWithReceipt,
          followupMessages,
        };
      };
      const executeToolWorkflow = async (
        call: AgentToolCall,
        round: number,
        options: {
          modelCallId?: string;
          suppressModelDelivery?: boolean;
          inheritedApproval?: AgentInheritedApproval;
        } = {},
      ): Promise<ToolWorkflowOutcome> => {
        if (params.signal?.aborted || !writeAllowed()) {
          return {
            toolResult: {
              callId: call.id,
              name: call.name,
              ok: false,
              actionReceipts: [
                createUnverifiedReceipt({
                  reason: "Conversation lifecycle changed before execution.",
                }),
              ],
              content: {
                error:
                  "Conversation lifecycle changed before this tool could execute.",
              },
            },
          };
        }
        const executedCall = await executePreparedToolCall(call, round, {
          inheritedApproval: options.inheritedApproval,
        });
        const { toolResult, toolDefinition, input } = executedCall;
        const deliveryCallId = options.modelCallId || call.id;

        if (
          toolResult.ok &&
          toolDefinition?.createResultReviewAction &&
          toolDefinition.resolveResultReview
        ) {
          const currentResult = toolResult;
          const currentInput = input;
          while (true) {
            const reviewAction = await toolDefinition.createResultReviewAction(
              currentInput as never,
              currentResult,
              {
                ...context,
                currentAnswerText,
              },
            );
            if (!reviewAction) {
              if (options.suppressModelDelivery) {
                return { toolResult: currentResult };
              }
              return {
                toolResult: currentResult,
                delivery: await buildToolDelivery(
                  currentResult,
                  deliveryCallId,
                  toolDefinition,
                ),
              };
            }

            const { resolution } = await requestActionResolution(reviewAction);
            if (params.signal?.aborted || !writeAllowed()) {
              return { toolResult: currentResult };
            }
            const reviewOutcome = await toolDefinition.resolveResultReview(
              currentInput as never,
              currentResult,
              resolution,
              {
                ...context,
                currentAnswerText,
              },
            );

            if (reviewOutcome.kind === "deliver") {
              return options.suppressModelDelivery
                ? { toolResult: currentResult }
                : {
                    toolResult: currentResult,
                    delivery: await buildToolDelivery(
                      currentResult,
                      deliveryCallId,
                      toolDefinition,
                      reviewOutcome.toolMessageContent,
                      reviewOutcome.followupMessages || [],
                    ),
                  };
            }

            if (reviewOutcome.kind === "stop") {
              return {
                toolResult: currentResult,
                stopRun: true,
                finalText: reviewOutcome.finalText,
              };
            }

            const chainedCall = buildSyntheticToolCall(
              reviewOutcome.call.name,
              reviewOutcome.call.arguments,
            );
            const chainedOutcome = await executeToolWorkflow(
              chainedCall,
              round,
              {
                modelCallId: deliveryCallId,
                suppressModelDelivery: Boolean(reviewOutcome.terminalText),
                inheritedApproval: reviewOutcome.call.inheritedApproval,
              },
            );
            if (reviewOutcome.terminalText) {
              const finalText = chainedOutcome.toolResult.ok
                ? reviewOutcome.terminalText.onSuccess
                : isUserDeniedToolResult(chainedOutcome.toolResult)
                  ? reviewOutcome.terminalText.onDenied
                  : reviewOutcome.terminalText.onError;
              return {
                toolResult: chainedOutcome.toolResult,
                stopRun: true,
                finalText,
              };
            }
            return chainedOutcome;
          }
        }

        if (options.suppressModelDelivery) {
          return { toolResult };
        }
        return {
          toolResult,
          delivery: await buildToolDelivery(
            toolResult,
            deliveryCallId,
            toolDefinition,
          ),
        };
      };
      const rollbackCommittedStreamedText = async (
        stepStreamedText: string,
      ): Promise<void> => {
        if (!stepStreamedText) return;
        currentAnswerText = currentAnswerText.slice(
          0,
          Math.max(0, currentAnswerText.length - stepStreamedText.length),
        );
        await emit({
          type: "message_rollback",
          length: stepStreamedText.length,
          text: stepStreamedText,
        });
      };
      let round = 0;
      let segment = 1;
      const seenProgressFingerprints = new Set<string>();
      while (true) {
        const segmentRecordStart = toolExecutionRecords.length;
        for (
          let segmentRound = 1;
          segmentRound <= maxRounds;
          segmentRound += 1
        ) {
          round += 1;
          let stepResult: { step: AgentModelStep; stepStreamedText: string };
          try {
            stepResult = await runModelStep(
              round,
              round === 1
                ? "Running agent"
                : segment === 1
                  ? `Continuing agent (${segmentRound}/${maxRounds})`
                  : `Continuing agent (segment ${segment}, ${segmentRound}/${maxRounds})`,
            );
          } catch (err) {
            if (err instanceof AgentPromptBudgetError) {
              return completeRun(err.message, "failed");
            }
            throw err;
          }
          const { step, stepStreamedText } = stepResult;
          if (step.kind === "final") {
            const returnedText = step.text || "";
            const streamedTextOffset = stepStreamedText
              ? returnedText.indexOf(stepStreamedText)
              : -1;
            const rawModelFinalText = stepStreamedText
              ? streamedTextOffset >= 0
                ? returnedText.slice(streamedTextOffset)
                : stepStreamedText
              : returnedText || currentAnswerText || "No response.";
            const finalDecision = await finalAnswerController.evaluate({
              candidateText:
                turnPathRedactor.redactTerminalText(rawModelFinalText),
              canCorrect: segmentRound < maxRounds,
              toolExecutionRecords,
            });
            if (finalDecision.kind !== "accept") {
              await rollbackCommittedStreamedText(stepStreamedText);
              if (finalDecision.kind === "correct") {
                const assistantCorrectionMessage: AgentAssistantMessage = {
                  ...(step.assistantMessage ?? {
                    role: "assistant" as const,
                    content: step.text || stepStreamedText,
                  }),
                  ...(typeof finalDecision.assistantContent === "string"
                    ? { content: finalDecision.assistantContent }
                    : {}),
                };
                const userCorrectionMessage: AgentUserMessage = {
                  role: "user",
                  content: finalDecision.correction,
                };
                newTranscriptMessages.push(
                  ...continuationSession.appendFinalCorrection({
                    assistantMessage: assistantCorrectionMessage,
                    correctionMessage: userCorrectionMessage,
                  }),
                );
                await persistTranscriptCheckpoint({
                  requireAccepted: Boolean(
                    finalDecision.actionContractRejection,
                  ),
                });
                if (finalDecision.actionContractRejection) {
                  actionContractSession.commitRejectedFinal(
                    finalDecision.actionContractRejection,
                  );
                }
                continue;
              }
              if (finalDecision.actionContractRejection) {
                actionContractSession.commitRejectedFinal(
                  finalDecision.actionContractRejection,
                );
              }
              return completeRun(finalDecision.userMessage, "failed");
            }
            return emitFinalStep(
              step,
              stepStreamedText,
              finalDecision.webAttribution,
            );
          }

          // The step returned tool_calls, not a final answer.  Any text the
          // model streamed during this step is intermediate "thinking" text
          // (e.g. "Let me read more of the paper...") that should appear in
          // the agent trace but NOT in the final chat answer.  Roll it back.
          await rollbackCommittedStreamedText(stepStreamedText);

          if (step.calls.length > maxToolCallsPerRound) {
            const overflowMessage = `The model returned ${step.calls.length} tool calls in one step, exceeding the safe limit of ${maxToolCallsPerRound}. None of those calls were executed.`;
            if (toolCallOverflowCorrectionUsed || segmentRound >= maxRounds) {
              return completeRun(
                `${overflowMessage} Please narrow the request and try again.`,
                "failed",
              );
            }
            toolCallOverflowCorrectionUsed = true;
            await restartFromSemanticCheckpoint({
              sourceMessages: messages,
              retryInstruction: `${overflowMessage} Retry with a complete new step containing at most ${maxToolCallsPerRound} tool calls. Do not assume that any result exists for the rejected calls.`,
            });
            await emit({
              type: "provider_event",
              providerType: "agent_tool_call_overflow",
              payload: {
                action: "checkpoint_and_retry",
                returnedToolCalls: step.calls.length,
                maxToolCallsPerRound,
              },
            });
            continue;
          }

          const calls = step.calls;
          const assistantToolMessage: AgentAssistantMessage =
            step.assistantMessage;
          if (!calls.length) break;
          continuationSession.beginToolStep(assistantToolMessage);
          newTranscriptMessages.push(assistantToolMessage);
          const roundToolMessages: AgentToolMessage[] = [];
          const roundFollowupMessages: AgentModelMessage[] = [];
          const appendRoundContinuation = () => {
            const delta = continuationSession.completeToolStep({
              toolMessages: roundToolMessages,
              followupMessages: roundFollowupMessages,
            });
            newTranscriptMessages.push(...delta);
          };
          for (const call of calls) {
            const outcome = await executeToolWorkflow(call, round, {
              modelCallId: call.id,
            });
            if (outcome.delivery) {
              const toolMessage: AgentToolMessage = {
                role: "tool",
                tool_call_id: outcome.delivery.callId,
                name: outcome.delivery.name,
                content: JSON.stringify(
                  outcome.delivery.content ?? {},
                  null,
                  2,
                ),
              };
              roundToolMessages.push(toolMessage);
              for (const followupMessage of outcome.delivery.followupMessages) {
                roundFollowupMessages.push(followupMessage);
              }
            }
            if (outcome.stopRun) {
              appendRoundContinuation();
              const stopFinalText = outcome.finalText || currentAnswerText;
              if (stopFinalText) {
                newTranscriptMessages.push({
                  role: "assistant",
                  content: stopFinalText,
                });
              }
              await persistTranscriptCheckpoint();
              return completeRun(stopFinalText, "completed");
            }
            if (consecutiveToolErrors >= 3) {
              appendRoundContinuation();
              await persistTranscriptCheckpoint();
              const finalText =
                currentAnswerText ||
                "Agent stopped after repeated tool errors. Please adjust the request and try again.";
              return completeRun(finalText, "failed");
            }
          }
          appendRoundContinuation();
          await persistTranscriptCheckpoint();
        }

        const newFingerprints = toolExecutionRecords
          .slice(segmentRecordStart)
          .filter(
            (record) =>
              record.ok &&
              (record.mutability !== "write" ||
                record.effect === "applied" ||
                record.effect === "partial"),
          )
          .map(buildToolProgressFingerprint)
          .filter((fingerprint) => !seenProgressFingerprints.has(fingerprint));
        if (!newFingerprints.length) {
          const finalText =
            currentAnswerText ||
            `Agent stopped after segment ${segment} produced no new successful tool result. The completed transcript was saved; narrow or redirect the request before continuing.`;
          return completeRun(finalText, "failed");
        }
        for (const fingerprint of newFingerprints) {
          seenProgressFingerprints.add(fingerprint);
        }
        // This is the durable continuation boundary. If Zotero or the model
        // process exits later, the next turn can continue from the complete
        // tool-call/result pairs checkpointed here instead of starting blind.
        await persistTranscriptCheckpoint();
        await emit({
          type: "status",
          text: `Checkpointed agent segment ${segment}; continuing`,
        });
        segment += 1;
      }
    } finally {
      if (webSourceRunId) clearWebSourcesForRun(webSourceRunId);
      pathLease.release();
    }
  }
}
