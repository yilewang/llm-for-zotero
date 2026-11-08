import type { ZoteroGateway } from "../services/zoteroGateway";
import type { AgentToolRegistry } from "../tools/registry";
import type { AnnotateSelection } from "../tools/write/annotatePdf";
import type { AgentToolResult } from "../types";
import { callTool } from "./executor";

export type SaveSelectionAnnotationInput = {
  /** The PDF attachment the reader shows. */
  attachmentId: number;
  libraryID: number;
  /** The reader panel's conversation; the change journal files it there. */
  conversationKey: number;
  /** Zotero's own selection draft, frozen when the popup appeared. */
  selection: AnnotateSelection;
  /** A Zotero palette hex, such as "#ffd400". */
  color: string;
  comment: string;
};

export type SaveSelectionAnnotationOutcome =
  | {
      ok: true;
      status: "applied" | "already_satisfied";
      result: AgentToolResult;
    }
  | { ok: false; error: string; result?: AgentToolResult };

/**
 * A save counts only when the tool succeeded and its receipt verified the
 * native annotation (applied, or an identical one already there).
 */
export function isVerifiedAnnotationSave(result: AgentToolResult): boolean {
  const receipt = result.actionReceipts?.[0];
  return Boolean(
    result.ok &&
    receipt?.verification === "verified" &&
    (receipt.status === "applied" || receipt.status === "already_satisfied"),
  );
}

function failureText(result: AgentToolResult): string {
  const content = result.content as { error?: unknown } | null | undefined;
  if (!result.ok && typeof content?.error === "string" && content.error.trim())
    return content.error.trim();
  const reason = result.actionReceipts?.[0]?.reasons?.find((text) =>
    String(text || "").trim(),
  );
  if (reason) return String(reason);
  return "Zotero did not confirm the saved annotation.";
}

/**
 * Saves a reader selection as a highlight from Inline Ask's card.
 *
 * The call takes the action route (host-built arguments, forced review,
 * write lock, central authorization, change journal). The card shows the
 * whole payload, so its Save click is the user's confirmation: the review
 * is resolved here with that payload's comment. A second review, which only
 * an expanded proposal would raise, is refused.
 */
export async function saveSelectionAnnotation(
  registry: AgentToolRegistry,
  gateway: ZoteroGateway,
  input: SaveSelectionAnnotationInput,
  hooks: { onConfirmation?: (toolName: string) => void } = {},
): Promise<SaveSelectionAnnotationOutcome> {
  const conversationKey = Math.floor(Number(input.conversationKey));
  if (!Number.isFinite(conversationKey) || conversationKey <= 0)
    throw new Error(
      "Saving an annotation needs the reader's conversation; none was given.",
    );
  const comment = input.comment.trim();
  let confirmations = 0;
  const result = await callTool(
    "annotate_pdf",
    {
      attachmentId: input.attachmentId,
      text: input.selection.text,
      color: input.color,
      comment,
      annotationType: "highlight",
      selection: input.selection,
    },
    {
      registry,
      zoteroGateway: gateway,
      libraryID: input.libraryID,
      conversationKey,
      confirmationMode: "native_ui",
      onProgress: () => undefined,
      requestConfirmation: async (_requestId, action) => {
        confirmations += 1;
        hooks.onConfirmation?.(action.toolName);
        if (confirmations > 1 || action.toolName !== "annotate_pdf")
          return { approved: false };
        // The review card lists a comment field only when there is one.
        const hasCommentField = action.fields.some(
          (field) => field.id === "comment",
        );
        return {
          approved: true,
          ...(hasCommentField ? { data: { comment } } : {}),
        };
      },
      requestContext: {
        actionEntryPoint: "action_ui",
        activeItemId: input.attachmentId,
      },
    },
    "Save the selected text as a highlight annotation",
  );
  if (isVerifiedAnnotationSave(result)) {
    const status = result.actionReceipts![0].status as
      | "applied"
      | "already_satisfied";
    return { ok: true, status, result };
  }
  return { ok: false, error: failureText(result), result };
}
