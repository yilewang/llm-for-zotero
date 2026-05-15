import type { PaperContextRef } from "../../shared/types";
import type { AgentRuntimeRequest } from "../types";
import type { AgentCacheEvidenceActivity } from "./cacheManagement";

export type AgentCoverageSourceKind =
  | "zotero_metadata"
  | "library_read"
  | "zotero_fulltext"
  | "mineru"
  | "embedding_retrieval"
  | "pdf_visual"
  | "note"
  | "annotation"
  | "web_literature";

export type AgentCoverageGranularity =
  | "scope"
  | "metadata"
  | "abstract"
  | "overview"
  | "section"
  | "passage"
  | "figure"
  | "visual_page"
  | "note"
  | "annotation"
  | "attachment";

export type AgentCoverageLevel =
  | "listed"
  | "partial"
  | "targeted"
  | "broad"
  | "complete";

export type AgentCoverageConfidence = "low" | "medium" | "high";

export type AgentCoverageEntry = {
  key: string;
  resourceKey: string;
  resourceLabel?: string;
  sourceKind: AgentCoverageSourceKind;
  topic?: string;
  granularity: AgentCoverageGranularity;
  coverage: AgentCoverageLevel;
  confidence: AgentCoverageConfidence;
  contentHash?: string;
  toolName: string;
  evidenceRefs: string[];
  durable?: boolean;
  originConversationKey?: number;
  count: number;
  updatedAt: number;
};

type ZoteroDb = {
  queryAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
};

const COVERAGE_TABLE = "llm_for_zotero_agent_coverage";
const COVERAGE_SCOPE_INDEX = "llm_for_zotero_agent_coverage_scope_idx";
const COVERAGE_RESOURCE_INDEX = "llm_for_zotero_agent_coverage_resource_idx";
const MAX_COVERAGE_ENTRIES_PER_SCOPE = 40;
const MAX_RENDERED_COVERAGE_ENTRIES = 10;

const coverageByScope = new Map<string, Map<string, AgentCoverageEntry>>();
const hydratedScopes = new Set<string>();
let initPromise: Promise<boolean> | null = null;

function getDb(): ZoteroDb | null {
  const zotero = (
    globalThis as typeof globalThis & {
      Zotero?: { DB?: ZoteroDb };
    }
  ).Zotero;
  return zotero?.DB || null;
}

function logCoverageStoreError(message: string, error: unknown): void {
  const toolkit = (
    globalThis as typeof globalThis & {
      ztoolkit?: { log?: (...args: unknown[]) => void };
    }
  ).ztoolkit;
  toolkit?.log?.(message, error);
}

async function ensureAgentCoverageStore(): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      await db.queryAsync(
        `CREATE TABLE IF NOT EXISTS ${COVERAGE_TABLE} (
          scope_key TEXT NOT NULL,
          coverage_key TEXT NOT NULL,
          resource_key TEXT NOT NULL,
          durable INTEGER NOT NULL DEFAULT 0,
          origin_conversation_key INTEGER,
          entry_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(scope_key, coverage_key)
        )`,
      );
      await db.queryAsync(
        `CREATE INDEX IF NOT EXISTS ${COVERAGE_SCOPE_INDEX}
         ON ${COVERAGE_TABLE} (scope_key, updated_at DESC)`,
      );
      await db.queryAsync(
        `CREATE INDEX IF NOT EXISTS ${COVERAGE_RESOURCE_INDEX}
         ON ${COVERAGE_TABLE} (resource_key, updated_at DESC)`,
      );
      return true;
    } catch (error) {
      initPromise = null;
      logCoverageStoreError(
        "LLM Agent: Failed to initialize coverage ledger",
        error,
      );
      return false;
    }
  })();
  return initPromise;
}

export async function initAgentCoverageStore(): Promise<boolean> {
  return ensureAgentCoverageStore();
}

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

function conversationScopeKey(conversationKey: number): string {
  return `conversation:${normalizePositiveInt(conversationKey) || 0}`;
}

function durableScopeKey(resourceKey: string): string {
  return `durable:${resourceKey}`;
}

function ledgerForScope(scopeKey: string): Map<string, AgentCoverageEntry> {
  let ledger = coverageByScope.get(scopeKey);
  if (!ledger) {
    ledger = new Map();
    coverageByScope.set(scopeKey, ledger);
  }
  return ledger;
}

