/**
 * The single list of what a turn tells the model, and each runtime's
 * decision about every item on it.
 *
 * The plugin's own agent (messageBuilder.ts) is the reference: every prompt
 * section and turn block it sends carries one of the ids below. Claude Code,
 * Antigravity and Codex each fill in a delivery table over the same ids, so
 * a new block fails to compile until every runtime decides about it.
 *
 * The table is not documentation only. `renderRuntimePromptBlocks` renders
 * exactly the blocks a runtime marks `send`, grouped by where the runtime
 * puts them, so what the table says and what the runtime sends cannot drift
 * apart. A runtime's transport decides only where "standing" and "turn"
 * text go (Claude's system-prompt append, agy's session `_meta`, the Codex
 * turn's user message).
 *
 * Kinds of decision:
 * - `send`: the shared renderer below produces the text; `placement` says
 *   whether it is standing (instructions the runtime keeps for the session)
 *   or turn (sent with each turn). A block that can change between turns
 *   must be "turn" for a runtime whose standing text is fixed at session
 *   start (Antigravity: agy stacks re-sent instructions instead of replacing
 *   them, probed on agy 1.5.17).
 * - `transport`: the runtime's own transport carries it (images as content
 *   blocks, history as the runtime's session); `how` names where.
 * - `replaced`: the runtime gets the same effect another way; `by` names it.
 * - `notApplicable`: the block has no meaning for the runtime.
 */

import type { AgentRuntimeRequest } from "../types";
import type { RuntimeConversationSystem } from "../../core/conversations/conversationSystems";
import { assertNeverConversationSystem } from "../../core/conversations/conversationSystems";
import { AGENT_PERSONA_INSTRUCTIONS } from "../model/agentPersona";
import { buildSkillInventory, getAllSkills } from "../skills";
import {
  isSkillWithheldForEphemeralRequest,
  SIDE_CHAT_READ_ONLY_INSTRUCTION,
} from "../skills/sideChatScope";
import { isEphemeralConversationKey } from "../../shared/conversationKeySpace";
import { renderToolGuidanceLines } from "../tools/guidance";
import { buildNotesDirectoryConfigSection } from "../../utils/notesDirectoryConfig";
import { RAW_PDF_TRANSPORT_POLICY_BLOCK } from "./rawPdfTransportPolicy";
import { buildVisibleTurnContextBlock } from "./turnContextEnvelope";
import { renderTurnMaterialForModel } from "./turnMaterial";
import { isSinglePaperConversation } from "./requestTurnPaperScope";
import { COLLECTION_SCOPE_RULES, TAG_SCOPE_RULES } from "./resourceContextPlan";

// ---------------------------------------------------------------------------
// Block ids
// ---------------------------------------------------------------------------

/**
 * Blocks the shared renderer below can produce as text. The order is the
 * order a runtime's standing and turn text list them in.
 */
export const TEXT_PROMPT_BLOCK_IDS = [
  // Standing instructions.
  "customInstructions",
  "persona",
  "zoteroAccess",
  "searchRoutes",
  "longToolResults",
  "directAgentWorkflow",
  "noteWriteRule",
  "notesFolder",
  "agentFiles",
  "rawPdfPolicy",
  "sideChatReadOnly",
  "skillInventory",
  "runtimePlatform",
  "modelLimitations",
  // Per-turn context.
  "libraryOverview",
  "visibleTurnContext",
  "executionCheckpoint",
  "turnMaterial",
  "scopeRules",
  "attachmentsNotice",
  "priorReads",
  "coverage",
  "earlierSources",
  "clarifications",
  "permissionMode",
  "singlePaperHint",
  "workingDirectory",
  "toolGuidance",
  "activeSkills",
] as const;

/**
 * Blocks that are not text from this module: native builds them from its
 * own state (caches, ledgers, the transcript), and an external runtime's
 * transport carries them or replaces them.
 */
export const TRANSPORT_PROMPT_BLOCK_IDS = [
  "paperContext",
  "stableResources",
  "sideChatBackground",
  "continuityNotes",
  "history",
  "pastChats",
  "userRequest",
  "images",
  "pdfFiles",
] as const;

