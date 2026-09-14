import { noteHtmlMatches } from "../../utils/noteHtml";
import { createZoteroMetadataResolver } from "../../services/zoteroMetadata/resolver";
import type { ResolvedNoteMetadata } from "../../services/zoteroMetadata/types";

export type NotePersistenceSaveOptions = {
  notifierQueue?: unknown;
};

export type FinalizedNoteBuildContext = {
  noteId: number;
  saveOptions: NotePersistenceSaveOptions;
  createdNoteMetadata?: ResolvedNoteMetadata;
};

export type FinalizedNoteBuildResult = {
  html: string;
  warnings?: string[];
};

export type FinalizedNotePersistenceResult = {
  noteId: number;
  html: string;
  warnings: string[];
  createdNoteReceipt?: CreatedZoteroNoteReceipt;
};

export type CreatedZoteroNoteReceipt = Readonly<{
  schemaVersion: 1;
  operation: "created";
  note: Readonly<{
    itemId: number;
    libraryID: number;
    key?: string;
    noteKind: "item" | "standalone";
    parentItemId?: number;
    dateAdded: string;
    dateModified?: string;
    version?: number;
  }>;
}>;

type FinalizedNoteParams = {
  note: Zotero.Item;
  initialHtml: string;
  finalize?: (
    context: FinalizedNoteBuildContext,
  ) => Promise<string | FinalizedNoteBuildResult>;
  log?: (message: string, error?: unknown) => void;
};

type NotifierQueueHandle = {
  saveOptions: NotePersistenceSaveOptions;
  commit: () => Promise<void>;
};

function logSafely(
  log: FinalizedNoteParams["log"],
  message: string,
  error: unknown,
): void {
  try {
    log?.(message, error);
  } catch {
    // Diagnostic logging must never change persistence behavior.
  }
}

function createNotifierQueueHandle(): NotifierQueueHandle {
  const notifier = (
    Zotero as unknown as {
      Notifier?: {
        Queue?: new () => unknown;
        commit?: (queue: unknown) => Promise<unknown>;
      };
    }
  ).Notifier;
  if (!notifier?.Queue || typeof notifier.commit !== "function") {
    return {
      saveOptions: {},
      commit: async () => {},
    };
  }
  const queue = new notifier.Queue();
  return {
    saveOptions: { notifierQueue: queue },
    commit: async () => {
      await notifier.commit?.(queue);
    },
  };
}

export function stripZoteroNoteWrapper(html: string): string {
  const normalized = (html || "").trim();
  const match = normalized.match(
    /^<div class="zotero-note znv\d+">([\s\S]*)<\/div>$/,
  );
  return (match?.[1] || normalized).trim();
}

export type NativeNoteVerification = Readonly<{
  schemaVersion: 1;
  noteId: number;
  html: string;
  expectedHtml: string;
  matches: boolean;
}>;

export class NoteVerificationError extends Error {
  constructor(
    readonly verification: NativeNoteVerification | null,
    message: string,
  ) {
    super(message);
  }
}

/** A successful read is always a forced native reload, never an in-memory echo. */
export async function verifyNativeNoteHtml(
  note: Zotero.Item,
  expectedHtml: string,
): Promise<NativeNoteVerification> {
  if (typeof note.reload !== "function") {
    throw new NoteVerificationError(
      null,
      "Native note verification is unavailable: reload is not supported",
    );
  }
  try {
    await note.reload(["note"], true);
  } catch {
    throw new NoteVerificationError(
      null,
      "Native note verification is unavailable: the note could not be reloaded",
    );
  }
  const html = note.getNote() || "";
  return {
    schemaVersion: 1,
    noteId: note.id,
    html,
    expectedHtml,
    matches: noteHtmlMatches(html, expectedHtml),
  };
}

async function persistAndVerifyNoteHtml(
  note: Zotero.Item,
  expectedHtml: string,
  saveOptions: NotePersistenceSaveOptions,
  alreadySaved = false,
): Promise<NativeNoteVerification> {
  let saveError: unknown;
  if (!alreadySaved) {
    note.setNote(expectedHtml);
    try {
      await note.saveTx(saveOptions as never);
    } catch (error) {
      saveError = error;
    }
  }
  const verification = await verifyNativeNoteHtml(note, expectedHtml);
  // A notification or post-commit exception does not undo the native commit.
  if (verification.matches) return verification;
  throw new NoteVerificationError(
    verification,
    saveError instanceof Error
      ? `Native note content does not match the prepared change after save: ${saveError.message}`
      : "Native note content does not match the prepared change",
  );
}

/** Write once and verify. Recovery decisions belong to the action coordinator. */
export async function persistVerifiedNoteHtml(
  note: Zotero.Item,
  html: string,
  saveOptions: NotePersistenceSaveOptions = {},
): Promise<NativeNoteVerification> {
  return persistAndVerifyNoteHtml(note, html, saveOptions);
}

function resolveCreatedNoteId(
  note: Zotero.Item,
  saveResult: number | boolean | undefined,
): number {
  const id =
    typeof saveResult === "number" && saveResult > 0 ? saveResult : note.id;
  if (!id || id <= 0) {
    throw new Error("Unable to resolve the newly created Zotero note ID");
  }
  return id;
}

