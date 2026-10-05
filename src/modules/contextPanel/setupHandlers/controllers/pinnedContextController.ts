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

export function isPinnedSelectedText(
  pinnedKeysByOwner: Map<number, Set<string>>,
  ownerId: number,
  context: SelectedTextContext,
): boolean {
  const keys = getReadonlyPinnedKeySet(pinnedKeysByOwner, ownerId);
  if (!keys?.size) return false;
  return keys.has(buildPinnedSelectedTextKey(context));
}

export function togglePinnedSelectedText(
  pinnedKeysByOwner: Map<number, Set<string>>,
  ownerId: number,
  context: SelectedTextContext,
): boolean {
  const key = buildPinnedSelectedTextKey(context);
  const keys = getPinnedKeySet(pinnedKeysByOwner, ownerId);
  if (keys.has(key)) {
    keys.delete(key);
    cleanupPinnedOwnerIfEmpty(pinnedKeysByOwner, ownerId);
    return false;
  }
  keys.add(key);
  return true;
}

export function removePinnedSelectedText(
  pinnedKeysByOwner: Map<number, Set<string>>,
  ownerId: number,
  context: SelectedTextContext,
): void {
  const keys = getReadonlyPinnedKeySet(pinnedKeysByOwner, ownerId);
  if (!keys?.size) return;
  keys.delete(buildPinnedSelectedTextKey(context));
  cleanupPinnedOwnerIfEmpty(pinnedKeysByOwner, ownerId);
}

export function retainPinnedSelectedTextContexts(
  pinnedKeysByOwner: Map<number, Set<string>>,
  ownerId: number,
  contexts: SelectedTextContext[],
): SelectedTextContext[] {
  const keys = getReadonlyPinnedKeySet(pinnedKeysByOwner, ownerId);
  if (!keys?.size || !contexts.length) {
    pinnedKeysByOwner.delete(normalizeOwnerId(ownerId));
    return [];
  }
  const retained = contexts.filter((context) =>
    keys.has(buildPinnedSelectedTextKey(context)),
  );
  prunePinnedSelectedTextKeys(pinnedKeysByOwner, ownerId, retained);
  return retained;
}

export function prunePinnedSelectedTextKeys(
  pinnedKeysByOwner: Map<number, Set<string>>,
  ownerId: number,
  contexts: SelectedTextContext[],
): void {
  const keys = getReadonlyPinnedKeySet(pinnedKeysByOwner, ownerId);
  if (!keys?.size) return;
  const validKeys = new Set(
    contexts.map((context) => buildPinnedSelectedTextKey(context)),
  );
  for (const key of Array.from(keys)) {
    if (!validKeys.has(key)) {
      keys.delete(key);
    }
  }
  cleanupPinnedOwnerIfEmpty(pinnedKeysByOwner, ownerId);
}

export function isPinnedImage(
  pinnedKeysByOwner: Map<number, Set<string>>,
  ownerId: number,
  imageUrl: string,
): boolean {
  const keys = getReadonlyPinnedKeySet(pinnedKeysByOwner, ownerId);
  if (!keys?.size) return false;
  return keys.has(buildPinnedImageKey(imageUrl));
}

export function togglePinnedImage(
  pinnedKeysByOwner: Map<number, Set<string>>,
  ownerId: number,
  imageUrl: string,
): boolean {
  const key = buildPinnedImageKey(imageUrl);
  if (!key) return false;
  const keys = getPinnedKeySet(pinnedKeysByOwner, ownerId);
  if (keys.has(key)) {
    keys.delete(key);
    cleanupPinnedOwnerIfEmpty(pinnedKeysByOwner, ownerId);
    return false;
  }
  keys.add(key);
  return true;
}

export function removePinnedImage(
  pinnedKeysByOwner: Map<number, Set<string>>,
  ownerId: number,
  imageUrl: string,
): void {
  const key = buildPinnedImageKey(imageUrl);
  if (!key) return;
  const keys = getReadonlyPinnedKeySet(pinnedKeysByOwner, ownerId);
  if (!keys?.size) return;
  keys.delete(key);
  cleanupPinnedOwnerIfEmpty(pinnedKeysByOwner, ownerId);
}

export function retainPinnedImages(
  pinnedKeysByOwner: Map<number, Set<string>>,
  ownerId: number,
  images: string[],
): string[] {
  const keys = getReadonlyPinnedKeySet(pinnedKeysByOwner, ownerId);
  if (!keys?.size || !images.length) {
    pinnedKeysByOwner.delete(normalizeOwnerId(ownerId));
    return [];
  }
  const retained = images.filter((imageUrl) =>
    keys.has(buildPinnedImageKey(imageUrl)),
  );
  prunePinnedImageKeys(pinnedKeysByOwner, ownerId, retained);
  return retained;
}

export function prunePinnedImageKeys(
  pinnedKeysByOwner: Map<number, Set<string>>,
  ownerId: number,
  images: string[],
): void {
  const keys = getReadonlyPinnedKeySet(pinnedKeysByOwner, ownerId);
  if (!keys?.size) return;
  const validKeys = new Set(
    images.map((imageUrl) => buildPinnedImageKey(imageUrl)),
  );
  for (const key of Array.from(keys)) {
    if (!validKeys.has(key)) {
      keys.delete(key);
    }
  }
  cleanupPinnedOwnerIfEmpty(pinnedKeysByOwner, ownerId);
}

