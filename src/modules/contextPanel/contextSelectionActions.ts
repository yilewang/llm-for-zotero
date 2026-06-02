import { t } from "../../utils/i18n";
import { MAX_SELECTED_PAPER_CONTEXTS } from "./constants";
import {
  appendSelectedTextContextForItem,
  getSelectedTextContextEntries,
  setSelectedTextContextEntries,
} from "./contextResolution";
import { setPaperModeOverride } from "./contexts/paperContextState";
import { isSamePaperContextRef } from "./modeBehavior";
import { readNoteSnapshot } from "./notes";
import { resolvePaperContextRefFromItem } from "./paperAttribution";
import type {
  PaperSearchAttachmentCandidate,
  PaperSearchGroupCandidate,
} from "./paperSearch";
import { buildPaperKey } from "./pdfContext";
import {
  buildReferenceSelectorTagContextKey,
  normalizeReferenceSelectorTagIdentityName,
} from "./referenceSelector/model";
import {
  selectedCollectionContextCache,
  selectedOtherRefContextCache,
  selectedPaperContextCache,
  selectedPaperPreviewExpandedCache,
  paperContextModeOverrides,
  selectedTagContextCache,
} from "./state";
import type {
  CollectionContextRef,
  OtherContextRef,
  PaperContextRef,
  TagContextRef,
} from "./types";
import { resolvePaperContextDisplayMetadata } from "./setupHandlers/controllers/composeContextController";

export type ContextSelectionStatusLevel = "ready" | "warning" | "error";
export type ReferenceAttachmentContextKind =
  | "pdf"
  | "note"
  | "figure"
  | "other";

export type ContextSelectionActionResult = {
  changed: boolean;
  statusMessage?: string;
  statusLevel?: ContextSelectionStatusLevel;
};

export type ContextSelectionActionDeps = {
  item: Zotero.Item | null;
  resolveAutoLoadedPaperContext: () => PaperContextRef | null;
  getManualPaperContextsForItem: (
    itemId: number,
    autoLoadedPaperContext: PaperContextRef | null,
  ) => PaperContextRef[];
  isPaperContextMineru: (paperContext: PaperContextRef) => boolean;
  getTextContextConversationKey: () => number | null;
  updatePaperPreviewPreservingScroll: () => void;
  updateSelectedTextPreviewPreservingScroll: () => void;
};

const unchanged = (
  statusMessage?: string,
  statusLevel?: ContextSelectionStatusLevel,
): ContextSelectionActionResult => ({
  changed: false,
  statusMessage,
  statusLevel,
});

const changed = (
  statusMessage?: string,
  statusLevel?: ContextSelectionStatusLevel,
): ContextSelectionActionResult => ({
  changed: true,
  statusMessage,
  statusLevel,
});

export function upsertPaperContext(
  deps: ContextSelectionActionDeps,
  paper: PaperContextRef,
): ContextSelectionActionResult {
  const item = deps.item;
  if (!item) return unchanged();
  const autoLoadedPaperContext = deps.resolveAutoLoadedPaperContext();
  if (isSamePaperContextRef(paper, autoLoadedPaperContext)) {
    return unchanged(t("Paper already selected"), "warning");
  }
  const selectedPapers = deps.getManualPaperContextsForItem(
    item.id,
    autoLoadedPaperContext,
  );
  const duplicate = selectedPapers.some(
    (entry) =>
      entry.itemId === paper.itemId &&
      entry.contextItemId === paper.contextItemId,
  );
  if (duplicate) return unchanged(t("Paper already selected"), "warning");
  if (selectedPapers.length >= MAX_SELECTED_PAPER_CONTEXTS) {
    return unchanged(`Paper Context up to ${MAX_SELECTED_PAPER_CONTEXTS}`, "error");
  }
  const metadata = resolvePaperContextDisplayMetadata(paper);
  const nextPapers = [
    ...selectedPapers,
    {
      ...paper,
      firstCreator: metadata.firstCreator || paper.firstCreator,
      year: metadata.year || paper.year,
    },
  ];
  selectedPaperContextCache.set(item.id, nextPapers);
  setPaperModeOverride(item.id, nextPapers[nextPapers.length - 1], "full-next");
  selectedPaperPreviewExpandedCache.set(item.id, false);
  deps.updatePaperPreviewPreservingScroll();
  const addedPaper = nextPapers[nextPapers.length - 1];
  const mineruTag = deps.isPaperContextMineru(addedPaper)
    ? ` ${t("(MinerU)")}`
    : "";
  return changed(
    `${t("Paper context added. Full text will be sent on the next turn.")}${mineruTag}`,
    "ready",
  );
}

