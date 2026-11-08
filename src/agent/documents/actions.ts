import { appLogger } from "../../core/logging";
import { canonicalNoteHtml } from "../../utils/noteHtml";
import { sha256Text } from "../store/journalRecoveryBlobStore";
import {
  createFinalizedZoteroNote,
  stripZoteroNoteWrapper,
  verifyNativeNoteHtml,
  type NativeNoteVerification,
} from "../../services/notePersistence";
import { importNoteImageAsset } from "../../services/notes/noteImages";
import { escapeNoteHtml } from "../../utils/textSanitization";
import {
  prepareDocumentMarkdownExport,
  readVerifiedAssetBytes,
  pathParts,
} from "./exportBundle";
import {
  loadDocumentActionState,
  loadPlanDocument,
  updateDocumentActionState,
} from "./store";
import {
  isOutsideCitationSource,
  type DocumentActionState,
  type DocumentNoteBinding,
  type PlanDocument,
} from "./types";
import { expandNewCitationTokens } from "../../services/notes/noteCitations";
import {
  hasNewCitationTokens,
  mergeNoteCitationItems,
  type NoteCitationItem,
} from "../../utils/noteCitations";
import { restoreNoteEmbedTokensInHtml } from "../../utils/noteEmbeds";

/**
 * A document's HTML as a new note stores it: each `{{cite item=… page=…}}`
 * becomes a Zotero citation chip, and the cited works are registered in the
 * note root. Every place that builds or proves the note uses this one form.
 * A request that cannot become a citation, or a misspelled one, throws
 * before anything is written.
 */
export function documentNoteHtml(html: string, libraryID: number): string {
  const parts = documentNoteParts(html, libraryID);
  return mergeNoteCitationItems(parts.html, parts.citationItems);
}

/**
 * The same note HTML, with the cited works kept apart instead of registered in
 * a root. An append needs this form: a root added to the body would land as a
 * second root inside the target note, so the works are registered in the
 * target note's own root when the append is composed.
 */
export function documentNoteParts(
  html: string,
  libraryID: number,
): { html: string; citationItems: NoteCitationItem[] } {
  if (!hasNewCitationTokens(html)) return { html, citationItems: [] };
  const expanded = expandNewCitationTokens(html, (itemRef) =>
    /^\d+$/.test(itemRef)
      ? Zotero.Items.get(Number(itemRef)) || null
      : Zotero.Items.getByLibraryAndKey(libraryID, itemRef.toUpperCase()) ||
        null,
  );
  const restored = restoreNoteEmbedTokensInHtml(
    expanded.text,
    expanded.registry,
  );
  return { html: restored.html, citationItems: expanded.citationItems };
}

/** Embed the finalized document's assets for both new and existing notes. */
export async function finalizeDocumentNoteHtml(
  document: PlanDocument,
  {
    noteId,
    saveOptions,
  }: {
    noteId: number;
    saveOptions?: import("../../services/notePersistence").NotePersistenceSaveOptions;
  },
): Promise<{ html: string; warnings: string[] }> {
  const blocks: string[] = [];
  const warnings: string[] = [];
  for (const asset of document.assets) {
    const bytes = await readVerifiedAssetBytes(asset);
    const imported = await importNoteImageAsset({
      noteItemId: noteId,
      bytes,
      mimeType: asset.mimeType,
      saveOptions,
    });
    if (!imported?.key) {
      warnings.push(`Figure ${asset.assetId} could not be embedded`);
      continue;
    }
    blocks.push(
      `<figure><img data-attachment-key="${escapeNoteHtml(imported.key)}" alt="${escapeNoteHtml(asset.caption)}" /><figcaption>${escapeNoteHtml(asset.caption)}</figcaption></figure>`,
    );
  }
  const html = blocks.length
    ? `${document.visibleHtml}<h2>Figures</h2>${blocks.join("")}`
    : document.visibleHtml;
  return { html, warnings };
}

