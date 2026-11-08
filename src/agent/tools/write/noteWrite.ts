import { executeNoteCreation } from "../../services/noteCreation";
import { executePreparedNoteChange } from "./preparedNoteChange";
import { importLocalImagesIntoNote } from "../../../services/notes/noteImages";
import {
  isLikelyHtmlNoteContent,
  normalizeNoteSourceText,
  noteHtmlToModelText,
  renderNoteMarkdownWithEmbeds,
  renderRawNoteHtml,
} from "../../../services/notes/noteRendering";
import {
  readNoteSnapshot,
  stripNoteHtml,
  type NoteSnapshot,
} from "../../../services/notes/noteSnapshot";
import { resolveParentItemForNoteTarget } from "../../../services/notes/noteTarget";
import {
  replaceTextContentInHtml,
  replaceNoteSelectionHtml,
  type NoteRangeReplacement,
} from "../../../utils/noteEdit";
import { synthesizeSelectedTextContexts } from "../../../services/context/normalizers";
import { noteHtmlMatches } from "../../../utils/noteHtml";
import {
  adoptRetypedNoteEmbedLabels,
  collectNoteEmbeds,
  createNoteEmbedCarrier,
  findMissingNoteEmbeds,
  formatNoteEmbedToken,
  NOTE_EMBED_TOKEN_PATTERN,
  noteEmbedRegistry,
  noteEmbedsByVisibleText,
  noteEmbedVisibleText,
  preserveNoteRoot,
  replaceNoteEmbedTokensWithLabels,
  restoreNoteEmbedTokensInHtml,
  type NoteEmbed,
} from "../../../utils/noteEmbeds";
import { escapeNoteHtml } from "../../../utils/textSanitization";
import {
  mergeNoteCitationItems,
  type NoteCitationItem,
} from "../../../utils/noteCitations";
import {
  expandNewCitationTokens,
  type CitationItemLookup,
} from "../../../services/notes/noteCitations";
import { stateChangeInvocationPlan } from "../../authorization/invocationPlan";
import {
  savePlanDocumentAsNote,
  finalizeDocumentNoteHtml,
} from "../../documents/actions";
import {
  materialRefFromDocument,
  resolveWorkflowNoteDocument,
} from "../../documents/workflowMaterial";
import type { MaterialRef } from "../../documents/materialRef";
import { executeExternalMutation } from "../../services/externalMutationCoordinator";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  sha256Text,
  storeRecoveryText,
} from "../../store/journalRecoveryBlobStore";
import { WRITE_NOTE_SKILL_ID } from "../../skills/noteIntent";
import type {
  AgentToolContext,
  AgentToolDefinition,
  AgentWriteToolDefinition,
  AgentToolGuidance,
} from "../../types";
import {
  fail,
  normalizePositiveInt,
  normalizePositiveIntArray,
  ok,
  validateObject,
} from "../shared";
import { buildNoteChangeResultCards } from "./noteChangePresentation";
import { buildSavedNoteResultCards } from "./noteResultPresentation";
import { readAgentConversationAnswer } from "../../store/transcriptStore";

type NotePatch = {
  find: string;
  replace: string;
  findFormat?: "text" | "markdown";
};

export const SOURCE_NOTE_COPY_GUIDANCE =
  "To copy an existing note without revising its content, use mode:'create' with sourceNoteId and the requested target/collections instead of reconstructing its content. This preserves the native note, including formatting, original provenance and embedded images; do not generate a new header or perform a corrective edit.";

export const NOTE_WRITE_GUIDANCE: AgentToolGuidance = {
  matches: (request, context) =>
    Boolean(
      context?.matchedSkillIds.includes(WRITE_NOTE_SKILL_ID) ||
      request.forcedSkillIds?.includes(WRITE_NOTE_SKILL_ID),
    ),
  instruction:
    "Use note_write mode:'edit' against the exact note target. For a bound Selected text passage, pass selection:{index:<1-based Selected text number>,replacement:<final Markdown>}. The host binds its owning note, replaces the selected structure, preserves surrounding content and embedded assets, and saves and verifies in one action. Preserve headings and list structure unless the user requests changing them. For precise edits without a bound selection, use patches with plain replacement text; findFormat:'markdown' interprets Markdown copied from library_read. Use mode:'append' to append and mode:'create' for a new note. Keep every {{kind:id}} placeholder of an embedded citation, highlight or image where its item belongs; to delete one the user names, list its id in removeEmbeds and omit its placeholder. To add a clickable Zotero citation, write {{cite item=<regular item's itemId> page=<pageLabel from paper_read>}}, or {{cite item=1 page=4; item=2 page=9}} for several works; omit page to cite a whole work. Resolve a named parent or collection before proposing the write. Pass finalized material by documentId so retries reuse exact content. Safe reviews every note write, including creation; Auto may apply routine same-library note changes directly. After verified success, do not claim that a diff is still awaiting review. " +
    SOURCE_NOTE_COPY_GUIDANCE,
};

/**
 * Sanitise HTML before writing to a Zotero note.  Strips dangerous
 * elements and attributes while preserving inline `style=` styling.
 */
function sanitizeNoteHtml(html: string): string {
  let s = html;
  // Remove dangerous elements (with content)
  s = s.replace(
    /<(script|style|iframe|object|embed|form|input)[^>]*>[\s\S]*?<\/\1>/gi,
    "",
  );
  // Remove self-closing / void variants
  s = s.replace(
    /<(script|style|iframe|object|embed|form|input)\b[^>]*\/?>/gi,
    "",
  );
  // Remove event-handler attributes (on*)
  s = s.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // Neutralise javascript: / vbscript: URLs in href / src
  s = s.replace(/(href|src)\s*=\s*"(?:javascript|vbscript):[^"]*"/gi, '$1=""');
  s = s.replace(/(href|src)\s*=\s*'(?:javascript|vbscript):[^']*'/gi, "$1=''");
  return s;
}

/** Placeholders of the given item copies, each item once with its count. */
function describeEmbeds(embeds: NoteEmbed[]): string {
  const copies = new Map<string, { embed: NoteEmbed; count: number }>();
  for (const embed of embeds) {
    const entry = copies.get(embed.id);
    if (entry) entry.count++;
    else copies.set(embed.id, { embed, count: 1 });
  }
  return Array.from(
    copies.values(),
    ({ embed, count }) =>
      formatNoteEmbedToken({
        ...embed,
        label:
          embed.label.length > 80
            ? `${embed.label.slice(0, 80).trimEnd()}…`
            : embed.label,
      }) + (count > 1 ? ` (${count} copies)` : ""),
  ).join(", ");
}

/** A review-card sentence naming the citations this write adds. */
function describeNewCitations(input: NoteWriteInput): string {
  const labels = (input._newCitations?.embeds || []).map(
    (embed) => embed.label,
  );
  return labels.length
    ? ` Adds ${labels.length} Zotero citation${labels.length === 1 ? "" : "s"}: ${labels.join(", ")}.`
    : "";
}

function assertKnownEmbedTokens(unknown: string[]): void {
  if (!unknown.length) return;
  throw new Error(
    `The note has no embedded item ${Array.from(new Set(unknown)).join(", ")}. Use only {{kind:id}} placeholders that appear in the current note text, never invent or alter one. No content was changed.`,
  );
}

