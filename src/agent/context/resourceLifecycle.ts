import type { AgentModelMessage, AgentRuntimeRequest } from "../types";
import type { PaperContextRef } from "../../shared/types";
import {
  buildPaperQuoteCitationGuidance,
  formatPaperCitationLabel,
  formatPaperSourceLabel,
} from "../../modules/contextPanel/paperAttribution";
import {
  resolveContextCachePreference,
  resolvePromptCacheCapability,
  type ContextCachePlan,
} from "../../contextCache/manager";
import {
  buildAgentEvidenceContextBlock,
  clearAgentEvidenceCache,
  commitAgentCacheEvidenceActivities,
  hydrateAgentEvidenceCache,
  planAgentContextCache,
  type AgentCacheEvidenceActivity,
} from "./cacheManagement";

export { hydrateAgentEvidenceCache };

export type AgentResourceLifecycleState =
  | "setup-required"
  | "resources-changed"
  | "resources-delta"
  | "thin-followup";

export type AgentContextInjection = "full" | "delta" | "thin";

export type AgentResourceGroup =
  | "selectedPapers"
  | "fullTextPapers"
  | "collections"
  | "selectedTexts"
  | "screenshots"
  | "attachments";

export type AgentResourceRecord = {
  group: AgentResourceGroup;
  key: string;
  signature: string;
  line: string;
};

export type AgentResourceSnapshot = {
  baseScope: Record<string, unknown>;
  resources: Record<AgentResourceGroup, AgentResourceRecord[]>;
};

export type AgentResourceDelta = {
  added: AgentResourceRecord[];
  removed: AgentResourceRecord[];
  changed: AgentResourceRecord[];
  unchanged: number;
};

export type AgentResourceDeltaCounts = {
  added: number;
  removed: number;
  changed: number;
};

export type AgentResourceContextPlan = {
  conversationKey: number;
  lifecycleState: AgentResourceLifecycleState;
  injection: AgentContextInjection;
  contextCache?: ContextCachePlan;
  resourceSignature: string;
  stableContextBlock: string;
  resourceSnapshot: AgentResourceSnapshot;
  resourceDelta?: AgentResourceDelta;
  resourceDeltaCounts?: AgentResourceDeltaCounts;
  priorReadBlock?: string;
};

export type AgentResourceLifecycleEntry = {
  resourceSignature: string;
  resourceSnapshot: AgentResourceSnapshot;
  lastCompletedAt: number;
};

export type AgentPendingReadActivity = AgentCacheEvidenceActivity;

const RESOURCE_DELTA_MAX_LINES = 12;
const DELTA_ELIGIBLE_GROUPS = new Set<AgentResourceGroup>([
  "selectedPapers",
  "collections",
]);

const resourceLifecycleState = new Map<string, AgentResourceLifecycleEntry>();

