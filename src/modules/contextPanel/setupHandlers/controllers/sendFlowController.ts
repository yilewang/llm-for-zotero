import { MAX_SELECTED_IMAGES } from "../../constants";
import type { ProviderProtocol } from "../../../../utils/providerProtocol";
import type { PdfSupport } from "../../../../providers";
import type {
  AdvancedModelParams,
  ChatAttachment,
  ChatRuntimeMode,
  CollectionContextRef,
  PaperContextRef,
  ResolvedContextSource,
  SelectedTextContext,
  TagContextRef,
} from "../../types";
import type { SelectedTextSource } from "../../types";
import type { EditLatestTurnMarker, EditLatestTurnResult } from "../../chat";
import type { ReasoningConfig as LLMReasoningConfig } from "../../../../utils/llmClient";
import {
  buildCodexAppServerNativeAttachmentBlockMessage,
  getBlockedCodexAppServerNativeAttachments,
  shouldApplyCodexAppServerNativeAttachmentPolicy,
} from "../../codexAppServerAttachmentPolicy";
import { resolvePdfModeModelInputs } from "./pdfPaperModelInputController";
import { getAllSkills, type AgentSkill } from "../../../../agent/skills";

type StatusLevel = "ready" | "warning" | "error";

type SelectedProfile = {
  entryId: string;
  model: string;
  apiBase: string;
  apiKey: string;
  providerLabel: string;
  authMode?:
    | "api_key"
    | "codex_auth"
    | "codex_app_server"
    | "copilot_auth"
    | "webchat";
  providerProtocol?: ProviderProtocol;
};

type LatestEditablePair = {
  conversationKey: number;
  pair: {
    userMessage: {
      timestamp: number;
    };
    assistantMessage: {
      timestamp: number;
      streaming?: boolean;
    };
  };
};

