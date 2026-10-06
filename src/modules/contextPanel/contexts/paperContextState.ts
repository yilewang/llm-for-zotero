/**
 * Paper context state management — pure state operations with no DOM dependencies.
 *
 * Manages:
 * - Send mode overrides (retrieval / full-next / full-sticky)
 * - Content source overrides (text / mineru / pdf)
 * - State clearing and lifecycle
 *
 * Override maps use flat composite keys: "ownerItemId:paperKey"
 * (see composeContextStore.paperSendModes / paperSourceModes).
 */

import type {
  PaperContextRef,
  PaperContextSendMode,
  PaperContentSourceMode,
} from "../types";
import { composeContextStore } from "./composeContextStore";
import { normalizePaperContextRefs } from "../../../services/context/normalizers";
import { sanitizeText } from "../../../utils/textSanitization";

// ── Send mode overrides ────────────────────────────────────────────────────

export function getPaperModeOverride(
  itemId: number,
  paperContext: PaperContextRef,
): PaperContextSendMode | null {
  return composeContextStore.paperSendModes.get(itemId, paperContext);
}

export function setPaperModeOverride(
  itemId: number,
  paperContext: PaperContextRef,
  mode: PaperContextSendMode,
): void {
  composeContextStore.paperSendModes.set(itemId, paperContext, mode);
}

export function clearPaperModeOverrides(itemId: number): void {
  composeContextStore.paperSendModes.clearOwner(itemId);
}

export function isPaperContextFullTextMode(
  mode: PaperContextSendMode | null | undefined,
): boolean {
  return mode === "full-next" || mode === "full-sticky";
}

// ── Content source overrides ────────────────────────────────────────────────

export function getPaperContentSourceOverride(
  itemId: number,
  paperContext: PaperContextRef,
): PaperContentSourceMode | null {
  return composeContextStore.paperSourceModes.get(itemId, paperContext);
}

export function setPaperContentSourceOverride(
  itemId: number,
  paperContext: PaperContextRef,
  mode: PaperContentSourceMode,
): void {
  composeContextStore.paperSourceModes.set(itemId, paperContext, mode);
}

export function clearPaperContentSourceOverride(
  itemId: number,
  paperContext: PaperContextRef,
): void {
  composeContextStore.paperSourceModes.delete(itemId, paperContext);
}

export function clearPaperContentSourceOverrides(itemId: number): void {
  composeContextStore.paperSourceModes.clearOwner(itemId);
}

export function getNextContentSourceMode(
  current: PaperContentSourceMode,
  hasMinerU: boolean,
): PaperContentSourceMode {
  if (hasMinerU) {
    return current === "pdf" ? "mineru" : "pdf";
  }
  return current === "pdf" ? "text" : "pdf";
}

// ── State clearing ──────────────────────────────────────────────────────────

export function clearSelectedPaperState(itemId: number): void {
  composeContextStore.papers.delete(itemId);
  composeContextStore.paperPreviewExpanded.delete(itemId);
  composeContextStore.paperListExpanded.delete(itemId);
  clearPaperModeOverrides(itemId);
  // Note: content source overrides are NOT cleared here because auto-loaded
  // papers may still have overrides when the papers list is empty.
}

export function clearAllRefContextState(itemId: number): void {
  clearSelectedPaperState(itemId);
  composeContextStore.collections.delete(itemId);
  composeContextStore.tags.delete(itemId);
  composeContextStore.otherRefs.delete(itemId);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function normalizePaperContextEntries(
  value: unknown,
): PaperContextRef[] {
  return normalizePaperContextRefs(value, { sanitizeText });
}
