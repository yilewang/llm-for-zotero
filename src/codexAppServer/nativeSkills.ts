import type {
  ChatAttachment,
  CollectionContextRef,
  NoteContextRef,
  PaperContextRef,
  ResolvedSelectedTextAnchor,
  SelectedTextContext,
  SelectedTextSource,
  TagContextRef,
} from "../shared/types";
import type {
  AgentRuntimeRequest,
  AgentRuntimeRequestInput,
} from "../agent/types";
import { resolveAgentRuntimeRequest } from "../agent/context/resolvedAgentRequest";
import type { AgentSkill } from "../agent/skills";
import { getAllSkills, getMatchedSkillIds } from "../agent/skills";
import { getSkillCustomizationNotice } from "../agent/skills/managedBlock";
import {
  inferNoteIntent,
  normalizeIntentText,
  WRITE_NOTE_SKILL_ID,
} from "../agent/skills/noteIntent";
import { detectSkillIntent } from "../agent/model/skillClassifier";
import { RAW_PDF_TRANSPORT_POLICY_BLOCK } from "../agent/context/rawPdfTransportPolicy";
import {
  getCodexNativeSkillRoutingModePref,
  type CodexNativeSkillRoutingMode,
} from "./prefs";

const CLASSIFIER_CACHE_MAX_ENTRIES = 200;

const classifierCache = new Map<string, string[]>();

const SKILL_CANDIDATE_PATTERN =
  /\bnote\b|\bnotes\b|\bcompare\b|\banaly[sz]e\b|\bfigure\b|\bliterature\b|\breview\b|\bcitation\b|\breference\b|\bimport\b|\bdraft\b|\bsummarize\b|\bsynthesi[sz]e\b|笔记|比较|分析|图|综述|文献|引用|参考|导入|总结|要約|比較|分析|図|レビュー|文献|引用|요약|비교|분석|그림|문헌|인용|nota|comparar|analizar|figura|revisión|literatura|cita|note|comparer|analyser|figure|revue|littérature|citation|notiz|vergleichen|analysieren|abbildung|literatur|zitat/iu;

export type CodexNativeSkillScope = {
  profileSignature?: string;
  conversationKey: number;
  libraryID: number;
  kind: "global" | "paper";
  activeItemId?: number;
  paperItemID?: number;
  activeContextItemId?: number;
  paperTitle?: string;
  paperContext?: PaperContextRef;
  activeNoteId?: number;
  activeNoteTitle?: string;
  activeNoteKind?: "item" | "standalone";
  activeNoteParentItemId?: number;
};

export type CodexNativeSkillContext = {
  forcedSkillIds?: string[];
  selectedTextContexts?: SelectedTextContext[];
  resolvedSelectedTextAnchors?: ResolvedSelectedTextAnchor[];
  selectedTexts?: string[];
  selectedTextSources?: SelectedTextSource[];
  selectedTextPaperContexts?: (PaperContextRef | undefined)[];
  selectedTextNoteContexts?: (NoteContextRef | undefined)[];
  selectedPaperContexts?: PaperContextRef[];
  pdfPaperContexts?: PaperContextRef[];
  localDocuments?: readonly import("../shared/types").LocalDocumentResource[];
  fullTextPaperContexts?: PaperContextRef[];
  pinnedPaperContexts?: PaperContextRef[];
  selectedCollectionContexts?: CollectionContextRef[];
  selectedTagContexts?: TagContextRef[];
  screenshots?: string[];
  attachments?: ChatAttachment[];
};

export type CodexNativeResolvedSkills = {
  request: AgentRuntimeRequest;
  matchedSkillIds: string[];
  instructionBlock: string;
  resolutionSource?: "none" | "deterministic" | "classifier" | "cache";
};

type ResolveNativeSkillsParams = {
  scope: CodexNativeSkillScope;
  userText: string;
  model: string;
  apiBase?: string;
  signal?: AbortSignal;
  skillContext?: CodexNativeSkillContext;
  detectSkillIntentImpl?: typeof detectSkillIntent;
};

export function clearCodexNativeSkillClassifierCache(): void {
  classifierCache.clear();
}

