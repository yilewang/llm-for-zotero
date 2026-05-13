import type { AgentModelMessage, AgentRuntimeRequest } from "../types";
import type { PaperContextRef } from "../../shared/types";
import {
  formatPaperCitationLabel,
  formatPaperSourceLabel,
} from "../../modules/contextPanel/paperAttribution";

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
  resourceSignature: string;
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

type AgentReadLedgerEntry = {
  key: string;
  toolName: string;
  label: string;
  targetLabel?: string;
  detail?: string;
  itemId?: number;
  contextItemId?: number;
  filePath?: string;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
};

export type AgentPendingReadActivity = {
  toolName: string;
  toolLabel?: string;
  input?: unknown;
  request: AgentRuntimeRequest;
  timestamp: number;
};

const RESOURCE_DELTA_MAX_LINES = 12;
const MAX_LEDGER_ENTRIES = 12;
const MAX_RENDERED_LEDGER_ENTRIES = 8;
const READ_TOOL_NAMES = new Set([
  "paper_read",
  "read_paper",
  "search_paper",
  "view_pdf_pages",
  "read_attachment",
]);
const DELTA_ELIGIBLE_GROUPS = new Set<AgentResourceGroup>([
  "selectedPapers",
  "collections",
]);

const resourceLifecycleState = new Map<string, AgentResourceLifecycleEntry>();
const readLedger = new Map<string, Map<string, AgentReadLedgerEntry>>();

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

function requestHasContentfulResource(request: AgentRuntimeRequest): boolean {
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
  if (requestHasContentfulResource(params.request)) return "full";
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
  return {
    conversationKey,
    lifecycleState,
    injection: resolveAgentContextInjection({ request, lifecycleState }),
    resourceSignature: signature,
    resourceSnapshot: snapshot,
    resourceDelta: delta,
    resourceDeltaCounts: getAgentResourceDeltaCounts(delta),
    priorReadBlock: buildAgentPriorReadContextBlock({ conversationKey }),
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
): AgentModelMessage {
  const lines = buildScopeIdentityLines(request);
  if (plan.priorReadBlock) lines.push(plan.priorReadBlock);
  if (plan.injection === "thin") {
    lines.push(
      "This is a continued agent turn with the same Zotero resources as the previous completed agent turn.",
      "Do not assume unread paper text is already known. Use tools only when this user request needs fresh evidence, exact quotes/pages/figures, comparisons, or Zotero note/library changes.",
    );
  } else if (plan.injection === "delta" && plan.resourceDelta) {
    lines.push(buildAgentResourceDeltaBlock(plan.resourceDelta));
  }
  return {
    role: "user",
    content: `${lines.filter(Boolean).join("\n")}\n\nUser request:\n${
      request.userText
    }`,
  };
}

function formatTargetLabel(target: {
  title?: string;
  itemId?: number;
  contextItemId?: number;
}): string {
  const parts: string[] = [];
  if (target.itemId) parts.push(`itemId=${target.itemId}`);
  if (target.contextItemId) parts.push(`contextItemId=${target.contextItemId}`);
  const title = normalizeText(target.title, 100);
  if (title) return `${title}${parts.length ? ` [${parts.join(", ")}]` : ""}`;
  if (parts.length) return parts.join(", ");
  return "";
}

function normalizePaperContext(
  value: unknown,
): Partial<PaperContextRef> | undefined {
  const record = normalizeRecord(value);
  const itemId = normalizePositiveInt(record.itemId);
  const contextItemId = normalizePositiveInt(record.contextItemId);
  const title = normalizeText(record.title, 120);
  if (!itemId && !contextItemId) return undefined;
  return {
    itemId,
    contextItemId,
    title: title || undefined,
    attachmentTitle: normalizeText(record.attachmentTitle, 120) || undefined,
    citationKey: normalizeText(record.citationKey, 80) || undefined,
    firstCreator: normalizeText(record.firstCreator, 80) || undefined,
    year: normalizeText(record.year, 32) || undefined,
    mineruCacheDir: normalizeText(record.mineruCacheDir, 512) || undefined,
  };
}

function targetFromRecord(value: unknown): {
  itemId?: number;
  contextItemId?: number;
  title?: string;
} {
  const record = normalizeRecord(value);
  const paperContext = normalizePaperContext(record.paperContext);
  return {
    itemId: normalizePositiveInt(record.itemId) || paperContext?.itemId,
    contextItemId:
      normalizePositiveInt(record.contextItemId) ||
      normalizePositiveInt(record.attachmentId) ||
      paperContext?.contextItemId,
    title:
      normalizeText(record.title, 120) ||
      normalizeText(record.name, 120) ||
      paperContext?.title,
  };
}

function collectRequestPaperContexts(
  request: AgentRuntimeRequest,
): PaperContextRef[] {
  const out: PaperContextRef[] = [];
  const seen = new Set<string>();
  const push = (entry: PaperContextRef | undefined) => {
    if (
      !entry ||
      !Number.isFinite(entry.itemId) ||
      !Number.isFinite(entry.contextItemId)
    ) {
      return;
    }
    const key = paperKey(entry);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };
  for (const entry of request.selectedTextPaperContexts || []) push(entry);
  for (const entry of request.selectedPaperContexts || []) push(entry);
  for (const entry of request.fullTextPaperContexts || []) push(entry);
  for (const entry of request.pinnedPaperContexts || []) push(entry);
  return out;
}

function defaultScopeTarget(request: AgentRuntimeRequest): {
  itemId?: number;
  contextItemId?: number;
  title?: string;
} {
  const paper = collectRequestPaperContexts(request)[0];
  return {
    itemId: paper?.itemId || request.activeItemId,
    contextItemId: paper?.contextItemId,
    title: paper?.title,
  };
}

function extractTargets(
  args: unknown,
  request: AgentRuntimeRequest,
): Array<{ itemId?: number; contextItemId?: number; title?: string }> {
  const record = normalizeRecord(args);
  const rawTargets = Array.isArray(record.targets) ? record.targets : [];
  const targets = rawTargets
    .map(targetFromRecord)
    .filter((target) =>
      Boolean(target.itemId || target.contextItemId || target.title),
    );
  const target = targetFromRecord(record.target);
  if (target.itemId || target.contextItemId || target.title) {
    targets.push(target);
  }
  if (targets.length) return targets;
  const fallback = defaultScopeTarget(request);
  return fallback.itemId || fallback.contextItemId || fallback.title
    ? [fallback]
    : [];
}

function fileNameForPath(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function normalizePathForPrefix(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/g, "");
}

function isLikelyMineruReadPath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  if (!normalized.includes("mineru")) return false;
  return (
    /\.(?:md|json)$/i.test(filePath) ||
    /\.(?:png|jpe?g|gif|webp|svg)$/i.test(filePath)
  );
}