export function upsertNoteTextContext(
  deps: ContextSelectionActionDeps,
  contextItemId: number,
): ContextSelectionActionResult {
  const item = deps.item;
  const textContextKey = deps.getTextContextConversationKey();
  if (!item || !textContextKey) return unchanged();
  const noteItem = Zotero.Items.get(contextItemId) || null;
  const snapshot = readNoteSnapshot(noteItem);
  if (!snapshot?.text) return unchanged(t("Selected note is empty"), "warning");
  const appended = appendSelectedTextContextForItem(
    textContextKey,
    snapshot.text,
    "note",
    undefined,
    { contextItemId: snapshot.noteId },
    {
      libraryID: snapshot.libraryID,
      noteItemKey: snapshot.noteItemKey || "",
      noteItemId: snapshot.noteId,
      parentItemId: snapshot.parentItemId,
      parentItemKey: snapshot.parentItemKey,
      noteKind: snapshot.noteKind,
      title: snapshot.title || `Note ${snapshot.noteId}`,
    },
  );
  if (!appended) return unchanged(t("Note already selected"), "warning");
  deps.updateSelectedTextPreviewPreservingScroll();
  return changed(t("Note context added as text."), "ready");
}

export function addZoteroItemsAsContext(
  deps: ContextSelectionActionDeps,
  zoteroItems: Zotero.Item[],
): ContextSelectionActionResult {
  if (!deps.item) return unchanged();
  let added = 0;
  let skipped = 0;
  let lastResult: ContextSelectionActionResult = unchanged();
  for (const zoteroItem of zoteroItems) {
    if ((zoteroItem as any).isNote?.()) {
      lastResult = upsertNoteTextContext(deps, zoteroItem.id);
    } else {
      const ref = resolvePaperContextRefFromItem(zoteroItem);
      lastResult = ref ? upsertPaperContext(deps, ref) : unchanged();
    }
    if (lastResult.changed) added += 1;
    else skipped += 1;
  }
  if (zoteroItems.length > 1) {
    if (added > 0 && skipped > 0) {
      return changed(`Added ${added} paper(s), ${skipped} skipped`, "warning");
    }
    if (added > 0) {
      return changed(`Added ${added} paper(s) as context`, "ready");
    }
  }
  return lastResult;
}

export function upsertOtherRefContext(
  deps: ContextSelectionActionDeps,
  ref: OtherContextRef,
): ContextSelectionActionResult {
  const item = deps.item;
  if (!item) return unchanged();
  const existing = selectedOtherRefContextCache.get(item.id) || [];
  if (existing.some((entry) => entry.contextItemId === ref.contextItemId)) {
    return unchanged(t("File already selected"), "warning");
  }
  selectedOtherRefContextCache.set(item.id, [...existing, ref]);
  deps.updatePaperPreviewPreservingScroll();
  return changed(
    `${ref.refKind === "figure" ? "Figure" : "File"} context added.`,
    "ready",
  );
}

export function upsertReferenceAttachmentContext(params: {
  deps: ContextSelectionActionDeps;
  selectedGroup: PaperSearchGroupCandidate;
  selectedAttachment: PaperSearchAttachmentCandidate;
  kind: ReferenceAttachmentContextKind;
}): ContextSelectionActionResult {
  const { deps, selectedGroup, selectedAttachment, kind } = params;
  if (kind === "pdf") {
    return upsertPaperContext(deps, {
      itemId: selectedGroup.itemId,
      contextItemId: selectedAttachment.contextItemId,
      title: selectedGroup.title,
      attachmentTitle: selectedAttachment.title,
      citationKey: selectedGroup.citationKey,
      firstCreator: selectedGroup.firstCreator,
      year: selectedGroup.year,
    });
  }
  if (kind === "note") {
    return upsertNoteTextContext(deps, selectedAttachment.contextItemId);
  }
  return upsertOtherRefContext(deps, {
    contextItemId: selectedAttachment.contextItemId,
    parentItemId:
      selectedGroup.itemId !== selectedAttachment.contextItemId
        ? selectedGroup.itemId
        : undefined,
    title: selectedAttachment.title || selectedGroup.title,
    contentType: selectedAttachment.contentType || "application/octet-stream",
    refKind: kind === "figure" ? "figure" : "other",
  });
}