export type TextPromptBlockId = (typeof TEXT_PROMPT_BLOCK_IDS)[number];
export type TransportPromptBlockId =
  (typeof TRANSPORT_PROMPT_BLOCK_IDS)[number];
export type TurnPromptBlockId = TextPromptBlockId | TransportPromptBlockId;

// ---------------------------------------------------------------------------
// Delivery tables
// ---------------------------------------------------------------------------

export type BlockPlacement = "standing" | "turn";

export type SendDelivery = { kind: "send"; placement: BlockPlacement };
export type TransportDelivery = { kind: "transport"; how: string };
export type ReplacedDelivery = { kind: "replaced"; by: string };
export type NotApplicableDelivery = { kind: "notApplicable"; reason: string };

export type BlockDelivery =
  | SendDelivery
  | TransportDelivery
  | ReplacedDelivery
  | NotApplicableDelivery;

/** A text block may be sent; a transport block may only be carried. */
type DeliveryFor<Id extends TurnPromptBlockId> = Id extends TextPromptBlockId
  ? SendDelivery | ReplacedDelivery | NotApplicableDelivery
  : TransportDelivery | ReplacedDelivery | NotApplicableDelivery;

export type RuntimePromptDeliveryTable = {
  readonly [Id in TurnPromptBlockId]: DeliveryFor<Id>;
};

const standing: SendDelivery = { kind: "send", placement: "standing" };
const turn: SendDelivery = { kind: "send", placement: "turn" };

/** The original agent's own loop state; no external runtime has it (D2). */
const RUNTIME_SESSION_MEMORY =
  "the runtime's own session memory and the review_coverage MCP tool";

const CLAUDE_CODE_DELIVERY: RuntimePromptDeliveryTable = {
  customInstructions: standing,
  persona: standing,
  zoteroAccess: standing,
  searchRoutes: standing,
  longToolResults: {
    kind: "notApplicable",
    reason: "Claude Code shows the model a tool result whole",
  },
  directAgentWorkflow: {
    kind: "replaced",
    by: "Claude Code's own agent loop; the Zotero MCP tool descriptions carry their rules",
  },
  noteWriteRule: standing,
  notesFolder: standing,
  agentFiles: standing,
  rawPdfPolicy: standing,
  sideChatReadOnly: standing,
  skillInventory: standing,
  runtimePlatform: {
    kind: "replaced",
    by: "Claude Code's own environment description",
  },
  modelLimitations: {
    kind: "notApplicable",
    reason: "Claude models read images",
  },
  libraryOverview: { kind: "replaced", by: RUNTIME_SESSION_MEMORY },
  visibleTurnContext: turn,
  executionCheckpoint: { kind: "replaced", by: RUNTIME_SESSION_MEMORY },
  turnMaterial: turn,
  scopeRules: turn,
  attachmentsNotice: {
    kind: "replaced",
    by: "the bridge's attachment path list (buildPromptText)",
  },
  priorReads: { kind: "replaced", by: RUNTIME_SESSION_MEMORY },
  coverage: { kind: "replaced", by: RUNTIME_SESSION_MEMORY },
  earlierSources: { kind: "replaced", by: RUNTIME_SESSION_MEMORY },
  clarifications: turn,
  permissionMode: {
    kind: "replaced",
    by: "Claude Code's own permission mode (the panel's permission chip)",
  },
  singlePaperHint: turn,
  workingDirectory: {
    kind: "replaced",
    by: "Claude Code's own working directory",
  },
  toolGuidance: turn,
  activeSkills: {
    kind: "replaced",
    by: "load_skill over Zotero MCP, chosen from the skill inventory",
  },
  paperContext: {
    kind: "replaced",
    by: "paper_read over Zotero MCP (no preloaded paper text, D1)",
  },
  stableResources: {
    kind: "replaced",
    by: "visibleTurnContext and scopeRules, rendered for each turn",
  },
  sideChatBackground: {
    kind: "notApplicable",
    reason: "side chats run on the original agent only",
  },
  continuityNotes: { kind: "replaced", by: RUNTIME_SESSION_MEMORY },
  history: {
    kind: "transport",
    how: "the Claude session (resume), or the bridge's fallback history (runtimeHistory.ts)",
  },
  pastChats: {
    kind: "transport",
    how: "buildExternalRuntimeUserText, before the user's words",
  },
  userRequest: { kind: "transport", how: "the bridge's userText" },
  images: { kind: "transport", how: "runtimeRequest.screenshots" },
  pdfFiles: {
    kind: "transport",
    how: "runtimeRequest.localDocuments and attachment paths",
  },
};

