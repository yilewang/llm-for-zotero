import type { AgentModelContentPart, AgentToolDefinition } from "../../types";
import type { PdfPageService } from "../../services/pdfPageService";
import { readAttachmentBytes } from "../../../modules/contextPanel/attachmentStorage";
import { fail, ok, validateObject, normalizePositiveInt } from "../shared";
import { classifyRequest } from "../../model/requestClassifier";

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

type CaptureReaderViewInput = {
  reason?: string;
  neighborPages?: number;
};

type CapturedPageCache = {
  pageLabel: string;
  pageIndex: number;
  contextItemId: number;
  artifacts: Array<{ storedPath: string; mimeType: string; title?: string }>;
  expiresAt: number;
};

// Per-conversation cache so follow-up questions re-use the last captured page
// without showing the confirmation card again.
const captureCache = new Map<number, CapturedPageCache>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getCachedCapture(conversationKey: number): CapturedPageCache | null {
  const entry = captureCache.get(conversationKey);
  if (!entry || Date.now() > entry.expiresAt) {
    captureCache.delete(conversationKey);
    return null;
  }
  return entry;
}

export function clearCaptureReaderViewCache(conversationKey: number): void {
  captureCache.delete(conversationKey);
}

function setCachedCapture(conversationKey: number, data: Omit<CapturedPageCache, "expiresAt">) {
  captureCache.set(conversationKey, {
    ...data,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}


export function createCaptureReaderViewTool(
  pdfPageService: PdfPageService,
): AgentToolDefinition<CaptureReaderViewInput, unknown> {
  return {
    spec: {
      name: "capture_reader_view",
      description:
        "Capture the page currently visible in the active Zotero PDF reader as an image and send it to the model for visual inspection. Use this when the user asks about something they are currently looking at — such as 'explain this equation', 'what does this figure show', or 'interpret what I see' — without needing to know the page number. The tool automatically detects the current reader page and shows the user a confirmation preview before sending.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          reason: {
            type: "string",
            description:
              "Brief description of why the current reader page is being captured (e.g. 'user asked to explain the visible equation')",
          },
          neighborPages: {
            type: "integer",
            description:
              "Number of adjacent pages (0 or 1) to include alongside the current page for additional context. Defaults to 0.",
          },
        },
      },
      mutability: "read",
      requiresConfirmation: true,
    },
    guidance: {
      matches: (request) => classifyRequest(request).isPdfVisualQuery,
      instruction: [
        "Use capture_reader_view when the user asks about a numbered equation, figure, table, or formula (e.g. 'explain equation 3', 'what is Figure 2', 'eq. 4') OR when they refer to something visible in the reader ('this equation', 'what I see', 'explain this').",
        "capture_reader_view always captures the page currently open in the PDF reader — it does NOT search for the page, which means it cannot select the wrong page. It is the reliable choice for any equation/figure/table the user is looking at.",
        "Do NOT also call search_pdf_pages or prepare_pdf_pages_for_model for the same request — capture_reader_view handles everything in one step.",
        "After the tool result is returned (ok), the captured page image and extracted text are embedded in the very next message. Read them and answer the user's question directly. No further approval or tool call is needed.",
        "Use neighborPages: 1 only if the content likely spans two pages.",
      ].join("\n"),
    },
    presentation: {
      label: "Capture Reader View",
      summaries: {
        onCall: "Capturing the current reader page",
        onPending: "Waiting for your approval before sending the current page",
        onApproved: "Approval received — sending the current reader page",
        onDenied: "Page capture cancelled",
        onSuccess: ({ content }) => {
          const pageLabel =
            content &&
            typeof content === "object" &&
            typeof (content as { pageLabel?: unknown }).pageLabel === "string"
              ? (content as { pageLabel: string }).pageLabel
              : null;
          return pageLabel
            ? `Sent page ${pageLabel} to the model for visual inspection`
            : "Sent the current reader page to the model";
        },
      },
    },
    validate: (args) => {
      if (args !== null && args !== undefined && !validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object or empty input");
      }
      const obj = (args as Record<string, unknown>) || {};
      return ok({
        reason:
          typeof obj.reason === "string" && obj.reason.trim()
            ? obj.reason.trim()
            : undefined,
        neighborPages: normalizePositiveInt(obj.neighborPages),
      });
    },
    shouldRequireConfirmation: async (_input, context) => {
      const cached = getCachedCapture(context.request.conversationKey);
      if (!cached) return true;
      // If the user has navigated to a different page, ask again
      const currentPageIndex = pdfPageService.getActivePageIndex();
      if (currentPageIndex !== null && currentPageIndex !== cached.pageIndex) {
        return true;
      }
      return false;
    },
    createPendingAction: async (input, context) => {
      const preview = await pdfPageService.captureActiveView({
        request: context.request,
        neighborPages: input.neighborPages,
      });
      const imageItems = preview.artifacts
        .filter(
          (artifact): artifact is Extract<typeof artifact, { kind: "image" }> =>
            artifact.kind === "image",
        )
        .map((artifact) => ({
          label: `Page ${artifact.pageLabel ?? artifact.pageIndex != null ? String((artifact.pageIndex ?? 0) + 1) : "?"}`,
          storedPath: artifact.storedPath,
          mimeType: "image/png",
          title: artifact.title ?? preview.target.title,
        }));
      return {
        toolName: "capture_reader_view",
        title: `${preview.target.title} — page ${preview.capturedPage.pageLabel}`,
        description:
          "Review the captured page below. Click \"Send to model\" to let the model visually inspect it.",
        confirmLabel: "Send to model",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "image_gallery",
            id: "previewImages",
            items: imageItems,
          },
        ],
      };
    },
    applyConfirmation: (input) => ok(input),
    execute: async (input, context) => {
      const conversationKey = context.request.conversationKey;
      const result = await pdfPageService.captureActiveView({
        request: context.request,
        neighborPages: input.neighborPages,
      });

      // Cache for follow-up questions in this conversation
      const imageArtifacts = result.artifacts
        .filter(
          (a): a is Extract<typeof a, { kind: "image" }> => a.kind === "image",
        )
        .map((a) => ({
          storedPath: a.storedPath,
          mimeType: a.mimeType,
          title: a.title,
        }));
      setCachedCapture(conversationKey, {
        pageLabel: result.capturedPage.pageLabel,
        pageIndex: result.capturedPage.pageIndex,
        contextItemId: result.target.contextItemId ?? 0,
        artifacts: imageArtifacts,
      });

      return {
        content: {
          target: {
            source: result.target.source,
            title: result.target.title,
            paperContext: result.target.paperContext,
            contextItemId: result.target.contextItemId,
            itemId: result.target.itemId,
          },
          capturedPageIndex: result.capturedPage.pageIndex,
          pageLabel: result.capturedPage.pageLabel,
          pageCount: result.artifacts.length,
          pageText: result.pageText || undefined,
        },
        artifacts: result.artifacts,
      };
    },
    buildFollowupMessage: async (result) => {
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
        if (artifact.kind !== "image" || !artifact.storedPath || !artifact.mimeType) {
          continue;
        }
        try {
          const bytes = await readAttachmentBytes(artifact.storedPath);
          const base64 = encodeBase64(bytes);
          parts.push({
            type: "image_url",
            image_url: {
              url: `data:${artifact.mimeType};base64,${base64}`,
              detail: "high",
            },
          });
        } catch {
          // image load failed — extracted text still provides grounding
        }
      }

      return { role: "user", content: parts };
    },
  };
}