/** Resolve `{{cite item=… page=…}}` to a Zotero item id or item key. */
function citationLookup(
  zoteroGateway: ZoteroGateway,
  libraryID: number | undefined,
): CitationItemLookup {
  return (itemRef) =>
    /^\d+$/.test(itemRef)
      ? zoteroGateway.getItem(Number(itemRef))
      : libraryID
        ? Zotero.Items.getByLibraryAndKey(libraryID, itemRef.toUpperCase()) ||
          null
        : null;
}

/**
 * Turn new citation requests into placeholders of new chips. The chips are
 * kept on the input, so every later render (the user's own review text
 * included) can place them again without looking the items up twice.
 */
function expandCitations(
  text: string,
  input: NoteWriteInput,
  lookup: CitationItemLookup,
): string {
  const expanded = expandNewCitationTokens(text, lookup);
  if (!expanded.registry.size) return text;
  const state = (input._newCitations ||= { embeds: [], items: [] });
  for (const embed of expanded.registry.values())
    if (!state.embeds.some((entry) => entry.id === embed.id))
      state.embeds.push(embed);
  for (const item of expanded.citationItems)
    if (
      !state.items.some((entry) =>
        entry.uris.some((uri) => item.uris.includes(uri)),
      )
    )
      state.items.push(item);
  return expanded.text;
}

/** The original note's items, plus the chips this write adds. */
function embedRegistryFor(originalHtml: string, input: NoteWriteInput) {
  const registry = noteEmbedRegistry(originalHtml);
  for (const embed of input._newCitations?.embeds || [])
    if (!registry.has(embed.id)) registry.set(embed.id, embed);
  return registry;
}

/** Register the works that new chips in the final HTML cite. */
function withCitationRegistry(html: string, input: NoteWriteInput): string {
  return mergeNoteCitationItems(html, usedCitationItems(html, input));
}

function usedCitationItems(
  html: string,
  input: NoteWriteInput,
): NoteCitationItem[] {
  return (input._newCitations?.items || []).filter((item) =>
    item.uris.some((uri) => html.includes(encodeURIComponent(uri))),
  );
}

/** Render edit, append or create content: new citation requests become
 * chips, and placeholders turn back into the items of the original note. */
function renderContentWithEmbeds(
  content: string,
  isHtml: boolean | undefined,
  originalHtml: string,
  input: NoteWriteInput,
  lookup: CitationItemLookup,
): string {
  const text = expandCitations(content, input, lookup);
  const registry = embedRegistryFor(originalHtml, input);
  const rendered = isHtml
    ? restoreNoteEmbedTokensInHtml(sanitizeNoteHtml(text), registry)
    : renderNoteMarkdownWithEmbeds(text, registry);
  assertKnownEmbedTokens(rendered.unknown);
  return rendered.html;
}

/** The final HTML of an edit: the note's root container (which holds its
 * citation registry) kept. An item is deleted only by leaving out its
 * placeholder, never by its id alone. */
function finishEditHtml(html: string, originalHtml: string): string {
  return preserveNoteRoot(originalHtml, html);
}

/**
 * Refuse an edit that would lose a copy of an embedded item nobody asked to
 * remove. An id in removeEmbeds lets that item lose copies; the copies whose
 * placeholders the edit left out are deleted, and the rest are kept.
 */
function assertEmbedsKept(
  originalHtml: string,
  nextHtml: string,
  removeEmbeds: string[] | undefined,
): void {
  const registry = noteEmbedRegistry(originalHtml);
  const strangers = (removeEmbeds || []).filter((id) => !registry.has(id));
  if (strangers.length)
    throw new Error(
      `removeEmbeds names ${strangers.join(", ")}, which is not an embedded item of this note. Use ids from the note's {{kind:id}} placeholders. No content was changed.`,
    );
  const missing = findMissingNoteEmbeds(originalHtml, nextHtml).filter(
    (embed) => !removeEmbeds?.includes(embed.id),
  );
  if (!missing.length) return;
  // Retyped text that several different items show cannot name one of them.
  const shown = noteEmbedsByVisibleText(collectNoteEmbeds(originalHtml));
  const ambiguous = Array.from(shown.entries())
    .filter(
      ([visible, owners]) =>
        visible.length >= 3 &&
        owners.length > 1 &&
        missing.some((embed) => owners.some((owner) => owner.id === embed.id)),
    )
    .map(
      ([visible, owners]) =>
        ` "${visible}" is shown by several items: ${owners
          .map((owner) => formatNoteEmbedToken(owner, { label: false }))
          .join(
            ", ",
          )}; write the placeholder of the one you mean, not its text.`,
    )
    .join("");
  throw new Error(
    `This edit would delete ${missing.length} embedded item${missing.length === 1 ? "" : "s"} from the note: ${describeEmbeds(missing)}. Put each placeholder back where its item belongs in the new text (moving it is fine, and {{kind:id}} without the label is enough).${ambiguous} Only if the user asked to delete an item, list its id in removeEmbeds and omit its placeholder. No content was changed.`,
  );
}

/**
 * The replacement for an edited range: a label retyped as plain text means
 * an item inside that range, never an item elsewhere in the note that shows
 * the same text. Placeholders become their items, which the range carries.
 */
function rangeReplacement(
  text: string,
  render: (adopted: string) => string,
  removeEmbeds?: readonly string[],
): NoteRangeReplacement {
  const listed = (embed: NoteEmbed) =>
    Boolean(removeEmbeds?.includes(embed.id));
  return (touched) => {
    // A listed item is being deleted, so its retyped label stays plain text.
    const html = render(
      adoptRetypedNoteEmbedLabels(
        text,
        touched.filter((embed) => !listed(embed)),
      ),
    );
    return { html, carried: createNoteEmbedCarrier(html), removed: listed };
  };
}

type NoteWriteInput = {
  documentId?: string;
  sourceMessageId?: string;
  /** The exact material this proposal is frozen to, resolved once in preparation. */
  _documentMaterialRef?: MaterialRef;
  _documentHasAssets?: boolean;
  mode: "edit" | "create" | "append";
  content: string;
  sourceNoteId?: number;
  _sourceOriginalHtml?: string;
  expectedOriginalHtml?: string;
  _patches?: NotePatch[];
  _selection?: { index: number; replacement: string };
  /** Ids of embedded items (citations, highlights, images) the edit deletes
   *  on purpose. Every other item of the original note must survive. */
  removeEmbeds?: string[];
  /** Citation chips this write adds, and the works they cite. */
  _newCitations?: { embeds: NoteEmbed[]; items: NoteCitationItem[] };
  /** Pre-patched HTML computed by applying patches directly to the original
   *  note HTML.  When set, `execute()` uses this instead of round-tripping
   *  through `renderRawNoteHtml` to preserve images, list numbering, etc. */
  _patchedHtml?: string;
  /** True when the content is HTML that should bypass markdown
   *  normalisation and be written directly via `setNote()`. */
  _isHtml?: boolean;
  /** Raw HTML retained until preparation sanitizes the final native payload. */
  _rawHtmlContent?: string;
  noteId?: number;
  noteTitle?: string;
  target?: "item" | "standalone";
  targetItemId?: number;
  targetNoteId?: number;
  collections?: number[];
};

