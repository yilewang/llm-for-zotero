import { renderMarkdownForNote } from "../../utils/markdown";
import {
  sanitizeText,
  escapeNoteHtml,
  getCurrentLocalTimestamp,
  normalizeSelectedTextSource,
} from "./textUtils";
import { normalizeAttachmentContentHash } from "./normalizers";
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
} from "./attachmentStorage";
import { toFileUrl } from "../../utils/pathFileUrl";
import {
  ATTACHMENT_GC_MIN_AGE_MS,
  collectAndDeleteUnreferencedBlobs,
  replaceOwnerAttachmentRefs,
} from "../../utils/attachmentRefStore";
import type {
  ChatAttachment,
  GeneratedChatImage,
  Message,
  PaperContextRef,
  QuoteCitation,
  SelectedTextSource,
} from "./types";
import {
  readNoteSnapshot,
  stripNoteHtml,
  type NoteSnapshot,
} from "./noteSnapshot";
import {
  extractStandalonePaperSourceLabel,
  extractInlineCitationMentions,
  formatSourceLabelWithPage,
  formatUnverifiedCitationChipLabel,
  matchAssistantCitationCandidates,
  lookupCachedCitationPage,
} from "./assistantCitationLinks";
import {
  isGlobalPortalItem,
  isPaperPortalItem,
  resolveNoteParentItem,
  resolvePaperPortalBaseItem,
} from "./portalScope";
import {
  isClaudeGlobalPortalItem,
  isClaudePaperPortalItem,
  resolveClaudePaperPortalBaseItem,
} from "../../claudeCode/portal";
import {
  isCodexGlobalPortalItem,
  isCodexPaperPortalItem,
  resolveCodexPaperPortalBaseItem,
} from "../../codexAppServer/portal";
import { getMessageCitationPaperContexts } from "./citationContexts";
import { replaceQuoteCitationPlaceholdersForMarkdown } from "./quoteCitations";
import {
  buildGeneratedImagesHtmlForNote,
  formatGeneratedImagesMarkdownForNote,
  normalizeEmbeddableGeneratedImages,
} from "./noteImages";
import {
  replaceVisualFigureFencesWithNoteImages,
  type NoteFigureRenderOptions,
} from "./figureExport";

export { readNoteSnapshot, stripNoteHtml, type NoteSnapshot };

function decodeNoteHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function isLikelyHtmlNoteContent(text: string): boolean {
  if (!text || !/[<>]/.test(text)) return false;
  return /<\/?(?:p|div|span|strong|b|em|i|u|a|ul|ol|li|blockquote|h[1-6]|br|hr|code|pre)\b/i.test(
    text,
  );
}

export function normalizeNoteSourceText(contentText: string): string {
  const raw = sanitizeText(contentText || "").trim();
  if (!raw) return "";
  if (!isLikelyHtmlNoteContent(raw)) return raw;

  let normalized = raw.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");

  normalized = normalized.replace(
    /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, _quote, href, text) => {
      const label = stripNoteHtml(text).trim();
      const decodedHref = decodeNoteHtmlEntities(`${href || ""}`).trim();
      if (!label) return decodedHref;
      return decodedHref ? `[${label}](${decodedHref})` : label;
    },
  );
  normalized = normalized.replace(
    /<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi,
    (_match, _tag, text) => `**${stripNoteHtml(text).trim()}**`,
  );
  normalized = normalized.replace(
    /<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi,
    (_match, _tag, text) => `*${stripNoteHtml(text).trim()}*`,
  );
  normalized = normalized.replace(
    /<code[^>]*>([\s\S]*?)<\/code>/gi,
    (_match, text) => `\`${stripNoteHtml(text).trim()}\``,
  );
  normalized = normalized.replace(
    /<pre[^>]*>([\s\S]*?)<\/pre>/gi,
    (_match, text) =>
      `\n\n\`\`\`\n${decodeNoteHtmlEntities(stripNoteHtml(text))}\n\`\`\`\n\n`,
  );
  normalized = normalized.replace(/<hr\s*\/?>/gi, "\n\n---\n\n");
  normalized = normalized.replace(/<br\s*\/?>/gi, "\n");
  normalized = normalized.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_match, level, text) =>
      `\n\n${"#".repeat(Number(level) || 1)} ${stripNoteHtml(text).trim()}\n\n`,
  );
  normalized = normalized.replace(/<li[^>]*>/gi, "\n- ");
  normalized = normalized.replace(/<\/li>/gi, "");
  normalized = normalized.replace(/<blockquote[^>]*>/gi, "\n\n> ");
  normalized = normalized.replace(/<\/blockquote>/gi, "\n\n");
  // Strip remaining HTML tags, but preserve <img> tags (for embedded figures)
  normalized = normalized.replace(/<(?!img\b)[^>]+>/g, "");
  normalized = decodeNoteHtmlEntities(normalized)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return normalized || stripNoteHtml(raw);
}

