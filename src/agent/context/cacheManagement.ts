import {
  planContextCacheReuse,
  type ContextCachePlan,
} from "../../contextCache/manager";
import type { PaperContextRef } from "../../shared/types";
import type { AgentRuntimeRequest, AgentToolArtifact } from "../types";

export type AgentCacheEvidenceActivity = {
  toolName: string;
  toolLabel?: string;
  input?: unknown;
  content?: unknown;
  artifacts?: AgentToolArtifact[];
  request: AgentRuntimeRequest;
  timestamp: number;
};

type AgentEvidenceSnippet = {
  text: string;
  sourceLabel?: string;
  citationLabel?: string;
  sectionLabel?: string;
  pageLabel?: string;
  chunkKind?: string;
  chunkIndex?: number;
  score?: number;
};

type AgentEvidenceEntry = {
  key: string;
  toolName: string;
  label: string;
  targetLabel?: string;
  detail?: string;
  sourceKind?: string;
  itemId?: number;
  contextItemId?: number;
  title?: string;
  filePath?: string;
  snippets: AgentEvidenceSnippet[];
  contentHash?: string;
  resourceSignature?: string;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
};

type ZoteroDb = {
  queryAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
};

const READ_TOOL_NAMES = new Set([
  "paper_read",
  "read_paper",
  "search_paper",
  "view_pdf_pages",
  "read_attachment",
]);
const MAX_EVIDENCE_ENTRIES = 12;
const MAX_RENDERED_EVIDENCE_ENTRIES = 8;
const MAX_SNIPPETS_PER_ENTRY = 4;
const MAX_SNIPPET_CHARS = 1200;
const MAX_RENDERED_SNIPPET_CHARS = 900;
const EVIDENCE_TABLE = "llm_for_zotero_agent_evidence";
const EVIDENCE_INDEX = "llm_for_zotero_agent_evidence_conversation_idx";

const evidenceLedger = new Map<string, Map<string, AgentEvidenceEntry>>();
const hydratedConversations = new Set<string>();
let initPromise: Promise<boolean> | null = null;

function getDb(): ZoteroDb | null {
  const zotero = (
    globalThis as typeof globalThis & {
      Zotero?: { DB?: ZoteroDb };
    }
  ).Zotero;
  return zotero?.DB || null;
}

function logEvidenceStoreError(message: string, error: unknown): void {
  const toolkit = (
    globalThis as typeof globalThis & {
      ztoolkit?: { log?: (...args: unknown[]) => void };
    }
  ).ztoolkit;
  toolkit?.log?.(message, error);
}

async function ensureAgentEvidenceStore(): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      await db.queryAsync(
        `CREATE TABLE IF NOT EXISTS ${EVIDENCE_TABLE} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_key INTEGER NOT NULL,
          evidence_key TEXT NOT NULL,
          resource_signature TEXT,
          entry_json TEXT NOT NULL,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          UNIQUE(conversation_key, evidence_key)
        )`,
      );
      await db.queryAsync(
        `CREATE INDEX IF NOT EXISTS ${EVIDENCE_INDEX}
         ON ${EVIDENCE_TABLE} (conversation_key, last_seen_at DESC)`,
      );
      return true;
    } catch (error) {
      logEvidenceStoreError(
        "LLM Agent: Failed to initialize evidence cache store",
        error,
      );
      initPromise = null;
      return false;
    }
  })();
  return initPromise;
}

export async function initAgentEvidenceStore(): Promise<boolean> {
  return ensureAgentEvidenceStore();
}

function lifecycleKey(conversationKey: number): string {
  const normalized = normalizePositiveInt(conversationKey);
  return `${normalized || 0}`;
}

function normalizeText(value: unknown, maxLength = 160): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeEvidenceText(value: unknown): string {
  return normalizeText(value, MAX_SNIPPET_CHARS);
}

function normalizePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function normalizeNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

function stableJson(value: unknown): string {
  return JSON.stringify(stabilizeForJson(value));
}