type SendFlowControllerDeps = {
  body: Element;
  inputBox: HTMLTextAreaElement;
  getItem: () => Zotero.Item | null;
  resolveContextSource: () => Promise<ResolvedContextSource | null>;
  closeSlashMenu: () => void;
  closePaperPicker: () => void;
  getSelectedTextContextEntries: (itemId: number) => SelectedTextContext[];
  getSelectedPaperContexts: (itemId: number) => PaperContextRef[];
  getSelectedCollectionContexts: (itemId: number) => CollectionContextRef[];
  getSelectedTagContexts: (itemId: number) => TagContextRef[];
  getFullTextPaperContexts: (
    item: Zotero.Item,
    paperContexts: PaperContextRef[],
  ) => PaperContextRef[];
  getPdfModePaperContexts: (
    item: Zotero.Item,
    paperContexts: PaperContextRef[],
  ) => PaperContextRef[];
  resolvePdfPaperAttachments: (
    paperContexts: PaperContextRef[],
  ) => Promise<ChatAttachment[]>;
  renderPdfPagesAsImages: (
    paperContexts: PaperContextRef[],
    maxImages?: number,
  ) => Promise<string[]>;
  getModelPdfSupport: (
    modelName: string,
    providerProtocol?: string,
    authMode?: string,
    apiBase?: string,
  ) => PdfSupport;
  uploadPdfForProvider: (params: {
    apiBase: string;
    apiKey: string;
    pdfBytes: Uint8Array<ArrayBufferLike>;
    fileName: string;
  }) => Promise<{ systemMessageContent: string; label: string } | null>;
  resolvePdfBytes: (
    paperContext: PaperContextRef,
  ) => Promise<Uint8Array<ArrayBufferLike>>;
  getSelectedFiles: (itemId: number) => ChatAttachment[];
  getSelectedImages: (itemId: number) => string[];
  resolvePromptText: (
    text: string,
    selectedText: string,
    hasAttachmentContext: boolean,
  ) => string;
  buildQuestionWithSelectedTextContexts: (
    selectedTexts: string[],
    selectedTextSources: SelectedTextSource[],
    promptText: string,
    options?: {
      selectedTextPaperContexts?: (PaperContextRef | undefined)[];
      includePaperAttribution?: boolean;
    },
  ) => string;
  buildModelPromptWithFileContext: (
    question: string,
    attachments: ChatAttachment[],
  ) => string;
  isAgentMode: () => boolean;
  isGlobalMode: () => boolean;
  isClaudeConversationSystem: () => boolean;
  isCodexConversationSystem: () => boolean;
  normalizeConversationTitleSeed: (raw: unknown) => string;
  getConversationKey: (item: Zotero.Item) => number;
  touchClaudeConversationTitle: (
    conversationKey: number,
    title: string,
  ) => Promise<void>;
  touchCodexConversationTitle: (
    conversationKey: number,
    title: string,
  ) => Promise<void>;
  touchGlobalConversationTitle: (
    conversationKey: number,
    title: string,
  ) => Promise<void>;
  touchPaperConversationTitle: (
    conversationKey: number,
    title: string,
  ) => Promise<void>;
  getSelectedProfile: () => SelectedProfile | null;
  getCurrentModelName: () => string;
  isScreenshotUnsupportedModel: (modelName: string) => boolean;
  getSelectedReasoning: () => LLMReasoningConfig | undefined;
  getAdvancedModelParams: (
    entryId: string | undefined,
  ) => AdvancedModelParams | undefined;
  getActiveEditSession: () => EditLatestTurnMarker | null;
  setActiveEditSession: (value: EditLatestTurnMarker | null) => void;
  getLatestEditablePair: () => Promise<LatestEditablePair | null>;
  editLatestUserMessageAndRetry: (
    opts: import("../../types").EditRetryOptions,
  ) => Promise<EditLatestTurnResult>;
  sendQuestion: (
    opts: import("../../types").SendQuestionOptions,
  ) => Promise<void>;
  retainClaudeRuntime?: (body: Element, item: Zotero.Item) => Promise<void>;
  retainPinnedImageState: (itemId: number) => void;
  retainPaperState: (itemId: number) => void;
  consumePaperModeState: (itemId: number) => void;
  retainPinnedFileState: (itemId: number) => void;
  retainPinnedTextState: (conversationKey: number) => void;
  updatePaperPreviewPreservingScroll: () => void;
  updateFilePreviewPreservingScroll: () => void;
  updateImagePreviewPreservingScroll: () => void;
  updateSelectedTextPreviewPreservingScroll: () => void;
  scheduleAttachmentGc: () => void;
  refreshGlobalHistoryHeader: () => void;
  persistDraftInput: () => void;
  autoLockGlobalChat: () => void;
  autoUnlockGlobalChat: () => void;
  setStatusMessage?: (message: string, level: StatusLevel) => void;
  editStaleStatusText: string;
  onComposerDraftCleared?: () => void;
  /** Consume forced skill IDs from slash menu selection. Returns the IDs and clears state. */
  consumeForcedSkillIds?: () => string[] | undefined;
  // [webchat]
  hasActivePdfFullTextPapers?: (
    item: Zotero.Item,
    paperContexts?: any[],
  ) => boolean;
  hasUploadedPdfInCurrentWebChatConversation?: () => boolean;
  markWebChatPdfUploadedForCurrentConversation?: () => void;
  consumeWebChatForceNewChatIntent?: () => boolean;
};

type CodexNativeSkillTextResolution = {
  text: string;
  forcedSkillId?: string;
};

type NaturalLanguageSkillDirective = {
  skillPhrase: string;
  rest: string;
};

type SkillCandidateScore = {
  skill: AgentSkill;
  score: number;
};

const NATURAL_SKILL_DIRECTIVE_PATTERN =
  /^(?:(?:please|pls)\s+)?(?:(?:can|could|would)\s+you\s+)?(?:(?:please|pls)\s+)?(?:use|using|with|activate|run|invoke)\s+(?:the\s+|a\s+|an\s+)?(.+?)\s+skill\b([\s\S]*)$/i;