function resolveCreateOrAppendContent(input: NoteWriteInput): void {
  if (input.mode !== "create" && input.mode !== "append") return;
  if (input._rawHtmlContent) {
    input._isHtml = true;
    input.content = sanitizeNoteHtml(input._rawHtmlContent);
    delete input._rawHtmlContent;
  }
  input.content = input._isHtml
    ? sanitizeNoteHtml(input.content)
    : normalizeNoteSourceText(input.content);
  // A new note has no items for a placeholder to name; keep what it showed.
  // A finalized document is saved exactly as stored, so it is left alone.
  // A chip this write adds is the one exception.
  if (input.mode === "create" && !input.documentId)
    input.content = input.content.replace(
      NOTE_EMBED_TOKEN_PATTERN,
      (token, _kind, id) =>
        input._newCitations?.embeds.some((embed) => embed.id === id)
          ? token
          : replaceNoteEmbedTokensWithLabels(token),
    );
}

function resolveEditSnapshot(
  zoteroGateway: ZoteroGateway,
  input: NoteWriteInput,
  context: AgentToolContext,
) {
  if (typeof zoteroGateway.getActiveNoteSnapshot === "function") {
    const snapshot = zoteroGateway.getActiveNoteSnapshot({
      request: context.request,
      item: context.item,
      noteId: input.targetNoteId || input.noteId,
    });
    if (snapshot) return snapshot;
  }
  const active = context.request.activeNoteContext;
  const requestedId = input.targetNoteId || input.noteId;
  if (!active || (requestedId && active.noteId !== requestedId)) return null;
  const text = active.noteText || "";
  return {
    noteId: active.noteId,
    title: active.title || `Note ${active.noteId}`,
    html: input.expectedOriginalHtml || (text ? renderRawNoteHtml(text) : ""),
    text,
    libraryID: context.request.libraryID || 1,
    noteKind: active.noteKind,
  };
}

/**
 * Apply find-and-replace patches directly to the note's original HTML,
 * preserving images, list structure, and other formatting in blocks that
 * are not being edited.
 *
 * A patch matches the note's visible text exactly. A text find that is not
 * there is read once more the way the model sees the note (library_read's
 * note text, Markdown such as **bold** included) and matched exactly again;
 * nothing looser.
 *
 * Returns the patched HTML, or `null` if any patch cannot be located.
 * A missing match must stop the write, never rewrite the whole note.
 */
function applyPatchesToNoteHtml(
  html: string,
  patches: NotePatch[],
  input: NoteWriteInput,
  lookup: CitationItemLookup,
): string | { failedPatch: number } {
  if (!patches.length || !html) return html || { failedPatch: 0 };

  let result = html;
  for (const [index, patch] of patches.entries()) {
    // A placeholder in find stands for the text its item displays; one in
    // replace puts the item itself back.
    // New citations join the registry before anything is looked up in it.
    const requested = expandCitations(patch.replace, input, lookup);
    const registry = embedRegistryFor(result, input);
    const find = patch.find.replace(
      NOTE_EMBED_TOKEN_PATTERN,
      (token, _kind, id) => {
        const embed = registry.get(id);
        return embed ? stripNoteHtml(embed.html) : token;
      },
    );
    // A label of a replaced item retyped as plain text means the item itself.
    const replace = rangeReplacement(
      requested,
      (adopted) => {
        const restored = restoreNoteEmbedTokensInHtml(
          escapeNoteHtml(adopted),
          registry,
        );
        assertKnownEmbedTokens(restored.unknown);
        return restored.html;
      },
      input.removeEmbeds,
    );
    const asShown = stripNoteHtml(renderRawNoteHtml(find));
    const applied =
      patch.findFormat === "markdown"
        ? replaceTextContentInHtml(result, asShown, replace)
        : (replaceTextContentInHtml(result, find, replace) ??
          (asShown !== find
            ? replaceTextContentInHtml(result, asShown, replace)
            : null));
    if (applied === null) return { failedPatch: index };
    result = applied;
  }
  return result;
}

function buildAppendedNoteText(
  existingText: string,
  appendText: string,
): string {
  const base = (existingText || "").trim();
  const addition = (appendText || "").trim();
  if (!base) return addition;
  if (!addition) return base;
  return `${base}\n\n---\n\n${addition}`;
}

function getUniqueInScopePaperItemIds(context: AgentToolContext): number[] {
  const ids = [
    ...context.request.turnPaperScope.papers.map((entry) => entry.paper),
  ]
    .map((entry) => normalizePositiveInt(entry?.itemId))
    .filter((entry): entry is number => Boolean(entry));
  return Array.from(new Set(ids));
}

function resolveParentTargetForCreate(
  zoteroGateway: ZoteroGateway,
  input: Pick<NoteWriteInput, "targetItemId">,
  context: AgentToolContext,
): { item: Zotero.Item; parentItem: Zotero.Item } | null {
  const resolve = (item: Zotero.Item | null | undefined) => {
    if (!item) return null;
    const parentItem = resolveParentItemForNoteTarget(item);
    return parentItem?.id ? { item, parentItem } : null;
  };

  const explicitTarget = resolve(zoteroGateway.getItem(input.targetItemId));
  if (explicitTarget) return explicitTarget;

  const activeNoteParentId = normalizePositiveInt(
    context.request.activeNoteContext?.parentItemId,
  );
  const activeNoteParent = resolve(zoteroGateway.getItem(activeNoteParentId));
  if (activeNoteParent) return activeNoteParent;

  const activeItem = resolve(
    zoteroGateway.getItem(context.request.activeItemId),
  );
  if (activeItem) return activeItem;

  const contextItem = resolve(context.item);
  if (contextItem) return contextItem;

  const inScopeItemIds = getUniqueInScopePaperItemIds(context);
  if (inScopeItemIds.length === 1) {
    return resolve(zoteroGateway.getItem(inScopeItemIds[0]));
  }

  return null;
}

function getNoteItemById(
  zoteroGateway: ZoteroGateway,
  noteId: number | undefined,
): Zotero.Item | null {
  const note = zoteroGateway.getItem(noteId);
  return (note as any)?.isNote?.() ? note : null;
}

function resolveAppendNoteTarget(
  zoteroGateway: ZoteroGateway,
  input: Pick<NoteWriteInput, "targetItemId" | "targetNoteId">,
  context: AgentToolContext,
): Zotero.Item {
  const explicitNoteId = normalizePositiveInt(input.targetNoteId);
  if (explicitNoteId) {
    const note = getNoteItemById(zoteroGateway, explicitNoteId);
    if (!note) {
      throw new Error(`Target note ${explicitNoteId} was not found`);
    }
    return note;
  }

  const activeNoteId = normalizePositiveInt(
    context.request.activeNoteContext?.noteId,
  );
  const activeNote =
    getNoteItemById(zoteroGateway, activeNoteId) ||
    (((context.item as any)?.isNote?.()
      ? context.item
      : null) as Zotero.Item | null) ||
    getNoteItemById(zoteroGateway, context.request.activeItemId);
  if (activeNote) return activeNote;

  const target = resolveParentTargetForCreate(zoteroGateway, input, context);
  if (!target) {
    throw new Error("No target item is available for note append");
  }

  const noteIds: number[] = (target.parentItem as any).getNotes?.() || [];
  const notes = noteIds
    .map((noteId) => getNoteItemById(zoteroGateway, noteId))
    .filter((note): note is Zotero.Item => Boolean(note && !note.deleted));
  if (notes.length === 1) return notes[0];
  if (notes.length > 1) {
    throw new Error(
      `Item ${target.parentItem.id} has multiple child notes; pass targetNoteId to choose which one to append to.`,
    );
  }
  throw new Error(
    `Item ${target.parentItem.id} has no child note to append to`,
  );
}

