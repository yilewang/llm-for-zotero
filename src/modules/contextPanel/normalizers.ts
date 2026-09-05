import type {
  CollectionContextRef,
  NoteContextRef,
  PaperContentSourceMode,
  PaperContextRef,
  SelectedTextContext,
  SelectedTextSource,
  TagContextRef,
} from "./types";

type TextSanitizer = (value: string) => string;

function normalizeText(value: unknown, sanitize?: TextSanitizer): string {
  const raw = typeof value === "string" ? value : "";
  return (sanitize ? sanitize(raw) : raw).trim();
}

function normalizeLibraryItemKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase();
  return normalized || undefined;
}

function resolveNoteItem(
  noteItemId?: number | null,
  libraryID?: number | null,
  noteItemKey?: string | null,
): Zotero.Item | null {
  const items = (globalThis as { Zotero?: { Items?: Record<string, unknown> } })
    .Zotero?.Items as
    | {
        get?: (id: number) => Zotero.Item | null | undefined;
        getByLibraryAndKey?: (
          libraryID: number,
          key: string,
        ) => Zotero.Item | null | undefined;
      }
    | undefined;
  if (noteItemId && typeof items?.get === "function") {
    const fromId = items.get(noteItemId) || null;
    if (fromId) return fromId;
  }
  if (
    libraryID &&
    noteItemKey &&
    typeof items?.getByLibraryAndKey === "function"
  ) {
    return items.getByLibraryAndKey(libraryID, noteItemKey) || null;
  }
  return null;
}

export function buildNoteContextIdentityKey(
  noteContext: Partial<NoteContextRef> | null | undefined,
): string {
  const libraryID = normalizePositiveInt(noteContext?.libraryID);
  const noteItemKey = normalizeLibraryItemKey(noteContext?.noteItemKey);
  if (libraryID && noteItemKey) {
    return `${libraryID}:${noteItemKey}`;
  }
  const noteItemId = normalizePositiveInt(noteContext?.noteItemId);
  if (!noteItemId) return "";
  const noteKind =
    noteContext?.noteKind === "standalone" ? "standalone" : "item";
  return `legacy:${noteItemId}:${noteKind}`;
}

export function normalizePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : null;
}

export function normalizeSelectedTextSource(
  value: unknown,
): SelectedTextSource {
  if (value === "model") return "model";
  if (value === "note") return "note";
  if (value === "note-edit") return "note-edit";
  return "pdf";
}

export function normalizeSelectedTextSources(
  value: unknown,
  count: number,
): SelectedTextSource[] {
  if (count <= 0) return [];
  const raw = Array.isArray(value) ? value : [];
  const out: SelectedTextSource[] = [];
  for (let index = 0; index < count; index++) {
    out.push(normalizeSelectedTextSource(raw[index]));
  }
  return out;
}

export function normalizeSelectedTextContexts(
  value: unknown,
  options?: {
    sanitizeText?: TextSanitizer;
  },
): SelectedTextContext[] {
  if (!Array.isArray(value)) return [];
  const sanitize = options?.sanitizeText;
  const out: SelectedTextContext[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const text = normalizeText(entry, sanitize);
      if (text) out.push({ text, source: "pdf" });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const typed = entry as Record<string, unknown>;
    const text = normalizeText(typed.text, sanitize);
    if (!text) continue;
    const source = normalizeSelectedTextSource(typed.source);
    const paperContext = normalizePaperContextRefs(
      typed.paperContext ? [typed.paperContext] : [],
      options,
    )[0];
    const noteContext = normalizeNoteContextRef(typed.noteContext, options);
    const contextItemId =
      normalizePositiveInt(typed.contextItemId) ||
      (source === "pdf" ? paperContext?.contextItemId : undefined);
    const rawPageIndex = Number(typed.pageIndex);
    const pageIndex =
      Number.isFinite(rawPageIndex) && rawPageIndex >= 0
        ? Math.floor(rawPageIndex)
        : undefined;
    const rawPageLabel = normalizeText(typed.pageLabel, sanitize);
    out.push({
      text,
      source,
      paperContext,
      noteContext,
      contextItemId,
      pageIndex,
      pageLabel:
        rawPageLabel ||
        (pageIndex !== undefined ? `${pageIndex + 1}` : undefined),
    });
  }
  return out;
}