function normalizeText(value: unknown, maxLength = 160): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function lifecycleKey(conversationKey: number): string {
  return `${normalizePositiveInt(conversationKey) || 0}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stabilizeForJson(value));
}

function stabilizeForJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stabilizeForJson);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const child = record[key];
    if (child === undefined) continue;
    out[key] = stabilizeForJson(child);
  }
  return out;
}

function hashText(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function sortResourceRecords<T extends AgentResourceRecord>(records: T[]): T[] {
  return [...records].sort((a, b) => {
    const groupCompare = a.group.localeCompare(b.group);
    if (groupCompare) return groupCompare;
    const keyCompare = a.key.localeCompare(b.key);
    if (keyCompare) return keyCompare;
    return a.signature.localeCompare(b.signature);
  });
}

function paperKey(entry: PaperContextRef): string {
  return `${normalizePositiveInt(entry.itemId) || 0}:${
    normalizePositiveInt(entry.contextItemId) || 0
  }`;
}

function formatPaperResourceLine(
  label: string,
  entry: PaperContextRef,
): string {
  const metadata = [
    `itemId=${entry.itemId}`,
    `contextItemId=${entry.contextItemId}`,
    `citationLabel=${formatPaperCitationLabel(entry)}`,
    `sourceLabel=${formatPaperSourceLabel(entry)}`,
    entry.citationKey ? `citationKey=${entry.citationKey}` : "",
    entry.mineruCacheDir ? `mineruCacheDir=${entry.mineruCacheDir}` : "",
  ].filter(Boolean);
  return `- ${label}: ${entry.title} [${metadata.join(", ")}]`;
}

function buildPaperResourceRecords(params: {
  group: "selectedPapers" | "fullTextPapers";
  label: string;
  papers?: PaperContextRef[];
}): AgentResourceRecord[] {
  return sortResourceRecords(
    (params.papers || [])
      .filter((entry) =>
        Boolean(
          normalizePositiveInt(entry.itemId) ||
          normalizePositiveInt(entry.contextItemId),
        ),
      )
      .map((entry) => ({
        group: params.group,
        key: paperKey(entry),
        signature: stableJson({
          itemId: normalizePositiveInt(entry.itemId) || 0,
          contextItemId: normalizePositiveInt(entry.contextItemId) || 0,
          title: normalizeText(entry.title, 240),
          attachmentTitle: normalizeText(entry.attachmentTitle, 240),
          citationKey: normalizeText(entry.citationKey, 120),
          firstCreator: normalizeText(entry.firstCreator, 120),
          year: normalizeText(entry.year, 40),
          mineruCacheDir: normalizeText(entry.mineruCacheDir, 1024),
        }),
        line: formatPaperResourceLine(params.label, entry),
      })),
  );
}

function buildCollectionResourceRecords(
  request: AgentRuntimeRequest,
): AgentResourceRecord[] {
  return sortResourceRecords(
    (request.selectedCollectionContexts || [])
      .filter((entry) => normalizePositiveInt(entry.collectionId))
      .map((entry) => ({
        group: "collections" as const,
        key: `${normalizePositiveInt(entry.libraryID) || 0}:${
          normalizePositiveInt(entry.collectionId) || 0
        }`,
        signature: stableJson({
          collectionId: normalizePositiveInt(entry.collectionId) || 0,
          libraryID: normalizePositiveInt(entry.libraryID) || 0,
          name: normalizeText(entry.name, 240),
        }),
        line: `- Collection: ${entry.name} [collectionId=${entry.collectionId}, libraryID=${entry.libraryID}]`,
      })),
  );
}

function buildSelectedTextResourceRecords(
  request: AgentRuntimeRequest,
): AgentResourceRecord[] {
  const selectedTexts = Array.isArray(request.selectedTexts)
    ? request.selectedTexts
    : [];
  return sortResourceRecords(
    selectedTexts.map((text, index) => {
      const source = request.selectedTextSources?.[index] || "unknown";
      const paper = request.selectedTextPaperContexts?.[index];
      const textHash = hashText(text || "");
      const paperPart = paper ? `, paper=${paper.title}` : "";
      return {
        group: "selectedTexts" as const,
        key: `${index}:${source}:${paper ? paperKey(paper) : ""}`,
        signature: stableJson({
          source,
          textHash,
          textLength: text.length,
          paper: paper
            ? {
                itemId: paper.itemId,
                contextItemId: paper.contextItemId,
                title: normalizeText(paper.title, 240),
              }
            : undefined,
        }),
        line: `- Selected text ${index + 1}: source=${source}, chars=${
          text.length
        }, contentHash=${textHash}${paperPart}`,
      };
    }),
  );
}

function buildScreenshotResourceRecords(
  request: AgentRuntimeRequest,
): AgentResourceRecord[] {
  const screenshots = Array.isArray(request.screenshots)
    ? request.screenshots.filter((entry): entry is string => Boolean(entry))
    : [];
  return sortResourceRecords(
    screenshots.map((url, index) => {
      const contentHash = hashText(url);
      return {
        group: "screenshots" as const,
        key: `${index}:${contentHash}`,
        signature: stableJson({
          index,
          contentHash,
        }),
        line: `- Screenshot ${index + 1} [contentHash=${contentHash}]`,
      };
    }),
  );
}

function buildAttachmentResourceRecords(
  request: AgentRuntimeRequest,
): AgentResourceRecord[] {
  const attachments = Array.isArray(request.attachments)
    ? request.attachments
    : [];
  return sortResourceRecords(
    attachments.map((attachment, index) => {
      const key =
        normalizeText(attachment.id, 160) ||
        normalizeText(attachment.contentHash, 160) ||
        `${index}:${normalizeText(attachment.name, 200)}`;
      const contentHash =
        normalizeText(attachment.contentHash, 160) ||
        hashText(
          stableJson({
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            storedPath: attachment.storedPath,
          }),
        );
      const metadata = [
        `id=${attachment.id}`,
        `category=${attachment.category}`,
        attachment.mimeType ? `mimeType=${attachment.mimeType}` : "",
        Number.isFinite(attachment.sizeBytes)
          ? `sizeBytes=${attachment.sizeBytes}`
          : "",
        contentHash ? `contentHash=${contentHash}` : "",
      ].filter(Boolean);
      return {
        group: "attachments" as const,
        key,
        signature: stableJson({
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          category: attachment.category,
          storedPath: attachment.storedPath,
          contentHash,
        }),
        line: `- Attachment: ${attachment.name} [${metadata.join(", ")}]`,
      };
    }),
  );
}

function buildAgentBaseScopeSnapshot(
  request: AgentRuntimeRequest,
): Record<string, unknown> {
  const activeNote = request.activeNoteContext;
  const metadata = normalizeRecord(request.metadata);
  return {
    conversationKey: normalizePositiveInt(request.conversationKey) || 0,
    libraryID: normalizePositiveInt(request.libraryID) || 0,
    activeItemId: normalizePositiveInt(request.activeItemId) || 0,
    activeNoteId: normalizePositiveInt(activeNote?.noteId) || 0,
    activeNoteKind: normalizeText(activeNote?.noteKind, 40),
    activeNoteParentItemId: normalizePositiveInt(activeNote?.parentItemId) || 0,
    activeNoteTitle: normalizeText(activeNote?.title, 240),
    activeNoteTextHash: activeNote ? hashText(activeNote.noteText || "") : "",
    activeNoteHtmlHash: activeNote?.noteHtml
      ? hashText(activeNote.noteHtml)
      : "",
    scopeType: normalizeText(metadata.scopeType, 80),
    scopeId: normalizeText(metadata.scopeId, 160),
    scopeLabel: normalizeText(metadata.scopeLabel, 240),
  };
}

export function buildAgentResourceSnapshot(
  request: AgentRuntimeRequest,
): AgentResourceSnapshot {
  return {
    baseScope: buildAgentBaseScopeSnapshot(request),
    resources: {
      selectedPapers: buildPaperResourceRecords({
        group: "selectedPapers",
        label: "Selected paper",
        papers: request.selectedPaperContexts,
      }),
      fullTextPapers: buildPaperResourceRecords({
        group: "fullTextPapers",
        label: "Full-text paper",
        papers: request.fullTextPaperContexts,
      }),
      collections: buildCollectionResourceRecords(request),
      selectedTexts: buildSelectedTextResourceRecords(request),
      screenshots: buildScreenshotResourceRecords(request),
      attachments: buildAttachmentResourceRecords(request),
    },
  };
}

export function buildAgentResourceSignatureFromSnapshot(
  snapshot: AgentResourceSnapshot,
): string {
  return stableJson(snapshot);
}

function flattenAgentResourceSnapshot(
  snapshot: AgentResourceSnapshot,
): AgentResourceRecord[] {
  const records: AgentResourceRecord[] = [];
  for (const group of Object.keys(snapshot.resources) as AgentResourceGroup[]) {
    for (const record of snapshot.resources[group]) {
      records.push({
        ...record,
        key: `${group}:${record.key}`,
      });
    }
  }
  return sortResourceRecords(records);
}

export function diffAgentResourceSnapshots(params: {
  previous: AgentResourceSnapshot;
  current: AgentResourceSnapshot;
}): AgentResourceDelta {
  const previousRecords = new Map(
    flattenAgentResourceSnapshot(params.previous).map((record) => [
      record.key,
      record,
    ]),
  );
  const currentRecords = new Map(
    flattenAgentResourceSnapshot(params.current).map((record) => [
      record.key,
      record,
    ]),
  );
  const added: AgentResourceRecord[] = [];
  const removed: AgentResourceRecord[] = [];
  const changed: AgentResourceRecord[] = [];
  let unchanged = 0;
  for (const [key, current] of currentRecords) {
    const previous = previousRecords.get(key);
    if (!previous) {
      added.push(current);
    } else if (previous.signature !== current.signature) {
      changed.push(current);
    } else {
      unchanged += 1;
    }
  }
  for (const [key, previous] of previousRecords) {
    if (!currentRecords.has(key)) removed.push(previous);
  }
  return {
    added: sortResourceRecords(added),
    removed: sortResourceRecords(removed),
    changed: sortResourceRecords(changed),
    unchanged,
  };
}

function getAgentResourceDeltaCounts(
  delta: AgentResourceDelta | undefined,
): AgentResourceDeltaCounts | undefined {
  if (!delta) return undefined;
  return {
    added: delta.added.length,
    removed: delta.removed.length,
    changed: delta.changed.length,
  };
}

function isDeltaEligible(delta: AgentResourceDelta): boolean {
  const changedRecords = [...delta.added, ...delta.removed, ...delta.changed];
  return changedRecords.every((record) =>
    DELTA_ELIGIBLE_GROUPS.has(record.group),
  );
}

export function resolveAgentResourceLifecycleState(params: {
  lifecycleEntry?: AgentResourceLifecycleEntry;
  resourceSignature: string;
  resourceSnapshot: AgentResourceSnapshot;
  forcedSkillIds?: string[];
}): AgentResourceLifecycleState {
  if (Array.isArray(params.forcedSkillIds) && params.forcedSkillIds.length) {
    return "resources-changed";
  }
  if (!params.lifecycleEntry) return "setup-required";
  if (params.lifecycleEntry.resourceSignature === params.resourceSignature) {
    return "thin-followup";
  }
  if (
    stableJson(params.lifecycleEntry.resourceSnapshot.baseScope) !==
    stableJson(params.resourceSnapshot.baseScope)
  ) {
    return "resources-changed";
  }
  const delta = diffAgentResourceSnapshots({
    previous: params.lifecycleEntry.resourceSnapshot,
    current: params.resourceSnapshot,
  });
  return isDeltaEligible(delta) ? "resources-delta" : "resources-changed";
}

function requestHasContentfulResource(params: {
  request: AgentRuntimeRequest;
  lifecycleState: AgentResourceLifecycleState;
}): boolean {
  const { request, lifecycleState } = params;
  const capability = resolvePromptCacheCapability({
    model: request.model || "",
    apiBase: request.apiBase,
    authMode: request.authMode,
    protocol: request.providerProtocol,
  });
  const fullTextOnlyFollowup =
    lifecycleState === "thin-followup" &&
    resolveContextCachePreference() !== "off" &&
    capability.stablePrefix &&
    capability.kind !== "none" &&
    Boolean(request.fullTextPaperContexts?.length) &&
    !request.activeNoteContext &&
    !request.selectedTexts?.length &&
    !request.screenshots?.length &&
    !request.attachments?.length;
  if (fullTextOnlyFollowup) return false;
  return Boolean(
    request.activeNoteContext ||
    request.selectedTexts?.length ||
    request.fullTextPaperContexts?.length ||
    request.screenshots?.length ||
    request.attachments?.length,
  );
}

export function resolveAgentContextInjection(params: {
  request: AgentRuntimeRequest;
  lifecycleState: AgentResourceLifecycleState;
}): AgentContextInjection {
  if (requestHasContentfulResource(params)) return "full";
  if (params.lifecycleState === "thin-followup") return "thin";
  if (params.lifecycleState === "resources-delta") return "delta";
  return "full";
}

export function buildAgentResourceContextPlan(
  request: AgentRuntimeRequest,
): AgentResourceContextPlan {
  const conversationKey = normalizePositiveInt(request.conversationKey) || 0;
  const snapshot = buildAgentResourceSnapshot(request);
  const signature = buildAgentResourceSignatureFromSnapshot(snapshot);
  const entry = resourceLifecycleState.get(lifecycleKey(conversationKey));
  const lifecycleState = resolveAgentResourceLifecycleState({
    lifecycleEntry: entry,
    resourceSignature: signature,
    resourceSnapshot: snapshot,
    forcedSkillIds: request.forcedSkillIds,
  });
  const delta =
    entry && lifecycleState === "resources-delta"
      ? diffAgentResourceSnapshots({
          previous: entry.resourceSnapshot,
          current: snapshot,
        })
      : undefined;
  const priorReadBlock = buildAgentEvidenceContextBlock({
    conversationKey,
    request,
    resourceSignature: signature,
  });
  const stableContextBlock = buildAgentStableResourceContextBlock(request);
  const contextCache = planAgentContextCache({
    request,
    stableContextText: stableContextBlock,
  });
  return {
    conversationKey,
    lifecycleState,
    injection: resolveAgentContextInjection({ request, lifecycleState }),
    contextCache,
    resourceSignature: signature,
    stableContextBlock,
    resourceSnapshot: snapshot,
    resourceDelta: delta,
    resourceDeltaCounts: getAgentResourceDeltaCounts(delta),
    priorReadBlock,
  };
}

export function commitAgentResourceContextPlan(
  plan: AgentResourceContextPlan,
): void {
  if (!plan.conversationKey) return;
  resourceLifecycleState.set(lifecycleKey(plan.conversationKey), {
    resourceSignature: plan.resourceSignature,
    resourceSnapshot: plan.resourceSnapshot,
    lastCompletedAt: Date.now(),
  });
}

export function clearAgentResourceLifecycleState(): void {
  resourceLifecycleState.clear();
}

function buildScopeIdentityLines(request: AgentRuntimeRequest): string[] {
  const lines = [
    "Current Zotero context summary:",
    `- Conversation key: ${request.conversationKey}`,
  ];
  if (request.activeItemId) {
    lines.push(`- Active item ID: ${request.activeItemId}`);
  }
  const note = request.activeNoteContext;
  if (note) {
    lines.push(
      `- Active note: ${note.title} [noteId=${note.noteId}, kind=${note.noteKind}]`,
    );
    if (note.parentItemId) {
      lines.push(`- Active note parent item ID: ${note.parentItemId}`);
    }
  }
  return lines;
}

export function buildAgentStableResourceContextBlock(
  request: AgentRuntimeRequest,
): string {
  const fullTextPaperKeySet = new Set(
    (request.fullTextPaperContexts || []).map((entry) => paperKey(entry)),
  );
  const retrievalOnlyPapers = (request.selectedPaperContexts || []).filter(
    (entry) => !fullTextPaperKeySet.has(paperKey(entry)),
  );
  const citationPaperRefs = [
    ...(request.selectedTextPaperContexts || []).filter(
      (entry): entry is PaperContextRef => Boolean(entry),
    ),
    ...retrievalOnlyPapers,
    ...(request.fullTextPaperContexts || []),
  ];
  const lines = [
    "Stable Zotero resource context:",
    ...buildScopeIdentityLines(request),
  ];

  if (citationPaperRefs.length) {
    lines.push(
      "Citation/source label rule: for direct quotes and substantive paper-grounded claims, use the exact sourceLabel shown for the relevant paper.",
    );
  }
  if (retrievalOnlyPapers.length) {
    lines.push(
      "Retrieval-only paper refs:",
      ...retrievalOnlyPapers.map((entry) =>
        formatPaperResourceLine("Retrieval paper", entry),
      ),
    );
  }
  if (request.fullTextPaperContexts?.length) {
    lines.push(
      "Full-text paper refs for this turn:",
      ...request.fullTextPaperContexts.map((entry) =>
        formatPaperResourceLine("Full-text paper", entry),
      ),
      ...request.fullTextPaperContexts
        .flatMap((entry) => buildPaperQuoteCitationGuidance(entry))
        .filter(Boolean),
    );
  }
  if (request.selectedCollectionContexts?.length) {
    lines.push(
      "Selected Zotero collection scopes:",
      ...request.selectedCollectionContexts.map(
        (entry, index) =>
          `- Collection ${index + 1}: ${entry.name} [collectionId=${entry.collectionId}, libraryID=${entry.libraryID}]`,
      ),
      "Treat these collections as scoped candidate sets. Use library_search({ entity:'items', mode:'list', filters:{ collectionId:<collectionId> } }) or collection-scoped actions when the user asks to inspect or operate on them. Do not assume all full text has already been read.",
      "If the user explicitly asks to read or analyze the full text of every paper in a collection, plan a batch workflow: enumerate papers, read/process them in bounded batches, create compact per-paper digests with evidence, then synthesize.",
    );
  }

  const resourceRecords = [
    ...buildAttachmentResourceRecords(request),
    ...buildScreenshotResourceRecords(request),
  ];
  if (resourceRecords.length) {
    lines.push(
      "Current attached visual/file resources:",
      ...resourceRecords.map((record) => record.line),
    );
  }

  return lines.filter(Boolean).join("\n");
}

function appendBoundedDeltaSection(params: {
  lines: string[];
  title: string;
  records: AgentResourceRecord[];
  remainingLines: number;
}): number {
  if (!params.records.length || params.remainingLines <= 0) {
    return params.remainingLines;
  }
  params.lines.push(params.title);
  const visible = params.records.slice(0, params.remainingLines);
  params.lines.push(...visible.map((record) => record.line));
  const hidden = params.records.length - visible.length;
  if (hidden > 0) params.lines.push(`- ${hidden} more not listed`);
  return params.remainingLines - visible.length;
}

function buildAgentResourceDeltaBlock(delta: AgentResourceDelta): string {
  const counts = getAgentResourceDeltaCounts(delta);
  if (!counts) return "";
  const lines = [
    "Zotero resource update for this continued agent turn:",
    `Summary: added=${counts.added}, removed=${counts.removed}, changed=${counts.changed}, stillAvailable=${delta.unchanged}`,
    "Only inspect added or changed resources when the user request needs evidence, exact quotes/pages/figures, comparisons, or Zotero note/library changes.",
    "This is a resource inventory update, not a request to eagerly read every resource.",
  ];
  let remainingLines = RESOURCE_DELTA_MAX_LINES;
  remainingLines = appendBoundedDeltaSection({
    lines,
    title: "Added resources:",
    records: delta.added,
    remainingLines,
  });
  remainingLines = appendBoundedDeltaSection({
    lines,
    title: "Changed resources:",
    records: delta.changed,
    remainingLines,
  });
  appendBoundedDeltaSection({
    lines,
    title: "Removed resources:",
    records: delta.removed,
    remainingLines,
  });
  return lines.join("\n");
}

export function renderAgentResourceContextPlan(
  plan: AgentResourceContextPlan,
  request: AgentRuntimeRequest,
  options: { memoryBlock?: string; turnGuidanceBlock?: string } = {},
): AgentModelMessage {
  const lines: string[] = [];
  if (plan.priorReadBlock) lines.push(plan.priorReadBlock);
  if (options.memoryBlock) lines.push(options.memoryBlock);
  if (options.turnGuidanceBlock) lines.push(options.turnGuidanceBlock);
  if (plan.injection === "thin") {
    lines.push(
      "This is a continued agent turn with the same Zotero resources as the previous completed agent turn.",
      "Do not assume unread paper text is already known. Use tools only when this user request needs fresh evidence, exact quotes/pages/figures, comparisons, or Zotero note/library changes.",
    );
  } else if (plan.injection === "delta" && plan.resourceDelta) {
    lines.push(buildAgentResourceDeltaBlock(plan.resourceDelta));
  }
  const contextText = lines.filter(Boolean).join("\n");
  return {
    role: "user",
    content: `${contextText ? `${contextText}\n\n` : ""}User request:\n${
      request.userText
    }`,
  };
}

export function commitAgentReadActivities(params: {
  conversationKey: number;
  activities: AgentPendingReadActivity[];
  resourceSignature?: string;
}): Promise<void> {
  return commitAgentCacheEvidenceActivities(params);
}

export function clearAgentReadLedger(): void {
  clearAgentEvidenceCache();
}

export function buildAgentPriorReadContextBlock(params: {
  conversationKey: number;
  request?: AgentRuntimeRequest;
  resourceSignature?: string;
}): string {
  return buildAgentEvidenceContextBlock(params);
}