function ledgerForConversation(
  conversationKey: number,
): Map<string, AgentEvidenceEntry> | undefined {
  return evidenceLedger.get(lifecycleKey(conversationKey));
}

function ensureLedgerForConversation(
  conversationKey: number,
): Map<string, AgentEvidenceEntry> {
  let ledger = evidenceLedger.get(lifecycleKey(conversationKey));
  if (!ledger) {
    ledger = new Map();
    evidenceLedger.set(lifecycleKey(conversationKey), ledger);
  }
  return ledger;
}

function hashText(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function deserializeEvidenceEntry(
  value: unknown,
  resourceSignature?: string,
): AgentEvidenceEntry | null {
  const record = normalizeRecord(value);
  const key = normalizeText(record.key, 240);
  const toolName = normalizeText(record.toolName, 80);
  const label = normalizeText(record.label, 120);
  if (!key || !toolName || !label) return null;
  const snippets = Array.isArray(record.snippets)
    ? record.snippets
        .map(snippetFromRecord)
        .filter((entry): entry is AgentEvidenceSnippet => Boolean(entry))
        .slice(0, MAX_SNIPPETS_PER_ENTRY)
    : [];
  const entry: AgentEvidenceEntry = {
    key,
    toolName,
    label,
    snippets,
    count: Math.max(1, normalizePositiveInt(record.count) || 1),
    firstSeenAt: Math.max(0, normalizePositiveInt(record.firstSeenAt) || 0),
    lastSeenAt: Math.max(0, normalizePositiveInt(record.lastSeenAt) || 0),
  };
  const targetLabel = normalizeText(record.targetLabel, 180);
  if (targetLabel) entry.targetLabel = targetLabel;
  const detail = normalizeText(record.detail, 200);
  if (detail) entry.detail = detail;
  const sourceKind = normalizeText(record.sourceKind, 80);
  if (sourceKind) entry.sourceKind = sourceKind;
  const itemId = normalizePositiveInt(record.itemId);
  if (itemId) entry.itemId = itemId;
  const contextItemId = normalizePositiveInt(record.contextItemId);
  if (contextItemId) entry.contextItemId = contextItemId;
  const title = normalizeText(record.title, 200);
  if (title) entry.title = title;
  const filePath = normalizeText(record.filePath, 1024);
  if (filePath) entry.filePath = filePath;
  const contentHash = normalizeText(record.contentHash, 120);
  if (contentHash) entry.contentHash = contentHash;
  const entryResourceSignature =
    normalizeText(record.resourceSignature, 4096) ||
    normalizeText(resourceSignature, 4096);
  if (entryResourceSignature) entry.resourceSignature = entryResourceSignature;
  return entry;
}

function normalizePaperContext(value: unknown): Partial<PaperContextRef> {
  const record = normalizeRecord(value);
  const itemId = normalizePositiveInt(record.itemId);
  const contextItemId = normalizePositiveInt(record.contextItemId);
  const title = normalizeText(record.title, 120);
  const firstCreator = normalizeText(record.firstCreator, 80);
  const year = normalizeText(record.year, 16);
  return {
    itemId,
    contextItemId,
    title: title || undefined,
    firstCreator: firstCreator || undefined,
    year: year || undefined,
  };
}

function collectRequestPaperContexts(
  request: AgentRuntimeRequest,
): PaperContextRef[] {
  return [
    ...(request.selectedTextPaperContexts || []).filter(
      (entry): entry is PaperContextRef => Boolean(entry),
    ),
    ...(request.selectedPaperContexts || []),
    ...(request.fullTextPaperContexts || []),
    ...(request.pinnedPaperContexts || []),
  ];
}

function targetFromRecord(value: unknown): {
  itemId?: number;
  contextItemId?: number;
  title?: string;
} {
  const record = normalizeRecord(value);
  const paperContext = normalizePaperContext(record.paperContext);
  return {
    itemId: normalizePositiveInt(record.itemId) || paperContext.itemId,
    contextItemId:
      normalizePositiveInt(record.contextItemId) || paperContext.contextItemId,
    title: normalizeText(record.title, 120) || paperContext.title,
  };
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

function snippetFromRecord(value: unknown): AgentEvidenceSnippet | null {
  const record = normalizeRecord(value);
  const text = normalizeEvidenceText(record.text);
  if (!text) return null;
  const snippet: AgentEvidenceSnippet = { text };
  const sourceLabel = normalizeText(record.sourceLabel, 80);
  if (sourceLabel) snippet.sourceLabel = sourceLabel;
  const citationLabel = normalizeText(record.citationLabel, 80);
  if (citationLabel) snippet.citationLabel = citationLabel;
  const sectionLabel = normalizeText(record.sectionLabel, 120);
  if (sectionLabel) snippet.sectionLabel = sectionLabel;
  const pageLabel = normalizeText(record.pageLabel, 40);
  if (pageLabel) snippet.pageLabel = pageLabel;
  const chunkKind = normalizeText(record.chunkKind, 40);
  if (chunkKind) snippet.chunkKind = chunkKind;
  const chunkIndex = normalizePositiveInt(record.chunkIndex);
  if (chunkIndex !== undefined) snippet.chunkIndex = chunkIndex;
  const score = normalizeNumber(record.score);
  if (score !== undefined) snippet.score = score;
  return snippet;
}

function targetFromPaperContext(value: unknown): {
  itemId?: number;
  contextItemId?: number;
  title?: string;
} {
  const paperContext = normalizePaperContext(value);
  return {
    itemId: paperContext.itemId,
    contextItemId: paperContext.contextItemId,
    title: paperContext.title,
  };
}

function buildPaperReadEvidenceEntries(
  activity: AgentCacheEvidenceActivity,
): AgentEvidenceEntry[] {
  const content = normalizeRecord(activity.content);
  const mode = normalizeText(content.mode, 40) || "overview";
  const detail = buildReadDetail(activity.toolName, activity.input);
  const entries: AgentEvidenceEntry[] = [];
  if (mode === "targeted" && Array.isArray(content.papers)) {
    for (const paper of content.papers) {
      const record = normalizeRecord(paper);
      const target = targetFromPaperContext(record.paperContext);
      const passages = Array.isArray(record.passages) ? record.passages : [];
      const snippets = passages
        .map(snippetFromRecord)
        .filter((entry): entry is AgentEvidenceSnippet => Boolean(entry))
        .slice(0, MAX_SNIPPETS_PER_ENTRY);
      if (!snippets.length) continue;
      const sourceKind = normalizeText(record.sourceKind, 60) || "paper_text";
      entries.push({
        key: buildEvidenceKey(activity.toolName, target, detail, snippets),
        toolName: activity.toolName,
        label: activity.toolLabel || "Read Paper",
        targetLabel: formatTargetLabel(target),
        detail,
        sourceKind,
        itemId: target.itemId,
        contextItemId: target.contextItemId,
        title: target.title,
        snippets,
        contentHash: hashText(stableJson(snippets)),
        count: 1,
        firstSeenAt: activity.timestamp,
        lastSeenAt: activity.timestamp,
      });
    }
    return entries;
  }

  if (Array.isArray(content.results)) {
    for (const result of content.results) {
      const record = normalizeRecord(result);
      const target = targetFromPaperContext(record.paperContext);
      const snippet = snippetFromRecord(record);
      if (!snippet) continue;
      const sourceKind =
        normalizeText(record.sourceKind, 60) ||
        (mode === "overview" ? "paper_overview" : "paper_text");
      entries.push({
        key: buildEvidenceKey(activity.toolName, target, detail, [snippet]),
        toolName: activity.toolName,
        label: activity.toolLabel || "Read Paper",
        targetLabel: formatTargetLabel(target),
        detail,
        sourceKind,
        itemId: target.itemId,
        contextItemId: target.contextItemId,
        title: target.title,
        snippets: [snippet],
        contentHash: hashText(stableJson(snippet)),
        count: 1,
        firstSeenAt: activity.timestamp,
        lastSeenAt: activity.timestamp,
      });
    }
  }
  return entries;
}

function buildFileIoEvidenceEntry(
  activity: AgentCacheEvidenceActivity,
): AgentEvidenceEntry | null {
  const input = normalizeRecord(activity.input);
  if (input.action !== "read") return null;
  const filePath = normalizeText(input.filePath, 1024);
  if (!filePath || !isLikelyMineruReadPath(filePath)) return null;
  const target = findMineruPaperTarget(filePath, activity.request);
  const text =
    typeof activity.content === "string"
      ? normalizeEvidenceText(activity.content)
      : normalizeEvidenceText(normalizeRecord(activity.content).content);
  const snippets = text ? [{ text }] : [];
  const offset = normalizePositiveInt(input.offset);
  const length = normalizePositiveInt(input.length);
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
    sourceKind: "mineru_file",
    itemId: target.itemId,
    contextItemId: target.contextItemId,
    title: target.title,
    filePath,
    snippets,
    contentHash: text ? hashText(text) : undefined,
    count: 1,
    firstSeenAt: activity.timestamp,
    lastSeenAt: activity.timestamp,
  };
}

function buildGenericReadEvidenceEntries(
  activity: AgentCacheEvidenceActivity,
): AgentEvidenceEntry[] {
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
    title: target.title,
    snippets: collectGenericSnippets(activity.content),
    contentHash: hashText(stableJson(activity.content ?? "")),
    count: 1,
    firstSeenAt: activity.timestamp,
    lastSeenAt: activity.timestamp,
  }));
}

