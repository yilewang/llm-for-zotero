import { executeNoteCreation } from "../../services/noteCreation";
import { executePreparedNoteChange } from "./preparedNoteChange";
import { importLocalImagesIntoNote } from "../../../modules/contextPanel/noteImages";
import {
  isLikelyHtmlNoteContent,
  normalizeNoteSourceText,
  readNoteSnapshot,
  renderRawNoteHtml,
  resolveParentItemForNoteTarget,
  stripNoteHtml,
  type NoteSnapshot,
} from "../../../modules/contextPanel/notes";
import {
  replaceTextContentInHtml,
  replaceNoteSelectionHtml,
} from "../../../utils/noteEdit";
import { synthesizeSelectedTextContexts } from "../../../modules/contextPanel/normalizers";
import { noteHtmlMatches } from "../../../utils/noteHtml";
import { stateChangeInvocationPlan } from "../../authorization/invocationPlan";
import {
  savePlanDocumentAsNote,
  finalizeDocumentNoteHtml,
} from "../../documents/actions";
import { resolveWorkflowNoteDocument } from "../../documents/workflowMaterial";
import { executeExternalMutation } from "../../services/externalMutationCoordinator";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  sha256Text,
  storeRecoveryText,
} from "../../store/journalRecoveryBlobStore";
import type { AgentToolContext, AgentWriteToolDefinition } from "../../types";
import {
  fail,
  normalizePositiveInt,
  normalizePositiveIntArray,
  ok,
  validateObject,
} from "../shared";
import {
  buildNoteChangeResultCards,
  resolveVerifiedNoteEditCompletion,
} from "./noteChangePresentation";
import { buildSavedNoteResultCards } from "./noteResultPresentation";

type NotePatch = {
  find: string;
  replace: string;
  findFormat?: "text" | "markdown";
};

export const SOURCE_NOTE_COPY_GUIDANCE =
  "To copy an existing note without revising its content, use mode:'create' with sourceNoteId and the requested target/collections instead of reconstructing its content. This preserves the native note, including formatting, original provenance and embedded images; do not generate a new header or perform a corrective edit.";

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