/** Finalize the payload before authorization, whether or not a card is shown.
 * Keep the original snapshot on subsequent calls so approval/execution cannot
 * silently rebase an already prepared edit onto a concurrently changed note. */
function prepareNoteWriteInput(
  zoteroGateway: ZoteroGateway,
  input: NoteWriteInput,
  context: AgentToolContext,
): void {
  if (input.sourceNoteId) {
    const source = getNoteItemById(zoteroGateway, input.sourceNoteId);
    if (!source || source.deleted) {
      throw new Error("The source note is no longer available.");
    }
    if (source.libraryID !== context.request.libraryID) {
      throw new Error("The source note must belong to the current library.");
    }
    const html = source.getNote();
    if (
      input._sourceOriginalHtml !== undefined &&
      input._sourceOriginalHtml !== html
    ) {
      throw new Error(
        "The source note changed before copying. Read it again before retrying.",
      );
    }
    input._sourceOriginalHtml = html;
    input._isHtml = true;
    input.content = sanitizeNoteHtml(html);
  }
  resolveCreateOrAppendContent(input);
  const lookup = citationLookup(zoteroGateway, context.request.libraryID);
  // A finalized document is saved exactly as stored; its citation requests
  // are turned into chips where its note HTML is built.
  if (!input.documentId && input.content) {
    // Show the chips' own labels in review, and bind the cited items now so
    // an item that cannot be cited is refused before anything is written.
    input.content = expandCitations(input.content, input, lookup).replace(
      NOTE_EMBED_TOKEN_PATTERN,
      (token, _kind, id) => {
        const chip = input._newCitations?.embeds.find(
          (embed) => embed.id === id,
        );
        return chip && token === `{{citation:${id}}}`
          ? input._isHtml
            ? escapeNoteHtml(formatNoteEmbedToken(chip))
            : formatNoteEmbedToken(chip)
          : token;
      },
    );
  }
  if (input.mode === "create" || input.expectedOriginalHtml !== undefined)
    return;
  if (input._selection) {
    const contexts = synthesizeSelectedTextContexts(context.request);
    const selected = contexts[input._selection.index - 1];
    const noteId =
      selected?.noteContext?.noteItemId ||
      (selected?.source === "note-edit"
        ? context.request.activeNoteContext?.noteId
        : undefined);
    if (
      !selected ||
      selected.source !== "note-edit" ||
      !noteId ||
      (input.targetNoteId && input.targetNoteId !== noteId)
    )
      throw new Error(
        "The selected editing text must belong to the target note. No content was changed.",
      );
    input.targetNoteId = noteId;
  }
  const snapshot =
    input.mode === "append"
      ? readNoteSnapshot(resolveAppendNoteTarget(zoteroGateway, input, context))
      : resolveEditSnapshot(zoteroGateway, input, context);
  if (!snapshot) {
    throw new Error(
      input.targetNoteId
        ? `Note ${input.targetNoteId} was not found, or is not a note.`
        : "No active note is available to edit. Pass targetNoteId to edit a specific note, or use mode 'create' to write a new note.",
    );
  }
  if (input.mode === "edit") {
    if (input._selection) {
      const original = context.request.activeNoteContext;
      if (
        original?.noteId === snapshot.noteId &&
        original.noteHtml &&
        !noteHtmlMatches(snapshot.html, original.noteHtml)
      )
        throw new Error(
          "The note changed after the text was selected. Read and select the current text before retrying; no content was changed.",
        );
      const selected = synthesizeSelectedTextContexts(context.request)[
        input._selection.index - 1
      ];
      const patched = replaceNoteSelectionHtml(
        snapshot.html,
        selected.text,
        rangeReplacement(
          input._selection.replacement,
          (adopted) =>
            renderContentWithEmbeds(
              adopted,
              false,
              snapshot.html,
              input,
              lookup,
            ),
          input.removeEmbeds,
        ),
      );
      if (patched === null)
        throw new Error(
          "The selected text is missing or occurs more than once in the current note. Select a unique passage before retrying; no content was changed.",
        );
      input._patchedHtml = patched;
      input.content = noteHtmlToModelText(patched);
      delete input._selection;
    }
    if (input._patches) {
      const patchedHtml = applyPatchesToNoteHtml(
        snapshot.html,
        input._patches,
        input,
        lookup,
      );
      if (typeof patchedHtml !== "string") {
        const count = input._patches.length;
        const find = input._patches[patchedHtml.failedPatch]?.find || "";
        throw new Error(
          `Note patch text was not found${count > 1 ? ` (patch ${patchedHtml.failedPatch + 1} of ${count})` : ""}: "${find.length > 120 ? `${find.slice(0, 120)}…` : find}". No content was changed; read the current note before retrying.`,
        );
      }
      input._patchedHtml = patchedHtml;
      input.content = noteHtmlToModelText(patchedHtml);
      delete input._patches;
    }
    if (input._rawHtmlContent) {
      input._isHtml = true;
      input.content = sanitizeNoteHtml(input._rawHtmlContent);
    }
    delete input._rawHtmlContent;
    input.content = input._isHtml
      ? input.content
      : normalizeNoteSourceText(input.content);
    // A retyped label of an item stands for the item, when no other item
    // of the note shows the same text. A finalized document is saved exactly
    // as stored, so it is left to the check below.
    if (input._patchedHtml === undefined && !input.documentId) {
      const embeds = collectNoteEmbeds(snapshot.html);
      const shown = noteEmbedsByVisibleText(embeds);
      input.content = adoptRetypedNoteEmbedLabels(
        input.content,
        embeds.filter(
          (embed) =>
            !input.removeEmbeds?.includes(embed.id) &&
            shown.get(noteEmbedVisibleText(embed))?.length === 1,
        ),
      );
    }
    // Bind the exact final HTML now, so the check below and the write agree.
    const finalHtml = withCitationRegistry(
      finishEditHtml(
        input._patchedHtml ??
          renderContentWithEmbeds(
            input.content,
            input._isHtml,
            snapshot.html,
            input,
            lookup,
          ),
        snapshot.html,
      ),
      input,
    );
    assertEmbedsKept(snapshot.html, finalHtml, input.removeEmbeds);
    input._patchedHtml = finalHtml;
  } else if (input.mode === "append") {
    renderContentWithEmbeds(
      input.content,
      input._isHtml,
      snapshot.html,
      input,
      lookup,
    );
  }
  input.expectedOriginalHtml = snapshot.html;
  input.noteId = snapshot.noteId;
  input.noteTitle = snapshot.title || "Untitled note";
}