function collectGenericSnippets(content: unknown): AgentEvidenceSnippet[] {
  const record = normalizeRecord(content);
  const candidates: unknown[] = [];
  if (Array.isArray(record.results)) candidates.push(...record.results);
  if (Array.isArray(record.pages)) candidates.push(...record.pages);
  if (Array.isArray(record.chunks)) candidates.push(...record.chunks);
  if (candidates.length) {
    return candidates
      .map(snippetFromRecord)
      .filter((entry): entry is AgentEvidenceSnippet => Boolean(entry))
      .slice(0, MAX_SNIPPETS_PER_ENTRY);
  }
  const text =
    typeof content === "string"
      ? normalizeEvidenceText(content)
      : normalizeEvidenceText(record.text || record.content || record.summary);
  return text ? [{ text }] : [];
}

function buildEvidenceKey(
  toolName: string,
  target: { itemId?: number; contextItemId?: number; title?: string },
  detail: string | undefined,
  snippets: AgentEvidenceSnippet[],
): string {
  return [
    toolName,
    target.itemId || "",
    target.contextItemId || "",
    target.title || "",
    detail || "",
    hashText(stableJson(snippets)),
  ].join(":");
}

function buildEvidenceEntries(
  activity: AgentCacheEvidenceActivity,
): AgentEvidenceEntry[] {
  if (activity.toolName === "file_io") {
    const entry = buildFileIoEvidenceEntry(activity);
    return entry ? [entry] : [];
  }
  if (activity.toolName === "paper_read") {
    const entries = buildPaperReadEvidenceEntries(activity);
    if (entries.length) return entries;
  }
  return buildGenericReadEvidenceEntries(activity);
}