export function synthesizeSelectedTextContexts(params: {
  selectedTextContexts?: unknown;
  selectedTexts?: unknown;
  legacySelectedText?: unknown;
  selectedTextSources?: unknown;
  selectedTextPaperContexts?: unknown;
  selectedTextNoteContexts?: unknown;
  sanitizeText?: TextSanitizer;
}): SelectedTextContext[] {
  const canonical = normalizeSelectedTextContexts(params.selectedTextContexts, {
    sanitizeText: params.sanitizeText,
  });
  if (canonical.length) return canonical;

  const sanitize = params.sanitizeText;
  const rawTexts = Array.isArray(params.selectedTexts)
    ? params.selectedTexts
    : typeof params.legacySelectedText === "string"
      ? [params.legacySelectedText]
      : [];
  const texts = rawTexts
    .map((entry) => normalizeText(entry, sanitize))
    .filter(Boolean);
  if (!texts.length) return [];
  const sources = normalizeSelectedTextSources(
    params.selectedTextSources,
    texts.length,
  );
  const papers = normalizeSelectedTextPaperContexts(
    params.selectedTextPaperContexts,
    texts.length,
    { sanitizeText: sanitize },
  );
  const notes = normalizeSelectedTextNoteContexts(
    params.selectedTextNoteContexts,
    texts.length,
    { sanitizeText: sanitize },
  );
  return texts.map((text, index) => ({
    text,
    source: sources[index],
    paperContext: papers[index],
    noteContext: notes[index],
    contextItemId:
      sources[index] === "pdf" ? papers[index]?.contextItemId : undefined,
  }));
}

export function normalizeNoteContextRef(
  value: unknown,
  options?: {
    sanitizeText?: TextSanitizer;
  },
): NoteContextRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const typed = value as Record<string, unknown>;
  const noteItemId = normalizePositiveInt(typed.noteItemId) || undefined;
  let libraryID = normalizePositiveInt(typed.libraryID) || undefined;
  let noteItemKey = normalizeLibraryItemKey(typed.noteItemKey);
  const sanitize = options?.sanitizeText;
  const title = normalizeText(typed.title, sanitize);
  let resolvedTitle = title;
  let parentItemId = normalizePositiveInt(typed.parentItemId) || undefined;
  let parentItemKey = normalizeLibraryItemKey(typed.parentItemKey);
  const resolvedNoteItem = resolveNoteItem(noteItemId, libraryID, noteItemKey);
  if (!libraryID) {
    libraryID =
      normalizePositiveInt((resolvedNoteItem as any)?.libraryID) || undefined;
  }
  if (!noteItemKey) {
    noteItemKey = normalizeLibraryItemKey((resolvedNoteItem as any)?.key);
  }
  if (!parentItemId) {
    parentItemId =
      normalizePositiveInt((resolvedNoteItem as any)?.parentID) || undefined;
  }
  if (!parentItemKey && parentItemId) {
    const parentItem =
      (
        globalThis as {
          Zotero?: {
            Items?: { get?: (id: number) => Zotero.Item | null | undefined };
          };
        }
      ).Zotero?.Items?.get?.(parentItemId) || null;
    parentItemKey = normalizeLibraryItemKey((parentItem as any)?.key);
  }
  if (!resolvedTitle) {
    resolvedTitle =
      normalizeText((resolvedNoteItem as any)?.getDisplayTitle?.(), sanitize) ||
      normalizeText((resolvedNoteItem as any)?.getField?.("title"), sanitize);
  }
  if (!libraryID || !noteItemKey) return undefined;
  const noteKind =
    typed.noteKind === "standalone"
      ? "standalone"
      : typed.noteKind === "item"
        ? "item"
        : parentItemId || parentItemKey
          ? "item"
          : "standalone";
  return {
    libraryID,
    noteItemKey,
    noteItemId,
    parentItemId,
    parentItemKey,
    noteKind,
    title:
      resolvedTitle ||
      (noteItemId ? `Note ${noteItemId}` : `Note ${noteItemKey}`),
  };
}

export function normalizeSelectedTextNoteContexts(
  value: unknown,
  count: number,
  options?: {
    sanitizeText?: TextSanitizer;
  },
): (NoteContextRef | undefined)[] {
  if (count <= 0) return [];
  const raw = Array.isArray(value) ? value : [];
  const out: (NoteContextRef | undefined)[] = [];
  for (let index = 0; index < count; index++) {
    out.push(normalizeNoteContextRef(raw[index], options));
  }
  return out;
}

export function normalizeAttachmentContentHash(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

function normalizePaperContentSourceMode(
  value: unknown,
): PaperContentSourceMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "text":
    case "mineru":
    case "pdf":
    case "markdown":
    case "html":
    case "txt":
    case "docx":
      return normalized;
    default:
      return undefined;
  }
}

