import { fnv1a32Raw } from "../../../../utils/fnv1a";
import { paperKey } from "../../../../shared/paperKey";
import type {
  ChatAttachment,
  PaperContextRef,
  SelectedTextContext,
} from "../../types";

function normalizeOwnerId(ownerId: number): number {
  return Number.isFinite(ownerId) && ownerId > 0 ? Math.floor(ownerId) : 0;
}

function getPinnedKeySet(
  map: Map<number, Set<string>>,
  ownerId: number,
): Set<string> {
  const normalizedOwnerId = normalizeOwnerId(ownerId);
  let keys = map.get(normalizedOwnerId);
  if (!keys) {
    keys = new Set<string>();
    map.set(normalizedOwnerId, keys);
  }
  return keys;
}

function getReadonlyPinnedKeySet(
  map: Map<number, Set<string>>,
  ownerId: number,
): Set<string> | null {
  const normalizedOwnerId = normalizeOwnerId(ownerId);
  if (!normalizedOwnerId) return null;
  return map.get(normalizedOwnerId) || null;
}

function cleanupPinnedOwnerIfEmpty(
  map: Map<number, Set<string>>,
  ownerId: number,
): void {
  const normalizedOwnerId = normalizeOwnerId(ownerId);
  if (!normalizedOwnerId) return;
  const keys = map.get(normalizedOwnerId);
  if (!keys?.size) {
    map.delete(normalizedOwnerId);
  }
}