async function prepareWorkflowDocumentNote(
  input: NoteWriteInput,
  context: AgentToolContext,
): Promise<void> {
  if (!input.documentId) return;
  const document = await resolveWorkflowNoteDocument(
    context,
    input.documentId,
    // Preparation freezes the reference; every later pass re-checks against it.
    input._documentMaterialRef,
  );
  if (input.content && input.content !== document.visibleHtml)
    throw new Error(
      "The reviewed content differs from the finalized document; revise the document before saving it.",
    );
  input.content = document.visibleHtml;
  input._isHtml = true;
  input._documentMaterialRef = materialRefFromDocument(document);
  input._documentHasAssets = document.assets.length > 0;
}

export function createNoteWriteTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<NoteWriteInput, unknown> {
  return {
    describeAction: (input) => [
      {
        id: `note_${input.mode}:${input.targetNoteId || input.noteId || input.targetItemId || "new"}`,
        proofDomain: "zotero_state",
        capability: "zotero.notes",
        operation:
          input.mode === "edit"
            ? "note_edit"
            : input.mode === "append"
              ? "note_append"
              : "note_create",
        source: "zotero_native",
        parameters: {
          noteMode: input.mode,
          documentId: input.documentId,
          documentVersion: input._documentMaterialRef?.documentVersion,
          contentHash: input._documentMaterialRef?.contentHash,
          targetItemId: input.targetItemId,
          targetNoteId: input.targetNoteId || input.noteId,
          expectedText: input.content
            ? stripNoteHtml(
                input._patchedHtml ??
                  (input._isHtml
                    ? sanitizeNoteHtml(
                        replaceNoteEmbedTokensWithLabels(input.content),
                      )
                    : renderRawNoteHtml(
                        replaceNoteEmbedTokensWithLabels(input.content),
                      )),
              )
            : undefined,
        },
        requestedTargets: [
          input.targetNoteId ||
            input.noteId ||
            (input.mode === "create" ? input.targetItemId : undefined),
        ]
          .filter((id): id is number => Boolean(id))
          .map((id) => `item:${id}`),
        destinationCollectionIds: input.collections || [],
      },
    ],
    effectOperations: ["note_create", "note_edit", "note_append"],
    spec: {
      name: "note_write",
      description:
        "Create, append to, or edit one Zotero note and verify native post-state. Use documentId for finalized authored material so retries reuse the exact stored version. Safe reviews every write, including creation. Use note_write_batch for many items.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          documentId: {
            type: "string",
            description:
              "Exact finalized document ID returned by submit_document. Use instead of content for create, edit, or append of finalized workflow material.",
          },
          mode: {
            type: "string",
            enum: ["edit", "create", "append"],
            description:
              "Use 'edit' only when rewriting or patching an existing current note. Use 'append' to add content to an existing note. Use 'create' to create a brand-new attached or standalone note.",
          },
          content: {
            type: "string",
            description:
              "The full note body as plain text or Markdown. Use this OR patches OR sourceNoteId, not more than one. Required for a newly authored note.",
          },
          selection: {
            type: "object",
            additionalProperties: false,
            properties: {
              index: {
                type: "integer",
                minimum: 1,
                description:
                  "The 1-based Selected text number with source active note editing focus.",
              },
              replacement: {
                type: "string",
                description:
                  "Final replacement Markdown for only this selection. Preserve the selected heading/list style unless the user requests changing it. The host binds the note, replaces the selected structure, preserves surrounding content, saves and verifies.",
              },
            },
            required: ["index", "replacement"],
            description:
              "For mode edit, replace a bound note selection directly. Use instead of patches or full-note content; no copied find text, native HTML, or separate readback call is needed.",
          },
          sourceNoteId: {
            type: "number",
            description:
              "For mode 'create' only: copy this existing note's complete native content and embedded images. Use instead of content when making a standalone/child copy, preserving formatting and provenance without generating a second header.",
          },
          sourceMessageId: {
            type: "string",
            description:
              "Save this exact prior assistant answer without reauthoring it. Use instead of content, patches, documentId or sourceNoteId.",
          },
          patches: {
            type: "array",
            items: {
              type: "object",
              properties: {
                find: {
                  type: "string",
                  description:
                    "The exact text to find. Use selected visible text with findFormat:text, or copy the Markdown from library_read with findFormat:markdown.",
                },
                findFormat: {
                  type: "string",
                  enum: ["text", "markdown"],
                  description:
                    "Representation of find: text for the selected editor text (default), markdown when copying formatted noteText from library_read. This only interprets find; replace is plain visible text.",
                },
                replace: {
                  type: "string",
                  description:
                    "The replacement visible text (plain text, without Markdown formatting markers). A {{kind:id}} placeholder puts that item there.",
                },
              },
              required: ["find", "replace"],
              additionalProperties: false,
            },
            description:
              "For mode 'edit': find-and-replace patches applied to the current note. Much faster than rewriting the full content. Each patch replaces the first occurrence of 'find' with 'replace'.",
          },
          removeEmbeds: {
            type: "array",
            items: { type: "string" },
            description:
              "Mode 'edit': ids of {{kind:id}} note placeholders (citations, highlights, images) the user asked to delete; omit those placeholders. Keep all others; an edit dropping one is refused.",
          },
          target: {
            type: "string",
            enum: ["item", "standalone"],
            description:
              "For mode 'create': attach to a paper ('item', default) or create standalone ('standalone').",
          },
          targetItemId: {
            type: "number",
            description:
              "For mode 'create': attach note to this specific item ID. For mode 'append': use this item when resolving the single child note fallback.",
          },
          targetNoteId: {
            type: "number",
            description:
              "The Zotero note to write to, by ID. For mode 'append' it names the note to append to; for mode 'edit' it names the note to rewrite or patch, which is how you edit a note the user does not currently have open. Omit it to act on the open note.",
          },
          collections: {
            type: "array",
            items: { type: "number" },
            description:
              "For mode 'create' with target 'standalone': Zotero collection IDs (folders) to file the new note into. Resolve names to IDs with library_search({ entity:'collections', mode:'list' }). Ignored for child notes, which belong to their parent item rather than to a collection.",
          },
        },
      },
      executionClass: "external_effect",
      workCategory: "zotero_action",
    },
    guidance: NOTE_WRITE_GUIDANCE,
    presentation: {
      label: "Write Note",
      traceIcon: "edit",
      buildResultCards: (content) =>
        buildNoteChangeResultCards(content) ||
        buildSavedNoteResultCards(zoteroGateway, content),
      summaries: {
        onCall: "Preparing note changes",
        onPending: "Waiting for confirmation on note edit",
        onApproved: "Applying note changes",
        onDenied: "Note changes cancelled",
        onSuccess: ({ content }) => {
          const title =
            content && typeof content === "object"
              ? String((content as { title?: unknown }).title || "")
              : "";
          const change = buildNoteChangeResultCards(content)?.[0];
          if (change)
            return change.state === "no_op"
              ? `No changes needed: ${change.title}`
              : `Changed note: ${change.title}`;
          return title ? `Note saved: ${title}` : "Note saved";
        },
      },
    },
    acceptInheritedApproval: async (_input, approval) => {
      // Accept review-mode approvals from literature_search review cards
      // that chain a save_note operation
      return (
        approval.sourceMode === "review" &&
        (approval.sourceActionId === "save_metadata_note" ||
          approval.sourceActionId === "save_paper_note")
      );
    },

    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          "Expected an object with a 'content' string or 'patches' array",
        );
      }
      const mode =
        args.mode === "create"
          ? ("create" as const)
          : args.mode === "append"
            ? ("append" as const)
            : ("edit" as const);

      const selection = args.selection as
        | { index?: unknown; replacement?: unknown }
        | undefined;
      if (
        selection !== undefined &&
        (!validateObject(selection) ||
          !Number.isSafeInteger(selection.index) ||
          Number(selection.index) < 1 ||
          typeof selection.replacement !== "string" ||
          !selection.replacement.trim() ||
          mode !== "edit" ||
          args.content !== undefined ||
          args.patches !== undefined ||
          args.documentId !== undefined ||
          args.sourceNoteId !== undefined)
      )
        return fail(
          "selection requires mode edit, a positive 1-based index and replacement Markdown, without content, patches, documentId or sourceNoteId",
        );
      // Parse patches if provided
      const hasPatches = Array.isArray(args.patches) && args.patches.length > 0;
      const hasContent =
        typeof args.content === "string" && args.content.trim();
      const sourceNoteId = normalizePositiveInt(args.sourceNoteId);
      const sourceMessageId =
        typeof args.sourceMessageId === "string"
          ? args.sourceMessageId.trim()
          : undefined;
      if (
        args.sourceMessageId !== undefined &&
        (!sourceMessageId ||
          args.content !== undefined ||
          args.patches !== undefined ||
          args.documentId !== undefined ||
          args.sourceNoteId !== undefined ||
          selection !== undefined)
      )
        return fail(
          "sourceMessageId requires one exact assistant answer without content, patches, documentId, sourceNoteId or selection",
        );
      const documentId =
        typeof args.documentId === "string"
          ? args.documentId.trim()
          : undefined;
      // A finalized document goes to exactly one named destination: a
      // parent item, or a standalone note (collections imply standalone).
      const documentStandalone =
        args.target === "standalone" ||
        Boolean(normalizePositiveIntArray(args.collections)?.length);
      if (
        args.documentId !== undefined &&
        (!documentId ||
          hasContent ||
          hasPatches ||
          sourceNoteId ||
          (mode === "create"
            ? Boolean(normalizePositiveInt(args.targetItemId)) ===
              documentStandalone
            : !normalizePositiveInt(args.targetNoteId) ||
              args.target === "standalone" ||
              args.collections !== undefined))
      )
        return fail(
          "documentId requires, for create, either the exact parent targetItemId or target:'standalone' (optionally with collections); for edit/append, targetNoteId. No substituted content or patches.",
        );
      if (
        args.sourceNoteId !== undefined &&
        (!sourceNoteId || mode !== "create" || hasContent || hasPatches)
      ) {
        return fail(
          "sourceNoteId requires mode 'create' and cannot be combined with content or patches",
        );
      }

      if (mode === "create" || mode === "append") {
        if (!hasContent && !sourceNoteId && !documentId && !sourceMessageId) {
          return fail(
            `content is required for mode '${mode}': provide the note body as a string`,
          );
        }
      } else if (
        !hasContent &&
        !hasPatches &&
        !documentId &&
        !selection &&
        !sourceMessageId
      ) {
        return fail(
          "Either 'content' (full note text) or 'patches' (find-and-replace pairs) is required for mode 'edit'",
        );
      }

      let removeEmbeds: string[] | undefined;
      if (args.removeEmbeds !== undefined) {
        const entries = Array.isArray(args.removeEmbeds)
          ? args.removeEmbeds
          : [];
        const ids = entries.map((entry) =>
          typeof entry === "string"
            ? /^\s*(?:\{\{\s*(?:citation|highlight|image|embed):)?([0-9a-f]{6,8})\b/i
                .exec(entry)?.[1]
                ?.toLowerCase()
            : undefined,
        );
        if (
          mode !== "edit" ||
          !Array.isArray(args.removeEmbeds) ||
          ids.some((id) => !id)
        )
          return fail(
            "removeEmbeds is only for mode 'edit': a list of embedded item ids from the note's {{kind:id}} placeholders, e.g. ['3fa9c1']",
          );
        removeEmbeds = Array.from(new Set(ids as string[]));
      }

      // Validate patches structure
      let patches: NotePatch[] | undefined;
      if (hasPatches) {
        patches = [];
        for (const entry of args.patches as unknown[]) {
          if (!validateObject<Record<string, unknown>>(entry)) {
            return fail(
              "Each patch must be an object with { find: string, replace: string }",
            );
          }
          if (typeof entry.find !== "string" || !entry.find) {
            return fail("Each patch must include a non-empty 'find' string");
          }
          if (typeof entry.replace !== "string") {
            return fail("Each patch must include a 'replace' string");
          }
          if (
            entry.findFormat !== undefined &&
            entry.findFormat !== "text" &&
            entry.findFormat !== "markdown"
          )
            return fail("findFormat must be text or markdown");
          patches.push({
            find: entry.find,
            replace: entry.replace,
            findFormat: entry.findFormat as NotePatch["findFormat"],
          });
        }
      }

      const target =
        args.target === "standalone" || (documentId && documentStandalone)
          ? ("standalone" as const)
          : ("item" as const);

      // Patches are resolved against a native snapshot before authorization.
      const rawContent = hasContent ? (args.content as string) : "";
      // Preserve the supplied format independently of the previous note's
      // styling. Preparation binds one sanitized payload before authorization.
      const contentHasHtml =
        hasContent &&
        rawContent.trimStart().startsWith("<") &&
        isLikelyHtmlNoteContent(rawContent);
      const content = hasContent ? normalizeNoteSourceText(rawContent) : "";

      return ok<NoteWriteInput>({
        mode,
        documentId,
        sourceMessageId,
        content,
        sourceNoteId,
        _rawHtmlContent: contentHasHtml ? rawContent.trim() : undefined,
        _patches: patches,
        removeEmbeds: removeEmbeds?.length ? removeEmbeds : undefined,
        _selection: selection as
          | { index: number; replacement: string }
          | undefined,
        target: mode === "create" ? target : undefined,
        targetItemId:
          mode === "create" || mode === "append"
            ? normalizePositiveInt(args.targetItemId)
            : undefined,
        // Also carried in edit mode now. It was stripped for every mode but
        // append, so editing any note other than the one already open was
        // impossible even though the parameter existed.
        targetNoteId:
          mode === "append" || mode === "edit"
            ? normalizePositiveInt(args.targetNoteId)
            : undefined,
        // Only meaningful when creating a standalone note; a child note
        // belongs to its parent item, not to a collection.
        collections:
          mode === "create"
            ? normalizePositiveIntArray(args.collections)
            : undefined,
      } as NoteWriteInput);
    },
    createPendingAction: (input, context) => {
      prepareNoteWriteInput(zoteroGateway, input, context);

      const normalizedContent = input._isHtml
        ? input.content
        : normalizeNoteSourceText(input.content);
      input.content = normalizedContent;

      if (input.mode === "create") {
        // Name the destination. The card previously promised "attaching it to
        // the paper" even when execute() would later rewrite the target to
        // standalone, so the user approved a statement that was not true.
        // Only name collections that actually resolve. Falling back to
        // "Collection 41" told the user their note was going somewhere real
        // when the id did not exist.
        const collectionLabels = (input.collections || [])
          .map((collectionId) => {
            const summary = zoteroGateway.getCollectionSummary(collectionId);
            return summary?.path || summary?.name || "";
          })
          .filter(Boolean);
        const filesIntoCollections =
          collectionLabels.length > 0 || Boolean(input.collections?.length);
        const description = filesIntoCollections
          ? `Review the note content before creating it in ${
              collectionLabels.length
                ? collectionLabels.join(", ")
                : "the requested collection"
            }.`
          : input.target === "standalone"
            ? "Review the note content before creating a standalone note."
            : "Review the note content before attaching it to the paper.";
        return {
          toolName: "note_write",
          mode: "review",
          title: "Review new note",
          description: `${description}${describeNewCitations(input)}`,
          confirmLabel: "Create note",
          cancelLabel: "Cancel",
          fields: [
            {
              type: "textarea",
              id: "content",
              label: "Final note content",
              value: normalizedContent,
              contentFormat: input._isHtml ? "html" : "markdown",
            },
          ],
        };
      }

      if (input.mode === "append") {
        const targetNote = resolveAppendNoteTarget(
          zoteroGateway,
          input,
          context,
        );
        const snapshot = readNoteSnapshot(targetNote);
        if (!snapshot) {
          throw new Error("Could not read the target note");
        }

        const appendText = input._isHtml
          ? normalizeNoteSourceText(input.content)
          : normalizedContent;

        return {
          toolName: "note_write",
          mode: "review",
          title: "Review note append",
          description: `Review the proposed content before appending it to "${input.noteTitle}".${describeNewCitations(input)}`,
          confirmLabel: "Append",
          cancelLabel: "Cancel",
          fields: [
            {
              type: "textarea",
              id: "content",
              label: "Content to append",
              value: input.content,
              contentFormat: input._isHtml ? "html" : "markdown",
            },
            {
              type: "diff_preview",
              id: "noteDiff",
              label: "Note changes",
              before: normalizeNoteSourceText(snapshot.html),
              after: buildAppendedNoteText(
                normalizeNoteSourceText(snapshot.html),
                appendText,
              ),
              contextLines: 0,
              emptyMessage: "No note changes yet.",
            },
          ],
        };
      }

      const snapshot = resolveEditSnapshot(zoteroGateway, input, context);
      if (!snapshot) {
        throw new Error(
          input.targetNoteId
            ? `Note ${input.targetNoteId} was not found, or is not a note.`
            : "No active note is available to edit. Pass targetNoteId to edit a specific note, or use mode 'create' with target 'item' when the user asks to write a new paper note.",
        );
      }

      // Diff preview always uses readable text, even for styled HTML notes
      const diffAfter = input._isHtml
        ? noteHtmlToModelText(input.content)
        : normalizedContent;
      // Count the copies the prepared edit actually deletes, not the ids it
      // names: an id may lose one copy of several, or none.
      const removed =
        input._patchedHtml === undefined
          ? []
          : findMissingNoteEmbeds(
              input.expectedOriginalHtml ?? snapshot.html,
              input._patchedHtml,
            );

      return {
        toolName: "note_write",
        mode: "review",
        title: `Review note update`,
        description: `Review the proposed note changes for "${input.noteTitle}" before applying them.${describeNewCitations(input)}${
          removed.length
            ? ` This edit deletes ${removed.length} embedded item${removed.length === 1 ? "" : "s"}: ${describeEmbeds(removed)}.`
            : ""
        }`,
        confirmLabel: "Apply edit",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "textarea",
            id: "content",
            label: "Final note content",
            value: input.content,
            contentFormat: input._isHtml ? "html" : "markdown",
          },
          {
            type: "diff_preview",
            id: "noteDiff",
            label: "Note changes",
            sourceFieldId: "content",
            before: noteHtmlToModelText(snapshot.html),
            after: diffAfter,
            contextLines: 0,
            emptyMessage: "No note changes yet.",
          },
        ],
      };
    },
    applyConfirmation: (input, resolutionData) => {
      if (!validateObject<Record<string, unknown>>(resolutionData)) {
        return ok(input);
      }
      const userEditedContent =
        typeof resolutionData.content === "string"
          ? input._isHtml
            ? sanitizeNoteHtml(resolutionData.content)
            : normalizeNoteSourceText(resolutionData.content)
          : input.content;
      // If the user modified the textarea, discard the pre-patched HTML
      // so execute() falls back to full-note rendering from the user's text.
      const patchedHtml =
        userEditedContent !== input.content ? undefined : input._patchedHtml;
      return ok({
        ...input,
        content: userEditedContent,
        _patchedHtml: patchedHtml,
      });
    },
    async planInvocation(input, context) {
      if (input.sourceMessageId && !input.content)
        input.content = await readAgentConversationAnswer(
          context.request.conversationKey,
          input.sourceMessageId,
        );
      await prepareWorkflowDocumentNote(input, context);
      prepareNoteWriteInput(zoteroGateway, input, context);
      const hasLocalImages =
        /!\[[^\]]*\]\(file:\/\/|<img\s+[^>]*src\s*=\s*"file:\/\//i.test(
          input.content,
        ) ||
        Boolean(
          input.sourceNoteId &&
          /\bdata-attachment-key\s*=/i.test(input.content),
        );
      return stateChangeInvocationPlan({
        effects: [input.mode === "create" ? "create" : "modify"],
        reversibility: hasLocalImages ? "partial" : "full",
        reason: hasLocalImages
          ? "The note pre-image is recoverable, but imported attachment side effects may require Zotero's trash cascade."
          : "The note pre-image is journalled before the validated update.",
      });
    },
    execute: async (input, context) => {
      await prepareWorkflowDocumentNote(input, context);
      prepareNoteWriteInput(zoteroGateway, input, context);
      if (input.documentId && input.mode === "create") {
        const documentId = input.documentId;
        const standalone = input.target === "standalone";
        const libraryID = context.request.libraryID!;
        return executeExternalMutation({
          context,
          toolName: "note_write",
          plan: {
            operation: "save_workflow_document",
            description: standalone
              ? "Save the exact finalized document as a standalone note"
              : "Attach the exact finalized summary to its paper",
            forward: {
              documentId,
              targetItemId: input.targetItemId,
              ...(standalone ? { collections: input.collections || [] } : {}),
              contentHash: input._documentMaterialRef?.contentHash,
            },
            reversibility: "full",
            deferredInverse: true,
          },
          execute: async () => {
            const saved = await savePlanDocumentAsNote(
              documentId,
              standalone
                ? {
                    standalone: true,
                    libraryID,
                    collectionIds: input.collections,
                  }
                : { parentItemId: input.targetItemId!, libraryID },
            );
            const note = zoteroGateway.getItem(saved.itemId)!;
            return {
              result: {
                noteId: saved.itemId,
                documentId,
                title: note.getNoteTitle(),
                status: saved.created ? "created" : "already_satisfied",
                ...(input.collections?.length
                  ? { collections: input.collections }
                  : {}),
                warnings: saved.warnings,
                noteVerification: saved.noteVerification,
              },
              effect: saved.created ? ("applied" as const) : ("none" as const),
              affectedCount: saved.created ? 1 : 0,
              inverse: saved.created
                ? {
                    version: 1 as const,
                    kind: "library_operations" as const,
                    operations: [
                      { type: "trash_items" as const, itemIds: [saved.itemId] },
                    ],
                  }
                : undefined,
              expectedPostcondition: {
                kind: "created_item" as const,
                itemId: saved.itemId,
                exists: true,
                parentItemId: standalone ? null : input.targetItemId!,
                htmlChecksum: await sha256Text(note.getNote()),
                ...(standalone
                  ? { collections: note.getCollections?.() || [] }
                  : {}),
              },
            };
          },
        });
      }
      const lookup = citationLookup(zoteroGateway, context.request.libraryID);
      const renderNewNoteHtml = (content: string) =>
        withCitationRegistry(
          renderContentWithEmbeds(content, input._isHtml, "", input, lookup),
          input,
        );
      const copyHasImages = Boolean(
        input.sourceNoteId && /\bdata-attachment-key\s*=/i.test(input.content),
      );
      const hasLocalImages =
        /!\[[^\]]*\]\(file:\/\/|<img\s+[^>]*src\s*=\s*"file:\/\//i.test(
          input.content,
        );

      if (input.mode === "create") {
        // Resolve every requested collection BEFORE the note is built.
        //
        // `addToCollection` does no existence check and never throws for a
        // valid integer; the failure surfaces later as a foreign-key
        // violation on the INSERT, inside the same transaction as the note
        // itself — so a wrong id did not just skip the filing, it destroyed
        // the generated note. The rest of the codebase already resolves
        // before mutating (see the gateway's "Collection not found").
        if (input.collections?.length) {
          const resolved: number[] = [];
          const unresolved: number[] = [];
          for (const collectionId of input.collections) {
            if (zoteroGateway.getCollectionSummary(collectionId)) {
              resolved.push(collectionId);
            } else {
              unresolved.push(collectionId);
            }
          }
          if (!resolved.length) {
            throw new Error(
              `No collection found for ID ${unresolved.join(", ")}. Resolve the name to an ID with library_search({ entity:'collections', mode:'list' }) and try again. The note was not created.`,
            );
          }
          input.collections = resolved;
        }
        // A collection destination is only satisfiable by a standalone note:
        // a child note belongs to its parent item and cannot be a collection
        // member. Asking for both is a request for a filed note, so honour
        // the collection rather than silently dropping it and attaching the
        // note to a paper the user never mentioned.
        if (input.collections?.length && input.target !== "standalone") {
          input.target = "standalone";
          input.targetItemId = undefined;
        }
        // Auto-fallback to standalone if no parent item is resolvable
        // (e.g. library chat mode with no active paper)
        let resolvedParentTarget: ReturnType<
          typeof resolveParentTargetForCreate
        > = null;
        if (input.target !== "standalone") {
          resolvedParentTarget = resolveParentTargetForCreate(
            zoteroGateway,
            input,
            context,
          );
          if (!resolvedParentTarget) {
            input.target = "standalone";
            input.targetItemId = undefined;
          } else {
            input.targetItemId = resolvedParentTarget.parentItem.id;
          }
        }

        const parent =
          input.target === "standalone"
            ? null
            : resolvedParentTarget?.parentItem;
        const libraryID = parent?.libraryID || context.request.libraryID;
        if (!libraryID)
          throw new Error("The destination library is unresolved");
        return executeNoteCreation({
          context,
          libraryID,
          parentItemId: parent?.id,
          collections:
            input.target === "standalone" ? input.collections : undefined,
          html: renderNewNoteHtml(input.content),
          finalize: copyHasImages
            ? async ({ noteId }) => {
                const source = getNoteItemById(
                  zoteroGateway,
                  input.sourceNoteId,
                )!;
                const note = zoteroGateway.getItem(noteId)!;
                await Zotero.DB.executeTransaction(async () => {
                  await Zotero.Notes.copyEmbeddedImages(source, note);
                });
                return note.getNote();
              }
            : hasLocalImages
              ? async ({ noteId, saveOptions }) => {
                  const content = await importLocalImagesIntoNote(
                    input.content,
                    noteId,
                    zoteroGateway,
                    saveOptions,
                  );
                  if (
                    /(?:src\s*=\s*["']file:|!\[[^\]]*\]\(file:)/i.test(content)
                  )
                    throw new Error("A requested image could not be embedded");
                  return renderNewNoteHtml(content);
                }
              : undefined,
        });
      }

      const targetNote =
        input.mode === "append"
          ? input.noteId
            ? getNoteItemById(zoteroGateway, input.noteId)
            : resolveAppendNoteTarget(zoteroGateway, input, context)
          : zoteroGateway.getItem(
              resolveEditSnapshot(zoteroGateway, input, context)?.noteId,
            );
      if (!targetNote)
        throw new Error("The exact destination note is unavailable");
      const originalHtml = input.expectedOriginalHtml || "";
      // The prepared edit HTML is exact; content the user changed in review,
      // or content with imported images, is rendered again the same way.
      const finishHtml = (html: string) =>
        input.mode === "edit"
          ? withCitationRegistry(finishEditHtml(html, originalHtml), input)
          : html;
      const render = (content: string) =>
        input.mode === "edit" && content === input.content && input._patchedHtml
          ? input._patchedHtml
          : finishHtml(
              renderContentWithEmbeds(
                content,
                input._isHtml,
                originalHtml,
                input,
                lookup,
              ),
            );
      const html = render(input.content);
      return executePreparedNoteChange({
        context,
        note: targetNote,
        mode: input.mode,
        html,
        expectedOriginalHtml: input.expectedOriginalHtml,
        // An append's new chips are registered in the combined note's root.
        citationItems:
          input.mode === "append" ? input._newCitations?.items : undefined,
        finalizeHtml:
          input.documentId && input._documentHasAssets
            ? async () => {
                const document = await resolveWorkflowNoteDocument(
                  context,
                  input.documentId!,
                  input._documentMaterialRef,
                );
                const finalized = await finalizeDocumentNoteHtml(document, {
                  noteId: targetNote.id,
                });
                if (finalized.warnings.length)
                  throw new Error(finalized.warnings.join("; "));
                const restored = restoreNoteEmbedTokensInHtml(
                  expandCitations(finalized.html, input, lookup),
                  embedRegistryFor(originalHtml, input),
                );
                assertKnownEmbedTokens(restored.unknown);
                return finishHtml(restored.html);
              }
            : hasLocalImages
              ? async () => {
                  const content = await importLocalImagesIntoNote(
                    input.content,
                    targetNote.id,
                    zoteroGateway,
                  );
                  return render(content);
                }
              : undefined,
      });
    },
  };
}