function paperResourceKey(paper: Partial<PaperContextRef>): string {
  const itemId = normalizePositiveInt(paper.itemId);
  const contextItemId = normalizePositiveInt(paper.contextItemId);
  if (itemId && contextItemId) return `paper:${itemId}:${contextItemId}`;
  if (itemId) return `item:${itemId}`;
  if (contextItemId) return `attachment:${contextItemId}`;
  return "";
}

function itemResourceKey(itemId: unknown): string {
  const normalized = normalizePositiveInt(itemId);
  return normalized ? `item:${normalized}` : "";
}

function noteResourceKey(itemId: unknown): string {
  const normalized = normalizePositiveInt(itemId);
  return normalized ? `note:${normalized}` : "";
}

function attachmentResourceKey(value: unknown): string {
  const normalized = normalizePositiveInt(value);
  return normalized ? `attachment:${normalized}` : "";
}

function collectionResourceKey(value: {
  collectionId?: unknown;
  libraryID?: unknown;
}): string {
  const collectionId = normalizePositiveInt(value.collectionId);
  if (!collectionId) return "";
  const libraryID = normalizePositiveInt(value.libraryID) || 0;
  return `collection:${libraryID}:${collectionId}`;
}

function libraryResourceKey(libraryID: unknown): string {
  const normalized = normalizePositiveInt(libraryID);
  return normalized ? `library:${normalized}` : "library:unknown";
}

function getPaperLabel(paper: Partial<PaperContextRef>): string | undefined {
  return normalizeText(paper.title, 120) || undefined;
}

function buildCoverageKey(entry: Omit<AgentCoverageEntry, "key">): string {
  return [
    entry.resourceKey,
    entry.sourceKind,
    entry.granularity,
    entry.coverage,
    entry.topic || "",
    entry.toolName,
    entry.contentHash || "",
  ].join(":");
}

function createCoverageEntry(
  value: Omit<
    AgentCoverageEntry,
    "key" | "count" | "updatedAt" | "evidenceRefs"
  > & {
    evidenceRefs?: string[];
    updatedAt: number;
  },
): AgentCoverageEntry | null {
  if (!value.resourceKey) return null;
  const entry: Omit<AgentCoverageEntry, "key"> = {
    resourceKey: value.resourceKey,
    resourceLabel: value.resourceLabel,
    sourceKind: value.sourceKind,
    topic: value.topic,
    granularity: value.granularity,
    coverage: value.coverage,
    confidence: value.confidence,
    contentHash: value.contentHash,
    toolName: value.toolName,
    evidenceRefs: (value.evidenceRefs || []).filter(Boolean).slice(0, 4),
    durable: value.durable,
    count: 1,
    updatedAt: value.updatedAt,
  };
  return {
    ...entry,
    key: buildCoverageKey(entry),
  };
}

function deserializeCoverageEntry(value: unknown): AgentCoverageEntry | null {
  const record = normalizeRecord(value);
  const key = normalizeText(record.key, 320);
  const resourceKey = normalizeText(record.resourceKey, 220);
  const sourceKind = normalizeText(
    record.sourceKind,
    80,
  ) as AgentCoverageSourceKind;
  const granularity = normalizeText(
    record.granularity,
    80,
  ) as AgentCoverageGranularity;
  const coverage = normalizeText(record.coverage, 80) as AgentCoverageLevel;
  const confidence = normalizeText(
    record.confidence,
    80,
  ) as AgentCoverageConfidence;
  const toolName = normalizeText(record.toolName, 100);
  if (
    !key ||
    !resourceKey ||
    !sourceKind ||
    !granularity ||
    !coverage ||
    !toolName
  ) {
    return null;
  }
  const entry: AgentCoverageEntry = {
    key,
    resourceKey,
    sourceKind,
    granularity,
    coverage,
    confidence: confidence || "medium",
    toolName,
    evidenceRefs: Array.isArray(record.evidenceRefs)
      ? record.evidenceRefs
          .map((entry) => normalizeText(entry, 180))
          .filter(Boolean)
          .slice(0, 4)
      : [],
    durable: record.durable === true,
    count: Math.max(1, normalizePositiveInt(record.count) || 1),
    updatedAt: Math.max(0, normalizePositiveInt(record.updatedAt) || 0),
  };
  const resourceLabel = normalizeText(record.resourceLabel, 160);
  if (resourceLabel) entry.resourceLabel = resourceLabel;
  const topic = normalizeText(record.topic, 160);
  if (topic) entry.topic = topic;
  const contentHash = normalizeText(record.contentHash, 120);
  if (contentHash) entry.contentHash = contentHash;
  const originConversationKey = normalizePositiveInt(
    record.originConversationKey,
  );
  if (originConversationKey)
    entry.originConversationKey = originConversationKey;
  return entry;
}

