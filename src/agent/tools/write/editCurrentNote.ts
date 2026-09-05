import type { ZoteroGateway } from "../../services/zoteroGateway";
import { LibraryMutationService } from "../../services/libraryMutationService";
import { executeExternalMutation } from "../../services/mutationCoordinator";
import {
  sha256Text,
  storeRecoveryText,
} from "../../store/journalRecoveryBlobStore";
import type { AgentToolContext, AgentWriteToolDefinition } from "../../types";
import {
  normalizeNoteSourceText,
  stripNoteHtml,
  renderRawNoteHtml,
  readNoteSnapshot,
  resolveParentItemForNoteTarget,
  type NoteSnapshot,
} from "../../../modules/contextPanel/notes";
import { importLocalImagesIntoNote } from "../../../modules/contextPanel/noteImages";
import {
  createFinalizedZoteroNote,
  persistVerifiedNoteHtml,
} from "../../../modules/contextPanel/notePersistence";
import { escapeNoteHtml } from "../../../modules/contextPanel/textUtils";
import {
  ok,
  fail,
  validateObject,
  normalizePositiveInt,
  normalizePositiveIntArray,
} from "../shared";
import { executeAndRecordUndo } from "./mutateLibraryShared";

type NotePatch = { find: string; replace: string };

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

/** Detect whether an HTML string contains inline `style=` attributes. */
function htmlHasInlineStyles(html: string): boolean {
  return /<[^>]+\bstyle\s*=/i.test(html);
}

