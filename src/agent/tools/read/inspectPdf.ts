import type { ChatAttachment, PaperContextRef } from "../../../shared/types";
import { readAttachmentBytes } from "../../../modules/contextPanel/attachmentStorage";
import type { AgentModelContentPart, AgentToolDefinition } from "../../types";
import type { PdfService } from "../../services/pdfService";
import type {
  ParsedPageSelection,
  PdfVisualMode,
  PdfPageService,
} from "../../services/pdfPageService";
import { parsePageSelectionValue } from "../../services/pdfPageService";
import type { RetrievalService } from "../../services/retrievalService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { AttachmentReadService } from "../../services/attachmentReadService";
import {
  fail,
  findAttachment,
  normalizePositiveInt,
  normalizePositiveIntArray,
  normalizeToolPaperContext,
  ok,
  PAPER_CONTEXT_REF_SCHEMA,
  validateObject,
} from "../shared";

type InspectPdfTarget = {
  paperContext?: PaperContextRef;
  itemId?: number;
  contextItemId?: number;
  attachmentId?: string;
  name?: string;
};

type InspectPdfOperation =
  | "front_matter"
  | "retrieve_evidence"
  | "read_chunks"
  | "search_pages"
  | "render_pages"
  | "capture_active_view"
  | "attach_file"
  | "read_attachment"
  | "index_attachment";

type InspectPdfInput = {
  operation: InspectPdfOperation;
  target?: InspectPdfTarget;
  targets?: InspectPdfTarget[];
  question?: string;
  chunkIndexes?: number[];
  pages?: number[];
  neighborPages?: number;
  topK?: number;
  perPaperTopK?: number;
  scope?: "whole_document";
  maxChars?: number;
  maxChunks?: number;
};

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