export function resolveExplicitCodexNativeSkillIds(
  forcedSkillIds: ReadonlyArray<string>,
): string[] {
  const knownSkillIds = new Set(getAllSkills().map((skill) => skill.id));
  return Array.from(
    new Set(forcedSkillIds.filter((skillId) => knownSkillIds.has(skillId))),
  );
}

// One normalizer serves intent matching and the classifier cache signature —
// the two must never diverge, so nativeSkills reuses the noteIntent helper.
const normalizeTextForSignature = normalizeIntentText;

function hasNonAsciiText(value: string): boolean {
  return Array.from(value).some((char) => char.charCodeAt(0) > 0x7f);
}

function uniqueInSkillOrder(
  ids: ReadonlySet<string>,
  allSkills: ReadonlyArray<AgentSkill>,
): string[] {
  return allSkills
    .filter((skill) => ids.has(skill.id))
    .map((skill) => skill.id);
}

function requestHasNoteSelection(request: AgentRuntimeRequest): boolean {
  return Boolean(
    request.selectedTextSources?.some(
      (source) => source === "note" || source === "note-edit",
    ),
  );
}

export function resolveDeterministicCodexNativeSkillIds(params: {
  request: AgentRuntimeRequest;
  allSkills?: ReadonlyArray<AgentSkill>;
}): string[] {
  const allSkills = params.allSkills || getAllSkills();
  if (!allSkills.length) return [];
  const matched = new Set(getMatchedSkillIds(params.request));
  // getMatchedSkillIds already forces write-note on the strong text-only
  // signal (inferExplicitNoteIntent). This deliberately broader check adds
  // inferNoteIntent's weak open-note branches for the codex deterministic
  // route only: no classifier runs here, and with a note open a bare action
  // verb usually is note intent.
  if (
    inferNoteIntent(params.request) &&
    allSkills.some((skill) => skill.id === WRITE_NOTE_SKILL_ID)
  ) {
    matched.add(WRITE_NOTE_SKILL_ID);
  }
  return uniqueInSkillOrder(matched, allSkills);
}

function isAmbiguousSkillCandidate(request: AgentRuntimeRequest): boolean {
  const text = normalizeTextForSignature(request.userText || "");
  if (!text || text.length > 1200) return false;
  const hasWorkflowContext = Boolean(
    request.activeNoteContext ||
    request.selectedTexts?.length ||
    request.turnPaperScope.papers.length ||
    request.turnPaperScope.collections.length ||
    request.turnPaperScope.tags.length ||
    request.screenshots?.length ||
    request.attachments?.length,
  );
  if (!hasWorkflowContext) return false;
  if (SKILL_CANDIDATE_PATTERN.test(text)) return true;
  if (hasNonAsciiText(text)) return true;
  return requestHasNoteSelection(request);
}

export function shouldUseCodexNativeSkillClassifierFallback(params: {
  mode?: CodexNativeSkillRoutingMode;
  request: AgentRuntimeRequest;
  allSkills?: ReadonlyArray<AgentSkill>;
  deterministicSkillIds?: ReadonlyArray<string>;
}): boolean {
  const allSkills = params.allSkills || getAllSkills();
  if (!allSkills.length) return false;
  if (params.deterministicSkillIds?.length) return false;
  const mode = params.mode || getCodexNativeSkillRoutingModePref();
  if (mode === "deterministic") return false;
  if (mode === "classifier")
    return Boolean((params.request.userText || "").trim());
  return isAmbiguousSkillCandidate(params.request);
}

function buildSkillVersionSignature(
  allSkills: ReadonlyArray<AgentSkill>,
): string {
  return allSkills
    .map((skill) =>
      [
        skill.id,
        skill.version,
        skill.source,
        normalizeTextForSignature(skill.description || ""),
        skill.patterns
          .map((pattern) => `${pattern.source}/${pattern.flags}`)
          .join("|"),
      ].join(":"),
    )
    .sort()
    .join(";");
}

