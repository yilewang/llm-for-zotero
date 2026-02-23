import { renderMarkdownForNote } from "../../utils/markdown";
import {
  sanitizeText,
  escapeNoteHtml,
  getCurrentLocalTimestamp,
  getSelectedTextSourceIcon,
  normalizeSelectedTextSource,
} from "./textUtils";
import { MAX_SELECTED_IMAGES } from "./constants";
import {
  getTrackedAssistantNoteForParent,
  removeAssistantNoteMapEntry,
  rememberAssistantNoteForParent,
} from "./prefHelpers";
import {
  ensureAttachmentBlobFromPath,
  extractManagedBlobHash,
  isManagedBlobPath,
  toFileUrl,
} from "./attachmentStorage";
import {
  ATTACHMENT_GC_MIN_AGE_MS,
  collectAndDeleteUnreferencedBlobs,
  replaceOwnerAttachmentRefs,
} from "../../utils/attachmentRefStore";
import type { ChatAttachment, Message, SelectedTextSource } from "./types";

function resolveParentItemForNote(item: Zotero.Item): Zotero.Item | null {
  if (item.isAttachment() && item.parentID) {
    return Zotero.Items.get(item.parentID) || null;
  }
  return item;
}

function buildAssistantNoteHtml(
  contentText: string,
  modelName: string,
): string {
  const response = sanitizeText(contentText || "").trim();
  const source = modelName.trim() || "unknown";
  const timestamp = getCurrentLocalTimestamp();
  let responseHtml = "";
  try {
    // Use Zotero note-editor native math format so that note.setNote()
    // loads math correctly through ProseMirror's schema parser.
    responseHtml = renderMarkdownForNote(response);
  } catch (err) {
    ztoolkit.log("Note markdown render error:", err);
    responseHtml = escapeNoteHtml(response).replace(/\n/g, "<br/>");
  }
  return `<p><strong>${escapeNoteHtml(timestamp)}</strong></p><p><strong>${escapeNoteHtml(source)}:</strong></p><div>${responseHtml}</div><hr/><p>Written by LLM-for-Zotero plugin</p>`;
}

function renderChatMessageHtmlForNote(text: string): string {
  const safeText = sanitizeText(text || "").trim();
  if (!safeText) return "";
  try {
    // Reuse the same markdown-to-note rendering path as single-response save.
    return renderMarkdownForNote(safeText);
  } catch (err) {
    ztoolkit.log("Chat history markdown render error:", err);
    return escapeNoteHtml(safeText).replace(/\n/g, "<br/>");
  }
}

function normalizeScreenshotImagesForNote(images: unknown): string[] {
  if (!Array.isArray(images)) return [];
  const out: string[] = [];
  for (const raw of images) {
    if (typeof raw !== "string") continue;
    const src = raw.trim();
    if (!src) continue;
    // Persist only embedded image data URLs; blob/object URLs are ephemeral.
    if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(src)) continue;
    out.push(src);
    if (out.length >= MAX_SELECTED_IMAGES) break;
  }
  return out;
}

function formatScreenshotEmbeddedLabel(count: number): string {
  return `Screenshots (${count}/${MAX_SELECTED_IMAGES}) are embedded below`;
}

function normalizeFileAttachmentsForNote(
  attachments: unknown,
): ChatAttachment[] {
  if (!Array.isArray(attachments)) return [];
  return attachments.filter(
    (entry): entry is ChatAttachment =>
      Boolean(entry) &&
      typeof entry === "object" &&
      (entry as ChatAttachment).category !== "image" &&
      typeof (entry as ChatAttachment).name === "string",
  );
}

function formatFileEmbeddedLabel(files: ChatAttachment[]): string {
  if (!files.length) return "";
  const names = files.map((entry) => entry.name).filter(Boolean);
  return `Files (${names.length}): ${names.join(", ")}`;
}

function formatSelectedTextQuoteMarkdown(
  selectedText: string,
  label = "Selected text",
): string {
  const quoted = selectedText
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  return `${label}:\n${quoted}`;
}

function normalizeSelectedTextsForNote(
  selectedTexts: unknown,
  selectedText: unknown,
  selectedTextSources: unknown,
): Array<{ text: string; source: SelectedTextSource }> {
  const normalizedTexts = (() => {
    if (Array.isArray(selectedTexts)) {
      return selectedTexts
        .map((entry) =>
          sanitizeText(typeof entry === "string" ? entry : "").trim(),
        )
        .filter(Boolean);
    }
    const legacy =
      typeof selectedText === "string" ? sanitizeText(selectedText).trim() : "";
    return legacy ? [legacy] : [];
  })();
  if (!normalizedTexts.length) return [];
  const rawSources = Array.isArray(selectedTextSources)
    ? selectedTextSources
    : [];
  return normalizedTexts.map((text, index) => ({
    text,
    source: normalizeSelectedTextSource(rawSources[index]),
  }));
}