const ANTIGRAVITY_DELIVERY: RuntimePromptDeliveryTable = {
  // agy keeps standing text from session start only, so anything that can
  // change between turns is sent with the turn.
  customInstructions: turn,
  persona: standing,
  zoteroAccess: turn,
  searchRoutes: standing,
  longToolResults: standing,
  directAgentWorkflow: {
    kind: "replaced",
    by: "agy's own agent loop; the Zotero MCP tool descriptions carry their rules",
  },
  noteWriteRule: standing,
  notesFolder: turn,
  agentFiles: turn,
  rawPdfPolicy: turn,
  sideChatReadOnly: standing,
  // Skills are added, removed and refreshed while a chat goes on.
  skillInventory: turn,
  runtimePlatform: {
    kind: "replaced",
    by: "agy's own environment description",
  },
  modelLimitations: {
    kind: "notApplicable",
    reason: "agy's models read images",
  },
  libraryOverview: { kind: "replaced", by: RUNTIME_SESSION_MEMORY },
  visibleTurnContext: turn,
  executionCheckpoint: { kind: "replaced", by: RUNTIME_SESSION_MEMORY },
  turnMaterial: turn,
  scopeRules: turn,
  attachmentsNotice: {
    kind: "replaced",
    by: "resource_link blocks for the attached files (promptInput.ts)",
  },
  priorReads: { kind: "replaced", by: RUNTIME_SESSION_MEMORY },
  coverage: { kind: "replaced", by: RUNTIME_SESSION_MEMORY },
  earlierSources: { kind: "replaced", by: RUNTIME_SESSION_MEMORY },
  clarifications: turn,
  permissionMode: {
    kind: "replaced",
    by: "the agy session mode (the panel's permission chip)",
  },
  singlePaperHint: turn,
  workingDirectory: {
    kind: "replaced",
    by: "agy's own working directory",
  },
  toolGuidance: turn,
  activeSkills: {
    kind: "replaced",
    by: "load_skill over Zotero MCP, chosen from the skill inventory",
  },
  paperContext: {
    kind: "replaced",
    by: "paper_read over Zotero MCP (no preloaded paper text, D1)",
  },
  stableResources: {
    kind: "replaced",
    by: "visibleTurnContext and scopeRules, rendered for each turn",
  },
  sideChatBackground: {
    kind: "notApplicable",
    reason: "side chats run on the original agent only",
  },
  continuityNotes: { kind: "replaced", by: RUNTIME_SESSION_MEMORY },
  history: {
    kind: "transport",
    how: "the agy session (load or resume); a new session gets the chat history before its first turn (runtimeHistory.ts)",
  },
  pastChats: {
    kind: "transport",
    how: "buildExternalRuntimeUserText, before the user's words",
  },
  userRequest: { kind: "transport", how: "the prompt's last text" },
  images: { kind: "transport", how: "ACP image blocks (promptInput.ts)" },
  pdfFiles: {
    kind: "transport",
    how: "resource_link blocks and local PDF paths (promptInput.ts)",
  },
};

/** Codex's standing text is its environment manifest (nativeClient.ts). */
const CODEX_MANIFEST =
  "the Codex Zotero environment manifest (buildZoteroEnvironmentManifest)";