function upsertCoverageEntry(
  ledger: Map<string, AgentCoverageEntry>,
  entry: AgentCoverageEntry,
): void {
  const existing = ledger.get(entry.key);
  if (existing) {
    existing.count += 1;
    existing.updatedAt = Math.max(existing.updatedAt, entry.updatedAt);
    existing.evidenceRefs = Array.from(
      new Set([...existing.evidenceRefs, ...entry.evidenceRefs]),
    ).slice(0, 4);
    existing.durable = existing.durable || entry.durable;
    return;
  }
  ledger.set(entry.key, entry);
  if (ledger.size <= MAX_COVERAGE_ENTRIES_PER_SCOPE) return;
  const oldest = Array.from(ledger.values()).sort(
    (left, right) => left.updatedAt - right.updatedAt,
  )[0];
  if (oldest) ledger.delete(oldest.key);
}

async function persistCoverageScope(
  scopeKey: string,
  ledger: Map<string, AgentCoverageEntry>,
): Promise<void> {
  const dbReady = await ensureAgentCoverageStore();
  const db = getDb();
  if (!dbReady || !db) return;
  const entries = Array.from(ledger.values())
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_COVERAGE_ENTRIES_PER_SCOPE);
  try {
    for (const entry of entries) {
      await db.queryAsync(
        `INSERT INTO ${COVERAGE_TABLE}
          (scope_key, coverage_key, resource_key, durable, origin_conversation_key, entry_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope_key, coverage_key) DO UPDATE SET
           resource_key = excluded.resource_key,
           durable = excluded.durable,
           origin_conversation_key = excluded.origin_conversation_key,
           entry_json = excluded.entry_json,
           updated_at = excluded.updated_at`,
        [
          scopeKey,
          entry.key,
          entry.resourceKey,
          entry.durable ? 1 : 0,
          entry.originConversationKey || null,
          stableJson(entry),
          entry.updatedAt,
        ],
      );
    }
    await db.queryAsync(
      `DELETE FROM ${COVERAGE_TABLE}
       WHERE scope_key = ?
         AND coverage_key NOT IN (
           SELECT coverage_key
           FROM ${COVERAGE_TABLE}
           WHERE scope_key = ?
           ORDER BY updated_at DESC
           LIMIT ?
         )`,
      [scopeKey, scopeKey, MAX_COVERAGE_ENTRIES_PER_SCOPE],
    );
  } catch (error) {
    logCoverageStoreError(
      "LLM Agent: Failed to persist coverage ledger",
      error,
    );
  }
}

async function hydrateCoverageScope(scopeKey: string): Promise<void> {
  if (hydratedScopes.has(scopeKey)) return;
  const dbReady = await ensureAgentCoverageStore();
  const db = getDb();
  if (!dbReady || !db) return;
  try {
    const rows = (await db.queryAsync(
      `SELECT entry_json AS entryJson
       FROM ${COVERAGE_TABLE}
       WHERE scope_key = ?
       ORDER BY updated_at DESC
       LIMIT ?`,
      [scopeKey, MAX_COVERAGE_ENTRIES_PER_SCOPE],
    )) as Array<{ entryJson?: unknown }> | undefined;
    const ledger = ledgerForScope(scopeKey);
    for (const row of rows || []) {
      const raw = typeof row.entryJson === "string" ? row.entryJson : "";
      if (!raw) continue;
      try {
        const entry = deserializeCoverageEntry(JSON.parse(raw) as unknown);
        if (entry) upsertCoverageEntry(ledger, entry);
      } catch {
        // Ignore malformed coverage rows; future successful runs refresh them.
      }
    }
    hydratedScopes.add(scopeKey);
  } catch (error) {
    logCoverageStoreError(
      "LLM Agent: Failed to hydrate coverage ledger",
      error,
    );
  }
}