function mergeSnippets(
  existing: AgentEvidenceSnippet[],
  incoming: AgentEvidenceSnippet[],
): AgentEvidenceSnippet[] {
  const seen = new Set(
    existing.map((snippet) => hashText(stableJson(snippet))),
  );
  const merged = [...existing];
  for (const snippet of incoming) {
    const key = hashText(stableJson(snippet));
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(snippet);
    if (merged.length >= MAX_SNIPPETS_PER_ENTRY) break;
  }
  return merged;
}

function upsertEvidenceEntry(
  ledger: Map<string, AgentEvidenceEntry>,
  entry: AgentEvidenceEntry,
): void {
  const existing = ledger.get(entry.key);
  if (existing) {
    existing.count += 1;
    existing.lastSeenAt = Math.max(existing.lastSeenAt, entry.lastSeenAt);
    existing.snippets = mergeSnippets(existing.snippets, entry.snippets);
    existing.resourceSignature =
      entry.resourceSignature || existing.resourceSignature;
    return;
  }
  ledger.set(entry.key, entry);
  if (ledger.size <= MAX_EVIDENCE_ENTRIES) return;
  const oldest = Array.from(ledger.values()).sort(
    (a, b) => a.lastSeenAt - b.lastSeenAt,
  )[0];
  if (oldest) ledger.delete(oldest.key);
}