const CODEX_DELIVERY: RuntimePromptDeliveryTable = {
  customInstructions: {
    kind: "replaced",
    by: "the panel's system message, sent as developer instructions",
  },
  persona: { kind: "replaced", by: CODEX_MANIFEST },
  zoteroAccess: { kind: "replaced", by: CODEX_MANIFEST },
  searchRoutes: { kind: "replaced", by: CODEX_MANIFEST },
  longToolResults: {
    kind: "notApplicable",
    reason: "Codex shows the model a tool result whole",
  },
  directAgentWorkflow: {
    kind: "replaced",
    by: "Codex's own agent loop; the Zotero MCP tool descriptions carry their rules",
  },
  noteWriteRule: { kind: "replaced", by: CODEX_MANIFEST },
  notesFolder: { kind: "replaced", by: CODEX_MANIFEST },
  agentFiles: { kind: "replaced", by: CODEX_MANIFEST },
  rawPdfPolicy: { kind: "replaced", by: CODEX_MANIFEST },
  sideChatReadOnly: {
    kind: "notApplicable",
    reason: "side chats run on the original agent only",
  },
  skillInventory: {
    kind: "replaced",
    by: "Codex's native skills (skills/list over the projected skill copies)",
  },
  runtimePlatform: {
    kind: "replaced",
    by: "Codex's own environment description",
  },
  modelLimitations: {
    kind: "notApplicable",
    reason: "Codex models read images",
  },
  libraryOverview: { kind: "replaced", by: RUNTIME_SESSION_MEMORY },
  visibleTurnContext: turn,
  executionCheckpoint: { kind: "replaced", by: RUNTIME_SESSION_MEMORY },
  turnMaterial: turn,
  scopeRules: turn,
  attachmentsNotice: {
    kind: "replaced",
    by: "the attached files' text, inlined after the user's words",
  },
  priorReads: {
    kind: "replaced",
    by: "the Codex context ledger (nativeContextLedger.ts)",
  },
  coverage: { kind: "replaced", by: RUNTIME_SESSION_MEMORY },
  earlierSources: { kind: "replaced", by: RUNTIME_SESSION_MEMORY },
  clarifications: turn,
  permissionMode: {
    kind: "replaced",
    by: "the Codex thread's permission profile (the panel's permission chip)",
  },
  singlePaperHint: turn,
  workingDirectory: {
    kind: "replaced",
    by: "Codex's own working directory",
  },
  toolGuidance: turn,
  activeSkills: {
    kind: "replaced",
    by: "Codex native skill inputs, or the manifest's skill block",
  },
  paperContext: {
    kind: "replaced",
    by: "paper_read over Zotero MCP (light context plan, D1)",
  },
  stableResources: {
    kind: "replaced",
    by: "visibleTurnContext and scopeRules, rendered for each turn",
  },
  sideChatBackground: {
    kind: "notApplicable",
    reason: "side chats run on the original agent only",
  },
  continuityNotes: { kind: "replaced", by: RUNTIME_SESSION_MEMORY },
  history: {
    kind: "transport",
    how: "the Codex thread (resume), or injected history items",
  },
  pastChats: {
    kind: "transport",
    how: "attachedPastChatText, a turn input of its own",
  },
  userRequest: { kind: "transport", how: "the turn's latest user message" },
  images: { kind: "transport", how: "image parts of the latest user message" },
  pdfFiles: {
    kind: "transport",
    how: "local PDF paths read with Codex's own file tools",
  },
};

export const RUNTIME_PROMPT_DELIVERY: Readonly<
  Record<RuntimeConversationSystem, RuntimePromptDeliveryTable>
> = {
  claude_code: CLAUDE_CODE_DELIVERY,
  codex: CODEX_DELIVERY,
  antigravity: ANTIGRAVITY_DELIVERY,
};

// ---------------------------------------------------------------------------
// Shared renderers (also used by the original agent)
// ---------------------------------------------------------------------------

/** The installed skills the model may load, as the original agent lists them. */
export function renderSkillInventoryBlock(
  request: AgentRuntimeRequest,
): string {
  return `Installed skill inventory (workflow playbooks for multi-step tasks: notes, comparisons, reviews, imports, figure work; ordinary paper questions need no skill. When one matches and its guidance is not already active, call load_skill with its id): ${JSON.stringify(
    // Manual skills apply only when the user selects them.
    buildSkillInventory(getAllSkills())
      .filter(
        (skill) =>
          skill.activation !== "manual" &&
          !isSkillWithheldForEphemeralRequest(skill.id, request),
      )
      .map(({ id, description }) => ({ id, description })),
  )}`;
}

export const SINGLE_PAPER_HINT =
  "Single-paper chat: answer directly using the supplied paper context; questions about the paper need no skill, so do not load evidence-based-qa for them. You may freely choose additional snippet, section, full, figure, or targeted reads of this paper when useful. For whole-paper explanations, consider the argument, methods, results, and limitations throughout the available source.";