function collectRequestResourceKeys(request: AgentRuntimeRequest): Set<string> {
  const keys = new Set<string>();
  const add = (value: string) => {
    if (value) keys.add(value);
  };
  add(libraryResourceKey(request.libraryID));
  if (request.activeItemId) add(itemResourceKey(request.activeItemId));
  const note = request.activeNoteContext;
  if (note) {
    add(noteResourceKey(note.noteId));
    add(itemResourceKey(note.parentItemId));
  }
  const paperContexts = [
    ...(request.selectedTextPaperContexts || []).filter(
      (entry): entry is PaperContextRef => Boolean(entry),
    ),
    ...(request.selectedPaperContexts || []),
    ...(request.fullTextPaperContexts || []),
    ...(request.pinnedPaperContexts || []),
  ];
  for (const paper of paperContexts) {
    add(paperResourceKey(paper));
    add(itemResourceKey(paper.itemId));
    add(attachmentResourceKey(paper.contextItemId));
  }
  for (const collection of request.selectedCollectionContexts || []) {
    add(collectionResourceKey(collection));
    add(libraryResourceKey(collection.libraryID));
  }
  for (const attachment of request.attachments || []) {
    add(normalizeText(attachment.id, 180) ? `attachment:${attachment.id}` : "");
  }
  return keys;
}

export async function hydrateAgentCoverageLedger(params: {
  conversationKey: number;
  request?: AgentRuntimeRequest;
}): Promise<void> {
  const conversationKey = normalizePositiveInt(params.conversationKey);
  if (!conversationKey) return;
  await hydrateCoverageScope(conversationScopeKey(conversationKey));
  if (!params.request) return;
  for (const key of collectRequestResourceKeys(params.request)) {
    await hydrateCoverageScope(durableScopeKey(key));
  }
}

function normalizeTopic(value: unknown, fallback?: string): string | undefined {
  const text = normalizeText(value, 160) || normalizeText(fallback, 160);
  return text || undefined;
}

function evidenceRefFor(
  activity: AgentCacheEvidenceActivity,
  extra: unknown,
): string {
  return `${activity.toolName}:${hashText(stableJson(extra))}`;
}

function activityContentHash(
  activity: AgentCacheEvidenceActivity,
  extra?: unknown,
): string {
  return hashText(stableJson(extra ?? activity.content ?? ""));
}

function paperContextFromRecord(value: unknown): Partial<PaperContextRef> {
  const record = normalizeRecord(value);
  const nested = normalizeRecord(record.paperContext);
  return {
    itemId:
      normalizePositiveInt(record.itemId) ||
      normalizePositiveInt(nested.itemId),
    contextItemId:
      normalizePositiveInt(record.contextItemId) ||
      normalizePositiveInt(nested.contextItemId),
    title: normalizeText(record.title, 160) || normalizeText(nested.title, 160),
    mineruCacheDir:
      normalizeText(record.mineruCacheDir, 1024) ||
      normalizeText(nested.mineruCacheDir, 1024),
  };
}

function sourceKindFromPaperBackend(value: unknown): AgentCoverageSourceKind {
  const normalized = normalizeText(value, 80);
  if (normalized === "mineru" || normalized === "mineru_file") return "mineru";
  if (normalized === "zotero_metadata") return "zotero_metadata";
  return "zotero_fulltext";
}

function sourceKindFromFilePath(filePath: string): AgentCoverageSourceKind {
  return /mineru/i.test(filePath) ? "mineru" : "library_read";
}

function buildPaperReadCoverageEntries(
  activity: AgentCacheEvidenceActivity,
): AgentCoverageEntry[] {
  const content = normalizeRecord(activity.content);
  const input = normalizeRecord(activity.input);
  const mode = normalizeText(content.mode, 40) || normalizeText(input.mode, 40);
  const topic = normalizeTopic(input.query, activity.request.userText);
  const entries: AgentCoverageEntry[] = [];

  if (mode === "overview" && Array.isArray(content.results)) {
    for (const result of content.results) {
      const record = normalizeRecord(result);
      const paper = paperContextFromRecord(record);
      const resourceKey = paperResourceKey(paper);
      const sourceKind = sourceKindFromPaperBackend(
        record.backend || record.sourceKind,
      );
      const entry = createCoverageEntry({
        resourceKey,
        resourceLabel: getPaperLabel(paper),
        sourceKind,
        topic,
        granularity: "overview",
        coverage: sourceKind === "zotero_metadata" ? "partial" : "broad",
        confidence: sourceKind === "zotero_metadata" ? "medium" : "high",
        contentHash: activityContentHash(activity, record),
        toolName: activity.toolName,
        evidenceRefs: [evidenceRefFor(activity, record)],
        durable: Boolean(resourceKey && activityContentHash(activity, record)),
        updatedAt: activity.timestamp,
      });
      if (entry) entries.push(entry);
    }
    return entries;
  }

  if (mode === "targeted" && Array.isArray(content.papers)) {
    for (const paperRecord of content.papers) {
      const record = normalizeRecord(paperRecord);
      const paper = paperContextFromRecord(record);
      const passages = Array.isArray(record.passages) ? record.passages : [];
      const contentHash = activityContentHash(activity, {
        paper,
        passages: passages.slice(0, 4),
      });
      const entry = createCoverageEntry({
        resourceKey: paperResourceKey(paper),
        resourceLabel: getPaperLabel(paper),
        sourceKind:
          sourceKindFromPaperBackend(record.sourceKind) === "mineru"
            ? "mineru"
            : "embedding_retrieval",
        topic,
        granularity: "passage",
        coverage: passages.length ? "targeted" : "partial",
        confidence: passages.length ? "high" : "medium",
        contentHash,
        toolName: activity.toolName,
        evidenceRefs: [evidenceRefFor(activity, { paper, passages })],
        durable: Boolean(contentHash),
        updatedAt: activity.timestamp,
      });
      if (entry) entries.push(entry);
    }
    return entries;
  }

  if (mode === "visual" || mode === "capture") {
    return buildVisualCoverageEntries(activity);
  }

  if (Array.isArray(content.results)) {
    return buildSearchPaperCoverageEntries(activity);
  }
  return entries;
}