export function renderRawNoteHtml(contentText: string): string {
  const raw = normalizeNoteSourceText(contentText);
  if (!raw) return "<p></p>";
  try {
    return renderMarkdownForNote(raw);
  } catch (err) {
    ztoolkit.log("Note markdown render error:", err);
    return escapeNoteHtml(raw).replace(/\n/g, "<br/>");
  }
}

async function renderRawNoteHtmlForSave(
  contentText: string,
  options: {
    noteId?: number;
    figureRender?: NoteFigureRenderOptions;
  } = {},
): Promise<string> {
  const raw = normalizeNoteSourceText(contentText);
  if (!raw) return "<p></p>";
  let noteSource = raw;
  if (options.noteId && options.figureRender?.doc) {
    try {
      noteSource = await replaceVisualFigureFencesWithNoteImages(
        raw,
        options.noteId,
        options.figureRender,
      );
    } catch (err) {
      ztoolkit.log("Note figure render error:", err);
      noteSource = raw;
    }
  }
  try {
    return renderMarkdownForNote(noteSource);
  } catch (err) {
    ztoolkit.log("Note markdown render error:", err);
    return escapeNoteHtml(noteSource).replace(/\n/g, "<br/>");
  }
}

export function resolveParentItemForNoteTarget(
  item: Zotero.Item,
): Zotero.Item | null {
  if (
    isGlobalPortalItem(item) ||
    isClaudeGlobalPortalItem(item) ||
    isCodexGlobalPortalItem(item)
  ) {
    return null;
  }
  if (isPaperPortalItem(item)) {
    return resolvePaperPortalBaseItem(item);
  }
  if (isClaudePaperPortalItem(item)) {
    return resolveClaudePaperPortalBaseItem(item);
  }
  if (isCodexPaperPortalItem(item)) {
    return resolveCodexPaperPortalBaseItem(item);
  }
  const noteParentItem = resolveNoteParentItem(item);
  if (noteParentItem) {
    return noteParentItem;
  }
  if ((item as any).isNote?.()) {
    return null;
  }
  if (item.isAttachment() && item.parentID) {
    return Zotero.Items.get(item.parentID) || null;
  }
  return item;
}

// ---------------------------------------------------------------------------
// Citation link injection for Zotero notes
// ---------------------------------------------------------------------------

/**
 * Build a `zotero://open-pdf/…` URI that opens a PDF attachment at a given
 * page.  Returns `null` when the item cannot be resolved.
 */
function buildZoteroPdfUri(
  contextItemId: number,
  pageLabel?: string,
): string | null {
  try {
    const item = Zotero.Items.get(contextItemId);
    if (!item) return null;
    const key = (item as any).key as string | undefined;
    if (!key) return null;
    const libraryID = Number(item.libraryID);
    // Determine library path segment
    let libraryPath = "library";
    if (libraryID && libraryID !== Zotero.Libraries.userLibraryID) {
      const lib = Zotero.Libraries.get(libraryID) as any;
      const groupID = lib?.groupID;
      if (groupID) {
        libraryPath = `groups/${groupID}`;
      }
    }
    let uri = `zotero://open-pdf/${libraryPath}/items/${key}`;
    // pageLabel is a display label (e.g. "5", "iv").  The `page` param in the
    // zotero:// URI expects a 1-based physical page number.  If it looks like
    // a simple integer, append it; otherwise omit to open at the start.
    if (pageLabel) {
      const pageNum = parseInt(pageLabel, 10);
      if (Number.isFinite(pageNum) && pageNum > 0) {
        uri += `?page=${pageNum}`;
      }
    }
    return uri;
  } catch {
    return null;
  }
}

/**
 * Post-process rendered note HTML to wrap citation mentions with clickable
 * `zotero://open-pdf` hyperlinks so users can jump to the cited PDF page
 * directly from the saved Zotero note.
 *
 * Handles both blockquote-tail citations (`<blockquote>…</blockquote><p>(Author, 2024)</p>`)
 * and inline parenthetical/narrative citations within paragraph text.
 */