export function removeReferenceAttachmentContext(params: {
  deps: ContextSelectionActionDeps;
  selectedGroup: PaperSearchGroupCandidate;
  selectedAttachment: PaperSearchAttachmentCandidate;
  kind: ReferenceAttachmentContextKind;
  silent?: boolean;
}): ContextSelectionActionResult {
  const { deps, selectedGroup, selectedAttachment, kind, silent } = params;
  const item = deps.item;
  if (!item) return unchanged();
  let removed = false;
  if (kind === "pdf") {
    const existing = selectedPaperContextCache.get(item.id) || [];
    const removedPapers = existing.filter(
      (paper) =>
        paper.itemId === selectedGroup.itemId &&
        paper.contextItemId === selectedAttachment.contextItemId,
    );
    if (removedPapers.length) {
      const next = existing.filter(
        (paper) =>
          !(
            paper.itemId === selectedGroup.itemId &&
            paper.contextItemId === selectedAttachment.contextItemId
          ),
      );
      if (next.length) selectedPaperContextCache.set(item.id, next);
      else selectedPaperContextCache.delete(item.id);
      for (const paper of removedPapers) {
        paperContextModeOverrides.delete(`${item.id}:${buildPaperKey(paper)}`);
      }
      selectedPaperPreviewExpandedCache.set(item.id, false);
      deps.updatePaperPreviewPreservingScroll();
      removed = true;
    }
  } else if (kind === "note") {
    const textContextKey = deps.getTextContextConversationKey();
    if (textContextKey) {
      const existing = getSelectedTextContextEntries(textContextKey);
      const next = existing.filter((entry) => {
        if (entry.source !== "note") return true;
        const noteItemId = Number(
          entry.noteContext?.noteItemId || entry.contextItemId || 0,
        );
        return noteItemId !== selectedAttachment.contextItemId;
      });
      if (next.length !== existing.length) {
        setSelectedTextContextEntries(textContextKey, next);
        deps.updateSelectedTextPreviewPreservingScroll();
        removed = true;
      }
    }
  } else {
    const existing = selectedOtherRefContextCache.get(item.id) || [];
    const next = existing.filter(
      (ref) => ref.contextItemId !== selectedAttachment.contextItemId,
    );
    if (next.length !== existing.length) {
      if (next.length) selectedOtherRefContextCache.set(item.id, next);
      else selectedOtherRefContextCache.delete(item.id);
      deps.updatePaperPreviewPreservingScroll();
      removed = true;
    }
  }
  if (!removed) return unchanged();
  return changed(silent ? undefined : t("Reference context removed."), "ready");
}

export function removeReferenceGroupContexts(params: {
  deps: ContextSelectionActionDeps;
  group: PaperSearchGroupCandidate;
}): ContextSelectionActionResult {
  const { deps, group } = params;
  const item = deps.item;
  if (!item) return unchanged();
  const attachmentIds = new Set(
    group.attachments.map((attachment) => attachment.contextItemId),
  );
  let removed = false;

  const existingPapers = selectedPaperContextCache.get(item.id) || [];
  const removedPapers = existingPapers.filter(
    (paper) =>
      paper.itemId === group.itemId || attachmentIds.has(paper.contextItemId),
  );
  if (removedPapers.length) {
    const nextPapers = existingPapers.filter(
      (paper) =>
        !(paper.itemId === group.itemId || attachmentIds.has(paper.contextItemId)),
    );
    if (nextPapers.length) selectedPaperContextCache.set(item.id, nextPapers);
    else selectedPaperContextCache.delete(item.id);
    for (const paper of removedPapers) {
      paperContextModeOverrides.delete(`${item.id}:${buildPaperKey(paper)}`);
    }
    selectedPaperPreviewExpandedCache.set(item.id, false);
    removed = true;
  }

  const existingOtherRefs = selectedOtherRefContextCache.get(item.id) || [];
  const nextOtherRefs = existingOtherRefs.filter(
    (ref) => !attachmentIds.has(ref.contextItemId),
  );
  if (nextOtherRefs.length !== existingOtherRefs.length) {
    if (nextOtherRefs.length) selectedOtherRefContextCache.set(item.id, nextOtherRefs);
    else selectedOtherRefContextCache.delete(item.id);
    removed = true;
  }

  const textContextKey = deps.getTextContextConversationKey();
  if (textContextKey) {
    const existingTexts = getSelectedTextContextEntries(textContextKey);
    const nextTexts = existingTexts.filter((entry) => {
      if (entry.source !== "note") return true;
      const noteItemId = Number(
        entry.noteContext?.noteItemId || entry.contextItemId || 0,
      );
      return !attachmentIds.has(noteItemId);
    });
    if (nextTexts.length !== existingTexts.length) {
      setSelectedTextContextEntries(textContextKey, nextTexts);
      deps.updateSelectedTextPreviewPreservingScroll();
      removed = true;
    }
  }

  if (!removed) return unchanged();
  deps.updatePaperPreviewPreservingScroll();
  return changed(t("Reference context removed."), "ready");
}