function normalizeTextSource(
  source: SelectedTextContext["source"],
): "pdf" | "model" | "note" | "note-edit" {
  if (source === "model") return "model";
  if (source === "note") return "note";
  if (source === "note-edit") return "note-edit";
  return "pdf";
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function buildPinnedNoteKey(
  noteContext: SelectedTextContext["noteContext"],
): string {
  if (!noteContext) return "-";
  const libraryID = Number.isFinite(noteContext.libraryID)
    ? Math.max(0, Math.floor(noteContext.libraryID))
    : 0;
  const noteItemKey = normalizeText(noteContext.noteItemKey).toUpperCase();
  if (libraryID && noteItemKey) {
    return `${libraryID}:${noteItemKey}`;
  }
  const noteItemId = Number.isFinite(noteContext.noteItemId)
    ? Math.max(0, Math.floor(noteContext.noteItemId as number))
    : 0;
  return noteItemId ? `legacy:${noteItemId}:${noteContext.noteKind}` : "-";
}

/** Simple FNV-1a hash for short, collision-resistant text fingerprints. */
function hashText(text: string): string {
  return fnv1a32Raw(text).toString(36);
}

export function buildPinnedSelectedTextKey(
  context: SelectedTextContext,
): string {
  const text = normalizeText(context.text);
  const source = normalizeTextSource(context.source);
  const paperContext = context.paperContext;
  const paperPart = paperContext ? buildPinnedPaperKey(paperContext) : "-";
  const noteKey = buildPinnedNoteKey(context.noteContext);
  const contextItemId = Number.isFinite(context.contextItemId)
    ? Math.max(0, Math.floor(context.contextItemId!))
    : 0;
  const pageIndex = Number.isFinite(context.pageIndex)
    ? Math.max(0, Math.floor(context.pageIndex!))
    : -1;
  // Use text hash instead of full text to keep keys short and stable
  const textHash = hashText(text);
  return `${source}\u241f${noteKey}\u241f${paperPart}\u241f${contextItemId}\u241f${pageIndex}\u241f${textHash}`;
}

export function buildPinnedImageKey(imageUrl: string): string {
  return normalizeText(imageUrl);
}

export function buildPinnedFileKey(attachment: ChatAttachment): string {
  const id = typeof attachment.id === "string" ? attachment.id.trim() : "";
  if (id) return id;
  const name = normalizeText(attachment.name);
  const mimeType = normalizeText(attachment.mimeType);
  const size = Number.isFinite(attachment.sizeBytes)
    ? Math.max(0, attachment.sizeBytes)
    : 0;
  return `${name}\u241f${mimeType}\u241f${size}`;
}

export function buildPinnedPaperKey(paperContext: PaperContextRef): string {
  return paperKey(paperContext);
}

type PinnedKeyStore = Map<number, Set<string>>;

/**
 * The pin operations for one kind of context, keyed by `keyOf`. Every kind
 * shares the same owner rules: `toggle` writes through the creating getter
 * (owners <= 0 land under 0), while the read-only getter that `isPinned`,
 * `remove`, `retain`, and `prune` use ignores owner 0. An empty key is never
 * pinned or removed.
 */
function createPinnedKeySet<T>(keyOf: (value: T) => string) {
  const isPinned = (
    pinnedKeysByOwner: PinnedKeyStore,
    ownerId: number,
    value: T,
  ): boolean => {
    const keys = getReadonlyPinnedKeySet(pinnedKeysByOwner, ownerId);
    if (!keys?.size) return false;
    return keys.has(keyOf(value));
  };

  /** Returns the new pinned state. */
  const toggle = (
    pinnedKeysByOwner: PinnedKeyStore,
    ownerId: number,
    value: T,
  ): boolean => {
    const key = keyOf(value);
    if (!key) return false;
    const keys = getPinnedKeySet(pinnedKeysByOwner, ownerId);
    if (keys.has(key)) {
      keys.delete(key);
      cleanupPinnedOwnerIfEmpty(pinnedKeysByOwner, ownerId);
      return false;
    }
    keys.add(key);
    return true;
  };

  const remove = (
    pinnedKeysByOwner: PinnedKeyStore,
    ownerId: number,
    value: T,
  ): void => {
    const key = keyOf(value);
    if (!key) return;
    const keys = getReadonlyPinnedKeySet(pinnedKeysByOwner, ownerId);
    if (!keys?.size) return;
    keys.delete(key);
    cleanupPinnedOwnerIfEmpty(pinnedKeysByOwner, ownerId);
  };

  const prune = (
    pinnedKeysByOwner: PinnedKeyStore,
    ownerId: number,
    values: T[],
  ): void => {
    const keys = getReadonlyPinnedKeySet(pinnedKeysByOwner, ownerId);
    if (!keys?.size) return;
    const validKeys = new Set(values.map((value) => keyOf(value)));
    for (const key of Array.from(keys)) {
      if (!validKeys.has(key)) {
        keys.delete(key);
      }
    }
    cleanupPinnedOwnerIfEmpty(pinnedKeysByOwner, ownerId);
  };

  /** Keeps the pinned values (same objects) and prunes the other keys. */
  const retain = (
    pinnedKeysByOwner: PinnedKeyStore,
    ownerId: number,
    values: T[],
  ): T[] => {
    const keys = getReadonlyPinnedKeySet(pinnedKeysByOwner, ownerId);
    if (!keys?.size || !values.length) {
      pinnedKeysByOwner.delete(normalizeOwnerId(ownerId));
      return [];
    }
    const retained = values.filter((value) => keys.has(keyOf(value)));
    prune(pinnedKeysByOwner, ownerId, retained);
    return retained;
  };

  return { isPinned, toggle, remove, retain, prune };
}

const selectedTextPins = createPinnedKeySet(buildPinnedSelectedTextKey);
export const isPinnedSelectedText = selectedTextPins.isPinned;
export const togglePinnedSelectedText = selectedTextPins.toggle;
export const removePinnedSelectedText = selectedTextPins.remove;
export const retainPinnedSelectedTextContexts = selectedTextPins.retain;
export const prunePinnedSelectedTextKeys = selectedTextPins.prune;

const imagePins = createPinnedKeySet(buildPinnedImageKey);
export const isPinnedImage = imagePins.isPinned;
export const togglePinnedImage = imagePins.toggle;
export const removePinnedImage = imagePins.remove;
export const retainPinnedImages = imagePins.retain;
export const prunePinnedImageKeys = imagePins.prune;

const filePins = createPinnedKeySet(buildPinnedFileKey);
export const isPinnedFile = filePins.isPinned;
export const togglePinnedFile = filePins.toggle;
export const removePinnedFile = filePins.remove;
export const retainPinnedFiles = filePins.retain;
export const prunePinnedFileKeys = filePins.prune;

const paperPins = createPinnedKeySet(buildPinnedPaperKey);
export const isPinnedPaper = paperPins.isPinned;
export const togglePinnedPaper = paperPins.toggle;
export const removePinnedPaper = paperPins.remove;
export const retainPinnedPapers = paperPins.retain;
export const prunePinnedPaperKeys = paperPins.prune;

export function clearPinnedContextOwner(
  pinnedKeysByOwner: Map<number, Set<string>>,
  ownerId: number,
): void {
  const normalizedOwnerId = normalizeOwnerId(ownerId);
  if (!normalizedOwnerId) return;
  pinnedKeysByOwner.delete(normalizedOwnerId);
}