export function buildCodexNativeSkillClassifierCacheKey(params: {
  request: AgentRuntimeRequest;
  allSkills?: ReadonlyArray<AgentSkill>;
}): string {
  const request = params.request;
  const allSkills = params.allSkills || getAllSkills();
  return JSON.stringify({
    prompt: normalizeTextForSignature(request.userText || ""),
    context: {
      activeNote: Boolean(request.activeNoteContext),
      selectedTextSources: Array.from(
        new Set(request.selectedTextSources || []),
      ).sort(),
      selectedTextCount: request.selectedTexts?.length || 0,
      selectedPaperCount: request.turnPaperScope.papers.filter((entry) =>
        entry.roles.includes("selected"),
      ).length,
      fullTextPaperCount: request.turnPaperScope.papers.filter((entry) =>
        entry.roles.includes("full_text"),
      ).length,
      pinnedPaperCount: request.turnPaperScope.papers.filter((entry) =>
        entry.roles.includes("pinned"),
      ).length,
      collectionCount: request.turnPaperScope.collections.length,
      tagCount: request.turnPaperScope.tags.length,
      screenshotCount: request.screenshots?.length || 0,
      attachmentTypes: Array.from(
        new Set(
          (request.attachments || []).map((attachment) => attachment.category),
        ),
      ).sort(),
    },
    skills: buildSkillVersionSignature(allSkills),
  });
}

function setClassifierCache(key: string, value: string[]): void {
  classifierCache.set(key, [...value]);
  if (classifierCache.size <= CLASSIFIER_CACHE_MAX_ENTRIES) return;
  const firstKey = classifierCache.keys().next().value;
  if (firstKey) classifierCache.delete(firstKey);
}

function normalizeList<T>(value: readonly T[] | undefined): T[] | undefined {
  return Array.isArray(value) && value.length ? Array.from(value) : undefined;
}

function buildScopePaperContexts(
  scope: CodexNativeSkillScope,
): PaperContextRef[] | undefined {
  if (scope.paperContext) return [scope.paperContext];
  if (
    scope.kind !== "paper" ||
    !scope.paperItemID ||
    !scope.activeContextItemId
  ) {
    return undefined;
  }
  return [
    {
      itemId: scope.paperItemID,
      contextItemId: scope.activeContextItemId,
      title: scope.paperTitle || `Paper ${scope.paperItemID}`,
    },
  ];
}

function buildScopeActiveNoteContext(
  scope: CodexNativeSkillScope,
): AgentRuntimeRequest["activeNoteContext"] {
  if (!scope.activeNoteId) return undefined;
  return {
    noteId: scope.activeNoteId,
    title: scope.activeNoteTitle || `Note ${scope.activeNoteId}`,
    noteKind: scope.activeNoteKind || "standalone",
    parentItemId: scope.activeNoteParentItemId,
    noteText: "",
  };
}

export function buildCodexNativeSkillRequest(
  params: Omit<ResolveNativeSkillsParams, "signal" | "detectSkillIntentImpl">,
): AgentRuntimeRequest {
  const { scope, skillContext } = params;
  const scopePapers = buildScopePaperContexts(scope);
  const rawRequest: AgentRuntimeRequestInput = {
    conversationKey: scope.conversationKey,
    mode: "agent",
    userText: params.userText,
    activeItemId: scope.activeItemId || scope.paperItemID,
    libraryID: scope.libraryID,
    conversationKind: scope.kind === "paper" ? "paper" : "global",
    selectedTextContexts: normalizeList(skillContext?.selectedTextContexts),
    resolvedSelectedTextAnchors: normalizeList(
      skillContext?.resolvedSelectedTextAnchors,
    ),
    selectedTexts: normalizeList(skillContext?.selectedTexts),
    selectedTextSources: normalizeList(skillContext?.selectedTextSources),
    selectedTextPaperContexts: normalizeList(
      skillContext?.selectedTextPaperContexts,
    ),
    selectedTextNoteContexts: normalizeList(
      skillContext?.selectedTextNoteContexts,
    ),
    selectedPaperContexts:
      normalizeList(skillContext?.selectedPaperContexts) || scopePapers,
    pdfPaperContexts: normalizeList(skillContext?.pdfPaperContexts),
    localDocuments: normalizeList(skillContext?.localDocuments),
    fullTextPaperContexts: normalizeList(skillContext?.fullTextPaperContexts),
    pinnedPaperContexts: normalizeList(skillContext?.pinnedPaperContexts),
    selectedCollectionContexts: normalizeList(
      skillContext?.selectedCollectionContexts,
    ),
    selectedTagContexts: normalizeList(skillContext?.selectedTagContexts),
    attachments: normalizeList(skillContext?.attachments),
    screenshots: normalizeList(skillContext?.screenshots),
    forcedSkillIds: normalizeList(skillContext?.forcedSkillIds),
    model: params.model,
    apiBase: params.apiBase,
    authMode: "codex_app_server",
    providerProtocol: "codex_responses",
    activeNoteContext: buildScopeActiveNoteContext(scope),
    modelProviderLabel: "Codex",
  };
  return resolveAgentRuntimeRequest(rawRequest);
}