type EditCurrentNoteInput = {
  documentId?: string;
  _documentContentHash?: string;
  _documentHasAssets?: boolean;
  mode: "edit" | "create" | "append";
  content: string;
  sourceNoteId?: number;
  _sourceOriginalHtml?: string;
  expectedOriginalHtml?: string;
  _patches?: NotePatch[];
  _selection?: { index: number; replacement: string };
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

function resolveCreateOrAppendContent(input: EditCurrentNoteInput): void {
  if (input.mode !== "create" && input.mode !== "append") return;
  if (input._rawHtmlContent) {
    input._isHtml = true;
    input.content = sanitizeNoteHtml(input._rawHtmlContent);
    delete input._rawHtmlContent;
  }
  input.content = input._isHtml
    ? sanitizeNoteHtml(input.content)
    : normalizeNoteSourceText(input.content);
}

function resolveEditSnapshot(
  zoteroGateway: ZoteroGateway,
  input: EditCurrentNoteInput,
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
 * Returns the patched HTML, or `null` if any patch cannot be located.
 * A missing match must stop the write, never rewrite the whole note.
 */
function applyPatchesToNoteHtml(
  html: string,
  patches: NotePatch[],
): string | null {
  if (!patches.length || !html) return html || null;

  let result = html;
  for (const patch of patches) {
    const find =
      patch.findFormat === "markdown"
        ? stripNoteHtml(renderRawNoteHtml(patch.find))
        : patch.find;
    const applied = replaceTextContentInHtml(result, find, patch.replace);
    if (applied === null) return null;
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
  input: Pick<EditCurrentNoteInput, "targetItemId">,
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
  input: Pick<EditCurrentNoteInput, "targetItemId" | "targetNoteId">,
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
  input: EditCurrentNoteInput,
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
      const replacementHtml = sanitizeNoteHtml(
        renderRawNoteHtml(input._selection.replacement),
      );
      const patched = replaceNoteSelectionHtml(
        snapshot.html,
        selected.text,
        replacementHtml,
      );
      if (patched === null)
        throw new Error(
          "The selected text is missing or occurs more than once in the current note. Select a unique passage before retrying; no content was changed.",
        );
      input._patchedHtml = patched;
      input.content = normalizeNoteSourceText(patched);
      delete input._selection;
    }
    if (input._patches) {
      const patchedHtml = applyPatchesToNoteHtml(snapshot.html, input._patches);
      if (patchedHtml === null) {
        throw new Error(
          "Note patch text was not found. No content was changed; read the current note before retrying.",
        );
      }
      input._patchedHtml = patchedHtml;
      input.content = normalizeNoteSourceText(patchedHtml);
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
  }
  input.expectedOriginalHtml = snapshot.html;
  input.noteId = snapshot.noteId;
  input.noteTitle = snapshot.title || "Untitled note";
}

async function prepareWorkflowDocumentNote(
  input: EditCurrentNoteInput,
  context: AgentToolContext,
): Promise<void> {
  if (!input.documentId) return;
  const document = await resolveWorkflowNoteDocument(
    context.request,
    input.documentId,
    input.mode === "create"
      ? input.targetItemId
      : input.targetNoteId || input.noteId,
    input.mode,
  );
  if (input.content && input.content !== document.visibleHtml)
    throw new Error(
      "The reviewed content differs from the finalized document; revise the document before saving it.",
    );
  input.content = document.visibleHtml;
  input._isHtml = true;
  input._documentContentHash = document.contentHash;
  input._documentHasAssets = document.assets.length > 0;
}

export function createEditCurrentNoteTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<EditCurrentNoteInput, unknown> {
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
          contentHash: input._documentContentHash,
          targetItemId: input.targetItemId,
          targetNoteId: input.targetNoteId || input.noteId,
          expectedText: input.content
            ? stripNoteHtml(
                input._isHtml
                  ? sanitizeNoteHtml(input.content)
                  : input._patchedHtml || renderRawNoteHtml(input.content),
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
    spec: {
      name: "edit_current_note",
      description:
        "Edit the current open Zotero note, append to an existing note, or create a new note attached to a paper or as a standalone note. Accepts plain text, Markdown, or HTML with inline styles.",
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
                    "The replacement visible text (plain text, without Markdown formatting markers).",
                },
              },
              required: ["find", "replace"],
              additionalProperties: false,
            },
            description:
              "For mode 'edit': find-and-replace patches applied to the current note. Much faster than rewriting the full content. Each patch replaces the first occurrence of 'find' with 'replace'.",
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
      requiresConfirmation: true,
    },
    guidance: {
      matches: () => true,
      instruction:
        "When a Zotero note is already open/current and the user asks to edit, rewrite, revise, polish, or update that note, call `edit_current_note` with mode 'edit'. NEVER output note text directly in chat. " +
        "For a selected passage, use selection:{index:<Selected text number>,replacement:<final Markdown>}; the host handles range, structure, persistence and verification. Use patches only for precise edits without a bound selection; content replaces the whole note. " +
        "When the user asks to append/add content to an existing note, call `edit_current_note` with mode 'append' and `content`; pass `targetNoteId` when the destination note is known. " +
        "When the user asks to create/write/save a new item note, call `edit_current_note` with mode 'create', target 'item', and `content`; create means a brand-new child note, not appending to the response-save note. " +
        "For finalized workflow material, call `note_write` with documentId returned by submit_document and omit content. Use mode:create with exact parent targetItemId, or mode:edit/append with exact targetNoteId. For standalone notes, call `edit_current_note` with mode 'create', target 'standalone', and `content`. " +
        SOURCE_NOTE_COPY_GUIDANCE +
        " " +
        "Requested new notes are created directly; the UI shows the saved content and a link to the native note after verification. Do not ask the user to approve a new-note draft or repeat the full saved note in your completion message. Auto applies edits and appends directly, then displays the verified diff; explicit review and Safe wait on the note card first. " +
        "Pass Markdown by default. When the user explicitly requests HTML output (e.g. for styled note templates), pass well-formed HTML with inline styles directly. " +
        "When the note discusses a specific figure, first use `paper_read({ mode:'figures' })` and embed the extracted PDF crop path: `![Figure N](file:///{path})` — auto-imported as a Zotero attachment. " +
        "Treat paper_read mode:'figures' as the authority for figure crop cache reuse/regeneration; use returned crop paths as-is and do not inspect or validate `figure_crops` metadata before writing. " +
        "When the note discusses a table, use `paper_read({ mode:'targeted' })` for the table text and surrounding discussion instead of the figure-crop extractor. " +
        "If paper_read mode:'figures' returns no_figures, mineru_required, error, zero figures, or no image artifact, switch to text-only mode when the user asked for a note: do not include figure images, rendered PDF page screenshots, MinerU source images, or extracted-image placeholders; explicitly state that figure extraction failed or no extracted crops are available, and that explanations are based on captions, figure legends, and surrounding paper text. " +
        "Do not embed MinerU source image paths for figure notes. " +
        "User-provided image inputs are unaffected. " +
        "Text-only models may still copy/embed extracted crop paths into notes when crops are available, but must not make unsupported visual claims beyond caption and surrounding-text evidence.",
    },
    presentation: {
      label: "Edit / Create / Append Note",
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
    resolveTerminalResult: (input, result, context) =>
      input.mode === "edit"
        ? resolveVerifiedNoteEditCompletion(result, context)
        : null,
    acceptInheritedApproval: async (_input, approval) => {
      // Accept review-mode approvals from search_literature_online review cards
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
      const documentId =
        typeof args.documentId === "string"
          ? args.documentId.trim()
          : undefined;
      if (
        args.documentId !== undefined &&
        (!documentId ||
          hasContent ||
          hasPatches ||
          sourceNoteId ||
          args.target === "standalone" ||
          !(mode === "create"
            ? normalizePositiveInt(args.targetItemId)
            : normalizePositiveInt(args.targetNoteId)) ||
          args.collections !== undefined)
      )
        return fail(
          "documentId requires the exact parent targetItemId for create, or targetNoteId for edit/append, without substituted content, patches, or collections.",
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
        if (!hasContent && !sourceNoteId && !documentId) {
          return fail(
            `content is required for mode '${mode}': provide the note body as a string`,
          );
        }
      } else if (!hasContent && !hasPatches && !documentId && !selection) {
        return fail(
          "Either 'content' (full note text) or 'patches' (find-and-replace pairs) is required for mode 'edit'",
        );
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
        args.target === "standalone"
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

      return ok<EditCurrentNoteInput>({
        mode,
        documentId,
        content,
        sourceNoteId,
        _rawHtmlContent: contentHasHtml ? rawContent.trim() : undefined,
        _patches: patches,
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
      } as EditCurrentNoteInput);
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
          toolName: "edit_current_note",
          mode: "review",
          title: "Review new note",
          description,
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
          toolName: "edit_current_note",
          mode: "review",
          title: "Review note append",
          description: `Review the proposed content before appending it to "${input.noteTitle}".`,
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
        ? normalizeNoteSourceText(input.content)
        : normalizedContent;

      return {
        toolName: "edit_current_note",
        mode: "review",
        title: `Review note update`,
        description: `Review the proposed note changes for "${input.noteTitle}" before applying them.`,
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
            before: normalizeNoteSourceText(snapshot.html),
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
        return executeExternalMutation({
          context,
          toolName: "note_write",
          plan: {
            operation: "save_workflow_document",
            description: "Attach the exact finalized summary to its paper",
            forward: {
              documentId,
              targetItemId: input.targetItemId,
              contentHash: input._documentContentHash,
            },
            reversibility: "full",
            deferredInverse: true,
          },
          execute: async () => {
            const saved = await savePlanDocumentAsNote(documentId, {
              parentItemId: input.targetItemId!,
              libraryID: context.request.libraryID!,
            });
            const note = zoteroGateway.getItem(saved.itemId)!;
            return {
              result: {
                noteId: saved.itemId,
                documentId,
                title: note.getNoteTitle(),
                status: saved.created ? "created" : "already_satisfied",
                warnings: saved.warnings,
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
                parentItemId: input.targetItemId!,
                htmlChecksum: await sha256Text(note.getNote()),
              },
            };
          },
        });
      }
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
          html: input._isHtml
            ? sanitizeNoteHtml(input.content)
            : renderRawNoteHtml(input.content),
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
                  return input._isHtml
                    ? sanitizeNoteHtml(content)
                    : renderRawNoteHtml(content);
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
      const render = (content: string) =>
        input._isHtml
          ? sanitizeNoteHtml(content)
          : input._patchedHtml || renderRawNoteHtml(content);
      return executePreparedNoteChange({
        context,
        note: targetNote,
        mode: input.mode,
        html: render(input.content),
        expectedOriginalHtml: input.expectedOriginalHtml,
        finalizeHtml:
          input.documentId && input._documentHasAssets
            ? async () => {
                const document = await resolveWorkflowNoteDocument(
                  context.request,
                  input.documentId!,
                  targetNote.id,
                  input.mode,
                );
                const finalized = await finalizeDocumentNoteHtml(document, {
                  noteId: targetNote.id,
                });
                if (finalized.warnings.length)
                  throw new Error(finalized.warnings.join("; "));
                return finalized.html;
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
