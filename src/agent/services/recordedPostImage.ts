import { canonicalNoteHtml } from "../../utils/noteHtml";
import { readNativeNoteHtml } from "../../services/notePersistence";
import type {
  LibraryMutationOperation,
  LibraryMutationState,
} from "./libraryMutation/contracts";
import type { AgentPostImageState } from "../types";
import { sha256Bytes, sha256Text } from "../store/journalRecoveryBlobStore";
import { isRegisteredLibraryMutationOperation } from "./libraryMutation/handlerOperations";
import { canonicalJson } from "./libraryMutation/canonicalJson";

/**
 * The one reader that knows how to re-read live state in the shape of a
 * recorded post-image.
 *
 * A durable write records what it expects to be true immediately afterwards:
 * a library operation's captured state, a script's guarded objects, a created
 * item, a note, a path, a file, a preference. Two callers need to read that
 * shape back — the reverter, before it replays an inverse over an object that
 * may have changed since, and the mutation coordinator, to prove a write is
 * still in the library when its receipt is minted. Both ask here, so a new
 * post-image kind becomes re-readable for both at once.
 */

const stable = canonicalJson;

export type RecordedPostImage = {
  /** What the write recorded as true immediately after it applied. */
  expected: unknown;
  /**
   * The forward payload, which for a library mutation is its operation, and
   * the step result some captures need to resolve created objects. Only a
   * captured library-operation state needs either; a caller that holds just
   * the image leaves them out, and that shape then reads as not re-readable.
   */
  forward?: unknown;
  result?: unknown;
};

export type RecordedPostImageState = AgentPostImageState;

/**
 * The native reads a post-image can need.
 *
 * Two readers exist and they are not equally capable: the reverter holds the
 * full mutation service, while the action contract holds only its own narrow
 * Zotero gateway. An image whose shape needs a capability the reader does not
 * have reads back as "not re-readable", which is a different answer from
 * "read it, and it differs" and must stay so.
 */
export type PostImageReader = {
  getItem(itemId: number): Zotero.Item | null;
  /** The current value of one preference, `undefined` when it is unset. */
  readSetting?(key: string): unknown;
  /** Live state captured in the shape of one library mutation operation. */
  captureOperationState?(
    operation: LibraryMutationOperation,
    result?: unknown,
  ): Promise<LibraryMutationState>;
};

export const MUTATION_STATE_SECTIONS = [
  "items",
  "collections",
  "savedSearches",
  "libraryTags",
  "relations",
] as const;

export function isMutationOperation(
  value: unknown,
): value is LibraryMutationOperation {
  return isRegisteredLibraryMutationOperation(value);
}

/**
 * A capability a reader may not have is never silently treated as a mismatch:
 * the caller turns the thrown refusal into "not re-readable".
 */
function readSetting(reader: PostImageReader, key: string): unknown {
  if (!reader.readSetting) {
    throw new Error("this reader cannot read preferences back");
  }
  return reader.readSetting(key);
}

async function captureOperationState(
  reader: PostImageReader,
  operation: LibraryMutationOperation,
): Promise<LibraryMutationState> {
  if (!reader.captureOperationState) {
    throw new Error("this reader cannot capture library operation state");
  }
  return reader.captureOperationState(operation);
}

export async function readFileBytes(path: string): Promise<Uint8Array | null> {
  const io = (globalThis as { IOUtils?: any }).IOUtils;
  try {
    if (!(await io?.exists?.(path))) return null;
    if (typeof io?.read === "function") {
      return new Uint8Array(await io.read(path));
    }
    if (typeof io?.readUTF8 === "function") {
      return new TextEncoder().encode(await io.readUTF8(path));
    }
    return null;
  } catch {
    return null;
  }
}

export function captureCurrentScriptItems(
  expectedItems: unknown[],
  reader: PostImageReader,
): unknown[] {
  return expectedItems.map((entry) => {
    const itemId = Number(
      entry && typeof entry === "object"
        ? (entry as { itemId?: unknown }).itemId
        : 0,
    );
    const item = reader.getItem(itemId) as any;
    if (!item) return { itemId, exists: false };
    let json: unknown;
    try {
      json = item.toJSON?.();
    } catch {
      json = undefined;
    }
    let noteHtml: string | undefined;
    try {
      if (item.isNote?.()) noteHtml = String(item.getNote?.() ?? "");
    } catch {
      noteHtml = undefined;
    }
    return {
      itemId,
      exists: true,
      ...(json === undefined ? {} : { json }),
      parentID: Number(item.parentID) || null,
      deleted: item.deleted === true,
      tags: item.getTags?.() || [],
      collectionIds: item.getCollections?.() || [],
      ...(noteHtml === undefined ? {} : { noteHtml }),
    };
  });
}