function buildSearchPaperCoverageEntries(
  activity: AgentCacheEvidenceActivity,
): AgentCoverageEntry[] {
  const content = normalizeRecord(activity.content);
  const input = normalizeRecord(activity.input);
  const results = Array.isArray(content.results) ? content.results : [];
  const topic = normalizeTopic(
    input.question || input.query,
    activity.request.userText,
  );
  const byResource = new Map<
    string,
    { paper: Partial<PaperContextRef>; rows: unknown[] }
  >();
  for (const result of results) {
    const paper = paperContextFromRecord(result);
    const resourceKey = paperResourceKey(paper);
    if (!resourceKey) continue;
    const group = byResource.get(resourceKey) || { paper, rows: [] };
    group.rows.push(result);
    byResource.set(resourceKey, group);
  }
  return Array.from(byResource.values())
    .map(({ paper, rows }) =>
      createCoverageEntry({
        resourceKey: paperResourceKey(paper),
        resourceLabel: getPaperLabel(paper),
        sourceKind: "embedding_retrieval",
        topic,
        granularity: "passage",
        coverage: rows.length ? "targeted" : "partial",
        confidence: rows.length ? "high" : "medium",
        contentHash: activityContentHash(activity, rows.slice(0, 4)),
        toolName: activity.toolName,
        evidenceRefs: [evidenceRefFor(activity, rows.slice(0, 4))],
        durable: true,
        updatedAt: activity.timestamp,
      }),
    )
    .filter((entry): entry is AgentCoverageEntry => Boolean(entry));
}

function buildVisualCoverageEntries(
  activity: AgentCacheEvidenceActivity,
): AgentCoverageEntry[] {
  const content = normalizeRecord(activity.content);
  const input = normalizeRecord(activity.input);
  const target = paperContextFromRecord(input.target || input);
  const contentPaper = paperContextFromRecord(content.paperContext);
  const paper = paperResourceKey(contentPaper) ? contentPaper : target;
  const resourceKey =
    paperResourceKey(paper) || attachmentResourceKey(input.contextItemId);
  const entry = createCoverageEntry({
    resourceKey,
    resourceLabel: getPaperLabel(paper) || normalizeText(content.title, 120),
    sourceKind: "pdf_visual",
    topic: normalizeTopic(
      input.question || input.query,
      activity.request.userText,
    ),
    granularity: "visual_page",
    coverage: "targeted",
    confidence: "high",
    contentHash: activityContentHash(activity, {
      pages: content.pages,
      artifacts: activity.artifacts?.map((artifact) => {
        const record = normalizeRecord(artifact);
        return {
          contentHash: normalizeText(record.contentHash, 120),
          pageLabel: normalizeText(record.pageLabel, 40),
        };
      }),
    }),
    toolName: activity.toolName,
    evidenceRefs: [
      evidenceRefFor(activity, content.pages || activity.artifacts),
    ],
    durable: Boolean(resourceKey),
    updatedAt: activity.timestamp,
  });
  return entry ? [entry] : [];
}