function injectCitationLinksIntoNoteHtml(
  html: string,
  paperContexts: PaperContextRef[] | undefined,
): string {
  if (!html || !paperContexts?.length) return html;

  // --- Phase 1: blockquote-tail citations ---
  // Pattern: `<blockquote>…</blockquote>…<p>(Author et al., 2024[, page N])</p>`
  // Capture the blockquote content so we can look up the citation page cache
  // (the cache is keyed by contextItemId + quote text).
  let result = html.replace(
    /(<blockquote>)([\s\S]*?)(<\/blockquote>\s*<p>)([\s\S]*?)(<\/p>)/gi,
    (
      _match,
      bqOpen: string,
      bqContent: string,
      bqCloseAndPOpen: string,
      innerText: string,
      suffix: string,
    ) => {
      const plainText = innerText.replace(/<[^>]+>/g, "").trim();
      if (!plainText) return _match;
      const candidates = matchAssistantCitationCandidates(
        plainText,
        paperContexts,
      );
      if (!candidates.length) return _match;
      const bestCandidate = candidates[0];
      const extracted = extractStandalonePaperSourceLabel(plainText);
      // Check the citation page cache for a corrected page (verified by
      // FindController when the user clicked the citation in the chat panel).
      const quoteText = stripNoteHtml(bqContent);
      const cachedPage = lookupCachedCitationPage(
        bestCandidate.contextItemId,
        quoteText,
      );
      const pageLabel = cachedPage || undefined;
      const uri = buildZoteroPdfUri(bestCandidate.contextItemId, pageLabel);
      if (!uri) return _match;
      const visibleCitationText = pageLabel
        ? formatSourceLabelWithPage(
            extracted?.sourceLabel || plainText,
            pageLabel,
          )
        : extracted?.sourceLabel || plainText;
      return `${bqOpen}${bqContent}${bqCloseAndPOpen}<a href="${escapeNoteHtml(uri)}">${escapeNoteHtml(visibleCitationText)}</a>${suffix}`;
    },
  );

  // --- Phase 2: inline citations ---
  // Process each <p>…</p> block (but skip those already handled as blockquote tails).
  result = result.replace(
    /(<p>)([\s\S]*?)(<\/p>)/gi,
    (_match, prefix: string, innerHtml: string, suffix: string) => {
      // Skip if this <p> is entirely wrapped in an <a> already (from phase 1).
      if (/^<a\s/.test(innerHtml.trim())) return _match;
      // Extract text content for citation pattern matching.
      const plainText = innerHtml.replace(/<[^>]+>/g, "");
      if (!plainText.trim()) return _match;
      const mentions = extractInlineCitationMentions(plainText);
      if (!mentions.length) return _match;

      // Build a mapping from plainText offsets back to innerHtml offsets.
      // We need this because innerHtml may contain HTML tags that shift offsets.
      const plainToHtmlMap: number[] = [];
      let plainIdx = 0;
      let inTag = false;
      for (let htmlIdx = 0; htmlIdx < innerHtml.length; htmlIdx++) {
        if (innerHtml[htmlIdx] === "<") {
          inTag = true;
          continue;
        }
        if (inTag) {
          if (innerHtml[htmlIdx] === ">") inTag = false;
          continue;
        }
        plainToHtmlMap[plainIdx] = htmlIdx;
        plainIdx++;
      }
      // sentinel for end-of-string
      plainToHtmlMap[plainIdx] = innerHtml.length;

      // Process mentions in reverse order to keep offsets valid.
      let modifiedHtml = innerHtml;
      for (let i = mentions.length - 1; i >= 0; i--) {
        const mention = mentions[i];
        const candidates = matchAssistantCitationCandidates(
          mention.rawText,
          paperContexts,
        );
        if (!candidates.length) continue;
        const bestCandidate = candidates[0];
        const uri = buildZoteroPdfUri(bestCandidate.contextItemId);
        if (!uri) continue;

        // Map plain-text offsets to HTML offsets.
        const htmlStart = plainToHtmlMap[mention.start];
        const htmlEnd = plainToHtmlMap[mention.end];
        if (htmlStart === undefined || htmlEnd === undefined) continue;

        const citationHtml = mention.extractedCitation.pageLabel
          ? escapeNoteHtml(formatUnverifiedCitationChipLabel(mention.rawText))
          : modifiedHtml.slice(htmlStart, htmlEnd);
        const linked = `<a href="${escapeNoteHtml(uri)}">${citationHtml}</a>`;
        modifiedHtml =
          modifiedHtml.slice(0, htmlStart) +
          linked +
          modifiedHtml.slice(htmlEnd);
      }

      return `${prefix}${modifiedHtml}${suffix}`;
    },
  );

  return result;
}