export async function captureCurrentScriptDeclaredGuard(params: {
  expected: unknown;
  reader: PostImageReader;
}): Promise<unknown> {
  if (!params.expected || typeof params.expected !== "object") {
    throw new Error("The script declaration guard is invalid");
  }
  const guard = params.expected as Record<string, unknown>;
  if (guard.kind === "library_operation") {
    if (!isMutationOperation(guard.operation)) {
      throw new Error("The script library-operation guard is invalid");
    }
    return {
      kind: "library_operation",
      operation: guard.operation,
      state: await captureOperationState(params.reader, guard.operation),
    };
  }
  if (guard.kind === "note_html") {
    const noteId = Number(guard.noteId);
    const item = params.reader.getItem(noteId);
    return {
      kind: "note_html",
      noteId,
      checksum: await sha256Text(item ? await readNativeNoteHtml(item) : ""),
    };
  }
  if (guard.kind === "file") {
    const path = String(guard.path || "");
    const bytes = await readFileBytes(path);
    return {
      kind: "file",
      path,
      exists: bytes !== null,
      checksum: bytes === null ? null : await sha256Bytes(bytes),
    };
  }
  if (guard.kind === "preference") {
    const key = String(guard.key || "");
    const value = readSetting(params.reader, key);
    return {
      kind: "preference",
      key,
      existed: value !== undefined,
      value,
    };
  }
  throw new Error("The script declaration guard type is unsupported");
}

/**
 * Live state read back in the shape of `image.expected`.
 *
 * `undefined` means the recorded shape is not one this version knows how to
 * read; it is never the same answer as "read it, and it differs".
 */
export async function readRecordedPostImage(params: {
  image: RecordedPostImage;
  reader: PostImageReader;
}): Promise<unknown> {
  const expected = params.image.expected;
  if (
    expected &&
    typeof expected === "object" &&
    (expected as { version?: unknown }).version === 1 &&
    typeof (expected as { operation?: unknown }).operation === "string"
  ) {
    const operation = params.image.forward;
    if (!isMutationOperation(operation)) return undefined;
    if (!params.reader.captureOperationState) return undefined;
    return params.reader.captureOperationState(operation, params.image.result);
  }
  if (
    expected &&
    typeof expected === "object" &&
    (expected as { kind?: unknown }).kind === "script_items"
  ) {
    const expectedItems = (expected as { items?: unknown }).items;
    if (!Array.isArray(expectedItems)) return undefined;
    const items = captureCurrentScriptItems(expectedItems, params.reader);
    return { kind: "script_items", items };
  }
  if (
    expected &&
    typeof expected === "object" &&
    (expected as { kind?: unknown }).kind === "script_effects"
  ) {
    const expectedItems = (expected as { items?: unknown }).items;
    const expectedDeclared = (expected as { declared?: unknown }).declared;
    if (!Array.isArray(expectedItems) || !Array.isArray(expectedDeclared)) {
      return undefined;
    }
    const declared = [];
    for (const guard of expectedDeclared) {
      declared.push(
        await captureCurrentScriptDeclaredGuard({
          expected: guard,
          reader: params.reader,
        }),
      );
    }
    return {
      kind: "script_effects",
      items: captureCurrentScriptItems(expectedItems, params.reader),
      declared,
    };
  }
  if (
    expected &&
    typeof expected === "object" &&
    (expected as { kind?: unknown }).kind === "created_item"
  ) {
    const record = expected as Record<string, unknown>;
    const itemId = Number(record.itemId);
    const item = params.reader.getItem(itemId);
    const current: Record<string, unknown> = {
      kind: "created_item",
      itemId,
      exists: Boolean(item),
    };
    if (Object.prototype.hasOwnProperty.call(record, "parentItemId")) {
      current.parentItemId = item
        ? Number((item as Zotero.Item & { parentID?: unknown }).parentID) ||
          null
        : null;
    }
    if (
      Object.prototype.hasOwnProperty.call(record, "html") ||
      Object.prototype.hasOwnProperty.call(record, "htmlChecksum")
    ) {
      const html = item ? await readNativeNoteHtml(item) : "";
      if (Object.prototype.hasOwnProperty.call(record, "html"))
        current.html = html;
      if (Object.prototype.hasOwnProperty.call(record, "htmlChecksum"))
        current.htmlChecksum = await sha256Text(html);
    }
    if (Object.prototype.hasOwnProperty.call(record, "collections")) {
      current.collections = item?.getCollections?.() || [];
    }
    return current;
  }
  if (
    expected &&
    typeof expected === "object" &&
    (expected as { kind?: unknown }).kind === "note_html"
  ) {
    const noteId = Number((expected as { noteId?: unknown }).noteId);
    const item = params.reader.getItem(noteId);
    if (Object.prototype.hasOwnProperty.call(expected, "canonicalChecksum")) {
      if (!item || item.deleted)
        throw new Error("The original note is unavailable");
      return {
        kind: "note_html",
        noteId,
        canonicalChecksum: await sha256Text(
          canonicalNoteHtml(await readNativeNoteHtml(item)),
        ),
      };
    }
    const html = item ? await readNativeNoteHtml(item) : "";
    const current: Record<string, unknown> = {
      kind: "note_html",
      noteId,
    };
    if (Object.prototype.hasOwnProperty.call(expected, "checksum")) {
      current.checksum = await sha256Text(html);
    } else {
      current.html = html;
    }
    return current;
  }
  if (
    expected &&
    typeof expected === "object" &&
    (expected as { kind?: unknown }).kind === "path"
  ) {
    const record = expected as Record<string, unknown>;
    const path = String(record.path || "");
    const io = (globalThis as { IOUtils?: any }).IOUtils;
    const exists = Boolean(await io?.exists?.(path));
    let pathKind: string | null = null;
    if (exists && typeof io?.stat === "function") {
      const stat = await io.stat(path);
      pathKind =
        stat?.type === "directory"
          ? "directory"
          : stat?.type === "regular" || stat?.type === "file"
            ? "file"
            : null;
    }
    return {
      kind: "path",
      path,
      pathKind,
      exists,
    };
  }
  if (
    expected &&
    typeof expected === "object" &&
    (expected as { kind?: unknown }).kind === "file"
  ) {
    const path = String((expected as { path?: unknown }).path || "");
    const bytes = await readFileBytes(path);
    return {
      kind: "file",
      path,
      exists: bytes !== null,
      checksum: bytes === null ? null : await sha256Bytes(bytes),
    };
  }
  if (
    expected &&
    typeof expected === "object" &&
    (expected as { kind?: unknown }).kind === "preference"
  ) {
    const key = String((expected as { key?: unknown }).key || "");
    const value = readSetting(params.reader, key);
    return { kind: "preference", key, existed: value !== undefined, value };
  }
  return undefined;
}