function buildFileIoCoverageEntries(
  activity: AgentCacheEvidenceActivity,
): AgentCoverageEntry[] {
  const input = normalizeRecord(activity.input);
  if (input.action !== "read") return [];
  const filePath = normalizeText(input.filePath, 1024);
  if (!filePath) return [];
  const sourceKind = sourceKindFromFilePath(filePath);
  const normalizedPath = filePath.replace(/\\/g, "/");
  const fileName = normalizedPath.split("/").pop() || normalizedPath;
  const matchingPaper = [
    ...(activity.request.selectedPaperContexts || []),
    ...(activity.request.fullTextPaperContexts || []),
    ...(activity.request.pinnedPaperContexts || []),
  ].find((paper) => {
    const cacheDir = normalizeText(paper.mineruCacheDir, 1024).replace(
      /\\/g,
      "/",
    );
    return (
      cacheDir && normalizedPath.startsWith(`${cacheDir.replace(/\/+$/g, "")}/`)
    );
  });
  const resourceKey = matchingPaper
    ? paperResourceKey(matchingPaper)
    : normalizeText(input.attachmentId, 120)
      ? `attachment:${input.attachmentId}`
      : "";
  const isFigure = /\.(?:png|jpe?g|gif|webp|svg)$/i.test(fileName);
  const isManifest = fileName === "manifest.json";
  const entry = createCoverageEntry({
    resourceKey,
    resourceLabel: getPaperLabel(matchingPaper || {}) || fileName,
    sourceKind,
    topic: normalizeTopic(input.query, activity.request.userText),
    granularity: isFigure ? "figure" : isManifest ? "metadata" : "section",
    coverage: isManifest ? "partial" : "targeted",
    confidence: sourceKind === "mineru" ? "high" : "medium",
    contentHash: activityContentHash(activity),
    toolName: activity.toolName,
    evidenceRefs: [
      evidenceRefFor(activity, { filePath, content: activity.content }),
    ],
    durable: Boolean(resourceKey && sourceKind === "mineru"),
    updatedAt: activity.timestamp,
  });
  return entry ? [entry] : [];
}

function buildLibrarySearchCoverageEntries(
  activity: AgentCacheEvidenceActivity,
): AgentCoverageEntry[] {
  const input = normalizeRecord(activity.input);
  const content = normalizeRecord(activity.content);
  const entity = normalizeText(content.entity || input.entity, 40);
  const mode = normalizeText(content.mode || input.mode, 40);
  const topic = normalizeTopic(input.text, activity.request.userText);
  const results = Array.isArray(content.results) ? content.results : [];
  const entries: AgentCoverageEntry[] = [];
  const libraryID = activity.request.libraryID;

  const scopeEntry = createCoverageEntry({
    resourceKey: libraryResourceKey(libraryID),
    resourceLabel: entity ? `${entity} ${mode || "query"}` : "library query",
    sourceKind: "zotero_metadata",
    topic,
    granularity: "scope",
    coverage: mode === "search" ? "targeted" : "listed",
    confidence: "medium",
    contentHash: activityContentHash(activity, {
      entity,
      mode,
      totalCount: content.totalCount,
      totalGroups: content.totalGroups,
      resultCount: results.length,
    }),
    toolName: activity.toolName,
    evidenceRefs: [evidenceRefFor(activity, { entity, mode, topic })],
    updatedAt: activity.timestamp,
  });
  if (scopeEntry) entries.push(scopeEntry);

  for (const result of results.slice(0, 12)) {
    const record = normalizeRecord(result);
    const itemId = normalizePositiveInt(record.itemId);
    const collectionId = normalizePositiveInt(record.collectionId);
    const resourceKey =
      entity === "collections"
        ? collectionResourceKey({
            collectionId,
            libraryID: record.libraryID || libraryID,
          })
        : entity === "notes" || normalizeText(record.itemType, 40) === "note"
          ? noteResourceKey(itemId)
          : itemResourceKey(itemId);
    if (!resourceKey) continue;
    const hasAbstract = Boolean(
      normalizeText(record.abstract, 240) ||
      normalizeText(normalizeRecord(record.metadata).abstractNote, 240),
    );
    const sourceKind: AgentCoverageSourceKind =
      entity === "notes" || normalizeText(record.itemType, 40) === "note"
        ? "note"
        : "zotero_metadata";
    const entry = createCoverageEntry({
      resourceKey,
      resourceLabel:
        normalizeText(record.title, 120) ||
        normalizeText(record.name, 120) ||
        resourceKey,
      sourceKind,
      topic,
      granularity: hasAbstract ? "abstract" : "metadata",
      coverage: hasAbstract ? "partial" : "listed",
      confidence: hasAbstract ? "high" : "medium",
      contentHash: activityContentHash(activity, record),
      toolName: activity.toolName,
      evidenceRefs: [evidenceRefFor(activity, record)],
      durable: Boolean(itemId && activityContentHash(activity, record)),
      updatedAt: activity.timestamp,
    });
    if (entry) entries.push(entry);
  }
  return entries;
}