/** For a runtime with no preloaded paper text (D1). */
const EXTERNAL_SINGLE_PAPER_HINT =
  "Single-paper chat: questions about this paper need no skill, so do not load evidence-based-qa for them; read the paper with paper_read (snippet, section, full, figure, or targeted reads) as the question needs. For whole-paper explanations, consider the argument, methods, results, and limitations throughout the paper.";

export function renderClarificationsBlock(
  request: Pick<AgentRuntimeRequest, "clarificationHistory">,
): string {
  if (!request.clarificationHistory?.length) return "";
  return [
    "Clarifications supplied for this request:",
    ...request.clarificationHistory.map(
      (entry) => `- ${entry.question}: ${entry.answer}`,
    ),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Runtime-specific text for shared blocks
// ---------------------------------------------------------------------------

/**
 * The Claude Code bridge's map from the search-routing source families
 * (SEARCH_ROUTING_CONTRACT) to its own tools: the Zotero MCP tools for the
 * turn's papers, the library and scholarly sources, and Claude Code's
 * WebSearch and WebFetch for the web (user decision 2a, 2026-10-20). The
 * bridge allows WebFetch and WebSearch by default (start-bridge-server.ts
 * --default-allowed-tools), but extra bridge arguments, the user's Claude
 * settings or the model provider can remove them, so the line says "when
 * available". Native web search has no tool description that carries the
 * query-language rule, so the line states it.
 */
export const CLAUDE_BRIDGE_SEARCH_TOOL_ROUTES =
  "Search tools: the Zotero MCP tools, when listed, read the turn's papers (paper_read), search the library (library_retrieve, library_search) search scholarly sources (literature_search) and read a found paper's abstract and open-access text (literature_read); Claude Code's WebSearch and WebFetch search and read the web when available. Write web search queries in the user's language by default.";

const ANTIGRAVITY_SEARCH_ROUTES =
  "Search tools: the Zotero MCP tools read the turn's papers (paper_read), search the library (library_retrieve, library_search), search scholarly sources (literature_search), and read a found paper's abstract and open-access text (literature_read). Write web search queries in the user's language by default.";

/**
 * agy shows its model a tool result whole only up to about 10 KB. A longer
 * one arrives with its middle removed and a note naming the file that holds
 * all of it, and the model answers from the shortened result unless it is
 * told to open that file (probed on agy 1.5.17: a summary used a fifth of a
 * 40 KB result without this instruction, and all of it with).
 */
const ANTIGRAVITY_LONG_RESULT_RULE =
  "A tool result longer than about 10 KB reaches you with its middle removed and a note naming the file that holds the full output. Whenever a result carries that note, read the whole file it names before you answer; never answer from a shortened result.";

function renderZoteroAccess(
  system: RuntimeConversationSystem,
  rawPdfMode: boolean,
): string {
  switch (system) {
    case "claude_code":
      return rawPdfMode
        ? "Claude Code receives Zotero MCP access for metadata and write operations. For raw-PDF identities, use the exact current-turn local paths instead of Zotero paper-content retrieval."
        : "Claude Code receives Zotero access through the scoped MCP tools for this turn. When those tools are available, use library_search, library_retrieve, library_read, and paper_read for Zotero library or paper-content questions before relying on filesystem exploration or conversation-visible snippets. Use zotero_script for Zotero-native API inspection or scripted library operations only when the semantic Zotero tools cannot cover the request.";
    case "antigravity":
      return rawPdfMode
        ? "You receive Zotero MCP access for metadata and write operations. For raw-PDF identities, use the exact current-turn local paths instead of Zotero paper-content retrieval."
        : "You receive Zotero access through the scoped Zotero MCP tools. Use library_search, library_retrieve, library_read, and paper_read for Zotero library or paper-content questions before relying on filesystem exploration or conversation-visible snippets.";
    case "codex":
      return "";
    default:
      return assertNeverConversationSystem(system);
  }
}

function renderSearchRoutes(system: RuntimeConversationSystem): string {
  switch (system) {
    case "claude_code":
      return CLAUDE_BRIDGE_SEARCH_TOOL_ROUTES;
    case "antigravity":
      return ANTIGRAVITY_SEARCH_ROUTES;
    case "codex":
      return "";
    default:
      return assertNeverConversationSystem(system);
  }
}

function renderNoteWriteRule(system: RuntimeConversationSystem): string {
  switch (system) {
    case "claude_code":
      // Unconditional on purpose: where notes belong is a property of
      // Zotero, not of whether this user happens to have configured a notes
      // directory. The directory block only carves out the file writes that
      // are not notes.
      return "A note you are asked to write is a Zotero note: use the Zotero note_write tool, not Claude Code's Write tool. note_write is the only note path Zotero can authorize, journal, and verify against the saved note, so a note written straight to disk leaves the host with no record of what changed.";
    case "antigravity":
      return "A note you are asked to write is a Zotero note: use the Zotero note_write tool, not a file-writing tool. note_write is the only note path Zotero can authorize, journal, and verify against the saved note.";
    case "codex":
      return "";
    default:
      return assertNeverConversationSystem(system);
  }
}

function renderNotesFolder(system: RuntimeConversationSystem): string {
  const configSection = buildNotesDirectoryConfigSection().trim();
  if (!configSection) return "";
  const rediscoverTools =
    system === "claude_code"
      ? "Bash, Glob, Find, LS, or Read"
      : "shell commands or file-listing and file-reading tools";
  const heading =
    system === "claude_code"
      ? "Claude Code note-directory rules:"
      : "Note-directory rules:";
  return [
    configSection,
    heading,
    `- The notes directory is already configured by the user. Do not use ${rediscoverTools} to rediscover the vault path, inspect likely note folders, or probe write access when this section is present.`,
    "- When the user asks to save a file-based note into the configured notes directory, use the configured Default target path unless the user explicitly names a different folder or absolute path.",
    "- Do not create a Papers, papers, Notes, or other alternate subfolder unless the user explicitly requested that exact folder.",
    `- For a requested file-based note, finalize it with submit_document and call the Zotero MCP file_io tool with its documentId, exact visibleMarkdown, and a \`.md\` path under the configured Default target path. file_io exports and verifies the complete figure bundle without ${system === "claude_code" ? "native shell or Write access" : "native shell or file-writing access"}.`,
  ].join("\n");
}

/**
 * The selected collection and tag scopes' rules for a runtime reached over
 * Zotero MCP. The original agent's own rules (resourceContextPlan.ts) also
 * declare digest parts with task_update, which MCP does not list, so those
 * stay out.
 */
function renderExternalScopeRules(request: AgentRuntimeRequest): string {
  const { collections, tags } = request.turnPaperScope;
  if (!collections.length && !tags.length) return "";
  return [
    'The turn includes selected collection or tag scopes: resolve phrases like "this folder", "this collection", "inside this folder", and "this tag" against them. Do not ask the user which folder or tag they mean unless several selected scopes make the reference genuinely ambiguous.',
    ...(collections.length ? COLLECTION_SCOPE_RULES : []),
    ...(tags.length ? TAG_SCOPE_RULES : []),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Rendering for one runtime
// ---------------------------------------------------------------------------

export type RuntimePromptInput = {
  request: AgentRuntimeRequest;
  /** The turn reads local PDFs directly and has no paper_read. */
  rawPdfMode: boolean;
  /** Where saved files go (buildAgentFilesInstructionForScope); "" for none. */
  agentFilesInstruction: string;
  /**
   * The Zotero MCP tools' guidance that matches this turn, for the tools
   * whose catalog description does not already carry it
   * (collectZoteroMcpTurnToolGuidance).
   */
  toolGuidance: readonly string[];
};

export type RenderedRuntimePrompt = {
  /** Instructions the runtime keeps for its session. */
  standing: string;
  /** Context sent with this turn, before the user's words. */
  turn: string;
};

type BlockRenderer = (
  system: RuntimeConversationSystem,
  input: RuntimePromptInput,
) => string;

const unrendered: BlockRenderer = () => "";

/**
 * One renderer per text block. A block whose meaning belongs to the
 * original agent's own loop renders nothing here: no runtime marks it
 * `send` (asserted by the parity test).
 */
const TEXT_BLOCK_RENDERERS: Readonly<Record<TextPromptBlockId, BlockRenderer>> =
  {
    customInstructions: (_system, { request }) =>
      (request.systemPrompt || "").trim(),
    persona: () =>
      [
        "## Original agent-mode Zotero behavior",
        ...AGENT_PERSONA_INSTRUCTIONS,
      ].join("\n\n"),
    zoteroAccess: (system, { rawPdfMode }) =>
      renderZoteroAccess(system, rawPdfMode),
    searchRoutes: (system) => renderSearchRoutes(system),
    longToolResults: (system) =>
      system === "antigravity" ? ANTIGRAVITY_LONG_RESULT_RULE : "",
    directAgentWorkflow: unrendered,
    noteWriteRule: (system) => renderNoteWriteRule(system),
    notesFolder: (system) => renderNotesFolder(system),
    // A raw-PDF turn reads only the given PDFs and saves no files.
    agentFiles: (_system, { rawPdfMode, agentFilesInstruction }) =>
      rawPdfMode ? "" : agentFilesInstruction,
    rawPdfPolicy: (_system, { rawPdfMode }) =>
      rawPdfMode ? RAW_PDF_TRANSPORT_POLICY_BLOCK : "",
    sideChatReadOnly: (_system, { request }) =>
      isEphemeralConversationKey(request.conversationKey)
        ? SIDE_CHAT_READ_ONLY_INSTRUCTION
        : "",
    skillInventory: (_system, { request }) =>
      renderSkillInventoryBlock(request),
    runtimePlatform: unrendered,
    modelLimitations: unrendered,
    libraryOverview: unrendered,
    visibleTurnContext: (_system, { request }) =>
      buildVisibleTurnContextBlock(request),
    executionCheckpoint: unrendered,
    turnMaterial: (_system, { request, rawPdfMode }) =>
      renderTurnMaterialForModel(request, {
        // A raw-PDF turn has no paper_read, so a page hint names no call.
        readCalls: !rawPdfMode,
        // One line apart, as the original agent's turn message has them.
      }).join("\n"),
    scopeRules: (_system, { request }) => renderExternalScopeRules(request),
    attachmentsNotice: unrendered,
    priorReads: unrendered,
    coverage: unrendered,
    earlierSources: unrendered,
    clarifications: (_system, { request }) =>
      renderClarificationsBlock(request),
    permissionMode: unrendered,
    singlePaperHint: (_system, { request }) =>
      isSinglePaperConversation(request) ? EXTERNAL_SINGLE_PAPER_HINT : "",
    workingDirectory: unrendered,
    toolGuidance: (_system, { toolGuidance }) =>
      renderToolGuidanceLines(toolGuidance).join("\n"),
    activeSkills: unrendered,
  };

/** True for a text block that has a renderer for external runtimes. */
export function isRenderedTextPromptBlock(id: TextPromptBlockId): boolean {
  return TEXT_BLOCK_RENDERERS[id] !== unrendered;
}

/**
 * The text blocks one runtime marks `send`, rendered and grouped by
 * placement. Each block is one paragraph; empty blocks are left out.
 */
export function renderRuntimePromptBlocks(
  system: RuntimeConversationSystem,
  input: RuntimePromptInput,
): RenderedRuntimePrompt {
  const table = RUNTIME_PROMPT_DELIVERY[system];
  const placed: Record<BlockPlacement, string[]> = { standing: [], turn: [] };
  for (const id of TEXT_PROMPT_BLOCK_IDS) {
    const delivery = table[id];
    if (delivery.kind !== "send") continue;
    const text = TEXT_BLOCK_RENDERERS[id](system, input).trim();
    if (text) placed[delivery.placement].push(text);
  }
  return {
    standing: placed.standing.join("\n\n"),
    turn: placed.turn.join("\n\n"),
  };
}

/** Each block's text for one runtime, for the parity test. */
export function renderRuntimePromptBlocksById(
  system: RuntimeConversationSystem,
  input: RuntimePromptInput,
): Partial<Record<TextPromptBlockId, string>> {
  const table = RUNTIME_PROMPT_DELIVERY[system];
  const result: Partial<Record<TextPromptBlockId, string>> = {};
  for (const id of TEXT_PROMPT_BLOCK_IDS) {
    if (table[id].kind !== "send") continue;
    result[id] = TEXT_BLOCK_RENDERERS[id](system, input).trim();
  }
  return result;
}