/**
 * How many objects the recorded post-image covers.
 *
 * The number is part of what a receipt claims: a write that guarded four
 * objects and one that guarded none must not read identically in the audit
 * trail.
 */
export function countPostImageTargets(expected: unknown): number {
  if (!expected || typeof expected !== "object") return 0;
  const record = expected as Record<string, unknown>;
  if (record.kind === "script_effects" || record.kind === "script_items") {
    return (
      (Array.isArray(record.items) ? record.items.length : 0) +
      (Array.isArray(record.declared) ? record.declared.length : 0)
    );
  }
  // A captured library-operation state carries its objects in named sections;
  // anything else — a note, a file, a preference, one created item — is one.
  const sections = MUTATION_STATE_SECTIONS.map((section) =>
    Array.isArray(record[section]) ? (record[section] as unknown[]).length : 0,
  );
  const rows = sections.reduce((total, count) => total + count, 0);
  return rows || 1;
}

/**
 * Re-reads a recorded post-image and says whether live state still holds it.
 *
 * `satisfied` is deliberately narrow: the objects the write recorded still
 * hold the state it recorded. It is a claim about state, not about intent, and
 * it is the strongest claim available for an effect whose only description is
 * what was found immediately after it applied.
 */
export async function verifyRecordedPostImage(params: {
  image: RecordedPostImage;
  reader: PostImageReader;
}): Promise<RecordedPostImageState> {
  const expected = params.image.expected;
  if (expected === undefined) {
    return {
      kind: "not_re_readable",
      comparedTargets: 0,
      reason: "the step recorded no expected post-image to read back",
    };
  }
  const comparedTargets = countPostImageTargets(expected);
  try {
    const current = await readRecordedPostImage(params);
    if (current === undefined) {
      return {
        kind: "not_re_readable",
        comparedTargets,
        reason:
          "the recorded post-image format cannot be read back by this version",
      };
    }
    return stable(current) === stable(expected)
      ? { kind: "satisfied", comparedTargets }
      : {
          kind: "mismatched",
          comparedTargets,
          reason:
            "native state no longer matches the post-image recorded for this step",
        };
  } catch (error) {
    return {
      kind: "not_re_readable",
      comparedTargets,
      reason: `the post-image could not be read back: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
