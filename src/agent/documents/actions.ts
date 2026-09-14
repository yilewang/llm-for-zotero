import { canonicalNoteHtml } from "../../utils/noteHtml";
import { sha256Text } from "../store/journalRecoveryBlobStore";
import {
  createFinalizedZoteroNote,
  stripZoteroNoteWrapper,
} from "../../modules/contextPanel/notePersistence";
import { importNoteImageAsset } from "../../modules/contextPanel/noteImages";
import { escapeNoteHtml } from "../../modules/contextPanel/textUtils";
import { loadPlanArtifact } from "../plans/store";
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
  getPlannedDocumentOrigin,
  type DocumentActionState,
  type PlanDocument,
} from "./types";

/** Embed the finalized document's assets for both new and existing notes. */
export async function finalizeDocumentNoteHtml(
  document: PlanDocument,
  {
    noteId,
    saveOptions,
  }: {
    noteId: number;
    saveOptions?: import("../../modules/contextPanel/notePersistence").NotePersistenceSaveOptions;
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

function citedItems(document: PlanDocument): Array<{
  libraryID: number;
  itemKey: string;
}> {
  const seen = new Set<string>();
  const out: Array<{ libraryID: number; itemKey: string }> = [];
  for (const cluster of document.citationBundle.clusters) {
    for (const source of cluster.sources) {
      const key = `${source.libraryID}:${source.itemKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ libraryID: source.libraryID, itemKey: source.itemKey });
    }
  }
  return out;
}

export type DocumentNoteTarget = { parentItemId: number; libraryID: number };

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

async function noteContentHash(html: string, canonical = true) {
  return sha256Text(
    canonical ? canonicalNoteHtml(html) : stripZoteroNoteWrapper(html),
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
}> {
  const document = await loadPlanDocument(documentId);
  if (!document) throw new Error("Document not found");
  const prior = await loadDocumentActionState(documentId);
  const binding = prior?.savedNote || prior?.pendingNote;
  if (binding) {
    if (
      (target &&
        (binding.parentItemId !== target.parentItemId ||
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
      const expectedHash =
        binding.nativeContentHash ||
        (await noteContentHash(document.visibleHtml));
      if (
        (target &&
          (existing.parentID !== target.parentItemId ||
            existing.libraryID !== target.libraryID)) ||
        (binding.documentVersion !== undefined &&
          ((existing.parentID || undefined) !== binding.parentItemId ||
            existing.libraryID !== binding.libraryID)) ||
        (binding.contentHash && binding.contentHash !== document.contentHash) ||
        (binding.documentVersion &&
          binding.documentVersion !== document.documentVersion) ||
        (await noteContentHash(
          existing.getNote(),
          binding.nativeContentHashVersion === 1,
        )) !== expectedHash ||
        binding.finalized === false
      ) {
        throw new Error(
          "The saved note no longer matches this exact document and parent, or its assets are incomplete. Resolve that note before saving again.",
        );
      }
      if (!prior?.savedNote) await promoteDocumentNote(documentId, binding);
      return {
        libraryID: existing.libraryID,
        itemKey: existing.key,
        itemId: existing.id,
        created: false,
        warnings: [],
      };
    }
    if (existing || prior?.savedNote)
      throw new Error(
        "The previously saved note was removed or changed. A retry cannot create a replacement automatically.",
      );
  }

  const planned = getPlannedDocumentOrigin(document);
  const artifact = planned
    ? await loadPlanArtifact(planned.planId, planned.planRevision)
    : null;
  const cited = citedItems(document);
  const singleParent = target
    ? Zotero.Items.get(target.parentItemId)
    : cited.length === 1
      ? resolveItemByKey(cited[0].libraryID, cited[0].itemKey)
      : null;
  if (
    target &&
    (!singleParent ||
      singleParent.deleted ||
      !singleParent.isRegularItem() ||
      singleParent.libraryID !== target.libraryID)
  ) {
    throw new Error(
      "The requested summary-note parent is unavailable in the frozen library.",
    );
  }
  const scope = artifact?.contract?.investigation?.scope;
  const libraryID =
    singleParent?.libraryID ||
    scope?.libraryID ||
    cited[0]?.libraryID ||
    Zotero.Libraries.userLibraryID;
  const note = new Zotero.Item("note");
  note.libraryID = libraryID;
  note.key =
    prior?.pendingNote?.itemKey || Zotero.Utilities.generateObjectKey();
  // Assigning a key identifies a native object. Initialize its load state before
  // setting note data; Zotero marks a missing reserved key as a new loaded item.
  await note.loadPrimaryData(false);
  if (singleParent && !singleParent.deleted) {
    note.parentID = singleParent.id;
  } else if (
    scope &&
    (scope.kind === "collections" || scope.kind === "mixed") &&
    scope.collectionIds?.length === 1
  ) {
    note.addToCollection(scope.collectionIds[0]);
  }
  let pendingNote: NonNullable<DocumentActionState["pendingNote"]> = {
    libraryID,
    itemKey: note.key,
    parentItemId: note.parentID || undefined,
    documentVersion: document.documentVersion,
    contentHash: document.contentHash,
    nativeContentHash: await noteContentHash(document.visibleHtml),
    nativeContentHashVersion: 1,
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
    initialHtml: document.visibleHtml,
    finalize: document.assets.length
      ? async ({ noteId, saveOptions }) => {
          const { html, warnings } = await finalizeDocumentNoteHtml(document, {
            noteId,
            saveOptions,
          });
          const candidate = {
            ...pendingNote,
            nativeContentHash: await noteContentHash(html),
            finalized: warnings.length === 0,
          };
          await persistPending(candidate, pendingNote);
          pendingNote = candidate;
          return { html, warnings };
        }
      : undefined,
    log: (message, error) => ztoolkit.log(message, error),
  });
  const created = Zotero.Items.get(persisted.noteId) || note;
  if (!created.key) throw new Error("Created note has no stable Zotero key");
  if (
    !pendingNote.finalized ||
    (await noteContentHash(created.getNote())) !==
      pendingNote.nativeContentHash ||
    created.key !== pendingNote.itemKey ||
    created.libraryID !== pendingNote.libraryID ||
    (created.parentID || undefined) !== pendingNote.parentItemId
  )
    throw new Error(
      "The note was preserved but its requested content or assets are incomplete, or its parent changed.",
    );
  await promoteDocumentNote(documentId, pendingNote);
  return {
    libraryID: created.libraryID,
    itemKey: created.key,
    itemId: created.id,
    created: true,
    warnings: [...persisted.warnings],
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