export function normalizePaperContextRefs(
  value: unknown,
  options?: {
    sanitizeText?: TextSanitizer;
  },
): PaperContextRef[] {
  if (!Array.isArray(value)) return [];
  const sanitize = options?.sanitizeText;
  const out: PaperContextRef[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const typed = entry as Record<string, unknown>;
    const libraryID = normalizePositiveInt(typed.libraryID);
    const itemId = normalizePositiveInt(typed.itemId);
    const contextItemId = normalizePositiveInt(typed.contextItemId);
    if (!itemId || !contextItemId) continue;
    const title = normalizeText(typed.title, sanitize);
    if (!title) continue;
    const attachmentTitle = normalizeText(typed.attachmentTitle, sanitize);
    const citationKey = normalizeText(typed.citationKey, sanitize);
    const firstCreator = normalizeText(typed.firstCreator, sanitize);
    const year = normalizeText(typed.year, sanitize);
    const contentSourceMode = normalizePaperContentSourceMode(
      typed.contentSourceMode,
    );
    const dedupeKey = `${libraryID || 0}:${itemId}:${contextItemId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const normalized: PaperContextRef = {
      ...(libraryID ? { libraryID } : {}),
      itemId,
      contextItemId,
      title,
      attachmentTitle: attachmentTitle || undefined,
      citationKey: citationKey || undefined,
      firstCreator: firstCreator || undefined,
      year: year || undefined,
    };
    if (contentSourceMode) normalized.contentSourceMode = contentSourceMode;
    out.push(normalized);
  }
  return out;
}

export function normalizeCollectionContextRefs(
  value: unknown,
  options?: {
    sanitizeText?: TextSanitizer;
  },
): CollectionContextRef[] {
  if (!Array.isArray(value)) return [];
  const sanitize = options?.sanitizeText;
  const out: CollectionContextRef[] = [];
  const seen = new Set<number>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const typed = entry as Record<string, unknown>;
    const collectionId = normalizePositiveInt(typed.collectionId);
    const libraryID = normalizePositiveInt(typed.libraryID);
    if (!collectionId || !libraryID || seen.has(collectionId)) continue;
    const name =
      normalizeText(typed.name, sanitize) || `Collection ${collectionId}`;
    seen.add(collectionId);
    out.push({
      collectionId,
      name,
      libraryID,
    });
  }
  return out;
}

export function normalizeTagContextRefs(
  value: unknown,
  options?: {
    sanitizeText?: TextSanitizer;
  },
): TagContextRef[] {
  if (!Array.isArray(value)) return [];
  const sanitize = options?.sanitizeText;
  const out: TagContextRef[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const typed = entry as Record<string, unknown>;
    const libraryID = normalizePositiveInt(typed.libraryID);
    if (!libraryID) continue;
    const name = normalizeText(typed.name, sanitize);
    const rawScope = typed.scope;
    const scope =
      rawScope === "allTagged" || rawScope === "untagged"
        ? rawScope
        : undefined;
    const normalizedName = normalizeText(typed.normalizedName, sanitize)
      .toLowerCase()
      .trim();
    if (!name || (!scope && !normalizedName)) continue;
    const includeAutomatic = typed.includeAutomatic === true;
    const key = scope
      ? `${libraryID}:scope:${scope}:${includeAutomatic ? "auto" : "manual"}`
      : `${libraryID}:tag:${normalizedName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      libraryID,
      normalizedName: scope ? undefined : normalizedName,
      scope,
      includeAutomatic,
    });
  }
  return out;
}

export function normalizeSelectedTextPaperContexts(
  value: unknown,
  count: number,
  options?: {
    sanitizeText?: TextSanitizer;
  },
): (PaperContextRef | undefined)[] {
  if (count <= 0) return [];
  const raw = Array.isArray(value) ? value : [];
  const sanitize = options?.sanitizeText;
  const out: (PaperContextRef | undefined)[] = [];
  for (let index = 0; index < count; index++) {
    const entry = raw[index];
    if (!entry || typeof entry !== "object") {
      out.push(undefined);
      continue;
    }
    const typed = entry as Record<string, unknown>;
    const itemId = normalizePositiveInt(typed.itemId);
    const contextItemId = normalizePositiveInt(typed.contextItemId);
    const title = normalizeText(typed.title, sanitize);
    if (!itemId || !contextItemId || !title) {
      out.push(undefined);
      continue;
    }
    const citationKey = normalizeText(typed.citationKey, sanitize);
    const attachmentTitle = normalizeText(typed.attachmentTitle, sanitize);
    const firstCreator = normalizeText(typed.firstCreator, sanitize);
    const year = normalizeText(typed.year, sanitize);
    out.push({
      itemId,
      contextItemId,
      title,
      attachmentTitle: attachmentTitle || undefined,
      citationKey: citationKey || undefined,
      firstCreator: firstCreator || undefined,
      year: year || undefined,
    });
  }
  return out;
}