async function persistEvidenceLedger(
  conversationKey: number,
  ledger: Map<string, AgentEvidenceEntry>,
): Promise<void> {
  const dbReady = await ensureAgentEvidenceStore();
  const db = getDb();
  if (!dbReady || !db) return;
  const entries = Array.from(ledger.values())
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_EVIDENCE_ENTRIES);
  try {
    for (const entry of entries) {
      await db.queryAsync(
        `INSERT INTO ${EVIDENCE_TABLE}
          (conversation_key, evidence_key, resource_signature, entry_json, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_key, evidence_key) DO UPDATE SET
           resource_signature = excluded.resource_signature,
           entry_json = excluded.entry_json,
           first_seen_at = excluded.first_seen_at,
           last_seen_at = excluded.last_seen_at`,
        [
          conversationKey,
          entry.key,
          entry.resourceSignature || null,
          stableJson(entry),
          entry.firstSeenAt,
          entry.lastSeenAt,
        ],
      );
    }
    await db.queryAsync(
      `DELETE FROM ${EVIDENCE_TABLE}
       WHERE conversation_key = ?
         AND evidence_key NOT IN (
           SELECT evidence_key
           FROM ${EVIDENCE_TABLE}
           WHERE conversation_key = ?
           ORDER BY last_seen_at DESC
           LIMIT ?
         )`,
      [conversationKey, conversationKey, MAX_EVIDENCE_ENTRIES],
    );
  } catch (error) {
    logEvidenceStoreError("LLM Agent: Failed to persist evidence cache", error);
  }
}

export async function hydrateAgentEvidenceCache(
  conversationKeyValue: number,
): Promise<void> {
  const conversationKey = normalizePositiveInt(conversationKeyValue);
  if (!conversationKey) return;
  const key = lifecycleKey(conversationKey);
  if (hydratedConversations.has(key)) return;
  const dbReady = await ensureAgentEvidenceStore();
  const db = getDb();
  if (!dbReady || !db) return;
  try {
    const rows = (await db.queryAsync(
      `SELECT entry_json AS entryJson,
              resource_signature AS resourceSignature
       FROM ${EVIDENCE_TABLE}
       WHERE conversation_key = ?
       ORDER BY last_seen_at DESC
       LIMIT ?`,
      [conversationKey, MAX_EVIDENCE_ENTRIES],
    )) as
      | Array<{
          entryJson?: unknown;
          resourceSignature?: unknown;
        }>
      | undefined;
    const ledger = ensureLedgerForConversation(conversationKey);
    for (const row of rows || []) {
      const entryJson = typeof row.entryJson === "string" ? row.entryJson : "";
      if (!entryJson) continue;
      try {
        const entry = deserializeEvidenceEntry(
          JSON.parse(entryJson) as unknown,
          typeof row.resourceSignature === "string"
            ? row.resourceSignature
            : undefined,
        );
        if (entry) upsertEvidenceEntry(ledger, entry);
      } catch {
        // Ignore malformed evidence rows; future successful reads will refresh them.
      }
    }
    hydratedConversations.add(key);
  } catch (error) {
    logEvidenceStoreError("LLM Agent: Failed to hydrate evidence cache", error);
  }
}