/**
 * Canonical footer appended to every saved note (whether saved via the
 * chat UI's "Save as note" button, via the chat-history export, or via a
 * skill). Centralised so the footer text matches across every entry path
 * — and so the skill's footer instruction in `src/agent/skills/write-note.md`
 * stays textually identical to the UI-appended one.
 */
const NOTE_FOOTER_TEXT = "Written by LLM-for-Zotero.";
const NOTE_FOOTER_HTML = `<hr/><p>${NOTE_FOOTER_TEXT}</p>`;

/**
 * Strips an already-present `Written by LLM-for-Zotero[ plugin][.]` footer
 * from the end of markdown text produced by the LLM. When the agent follows
 * the `write-note` skill, its output already ends with the canonical
 * footer — we must remove it before the UI adds its own, otherwise the
 * rendered note shows the footer twice (the bug this fixes).
 *
 * Tolerates minor formatting variation: optional preceding `---` separator,
 * optional trailing period, optional "plugin" suffix, and surrounding
 * whitespace.
 */
function stripTrailingPluginFooter(text: string): string {
  if (!text) return text;
  return text.replace(
    /\s*(?:\n+-{3,}\s*)?\n+\s*Written by LLM-for-Zotero(?:\s+plugin)?\.?\s*$/i,
    "",
  );
}

function buildAssistantNoteHtml(
  contentText: string,
  modelName: string,
  paperContexts?: PaperContextRef[],
  quoteCitations?: QuoteCitation[],
  generatedImagesHtml = "",
  queryText = "",
): string {
  const query = replaceQuoteCitationPlaceholdersForMarkdown(
    sanitizeText(queryText || "").trim(),
    quoteCitations,
    { unresolved: "omit" },
  );
  const response = replaceQuoteCitationPlaceholdersForMarkdown(
    sanitizeText(stripTrailingPluginFooter(contentText || "")).trim(),
    quoteCitations,
    { unresolved: "omit" },
  );
  const source = modelName.trim() || "unknown";
  const timestamp = getCurrentLocalTimestamp();
  let queryHtml = query ? renderRawNoteHtml(query) : "";
  let responseHtml = response ? renderRawNoteHtml(response) : "";
  if (queryHtml) {
    queryHtml = injectCitationLinksIntoNoteHtml(queryHtml, paperContexts);
  }
  if (responseHtml) {
    responseHtml = injectCitationLinksIntoNoteHtml(responseHtml, paperContexts);
  }
  const queryBlock = queryHtml
    ? `<p><strong>User query:</strong></p><div>${queryHtml}</div>`
    : "";
  return `<p><strong>${escapeNoteHtml(timestamp)}</strong></p>${queryBlock}<p><strong>Model response:</strong> ${escapeNoteHtml(source)}</p><div>${responseHtml}${generatedImagesHtml}</div>${NOTE_FOOTER_HTML}`;
}

async function buildAssistantNoteHtmlForSave(
  contentText: string,
  modelName: string,
  paperContexts?: PaperContextRef[],
  quoteCitations?: QuoteCitation[],
  generatedImagesHtml = "",
  queryText = "",
  options: {
    noteId?: number;
    figureRender?: NoteFigureRenderOptions;
  } = {},
): Promise<string> {
  const query = replaceQuoteCitationPlaceholdersForMarkdown(
    sanitizeText(queryText || "").trim(),
    quoteCitations,
    { unresolved: "omit" },
  );
  const response = replaceQuoteCitationPlaceholdersForMarkdown(
    sanitizeText(stripTrailingPluginFooter(contentText || "")).trim(),
    quoteCitations,
    { unresolved: "omit" },
  );
  const source = modelName.trim() || "unknown";
  const timestamp = getCurrentLocalTimestamp();
  let queryHtml = query ? await renderRawNoteHtmlForSave(query, options) : "";
  let responseHtml = response
    ? await renderRawNoteHtmlForSave(response, options)
    : "";
  if (queryHtml) {
    queryHtml = injectCitationLinksIntoNoteHtml(queryHtml, paperContexts);
  }
  if (responseHtml) {
    responseHtml = injectCitationLinksIntoNoteHtml(responseHtml, paperContexts);
  }
  const queryBlock = queryHtml
    ? `<p><strong>User query:</strong></p><div>${queryHtml}</div>`
    : "";
  return `<p><strong>${escapeNoteHtml(timestamp)}</strong></p>${queryBlock}<p><strong>Model response:</strong> ${escapeNoteHtml(source)}</p><div>${responseHtml}${generatedImagesHtml}</div>${NOTE_FOOTER_HTML}`;
}

