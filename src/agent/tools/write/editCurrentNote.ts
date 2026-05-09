import type { ZoteroGateway } from "../../services/zoteroGateway";
import { LibraryMutationService } from "../../services/libraryMutationService";
import { pushUndoEntry } from "../../store/undoStore";
import type { AgentToolDefinition } from "../../types";
import {
  normalizeNoteSourceText,
  stripNoteHtml,
  renderRawNoteHtml,
} from "../../../modules/contextPanel/notes";
import { rememberAssistantNoteForParent } from "../../../modules/contextPanel/prefHelpers";
import { escapeNoteHtml } from "../../../modules/contextPanel/textUtils";
import { fileUrlToPath } from "../../../utils/localPath";
import { ok, fail, validateObject, normalizePositiveInt } from "../shared";
import { executeAndRecordUndo } from "./mutateLibraryShared";

/**
 * Scan note content for local file image references (![alt](file:///path) or
 * <img src="file:///path" />) and import them as Zotero embedded note images.
 * Returns the content with references replaced by data-attachment-key img tags.
 */
async function importLocalImages(
  content: string,
  noteItemId: number,
  zoteroGateway: ZoteroGateway,
): Promise<string> {
  // Match both markdown ![alt](file://...) and HTML <img src="file://..." />
  const markdownPattern = /!\[([^\]]*)\]\((file:\/\/\/?[^)]+)\)/g;
  const htmlPattern = /<img\s+[^>]*src\s*=\s*"(file:\/\/\/?[^"]+)"[^>]*\/?>/gi;

  let result = content;

  // Process markdown images
  const mdMatches = [...content.matchAll(markdownPattern)];
  for (const match of mdMatches) {
    const fullMatch = match[0];
    const alt = match[1];
    const filePath = fileUrlToPath(match[2]);
    if (!filePath) continue;
    try {
      const imported = await zoteroGateway.importNoteImage({
        imagePath: filePath,
        noteItemId,
      });
      if (imported?.key) {
        result = result.replace(
          fullMatch,
          `<img data-attachment-key="${imported.key}" alt="${alt}" />`,
        );
      }
    } catch {
      // Leave original reference if import fails
    }
  }

  // Process HTML img tags with file:// src
  const htmlMatches = [...result.matchAll(htmlPattern)];
  for (const match of htmlMatches) {
    const fullMatch = match[0];
    const filePath = fileUrlToPath(match[1]);
    if (!filePath) continue;
    const altMatch = fullMatch.match(/alt\s*=\s*"([^"]*)"/i);
    const alt = altMatch?.[1] || "";
    try {
      const imported = await zoteroGateway.importNoteImage({
        imagePath: filePath,
        noteItemId,
      });
      if (imported?.key) {
        result = result.replace(
          fullMatch,
          `<img data-attachment-key="${imported.key}" alt="${alt}" />`,
        );
      }
    } catch {
      // Leave original reference if import fails
    }
  }

  return result;
}

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
  mode: "edit" | "create";
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
};

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

