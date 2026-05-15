/**
 * Shared utilities for PDF-related tools (read_paper, search_paper,
 * view_pdf_pages, read_attachment).
 *
 * Extracted from the former monolithic inspect_pdf tool so that each
 * focused tool can reuse target resolution, caching, and multimodal
 * helpers without duplicating code.
 */
import type { ChatAttachment, PaperContextRef } from "../../../shared/types";
import { readAttachmentBytes } from "../../../modules/contextPanel/attachmentStorage";
import type {
  AgentModelContentPart,
  AgentRuntimeRequest,
  AgentToolContext,
  AgentToolDefinition,
} from "../../types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  normalizePositiveInt,
  normalizeToolPaperContext,
  validateObject,
} from "../shared";

// ---------------------------------------------------------------------------
// Target types
// ---------------------------------------------------------------------------

export type PdfTarget = {
  paperContext?: PaperContextRef;
  itemId?: number;
  contextItemId?: number;
  attachmentId?: string;
  name?: string;
};

// ---------------------------------------------------------------------------
// Target normalization
// ---------------------------------------------------------------------------

export function normalizeTarget(value: unknown): PdfTarget | undefined {
  if (!validateObject<Record<string, unknown>>(value)) return undefined;
  const paperContext = validateObject<Record<string, unknown>>(value.paperContext)
    ? normalizeToolPaperContext(value.paperContext) || undefined
    : undefined;
  return {
    paperContext,
    itemId: normalizePositiveInt(value.itemId),
    contextItemId: normalizePositiveInt(value.contextItemId),
    attachmentId:
      typeof value.attachmentId === "string" && value.attachmentId.trim()
        ? value.attachmentId.trim()
        : undefined,
    name:
      typeof value.name === "string" && value.name.trim()
        ? value.name.trim()
        : undefined,
  };
}

export function normalizeTargets(
  value: unknown,
  maxCount: number,
): PdfTarget[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const targets = value
    .map((entry) => normalizeTarget(entry))
    .filter((entry): entry is PdfTarget => Boolean(entry))
    .slice(0, maxCount);
  return targets.length ? targets : undefined;
}

function describeTarget(target: PdfTarget): string {
  const parts = [
    target.itemId ? `itemId=${target.itemId}` : "",
    target.contextItemId ? `contextItemId=${target.contextItemId}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "missing itemId/contextItemId";
}

function resolveTarget(
  target: PdfTarget,
  zoteroGateway: ZoteroGateway,
): PaperContextRef | null {
  if (target.paperContext) return target.paperContext;
  if (target.itemId || target.contextItemId) {
    return zoteroGateway.resolvePaperContextTarget({
      itemId: target.itemId,
      contextItemId: target.contextItemId,
    });
  }
  return null;
}

function dedupePaperContextRefs(
  paperContexts: PaperContextRef[],
): PaperContextRef[] {
  const out: PaperContextRef[] = [];
  const seen = new Set<string>();
  for (const paperContext of paperContexts) {
    if (
      !paperContext ||
      !Number.isFinite(paperContext.itemId) ||
      !Number.isFinite(paperContext.contextItemId)
    ) {
      continue;
    }
    const key = `${Math.floor(Number(paperContext.itemId))}:${Math.floor(
      Number(paperContext.contextItemId),
    )}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(paperContext);
  }
  return out;
}

export function describeNoDefaultPaperTarget(
  request: AgentRuntimeRequest,
): string {
  if (
    request.conversationKind === "global" ||
    request.selectedCollectionContexts?.length
  ) {
    return (
      "No paper target in library chat. Use library_search with the selected " +
      "collection and pass explicit targets to paper_read."
    );
  }
  return "No paper context available for paper_read";
}

/**
 * Resolve paper contexts from the tool input, falling back to the
 * request-level paper contexts when no explicit target is provided.
 */
export function resolveDefaultTargets(
  target: PdfTarget | undefined,
  targets: PdfTarget[] | undefined,
  context: { request: AgentRuntimeRequest },
  zoteroGateway: ZoteroGateway,
  maxCount: number,
): PaperContextRef[] {
  if (targets?.length) {
    const resolved: PaperContextRef[] = [];
    for (const explicitTarget of targets) {
      const paperContext = resolveTarget(explicitTarget, zoteroGateway);
      if (!paperContext) {
        throw new Error(
          `Could not resolve paper target ${describeTarget(explicitTarget)}`,
        );
      }
      resolved.push(paperContext);
    }
    return dedupePaperContextRefs(resolved).slice(0, maxCount);
  }
  if (target) {
    const paperContext = resolveTarget(target, zoteroGateway);
    if (!paperContext) {
      throw new Error(`Could not resolve paper target ${describeTarget(target)}`);
    }
    return [paperContext];
  }
  return dedupePaperContextRefs(
    zoteroGateway.listPaperContexts(context.request),
  ).slice(0, maxCount);
}

// ---------------------------------------------------------------------------
// PDF visual mode inference
// ---------------------------------------------------------------------------

export type PdfVisualMode = "general" | "figure" | "equation";

