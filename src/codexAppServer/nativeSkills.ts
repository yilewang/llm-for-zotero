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
import { RAW_PDF_TRANSPORT_POLICY_BLOCK } from "../agent/context/rawPdfTransportPolicy";

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
  resolutionSource?: "none" | "explicit" | "semantic";
};

type ResolveNativeSkillsParams = {
  scope: CodexNativeSkillScope;
  userText: string;
  model: string;
  apiBase?: string;
  signal?: AbortSignal;
  skillContext?: CodexNativeSkillContext;
  classifiedIntent?: AgentRuntimeRequest["classifiedIntent"];
  skillRoutingReceipt?: AgentRuntimeRequest["skillRoutingReceipt"];
};

export function resolveExplicitCodexNativeSkillIds(
  forcedSkillIds: ReadonlyArray<string>,
): string[] {
  const knownSkillIds = new Set(getAllSkills().map((skill) => skill.id));
  return Array.from(
    new Set(forcedSkillIds.filter((skillId) => knownSkillIds.has(skillId))),
  );
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
  params: Omit<ResolveNativeSkillsParams, "signal">,
): AgentRuntimeRequest {
  const { scope, skillContext } = params;
  const scopePapers = buildScopePaperContexts(scope);
  const rawRequest: AgentRuntimeRequestInput = {
    conversationKey: scope.conversationKey,
    mode: "agent",
    userText: params.userText,
    classifiedIntent: params.classifiedIntent,
    skillRoutingReceipt: params.skillRoutingReceipt,
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
  const semanticIds = request.classifiedIntent?.semantic
    ? request.skillRoutingReceipt?.skills.map((entry) => entry.id) || []
    : [];
  const matchedSkillIds = getMatchedSkillIds(request, semanticIds);
  return {
    request,
    matchedSkillIds,
    instructionBlock: buildCodexNativeSkillInstructionBlock(
      matchedSkillIds,
      allSkills,
      { rawPdfMode },
    ),
    resolutionSource: request.classifiedIntent?.semantic
      ? "semantic"
      : matchedSkillIds.length
        ? "explicit"
        : "none",
  };
}