export function createEditCurrentNoteTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<EditCurrentNoteInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);
  return {
    spec: {
      name: "edit_current_note",
      description:
        "Edit the current open Zotero note, or create a new note attached to a paper or as a standalone note. Accepts plain text, Markdown, or HTML with inline styles.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: {
            type: "string",
            enum: ["edit", "create"],
            description:
              "Use 'edit' to replace the current open note (default), or 'create' to create a new note.",
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
              "For mode 'create': attach note to this specific item ID. If omitted, attaches to the active item.",
          },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },
    guidance: {
      matches: () => true,
      instruction:
        "When a note is open and the user asks to edit, rewrite, revise, polish, or update ANY text, call `edit_current_note` with mode 'edit'. NEVER output note text directly in chat. " +
        "For edits, PREFER `patches` (find-and-replace pairs) over `content` (full rewrite). " +
        "To create a new note, call `edit_current_note` with mode 'create' and `content`. " +
        "Pass Markdown by default. When the user explicitly requests HTML output (e.g. for styled note templates), pass well-formed HTML with inline styles directly. " +
        "When the note discusses a specific figure or table you previously read via file_io, embed the image: `![Figure N](file:///{path})` — auto-imported as a Zotero attachment.",
    },
    presentation: {
      label: "Edit / Create Note",
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
        args.mode === "create" ? ("create" as const) : ("edit" as const);

      // Parse patches if provided
      const hasPatches = Array.isArray(args.patches) && args.patches.length > 0;
      const hasContent =
        typeof args.content === "string" && args.content.trim();

      if (mode === "create") {
        if (!hasContent) {
          return fail(
            "content is required for mode 'create': provide the note body as a string",
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
          mode === "create"
            ? normalizePositiveInt(args.targetItemId)
            : undefined,
      } as EditCurrentNoteInput);
    },
    createPendingAction: (input, context) => {
      // Resolve patches into full content if needed
      const inputExt = input as EditCurrentNoteInput & {
        _patches?: NotePatch[];
      };
      if (inputExt._patches && input.mode === "edit") {
        const snapshot = zoteroGateway.getActiveNoteSnapshot({
          request: context.request,
          item: context.item,
        });
        if (!snapshot) {
          throw new Error("No active note is available to edit");
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

      // --- Resolve _isHtml for create mode from LLM output ---
      if (input.mode === "create" && input._rawHtmlContent) {
        input._isHtml = true;
        input.content = sanitizeNoteHtml(input._rawHtmlContent);
        delete input._rawHtmlContent;
      }

      const normalizedContent = input._isHtml
        ? input.content
        : normalizeNoteSourceText(input.content);
      input.content = normalizedContent;

      if (input.mode === "create") {
        return {
          toolName: "edit_current_note",
          mode: "review",
          title: "Review new note",
          description:
            input.target === "standalone"
              ? "Review the note content before creating a standalone note."
              : "Review the note content before attaching it to the paper.",
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

      const snapshot = zoteroGateway.getActiveNoteSnapshot({
        request: context.request,
        item: context.item,
      });
      if (!snapshot) {
        throw new Error("No active note is available to edit");
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
        description: `Review the proposed note changes for "${input.noteTitle}" and edit the final note text before applying it.`,
        confirmLabel: "Apply edit",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "diff_preview",
            id: "noteDiff",
            label: "Note changes",
            before: snapshot.text,
            after: diffAfter,
            sourceFieldId: "content",
            contextLines: 0,
            emptyMessage: "No note changes yet.",
          },
          {
            type: "textarea",
            id: "content",
            label: "Final note content",
            value: input._isHtml ? input.content : normalizedContent,
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
    execute: async (input, context) => {
      const hasLocalImages =
        /!\[[^\]]*\]\(file:\/\/|<img\s+[^>]*src\s*=\s*"file:\/\//i.test(
          input.content,
        );

      if (input.mode === "create") {
        // Auto-fallback to standalone if no parent item is resolvable
        // (e.g. library chat mode with no active paper)
        if (input.target !== "standalone") {
          const resolvedItem = input.targetItemId
            ? zoteroGateway.getItem(input.targetItemId)
            : zoteroGateway.getItem(context.request.activeItemId) ||
              context.item;
          if (!resolvedItem) {
            input.target = "standalone";
          }
        }

        if (!hasLocalImages && !input._isHtml) {
          // No images, no styled HTML — use the standard mutation service path
          const { result } = await executeAndRecordUndo(
            mutationService,
            {
              type: "save_note",
              content: input.content,
              target: input.target,
              targetItemId: input.targetItemId,
            },
            context,
            "edit_current_note",
          );
          return result;
        }

        // Has local images — create note manually to get the note ID,
        // then import images and update note HTML
        const parentItem = input.targetItemId
          ? zoteroGateway.getItem(input.targetItemId)
          : zoteroGateway.getItem(context.request.activeItemId) || context.item;
        const parentId = parentItem?.isRegularItem?.()
          ? parentItem.id
          : parentItem?.parentID || parentItem?.id;
        const libraryID =
          parentItem?.libraryID || context.request.libraryID || 1;

        // Create a blank note first
        const note = new Zotero.Item("note");
        note.libraryID = libraryID;
        if (parentId && input.target !== "standalone") {
          note.parentID = parentId;
        }
        note.setNote("<p>Importing images...</p>");
        await note.saveTx();
        const noteId = note.id;

        // Import images into this note
        let finalContent = input.content;
        try {
          finalContent = await importLocalImages(
            input.content,
            noteId,
            zoteroGateway,
          );
        } catch (e) {
          Zotero.debug?.(`[llm-for-zotero] Image import failed: ${e}`);
        }

        // Now set the final note HTML with data-attachment-key img tags
        if (input._isHtml) {
          note.setNote(sanitizeNoteHtml(finalContent));
        } else {
          note.setNote(renderRawNoteHtml(finalContent));
        }
        await note.saveTx();

        if (input.target !== "standalone" && parentId && noteId > 0) {
          rememberAssistantNoteForParent(parentId, noteId);
        }

        // Register undo
        pushUndoEntry(context.request.conversationKey, {
          id: `undo-edit-current-note-create-${noteId}-${Date.now()}`,
          toolName: "edit_current_note",
          description: `Trash created note`,
          revert: async () => {
            const n = zoteroGateway.getItem(noteId);
            if (n) {
              n.deleted = true;
              await n.saveTx();
            }
          },
        });

        return {
          status: "created",
          noteId,
          title: String(note.getField?.("title") || ""),
        };
      }

      // For edit mode, import images before saving
      let contentToSave = input.content;
      if (hasLocalImages && input.noteId) {
        try {
          contentToSave = await importLocalImages(
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
        content: contentToSave,
        expectedOriginalHtml: input.expectedOriginalHtml,
        preRenderedHtml: input._isHtml
          ? sanitizeNoteHtml(contentToSave)
          : input._patchedHtml,
      });
      pushUndoEntry(context.request.conversationKey, {
        id: `undo-edit-current-note-${result.noteId}-${Date.now()}`,
        toolName: "edit_current_note",
        description: `Revert note edit: ${result.title}`,
        revert: async () => {
          await zoteroGateway.restoreNoteHtml({
            noteId: result.noteId,
            html: result.previousHtml,
          });
        },
      });
      return {
        status: "updated",
        noteId: result.noteId,
        title: result.title,
        noteText: result.nextText,
      };
    },
  };
}