const NATURAL_SKILL_MIN_SCORE = 70;
const NATURAL_SKILL_MIN_MARGIN = 10;
const DESCRIPTION_TOKEN_SCORE = 62;
const SKILL_TOKEN_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "by",
  "can",
  "could",
  "for",
  "from",
  "help",
  "i",
  "in",
  "into",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "please",
  "skill",
  "that",
  "the",
  "these",
  "this",
  "those",
  "to",
  "use",
  "using",
  "with",
  "would",
  "you",
  "your",
]);

function normalizeSkillAliasText(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[`'"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function getMeaningfulSkillTokens(value: string): string[] {
  const normalized = normalizeSkillAliasText(value);
  if (!normalized) return [];
  return normalized
    .split(" ")
    .filter((token) => token && !SKILL_TOKEN_STOPWORDS.has(token));
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + substitutionCost,
      );
    }
    for (let j = 0; j <= b.length; j++) {
      previous[j] = current[j];
    }
  }

  return previous[b.length];
}

function scoreTokenMatch(queryToken: string, targetToken: string): number {
  if (!queryToken || !targetToken) return 0;
  if (queryToken === targetToken) return 1;
  if (
    queryToken.length >= 4 &&
    targetToken.length >= 4 &&
    (queryToken.startsWith(targetToken) || targetToken.startsWith(queryToken))
  ) {
    return 0.9;
  }
  const maxLength = Math.max(queryToken.length, targetToken.length);
  if (maxLength >= 4 && levenshteinDistance(queryToken, targetToken) <= 1) {
    return 0.85;
  }
  return 0;
}

function scoreIdAliasMatch(skill: AgentSkill, phraseTokens: string[]): number {
  const idTokens = getMeaningfulSkillTokens(skill.id);
  if (!phraseTokens.length || !idTokens.length) return 0;

  if (phraseTokens.join("") === idTokens.join("")) return 100;

  if (phraseTokens.length < 2 || phraseTokens.length > idTokens.length) {
    return 0;
  }

  const tokenScores = phraseTokens.map((token, index) =>
    scoreTokenMatch(token, idTokens[index] || ""),
  );
  if (tokenScores.some((score) => score <= 0)) return 0;

  const average =
    tokenScores.reduce((total, score) => total + score, 0) / tokenScores.length;
  return 78 + average * 12 + phraseTokens.length;
}

function scoreDescriptionMatch(
  skill: AgentSkill,
  phraseTokens: string[],
): number {
  if (phraseTokens.length < 2) return 0;
  const descriptionTokens = getMeaningfulSkillTokens(skill.description);
  if (!descriptionTokens.length) return 0;

  const matchedScores = phraseTokens
    .map((token) =>
      Math.max(
        0,
        ...descriptionTokens.map((descriptionToken) =>
          scoreTokenMatch(token, descriptionToken),
        ),
      ),
    )
    .filter((score) => score > 0);
  if (matchedScores.length < 2) return 0;

  return (
    DESCRIPTION_TOKEN_SCORE +
    matchedScores.reduce((total, score) => total + score, 0) * 4
  );
}

function parseNaturalLanguageSkillDirective(
  text: string,
): NaturalLanguageSkillDirective | null {
  const match = NATURAL_SKILL_DIRECTIVE_PATTERN.exec(text.trim());
  if (!match) return null;

  const skillPhrase = (match[1] || "").trim();
  if (!skillPhrase) return null;

  const rest = (match[2] || "")
    .trim()
    .replace(/^[,:;-]\s*/u, "")
    .replace(/^to\s+/i, "")
    .trim();
  return { skillPhrase, rest };
}

function resolveNaturalLanguageSkillId(
  skillPhrase: string,
  allSkills: ReadonlyArray<AgentSkill>,
): string | undefined {
  const phraseTokens = getMeaningfulSkillTokens(skillPhrase);
  if (!phraseTokens.length) return undefined;

  const scored = allSkills
    .map(
      (skill): SkillCandidateScore => ({
        skill,
        score: Math.max(
          scoreIdAliasMatch(skill, phraseTokens),
          scoreDescriptionMatch(skill, phraseTokens),
        ),
      }),
    )
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top || top.score < NATURAL_SKILL_MIN_SCORE) return undefined;

  const runnerUp = scored[1];
  if (runnerUp && top.score - runnerUp.score < NATURAL_SKILL_MIN_MARGIN) {
    return undefined;
  }

  return top.skill.id;
}

function resolveCodexNativeSkillText(
  text: string,
  authMode?: SelectedProfile["authMode"],
): CodexNativeSkillTextResolution {
  if (authMode !== "codex_app_server") return { text };
  const trimmed = text.trim();
  const allSkills = getAllSkills();
  const nativeMatch = /^\$([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(
    trimmed,
  );
  if (nativeMatch) {
    const skillId = nativeMatch[1];
    if (!allSkills.some((skill) => skill.id === skillId)) {
      return { text };
    }
    return { text: trimmed, forcedSkillId: skillId };
  }
  const slashMatch = /^\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(
    trimmed,
  );
  if (slashMatch) {
    const skillId = slashMatch[1];
    if (!allSkills.some((skill) => skill.id === skillId)) {
      return { text };
    }
    const rest = (slashMatch[2] || "").trim();
    return {
      text: rest ? `$${skillId}\n\n${rest}` : `$${skillId}`,
      forcedSkillId: skillId,
    };
  }

  const directive = parseNaturalLanguageSkillDirective(trimmed);
  if (!directive) return { text };

  const naturalSkillId = resolveNaturalLanguageSkillId(
    directive.skillPhrase,
    allSkills,
  );
  if (!naturalSkillId) return { text };

  return {
    text: directive.rest
      ? `$${naturalSkillId}\n\n${directive.rest}`
      : `$${naturalSkillId}`,
    forcedSkillId: naturalSkillId,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function prependCodexNativeSkillMention(
  question: string,
  skillId: string,
): string {
  const trimmedQuestion = question.trim();
  const nativeSkillPrefix = new RegExp(`^\\$${escapeRegExp(skillId)}(?:\\s|$)`);
  if (nativeSkillPrefix.test(trimmedQuestion)) return question;
  return trimmedQuestion ? `$${skillId}\n\n${question}` : `$${skillId}`;
}

export function createSendFlowController(deps: SendFlowControllerDeps): {
  doSend: (options?: {
    overrideText?: string;
    preserveInputDraft?: boolean;
  }) => Promise<void>;
} {
  const doSend = async (options?: {
    overrideText?: string;
    preserveInputDraft?: boolean;
  }) => {
    const item = deps.getItem();
    if (!item) return;

    deps.closeSlashMenu();
    deps.closePaperPicker();
    deps.autoLockGlobalChat();

    try {
      const textContextConversationKey = deps.getConversationKey(item);
      const draftText = deps.inputBox.value.trim();
      const earlyProfile = deps.getSelectedProfile();
      const rawSubmittedText = (options?.overrideText ?? draftText).trim();
      const codexNativeSkillText = resolveCodexNativeSkillText(
        rawSubmittedText,
        earlyProfile?.authMode,
      );
      const text = codexNativeSkillText.text;
      const selectedContexts = deps.getSelectedTextContextEntries(
        textContextConversationKey,
      );
      const selectedTexts = selectedContexts.map((entry) => entry.text);
      const selectedTextSources = selectedContexts.map((entry) => entry.source);
      const selectedTextPaperContexts = selectedContexts.map(
        (entry) => entry.paperContext,
      );
      const selectedTextNoteContexts = selectedContexts.map(
        (entry) => entry.noteContext,
      );
      const primarySelectedText = selectedTexts[0] || "";
      const contextSource = await deps.resolveContextSource();
      const allSelectedPaperContexts = deps.getSelectedPaperContexts(item.id);
      const selectedCollectionContexts = deps.getSelectedCollectionContexts(
        item.id,
      );
      const selectedTagContexts = deps.getSelectedTagContexts(item.id);
      const usesPluginAgentMode =
        (deps.isAgentMode() || deps.isClaudeConversationSystem()) &&
        !deps.isCodexConversationSystem();
      // Plugin Agent mode uses text/MinerU pipeline by default, but if the user
      // explicitly forced PDF mode on a paper, honour that choice.
      const pdfModePaperContexts = deps.getPdfModePaperContexts(
        item,
        allSelectedPaperContexts,
      );
      // Papers in PDF mode are sent as file attachments, not through the text pipeline
      const pdfModeKeySet = new Set(
        pdfModePaperContexts.map((p) => `${p.itemId}:${p.contextItemId}`),
      );
      const selectedPaperContexts = allSelectedPaperContexts.filter(
        (p) => !pdfModeKeySet.has(`${p.itemId}:${p.contextItemId}`),
      );
      const fullTextPaperContexts = deps.getFullTextPaperContexts(
        item,
        selectedPaperContexts,
      );
      // Resolve PDFs based on model capability. The visible chip/attachment state
      // stays unchanged; these variables are the provider-specific model inputs.
      const isWebChat = earlyProfile?.authMode === "webchat";
      const runtimeMode: ChatRuntimeMode = usesPluginAgentMode
        ? "agent"
        : "chat";
      const useCodexAttachmentPolicy =
        shouldApplyCodexAppServerNativeAttachmentPolicy({
          authMode: earlyProfile?.authMode,
        });
      const earlyModelName = (
        earlyProfile?.model ||
        deps.getCurrentModelName() ||
        ""
      ).trim();
      const selectedBaseFiles = deps.getSelectedFiles(item.id);
      if (useCodexAttachmentPolicy) {
        const blockedAttachments =
          getBlockedCodexAppServerNativeAttachments(selectedBaseFiles);
        if (blockedAttachments.length) {
          deps.setStatusMessage?.(
            buildCodexAppServerNativeAttachmentBlockMessage(blockedAttachments),
            "error",
          );
          return;
        }
      }
      const selectedImages = deps
        .getSelectedImages(item.id)
        .slice(0, MAX_SELECTED_IMAGES);
      const selectedImageCountForBudget = deps.isScreenshotUnsupportedModel(
        earlyModelName,
      )
        ? 0
        : selectedImages.length;
      const pdfInputs = await resolvePdfModeModelInputs({
        deps: {
          setInputDisabled: (disabled) => {
            deps.inputBox.disabled = disabled;
          },
          setStatusMessage: deps.setStatusMessage,
          logError: (message, ...args) => {
            ztoolkit.log(message, ...args);
          },
          isScreenshotUnsupportedModel: deps.isScreenshotUnsupportedModel,
          getModelPdfSupport: deps.getModelPdfSupport,
          resolvePdfPaperAttachments: deps.resolvePdfPaperAttachments,
          renderPdfPagesAsImages: deps.renderPdfPagesAsImages,
          uploadPdfForProvider: deps.uploadPdfForProvider,
          resolvePdfBytes: deps.resolvePdfBytes,
        },
        paperContexts: pdfModePaperContexts,
        selectedBaseFiles,
        selectedImageCountForBudget,
        profile: earlyProfile,
        currentModelName: earlyModelName,
        isWebChat,
        useCodexAttachmentPolicy,
      });
      if (!pdfInputs.ok) return;
      const {
        selectedFiles,
        modelFiles,
        pdfPageImageDataUrls,
        pdfUploadSystemMessages,
      } = pdfInputs;
      const hasImageInputs =
        selectedImages.length > 0 || pdfPageImageDataUrls.length > 0;
      if (
        isWebChat &&
        (selectedCollectionContexts.length || selectedTagContexts.length)
      ) {
        deps.setStatusMessage?.(
          "Web chat does not support Zotero collection or tag context. Remove the scope chip and try again.",
          "error",
        );
        return;
      }
      const hasPaperComposeState =
        allSelectedPaperContexts.length > 0 ||
        selectedCollectionContexts.length > 0 ||
        selectedTagContexts.length > 0 ||
        !deps.isGlobalMode();

      if (
        !text &&
        !primarySelectedText &&
        !selectedPaperContexts.length &&
        !selectedCollectionContexts.length &&
        !selectedTagContexts.length &&
        !selectedFiles.length &&
        !hasImageInputs
      ) {
        return;
      }

      const hasNonImageAttachments =
        selectedFiles.length > 0 ||
        selectedPaperContexts.length > 0 ||
        selectedCollectionContexts.length > 0 ||
        selectedTagContexts.length > 0;

      const promptText = deps.resolvePromptText(
        text,
        primarySelectedText,
        hasNonImageAttachments,
      );
      let resolvedPromptText = promptText;
      if (!resolvedPromptText && hasImageInputs) {
        resolvedPromptText = "Please analyze the attached images.";
      }
      if (!resolvedPromptText) return;

      const selectedScopeContextCount =
        selectedPaperContexts.length +
        selectedCollectionContexts.length +
        selectedTagContexts.length;
      if (
        !text &&
        !primarySelectedText &&
        selectedScopeContextCount > 0 &&
        !selectedFiles.length &&
        !hasImageInputs
      ) {
        resolvedPromptText = selectedPaperContexts.length
          ? "Please analyze selected papers."
          : selectedCollectionContexts.length
            ? "Please analyze selected collection."
            : "Please analyze selected tag.";
      }

      const composedQuestionBase = primarySelectedText
        ? deps.buildQuestionWithSelectedTextContexts(
            selectedTexts,
            selectedTextSources,
            resolvedPromptText,
            {
              selectedTextPaperContexts,
              includePaperAttribution: deps.isGlobalMode(),
            },
          )
        : resolvedPromptText;

      const composedQuestion = usesPluginAgentMode
        ? resolvedPromptText
        : deps.buildModelPromptWithFileContext(
            composedQuestionBase,
            selectedFiles,
          );

      // Check for command action metadata (set by handleInlineCommand for /command display)
      const dataset = deps.inputBox.dataset;
      const commandAction = dataset?.commandAction;
      const commandParams = dataset?.commandParams ?? "";
      if (commandAction && dataset) {
        delete dataset.commandAction;
        delete dataset.commandParams;
      }
      const displayQuestion = commandAction
        ? commandParams
          ? `/${commandAction} ${commandParams}`
          : `/${commandAction}`
        : primarySelectedText
          ? resolvedPromptText
          : rawSubmittedText || resolvedPromptText;

      const titleSeed =
        deps.normalizeConversationTitleSeed(rawSubmittedText) ||
        deps.normalizeConversationTitleSeed(resolvedPromptText);
      if (titleSeed) {
        const touchTitle = deps.isClaudeConversationSystem()
          ? deps.touchClaudeConversationTitle
          : deps.isCodexConversationSystem()
            ? deps.touchCodexConversationTitle
            : deps.isGlobalMode()
              ? deps.touchGlobalConversationTitle
              : deps.touchPaperConversationTitle;
        void touchTitle(deps.getConversationKey(item), titleSeed).catch(
          (err) => {
            ztoolkit.log("LLM: Failed to touch conversation title", err);
          },
        );
      }

      const selectedProfile = deps.getSelectedProfile();
      const shouldRetainClaudeRuntime =
        deps.isClaudeConversationSystem() ||
        selectedProfile?.providerLabel === "Claude Code";
      const activeModelName = (
        selectedProfile?.model ||
        deps.getCurrentModelName() ||
        ""
      ).trim();
      const images = [
        ...(deps.isScreenshotUnsupportedModel(activeModelName)
          ? []
          : selectedImages),
        ...pdfPageImageDataUrls,
      ];
      const selectedReasoning = deps.getSelectedReasoning();
      const advancedParams = deps.getAdvancedModelParams(
        selectedProfile?.entryId,
      );

      const activeEditSession = deps.getActiveEditSession();
      if (activeEditSession) {
        const latest = await deps.getLatestEditablePair();
        if (!latest) {
          deps.setActiveEditSession(null);
          deps.setStatusMessage?.("No editable latest prompt", "error");
          return;
        }
        const { conversationKey: latestKey, pair } = latest;
        if (
          pair.assistantMessage.streaming ||
          activeEditSession.conversationKey !== latestKey ||
          activeEditSession.userTimestamp !== pair.userMessage.timestamp ||
          activeEditSession.assistantTimestamp !==
            pair.assistantMessage.timestamp
        ) {
          deps.setActiveEditSession(null);
          deps.setStatusMessage?.(deps.editStaleStatusText, "error");
          return;
        }

        const editResult = await deps.editLatestUserMessageAndRetry({
          body: deps.body,
          item,
          contextSource,
          displayQuestion,
          selectedTexts: selectedTexts.length ? selectedTexts : undefined,
          selectedTextSources: selectedTexts.length
            ? selectedTextSources
            : undefined,
          selectedTextPaperContexts: selectedTexts.length
            ? selectedTextPaperContexts
            : undefined,
          selectedTextNoteContexts: selectedTexts.length
            ? selectedTextNoteContexts
            : undefined,
          screenshotImages: images,
          paperContexts: selectedPaperContexts,
          fullTextPaperContexts,
          selectedCollectionContexts,
          selectedTagContexts,
          attachments: selectedFiles.length ? selectedFiles : undefined,
          modelAttachments: selectedFiles.length ? modelFiles : undefined,
          pdfUploadSystemMessages: pdfUploadSystemMessages.length
            ? pdfUploadSystemMessages
            : undefined,
          targetRuntimeMode: runtimeMode,
          expected: activeEditSession,
          model: selectedProfile?.model,
          apiBase: selectedProfile?.apiBase,
          apiKey: selectedProfile?.apiKey,
          authMode: selectedProfile?.authMode,
          providerProtocol: selectedProfile?.providerProtocol,
          modelEntryId: selectedProfile?.entryId,
          modelProviderLabel: selectedProfile?.providerLabel,
          reasoning: selectedReasoning,
          advanced: advancedParams,
        });
        if (editResult !== "ok") {
          if (editResult === "stale") {
            deps.setActiveEditSession(null);
            deps.setStatusMessage?.(deps.editStaleStatusText, "error");
            return;
          }
          if (editResult === "missing") {
            deps.setActiveEditSession(null);
            deps.setStatusMessage?.("No editable latest prompt", "error");
            return;
          }
          deps.setStatusMessage?.("Failed to save edited prompt", "error");
          return;
        }

        if (!options?.preserveInputDraft) {
          deps.inputBox.value = "";
          deps.onComposerDraftCleared?.();
          deps.persistDraftInput();
        }
        deps.retainPinnedImageState(item.id);
        if (hasPaperComposeState) {
          deps.consumePaperModeState(item.id);
          deps.retainPaperState(item.id);
          deps.updatePaperPreviewPreservingScroll();
        }
        if (selectedFiles.length) {
          deps.retainPinnedFileState(item.id);
          deps.updateFilePreviewPreservingScroll();
        }
        deps.updateImagePreviewPreservingScroll();
        if (primarySelectedText) {
          deps.retainPinnedTextState(textContextConversationKey);
          deps.updateSelectedTextPreviewPreservingScroll();
        }
        deps.setActiveEditSession(null);
        deps.scheduleAttachmentGc();
        deps.refreshGlobalHistoryHeader();
        return;
      }

      if (!options?.preserveInputDraft) {
        deps.inputBox.value = "";
        deps.onComposerDraftCleared?.();
        deps.persistDraftInput();
      }
      deps.retainPinnedImageState(item.id);
      if (selectedFiles.length) {
        deps.retainPinnedFileState(item.id);
        deps.updateFilePreviewPreservingScroll();
      }
      deps.updateImagePreviewPreservingScroll();
      if (primarySelectedText) {
        deps.retainPinnedTextState(textContextConversationKey);
        deps.updateSelectedTextPreviewPreservingScroll();
      }

      // [webchat] Determine whether to send PDF and/or force a new chat
      // (isWebChat already computed early from earlyProfile)
      const webchatForceNewChat = isWebChat
        ? (deps.consumeWebChatForceNewChatIntent?.() ?? false)
        : false;
      const webchatSendPdf = isWebChat
        ? (deps.hasActivePdfFullTextPapers?.(item, allSelectedPaperContexts) ??
            false) &&
          (webchatForceNewChat ||
            !(deps.hasUploadedPdfInCurrentWebChatConversation?.() ?? false))
        : false;

      const consumedForcedSkillIds = deps.consumeForcedSkillIds?.() || [];
      const forcedSkillIds = Array.from(
        new Set([
          ...consumedForcedSkillIds,
          ...(codexNativeSkillText.forcedSkillId
            ? [codexNativeSkillText.forcedSkillId]
            : []),
        ]),
      );
      const questionForSend =
        selectedProfile?.authMode === "codex_app_server" && forcedSkillIds[0]
          ? prependCodexNativeSkillMention(composedQuestion, forcedSkillIds[0])
          : composedQuestion;
      if (shouldRetainClaudeRuntime) {
        await deps.retainClaudeRuntime?.(deps.body, item);
      }
      const sendTask = deps.sendQuestion({
        body: deps.body,
        item,
        contextSource,
        question: questionForSend,
        images,
        model: selectedProfile?.model,
        apiBase: selectedProfile?.apiBase,
        apiKey: selectedProfile?.apiKey,
        authMode: selectedProfile?.authMode,
        providerProtocol: selectedProfile?.providerProtocol,
        modelEntryId: selectedProfile?.entryId,
        modelProviderLabel: selectedProfile?.providerLabel,
        reasoning: selectedReasoning,
        advanced: advancedParams,
        displayQuestion,
        selectedTexts: selectedTexts.length ? selectedTexts : undefined,
        selectedTextSources: selectedTexts.length
          ? selectedTextSources
          : undefined,
        selectedTextPaperContexts: selectedTexts.length
          ? selectedTextPaperContexts
          : undefined,
        selectedTextNoteContexts: selectedTexts.length
          ? selectedTextNoteContexts
          : undefined,
        paperContexts: selectedPaperContexts,
        fullTextPaperContexts,
        selectedCollectionContexts,
        selectedTagContexts,
        attachments: selectedFiles.length ? selectedFiles : undefined,
        modelAttachments: selectedFiles.length ? modelFiles : undefined,
        runtimeMode,
        pdfModePaperKeys: pdfModeKeySet.size > 0 ? pdfModeKeySet : undefined,
        forcedSkillIds: forcedSkillIds.length ? forcedSkillIds : undefined,
        pdfUploadSystemMessages: pdfUploadSystemMessages.length
          ? pdfUploadSystemMessages
          : undefined,
        webchatSendPdf,
        webchatForceNewChat,
      });
      if (hasPaperComposeState) {
        deps.consumePaperModeState(item.id);
        deps.retainPaperState(item.id);
        deps.updatePaperPreviewPreservingScroll();
      }
      const win = deps.body.ownerDocument?.defaultView;
      if (win) {
        win.setTimeout(() => {
          deps.refreshGlobalHistoryHeader();
        }, 120);
      }
      await sendTask;
      if (isWebChat && webchatSendPdf) {
        deps.markWebChatPdfUploadedForCurrentConversation?.();
      }
      deps.refreshGlobalHistoryHeader();
    } finally {
      deps.autoUnlockGlobalChat();
    }
  };

  return { doSend };
}