function resolveItemByKey(
  libraryID: number,
  itemKey: string,
): Zotero.Item | null {
  return Zotero.Items.getByLibraryAndKey(libraryID, itemKey) || null;
}

/**
 * The Zotero items a document cites, once each, in citation order: the
 * candidates for its saved note's parent.
 */
export function documentCitedItems(document: PlanDocument): Array<{
  libraryID: number;
  itemKey: string;
}> {
  const seen = new Set<string>();
  const out: Array<{ libraryID: number; itemKey: string }> = [];
  for (const cluster of document.citationBundle.clusters) {
    for (const source of cluster.sources) {
      // An outside paper has no Zotero item to be a note's parent.
      if (isOutsideCitationSource(source)) continue;
      const key = `${source.libraryID}:${source.itemKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ libraryID: source.libraryID, itemKey: source.itemKey });
    }
  }
  return out;
}

/** A note on a parent item, or a standalone note filed in collections. */
export type DocumentNoteTarget =
  | { parentItemId: number; libraryID: number }
  | { standalone: true; libraryID: number; collectionIds?: number[] };

function targetParentId(target: DocumentNoteTarget): number | undefined {
  return "parentItemId" in target ? target.parentItemId : undefined;
}

function targetCollectionIds(target: DocumentNoteTarget | undefined): number[] {
  return target && "standalone" in target
    ? [...new Set(target.collectionIds || [])]
    : [];
}

/** Whether a native note sits where the target puts it. */
function noteMatchesTarget(
  note: Zotero.Item,
  target: DocumentNoteTarget,
): boolean {
  const collections = note.getCollections?.() || [];
  return (
    (note.parentID || undefined) === targetParentId(target) &&
    note.libraryID === target.libraryID &&
    targetCollectionIds(target).every((id) => collections.includes(id))
  );
}

const pendingDocumentSaves = new Map<string, Promise<unknown>>();

/** Reserve a durable native key before saving; serialize concurrent saves of the same document. */
export async function savePlanDocumentAsNote(
  documentId: string,
  target?: DocumentNoteTarget,
) {
  const previous = pendingDocumentSaves.get(documentId);
  const operation = (previous || Promise.resolve())
    .catch(() => undefined)
    .then(() => saveDocumentNote(documentId, target));
  pendingDocumentSaves.set(documentId, operation);
  try {
    return await operation;
  } finally {
    if (pendingDocumentSaves.get(documentId) === operation)
      pendingDocumentSaves.delete(documentId);
  }
}

/**
 * Version 2 counts the root citation registry only by the works it registers:
 * Zotero's note editor refreshes their cached CSL data on its own. Version 1
 * counts the registry in full; bindings without a version hashed the raw body.
 */
const NOTE_HASH_VERSION = 2;

async function noteContentHash(
  html: string,
  version: DocumentNoteBinding["nativeContentHashVersion"],
) {
  return sha256Text(
    version
      ? canonicalNoteHtml(html, { registryWorksOnly: version === 2 })
      : stripZoteroNoteWrapper(html),
  );
}

/** A checkpoint may advance only the reservation it actually read. */
function assertNoteReservation(
  current: DocumentActionState,
  expected: DocumentActionState["pendingNote"],
): void {
  const binding = current.savedNote || current.pendingNote;
  if (
    current.savedNote ||
    binding?.libraryID !== expected?.libraryID ||
    binding?.itemKey !== expected?.itemKey ||
    binding?.documentVersion !== expected?.documentVersion ||
    binding?.contentHash !== expected?.contentHash ||
    binding?.parentItemId !== expected?.parentItemId ||
    binding?.nativeContentHash !== expected?.nativeContentHash ||
    binding?.finalized !== expected?.finalized
  )
    throw new Error(
      "The document note reservation changed before it could be updated.",
    );
}

async function promoteDocumentNote(
  documentId: string,
  binding: NonNullable<DocumentActionState["pendingNote"]>,
): Promise<void> {
  await updateDocumentActionState(documentId, (current) => {
    assertNoteReservation(current, binding);
    return {
      ...current,
      savedNote: binding,
      pendingNote: undefined,
      updatedAt: Date.now(),
    };
  });
}

async function saveDocumentNote(
  documentId: string,
  target?: DocumentNoteTarget,
): Promise<{
  libraryID: number;
  itemKey: string;
  itemId: number;
  created: boolean;
  warnings: string[];
  /** Native read-back proving the saved note carries this exact document. */
  noteVerification?: NativeNoteVerification;
}> {
  const document = await loadPlanDocument(documentId);
  if (!document) throw new Error("Document not found");
  const prior = await loadDocumentActionState(documentId);
  const binding = prior?.savedNote || prior?.pendingNote;
  if (binding) {
    if (
      (target &&
        (binding.parentItemId !== targetParentId(target) ||
          binding.libraryID !== target.libraryID)) ||
      (binding.contentHash && binding.contentHash !== document.contentHash) ||
      (binding.documentVersion &&
        binding.documentVersion !== document.documentVersion)
    )
      throw new Error(
        "The reserved note identity belongs to different content or a different parent.",
      );
    const existing = resolveItemByKey(binding.libraryID, binding.itemKey);
    if (existing && existing.isNote() && !existing.deleted) {
      await existing.reload(["primaryData", "note"], true);
      // A binding without a stored hash predates citation requests, so its
      // note holds the document's HTML as written.
      const expectedHash =
        binding.nativeContentHash ||
        (await noteContentHash(document.visibleHtml, 1));
      const readBack = existing.getNote();
      if (
        (target && !noteMatchesTarget(existing, target)) ||
        (binding.documentVersion !== undefined &&
          ((existing.parentID || undefined) !== binding.parentItemId ||
            existing.libraryID !== binding.libraryID)) ||
        (binding.contentHash && binding.contentHash !== document.contentHash) ||
        (binding.documentVersion &&
          binding.documentVersion !== document.documentVersion) ||
        (await noteContentHash(readBack, binding.nativeContentHashVersion)) !==
          expectedHash ||
        binding.finalized === false
      ) {
        throw new Error(
          "The saved note no longer matches this exact document and parent, or its assets are incomplete. Resolve that note before saving again.",
        );
      }
      // A citation chip's label and the root registry come from the cited
      // work's metadata at save time. Rebuilding them now would refuse the
      // note after the user edits or deletes that work, so the read-back the
      // stored hash just identified is what the note is proved against.
      const provedByStoredHash =
        Boolean(binding.nativeContentHash) &&
        hasNewCitationTokens(document.visibleHtml);
      // Embedded assets rewrite the stored HTML with native attachment keys,
      // so only an asset-free document can be proved against its own body.
      const noteVerification = provedByStoredHash
        ? await verifyNativeNoteHtml(existing, readBack)
        : document.assets.length
          ? undefined
          : await verifyNativeNoteHtml(existing, document.visibleHtml);
      // Prove the note before recording it as saved: a promotion the read-back
      // contradicts would lock the document out of every later save attempt.
      if (noteVerification && !noteVerification.matches)
        throw new Error(
          "The saved note no longer matches this exact document and parent, or its assets are incomplete. Resolve that note before saving again.",
        );
      if (!prior?.savedNote) await promoteDocumentNote(documentId, binding);
      return {
        libraryID: existing.libraryID,
        itemKey: existing.key,
        itemId: existing.id,
        created: false,
        warnings: [],
        noteVerification,
      };
    }
    if (existing || prior?.savedNote)
      throw new Error(
        "The previously saved note was removed or changed. A retry cannot create a replacement automatically.",
      );
  }

  const cited = documentCitedItems(document);
  const requestedParentId = target ? targetParentId(target) : undefined;
  const singleParent = target
    ? requestedParentId
      ? Zotero.Items.get(requestedParentId)
      : null
    : cited.length === 1
      ? resolveItemByKey(cited[0].libraryID, cited[0].itemKey)
      : null;
  if (
    requestedParentId &&
    (!singleParent ||
      singleParent.deleted ||
      !singleParent.isRegularItem() ||
      singleParent.libraryID !== target!.libraryID)
  ) {
    throw new Error(
      "The requested summary-note parent is unavailable in the frozen library.",
    );
  }
  // Checked before anything is reserved: Zotero does not check a collection
  // id when it is added, and a missing one fails the note's own save.
  const collectionIds = targetCollectionIds(target);
  for (const collectionId of collectionIds) {
    const collection = Zotero.Collections.get(collectionId);
    if (
      !collection ||
      collection.deleted ||
      collection.libraryID !== target!.libraryID
    )
      throw new Error(
        `Collection ${collectionId} is unavailable in the frozen library; the note was not created.`,
      );
  }
  const libraryID =
    target?.libraryID ||
    singleParent?.libraryID ||
    cited[0]?.libraryID ||
    Zotero.Libraries.userLibraryID;
  // Built before anything is reserved, so a citation that cannot be made
  // stops the save without leaving a pending note behind.
  const initialHtml = documentNoteHtml(document.visibleHtml, libraryID);
  const note = new Zotero.Item("note");
  note.libraryID = libraryID;
  note.key =
    prior?.pendingNote?.itemKey || Zotero.Utilities.generateObjectKey();
  // Assigning a key identifies a native object. Initialize its load state before
  // setting note data; Zotero marks a missing reserved key as a new loaded item.
  await note.loadPrimaryData(false);
  if (singleParent && !singleParent.deleted) {
    note.parentID = singleParent.id;
  }
  for (const collectionId of collectionIds) note.addToCollection(collectionId);
  let pendingNote: NonNullable<DocumentActionState["pendingNote"]> = {
    libraryID,
    itemKey: note.key,
    parentItemId: note.parentID || undefined,
    documentVersion: document.documentVersion,
    contentHash: document.contentHash,
    nativeContentHash: await noteContentHash(initialHtml, NOTE_HASH_VERSION),
    nativeContentHashVersion: NOTE_HASH_VERSION,
    finalized: document.assets.length === 0,
  };
  const persistPending = (
    next: NonNullable<DocumentActionState["pendingNote"]>,
    expected: DocumentActionState["pendingNote"],
  ) =>
    updateDocumentActionState(documentId, (current) => {
      assertNoteReservation(current, expected);
      return {
        ...current,
        pendingNote: next,
        updatedAt: Date.now(),
      };
    });
  await persistPending(pendingNote, prior?.pendingNote);
  const persisted = await createFinalizedZoteroNote({
    note,
    initialHtml,
    finalize: document.assets.length
      ? async ({ noteId, saveOptions }) => {
          const finalized = await finalizeDocumentNoteHtml(document, {
            noteId,
            saveOptions,
          });
          const html = documentNoteHtml(finalized.html, libraryID);
          const { warnings } = finalized;
          const candidate = {
            ...pendingNote,
            nativeContentHash: await noteContentHash(html, NOTE_HASH_VERSION),
            finalized: warnings.length === 0,
          };
          await persistPending(candidate, pendingNote);
          pendingNote = candidate;
          return { html, warnings };
        }
      : undefined,
    log: (message, error) => appLogger.warn(message, error),
  });
  const created = Zotero.Items.get(persisted.noteId) || note;
  if (!created.key) throw new Error("Created note has no stable Zotero key");
  if (
    !pendingNote.finalized ||
    (await noteContentHash(
      created.getNote(),
      pendingNote.nativeContentHashVersion,
    )) !== pendingNote.nativeContentHash ||
    created.key !== pendingNote.itemKey ||
    created.libraryID !== pendingNote.libraryID ||
    (created.parentID || undefined) !== pendingNote.parentItemId ||
    (target && !noteMatchesTarget(created, target))
  )
    throw new Error(
      "The note was preserved but its requested content or assets are incomplete, or its parent or collections changed.",
    );
  const noteVerification = await verifyNativeNoteHtml(created, persisted.html);
  // The forced read-back is the only proof the write reached the database.
  // Promoting a reservation it contradicts marks the document saved while the
  // receipt rejects it, and every retry then refuses the mismatched note.
  if (!noteVerification.matches)
    throw new Error(
      "The reserved note does not match the finalized content; the document was not recorded as saved.",
    );
  await promoteDocumentNote(documentId, pendingNote);
  return {
    libraryID: created.libraryID,
    itemKey: created.key,
    itemId: created.id,
    created: true,
    warnings: [...persisted.warnings],
    noteVerification,
  };
}

export async function exportPlanDocumentMarkdown(
  documentId: string,
  requestedPath: string,
): Promise<string> {
  const document = await loadPlanDocument(documentId);
  if (!document) throw new Error("Document not found");
  const outputPath = /\.md$/i.test(requestedPath)
    ? requestedPath
    : `${requestedPath}.md`;
  const io = (globalThis as unknown as { IOUtils?: any }).IOUtils;
  if (typeof io?.write !== "function") {
    throw new Error("Atomic file export is unavailable in this Zotero build");
  }
  const bundle = await prepareDocumentMarkdownExport(document, outputPath);
  const verifiedAssets = bundle.assets;

  const { directory, stem } = pathParts(outputPath);
  const separator = outputPath.includes("\\") ? "\\" : "/";
  const assetDirectory = `${directory}${separator}${stem}_assets`;
  const stagedAssetDirectory = `${assetDirectory}.tmp-${document.contentHash
    .replace(/^sha256:/, "")
    .slice(0, 12)}`;
  let installedAssets = false;
  try {
    if (verifiedAssets.length) {
      if (
        typeof io.exists === "function" &&
        (await io.exists(assetDirectory))
      ) {
        throw new Error(
          `The export asset directory already exists: ${stem}_assets`,
        );
      }
      await io.remove?.(stagedAssetDirectory, {
        recursive: true,
        ignoreAbsent: true,
      });
      await io.makeDirectory(stagedAssetDirectory, {
        createAncestors: true,
        ignoreExisting: true,
      });
      for (const entry of verifiedAssets) {
        const stagedTarget = `${stagedAssetDirectory}${separator}${entry.fileName}`;
        await io.write(stagedTarget, entry.bytes, {
          tmpPath: `${stagedTarget}.tmp`,
        });
      }
      if (typeof io.move === "function") {
        await io.move(stagedAssetDirectory, assetDirectory, {
          noOverwrite: true,
        });
      } else {
        await io.makeDirectory(assetDirectory, {
          createAncestors: true,
          ignoreExisting: false,
        });
        for (const entry of verifiedAssets) {
          const target = `${assetDirectory}${separator}${entry.fileName}`;
          await io.write(target, entry.bytes, { tmpPath: `${target}.tmp` });
        }
        await io.remove?.(stagedAssetDirectory, {
          recursive: true,
          ignoreAbsent: true,
        });
      }
      installedAssets = true;
    }
    const bytes = bundle.bytes;
    await io.write(outputPath, bytes, { tmpPath: `${outputPath}.tmp` });
  } catch (error) {
    await io.remove?.(stagedAssetDirectory, {
      recursive: true,
      ignoreAbsent: true,
    });
    if (installedAssets) {
      await io.remove?.(assetDirectory, {
        recursive: true,
        ignoreAbsent: true,
      });
    }
    throw error;
  }

  await updateDocumentActionState(documentId, (current) => ({
    ...current,
    lastExportedAt: Date.now(),
    lastExportedName: outputPath.split(/[\\/]/).pop(),
    updatedAt: Date.now(),
  }));
  return outputPath;
}
