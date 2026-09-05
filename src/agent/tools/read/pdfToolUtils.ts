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
import { getTurnPaperScopeFromRequest } from "../../context/requestTurnPaperScope";
import { getActiveTurnPaper } from "../../context/turnPaperScope";
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

export type PaperTargetSelector = Readonly<
  Pick<PdfTarget, "paperContext" | "itemId" | "contextItemId">
>;

export type VisualPaperTargetSelector = Readonly<{
  paperSelector?: PaperTargetSelector;
  attachmentId?: string;
  name?: string;
}>;

export type ExplicitTargetErrorCode =
  | "conflicting_target_arguments"
  | "empty_target_entry"
  | "unsupported_target_selector"
  | "selector_not_supported_for_mode"
  | "unresolvable_target"
  | "conflicting_paper_identity";

export type ExplicitTargetSyntaxResult =
  | Readonly<{ kind: "omitted" }>
  | Readonly<{
      kind: "paper_selectors";
      selectors: readonly PaperTargetSelector[];
    }>
  | Readonly<{
      kind: "visual_selector";
      selector: VisualPaperTargetSelector;
    }>
  | Readonly<{
      kind: "invalid";
      code: ExplicitTargetErrorCode;
      message: string;
    }>;

export class ExplicitPaperTargetError extends Error {
  constructor(
    readonly code: Extract<
      ExplicitTargetErrorCode,
      "unresolvable_target" | "conflicting_paper_identity"
    >,
    message: string,
  ) {
    super(message);
    this.name = "ExplicitPaperTargetError";
  }
}

// ---------------------------------------------------------------------------
// Target normalization
// ---------------------------------------------------------------------------