export function toggleCollectionContext(params: {
  deps: ContextSelectionActionDeps;
  ref: CollectionContextRef;
}): ContextSelectionActionResult {
  const { deps, ref } = params;
  const item = deps.item;
  if (!item) return unchanged();
  const existing = selectedCollectionContextCache.get(item.id) || [];
  const existingIndex = existing.findIndex(
    (entry) => entry.collectionId === ref.collectionId,
  );
  if (existingIndex >= 0) {
    const next = existing.filter((_, index) => index !== existingIndex);
    if (next.length) selectedCollectionContextCache.set(item.id, next);
    else selectedCollectionContextCache.delete(item.id);
    deps.updatePaperPreviewPreservingScroll();
    return changed(t("Collection context removed."), "ready");
  }
  selectedCollectionContextCache.set(item.id, [...existing, ref]);
  deps.updatePaperPreviewPreservingScroll();
  return changed(t("Collection context added."), "ready");
}

export function normalizeTagContextRef(
  ref: TagContextRef,
  libraryID: number,
): TagContextRef | null {
  const normalizedRef: TagContextRef = {
    ...ref,
    libraryID,
    name: ref.name.trim(),
    normalizedName: ref.normalizedName
      ? normalizeReferenceSelectorTagIdentityName(ref.normalizedName) || undefined
      : ref.scope
        ? undefined
        : normalizeReferenceSelectorTagIdentityName(ref.name) || undefined,
  };
  if (
    !normalizedRef.name ||
    (!normalizedRef.scope && !normalizedRef.normalizedName)
  ) {
    return null;
  }
  return normalizedRef;
}

export function isTagContextSelected(params: {
  itemId: number;
  ref: TagContextRef;
}): boolean {
  const key = buildReferenceSelectorTagContextKey(params.ref);
  return (selectedTagContextCache.get(params.itemId) || []).some(
    (entry) => buildReferenceSelectorTagContextKey(entry) === key,
  );
}

export function toggleTagContext(params: {
  deps: ContextSelectionActionDeps;
  ref: TagContextRef;
  libraryID: number;
}): ContextSelectionActionResult {
  const { deps, ref, libraryID } = params;
  const item = deps.item;
  if (!item) return unchanged();
  const normalizedRef = normalizeTagContextRef(ref, libraryID);
  if (!normalizedRef) return unchanged();
  const existing = selectedTagContextCache.get(item.id) || [];
  const nextKey = buildReferenceSelectorTagContextKey(normalizedRef);
  const existingIndex = existing.findIndex(
    (entry) => buildReferenceSelectorTagContextKey(entry) === nextKey,
  );
  if (existingIndex >= 0) {
    const next = existing.filter((_, index) => index !== existingIndex);
    if (next.length) selectedTagContextCache.set(item.id, next);
    else selectedTagContextCache.delete(item.id);
    deps.updatePaperPreviewPreservingScroll();
    return changed(t("Tag context removed."), "ready");
  }
  selectedTagContextCache.set(item.id, [...existing, normalizedRef]);
  deps.updatePaperPreviewPreservingScroll();
  return changed(t("Tag context added."), "ready");
}
