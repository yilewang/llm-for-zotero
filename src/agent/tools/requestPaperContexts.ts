import type { AgentRuntimeRequest } from "../types";
import type { PaperContextRef } from "../../shared/types";
import { getTurnPapers } from "../context/requestTurnPaperScope";

export function collectRequestPaperContexts(
  request: AgentRuntimeRequest,
): PaperContextRef[] {
  const out: PaperContextRef[] = [];
  const indexByKey = new Map<string, number>();
  const mergeContentSourceMode = (
    existing: PaperContextRef,
    incoming: PaperContextRef,
  ): PaperContextRef["contentSourceMode"] => {
    if (
      existing.contentSourceMode === "mineru" ||
      incoming.contentSourceMode === "mineru"
    ) {
      return "mineru";
    }
    return existing.contentSourceMode || incoming.contentSourceMode;
  };
  const merge = (
    existing: PaperContextRef,
    incoming: PaperContextRef,
  ): PaperContextRef => ({
    ...existing,
    attachmentTitle: existing.attachmentTitle || incoming.attachmentTitle,
    citationKey: existing.citationKey || incoming.citationKey,
    firstCreator: existing.firstCreator || incoming.firstCreator,
    year: existing.year || incoming.year,
    contentSourceMode: mergeContentSourceMode(existing, incoming),
    mineruCacheDir: existing.mineruCacheDir || incoming.mineruCacheDir,
  });
  const push = (entry: PaperContextRef | undefined) => {
    if (
      !entry ||
      !Number.isFinite(entry.itemId) ||
      !Number.isFinite(entry.contextItemId)
    ) {
      return;
    }
    const key = `${entry.libraryID || 0}:${entry.itemId}:${entry.contextItemId}`;
    const existingIndex = indexByKey.get(key);
    if (existingIndex !== undefined) {
      out[existingIndex] = merge(out[existingIndex], entry);
      return;
    }
    indexByKey.set(key, out.length);
    out.push(entry);
  };
  for (const entry of getTurnPapers(request)) push(entry);
  return out;
}