function formatSelectedTextLabel(
  source: SelectedTextSource,
  index: number,
  total: number,
): string {
  const icon = getSelectedTextSourceIcon(source);
  if (total === 1) return `${icon} Selected text`;
  return `${icon} Selected text (${index + 1})`;
}

function buildScreenshotImagesHtmlForNote(images: string[]): string {
  if (!images.length) return "";
  const label = formatScreenshotEmbeddedLabel(images.length);
  const blocks = images
    .map((src, index) => {
      const alt = `Screenshot ${index + 1}`;
      return `<p><img src="${escapeNoteHtml(src)}" alt="${escapeNoteHtml(alt)}"/></p>`;
    })
    .join("");
  return `<div><p>${escapeNoteHtml(label)}</p>${blocks}</div>`;
}

function buildFileListHtmlForNote(files: ChatAttachment[]): string {
  if (!files.length) return "";
  const items = files
    .map((entry) => {
      const href = toFileUrl(entry.storedPath);
      const typeText = escapeNoteHtml(
        (entry.mimeType || "application/octet-stream").trim(),
      );
      const sizeText = `${(entry.sizeBytes / 1024 / 1024).toFixed(2)} MB`;
      const escapedName = escapeNoteHtml(entry.name);
      const linkedName = href
        ? `<a href="${escapeNoteHtml(href)}">${escapedName}</a>`
        : `<strong>${escapedName}</strong>`;
      return `<li>${linkedName} (${typeText}, ${escapeNoteHtml(sizeText)})</li>`;
    })
    .join("");
  return `<div><p>${escapeNoteHtml(formatFileEmbeddedLabel(files))}</p><ul>${items}</ul></div>`;
}