export function inferPdfMode(question: string | undefined): PdfVisualMode {
  const text = `${question || ""}`.toLowerCase();
  if (/\b(eq|equation|theorem|proof|formula|derivation)\b/.test(text)) {
    return "equation";
  }
  if (/\b(fig|figure|table|diagram|chart|plot|graph|panel)\b/.test(text)) {
    return "figure";
  }
  return "general";
}

// ---------------------------------------------------------------------------
// Attachment helpers
// ---------------------------------------------------------------------------

export function firstNonImageAttachment(
  attachments: ChatAttachment[] | undefined,
): ChatAttachment | null {
  const entries = Array.isArray(attachments) ? attachments : [];
  return (
    entries.find((entry) => entry.category !== "image" && Boolean(entry.storedPath)) ||
    null
  );
}

// ---------------------------------------------------------------------------
// Base64 encoding
// ---------------------------------------------------------------------------

export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, Math.min(bytes.length, index + chunkSize));
    out += String.fromCharCode(...chunk);
  }
  const btoaFn = (globalThis as typeof globalThis & { btoa?: (s: string) => string }).btoa;
  if (typeof btoaFn !== "function") throw new Error("btoa unavailable");
  return btoaFn(out);
}

// ---------------------------------------------------------------------------
// Page caches (used by view_pdf_pages)
// ---------------------------------------------------------------------------

type PreparedPdfCache = {
  pageIndexes: number[];
  contextItemId?: number;
  expiresAt: number;
};

type CapturedPdfCache = {
  pageIndex: number;
  contextItemId?: number;
  expiresAt: number;
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const preparedCache = new Map<number, PreparedPdfCache>();
const capturedCache = new Map<number, CapturedPdfCache>();

export function getCachedPrepared(conversationKey: number): PreparedPdfCache | null {
  const entry = preparedCache.get(conversationKey);
  if (!entry || Date.now() > entry.expiresAt) {
    preparedCache.delete(conversationKey);
    return null;
  }
  return entry;
}

export function getCachedCapture(conversationKey: number): CapturedPdfCache | null {
  const entry = capturedCache.get(conversationKey);
  if (!entry || Date.now() > entry.expiresAt) {
    capturedCache.delete(conversationKey);
    return null;
  }
  return entry;
}

export function setPreparedCache(
  conversationKey: number,
  pageIndexes: number[],
  contextItemId?: number,
): void {
  preparedCache.set(conversationKey, {
    pageIndexes,
    contextItemId,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

export function setCapturedCache(
  conversationKey: number,
  pageIndex: number,
  contextItemId?: number,
): void {
  capturedCache.set(conversationKey, {
    pageIndex,
    contextItemId,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

export function clearPdfToolCaches(conversationKey: number): void {
  preparedCache.delete(conversationKey);
  capturedCache.delete(conversationKey);
}

// ---------------------------------------------------------------------------
// Page selection helpers
// ---------------------------------------------------------------------------

export function samePageSet(
  left: number[] | undefined,
  right: number[] | undefined,
): boolean {
  const a = Array.from(new Set(left || [])).sort((x, y) => x - y);
  const b = Array.from(new Set(right || [])).sort((x, y) => x - y);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// ---------------------------------------------------------------------------
// Multimodal followup for capture_active_view
// ---------------------------------------------------------------------------

export async function buildCaptureFollowupMessage(result: {
  ok: boolean;
  artifacts?: unknown;
  content: unknown;
}) {
  if (!result.ok) return null;
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
  if (!artifacts.length) return null;

  const content = result.content as {
    pageLabel?: string;
    pageText?: string;
  } | null;
  const pageLabel =
    typeof content?.pageLabel === "string" ? content.pageLabel : null;
  const pageText =
    typeof content?.pageText === "string" && content.pageText.trim()
      ? content.pageText.trim()
      : null;

  const headerLines = [
    pageLabel
      ? `[Reader page ${pageLabel} — extracted text and image below]`
      : "[Reader page — extracted text and image below]",
    "Answer the user's question using ONLY the content shown below.",
    "Do not use prior knowledge or training data about this paper.",
  ];

  const textSection = pageText
    ? `\n\nExtracted page text:\n"""\n${pageText}\n"""`
    : "";

  const parts: AgentModelContentPart[] = [
    {
      type: "text",
      text: headerLines.join(" ") + textSection,
    },
  ];

  for (const artifact of artifacts) {
    if (
      !artifact ||
      typeof artifact !== "object" ||
      (artifact as { kind?: unknown }).kind !== "image"
    ) {
      continue;
    }
    const image = artifact as {
      storedPath?: string;
      mimeType?: string;
    };
    if (!image.storedPath || !image.mimeType) continue;
    const bytes = await readAttachmentBytes(image.storedPath);
    parts.push({
      type: "image_url",
      image_url: {
        url: `data:${image.mimeType};base64,${encodeBase64(bytes)}`,
        detail: "high",
      },
    });
  }
  return {
    role: "user" as const,
    content: parts,
  };
}
