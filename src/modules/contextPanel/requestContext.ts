/**
 * The request context of one panel turn: the papers, passages, collections,
 * tags, files, images and forced skills that the turn sends, and the two
 * shapes the panel hands them on in.
 *
 * - `toAgentRuntimeRequestParams` builds the parameters of the agent request
 *   builder (chat.ts `buildAgentRuntimeRequest`, reached by the agent engine
 *   through `deps.buildAgentRuntimeRequest`).
 * - `toCodexNativeSkillContext` builds the skill context of a native Codex
 *   turn, where every empty list becomes `undefined`.
 *
 * Each request site still decides its own field values: the sites differ on
 * purpose (or by an open product decision), so this module only names the
 * shape and the two projections, never a shared assembler.
 */
import type {
  AdvancedModelParams,
  ChatAttachment,
  CollectionContextRef,
  LocalDocumentResource,
  NoteContextRef,
  PaperContextRef,
  ResolvedSelectedTextAnchor,
  SelectedTextContext,
  SelectedTextSource,
  TagContextRef,
} from "../../shared/types";
import type {
  ChatMessage,
  ReasoningConfig as LLMReasoningConfig,
} from "../../utils/llmClient";
import type { ProviderProtocol } from "../../utils/providerProtocol";
import type { CodexNativeSkillContext } from "../../codexAppServer/nativeSkills";
import type { TurnPaperScopeInput } from "../../agent/context/turnPaperScope";

export type EffectiveRequestConfig = {
  model: string;
  apiBase: string;
  apiKey: string;
  authMode:
    | "api_key"
    | "codex_auth"
    | "codex_app_server"
    | "copilot_auth"
    | "webchat";
  providerProtocol?: ProviderProtocol;
  modelEntryId?: string;
  modelProviderLabel?: string;
  reasoning: LLMReasoningConfig | undefined;
  advanced: AdvancedModelParams | undefined;
};

/** The parameters of the agent request builder. */
export type BuildAgentRuntimeRequestParams = {
  conversationKey: number;
  conversationGeneration?: number;
  sourceMessageTimestamp?: number;
  item: Zotero.Item;
  activePaperContext?: PaperContextRef;
  userText: string;
  selectedTextContexts?: SelectedTextContext[];
  resolvedSelectedTextAnchors?: ResolvedSelectedTextAnchor[];
  selectedTexts: string[];
  selectedTextSources?: SelectedTextSource[];
  selectedTextPaperContexts?: (PaperContextRef | undefined)[];
  selectedTextNoteContexts?: (NoteContextRef | undefined)[];
  paperContexts: PaperContextRef[];
  pdfPaperContexts?: PaperContextRef[];
  fullTextPaperContexts: PaperContextRef[];
  citationPaperContexts?: PaperContextRef[];
  selectedCollectionContexts?: CollectionContextRef[];
  selectedTagContexts?: TagContextRef[];
  attachments: ChatAttachment[] | undefined;
  localDocuments?: readonly LocalDocumentResource[];
  screenshots: string[] | undefined;
  forcedSkillIds?: string[];
  effectiveRequestConfig: EffectiveRequestConfig;
  history: ChatMessage[];
};

/**
 * What one turn sends. The scope fields carry the names of
 * `TurnPaperScopeInput`. `attachments` are the files the request asks the
 * model for; `skillAttachments` are the files the native skill router sees
 * (the Codex send routes skills on the visible attachments).
 *
 * A field a site leaves out stays absent in the agent request parameters.
 */