type EditCurrentNoteInput = {
  mode: "edit" | "create" | "append";
  content: string;
  expectedOriginalHtml?: string;
  /** Pre-patched HTML computed by applying patches directly to the original
   *  note HTML.  When set, `execute()` uses this instead of round-tripping
   *  through `renderRawNoteHtml` to preserve images, list numbering, etc. */
  _patchedHtml?: string;
  /** True when the content is styled HTML that should bypass markdown
   *  normalisation and be written directly via `setNote()`. */
  _isHtml?: boolean;
  /** Raw HTML content from the LLM, kept until `createPendingAction` can
   *  verify that the source note is actually a styled template (edit mode)
   *  or accept it outright (create mode). */
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
 * Apply find-and-replace patches to a base text.
 * Each patch replaces the first occurrence of `find` with `replace`.
 * Returns the patched text.
 */
function applyPatches(base: string, patches: NotePatch[]): string {
  let result = base;
  for (const patch of patches) {
    const index = result.indexOf(patch.find);
    if (index >= 0) {
      result =
        result.slice(0, index) +
        patch.replace +
        result.slice(index + patch.find.length);
    }
  }
  return result;
}

/**
 * Render a replacement string as inline HTML.  Uses the full markdown
 * renderer but strips the outer `<p>` wrapper so the result can be
 * inserted into an existing HTML element.
 */
function renderReplacementAsInlineHtml(text: string): string {
  try {
    const rendered = renderRawNoteHtml(text);
    const match = rendered.match(/^<p>([\s\S]*)<\/p>\s*$/);
    if (match) return match[1];
    return escapeNoteHtml(text);
  } catch {
    return escapeNoteHtml(text);
  }
}

/**
 * Find plain text content within HTML (skipping tags and decoding common
 * entities) and replace it, preserving surrounding HTML structure.
 *
 * Returns the patched HTML, or `null` when the text cannot be located
 * (caller should fall back to full-note replacement).
 */
function replaceTextContentInHtml(
  html: string,
  find: string,
  replace: string,
): string | null {
  if (!find) return html;

  // Strategy 1: Direct match (no entities or inline tags in the way)
  const directIdx = html.indexOf(find);
  if (directIdx >= 0) {
    return (
      html.slice(0, directIdx) +
      escapeNoteHtml(replace) +
      html.slice(directIdx + find.length)
    );
  }

  // Strategy 2: Walk HTML character-by-character, building a text→HTML
  // position map that handles tags and common HTML entities.
  const textChars: string[] = [];
  // For each text character, record the HTML start and end positions
  // of the source token (a single char or an entity like &amp;).
  const htmlStarts: number[] = [];
  const htmlEnds: number[] = [];

  let i = 0;
  while (i < html.length) {
    if (html[i] === "<") {
      const tagEnd = html.indexOf(">", i);
      if (tagEnd < 0) break;
      i = tagEnd + 1;
      continue;
    }

    if (html[i] === "&") {
      const semiPos = html.indexOf(";", i);
      if (semiPos > i && semiPos - i <= 10) {
        const entity = html.slice(i, semiPos + 1);
        let decoded: string;
        switch (entity.toLowerCase()) {
          case "&amp;":
            decoded = "&";
            break;
          case "&lt;":
            decoded = "<";
            break;
          case "&gt;":
            decoded = ">";
            break;
          case "&nbsp;":
            decoded = " ";
            break;
          case "&quot;":
            decoded = '"';
            break;
          case "&apos;":
          case "&#39;":
            decoded = "'";
            break;
          default: {
            const numMatch = entity.match(/^&#(\d+);$/);
            if (numMatch) {
              decoded = String.fromCodePoint(parseInt(numMatch[1], 10));
            } else {
              const hexMatch = entity.match(/^&#x([0-9a-fA-F]+);$/i);
              decoded = hexMatch
                ? String.fromCodePoint(parseInt(hexMatch[1], 16))
                : entity;
            }
            break;
          }
        }
        for (const ch of decoded) {
          textChars.push(ch);
          htmlStarts.push(i);
          htmlEnds.push(semiPos + 1);
        }
        i = semiPos + 1;
        continue;
      }
    }

    textChars.push(html[i]);
    htmlStarts.push(i);
    htmlEnds.push(i + 1);
    i++;
  }

  const text = textChars.join("");
  const findIdx = text.indexOf(find);
  if (findIdx < 0) return null;

  const findEndIdx = findIdx + find.length;
  const htmlStart = htmlStarts[findIdx];
  const htmlEnd =
    findEndIdx <= htmlEnds.length ? htmlEnds[findEndIdx - 1] : html.length;

  return (
    html.slice(0, htmlStart) +
    renderReplacementAsInlineHtml(replace) +
    html.slice(htmlEnd)
  );
}

/**
 * Apply find-and-replace patches directly to the note's original HTML,
 * preserving images, list structure, and other formatting in blocks that
 * are not being edited.
 *
 * Returns the patched HTML, or `null` if any patch cannot be located
 * (the caller should fall back to full-note replacement via
 * `renderRawNoteHtml`).
 */
function applyPatchesToNoteHtml(
  html: string,
  patches: NotePatch[],
): string | null {
  if (!patches.length || !html) return html || null;

  let result = html;
  for (const patch of patches) {
    const applied = replaceTextContentInHtml(result, patch.find, patch.replace);
    if (applied === null) return null;
    result = applied;
  }
  return result;
}

function buildAppendedNoteHtml(
  existingHtml: string,
  appendHtml: string,
): string {
  const base = (existingHtml || "").trim();
  const addition = (appendHtml || "").trim();
  if (!base) return addition;
  if (!addition) return base;
  return `${base}<hr/>${addition}`;
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

export function createEditCurrentNoteTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<EditCurrentNoteInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);
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
          targetItemId: input.targetItemId,
          targetNoteId: input.targetNoteId || input.noteId,
          expectedText: input.content
            ? stripNoteHtml(renderRawNoteHtml(input.content))
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
          mode: {
            type: "string",
            enum: ["edit", "create", "append"],
            description:
              "Use 'edit' only when rewriting or patching an existing current note. Use 'append' to add content to an existing note. Use 'create' to create a brand-new attached or standalone note.",
          },
          content: {
            type: "string",
            description:
              "The full note body as plain text or Markdown. Use this OR patches, not both. Required for mode 'create'.",
          },
          patches: {
            type: "array",
            items: {
              type: "object",
              properties: {
                find: {
                  type: "string",
                  description:
                    "The exact text in the current note to find (must match verbatim).",
                },
                replace: {
                  type: "string",
                  description: "The replacement text.",
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
      mutability: "write",
      requiresConfirmation: true,
    },
    guidance: {
      matches: () => true,
      instruction:
        "When a Zotero note is already open/current and the user asks to edit, rewrite, revise, polish, or update that note, call `edit_current_note` with mode 'edit'. NEVER output note text directly in chat. " +
        "For edits, PREFER `patches` (find-and-replace pairs) over `content` (full rewrite). " +
        "When the user asks to append/add content to an existing note, call `edit_current_note` with mode 'append' and `content`; pass `targetNoteId` when the destination note is known. " +
        "When the user asks to create/write/save a new item note, call `edit_current_note` with mode 'create', target 'item', and `content`; create means a brand-new child note, not appending to the response-save note. " +
        "For standalone notes, call `edit_current_note` with mode 'create', target 'standalone', and `content`. " +
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
          return title ? `Note saved: ${title}` : "Note saved";
        },
      },
    },
    shouldRequireConfirmation: async (input: EditCurrentNoteInput) => {
      // Create mode: write directly, no confirmation needed
      if (input.mode === "create") return false;
      // Edit mode: always show diff preview for user review
      return true;
    },
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

      // Parse patches if provided
      const hasPatches = Array.isArray(args.patches) && args.patches.length > 0;
      const hasContent =
        typeof args.content === "string" && args.content.trim();

      if (mode === "create" || mode === "append") {
        if (!hasContent) {
          return fail(
            `content is required for mode '${mode}': provide the note body as a string`,
          );
        }
      } else if (!hasContent && !hasPatches) {
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
          patches.push({ find: entry.find, replace: entry.replace });
        }
      }

      const target =
        args.target === "standalone"
          ? ("standalone" as const)
          : ("item" as const);

      // For patches mode, content will be resolved in createPendingAction
      // using the current note snapshot + patches
      const rawContent = hasContent ? (args.content as string) : "";
      // Always normalise content.  If the LLM produced styled HTML, keep the
      // raw version aside — createPendingAction will decide whether to use it
      // based on whether the *source* note is a styled template (edit mode)
      // or accept it outright (create mode).
      const contentHasStyledHtml =
        hasContent && htmlHasInlineStyles(rawContent);
      const content = hasContent ? normalizeNoteSourceText(rawContent) : "";

      return ok<EditCurrentNoteInput & { _patches?: NotePatch[] }>({
        mode,
        content,
        _rawHtmlContent: contentHasStyledHtml ? rawContent.trim() : undefined,
        _patches: patches,
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
      // Resolve patches into full content if needed
      const inputExt = input as EditCurrentNoteInput & {
        _patches?: NotePatch[];
      };
      if (inputExt._patches && input.mode === "edit") {
        const snapshot = resolveEditSnapshot(zoteroGateway, input, context);
        if (!snapshot) {
          throw new Error(
            "No active note is available to edit. Use mode 'create' with target 'item' when the user asks to write or save a new paper note.",
          );
        }
        // Apply patches to the plain text representation for the diff preview.
        const patched = applyPatches(snapshot.text, inputExt._patches);
        input.content = normalizeNoteSourceText(patched);

        // Also apply patches directly to the original HTML so that images,
        // list numbering, and other structure are preserved when executing.
        const patchedHtml = applyPatchesToNoteHtml(
          snapshot.html,
          inputExt._patches,
        );
        if (patchedHtml) {
          input._patchedHtml = patchedHtml;
        }
        delete inputExt._patches;
      }

      // Resolve styled create/append input on both reviewed and direct paths.
      resolveCreateOrAppendContent(input);

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
        input.expectedOriginalHtml = snapshot.html;
        input.noteId = snapshot.noteId;
        input.noteTitle = snapshot.title || "Untitled note";

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
              type: "diff_preview",
              id: "noteDiff",
              label: "Note changes",
              before: snapshot.text,
              after: buildAppendedNoteText(snapshot.text, appendText),
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

      // --- Resolve _isHtml for edit mode: only activate when the source
      //     note itself is a styled template (has inline style= attributes). ---
      if (input._rawHtmlContent && htmlHasInlineStyles(snapshot.html)) {
        input._isHtml = true;
        input.content = sanitizeNoteHtml(input._rawHtmlContent);
      }
      delete input._rawHtmlContent;

      input.expectedOriginalHtml = snapshot.html;
      input.noteId = snapshot.noteId;
      input.noteTitle = snapshot.title || "Untitled note";

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
            type: "diff_preview",
            id: "noteDiff",
            label: "Note changes",
            before: snapshot.text,
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
    planMutation(input) {
      const hasLocalImages =
        /!\[[^\]]*\]\(file:\/\/|<img\s+[^>]*src\s*=\s*"file:\/\//i.test(
          input.content,
        );
      return {
        effect: "write",
        reversibility: hasLocalImages ? "partial" : "full",
        reason: hasLocalImages
          ? "The note pre-image is recoverable, but imported attachment side effects may require Zotero's trash cascade."
          : undefined,
        // Edit/append review also resolves patch inputs against the current
        // note and binds the expected pre-image. Skipping that review would
        // execute an unresolved patch as an empty replacement.
        requiresConfirmation: input.mode !== "create",
      };
    },
    execute: async (input, context) => {
      resolveCreateOrAppendContent(input);
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

        if (!hasLocalImages && !input._isHtml) {
          // No images, no styled HTML — use the standard mutation service path
          const execution = await executeAndRecordUndo(
            mutationService,
            {
              type: "save_note",
              content: input.content,
              target: input.target,
              targetItemId: input.targetItemId,
              appendToTrackedNote: false,
              collections: input.collections,
            },
            context,
            "edit_current_note",
          );
          return {
            content: execution.content.result,
            effect: execution.effect,
          };
        }

        // Has local images — create note manually to get the note ID,
        // then import images and update note HTML
        const parentItem =
          input.target === "standalone"
            ? null
            : (
                resolvedParentTarget ||
                resolveParentTargetForCreate(zoteroGateway, input, context)
              )?.parentItem || null;
        const parentId = parentItem?.id;
        const libraryID =
          parentItem?.libraryID || context.request.libraryID || 1;

        return executeExternalMutation({
          context,
          toolName: "note_write",
          plan: {
            operation: "create_note_with_assets",
            description: "Create a Zotero note with embedded assets",
            forward: {
              target: input.target,
              targetItemId: parentId,
              collections: input.collections,
            },
            reversibility: "partial",
            deferredInverse: true,
            reason:
              "The note ID and any embedded attachment IDs are assigned during creation.",
          },
          execute: async () => {
            // Persist useful text before importing images that require a note
            // ID. Notifications remain queued until final HTML is verified.
            const note = new Zotero.Item("note");
            note.libraryID = libraryID;
            if (parentId && input.target !== "standalone") {
              note.parentID = parentId;
            }
            // File the note in the same save as its body. This branch runs for
            // notes containing images -- the figure-note case this plugin
            // specialises in -- and without this a note with a figure silently
            // lost the collection the user asked for, while an identical note
            // without one landed correctly.
            const filedCollections: number[] = [];
            if (input.target === "standalone") {
              for (const collectionId of input.collections || []) {
                if (!Number.isFinite(collectionId) || collectionId <= 0)
                  continue;
                try {
                  note.addToCollection(Math.floor(collectionId));
                  filedCollections.push(Math.floor(collectionId));
                } catch (error) {
                  Zotero.debug?.(
                    `[llm-for-zotero] Could not file note into collection ${collectionId}: ${
                      error instanceof Error
                        ? error.message
                        : String(error || "")
                    }`,
                  );
                }
              }
            }
            const initialHtml = input._isHtml
              ? sanitizeNoteHtml(input.content)
              : renderRawNoteHtml(input.content);
            const persisted = await createFinalizedZoteroNote({
              note,
              initialHtml,
              finalize: hasLocalImages
                ? async ({ noteId, saveOptions }) => {
                    const finalContent = await importLocalImagesIntoNote(
                      input.content,
                      noteId,
                      zoteroGateway,
                      saveOptions,
                    );
                    const html = input._isHtml
                      ? sanitizeNoteHtml(finalContent)
                      : renderRawNoteHtml(finalContent);
                    const warnings =
                      /(?:src\s*=\s*["']file:|!\[[^\]]*\]\(file:)/i.test(
                        finalContent,
                      )
                        ? ["One or more local images could not be embedded"]
                        : [];
                    return { html, warnings };
                  }
                : undefined,
              log: (message, error) => {
                Zotero.debug?.(
                  `[llm-for-zotero] ${message}: ${
                    error instanceof Error ? error.message : String(error || "")
                  }`,
                );
              },
            });
            const noteId = persisted.noteId;
            if (persisted.warnings.length) {
              Zotero.debug?.(
                `[llm-for-zotero] Note ${noteId} created with warnings: ${persisted.warnings.join(
                  "; ",
                )}`,
              );
            }

            const result = {
              status: "created",
              collections: filedCollections.length
                ? filedCollections
                : undefined,
              noteId,
              title: String(note.getField?.("title") || ""),
              ...(persisted.createdNoteReceipt
                ? { createdNoteReceipt: persisted.createdNoteReceipt }
                : {}),
              ...(persisted.warnings.length
                ? { warnings: persisted.warnings }
                : {}),
            };
            return {
              result,
              inverse: {
                version: 1,
                kind: "library_operations",
                operations: [{ type: "trash_items", itemIds: [noteId] }],
              },
              expectedPostcondition: {
                kind: "created_item",
                itemId: noteId,
                exists: true,
                parentItemId: parentId || null,
                htmlChecksum: await sha256Text(note.getNote?.() || ""),
                collections: filedCollections,
              },
              reversibility: hasLocalImages
                ? ("partial" as const)
                : ("full" as const),
              reason: hasLocalImages
                ? "The note itself is recoverable; embedded attachment creation is covered by Zotero's note trash cascade."
                : undefined,
              affectedCount: 1,
              effect: "applied",
            };
          },
        });
      }

      if (input.mode === "append") {
        let preparedAppend: {
          targetNote: Zotero.Item;
          snapshot: NoteSnapshot;
        } | null = null;

        return executeExternalMutation({
          context,
          toolName: "note_write",
          plan: async () => {
            const targetNote = input.noteId
              ? getNoteItemById(zoteroGateway, input.noteId)
              : resolveAppendNoteTarget(zoteroGateway, input, context);
            const snapshot = readNoteSnapshot(targetNote);
            if (!targetNote || !snapshot) {
              throw new Error("Could not read the target note");
            }
            if (
              typeof input.expectedOriginalHtml === "string" &&
              stripNoteHtml(snapshot.html) !==
                stripNoteHtml(input.expectedOriginalHtml)
            ) {
              throw new Error(
                "The target note changed before this append was applied. Refresh and try again.",
              );
            }
            preparedAppend = { targetNote, snapshot };
            return {
              operation: "append_note_html",
              description: `Append to note: ${snapshot.title}`,
              forward: { noteId: snapshot.noteId },
              inverse: {
                version: 1,
                kind: "note_html",
                noteId: snapshot.noteId,
                payload: await storeRecoveryText(snapshot.html),
              },
              precondition: {
                kind: "note_html",
                noteId: snapshot.noteId,
                checksum: await sha256Text(snapshot.html),
              },
              reversibility: hasLocalImages
                ? ("partial" as const)
                : ("full" as const),
              reason: hasLocalImages
                ? "Imported image attachments may remain if note restoration cannot cascade them."
                : undefined,
            };
          },
          execute: async () => {
            if (!preparedAppend) {
              throw new Error("The append pre-image was not prepared");
            }
            const { targetNote, snapshot } = preparedAppend;
            let contentToAppend = input.content;
            if (hasLocalImages) {
              try {
                contentToAppend = await importLocalImagesIntoNote(
                  input.content,
                  snapshot.noteId,
                  zoteroGateway,
                );
              } catch (e) {
                Zotero.debug?.(`[llm-for-zotero] Image import failed: ${e}`);
              }
            }

            const appendHtml = input._isHtml
              ? sanitizeNoteHtml(contentToAppend)
              : renderRawNoteHtml(contentToAppend);
            const nextHtml = buildAppendedNoteHtml(snapshot.html, appendHtml);
            await persistVerifiedNoteHtml(targetNote, nextHtml);

            const appendedText = normalizeNoteSourceText(contentToAppend);
            return {
              result: {
                status: "appended",
                noteId: snapshot.noteId,
                title: snapshot.title,
                noteText: buildAppendedNoteText(snapshot.text, appendedText),
              },
              expectedPostcondition: {
                kind: "note_html",
                noteId: snapshot.noteId,
                // persistVerifiedNoteHtml reloads from Zotero before it
                // returns. Guard the representation Zotero actually stored,
                // including its optional note wrapper, so an immediate undo
                // cannot conflict with our own successful write.
                checksum: await sha256Text(targetNote.getNote?.() || nextHtml),
              },
              reversibility: hasLocalImages
                ? ("partial" as const)
                : ("full" as const),
              affectedCount: 1,
              effect: "applied",
            };
          },
        });
      }

      let editSnapshot: NonNullable<
        ReturnType<typeof resolveEditSnapshot>
      > | null = null;
      return executeExternalMutation({
        context,
        toolName: "note_write",
        plan: async () => {
          const snapshot = resolveEditSnapshot(zoteroGateway, input, context);
          if (!snapshot) {
            throw new Error(
              input.targetNoteId || input.noteId
                ? `Note ${input.targetNoteId || input.noteId} was not found, or is not a note.`
                : "No active note is available to edit.",
            );
          }
          editSnapshot = snapshot;
          return {
            operation: "replace_note_html",
            description: "Replace Zotero note content",
            forward: { noteId: snapshot.noteId },
            inverse: {
              version: 1,
              kind: "note_html",
              noteId: snapshot.noteId,
              payload: await storeRecoveryText(snapshot.html),
            },
            precondition: {
              kind: "note_html",
              noteId: snapshot.noteId,
              checksum: await sha256Text(snapshot.html),
            },
            reversibility: hasLocalImages
              ? ("partial" as const)
              : ("full" as const),
            reason: hasLocalImages
              ? "Imported image attachments may remain after HTML restoration."
              : undefined,
          };
        },
        execute: async () => {
          if (!editSnapshot) {
            throw new Error("The note edit pre-image was not prepared");
          }
          // For edit mode, import images before saving.
          let contentToSave = input.content;
          if (hasLocalImages && input.noteId) {
            try {
              contentToSave = await importLocalImagesIntoNote(
                input.content,
                input.noteId,
                zoteroGateway,
              );
            } catch (e) {
              Zotero.debug?.(`[llm-for-zotero] Image import failed: ${e}`);
            }
          }

          const result = await zoteroGateway.replaceCurrentNote({
            request: context.request,
            item: context.item,
            noteId: input.targetNoteId,
            content: contentToSave,
            expectedOriginalHtml: input.expectedOriginalHtml,
            preRenderedHtml: input._isHtml
              ? sanitizeNoteHtml(contentToSave)
              : input._patchedHtml,
          });
          const current =
            typeof zoteroGateway.getItem === "function"
              ? zoteroGateway.getItem(result.noteId)
              : null;
          const renderedNextHtml = input._isHtml
            ? sanitizeNoteHtml(contentToSave)
            : input._patchedHtml || renderRawNoteHtml(contentToSave);
          return {
            result: {
              status: "updated",
              noteId: result.noteId,
              title: result.title,
              noteText: result.nextText,
            },
            expectedPostcondition: {
              kind: "note_html",
              noteId: result.noteId,
              checksum: await sha256Text(
                current?.getNote?.() || renderedNextHtml,
              ),
            },
            reversibility: hasLocalImages
              ? ("partial" as const)
              : ("full" as const),
            affectedCount: 1,
            effect: "applied",
          };
        },
      });
    },
  };
}