export async function clearPersistedAgentEvidence(
  conversationKeyValue?: number,
): Promise<void> {
  if (conversationKeyValue === undefined) {
    evidenceLedger.clear();
    hydratedConversations.clear();
  } else {
    const conversationKey = normalizePositiveInt(conversationKeyValue);
    if (conversationKey) {
      evidenceLedger.delete(lifecycleKey(conversationKey));
      hydratedConversations.delete(lifecycleKey(conversationKey));
    }
  }
  const dbReady = await ensureAgentEvidenceStore();
  const db = getDb();
  if (!dbReady || !db) return;
  try {
    if (conversationKeyValue === undefined) {
      await db.queryAsync(`DELETE FROM ${EVIDENCE_TABLE}`);
      return;
    }
    const conversationKey = normalizePositiveInt(conversationKeyValue);
    if (!conversationKey) return;
    await db.queryAsync(
      `DELETE FROM ${EVIDENCE_TABLE} WHERE conversation_key = ?`,
      [conversationKey],
    );
  } catch (error) {
    logEvidenceStoreError("LLM Agent: Failed to clear evidence cache", error);
  }
}

export async function commitAgentCacheEvidenceActivities(params: {
  conversationKey: number;
  activities: AgentCacheEvidenceActivity[];
  resourceSignature?: string;
}): Promise<void> {
  const conversationKey = normalizePositiveInt(params.conversationKey);
  if (!conversationKey || !params.activities.length) return;
  const ledger = ensureLedgerForConversation(conversationKey);
  const resourceSignature = normalizeText(params.resourceSignature, 4096);
  for (const activity of params.activities) {
    for (const entry of buildEvidenceEntries(activity)) {
      if (resourceSignature) entry.resourceSignature = resourceSignature;
      upsertEvidenceEntry(ledger, entry);
    }
  }
  await persistEvidenceLedger(conversationKey, ledger);
}

export function clearAgentEvidenceCache(): void {
  evidenceLedger.clear();
  hydratedConversations.clear();
}

function truncateMiddle(value: string, maxLength = 96): string {
  if (value.length <= maxLength) return value;
  const head = value.slice(0, Math.floor(maxLength / 2) - 2);
  const tail = value.slice(value.length - Math.floor(maxLength / 2) + 1);
  return `${head}...${tail}`;
}

function truncateSnippet(value: string): string {
  if (value.length <= MAX_RENDERED_SNIPPET_CHARS) return value;
  return `${value.slice(0, MAX_RENDERED_SNIPPET_CHARS).trimEnd()}...`;
}

function formatSnippet(snippet: AgentEvidenceSnippet, index: number): string {
  const metadata = [
    snippet.sourceLabel ? `source=${snippet.sourceLabel}` : "",
    snippet.pageLabel ? `page=${snippet.pageLabel}` : "",
    snippet.sectionLabel ? `section=${snippet.sectionLabel}` : "",
    snippet.chunkIndex !== undefined ? `chunk=${snippet.chunkIndex}` : "",
  ].filter(Boolean);
  const prefix = metadata.length
    ? `  ${index + 1}. [${metadata.join(", ")}]`
    : `  ${index + 1}.`;
  return `${prefix} ${truncateSnippet(snippet.text)}`;
}

function formatEvidenceEntry(entry: AgentEvidenceEntry): string[] {
  const pieces = [entry.label];
  if (entry.targetLabel) pieces.push(entry.targetLabel);
  if (entry.detail) pieces.push(entry.detail);
  if (entry.sourceKind) pieces.push(`sourceKind=${entry.sourceKind}`);
  if (entry.filePath) pieces.push(`path=${truncateMiddle(entry.filePath)}`);
  if (entry.count > 1) pieces.push(`${entry.count}x`);
  const lines = [`- ${pieces.join(" - ")}`];
  if (entry.snippets.length) {
    lines.push(
      ...entry.snippets
        .slice(0, MAX_SNIPPETS_PER_ENTRY)
        .map((snippet, index) => formatSnippet(snippet, index)),
    );
  }
  return lines;
}