function findMineruPaperTarget(
  filePath: string,
  request: AgentRuntimeRequest,
): { itemId?: number; contextItemId?: number; title?: string } {
  const normalizedFilePath = normalizePathForPrefix(filePath);
  for (const paper of collectRequestPaperContexts(request)) {
    const cacheDir =
      typeof paper.mineruCacheDir === "string"
        ? normalizePathForPrefix(paper.mineruCacheDir)
        : "";
    if (!cacheDir) continue;
    if (
      normalizedFilePath === cacheDir ||
      normalizedFilePath.startsWith(`${cacheDir}/`)
    ) {
      return {
        itemId: paper.itemId,
        contextItemId: paper.contextItemId,
        title: paper.title,
      };
    }
  }
  return defaultScopeTarget(request);
}

function buildReadDetail(toolName: string, args: unknown): string | undefined {
  const record = normalizeRecord(args);
  if (toolName === "paper_read") {
    const mode = normalizeText(record.mode, 40) || "overview";
    const pieces = [`mode=${mode}`];
    const query = normalizeText(record.query, 120);
    if (query) pieces.push(`query="${query}"`);
    if (Array.isArray(record.pages) && record.pages.length) {
      pieces.push(`pages=${record.pages.join(", ")}`);
    }
    return pieces.join(", ");
  }
  if (toolName === "search_paper") {
    const question = normalizeText(record.question, 120);
    return question ? `question="${question}"` : undefined;
  }
  if (toolName === "read_paper" && Array.isArray(record.chunkIndexes)) {
    const chunks = record.chunkIndexes
      .map((value) => normalizePositiveInt(value))
      .filter(Boolean)
      .join(", ");
    return chunks ? `chunks=${chunks}` : undefined;
  }
  if (toolName === "view_pdf_pages") {
    if (record.capture === true) return "captured current page";
    if (Array.isArray(record.pages) && record.pages.length) {
      return `pages=${record.pages.join(", ")}`;
    }
    const question = normalizeText(record.question, 120);
    return question ? `question="${question}"` : undefined;
  }
  if (toolName === "read_attachment") {
    return record.attachFile === true ? "attached full file" : undefined;
  }
  return undefined;
}