function renderChatMessageHtmlForNote(
  text: string,
  quoteCitations?: QuoteCitation[],
): string {
  const safeText = replaceQuoteCitationPlaceholdersForMarkdown(
    sanitizeText(text || "").trim(),
    quoteCitations,
    { unresolved: "omit" },
  );
  if (!safeText) return "";
  // Reuse the same markdown-to-note rendering path as single-response save.
  return renderRawNoteHtml(safeText);
}

async function renderChatMessageHtmlForNoteSave(
  text: string,
  noteId: number | undefined,
  figureRender: NoteFigureRenderOptions | undefined,
  quoteCitations?: QuoteCitation[],
): Promise<string> {
  const safeText = replaceQuoteCitationPlaceholdersForMarkdown(
    sanitizeText(text || "").trim(),
    quoteCitations,
    { unresolved: "omit" },
  );
  if (!safeText) return "";
  return renderRawNoteHtmlForSave(safeText, {
    noteId,
    figureRender,
  });
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
  return `Screenshots (${count}) are embedded below`;
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
  if (source === "note") {
    return total === 1
      ? "Note context"
      : `Note context (${index + 1})`;
  }
  if (source === "note-edit") {
    return total === 1
      ? "Editing focus"
      : `Editing focus (${index + 1})`;
  }
  if (total === 1) return "Selected text";
  return `Selected text (${index + 1})`;
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

function collectAttachmentHashes(messages: Message[]): string[] {
  const hashes = new Set<string>();
  for (const msg of messages) {
    const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
    for (const attachment of attachments) {
      if (!attachment || attachment.category === "image") continue;
      const hash =
        normalizeAttachmentContentHash(attachment.contentHash) ||
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
        const existingHash = normalizeAttachmentContentHash(
          attachment.contentHash,
        );
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
};
export function buildChatHistoryNotePayload(
  messages: Message[],
  options: {
    generatedImageHtmlByMessageIndex?: Map<number, string>;
  },
): {
  noteHtml: string;
  noteText: string;
};
export function buildChatHistoryNotePayload(
  messages: Message[],
  options: {
    generatedImageHtmlByMessageIndex?: Map<number, string>;
  } = {},
): {
  noteHtml: string;
  noteText: string;
} {
  const timestamp = getCurrentLocalTimestamp();
  const textLines: string[] = [];
  const htmlBlocks: string[] = [];
  let lastUserPaperContexts: PaperContextRef[] | undefined;
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const msg = messages[messageIndex]!;
    // Strip any skill-added footer from assistant messages so chat-history
    // exports don't end up with "Written by LLM-for-Zotero." repeated for
    // every saved-as-note assistant turn plus the UI wrapper's own footer.
    const rawText = msg.text || "";
    const textPreStripped =
      msg.role === "assistant" ? stripTrailingPluginFooter(rawText) : rawText;
    const text = sanitizeText(textPreStripped).trim();
    const selectedTextContexts = normalizeSelectedTextsForNote(
      msg.selectedTexts,
      msg.selectedText,
      msg.selectedTextSources,
    );
    const screenshotImages = normalizeScreenshotImagesForNote(
      msg.screenshotImages,
    );
    const fileAttachments = normalizeFileAttachmentsForNote(msg.attachments);
    const generatedImages =
      msg.role === "assistant"
        ? normalizeEmbeddableGeneratedImages(msg.generatedImages)
        : [];
    const generatedImageText =
      msg.role === "assistant"
        ? formatGeneratedImagesMarkdownForNote(generatedImages)
        : "";
    const generatedImageHtml =
      msg.role === "assistant"
        ? options.generatedImageHtmlByMessageIndex?.get(messageIndex) || ""
        : "";
    const screenshotCount = screenshotImages.length;
    if (
      !text &&
      !selectedTextContexts.length &&
      !screenshotCount &&
      !fileAttachments.length &&
      !generatedImageText &&
      !generatedImageHtml
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
    } else if (generatedImageText) {
      textWithContext = [textWithContext, generatedImageText]
        .filter(Boolean)
        .join("\n\n");
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
    let rendered = renderChatMessageHtmlForNote(
      htmlTextWithContext,
      msg.role === "assistant" ? msg.quoteCitations : undefined,
    );
    // For assistant messages, inject citation links using the preceding
    // user message's paper contexts so citations become clickable in the note.
    if (msg.role === "assistant" && rendered) {
      rendered = injectCitationLinksIntoNoteHtml(
        rendered,
        lastUserPaperContexts,
      );
    }
    const exportedText =
      msg.role === "assistant"
        ? replaceQuoteCitationPlaceholdersForMarkdown(
            textWithContext,
            msg.quoteCitations,
            { unresolved: "omit" },
          )
        : textWithContext;
    if (msg.role === "user") {
      lastUserPaperContexts = getMessageCitationPaperContexts(msg);
    }
    if (!rendered && !screenshotHtml && !fileHtml && !generatedImageHtml)
      continue;
    textLines.push(`${speaker}: ${exportedText}`);
    const renderedBlock = rendered ? `<div>${rendered}</div>` : "";
    htmlBlocks.push(
      `<p><strong>${escapeNoteHtml(speaker)}:</strong></p>${renderedBlock}${screenshotHtml}${fileHtml}${generatedImageHtml}`,
    );
  }
  const noteText = textLines.join("\n\n");
  const bodyHtml = htmlBlocks.join("<hr/>");
  return {
    noteText,
    noteHtml: `<p><strong>Chat history saved at ${escapeNoteHtml(timestamp)}</strong></p><div>${bodyHtml}</div>${NOTE_FOOTER_HTML}`,
  };
}

async function buildChatHistoryNotePayloadForSave(
  messages: Message[],
  options: {
    noteId: number;
    generatedImageHtmlByMessageIndex?: Map<number, string>;
    figureRender?: NoteFigureRenderOptions;
  },
): Promise<{
  noteHtml: string;
  noteText: string;
}> {
  const timestamp = getCurrentLocalTimestamp();
  const textLines: string[] = [];
  const htmlBlocks: string[] = [];
  let lastUserPaperContexts: PaperContextRef[] | undefined;
  for (
    let messageIndex = 0;
    messageIndex < messages.length;
    messageIndex += 1
  ) {
    const msg = messages[messageIndex]!;
    const rawText = msg.text || "";
    const textPreStripped =
      msg.role === "assistant" ? stripTrailingPluginFooter(rawText) : rawText;
    const text = sanitizeText(textPreStripped).trim();
    const selectedTextContexts = normalizeSelectedTextsForNote(
      msg.selectedTexts,
      msg.selectedText,
      msg.selectedTextSources,
    );
    const screenshotImages = normalizeScreenshotImagesForNote(
      msg.screenshotImages,
    );
    const fileAttachments = normalizeFileAttachmentsForNote(msg.attachments);
    const generatedImages =
      msg.role === "assistant"
        ? normalizeEmbeddableGeneratedImages(msg.generatedImages)
        : [];
    const generatedImageText =
      msg.role === "assistant"
        ? formatGeneratedImagesMarkdownForNote(generatedImages)
        : "";
    const generatedImageHtml =
      msg.role === "assistant"
        ? options.generatedImageHtmlByMessageIndex?.get(messageIndex) || ""
        : "";
    const screenshotCount = screenshotImages.length;
    if (
      !text &&
      !selectedTextContexts.length &&
      !screenshotCount &&
      !fileAttachments.length &&
      !generatedImageText &&
      !generatedImageHtml
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
    } else if (generatedImageText) {
      textWithContext = [textWithContext, generatedImageText]
        .filter(Boolean)
        .join("\n\n");
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
    let rendered = await renderChatMessageHtmlForNoteSave(
      htmlTextWithContext,
      options.noteId,
      options.figureRender,
      msg.role === "assistant" ? msg.quoteCitations : undefined,
    );
    if (msg.role === "assistant" && rendered) {
      rendered = injectCitationLinksIntoNoteHtml(
        rendered,
        lastUserPaperContexts,
      );
    }
    const exportedText =
      msg.role === "assistant"
        ? replaceQuoteCitationPlaceholdersForMarkdown(
            textWithContext,
            msg.quoteCitations,
            { unresolved: "omit" },
          )
        : textWithContext;
    if (msg.role === "user") {
      lastUserPaperContexts = getMessageCitationPaperContexts(msg);
    }
    if (!rendered && !screenshotHtml && !fileHtml && !generatedImageHtml)
      continue;
    textLines.push(`${speaker}: ${exportedText}`);
    const renderedBlock = rendered ? `<div>${rendered}</div>` : "";
    htmlBlocks.push(
      `<p><strong>${escapeNoteHtml(speaker)}:</strong></p>${renderedBlock}${screenshotHtml}${fileHtml}${generatedImageHtml}`,
    );
  }
  const noteText = textLines.join("\n\n");
  const bodyHtml = htmlBlocks.join("<hr/>");
  return {
    noteText,
    noteHtml: `<p><strong>Chat history saved at ${escapeNoteHtml(timestamp)}</strong></p><div>${bodyHtml}</div>${NOTE_FOOTER_HTML}`,
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

export type AssistantResponseNoteDestination =
  | { kind: "item"; item: Zotero.Item }
  | { kind: "standalone"; libraryID: number };

export type AssistantResponseNoteResult = {
  status: "created";
  destination: AssistantResponseNoteDestination["kind"];
  noteId?: number;
};

export async function createAssistantResponseNote(params: {
  destination: AssistantResponseNoteDestination;
  contentText: string;
  queryText?: string;
  modelName: string;
  paperContexts?: PaperContextRef[];
  quoteCitations?: QuoteCitation[];
  generatedImages?: GeneratedChatImage[];
  figureRender?: NoteFigureRenderOptions;
}): Promise<AssistantResponseNoteResult> {
  let libraryID = 0;
  let parentId: number | undefined;
  if (params.destination.kind === "item") {
    const parentItem = resolveParentItemForNoteTarget(params.destination.item);
    parentId = parentItem?.id;
    if (!parentItem || !parentId) {
      throw new Error("No parent item available for note creation");
    }
    libraryID = parentItem.libraryID;
  } else {
    libraryID = Number.isFinite(params.destination.libraryID)
      ? Math.floor(params.destination.libraryID)
      : 0;
    if (libraryID <= 0) {
      throw new Error("Invalid library ID for standalone note creation");
    }
  }

  const generatedImages = normalizeEmbeddableGeneratedImages(
    params.generatedImages,
  );
  const buildHtml = async (noteId?: number): Promise<string> => {
    const generatedImagesHtml =
      noteId && generatedImages.length
        ? await buildGeneratedImagesHtmlForNote(generatedImages, noteId)
        : "";
    return buildAssistantNoteHtmlForSave(
      params.contentText,
      params.modelName,
      params.paperContexts,
      params.quoteCitations,
      generatedImagesHtml,
      params.queryText,
      {
        noteId,
        figureRender: params.figureRender,
      },
    );
  };

  const note = new Zotero.Item("note");
  note.libraryID = libraryID;
  if (parentId) note.parentID = parentId;
  const needsDeferredHtml =
    generatedImages.length || Boolean(params.figureRender?.doc);
  if (needsDeferredHtml) {
    note.setNote("<p>Preparing note figures...</p>");
  } else {
    note.setNote(await buildHtml());
  }
  const saveResult = await note.saveTx();
  const noteId =
    typeof saveResult === "number" && saveResult > 0 ? saveResult : note.id;
  if (needsDeferredHtml && noteId && noteId > 0) {
    note.setNote(await buildHtml(noteId));
    await note.saveTx();
  }
  if (noteId && noteId > 0) {
    const target =
      params.destination.kind === "item"
        ? `parent ${parentId}`
        : `library ${libraryID}`;
    ztoolkit.log(`LLM: Created response note ${noteId} for ${target}`);
  } else {
    ztoolkit.log(
      "LLM: Warning – response note was saved but could not determine note ID",
    );
  }
  return {
    status: "created",
    destination: params.destination.kind,
    noteId: noteId && noteId > 0 ? noteId : undefined,
  };
}

export async function createNoteFromAssistantText(
  item: Zotero.Item,
  contentText: string,
  modelName: string,
  paperContexts?: PaperContextRef[],
  options: {
    appendToTrackedNote?: boolean;
    rememberCreatedNote?: boolean;
    quoteCitations?: QuoteCitation[];
    generatedImages?: GeneratedChatImage[];
    queryText?: string;
    figureRender?: NoteFigureRenderOptions;
  } = {},
): Promise<"created" | "appended"> {
  const parentItem = resolveParentItemForNoteTarget(item);
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
  const generatedImages = normalizeEmbeddableGeneratedImages(
    options.generatedImages,
  );
  const buildHtml = async (noteId?: number): Promise<string> => {
    const generatedImagesHtml =
      noteId && generatedImages.length
        ? await buildGeneratedImagesHtmlForNote(generatedImages, noteId)
        : "";
    return buildAssistantNoteHtmlForSave(
      contentText,
      modelName,
      paperContexts,
      options.quoteCitations,
      generatedImagesHtml,
      options.queryText,
      {
        noteId,
        figureRender: options.figureRender,
      },
    );
  };

  if (options.appendToTrackedNote) {
    // Try to find an existing tracked note for this parent item.
    // If one exists and is still valid, append the new content to it.
    const existingNote = getTrackedAssistantNoteForParent(parentId);
    if (existingNote) {
      try {
        const html = await buildHtml(existingNote.id);
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
  }

  // No existing tracked note (or append failed) – create a brand-new note.
  const result = await createAssistantResponseNote({
    destination: { kind: "item", item },
    contentText,
    queryText: options.queryText,
    modelName,
    paperContexts,
    quoteCitations: options.quoteCitations,
    generatedImages: options.generatedImages,
    figureRender: options.figureRender,
  });
  if (result.noteId && result.noteId > 0) {
    if (options.rememberCreatedNote) {
      rememberAssistantNoteForParent(parentId, result.noteId);
    }
  }
  return "created";
}

export async function createStandaloneNoteFromAssistantText(
  libraryID: number,
  contentText: string,
  modelName: string,
  paperContexts?: PaperContextRef[],
  quoteCitations?: QuoteCitation[],
  generatedImages?: GeneratedChatImage[],
  queryText?: string,
  figureRender?: NoteFigureRenderOptions,
): Promise<"created"> {
  await createAssistantResponseNote({
    destination: { kind: "standalone", libraryID },
    contentText,
    queryText,
    modelName,
    paperContexts,
    quoteCitations,
    generatedImages,
    figureRender,
  });
  return "created";
}

async function buildGeneratedImageHtmlByMessageIndex(
  history: Message[],
  noteId: number,
): Promise<Map<number, string>> {
  const htmlByIndex = new Map<number, string>();
  if (!noteId || noteId <= 0) return htmlByIndex;
  for (let index = 0; index < history.length; index += 1) {
    const msg = history[index];
    if (msg?.role !== "assistant") continue;
    const generatedImages = normalizeEmbeddableGeneratedImages(
      msg.generatedImages,
    );
    if (!generatedImages.length) continue;
    const html = await buildGeneratedImagesHtmlForNote(generatedImages, noteId);
    if (html) htmlByIndex.set(index, html);
  }
  return htmlByIndex;
}

export async function createNoteFromChatHistory(
  item: Zotero.Item,
  history: Message[],
  options: {
    figureRender?: NoteFigureRenderOptions;
  } = {},
): Promise<void> {
  const parentItem = resolveParentItemForNoteTarget(item);
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
  const generatedImageHtmlByMessageIndex =
    await buildGeneratedImageHtmlByMessageIndex(normalizedHistory, noteId);
  const payload = options.figureRender?.doc
    ? await buildChatHistoryNotePayloadForSave(normalizedHistory, {
        noteId,
        generatedImageHtmlByMessageIndex,
        figureRender: options.figureRender,
      })
    : buildChatHistoryNotePayload(normalizedHistory, {
        generatedImageHtmlByMessageIndex,
      });
  note.setNote(payload.noteHtml);
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
  options: {
    figureRender?: NoteFigureRenderOptions;
  } = {},
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
  const generatedImageHtmlByMessageIndex =
    await buildGeneratedImageHtmlByMessageIndex(normalizedHistory, noteId);
  const payload = options.figureRender?.doc
    ? await buildChatHistoryNotePayloadForSave(normalizedHistory, {
        noteId,
        generatedImageHtmlByMessageIndex,
        figureRender: options.figureRender,
      })
    : buildChatHistoryNotePayload(normalizedHistory, {
        generatedImageHtmlByMessageIndex,
      });
  note.setNote(payload.noteHtml);
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