function buildRequestEvidenceScope(request: AgentRuntimeRequest): {
  paperKeys: Set<string>;
  itemIds: Set<number>;
  contextItemIds: Set<number>;
  titles: Set<string>;
} {
  const paperKeys = new Set<string>();
  const itemIds = new Set<number>();
  const contextItemIds = new Set<number>();
  const titles = new Set<string>();
  const addTarget = (target: {
    itemId?: number;
    contextItemId?: number;
    title?: string;
  }) => {
    if (target.itemId) itemIds.add(target.itemId);
    if (target.contextItemId) contextItemIds.add(target.contextItemId);
    if (target.itemId && target.contextItemId) {
      paperKeys.add(`${target.itemId}:${target.contextItemId}`);
    }
    const title = normalizeText(target.title, 200).toLowerCase();
    if (title) titles.add(title);
  };
  for (const paper of collectRequestPaperContexts(request)) {
    addTarget({
      itemId: paper.itemId,
      contextItemId: paper.contextItemId,
      title: paper.title,
    });
  }
  if (request.activeItemId) addTarget({ itemId: request.activeItemId });
  return { paperKeys, itemIds, contextItemIds, titles };
}

function isEvidenceEntryRelevant(
  entry: AgentEvidenceEntry,
  params: {
    request?: AgentRuntimeRequest;
    resourceSignature?: string;
  },
): boolean {
  const hasTarget = Boolean(entry.itemId || entry.contextItemId || entry.title);
  if (hasTarget) {
    if (!params.request) return true;
    const scope = buildRequestEvidenceScope(params.request);
    if (
      entry.itemId &&
      entry.contextItemId &&
      scope.paperKeys.has(`${entry.itemId}:${entry.contextItemId}`)
    ) {
      return true;
    }
    if (entry.itemId && scope.itemIds.has(entry.itemId)) return true;
    if (entry.contextItemId && scope.contextItemIds.has(entry.contextItemId)) {
      return true;
    }
    const title = normalizeText(entry.title, 200).toLowerCase();
    return Boolean(title && scope.titles.has(title));
  }
  const currentResourceSignature = normalizeText(
    params.resourceSignature,
    4096,
  );
  if (!currentResourceSignature) return true;
  return Boolean(
    entry.resourceSignature &&
    entry.resourceSignature === currentResourceSignature,
  );
}

export function buildAgentEvidenceContextBlock(params: {
  conversationKey: number;
  request?: AgentRuntimeRequest;
  resourceSignature?: string;
}): string {
  const conversationKey = normalizePositiveInt(params.conversationKey);
  if (!conversationKey) return "";
  const ledger = ledgerForConversation(conversationKey);
  if (!ledger?.size) return "";
  const entries = Array.from(ledger.values())
    .filter((entry) => isEvidenceEntryRelevant(entry, params))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_RENDERED_EVIDENCE_ENTRIES);
  if (!entries.length) return "";
  return [
    "Preserved evidence from prior agent tool reads:",
    "Reuse this evidence when it directly answers the follow-up. Re-read only when the user asks for updated evidence, the preserved snippets are insufficient, or the resource scope changed.",
    ...entries.flatMap(formatEvidenceEntry),
  ].join("\n");
}

export function planAgentContextCache(params: {
  request: AgentRuntimeRequest;
  resourceSnapshot: unknown;
  evidenceBlock?: string;
}): ContextCachePlan {
  const contextText = stableJson({
    resourceSnapshot: params.resourceSnapshot,
    evidenceBlock: params.evidenceBlock || "",
  });
  return planContextCacheReuse({
    model: params.request.model,
    apiBase: params.request.apiBase,
    authMode: params.request.authMode,
    protocol: params.request.providerProtocol,
    mode: "full",
    strategy: "agent-evidence-full",
    contextText,
    paperContexts: params.request.selectedPaperContexts,
    fullTextPaperContexts: params.request.fullTextPaperContexts,
  });
}