function buildFileIoEntry(
  activity: AgentPendingReadActivity,
): AgentReadLedgerEntry | null {
  const record = normalizeRecord(activity.input);
  if (record.action !== "read") return null;
  const filePath = normalizeText(record.filePath, 1024);
  if (!filePath || !isLikelyMineruReadPath(filePath)) return null;
  const target = findMineruPaperTarget(filePath, activity.request);
  const offset = normalizePositiveInt(record.offset);
  const length = normalizePositiveInt(record.length);
  const fileName = fileNameForPath(filePath);
  const detail =
    offset !== undefined || length !== undefined
      ? [
          offset !== undefined ? `offset=${offset}` : "",
          length ? `length=${length}` : "",
        ]
          .filter(Boolean)
          .join(", ")
      : undefined;
  return {
    key: [
      "file_io",
      filePath,
      offset || "",
      length || "",
      target.itemId || "",
      target.contextItemId || "",
    ].join(":"),
    toolName: "file_io",
    label:
      fileName === "full.md"
        ? "Read MinerU full.md"
        : fileName === "manifest.json"
          ? "Read MinerU manifest"
          : /\.(?:png|jpe?g|gif|webp|svg)$/i.test(fileName)
            ? "Read MinerU figure/file"
            : "Read MinerU file",
    targetLabel: formatTargetLabel(target),
    detail,
    itemId: target.itemId,
    contextItemId: target.contextItemId,
    filePath,
    count: 1,
    firstSeenAt: activity.timestamp,
    lastSeenAt: activity.timestamp,
  };
}

function buildReadLedgerEntries(
  activity: AgentPendingReadActivity,
): AgentReadLedgerEntry[] {
  if (activity.toolName === "file_io") {
    const entry = buildFileIoEntry(activity);
    return entry ? [entry] : [];
  }
  if (!READ_TOOL_NAMES.has(activity.toolName)) return [];
  const detail = buildReadDetail(activity.toolName, activity.input);
  const targets = extractTargets(activity.input, activity.request);
  const effectiveTargets = targets.length
    ? targets
    : [defaultScopeTarget(activity.request)];
  return effectiveTargets.map((target, index) => ({
    key: [
      activity.toolName,
      target.itemId || "",
      target.contextItemId || "",
      target.title || "",
      detail || "",
      index,
    ].join(":"),
    toolName: activity.toolName,
    label: activity.toolLabel || activity.toolName.replace(/_/g, " "),
    targetLabel: formatTargetLabel(target),
    detail,
    itemId: target.itemId,
    contextItemId: target.contextItemId,
    count: 1,
    firstSeenAt: activity.timestamp,
    lastSeenAt: activity.timestamp,
  }));
}

function upsertReadEntry(
  ledger: Map<string, AgentReadLedgerEntry>,
  entry: AgentReadLedgerEntry,
): void {
  const existing = ledger.get(entry.key);
  if (existing) {
    existing.count += 1;
    existing.lastSeenAt = Math.max(existing.lastSeenAt, entry.lastSeenAt);
    return;
  }
  ledger.set(entry.key, entry);
  if (ledger.size <= MAX_LEDGER_ENTRIES) return;
  const oldest = Array.from(ledger.values()).sort(
    (a, b) => a.lastSeenAt - b.lastSeenAt,
  )[0];
  if (oldest) ledger.delete(oldest.key);
}

export function commitAgentReadActivities(params: {
  conversationKey: number;
  activities: AgentPendingReadActivity[];
}): void {
  const conversationKey = normalizePositiveInt(params.conversationKey);
  if (!conversationKey || !params.activities.length) return;
  let ledger = readLedger.get(lifecycleKey(conversationKey));
  if (!ledger) {
    ledger = new Map();
    readLedger.set(lifecycleKey(conversationKey), ledger);
  }
  for (const activity of params.activities) {
    for (const entry of buildReadLedgerEntries(activity)) {
      upsertReadEntry(ledger, entry);
    }
  }
}

export function clearAgentReadLedger(): void {
  readLedger.clear();
}

function truncateMiddle(value: string, maxLength = 96): string {
  if (value.length <= maxLength) return value;
  const head = value.slice(0, Math.floor(maxLength / 2) - 2);
  const tail = value.slice(value.length - Math.floor(maxLength / 2) + 1);
  return `${head}...${tail}`;
}

function formatReadLedgerLine(entry: AgentReadLedgerEntry): string {
  const pieces = [entry.label];
  if (entry.targetLabel) pieces.push(entry.targetLabel);
  if (entry.detail) pieces.push(entry.detail);
  if (entry.filePath) pieces.push(`path=${truncateMiddle(entry.filePath)}`);
  if (entry.count > 1) pieces.push(`${entry.count}x`);
  return `- ${pieces.join(" - ")}`;
}

export function buildAgentPriorReadContextBlock(params: {
  conversationKey: number;
}): string {
  const conversationKey = normalizePositiveInt(params.conversationKey);
  if (!conversationKey) return "";
  const ledger = readLedger.get(lifecycleKey(conversationKey));
  if (!ledger?.size) return "";
  const entries = Array.from(ledger.values())
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_RENDERED_LEDGER_ENTRIES);
  return [
    "Already inspected in this agent conversation:",
    ...entries.map(formatReadLedgerLine),
  ].join("\n");
}