function encodeBase64(bytes: Uint8Array): string {
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

function getCachedPrepared(conversationKey: number): PreparedPdfCache | null {
  const entry = preparedCache.get(conversationKey);
  if (!entry || Date.now() > entry.expiresAt) {
    preparedCache.delete(conversationKey);
    return null;
  }
  return entry;
}

function getCachedCapture(conversationKey: number): CapturedPdfCache | null {
  const entry = capturedCache.get(conversationKey);
  if (!entry || Date.now() > entry.expiresAt) {
    capturedCache.delete(conversationKey);
    return null;
  }
  return entry;
}

function setPreparedCache(
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

function setCapturedCache(
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

export function clearInspectPdfCache(conversationKey: number): void {
  preparedCache.delete(conversationKey);
  capturedCache.delete(conversationKey);
}

function normalizeTarget(value: unknown): InspectPdfTarget | undefined {
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

function normalizeTargets(value: unknown): InspectPdfTarget[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const targets = value
    .map((entry) => normalizeTarget(entry))
    .filter((entry): entry is InspectPdfTarget => Boolean(entry))
    .slice(0, 6);
  return targets.length ? targets : undefined;
}

function inferPdfMode(question: string | undefined): PdfVisualMode {
  const text = `${question || ""}`.toLowerCase();
  if (/\b(eq|equation|theorem|proof|formula|derivation)\b/.test(text)) {
    return "equation";
  }
  if (/\b(fig|figure|table|diagram|chart|plot|graph|panel)\b/.test(text)) {
    return "figure";
  }
  return "general";
}

function normalizePages(value: unknown): ParsedPageSelection | null {
  return parsePageSelectionValue(value);
}

function samePageSet(left: number[] | undefined, right: number[] | undefined): boolean {
  const a = Array.from(new Set(left || [])).sort((x, y) => x - y);
  const b = Array.from(new Set(right || [])).sort((x, y) => x - y);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function resolveDefaultTargets(
  input: InspectPdfInput,
  context: Parameters<AgentToolDefinition<InspectPdfInput, unknown>["execute"]>[1],
  zoteroGateway: ZoteroGateway,
): PaperContextRef[] {
  if (input.targets?.length) {
    return input.targets
      .map((target) => target.paperContext)
      .filter((entry): entry is PaperContextRef => Boolean(entry));
  }
  if (input.target?.paperContext) return [input.target.paperContext];
  return zoteroGateway.listPaperContexts(context.request).slice(0, 6);
}

function firstNonImageAttachment(
  attachments: ChatAttachment[] | undefined,
): ChatAttachment | null {
  const entries = Array.isArray(attachments) ? attachments : [];
  return (
    entries.find((entry) => entry.category !== "image" && Boolean(entry.storedPath)) ||
    null
  );
}

async function buildCaptureFollowupMessage(result: {
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

export function createInspectPdfTool(
  pdfService: PdfService,
  pdfPageService: PdfPageService,
  retrievalService: RetrievalService,
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<InspectPdfInput, unknown> {
  const attachmentReadService = new AttachmentReadService(zoteroGateway);
  return {
    spec: {
      name: "inspect_pdf",
      description:
        "Inspect local PDFs and any Zotero attachments through one general tool. Use operations to read front matter, retrieve evidence, read chunks, locate pages, render pages, capture the active reader view, attach a file for the model, read the content of any Zotero attachment (HTML snapshots, text files, images, etc.) by contextItemId, or trigger PDF full-text indexing (index_attachment) so that retrieve_evidence and search_pages work.",
      inputSchema: {
        type: "object",
        required: ["operation"],
        additionalProperties: false,
        properties: {
          operation: {
            type: "string",
            enum: [
              "front_matter",
              "retrieve_evidence",
              "read_chunks",
              "search_pages",
              "render_pages",
              "capture_active_view",
              "attach_file",
              "read_attachment",
              "index_attachment",
            ],
          },
          target: {
            type: "object",
            description: "Target paper or attachment.",
            properties: {
              contextItemId: {
                type: "number",
                description: "Zotero attachment item ID (from paper context or query results)",
              },
              itemId: {
                type: "number",
                description: "Zotero parent item ID",
              },
              paperContext: PAPER_CONTEXT_REF_SCHEMA,
              attachmentId: {
                type: "string",
                description: "Uploaded attachment ID (for file attachments)",
              },
              name: {
                type: "string",
                description: "Uploaded attachment name",
              },
            },
            additionalProperties: false,
          },
          targets: {
            type: "array",
            description: "Multiple target papers (max 6). Same shape as target.",
            items: {
              type: "object",
              properties: {
                contextItemId: {
                  type: "number",
                  description: "Zotero attachment item ID",
                },
                itemId: {
                  type: "number",
                  description: "Zotero parent item ID",
                },
                paperContext: PAPER_CONTEXT_REF_SCHEMA,
              },
              additionalProperties: false,
            },
          },
          question: { type: "string" },
          chunkIndexes: {
            type: "array",
            items: { type: "number" },
          },
          pages: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              {
                type: "array",
                items: { type: "number" },
              },
            ],
          },
          neighborPages: { type: "number" },
          topK: { type: "number" },
          perPaperTopK: { type: "number" },
          scope: {
            type: "string",
            enum: ["whole_document"],
          },
          maxChars: { type: "number" },
          maxChunks: { type: "number" },
        },
      },
      mutability: "read",
      requiresConfirmation: true,
    },
    presentation: {
      label: "Inspect PDF",
      summaries: {
        onCall: ({ args }) => {
          const operation =
            args && typeof args === "object"
              ? String((args as { operation?: unknown }).operation || "inspect")
              : "inspect";
          const operationLabel =
            {
              front_matter: "front matter",
              retrieve_evidence: "retrieve evidence",
              read_chunks: "read chunks",
              search_pages: "search pages",
              render_pages: "render pages",
              capture_active_view: "capture active view",
              attach_file: "attach file",
              read_attachment: "read attachment",
              index_attachment: "index attachment",
            }[operation] || operation;
          return `Inspecting PDF (${operationLabel})`;
        },
        onPending: "Waiting for your approval before sending document content",
        onApproved: "Approval received - sending document content",
        onDenied: "PDF inspection cancelled",
        onSuccess: ({ content }) => {
          const operation =
            content && typeof content === "object"
              ? String((content as { operation?: unknown }).operation || "")
              : "";
          const results =
            content && typeof content === "object"
              ? Array.isArray((content as { results?: unknown }).results)
                ? ((content as { results: unknown[] }).results)
                : []
              : [];
          if (operation === "capture_active_view") {
            return "Captured the current reader page";
          }
          if (operation === "render_pages") {
            const pageCount =
              content && typeof content === "object"
                ? Number((content as { pageCount?: unknown }).pageCount || 0)
                : 0;
            return pageCount > 0
              ? `Prepared ${pageCount} PDF page image${
                  pageCount === 1 ? "" : "s"
                }`
              : "Prepared PDF content";
          }
          if (operation === "front_matter") {
            return results.length > 1
              ? `Read front matter for ${results.length} PDFs`
              : "Read PDF front matter";
          }
          if (operation === "retrieve_evidence") {
            return results.length > 0
              ? `Retrieved ${results.length} evidence passage${
                  results.length === 1 ? "" : "s"
                }`
              : "No evidence found in the PDF";
          }
          if (operation === "read_chunks") {
            return results.length > 0
              ? `Read ${results.length} PDF chunk${
                  results.length === 1 ? "" : "s"
                }`
              : "No PDF chunks read";
          }
          if (operation === "search_pages") {
            return results.length > 0
              ? `Found ${results.length} relevant PDF page${
                  results.length === 1 ? "" : "s"
                }`
              : "No matching PDF pages found";
          }
          if (operation === "attach_file") {
            return "Prepared the file for direct reading";
          }
          if (operation === "read_attachment") {
            return "Read attachment content";
          }
          if (operation === "index_attachment") {
            return "Started PDF indexing";
          }
          return "Completed the PDF inspection";
        },
      },
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      const operation =
        args.operation === "front_matter" ||
        args.operation === "retrieve_evidence" ||
        args.operation === "read_chunks" ||
        args.operation === "search_pages" ||
        args.operation === "render_pages" ||
        args.operation === "capture_active_view" ||
        args.operation === "attach_file" ||
        args.operation === "read_attachment" ||
        args.operation === "index_attachment"
          ? (args.operation as InspectPdfOperation)
          : null;
      if (!operation) {
        return fail(
          `Invalid operation '${String(args.operation)}'. Valid operations: ` +
          `front_matter, retrieve_evidence, read_chunks, search_pages, render_pages, ` +
          `capture_active_view, attach_file, read_attachment, index_attachment.`
        );
      }
      const pagesSelection = normalizePages(args.pages);
      const input: InspectPdfInput = {
        operation,
        target: normalizeTarget(args.target),
        targets: normalizeTargets(args.targets),
        question:
          typeof args.question === "string" && args.question.trim()
            ? args.question.trim()
            : undefined,
        chunkIndexes: normalizePositiveIntArray(args.chunkIndexes) || undefined,
        pages: pagesSelection?.pageIndexes,
        neighborPages: normalizePositiveInt(args.neighborPages),
        topK: normalizePositiveInt(args.topK),
        perPaperTopK: normalizePositiveInt(args.perPaperTopK),
        scope: args.scope === "whole_document" ? "whole_document" : undefined,
        maxChars: normalizePositiveInt(args.maxChars),
        maxChunks: normalizePositiveInt(args.maxChunks),
      };
      if (
        ["front_matter", "retrieve_evidence"].includes(operation) &&
        input.targets &&
        input.targets.length > 6
      ) {
        return fail("targets supports at most 6 papers");
      }
      if (operation === "read_chunks" && !input.chunkIndexes?.length) {
        return fail("chunkIndexes are required for read_chunks");
      }
      // search_pages: question is optional here because execute() falls back
      // to context.request.userText when input.question is omitted.
      if (
        operation === "render_pages" &&
        !input.pages?.length &&
        input.scope !== "whole_document"
      ) {
        return fail("pages or scope:'whole_document' is required for render_pages");
      }
      return ok(input);
    },
    shouldRequireConfirmation: async () => {
      // All inspect_pdf operations are read-only — auto-approve to reduce
      // friction in agent workflows (figure analysis, evidence retrieval, etc.)
      return false;
    },
    createPendingAction: async (input, context) => {
      if (input.operation === "capture_active_view") {
        const preview = await pdfPageService.captureActiveView({
          request: context.request,
          neighborPages: input.neighborPages,
        });
        const previewImages = preview.artifacts
          .filter(
            (artifact): artifact is Extract<typeof artifact, { kind: "image" }> =>
              artifact.kind === "image",
          )
          .map((artifact) => ({
            label: `Page ${
              artifact.pageLabel ||
              (artifact.pageIndex !== undefined ? `${artifact.pageIndex + 1}` : "?")
            }`,
            storedPath: artifact.storedPath,
            mimeType: "image/png",
            title: artifact.title || preview.target.title,
          }));
        return {
          toolName: "inspect_pdf",
          title: `${preview.target.title} - page ${preview.capturedPage.pageLabel}`,
          description:
            "Review the captured page below. Click \"Send to model\" to let the model inspect it.",
          confirmLabel: "Send to model",
          cancelLabel: "Cancel",
          fields: [
            {
              type: "image_gallery",
              id: "previewImages",
              items: previewImages,
            },
          ],
        };
      }
      if (input.operation === "attach_file") {
        const explicitTarget = input.target;
        const attachment =
          (explicitTarget?.attachmentId || explicitTarget?.name
            ? findAttachment(context.request.attachments, {
                attachmentId: explicitTarget.attachmentId,
                name: explicitTarget.name,
              })
            : null) || firstNonImageAttachment(context.request.attachments);
        const attachmentName =
          attachment?.name ||
          explicitTarget?.name ||
          "Attached file";
        const mimeType = attachment?.mimeType || "application/pdf";
        return {
          toolName: "inspect_pdf",
          title: attachmentName,
          description:
            "Review the file details below. Click \"Send to model\" to let the model inspect this attachment.",
          confirmLabel: "Send to model",
          cancelLabel: "Cancel",
          fields: [
            {
              type: "review_table",
              id: "fileReview",
              rows: [
                {
                  key: "file",
                  label: "File",
                  before: attachment?.category || "attachment",
                  after: attachmentName,
                },
                {
                  key: "mimeType",
                  label: "Type",
                  before: attachment?.category || "attachment",
                  after: mimeType,
                },
              ],
            },
          ],
        };
      }
      let pages = input.pages || [];
      let previewPages = pages;
      let description =
        "Review the selected pages below, then click \"Send to model\" to send them for inspection.";
      if (input.scope === "whole_document" && !pages.length) {
        const pageCount = await pdfPageService.getPageCountForTarget({
          request: context.request,
          paperContext: input.target?.paperContext,
          itemId: input.target?.itemId,
          contextItemId: input.target?.contextItemId,
          attachmentId: input.target?.attachmentId,
          name: input.target?.name,
        });
        pages = Array.from({ length: pageCount }, (_value, index) => index);
        previewPages = pages.slice(0, 12);
        description =
          pageCount > previewPages.length
            ? `This will send all ${pageCount} pages. Previewing the first ${previewPages.length} pages below.`
            : `This will send all ${pageCount} pages for inspection.`;
      }
      const preview = await pdfPageService.preparePagesForModel({
        request: context.request,
        paperContext: input.target?.paperContext,
        itemId: input.target?.itemId,
        contextItemId: input.target?.contextItemId,
        attachmentId: input.target?.attachmentId,
        name: input.target?.name,
        pages: previewPages,
        neighborPages: 0,
      });
      return {
        toolName: "inspect_pdf",
        title:
          pages.length === 1
            ? `${preview.target.title} - p${pages[0] + 1}`
            : `${preview.target.title} - ${previewPages.length} page preview`,
        description,
        confirmLabel: "Send to model",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "text",
            id: "pageSelection",
            label: "Pages to send",
            value:
              pages.length > 0
                ? `p${pages.map((page) => page + 1).join(", p")}`
                : undefined,
            placeholder: "e.g. p3 or p3-5",
          },
          {
            type: "image_gallery",
            id: "previewImages",
            items: preview.pages.map((page) => ({
              label: `Page ${page.pageLabel}`,
              storedPath: page.imagePath,
              mimeType: "image/png",
              title: `${preview.target.title} - page ${page.pageLabel}`,
            })),
          },
        ],
      };
    },
    applyConfirmation: (input, resolutionData) => {
      if (input.operation !== "render_pages") {
        return ok(input);
      }
      if (!validateObject<Record<string, unknown>>(resolutionData)) {
        return ok(input);
      }
      if (Object.prototype.hasOwnProperty.call(resolutionData, "pageSelection")) {
        const selection = parsePageSelectionValue(resolutionData.pageSelection);
        if (!selection?.pageIndexes.length) {
          return fail("At least one page is required");
        }
        return ok({
          ...input,
          pages: selection.pageIndexes,
        });
      }
      return ok(input);
    },
    execute: async (input, context) => {
      switch (input.operation) {
        case "front_matter": {
          const targets = resolveDefaultTargets(input, context, zoteroGateway);
          if (!targets.length) {
            throw new Error("No paper context available for front-matter reading");
          }
          const results = [];
          for (const target of targets) {
            results.push(
              await pdfService.getFrontMatterExcerpt({
                paperContext: target,
                maxChunks: input.maxChunks,
                maxChars: input.maxChars,
              }),
            );
          }
          return {
            operation: input.operation,
            results,
            warnings: [],
          };
        }
        case "retrieve_evidence": {
          const papers = resolveDefaultTargets(input, context, zoteroGateway);
          if (!papers.length) {
            throw new Error("No paper context available for evidence retrieval");
          }
          return {
            operation: input.operation,
            results: await retrievalService.retrieveEvidence({
              papers,
              question: input.question || context.request.userText,
              apiBase: context.request.apiBase,
              apiKey: context.request.apiKey,
              topK: input.topK,
              perPaperTopK: input.perPaperTopK,
            }),
            warnings: [],
          };
        }
        case "read_chunks": {
          const paperContext =
            input.target?.paperContext || resolveDefaultTargets(input, context, zoteroGateway)[0];
          if (!paperContext) {
            throw new Error("No paper context available for chunk reading");
          }
          return {
            operation: input.operation,
            results: await Promise.all(
              (input.chunkIndexes || []).map((chunkIndex) =>
                pdfService.getChunkExcerpt({
                  paperContext,
                  chunkIndex,
                }),
              ),
            ),
            warnings: [],
          };
        }
        case "search_pages": {
          const result = await pdfPageService.searchPages({
            request: context.request,
            paperContext: input.target?.paperContext,
            itemId: input.target?.itemId,
            contextItemId: input.target?.contextItemId,
            attachmentId: input.target?.attachmentId,
            name: input.target?.name,
            question: input.question || context.request.userText,
            pages: input.pages,
            mode: inferPdfMode(input.question || context.request.userText),
            topK: input.topK,
          });
          return {
            operation: input.operation,
            results: result.pages.map((page) => ({
              pageIndex: page.pageIndex,
              pageLabel: page.pageLabel,
              score: page.score,
              reason: page.reason,
              excerpt: page.excerpt,
            })),
            target: {
              source: result.target.source,
              title: result.target.title,
              paperContext: result.target.paperContext,
              contextItemId: result.target.contextItemId,
              itemId: result.target.itemId,
            },
            warnings: [],
          };
        }
        case "render_pages": {
          let pages = input.pages || [];
          if (input.scope === "whole_document" && !pages.length) {
            const pageCount = await pdfPageService.getPageCountForTarget({
              request: context.request,
              paperContext: input.target?.paperContext,
              itemId: input.target?.itemId,
              contextItemId: input.target?.contextItemId,
              attachmentId: input.target?.attachmentId,
              name: input.target?.name,
            });
            pages = Array.from({ length: pageCount }, (_value, index) => index);
          }
          const prepared = await pdfPageService.preparePagesForModel({
            request: context.request,
            paperContext: input.target?.paperContext,
            itemId: input.target?.itemId,
            contextItemId: input.target?.contextItemId,
            attachmentId: input.target?.attachmentId,
            name: input.target?.name,
            pages,
            neighborPages: input.neighborPages,
          });
          setPreparedCache(
            context.request.conversationKey,
            prepared.pages.map((page) => page.pageIndex),
            prepared.target.contextItemId,
          );
          return {
            content: {
              operation: input.operation,
              target: {
                source: prepared.target.source,
                title: prepared.target.title,
                paperContext: prepared.target.paperContext,
                contextItemId: prepared.target.contextItemId,
                itemId: prepared.target.itemId,
              },
              pageCount: prepared.pages.length,
              results: prepared.pages.map((page) => ({
                pageIndex: page.pageIndex,
                pageLabel: page.pageLabel,
              })),
              pageTexts: prepared.pageTexts,
              warnings: [],
            },
            artifacts: prepared.artifacts,
          };
        }
        case "capture_active_view": {
          const captured = await pdfPageService.captureActiveView({
            request: context.request,
            neighborPages: input.neighborPages,
          });
          setCapturedCache(
            context.request.conversationKey,
            captured.capturedPage.pageIndex,
            captured.target.contextItemId,
          );
          return {
            content: {
              operation: input.operation,
              target: {
                source: captured.target.source,
                title: captured.target.title,
                paperContext: captured.target.paperContext,
                contextItemId: captured.target.contextItemId,
                itemId: captured.target.itemId,
              },
              capturedPageIndex: captured.capturedPage.pageIndex,
              pageLabel: captured.capturedPage.pageLabel,
              pageCount: captured.artifacts.length,
              pageText: captured.pageText || undefined,
              warnings: [],
            },
            artifacts: captured.artifacts,
          };
        }
        case "attach_file": {
          const explicitTarget = input.target;
          const uploadedAttachment =
            (explicitTarget?.attachmentId || explicitTarget?.name
              ? findAttachment(context.request.attachments, {
                  attachmentId: explicitTarget.attachmentId,
                  name: explicitTarget.name,
                })
              : null) || firstNonImageAttachment(context.request.attachments);
          if (uploadedAttachment && uploadedAttachment.category !== "image") {
            if (uploadedAttachment.category === "pdf") {
              const prepared = await pdfPageService.preparePdfFileForModel({
                request: context.request,
                attachmentId: uploadedAttachment.id,
                name: uploadedAttachment.name,
              });
              return {
                content: {
                  operation: input.operation,
                  result: {
                    attachmentId: uploadedAttachment.id,
                    name: uploadedAttachment.name,
                    mimeType: uploadedAttachment.mimeType,
                  },
                  warnings: [],
                },
                artifacts: [prepared.artifact],
              };
            }
            return {
              operation: input.operation,
              results: [
                {
                  id: uploadedAttachment.id,
                  name: uploadedAttachment.name,
                  mimeType: uploadedAttachment.mimeType,
                  textContent: uploadedAttachment.textContent || "",
                },
              ],
              warnings: [],
            };
          }
          const prepared = await pdfPageService.preparePdfFileForModel({
            request: context.request,
            paperContext: explicitTarget?.paperContext,
            itemId: explicitTarget?.itemId,
            contextItemId: explicitTarget?.contextItemId,
            attachmentId: explicitTarget?.attachmentId,
            name: explicitTarget?.name,
          });
          return {
            content: {
              operation: input.operation,
              result: {
                title: prepared.target.title,
                mimeType: prepared.target.mimeType,
              },
              warnings: [],
            },
            artifacts: [prepared.artifact],
          };
        }
        case "read_attachment": {
          const contextItemId = input.target?.contextItemId;
          if (!contextItemId) {
            throw new Error(
              "read_attachment requires target.contextItemId — the Zotero attachment item ID to read",
            );
          }
          const result = await attachmentReadService.readAttachmentContent({
            attachmentId: contextItemId,
            maxChars: input.maxChars,
          });
          return {
            operation: input.operation,
            ...result,
          };
        }
        case "index_attachment": {
          const contextItemId = input.target?.contextItemId;
          if (!contextItemId) {
            throw new Error(
              "index_attachment requires target.contextItemId — the PDF attachment item ID to index",
            );
          }
          return zoteroGateway.indexPdfAttachment({ attachmentId: contextItemId });
        }
      }
    },
    buildFollowupMessage: async (result) => {
      const content =
        result.content && typeof result.content === "object"
          ? (result.content as { operation?: unknown })
          : null;
      if (content?.operation === "capture_active_view") {
        return buildCaptureFollowupMessage(result);
      }
      return null;
    },
  };
}