export function isPinnedFile(
  pinnedKeysByOwner: Map<number, Set<string>>,
  ownerId: number,
  attachment: ChatAttachment,
): boolean {
  const keys = getReadonlyPinnedKeySet(pinnedKeysByOwner, ownerId);
  if (!keys?.size) return false;
  return keys.has(buildPinnedFileKey(attachment));
}

export function togglePinnedFile(
  pinnedKeysByOwner: Map<number, Set<string>>,
  ownerId: number,
  attachment: ChatAttachment,
): boolean {
  const key = buildPinnedFileKey(attachment);
  if (!key) return false;
  const keys = getPinnedKeySet(pinnedKeysByOwner, ownerId);
  if (keys.has(key)) {
    keys.delete(key);
    cleanupPinnedOwnerIfEmpty(pinnedKeysByOwner, ownerId);
    return false;
  }
  keys.add(key);
  return true;
}

export function removePinnedFile(
  pinnedKeysByOwner: Map<number, Set<string>>,
  ownerId: number,
  attachment: ChatAttachment,
): void {
  const key = buildPinnedFileKey(attachment);
  if (!key) return;
  const keys = getReadonlyPinnedKeySet(pinnedKeysByOwner, ownerId);
  if (!keys?.size) return;
  keys.delete(key);
  cleanupPinnedOwnerIfEmpty(pinnedKeysByOwner, ownerId);
}

export function retainPinnedFiles(
  pinnedKeysByOwner: Map<number, Set<string>>,
  ownerId: number,
  attachments: ChatAttachment[],
): ChatAttachment[] {
  const keys = getReadonlyPinnedKeySet(pinnedKeysByOwner, ownerId);
  if (!keys?.size || !attachments.length) {
    pinnedKeysByOwner.delete(normalizeOwnerId(ownerId));
    return [];
  }
  const retained = attachments.filter((attachment) =>
    keys.has(buildPinnedFileKey(attachment)),
  );
  prunePinnedFileKeys(pinnedKeysByOwner, ownerId, retained);
  return retained;
}

export function prunePinnedFileKeys(
  pinnedKeysByOwner: Map<number, Set<string>>,
  ownerId: number,
  attachments: ChatAttachment[],
): void {
  const keys = getReadonlyPinnedKeySet(pinnedKeysByOwner, ownerId);
  if (!keys?.size) return;
  const validKeys = new Set(
    attachments.map((attachment) => buildPinnedFileKey(attachment)),
  );
  for (const key of Array.from(keys)) {
    if (!validKeys.has(key)) {
      keys.delete(key);
    }
  }
  cleanupPinnedOwnerIfEmpty(pinnedKeysByOwner, ownerId);
}

export function isPinnedPaper(
  pinnedKeysByOwner: Map<number, Set<string>>,
  ownerId: number,
  paperContext: PaperContextRef,
): boolean {
  const keys = getReadonlyPinnedKeySet(pinnedKeysByOwner, ownerId);
  if (!keys?.size) return false;
  return keys.has(buildPinnedPaperKey(paperContext));
}

export function togglePinnedPaper(
  pinnedKeysByOwner: Map<number, Set<string>>,
  ownerId: number,
  paperContext: PaperContextRef,
): boolean {
  const key = buildPinnedPaperKey(paperContext);
  if (!key) return false;
  const keys = getPinnedKeySet(pinnedKeysByOwner, ownerId);
  if (keys.has(key)) {
    keys.delete(key);
    cleanupPinnedOwnerIfEmpty(pinnedKeysByOwner, ownerId);
    return false;
  }
  keys.add(key);
  return true;
}

export function removePinnedPaper(
  pinnedKeysByOwner: Map<number, Set<string>>,
  ownerId: number,
  paperContext: PaperContextRef,
): void {
  const key = buildPinnedPaperKey(paperContext);
  if (!key) return;
  const keys = getReadonlyPinnedKeySet(pinnedKeysByOwner, ownerId);
  if (!keys?.size) return;
  keys.delete(key);
  cleanupPinnedOwnerIfEmpty(pinnedKeysByOwner, ownerId);
}

export function retainPinnedPapers(
  pinnedKeysByOwner: Map<number, Set<string>>,
  ownerId: number,
  paperContexts: PaperContextRef[],
): PaperContextRef[] {
  const keys = getReadonlyPinnedKeySet(pinnedKeysByOwner, ownerId);
  if (!keys?.size || !paperContexts.length) {
    pinnedKeysByOwner.delete(normalizeOwnerId(ownerId));
    return [];
  }
  const retained = paperContexts.filter((paperContext) =>
    keys.has(buildPinnedPaperKey(paperContext)),
  );
  prunePinnedPaperKeys(pinnedKeysByOwner, ownerId, retained);
  return retained;
}

export function prunePinnedPaperKeys(
  pinnedKeysByOwner: Map<number, Set<string>>,
  ownerId: number,
  paperContexts: PaperContextRef[],
): void {
  const keys = getReadonlyPinnedKeySet(pinnedKeysByOwner, ownerId);
  if (!keys?.size) return;
  const validKeys = new Set(
    paperContexts.map((paperContext) => buildPinnedPaperKey(paperContext)),
  );
  for (const key of Array.from(keys)) {
    if (!validKeys.has(key)) {
      keys.delete(key);
    }
  }
  cleanupPinnedOwnerIfEmpty(pinnedKeysByOwner, ownerId);
}

export function clearPinnedContextOwner(
  pinnedKeysByOwner: Map<number, Set<string>>,
  ownerId: number,
): void {
  const normalizedOwnerId = normalizeOwnerId(ownerId);
  if (!normalizedOwnerId) return;
  pinnedKeysByOwner.delete(normalizedOwnerId);
}