export type TurnRequestContext = {
  activePaperContext?: PaperContextRef;
  selectedTextContexts?: SelectedTextContext[];
  resolvedSelectedTextAnchors?: ResolvedSelectedTextAnchor[];
  selectedTexts: string[];
  selectedTextSources?: SelectedTextSource[];
  selectedTextPaperContexts?: (PaperContextRef | undefined)[];
  selectedTextNoteContexts?: (NoteContextRef | undefined)[];
  selectedPaperContexts: PaperContextRef[];
  pdfPaperContexts?: PaperContextRef[];
  fullTextPaperContexts: PaperContextRef[];
  pinnedPaperContexts?: PaperContextRef[];
  citationPaperContexts?: PaperContextRef[];
  selectedCollectionContexts?: CollectionContextRef[];
  selectedTagContexts?: TagContextRef[];
  attachments: ChatAttachment[] | undefined;
  skillAttachments?: ChatAttachment[];
  localDocuments?: readonly LocalDocumentResource[];
  screenshots: string[] | undefined;
  forcedSkillIds?: string[];
};

type TurnPaperScopeFields = Omit<
  TurnPaperScopeInput,
  | "libraryID"
  | "libraryName"
  | "conversationKind"
  | "activeItemId"
  | "resolvePaperContext"
>;
// Compile-time check: a request context carries every scope field of
// `TurnPaperScopeInput` under the same name and with a compatible type.
type FitsTurnPaperScope<T extends TurnPaperScopeFields> = T;
export type TurnRequestScopeFields = FitsTurnPaperScope<
  Pick<TurnRequestContext, keyof TurnPaperScopeFields>
>;

/** The fields of one request that are not compose context. */
export type AgentRuntimeRequestTurn = Pick<
  BuildAgentRuntimeRequestParams,
  | "conversationKey"
  | "conversationGeneration"
  | "sourceMessageTimestamp"
  | "item"
  | "userText"
  | "effectiveRequestConfig"
  | "history"
>;

export function toAgentRuntimeRequestParams(
  context: TurnRequestContext,
  turn: AgentRuntimeRequestTurn,
): BuildAgentRuntimeRequestParams {
  const {
    selectedPaperContexts,
    pinnedPaperContexts: _pinnedPaperContexts,
    skillAttachments: _skillAttachments,
    ...requestFields
  } = context;
  return {
    ...turn,
    ...requestFields,
    paperContexts: selectedPaperContexts,
  };
}

export function toCodexNativeSkillContext(
  context: TurnRequestContext,
): CodexNativeSkillContext {
  return {
    forcedSkillIds: context.forcedSkillIds?.length
      ? context.forcedSkillIds
      : undefined,
    selectedTextContexts: context.selectedTextContexts?.length
      ? context.selectedTextContexts
      : undefined,
    resolvedSelectedTextAnchors: context.resolvedSelectedTextAnchors?.length
      ? context.resolvedSelectedTextAnchors
      : undefined,
    selectedTexts: context.selectedTexts?.length
      ? context.selectedTexts
      : undefined,
    selectedTextSources: context.selectedTextSources?.length
      ? context.selectedTextSources
      : undefined,
    selectedTextPaperContexts: context.selectedTextPaperContexts?.some(Boolean)
      ? context.selectedTextPaperContexts
      : undefined,
    selectedTextNoteContexts: context.selectedTextNoteContexts?.some(Boolean)
      ? context.selectedTextNoteContexts
      : undefined,
    selectedPaperContexts: context.selectedPaperContexts?.length
      ? context.selectedPaperContexts
      : undefined,
    pdfPaperContexts: context.pdfPaperContexts?.length
      ? context.pdfPaperContexts
      : undefined,
    localDocuments: context.localDocuments?.length
      ? context.localDocuments
      : undefined,
    fullTextPaperContexts: context.fullTextPaperContexts?.length
      ? context.fullTextPaperContexts
      : undefined,
    pinnedPaperContexts: context.pinnedPaperContexts?.length
      ? context.pinnedPaperContexts
      : undefined,
    selectedCollectionContexts: context.selectedCollectionContexts?.length
      ? context.selectedCollectionContexts
      : undefined,
    selectedTagContexts: context.selectedTagContexts?.length
      ? context.selectedTagContexts
      : undefined,
    screenshots: context.screenshots?.length ? context.screenshots : undefined,
    attachments: context.skillAttachments?.length
      ? context.skillAttachments
      : undefined,
  };
}
