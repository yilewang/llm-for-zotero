import { formatPaperContextReferenceLabel } from "../../paperAttribution";
import type { PaperContextRef } from "../../types";
import type {
  AgentToolExecutionContext,
  AgentToolTarget,
  ResolvedAgentToolTarget,
} from "./types";

function getFirstPdfChildAttachment(
  item: Zotero.Item | null | undefined,
): Zotero.Item | null {
  if (!item || item.isAttachment()) return null;
  const attachments = item.getAttachments();
  for (const attachmentId of attachments) {
    const attachment = Zotero.Items.get(attachmentId);
    if (
      attachment &&
      attachment.isAttachment() &&
      attachment.attachmentContentType === "application/pdf"
    ) {
      return attachment;
    }
  }
  return null;
}

export function resolveContextItemFromPaperContext(
  paperContext: PaperContextRef,
): Zotero.Item | null {
  const direct = Zotero.Items.get(paperContext.contextItemId);
  if (
    direct &&
    direct.isAttachment() &&
    direct.attachmentContentType === "application/pdf"
  ) {
    return direct;
  }
  const item = Zotero.Items.get(paperContext.itemId);
  return getFirstPdfChildAttachment(item);
}

function formatTargetLabel(
  paperContext: PaperContextRef | null,
  fallback: string,
): string {
  if (!paperContext) return fallback;
  return formatPaperContextReferenceLabel(paperContext);
}

function selectIndexedPaper(
  papers: PaperContextRef[],
  index: number,
): PaperContextRef | null {
  if (!Number.isFinite(index) || index < 1) return null;
  return papers[Math.floor(index) - 1] || null;
}

export function resolveAgentToolTarget(
  ctx: AgentToolExecutionContext,
  target: AgentToolTarget,
): ResolvedAgentToolTarget {
  let paperContext: PaperContextRef | null = null;
  let fallbackLabel: string = target.scope;

  switch (target.scope) {
    case "active-paper":
      paperContext = ctx.activePaperContext || null;
      fallbackLabel = "active-paper";
      break;
    case "selected-paper":
      paperContext = selectIndexedPaper(
        ctx.selectedPaperContexts,
        target.index,
      );
      fallbackLabel = `selected-paper#${target.index}`;
      break;
    case "pinned-paper":
      paperContext = selectIndexedPaper(ctx.pinnedPaperContexts, target.index);
      fallbackLabel = `pinned-paper#${target.index}`;
      break;
    case "recent-paper":
      paperContext = selectIndexedPaper(ctx.recentPaperContexts, target.index);
      fallbackLabel = `recent-paper#${target.index}`;
      break;
    case "retrieved-paper":
      paperContext = selectIndexedPaper(
        ctx.retrievedPaperContexts,
        target.index,
      );
      fallbackLabel = `retrieved-paper#${target.index}`;
      break;
  }

  if (!paperContext) {
    return {
      paperContext: null,
      contextItem: null,
      targetLabel: fallbackLabel,
      error: `Target was unavailable: ${fallbackLabel}.`,
    };
  }

  return {
    paperContext,
    contextItem: resolveContextItemFromPaperContext(paperContext),
    targetLabel: formatTargetLabel(paperContext, fallbackLabel),
    resolvedKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
  };
}
