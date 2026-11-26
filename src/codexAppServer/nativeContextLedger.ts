import type { PaperContextRef } from "../shared/types";
import type { ZoteroMcpToolActivityEvent } from "../agent/mcp/server";
import {
  areConversationWritesFrozen,
  isConversationWriteGenerationCurrent,
} from "../shared/conversationWriteFence";
import { SINGLE_PAPER_READ_TOOL_NAMES } from "../agent/context/toolNames";
import { positiveIntOrUndefined, recordOrEmpty } from "../core/values";
import {
  buildReadDetail,
  fileNameForPath,
  formatTargetLabel,
  isLikelyMineruReadPath,
  truncateMiddle,
} from "../agent/context/cacheManagement";

const MAX_LEDGER_ENTRIES = 12;
const MAX_RENDERED_LEDGER_ENTRIES = 8;

type NativeContextLedgerScope = {
  profileSignature?: string;
  conversationKey: number;
  instanceID?: string;
  conversationGeneration?: number;
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

function ledgerKey(params: {
  profileSignature?: string;
  conversationKey: number;
  instanceID?: string;
  threadId: string;
}): string {
  return [
    normalizeText(params.profileSignature, 128) || "default-profile",
    positiveIntOrUndefined(params.conversationKey) || 0,
    normalizeText(params.instanceID, 128),
    normalizeText(params.threadId, 256),
  ].join(":");
}

function normalizePaperContext(
  value: unknown,
): NormalizedPaperContext | undefined {
  const record = recordOrEmpty(value);
  const itemId = positiveIntOrUndefined(record.itemId);
  const contextItemId = positiveIntOrUndefined(record.contextItemId);
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
  const record = recordOrEmpty(value);
  const paperContext = normalizePaperContext(record.paperContext);
  return {
    itemId: positiveIntOrUndefined(record.itemId) || paperContext?.itemId,
    contextItemId:
      positiveIntOrUndefined(record.contextItemId) ||
      positiveIntOrUndefined(record.attachmentId) ||
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
  const record = recordOrEmpty(args);
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

function buildFileIoEntry(params: {
  args: unknown;
  scope: NativeContextLedgerScope;
  timestamp: number;
}): NativeReadLedgerEntry | null {
  const record = recordOrEmpty(params.args);
  if (record.action !== "read") return null;
  const filePath = normalizeText(record.filePath, 1024);
  if (!filePath || !isLikelyMineruReadPath(filePath)) return null;
  const target = defaultScopeTarget(params.scope);
  const offset = positiveIntOrUndefined(record.offset);
  const length = positiveIntOrUndefined(record.length);
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
  // Events come only from the MCP server, which never exposes a retired
  // primitive, so facade names are the whole vocabulary here.
  if (!SINGLE_PAPER_READ_TOOL_NAMES.has(params.event.toolName)) return [];
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

export function clearCodexNativeReadLedgerForConversation(params: {
  conversationKey: number;
  instanceID?: string;
  profileSignature?: string;
}): void {
  const conversationKey = positiveIntOrUndefined(params.conversationKey);
  if (!conversationKey) return;
  const profile = normalizeText(params.profileSignature, 128);
  const instanceID = normalizeText(params.instanceID, 128);
  for (const key of readLedger.keys()) {
    const parts = key.split(":");
    const sameConversation =
      parts[1] === String(conversationKey) &&
      (!profile || parts[0] === profile);
    const sameInstance =
      !instanceID || parts[2] === instanceID || parts[2] === "";
    if (sameConversation && sameInstance) {
      readLedger.delete(key);
    }
  }
}

export function recordCodexNativeReadActivity(params: {
  threadId: string;
  scope: NativeContextLedgerScope;
  event: ZoteroMcpToolActivityEvent;
}): void {
  if (params.event.phase !== "completed" || params.event.ok !== true) return;
  const threadId = normalizeText(params.threadId, 256);
  if (!threadId) return;
  const conversationKey = positiveIntOrUndefined(params.scope.conversationKey);
  if (!conversationKey) return;
  if (
    areConversationWritesFrozen(conversationKey) ||
    (Number.isFinite(params.scope.conversationGeneration) &&
      !isConversationWriteGenerationCurrent(
        conversationKey,
        Number(params.scope.conversationGeneration),
      ))
  ) {
    return;
  }
  const entries = buildToolEntries({
    event: params.event,
    scope: params.scope,
  });
  if (!entries.length) return;
  const key = ledgerKey({
    profileSignature: params.scope.profileSignature,
    conversationKey,
    instanceID: params.scope.instanceID,
    threadId,
  });
  let ledger = readLedger.get(key);
  if (!ledger) {
    ledger = new Map();
    readLedger.set(key, ledger);
  }
  for (const entry of entries) upsertEntry(ledger, entry);
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
  instanceID?: string;
  threadId?: string;
}): string {
  const threadId = normalizeText(params.threadId, 256);
  if (!threadId) return "";
  const key = ledgerKey({
    profileSignature: params.profileSignature,
    conversationKey: params.conversationKey,
    instanceID: params.instanceID,
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
