import type {
  ChatAttachment,
  CollectionContextRef,
  PaperContextRef,
  SelectedTextSource,
} from "../shared/types";
import type { AgentRuntimeRequest } from "../agent/types";
import type { AgentSkill } from "../agent/skills";
import { getAllSkills, getMatchedSkillIds, matchesSkill } from "../agent/skills";
import { detectSkillIntent } from "../agent/model/skillClassifier";
import {
  getCodexNativeSkillRoutingModePref,
  type CodexNativeSkillRoutingMode,
} from "./prefs";

const WRITE_NOTE_SKILL_ID = "write-note";
const CLASSIFIER_CACHE_MAX_ENTRIES = 200;

const classifierCache = new Map<string, string[]>();

const NOTE_OBJECT_PATTERN =
  /\bnotes?\b|\bnota(?:s)?\b|\bnotiz(?:en)?\b|\bnote\b|\bnotes\b|\bnota\b|\bnotas\b|笔记|便签|札记|ノート|メモ|노트|메모|заметк\p{L}*|ملاحظة/iu;
const NOTE_ACTION_PATTERN =
  /\bsave\b|\bwrite\b|\bcreate\b|\bmake\b|\bedit\b|\bupdate\b|\brevise\b|\bpolish\b|\bappend\b|\binsert\b|\badd\b|\bguardar\b|\bescribir\b|\bcrear\b|\beditar\b|\bactualizar\b|\bmodificar\b|\bañadir\b|\bajouter\b|\benregistrer\b|\bécrire\b|\becrire\b|\bcréer\b|\bcreer\b|\bmodifier\b|\bspeichern\b|\bschreiben\b|\berstellen\b|\bbearbeiten\b|\baktualisieren\b|\bhinzuf\p{L}*\b|\bsalvar\b|\bescrever\b|\bcriar\b|\beditar\b|\batualizar\b|\bsalva\p{L}*\b|\bscrivere\b|\bcreare\b|\bmodificare\b|\baggiornare\b|保存|写|撰写|创建|新建|编辑|修改|更新|润色|加入|添加|追加|書|作成|編集|更新|保存|追加|저장|작성|생성|편집|수정|업데이트|추가/iu;
const NOTE_EXPLICIT_PATTERN =
  /\bsave\s+(?:it|this|that|them)?\s*(?:as|to)?\s*(?:my\s+)?notes?\b|\b(?:write|create|make|edit|update|append)\s+(?:a\s+|my\s+)?notes?\b|保存.*笔记|笔记.*保存|ノート.*保存|メモ.*保存|노트.*저장|메모.*저장/iu;
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
  selectedTexts?: string[];
  selectedTextSources?: SelectedTextSource[];
  selectedTextPaperContexts?: (PaperContextRef | undefined)[];
  selectedPaperContexts?: PaperContextRef[];
  fullTextPaperContexts?: PaperContextRef[];
  pinnedPaperContexts?: PaperContextRef[];
  selectedCollectionContexts?: CollectionContextRef[];
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

function normalizeTextForSignature(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 2000);
}

function hasNonAsciiText(value: string): boolean {
  return /[^\x00-\x7F]/.test(value);
}

function uniqueInSkillOrder(
  ids: ReadonlySet<string>,
  allSkills: ReadonlyArray<AgentSkill>,
): string[] {
  return allSkills.filter((skill) => ids.has(skill.id)).map((skill) => skill.id);
}

function requestHasNoteSelection(request: AgentRuntimeRequest): boolean {
  return Boolean(
    request.selectedTextSources?.some(
      (source) => source === "note" || source === "note-edit",
    ),
  );
}

export function inferCodexNativeNoteIntent(
  request: Pick<
    AgentRuntimeRequest,
    "userText" | "activeNoteContext" | "selectedTextSources" | "selectedTexts"
  >,
): boolean {
  const text = normalizeTextForSignature(request.userText || "");
  if (!text) return false;
  const hasNoteObject = NOTE_OBJECT_PATTERN.test(text);
  const hasNoteAction = NOTE_ACTION_PATTERN.test(text);
  if (NOTE_EXPLICIT_PATTERN.test(text)) return true;
  if (hasNoteObject && hasNoteAction) return true;

  const hasNoteContext = Boolean(request.activeNoteContext);
  const hasNoteSelection = Boolean(
    request.selectedTextSources?.some(
      (source) => source === "note" || source === "note-edit",
    ),
  );
  if (!hasNoteContext && !hasNoteSelection) return false;

  if (hasNoteAction) return true;
  if (hasNoteObject && text.length <= 240) return true;
  return Boolean(request.selectedTexts?.length && text.length <= 160);
}

