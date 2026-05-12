import type { PaperContextRef } from "../shared/types";
import type { ZoteroMcpToolActivityEvent } from "../agent/mcp/server";

const MAX_LEDGER_ENTRIES = 12;
const MAX_RENDERED_LEDGER_ENTRIES = 8;
const READ_TOOL_NAMES = new Set([
  "paper_read",
  "read_paper",
  "search_paper",
  "view_pdf_pages",
  "read_attachment",
]);

type NativeContextLedgerScope = {
  profileSignature?: string;
  conversationKey: number;
  kind: "global" | "paper";
  libraryID?: number;
  paperItemID?: number;
  activeItemId?: number;
  activeContextItemId?: number;
  paperTitle?: string;
  paperContext?: PaperContextRef;
};

type NativeReadLedgerEntry = {
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

type NormalizedPaperContext = Partial<PaperContextRef>;

const readLedger = new Map<string, Map<string, NativeReadLedgerEntry>>();

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

function ledgerKey(params: {
  profileSignature?: string;
  conversationKey: number;
  threadId: string;
}): string {
  return [
    normalizeText(params.profileSignature, 128) || "default-profile",
    normalizePositiveInt(params.conversationKey) || 0,
    normalizeText(params.threadId, 256),
  ].join(":");
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
): NormalizedPaperContext | undefined {
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

function defaultScopeTarget(scope: NativeContextLedgerScope): {
  itemId?: number;
  contextItemId?: number;
  title?: string;
} {
  return {
    itemId:
      scope.paperContext?.itemId || scope.paperItemID || scope.activeItemId,
    contextItemId:
      scope.paperContext?.contextItemId || scope.activeContextItemId,
    title: scope.paperContext?.title || scope.paperTitle,
  };
}

function extractTargets(
  args: unknown,
  scope: NativeContextLedgerScope,
): Array<{ itemId?: number; contextItemId?: number; title?: string }> {
  const record = normalizeRecord(args);
  const rawTargets = Array.isArray(record.targets) ? record.targets : [];
  const targets = rawTargets
    .map(targetFromRecord)
    .filter((target) =>
      Boolean(target.itemId || target.contextItemId || target.title),
    );
  const target = targetFromRecord(record.target);
  if (target.itemId || target.contextItemId || target.title)
    targets.push(target);
  if (targets.length) return targets;
  const fallback = defaultScopeTarget(scope);
  return fallback.itemId || fallback.contextItemId || fallback.title
    ? [fallback]
    : [];
}

function fileNameForPath(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function isLikelyMineruReadPath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  if (!normalized.includes("mineru")) return false;
  return (
    /\.(?:md|json)$/i.test(filePath) ||
    /\.(?:png|jpe?g|gif|webp|svg)$/i.test(filePath)
  );
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

function buildFileIoEntry(params: {
  args: unknown;
  scope: NativeContextLedgerScope;
  timestamp: number;
}): NativeReadLedgerEntry | null {
  const record = normalizeRecord(params.args);
  if (record.action !== "read") return null;
  const filePath = normalizeText(record.filePath, 1024);
  if (!filePath || !isLikelyMineruReadPath(filePath)) return null;
  const target = defaultScopeTarget(params.scope);
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
    firstSeenAt: params.timestamp,
    lastSeenAt: params.timestamp,
  };
}

function buildToolEntries(params: {
  event: ZoteroMcpToolActivityEvent;
  scope: NativeContextLedgerScope;
}): NativeReadLedgerEntry[] {
  const timestamp = params.event.timestamp || Date.now();
  if (params.event.toolName === "file_io") {
    const entry = buildFileIoEntry({
      args: params.event.arguments,
      scope: params.scope,
      timestamp,
    });
    return entry ? [entry] : [];
  }
  if (!READ_TOOL_NAMES.has(params.event.toolName)) return [];
  const detail = buildReadDetail(params.event.toolName, params.event.arguments);
  const targets = extractTargets(params.event.arguments, params.scope);
  const effectiveTargets = targets.length
    ? targets
    : [defaultScopeTarget(params.scope)];
  return effectiveTargets.map((target, index) => ({
    key: [
      params.event.toolName,
      target.itemId || "",
      target.contextItemId || "",
      target.title || "",
      detail || "",
      index,
    ].join(":"),
    toolName: params.event.toolName,
    label: params.event.toolLabel || params.event.toolName.replace(/_/g, " "),
    targetLabel: formatTargetLabel(target),
    detail,
    itemId: target.itemId,
    contextItemId: target.contextItemId,
    count: 1,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
  }));
}

function upsertEntry(
  ledger: Map<string, NativeReadLedgerEntry>,
  entry: NativeReadLedgerEntry,
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

export function clearCodexNativeReadLedger(): void {
  readLedger.clear();
}

export function recordCodexNativeReadActivity(params: {
  threadId: string;
  scope: NativeContextLedgerScope;
  event: ZoteroMcpToolActivityEvent;
}): void {
  if (params.event.phase !== "completed" || params.event.ok !== true) return;
  const threadId = normalizeText(params.threadId, 256);
  if (!threadId) return;
  const conversationKey = normalizePositiveInt(params.scope.conversationKey);
  if (!conversationKey) return;
  const entries = buildToolEntries({
    event: params.event,
    scope: params.scope,
  });
  if (!entries.length) return;
  const key = ledgerKey({
    profileSignature: params.scope.profileSignature,
    conversationKey,
    threadId,
  });
  let ledger = readLedger.get(key);
  if (!ledger) {
    ledger = new Map();
    readLedger.set(key, ledger);
  }
  for (const entry of entries) upsertEntry(ledger, entry);
}

function truncateMiddle(value: string, maxLength = 96): string {
  if (value.length <= maxLength) return value;
  const head = value.slice(0, Math.floor(maxLength / 2) - 2);
  const tail = value.slice(value.length - Math.floor(maxLength / 2) + 1);
  return `${head}...${tail}`;
}

function formatLedgerLine(entry: NativeReadLedgerEntry): string {
  const pieces = [entry.label];
  if (entry.targetLabel) pieces.push(entry.targetLabel);
  if (entry.detail) pieces.push(entry.detail);
  if (entry.filePath) pieces.push(`path=${truncateMiddle(entry.filePath)}`);
  if (entry.count > 1) pieces.push(`${entry.count}x`);
  return `- ${pieces.join(" - ")}`;
}

export function buildCodexNativePriorReadContextBlock(params: {
  profileSignature?: string;
  conversationKey: number;
  threadId?: string;
}): string {
  const threadId = normalizeText(params.threadId, 256);
  if (!threadId) return "";
  const key = ledgerKey({
    profileSignature: params.profileSignature,
    conversationKey: params.conversationKey,
    threadId,
  });
  const ledger = readLedger.get(key);
  if (!ledger?.size) return "";
  const entries = Array.from(ledger.values())
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_RENDERED_LEDGER_ENTRIES);
  return [
    "Already inspected in this Codex thread:",
    ...entries.map(formatLedgerLine),
  ].join("\n");
}
