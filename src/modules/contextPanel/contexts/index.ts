export type {
  ContextModule,
  ContextRegistry,
  PreviewRenderParams,
} from "./contextModule";

// ── Paper context state ──
export {
  getPaperModeOverride,
  setPaperModeOverride,
  clearPaperModeOverrides,
  isPaperContextFullTextMode,
  getPaperContentSourceOverride,
  setPaperContentSourceOverride,
  clearPaperContentSourceOverrides,
  getNextContentSourceMode,
  clearSelectedPaperState,
  clearAllRefContextState,
  normalizePaperContextEntries,
} from "./paperContextState";

// ── Image context state ──
export {
  clearSelectedImageState,
  retainPinnedImageState,
} from "./imageContextState";

// ── File context state ──
export {
  clearSelectedFileState,
  retainPinnedFileState,
} from "./fileContextState";

// ── Text context state ──
export {
  clearSelectedTextState,
  retainPinnedTextState,
} from "./textContextState";

// ── Utilities ──
export { TTLMap } from "./ttlMap";