function normalizeAttachmentHash(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

function collectAttachmentHashes(messages: Message[]): string[] {
  const hashes = new Set<string>();
  for (const msg of messages) {
    const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
    for (const attachment of attachments) {
      if (!attachment || attachment.category === "image") continue;
      const hash =
        normalizeAttachmentHash(attachment.contentHash) ||
        extractManagedBlobHash(attachment.storedPath);
      if (!hash) continue;
      hashes.add(hash);
    }
  }
  return Array.from(hashes);
}

async function normalizeHistoryAttachmentsToSharedBlobs(
  history: Message[],
): Promise<Message[]> {
  const cloned: Message[] = [];
  for (const msg of history) {
    const attachments = Array.isArray(msg.attachments)
      ? msg.attachments
      : undefined;
    if (!attachments?.length) {
      cloned.push({ ...msg });
      continue;
    }
    const nextAttachments: ChatAttachment[] = [];
    for (const attachment of attachments) {
      if (
        attachment.category === "image" ||
        !attachment.storedPath ||
        !attachment.storedPath.trim()
      ) {
        nextAttachments.push({ ...attachment });
        continue;
      }
      try {
        const normalizedPath = attachment.storedPath.trim();
        const existingHash = normalizeAttachmentHash(attachment.contentHash);
        if (existingHash && isManagedBlobPath(normalizedPath)) {
          nextAttachments.push({
            ...attachment,
            contentHash: existingHash,
            storedPath: normalizedPath,
          });
          continue;
        }
        const managedHash = extractManagedBlobHash(normalizedPath);
        if (managedHash) {
          nextAttachments.push({
            ...attachment,
            contentHash: managedHash,
            storedPath: normalizedPath,
          });
          continue;
        }
        const imported = await ensureAttachmentBlobFromPath(
          normalizedPath,
          attachment.name,
        );
        nextAttachments.push({
          ...attachment,
          storedPath: imported.storedPath,
          contentHash: imported.contentHash,
        });
      } catch (err) {
        ztoolkit.log("LLM: Failed to normalize note attachment blob", err);
        nextAttachments.push({
          ...attachment,
          storedPath: undefined,
          contentHash: undefined,
        });
      }
    }
    cloned.push({
      ...msg,
      attachments: nextAttachments,
    });
  }
  return cloned;
}

export function buildChatHistoryNotePayload(messages: Message[]): {
  noteHtml: string;
  noteText: string;
} {
  const timestamp = getCurrentLocalTimestamp();
  const textLines: string[] = [];
  const htmlBlocks: string[] = [];
  for (const msg of messages) {
    const text = sanitizeText(msg.text || "").trim();
    const selectedTextContexts = normalizeSelectedTextsForNote(
      msg.selectedTexts,
      msg.selectedText,
      msg.selectedTextSources,
    );
    const screenshotImages = normalizeScreenshotImagesForNote(
      msg.screenshotImages,
    );
    const fileAttachments = normalizeFileAttachmentsForNote(msg.attachments);
    const screenshotCount = screenshotImages.length;
    if (
      !text &&
      !selectedTextContexts.length &&
      !screenshotCount &&
      !fileAttachments.length
    )
      continue;
    let textWithContext = text;
    let htmlTextWithContext = text;
    if (msg.role === "user") {
      const userBlocks: string[] = [];
      const userHtmlBlocks: string[] = [];
      if (selectedTextContexts.length === 1) {
        const entry = selectedTextContexts[0];
        const label = formatSelectedTextLabel(
          entry.source,
          0,
          selectedTextContexts.length,
        );
        userBlocks.push(formatSelectedTextQuoteMarkdown(entry.text, label));
        userHtmlBlocks.push(formatSelectedTextQuoteMarkdown(entry.text, label));
      } else if (selectedTextContexts.length > 1) {
        selectedTextContexts.forEach((entry, index) => {
          const label = formatSelectedTextLabel(
            entry.source,
            index,
            selectedTextContexts.length,
          );
          userBlocks.push(formatSelectedTextQuoteMarkdown(entry.text, label));
          userHtmlBlocks.push(
            formatSelectedTextQuoteMarkdown(entry.text, label),
          );
        });
      }
      if (screenshotCount) {
        userBlocks.push(formatScreenshotEmbeddedLabel(screenshotCount));
      }
      if (fileAttachments.length) {
        userBlocks.push(formatFileEmbeddedLabel(fileAttachments));
      }
      if (text) {
        userBlocks.push(text);
        userHtmlBlocks.push(text);
      }
      textWithContext = userBlocks.join("\n\n");
      htmlTextWithContext = userHtmlBlocks.join("\n\n");
    }
    const speaker =
      msg.role === "user"
        ? "user"
        : sanitizeText(msg.modelName || "").trim() || "model";
    const screenshotHtml =
      msg.role === "user"
        ? buildScreenshotImagesHtmlForNote(screenshotImages)
        : "";
    const fileHtml =
      msg.role === "user" ? buildFileListHtmlForNote(fileAttachments) : "";
    const rendered = renderChatMessageHtmlForNote(
      msg.role === "user" ? htmlTextWithContext : textWithContext,
    );
    if (!rendered && !screenshotHtml && !fileHtml) continue;
    textLines.push(`${speaker}: ${textWithContext}`);
    const renderedBlock = rendered ? `<div>${rendered}</div>` : "";
    htmlBlocks.push(
      `<p><strong>${escapeNoteHtml(speaker)}:</strong></p>${renderedBlock}${screenshotHtml}${fileHtml}`,
    );
  }
  const noteText = textLines.join("\n\n");
  const bodyHtml = htmlBlocks.join("<hr/>");
  return {
    noteText,
    noteHtml: `<p><strong>Chat history saved at ${escapeNoteHtml(timestamp)}</strong></p><div>${bodyHtml}</div><hr/><p>Written by LLM-for-Zotero plugin</p>`,
  };
}

function appendAssistantAnswerToNoteHtml(
  existingHtml: string,
  newAnswerHtml: string,
): string {
  const base = (existingHtml || "").trim();
  const addition = (newAnswerHtml || "").trim();
  if (!base) return addition;
  if (!addition) return base;
  return `${base}<hr/>${addition}`;
}

export async function createNoteFromAssistantText(
  item: Zotero.Item,
  contentText: string,
  modelName: string,
): Promise<"created" | "appended"> {
  const parentItem = resolveParentItemForNote(item);
  const parentId = parentItem?.id;
  if (!parentItem || !parentId) {
    throw new Error("No parent item available for note creation");
  }

  // Always render from the plain-text / markdown source via
  // renderMarkdownForNote.  This produces clean HTML that Zotero's
  // ProseMirror note-editor can reliably parse.  (The previous approach
  // of injecting rendered DOM HTML from the bubble was fragile — KaTeX
  // span trees and sanitised classless wrappers were mostly dropped by
  // ProseMirror.)
  const html = buildAssistantNoteHtml(contentText, modelName);

  // Try to find an existing tracked note for this parent item.
  // If one exists and is still valid, append the new content to it.
  const existingNote = getTrackedAssistantNoteForParent(parentId);
  if (existingNote) {
    try {
      const appendedHtml = appendAssistantAnswerToNoteHtml(
        existingNote.getNote() || "",
        html,
      );
      existingNote.setNote(appendedHtml);
      await existingNote.saveTx();
      ztoolkit.log(
        `LLM: Appended to existing note ${existingNote.id} for parent ${parentId}`,
      );
      return "appended";
    } catch (appendErr) {
      // If appending fails (e.g. note was deleted externally), fall through
      // to create a new note instead.
      ztoolkit.log(
        "LLM: Failed to append to existing note, creating new:",
        appendErr,
      );
      removeAssistantNoteMapEntry(parentId);
    }
  }

  // No existing tracked note (or append failed) – create a brand-new note.
  const note = new Zotero.Item("note");
  note.libraryID = parentItem.libraryID;
  note.parentID = parentId;
  note.setNote(html);
  const saveResult = await note.saveTx();
  // saveTx() returns the new item ID (number) on creation.
  // Also check note.id as a fallback.
  const newNoteId =
    typeof saveResult === "number" && saveResult > 0 ? saveResult : note.id;
  if (newNoteId && newNoteId > 0) {
    rememberAssistantNoteForParent(parentId, newNoteId);
    ztoolkit.log(`LLM: Created new note ${newNoteId} for parent ${parentId}`);
  } else {
    ztoolkit.log(
      "LLM: Warning – note was saved but could not determine note ID",
    );
  }
  return "created";
}

export async function createNoteFromChatHistory(
  item: Zotero.Item,
  history: Message[],
): Promise<void> {
  const parentItem = resolveParentItemForNote(item);
  const parentId = parentItem?.id;
  if (!parentItem || !parentId) {
    throw new Error("No parent item available for note creation");
  }
  // Chat history export always creates a brand-new, standalone note.
  // It does NOT append to the tracked assistant note and does NOT
  // update the tracked note ID, so single-response "Save as note"
  // keeps its own append chain undisturbed.
  const note = new Zotero.Item("note");
  note.libraryID = parentItem.libraryID;
  note.parentID = parentId;
  // Create first to get stable note ID for attachment reference ownership.
  note.setNote("<p>Preparing chat history export...</p>");
  const saveResult = await note.saveTx();
  const noteId =
    typeof saveResult === "number" && saveResult > 0 ? saveResult : note.id;
  if (!noteId || noteId <= 0) {
    throw new Error("Unable to resolve new note ID for chat history export");
  }
  const normalizedHistory =
    await normalizeHistoryAttachmentsToSharedBlobs(history);
  note.setNote(buildChatHistoryNotePayload(normalizedHistory).noteHtml);
  await note.saveTx();
  const attachmentHashes = collectAttachmentHashes(normalizedHistory);
  try {
    await replaceOwnerAttachmentRefs("note", noteId, attachmentHashes);
  } catch (err) {
    ztoolkit.log("LLM: Failed to persist note attachment refs", err);
  }
  void collectAndDeleteUnreferencedBlobs(ATTACHMENT_GC_MIN_AGE_MS).catch(
    (err) => {
      ztoolkit.log("LLM: Attachment GC after note export failed", err);
    },
  );
  ztoolkit.log(
    `LLM: Created chat history note ${noteId} for parent ${parentId}`,
  );
}

export async function createStandaloneNoteFromChatHistory(
  libraryID: number,
  history: Message[],
): Promise<void> {
  const normalizedLibraryID = Number.isFinite(libraryID)
    ? Math.floor(libraryID)
    : 0;
  if (normalizedLibraryID <= 0) {
    throw new Error("Invalid library ID for standalone note export");
  }
  const note = new Zotero.Item("note");
  note.libraryID = normalizedLibraryID;
  note.setNote("<p>Preparing chat history export...</p>");
  const saveResult = await note.saveTx();
  const noteId =
    typeof saveResult === "number" && saveResult > 0 ? saveResult : note.id;
  if (!noteId || noteId <= 0) {
    throw new Error(
      "Unable to resolve new standalone note ID for chat history export",
    );
  }
  const normalizedHistory =
    await normalizeHistoryAttachmentsToSharedBlobs(history);
  note.setNote(buildChatHistoryNotePayload(normalizedHistory).noteHtml);
  await note.saveTx();
  const attachmentHashes = collectAttachmentHashes(normalizedHistory);
  try {
    await replaceOwnerAttachmentRefs("note", noteId, attachmentHashes);
  } catch (err) {
    ztoolkit.log("LLM: Failed to persist standalone note attachment refs", err);
  }
  void collectAndDeleteUnreferencedBlobs(ATTACHMENT_GC_MIN_AGE_MS).catch(
    (err) => {
      ztoolkit.log(
        "LLM: Attachment GC after standalone note export failed",
        err,
      );
    },
  );
  ztoolkit.log(
    `LLM: Created standalone chat history note ${noteId} in library ${normalizedLibraryID}`,
  );
}