export function buildCodexNativeSkillInstructionBlock(
  matchedSkillIds: ReadonlyArray<string>,
  allSkills: ReadonlyArray<AgentSkill> = getAllSkills(),
  options: { rawPdfMode?: boolean } = {},
): string {
  if (!matchedSkillIds.length) return "";
  const activeIds = new Set(matchedSkillIds);
  const matchedSkills = allSkills.filter((skill) => activeIds.has(skill.id));
  if (!matchedSkills.length) return "";
  return [
    "LLM-for-Zotero skills active for this turn:",
    "The following skill instructions are provided because the user's message matches these workflows. Use them as workflow guidance for Zotero MCP tools; do not treat skills as additional MCP tools.",
    ...matchedSkills.map((skill) =>
      [
        `Skill: ${skill.id}`,
        getSkillCustomizationNotice(skill.instruction) || "",
        skill.instruction.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    options.rawPdfMode ? RAW_PDF_TRANSPORT_POLICY_BLOCK : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function resolveCodexNativeSkills(
  params: ResolveNativeSkillsParams,
): Promise<CodexNativeResolvedSkills> {
  const request = buildCodexNativeSkillRequest(params);
  const rawPdfMode = Boolean(params.skillContext?.localDocuments?.length);
  const allSkills = getAllSkills();
  if (!allSkills.length) {
    return {
      request,
      matchedSkillIds: [],
      instructionBlock: "",
      resolutionSource: "none",
    };
  }
  const deterministicSkillIds = resolveDeterministicCodexNativeSkillIds({
    request,
    allSkills,
  });
  if (deterministicSkillIds.length) {
    return {
      request,
      matchedSkillIds: deterministicSkillIds,
      instructionBlock: buildCodexNativeSkillInstructionBlock(
        deterministicSkillIds,
        allSkills,
        { rawPdfMode },
      ),
      resolutionSource: "deterministic",
    };
  }

  if (
    !shouldUseCodexNativeSkillClassifierFallback({
      mode: getCodexNativeSkillRoutingModePref(),
      request,
      allSkills,
      deterministicSkillIds,
    })
  ) {
    return {
      request,
      matchedSkillIds: [],
      instructionBlock: "",
      resolutionSource: "none",
    };
  }

  const cacheKey = buildCodexNativeSkillClassifierCacheKey({
    request,
    allSkills,
  });
  if (classifierCache.has(cacheKey)) {
    const cachedSkillIds = classifierCache.get(cacheKey) || [];
    return {
      request,
      matchedSkillIds: [...cachedSkillIds],
      instructionBlock: buildCodexNativeSkillInstructionBlock(
        cachedSkillIds,
        allSkills,
        { rawPdfMode },
      ),
      resolutionSource: "cache",
    };
  }

  const classify = params.detectSkillIntentImpl || detectSkillIntent;
  const classifiedSkillIds = await classify(
    request,
    [...allSkills],
    params.signal,
  );
  const matchedSkillIds = getMatchedSkillIds(request, classifiedSkillIds);
  setClassifierCache(cacheKey, matchedSkillIds);
  return {
    request,
    matchedSkillIds,
    instructionBlock: buildCodexNativeSkillInstructionBlock(
      matchedSkillIds,
      allSkills,
      { rawPdfMode },
    ),
    resolutionSource: "classifier",
  };
}