export function normalizeTarget(value: unknown): PdfTarget | undefined {
  if (!validateObject<Record<string, unknown>>(value)) return undefined;
  const paperContext = validateObject<Record<string, unknown>>(
    value.paperContext,
  )
    ? normalizeToolPaperContext(value.paperContext) || undefined
    : undefined;
  const target: PdfTarget = {
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
  return target.paperContext ||
    target.itemId ||
    target.contextItemId ||
    target.attachmentId ||
    target.name
    ? target
    : undefined;
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

const PAPER_TARGET_FIELDS = new Set([
  "paperContext",
  "itemId",
  "contextItemId",
]);
const VISUAL_TARGET_FIELDS = new Set([
  ...PAPER_TARGET_FIELDS,
  "attachmentId",
  "name",
]);

function invalidTargetSyntax(
  code: Exclude<
    ExplicitTargetErrorCode,
    "unresolvable_target" | "conflicting_paper_identity"
  >,
  message: string,
): ExplicitTargetSyntaxResult {
  return { kind: "invalid", code, message };
}

function hasUnsupportedFields(
  value: Record<string, unknown>,
  supported: ReadonlySet<string>,
): boolean {
  return Object.keys(value).some((key) => !supported.has(key));
}

function toPaperTargetSelector(
  value: Record<string, unknown>,
): PaperTargetSelector | null {
  const normalized = normalizeTarget(value);
  if (
    !normalized ||
    (!normalized.paperContext &&
      !normalized.itemId &&
      !normalized.contextItemId)
  ) {
    return null;
  }
  return {
    paperContext: normalized.paperContext,
    itemId: normalized.itemId,
    contextItemId: normalized.contextItemId,
  };
}

/**
 * Normalize model-generated paper_read selector syntax without resolving
 * Zotero identity. Exactly-empty target objects remain a compatibility alias
 * for an omitted target, while non-empty malformed selectors fail closed.
 */
export function normalizeExplicitTargetSyntax(params: {
  targetProvided: boolean;
  target: unknown;
  targetsProvided: boolean;
  targets: unknown;
  mode: "paper" | "visual";
  maxCount: number;
}): ExplicitTargetSyntaxResult {
  if (params.targetProvided && params.targetsProvided) {
    return invalidTargetSyntax(
      "conflicting_target_arguments",
      "Provide either target or targets, not both.",
    );
  }

  if (params.targetsProvided) {
    if (params.mode === "visual") {
      return invalidTargetSyntax(
        "selector_not_supported_for_mode",
        "Visual and capture reads accept one target selector, not targets.",
      );
    }
    if (!Array.isArray(params.targets)) {
      return invalidTargetSyntax(
        "unsupported_target_selector",
        "targets must be an array of paper selectors.",
      );
    }
    if (!params.targets.length) return { kind: "omitted" };
    const selectors: PaperTargetSelector[] = [];
    for (const [index, entry] of params.targets.entries()) {
      if (!validateObject<Record<string, unknown>>(entry)) {
        return invalidTargetSyntax(
          "unsupported_target_selector",
          `targets[${index}] must be an object.`,
        );
      }
      if (!Object.keys(entry).length) {
        return invalidTargetSyntax(
          "empty_target_entry",
          `targets[${index}] must identify a paper.`,
        );
      }
      if (hasUnsupportedFields(entry, PAPER_TARGET_FIELDS)) {
        return invalidTargetSyntax(
          "unsupported_target_selector",
          `targets[${index}] contains an unsupported paper selector.`,
        );
      }
      const selector = toPaperTargetSelector(entry);
      if (!selector) {
        return invalidTargetSyntax(
          "unsupported_target_selector",
          `targets[${index}] must include paperContext, itemId, or contextItemId.`,
        );
      }
      if (selectors.length < params.maxCount) selectors.push(selector);
    }
    return { kind: "paper_selectors", selectors };
  }

  if (!params.targetProvided) return { kind: "omitted" };
  if (!validateObject<Record<string, unknown>>(params.target)) {
    return invalidTargetSyntax(
      "unsupported_target_selector",
      "target must be an object.",
    );
  }
  if (!Object.keys(params.target).length) return { kind: "omitted" };
  if (hasUnsupportedFields(params.target, VISUAL_TARGET_FIELDS)) {
    return invalidTargetSyntax(
      "unsupported_target_selector",
      "target contains an unsupported selector.",
    );
  }
  const normalized = normalizeTarget(params.target);
  if (!normalized) {
    return invalidTargetSyntax(
      "unsupported_target_selector",
      "target must include a supported paper or visual selector.",
    );
  }
  const hasVisualSelector = Boolean(normalized.attachmentId || normalized.name);
  if (hasVisualSelector) {
    if (params.mode !== "visual") {
      return invalidTargetSyntax(
        "selector_not_supported_for_mode",
        "attachmentId and name selectors are supported only for visual or capture reads.",
      );
    }
    const paperSelector = toPaperTargetSelector(params.target) || undefined;
    return {
      kind: "visual_selector",
      selector: {
        paperSelector,
        attachmentId: normalized.attachmentId,
        name: normalized.name,
      },
    };
  }
  const selector = toPaperTargetSelector(params.target);
  if (!selector) {
    return invalidTargetSyntax(
      "unsupported_target_selector",
      "target must include paperContext, itemId, or contextItemId.",
    );
  }
  return params.mode === "visual"
    ? {
        kind: "visual_selector",
        selector: { paperSelector: selector },
      }
    : { kind: "paper_selectors", selectors: [selector] };
}

function describeTarget(target: PdfTarget): string {
  const parts = [
    target.itemId || target.paperContext?.itemId
      ? `itemId=${target.itemId || target.paperContext?.itemId}`
      : "",
    target.contextItemId || target.paperContext?.contextItemId
      ? `contextItemId=${
          target.contextItemId || target.paperContext?.contextItemId
        }`
      : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "missing itemId/contextItemId";
}

function resolveTarget(
  target: PdfTarget,
  zoteroGateway: ZoteroGateway,
): PaperContextRef | null {
  const paperContext = target.paperContext;
  if (paperContext && target.itemId && target.itemId !== paperContext.itemId) {
    throw new ExplicitPaperTargetError(
      "conflicting_paper_identity",
      "The explicit paper target contains conflicting itemId values.",
    );
  }
  if (
    paperContext &&
    target.contextItemId &&
    target.contextItemId !== paperContext.contextItemId
  ) {
    throw new ExplicitPaperTargetError(
      "conflicting_paper_identity",
      "The explicit paper target contains conflicting contextItemId values.",
    );
  }
  const itemId = target.itemId || paperContext?.itemId;
  const contextItemId = target.contextItemId || paperContext?.contextItemId;
  if (itemId || contextItemId) {
    const resolved = zoteroGateway.resolvePaperContextTarget({
      itemId,
      contextItemId,
    });
    if (
      resolved &&
      ((itemId && resolved.itemId !== itemId) ||
        (contextItemId && resolved.contextItemId !== contextItemId))
    ) {
      throw new ExplicitPaperTargetError(
        "conflicting_paper_identity",
        "The explicit paper target resolved to a different Zotero paper.",
      );
    }
    return resolved;
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
    const key = `${Math.floor(Number(paperContext.libraryID || 0))}:${Math.floor(
      Number(paperContext.itemId),
    )}:${Math.floor(Number(paperContext.contextItemId))}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(paperContext);
  }
  return out;
}

export function describeNoDefaultPaperTarget(
  request: AgentRuntimeRequest,
): string {
  const scope = getTurnPaperScopeFromRequest(request);
  if (
    request.conversationKind === "global" ||
    scope.collections.length ||
    scope.tags.length
  ) {
    return (
      "No paper target in library chat. Use library_search with the selected " +
      "collection/tag and pass explicit targets to paper_read."
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
      throw new Error(
        `Could not resolve paper target ${describeTarget(target)}`,
      );
    }
    return [paperContext];
  }
  const scope = getTurnPaperScopeFromRequest(context.request);
  const activePaper = getActiveTurnPaper(scope);
  const activeKey = activePaper
    ? `${activePaper.libraryID}:${activePaper.itemId}:${activePaper.contextItemId}`
    : "";
  const addedPapers = scope.papers
    .filter(
      (entry) =>
        `${entry.paper.libraryID}:${entry.paper.itemId}:${entry.paper.contextItemId}` !==
        activeKey,
    )
    .map((entry) => entry.paper);
  const allPapers = scope.papers.map((entry) => entry.paper);
  const userText = context.request.userText || "";
  const paperTargetIntent = context.request.classifiedIntent?.paperTargetIntent;
  const requestsActivePaper =
    /\b(?:this|the current|current|active)\s+(?:paper|article|study|document|pdf)\b/i.test(
      userText,
    );
  const requestsAddedPapers =
    /\b(?:the\s+)?(?:selected|added|attached)\s+(?:papers?|articles?|studies|documents?|pdfs?)\b/i.test(
      userText,
    );
  const requestsAllVisiblePapers =
    /\b(?:these|both|all(?:\s+of\s+the)?)\s+(?:papers?|articles?|studies|documents?|pdfs?)\b/i.test(
      userText,
    );
  const classifiedTargets =
    paperTargetIntent === "active"
      ? activePaper
        ? [activePaper]
        : []
      : paperTargetIntent === "added"
        ? activePaper
          ? addedPapers
          : allPapers
        : paperTargetIntent === "all_visible"
          ? allPapers
          : paperTargetIntent === "unspecified"
            ? activePaper
              ? [activePaper]
              : allPapers
            : undefined;
  const legacySummarizeTargets =
    paperTargetIntent === undefined &&
    context.request.classifiedIntent?.retrievalIntent === "summarize" &&
    allPapers.length > 1
      ? allPapers
      : undefined;
  // A failed classifier leaves classifiedIntent absent. In that degraded mode
  // the English-only phrases above are the compatibility fallback, so requests
  // expressed differently may require explicit target/targets selectors.
  const heuristicTargets = requestsActivePaper
    ? activePaper
      ? [activePaper]
      : []
    : requestsAddedPapers
      ? addedPapers
      : requestsAllVisiblePapers
        ? allPapers
        : activePaper
          ? [activePaper]
          : allPapers;
  const implicit =
    classifiedTargets || legacySummarizeTargets || heuristicTargets;
  return dedupePaperContextRefs(implicit).slice(0, maxCount);
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
    entries.find(
      (entry) => entry.category !== "image" && Boolean(entry.storedPath),
    ) || null
  );
}

// ---------------------------------------------------------------------------
// Base64 encoding
// ---------------------------------------------------------------------------

export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(
      index,
      Math.min(bytes.length, index + chunkSize),
    );
    out += String.fromCharCode(...chunk);
  }
  const btoaFn = (
    globalThis as typeof globalThis & { btoa?: (s: string) => string }
  ).btoa;
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

export function getCachedPrepared(
  conversationKey: number,
): PreparedPdfCache | null {
  const entry = preparedCache.get(conversationKey);
  if (!entry || Date.now() > entry.expiresAt) {
    preparedCache.delete(conversationKey);
    return null;
  }
  return entry;
}

export function getCachedCapture(
  conversationKey: number,
): CapturedPdfCache | null {
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