function buildLibraryReadCoverageEntries(
  activity: AgentCacheEvidenceActivity,
): AgentCoverageEntry[] {
  const input = normalizeRecord(activity.input);
  const content = normalizeRecord(activity.content);
  const sections = Array.isArray(content.sections)
    ? content.sections.map((entry) => normalizeText(entry, 40)).filter(Boolean)
    : Array.isArray(input.sections)
      ? input.sections.map((entry) => normalizeText(entry, 40)).filter(Boolean)
      : [];
  const results = normalizeRecord(content.results);
  return Object.entries(results)
    .map(([key, value]) => {
      const record = normalizeRecord(value);
      const itemId =
        normalizePositiveInt(record.itemId) || normalizePositiveInt(key);
      const itemType = normalizeText(record.itemType, 40);
      const resourceKey =
        itemType === "note" ? noteResourceKey(itemId) : itemResourceKey(itemId);
      const hasContent = sections.includes("content");
      const hasNotes = sections.includes("notes");
      const hasAnnotations = sections.includes("annotations");
      const hasAttachments = sections.includes("attachments");
      const granularity: AgentCoverageGranularity = hasContent
        ? "note"
        : hasAnnotations
          ? "annotation"
          : hasNotes
            ? "note"
            : hasAttachments
              ? "attachment"
              : sections.includes("metadata")
                ? "metadata"
                : "scope";
      const sourceKind: AgentCoverageSourceKind = hasAnnotations
        ? "annotation"
        : itemType === "note" || hasContent || hasNotes
          ? "note"
          : "library_read";
      return createCoverageEntry({
        resourceKey,
        resourceLabel:
          normalizeText(record.title, 120) ||
          normalizeText(record.name, 120) ||
          resourceKey,
        sourceKind,
        topic: normalizeTopic(input.query, activity.request.userText),
        granularity,
        coverage:
          hasContent || hasAnnotations || hasNotes ? "targeted" : "partial",
        confidence: "high",
        contentHash: activityContentHash(activity, { key, record, sections }),
        toolName: activity.toolName,
        evidenceRefs: [evidenceRefFor(activity, { key, sections })],
        durable: Boolean(itemId),
        updatedAt: activity.timestamp,
      });
    })
    .filter((entry): entry is AgentCoverageEntry => Boolean(entry));
}

export function buildAgentCoverageEntriesForActivity(
  activity: AgentCacheEvidenceActivity,
): AgentCoverageEntry[] {
  if (activity.toolName === "paper_read") {
    return buildPaperReadCoverageEntries(activity);
  }
  if (
    activity.toolName === "search_paper" ||
    activity.toolName === "read_paper"
  ) {
    return buildSearchPaperCoverageEntries(activity);
  }
  if (activity.toolName === "view_pdf_pages") {
    return buildVisualCoverageEntries(activity);
  }
  if (activity.toolName === "file_io") {
    return buildFileIoCoverageEntries(activity);
  }
  if (
    activity.toolName === "library_search" ||
    activity.toolName === "query_library"
  ) {
    return buildLibrarySearchCoverageEntries(activity);
  }
  if (
    activity.toolName === "library_read" ||
    activity.toolName === "read_library"
  ) {
    return buildLibraryReadCoverageEntries(activity);
  }
  return [];
}

function isDurableEligible(entry: AgentCoverageEntry): boolean {
  if (!entry.contentHash) return false;
  return (
    entry.resourceKey.startsWith("paper:") ||
    entry.resourceKey.startsWith("item:") ||
    entry.resourceKey.startsWith("attachment:") ||
    entry.resourceKey.startsWith("note:")
  );
}