async function readCreatedNoteMetadata(
  noteId: number,
  originalNote: Zotero.Item,
): Promise<ResolvedNoteMetadata | undefined> {
  const items = (
    Zotero as unknown as {
      Items?: { get?: (itemId: number) => Zotero.Item | null | undefined };
    }
  ).Items;
  const savedNote = items?.get?.(noteId) || originalNote;
  const reload = (
    savedNote as Zotero.Item & {
      reload?: (
        dataTypes?: string[],
        reloadUnchanged?: boolean,
      ) => Promise<void>;
    }
  ).reload;
  if (typeof reload === "function") {
    await reload.call(savedNote, ["primaryData", "note"], true);
  }
  const resolver = createZoteroMetadataResolver({
    getItem: (itemId) => (itemId === noteId ? savedNote : items?.get?.(itemId)),
  });
  const resolution = resolver.resolveItemMetadata(noteId, {
    detail: "summary",
    includeSystemMetadata: true,
  });
  return resolution.status === "resolved" && resolution.value.kind === "note"
    ? resolution.value
    : undefined;
}

function buildCreatedNoteReceipt(params: {
  initial?: ResolvedNoteMetadata;
  final?: ResolvedNoteMetadata;
}): CreatedZoteroNoteReceipt | undefined {
  const identity = params.final?.identity || params.initial?.identity;
  const dateAdded =
    params.final?.system?.dateAdded || params.initial?.system?.dateAdded;
  if (!identity || identity.libraryID <= 0 || !dateAdded) return undefined;
  const finalSystem = params.final?.system;
  const note = params.final || params.initial;
  if (!note) return undefined;
  return {
    schemaVersion: 1,
    operation: "created",
    note: {
      itemId: identity.itemId,
      libraryID: identity.libraryID,
      ...(identity.key ? { key: identity.key } : {}),
      noteKind: note.noteKind,
      ...(note.parentItemId ? { parentItemId: note.parentItemId } : {}),
      dateAdded,
      ...(finalSystem?.dateModified
        ? { dateModified: finalSystem.dateModified }
        : {}),
      ...(finalSystem?.version ? { version: finalSystem.version } : {}),
    },
  };
}

export async function readCreatedNoteReceipt(
  note: Zotero.Item,
): Promise<CreatedZoteroNoteReceipt | undefined> {
  return buildCreatedNoteReceipt({
    final: await readCreatedNoteMetadata(note.id, note),
  });
}

/**
 * Create a Zotero note without exposing an intermediate placeholder to item
 * observers. The first persisted state is always useful content. When assets
 * require a stable note ID, all note and attachment notifications remain in a
 * coordinator-owned queue until final HTML has been persisted and verified.
 */
export async function createFinalizedZoteroNote(
  params: FinalizedNoteParams,
): Promise<FinalizedNotePersistenceResult> {
  const queue = createNotifierQueueHandle();
  const warnings: string[] = [];
  let noteId = 0;
  let finalHtml = params.initialHtml;
  let primaryError: unknown;
  let result: FinalizedNotePersistenceResult | undefined;
  let initialCreatedNoteMetadata: ResolvedNoteMetadata | undefined;

  try {
    await persistVerifiedNoteHtml(
      params.note,
      params.initialHtml,
      queue.saveOptions,
    );
    noteId = resolveCreatedNoteId(params.note, undefined);

    try {
      initialCreatedNoteMetadata = await readCreatedNoteMetadata(
        noteId,
        params.note,
      );
      if (!initialCreatedNoteMetadata?.system?.dateAdded) {
        warnings.push(
          "Authoritative Zotero dateAdded was unavailable for the created note",
        );
      }
    } catch (error) {
      warnings.push(
        "Authoritative Zotero creation metadata could not be read; the note was still saved",
      );
      logSafely(
        params.log,
        "LLM: Failed to read created-note metadata after initial save",
        error,
      );
    }

    if (params.finalize) {
      try {
        const finalized = await params.finalize({
          noteId,
          saveOptions: queue.saveOptions,
          createdNoteMetadata: initialCreatedNoteMetadata,
        });
        if (typeof finalized === "string") {
          finalHtml = finalized;
        } else {
          finalHtml = finalized.html;
          warnings.push(...(finalized.warnings || []));
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error || "unknown");
        warnings.push(`Note asset finalization failed: ${message}`);
        logSafely(params.log, "LLM: Note asset finalization failed", error);
        throw new Error(`Note asset finalization is incomplete: ${message}`);
      }
    }

    await persistAndVerifyNoteHtml(
      params.note,
      finalHtml,
      queue.saveOptions,
      !params.finalize || noteHtmlMatches(finalHtml, params.initialHtml),
    );
    let finalCreatedNoteMetadata: ResolvedNoteMetadata | undefined;
    try {
      finalCreatedNoteMetadata = await readCreatedNoteMetadata(
        noteId,
        params.note,
      );
    } catch (error) {
      warnings.push(
        "Final Zotero note metadata could not be read; final note content was still verified",
      );
      logSafely(
        params.log,
        "LLM: Failed to read created-note metadata after final save",
        error,
      );
    }
    const createdNoteReceipt = buildCreatedNoteReceipt({
      initial: initialCreatedNoteMetadata,
      final: finalCreatedNoteMetadata,
    });
    result = {
      noteId,
      html: finalHtml,
      warnings,
      ...(createdNoteReceipt ? { createdNoteReceipt } : {}),
    };
  } catch (error) {
    primaryError = error;
  }

  let commitError: unknown;
  try {
    await queue.commit();
  } catch (error) {
    commitError = error;
    logSafely(
      params.log,
      "LLM: Failed to commit queued note notifications",
      error,
    );
  }

  if (primaryError) throw primaryError;
  if (commitError && result) {
    result.warnings.push(
      "The note content was saved and verified, but its notifications could not be delivered",
    );
  }
  if (!result) {
    throw new Error("Zotero note persistence completed without a result");
  }
  return result;
}