export function resolveDeterministicCodexNativeSkillIds(params: {
  request: AgentRuntimeRequest;
  allSkills?: ReadonlyArray<AgentSkill>;
}): string[] {
  const allSkills = params.allSkills || getAllSkills();
  if (!allSkills.length) return [];
  const matched = new Set(getMatchedSkillIds(params.request));
  for (const skill of allSkills) {
    if (matchesSkill(skill, params.request)) matched.add(skill.id);
  }
  if (
    inferCodexNativeNoteIntent(params.request) &&
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
      request.selectedPaperContexts?.length ||
      request.fullTextPaperContexts?.length ||
      request.pinnedPaperContexts?.length ||
      request.selectedCollectionContexts?.length ||
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
  if (mode === "classifier") return Boolean((params.request.userText || "").trim());
  return isAmbiguousSkillCandidate(params.request);
}

function buildSkillVersionSignature(allSkills: ReadonlyArray<AgentSkill>): string {
  return allSkills
    .map((skill) =>
      [
        skill.id,
        skill.version,
        skill.source,
        normalizeTextForSignature(skill.description || ""),
        skill.patterns.map((pattern) => `${pattern.source}/${pattern.flags}`).join("|"),
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
      selectedPaperCount: request.selectedPaperContexts?.length || 0,
      fullTextPaperCount: request.fullTextPaperContexts?.length || 0,
      pinnedPaperCount: request.pinnedPaperContexts?.length || 0,
      collectionCount: request.selectedCollectionContexts?.length || 0,
      screenshotCount: request.screenshots?.length || 0,
      attachmentTypes: Array.from(
        new Set((request.attachments || []).map((attachment) => attachment.category)),
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

function normalizeList<T>(value: T[] | undefined): T[] | undefined {
  return Array.isArray(value) && value.length ? value : undefined;
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
  return {
    conversationKey: scope.conversationKey,
    mode: "agent",
    userText: params.userText,
    activeItemId: scope.activeItemId || scope.paperItemID,
    libraryID: scope.libraryID,
    selectedTexts: normalizeList(skillContext?.selectedTexts),
    selectedTextSources: normalizeList(skillContext?.selectedTextSources),
    selectedTextPaperContexts: normalizeList(
      skillContext?.selectedTextPaperContexts,
    ),
    selectedPaperContexts:
      normalizeList(skillContext?.selectedPaperContexts) || scopePapers,
    fullTextPaperContexts: normalizeList(skillContext?.fullTextPaperContexts),
    pinnedPaperContexts: normalizeList(skillContext?.pinnedPaperContexts),
    selectedCollectionContexts: normalizeList(
      skillContext?.selectedCollectionContexts,
    ),
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
}

export function buildCodexNativeSkillInstructionBlock(
  matchedSkillIds: ReadonlyArray<string>,
  allSkills: ReadonlyArray<AgentSkill> = getAllSkills(),
): string {
  if (!matchedSkillIds.length) return "";
  const activeIds = new Set(matchedSkillIds);
  const matchedSkills = allSkills.filter((skill) => activeIds.has(skill.id));
  if (!matchedSkills.length) return "";
  return [
    "LLM-for-Zotero skills active for this turn:",
    "The following skill instructions are provided because the user's message matches these workflows. Use them as workflow guidance for Zotero MCP tools; do not treat skills as additional MCP tools.",
    ...matchedSkills.map((skill) =>
      [`Skill: ${skill.id}`, skill.instruction.trim()]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n\n");
}

export async function resolveCodexNativeSkills(
  params: ResolveNativeSkillsParams,
): Promise<CodexNativeResolvedSkills> {
  const request = buildCodexNativeSkillRequest(params);
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
      ),
      resolutionSource: "cache",
    };
  }

  const classify = params.detectSkillIntentImpl || detectSkillIntent;
  const classifiedSkillIds = await classify(request, [...allSkills], params.signal);
  const matchedSkillIds = getMatchedSkillIds(request, classifiedSkillIds);
  setClassifierCache(cacheKey, matchedSkillIds);
  return {
    request,
    matchedSkillIds,
    instructionBlock: buildCodexNativeSkillInstructionBlock(
      matchedSkillIds,
      allSkills,
    ),
    resolutionSource: "classifier",
  };
}