export async function commitAgentCoverageActivities(params: {
  conversationKey: number;
  activities: AgentCacheEvidenceActivity[];
}): Promise<void> {
  const conversationKey = normalizePositiveInt(params.conversationKey);
  if (!conversationKey || !params.activities.length) return;
  const touchedScopes = new Set<string>();
  const conversationScope = conversationScopeKey(conversationKey);
  const conversationLedger = ledgerForScope(conversationScope);
  for (const activity of params.activities) {
    for (const entry of buildAgentCoverageEntriesForActivity(activity)) {
      const scopedEntry: AgentCoverageEntry = {
        ...entry,
        originConversationKey: conversationKey,
      };
      upsertCoverageEntry(conversationLedger, scopedEntry);
      touchedScopes.add(conversationScope);
      if (!isDurableEligible(entry)) continue;
      const durableEntry: AgentCoverageEntry = {
        ...entry,
        durable: true,
        originConversationKey: conversationKey,
      };
      const scopeKey = durableScopeKey(entry.resourceKey);
      upsertCoverageEntry(ledgerForScope(scopeKey), durableEntry);
      touchedScopes.add(scopeKey);
    }
  }
  for (const scopeKey of touchedScopes) {
    await persistCoverageScope(scopeKey, ledgerForScope(scopeKey));
  }
}

export async function clearPersistedAgentCoverage(
  conversationKeyValue?: number,
): Promise<void> {
  if (conversationKeyValue === undefined) {
    coverageByScope.clear();
    hydratedScopes.clear();
  } else {
    const conversationKey = normalizePositiveInt(conversationKeyValue);
    if (conversationKey) {
      const scopeKey = conversationScopeKey(conversationKey);
      coverageByScope.delete(scopeKey);
      hydratedScopes.delete(scopeKey);
      for (const [key, ledger] of Array.from(coverageByScope.entries())) {
        for (const [entryKey, entry] of Array.from(ledger.entries())) {
          if (entry.originConversationKey === conversationKey) {
            ledger.delete(entryKey);
          }
        }
        if (!ledger.size) {
          coverageByScope.delete(key);
          hydratedScopes.delete(key);
        }
      }
    }
  }
  const dbReady = await ensureAgentCoverageStore();
  const db = getDb();
  if (!dbReady || !db) return;
  try {
    if (conversationKeyValue === undefined) {
      await db.queryAsync(`DELETE FROM ${COVERAGE_TABLE}`);
      return;
    }
    const conversationKey = normalizePositiveInt(conversationKeyValue);
    if (!conversationKey) return;
    await db.queryAsync(
      `DELETE FROM ${COVERAGE_TABLE}
       WHERE scope_key = ?
          OR origin_conversation_key = ?`,
      [conversationScopeKey(conversationKey), conversationKey],
    );
  } catch (error) {
    logCoverageStoreError("LLM Agent: Failed to clear coverage ledger", error);
  }
}

export function clearAgentCoverageLedger(): void {
  coverageByScope.clear();
  hydratedScopes.clear();
}

function getVisibleCoverageEntries(params: {
  conversationKey: number;
  request?: AgentRuntimeRequest;
}): AgentCoverageEntry[] {
  const entries: AgentCoverageEntry[] = [];
  const conversationLedger = coverageByScope.get(
    conversationScopeKey(params.conversationKey),
  );
  if (conversationLedger) entries.push(...conversationLedger.values());
  if (params.request) {
    for (const key of collectRequestResourceKeys(params.request)) {
      const durableLedger = coverageByScope.get(durableScopeKey(key));
      if (durableLedger) entries.push(...durableLedger.values());
    }
  }
  const seen = new Set<string>();
  return entries
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .filter((entry) => {
      const key = `${entry.resourceKey}:${entry.key}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_RENDERED_COVERAGE_ENTRIES);
}

function formatCoverageEntry(entry: AgentCoverageEntry): string {
  const pieces = [
    entry.resourceLabel
      ? `${entry.resourceLabel} [${entry.resourceKey}]`
      : entry.resourceKey,
    `${entry.coverage} ${entry.granularity}`,
    `source=${entry.sourceKind}`,
    `tool=${entry.toolName}`,
    `confidence=${entry.confidence}`,
    entry.topic ? `topic="${entry.topic}"` : "",
    entry.durable ? "durable" : "conversation",
    entry.count > 1 ? `${entry.count}x` : "",
  ].filter(Boolean);
  return `- ${pieces.join("; ")}`;
}

export function buildAgentCoverageContextBlock(params: {
  conversationKey: number;
  request?: AgentRuntimeRequest;
}): string {
  const conversationKey = normalizePositiveInt(params.conversationKey);
  if (!conversationKey) return "";
  const entries = getVisibleCoverageEntries({
    conversationKey,
    request: params.request,
  });
  if (!entries.length) return "";
  return [
    "Known coverage from prior agent reads:",
    "Use this as source-aware read-state, not as a substitute for unread source content. Reuse preserved evidence when enough; call tools when the requested evidence or coverage layer is missing.",
    ...entries.map(formatCoverageEntry),
  ].join("\n");
}
