/**
 * Compose-context store: one typed door to what the composer holds for each
 * owner (the papers, folders, tags, images, files and selected text that the
 * next send carries, and the chip panel state that goes with them).
 *
 * The store keeps no data of its own. Every slot reads and writes the Map,
 * Set or TTLMap instance that `state.ts` exports, so code (and tests) that
 * still use those instances directly see the same entries.
 *
 * Keys are as before:
 * - papers, other refs, collections, tags, images, files and their preview
 *   flags are keyed by the panel item id (`item.id`);
 * - selected texts and their expanded-index / note-expanded flags are keyed
 *   by the text-context conversation key (callers name the parameter
 *   `itemId`, but they pass the conversation key);
 * - the initialized-conversation set receives both item ids and
 *   conversation keys, depending on the writer;
 * - per-paper send-mode and source-mode overrides are keyed by
 *   `ownerScopedPaperKey(ownerItemId, paper)`.
 */

import type {
  ChatAttachment,
  CollectionContextRef,
  OtherContextRef,
  PaperContentSourceMode,
  PaperContextRef,
  PaperContextSendMode,
  SelectedTextContext,
  TagContextRef,
} from "../types";
import {
  initializedConversationComposeContextKeys,
  paperContentSourceOverrides,
  paperContextModeOverrides,
  pinnedFileKeys,
  pinnedImageKeys,
  pinnedSelectedTextKeys,
  selectedCollectionContextCache,
  selectedFileAttachmentCache,
  selectedFilePreviewExpandedCache,
  selectedImageCache,
  selectedImagePreviewActiveIndexCache,
  selectedImagePreviewExpandedCache,
  selectedNotePreviewExpandedCache,
  selectedOtherRefContextCache,
  selectedPaperContextCache,
  selectedPaperContextListExpandedCache,
  selectedPaperPreviewExpandedCache,
  selectedTagContextCache,
  selectedTextCache,
  selectedTextPreviewExpandedCache,
} from "../state";
import {
  ownerScopedPaperKey,
  type PaperKeyRef,
} from "../../../shared/paperKey";

/** The part of Map / TTLMap that a slot uses. */
type OwnerBackingMap<V> = {
  get(key: number): V | undefined;
  set(key: number, value: V): unknown;
  has(key: number): boolean;
  delete(key: number): boolean;
};

/** One value per owner. */
export type ComposeOwnerSlot<V> = {
  get(ownerId: number): V | undefined;
  has(ownerId: number): boolean;
  set(ownerId: number, value: V): void;
  delete(ownerId: number): boolean;
};

/** One list per owner. */
export type ComposeListSlot<T> = ComposeOwnerSlot<T[]> & {
  /** The stored list itself, or a new empty array when there is none. */
  list(ownerId: number): T[];
  /** Store a non-empty list as given; delete the entry for an empty one. */
  replace(ownerId: number, entries: T[] | null | undefined): void;
};

/** One mode per (owner, paper), keyed by `ownerScopedPaperKey`. */
export type ComposePaperOverrideSlot<M> = {
  get(ownerId: number, paper: PaperKeyRef): M | null;
  set(ownerId: number, paper: PaperKeyRef, mode: M): void;
  delete(ownerId: number, paper: PaperKeyRef): boolean;
  /** Delete every entry whose key starts with `${ownerId}:`. */
  clearOwner(ownerId: number): void;
};

function ownerSlot<V>(map: OwnerBackingMap<V>): ComposeOwnerSlot<V> {
  return {
    get: (ownerId) => map.get(ownerId),
    has: (ownerId) => map.has(ownerId),
    set: (ownerId, value) => {
      map.set(ownerId, value);
    },
    delete: (ownerId) => map.delete(ownerId),
  };
}

function listSlot<T>(map: OwnerBackingMap<T[]>): ComposeListSlot<T> {
  return {
    ...ownerSlot(map),
    list: (ownerId) => map.get(ownerId) || [],
    replace: (ownerId, entries) => {
      if (entries?.length) map.set(ownerId, entries);
      else map.delete(ownerId);
    },
  };
}

function paperOverrideSlot<M>(
  map: Map<string, M>,
): ComposePaperOverrideSlot<M> {
  return {
    get: (ownerId, paper) =>
      map.get(ownerScopedPaperKey(ownerId, paper)) || null,
    set: (ownerId, paper, mode) => {
      map.set(ownerScopedPaperKey(ownerId, paper), mode);
    },
    delete: (ownerId, paper) => map.delete(ownerScopedPaperKey(ownerId, paper)),
    clearOwner: (ownerId) => {
      const prefix = `${ownerId}:`;
      for (const key of Array.from(map.keys())) {
        if (key.startsWith(prefix)) map.delete(key);
      }
    },
  };
}

export const composeContextStore = {
  // Keyed by panel item id.
  papers: listSlot<PaperContextRef>(selectedPaperContextCache),
  otherRefs: listSlot<OtherContextRef>(selectedOtherRefContextCache),
  collections: listSlot<CollectionContextRef>(selectedCollectionContextCache),
  tags: listSlot<TagContextRef>(selectedTagContextCache),
  /** The contextItemId of the sticky paper chip, or false for none. */
  paperPreviewExpanded: ownerSlot<number | false>(
    selectedPaperPreviewExpandedCache,
  ),
  paperListExpanded: ownerSlot<boolean>(selectedPaperContextListExpandedCache),
  images: listSlot<string>(selectedImageCache),
  imagePreviewExpanded: ownerSlot<boolean>(selectedImagePreviewExpandedCache),
  imagePreviewActiveIndex: ownerSlot<number>(
    selectedImagePreviewActiveIndexCache,
  ),
  files: listSlot<ChatAttachment>(selectedFileAttachmentCache),
  filePreviewExpanded: ownerSlot<boolean>(selectedFilePreviewExpandedCache),

  // Keyed by the text-context conversation key.
  /** Raw selected-text entries; contextResolution normalizes on read. */
  selectedTexts: listSlot<SelectedTextContext>(selectedTextCache),
  selectedTextExpandedIndex: ownerSlot<number>(
    selectedTextPreviewExpandedCache,
  ),
  notePreviewExpanded: ownerSlot<boolean>(selectedNotePreviewExpandedCache),

  /**
   * Pinned-entry key sets per owner. pinnedContextController owns the pin
   * operations; these are the maps it works on.
   */
  pinnedKeys: {
    selectedTexts: pinnedSelectedTextKeys,
    images: pinnedImageKeys,
    files: pinnedFileKeys,
  },

  /**
   * Owners whose paper/collection/tag composer state is set up. Membership
   * counts even when every list is empty. Writers mark item ids and
   * conversation keys.
   */
  initializedConversations: {
    has: (key: number): boolean =>
      initializedConversationComposeContextKeys.has(key),
    mark: (key: number): void => {
      initializedConversationComposeContextKeys.add(key);
    },
    forget: (key: number): void => {
      initializedConversationComposeContextKeys.delete(key);
    },
  },

  paperSendModes: paperOverrideSlot<PaperContextSendMode>(
    paperContextModeOverrides,
  ),
  paperSourceModes: paperOverrideSlot<PaperContentSourceMode>(
    paperContentSourceOverrides,
  ),
};

export type ComposeContextStore = typeof composeContextStore;
