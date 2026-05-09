/**
 * Paper context state management — pure state operations with no DOM dependencies.
 *
 * Manages:
 * - Send mode overrides (retrieval / full-next / full-sticky)
 * - Content source overrides (text / mineru / pdf)
 * - State clearing and lifecycle
 *
 * Override maps use flat composite keys: "ownerItemId:paperKey"
 */

import type {
  PaperContextRef,
  PaperContextSendMode,
  PaperContentSourceMode,
} from "../types";
import {
  selectedPaperContextCache,
  selectedOtherRefContextCache,
  paperContextModeOverrides,
  paperContentSourceOverrides,
  selectedPaperPreviewExpandedCache,
} from "../state";
import { buildPaperKey } from "../pdfContext";
import { normalizePaperContextRefs } from "../normalizers";
import { sanitizeText } from "../textUtils";

/** Builds the flat composite key for override maps. */
function overrideKey(itemId: number, paperContext: PaperContextRef): string {
  return `${itemId}:${buildPaperKey(paperContext)}`;
}

// ── Send mode overrides ────────────────────────────────────────────────────

export function getPaperModeOverride(
  itemId: number,
  paperContext: PaperContextRef,
): PaperContextSendMode | null {
  return (
    paperContextModeOverrides.get(overrideKey(itemId, paperContext)) || null
  );
}

export function setPaperModeOverride(
  itemId: number,
  paperContext: PaperContextRef,
  mode: PaperContextSendMode,
): void {
  paperContextModeOverrides.set(overrideKey(itemId, paperContext), mode);
}

export function clearPaperModeOverrides(itemId: number): void {
  const prefix = `${itemId}:`;
  for (const key of Array.from(paperContextModeOverrides.keys())) {
    if (key.startsWith(prefix)) paperContextModeOverrides.delete(key);
  }
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
  return (
    paperContentSourceOverrides.get(overrideKey(itemId, paperContext)) || null
  );
}

export function setPaperContentSourceOverride(
  itemId: number,
  paperContext: PaperContextRef,
  mode: PaperContentSourceMode,
): void {
  paperContentSourceOverrides.set(overrideKey(itemId, paperContext), mode);
}

export function clearPaperContentSourceOverrides(itemId: number): void {
  const prefix = `${itemId}:`;
  for (const key of Array.from(paperContentSourceOverrides.keys())) {
    if (key.startsWith(prefix)) paperContentSourceOverrides.delete(key);
  }
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
  selectedPaperContextCache.delete(itemId);
  selectedPaperPreviewExpandedCache.delete(itemId);
  clearPaperModeOverrides(itemId);
  // Note: content source overrides are NOT cleared here because auto-loaded
  // papers may still have overrides when selectedPaperContextCache is empty.
}

export function clearAllRefContextState(itemId: number): void {
  clearSelectedPaperState(itemId);
  selectedOtherRefContextCache.delete(itemId);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function normalizePaperContextEntries(
  value: unknown,
): PaperContextRef[] {
  return normalizePaperContextRefs(value, { sanitizeText });
}
