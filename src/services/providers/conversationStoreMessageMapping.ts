declare const Zotero: any;

import type { GeneratedChatImage, QuoteCitation } from "../../shared/types";
import type { StoredChatMessage } from "../../utils/chatStore";
import { normalizeGeneratedChatImages } from "../../shared/generatedImages";
import { buildLatestStoredMessagesQuery } from "../../shared/conversationMessageSql";
import { parseForcedSkillIdsJson } from "../../shared/skillIds";
import {
  normalizeCollectionContextRefs,
  normalizePaperContextRefs,
  normalizeSelectedTextNoteContexts,
  normalizeSelectedTextPaperContexts,
  normalizeSelectedTextSource,
  normalizeTagContextRefs,
  normalizeAttachedConversationRefs,
  synthesizeSelectedTextContexts,
} from "../context/normalizers";
import { normalizeQuoteCitations } from "../quotes/quoteCitations";
import { restoreQuoteSourceFileStates } from "../../shared/quoteLocationStorage";

/**
 * Read a conversation's most recent message rows and map them back into
 * `StoredChatMessage`.
 *
 * Every context column is stored as JSON text, and the row that comes back is
 * whatever an older plugin version wrote: a column can be absent, empty, or
 * unparseable.  So each column is decoded defensively and a column that fails
 * to parse is dropped rather than failing the whole conversation load — a
 * chat history that will not open is a worse outcome than one missing a
 * paper chip.
 *
 * The caller owns everything provider-specific: which table the rows live in,
 * which columns its `SELECT` lists, and the selector that decides which rows
 * belong to the conversation.
 */
export async function loadStoredConversationMessages(config: {
  messagesTable: string;
  selectColumnsSql: string;
  whereSql: string;
  params: unknown[];
  limit: number;
}): Promise<StoredChatMessage[]> {
  const rows = (await Zotero.DB.queryAsync(
    buildLatestStoredMessagesQuery({
      tableName: config.messagesTable,
      selectColumnsSql: config.selectColumnsSql,
      whereSql: config.whereSql,
    }),
    [...config.params, config.limit],
  )) as Array<Record<string, unknown>> | undefined;

  if (!rows?.length) return [];

  const messages: StoredChatMessage[] = [];
  for (const row of rows) {
    const role =
      row.role === "assistant"
        ? "assistant"
        : row.role === "user"
          ? "user"
          : null;
    if (!role) continue;
    const selectedTexts = (() => {
      if (typeof row.selectedTextsJson !== "string" || !row.selectedTextsJson) {
        return typeof row.selectedText === "string" && row.selectedText.trim()
          ? [row.selectedText.trim()]
          : [];
      }
      try {
        const parsed = JSON.parse(row.selectedTextsJson) as unknown;
        return Array.isArray(parsed)
          ? parsed.filter(
              (entry): entry is string =>
                typeof entry === "string" && Boolean(entry.trim()),
            )
          : [];
      } catch {
        return [];
      }
    })();
    const selectedTextSources = (() => {
      if (
        typeof row.selectedTextSourcesJson !== "string" ||
        !row.selectedTextSourcesJson
      ) {
        return undefined;
      }
      try {
        const parsed = JSON.parse(row.selectedTextSourcesJson) as unknown;
        return Array.isArray(parsed)
          ? parsed.map((entry) => normalizeSelectedTextSource(entry))
          : undefined;
      } catch {
        return undefined;
      }
    })();
    const selectedTextPaperContexts = (() => {
      if (
        typeof row.selectedTextPaperContextsJson !== "string" ||
        !row.selectedTextPaperContextsJson
      ) {
        return undefined;
      }
      try {
        const parsed = JSON.parse(row.selectedTextPaperContextsJson) as unknown;
        const normalized = normalizeSelectedTextPaperContexts(
          parsed,
          selectedTexts.length,
        );
        return normalized.some((entry) => Boolean(entry))
          ? normalized
          : undefined;
      } catch {
        return undefined;
      }
    })();
    const selectedTextNoteContexts = (() => {
      if (
        typeof row.selectedTextNoteContextsJson !== "string" ||
        !row.selectedTextNoteContextsJson
      ) {
        return undefined;
      }
      try {
        const parsed = JSON.parse(row.selectedTextNoteContextsJson) as unknown;
        const normalized = normalizeSelectedTextNoteContexts(
          parsed,
          selectedTexts.length,
        );
        return normalized.some((entry) => Boolean(entry))
          ? normalized
          : undefined;
      } catch {
        return undefined;
      }
    })();
    const selectedTextContexts = synthesizeSelectedTextContexts({
      selectedTextContexts: (() => {
        if (
          typeof row.selectedTextContextsJson !== "string" ||
          !row.selectedTextContextsJson
        ) {
          return undefined;
        }
        try {
          return JSON.parse(row.selectedTextContextsJson) as unknown;
        } catch {
          return undefined;
        }
      })(),
      selectedTexts,
      legacySelectedText: row.selectedText,
      selectedTextSources,
      selectedTextPaperContexts,
      selectedTextNoteContexts,
    });
    const paperContexts = (() => {
      if (typeof row.paperContextsJson !== "string" || !row.paperContextsJson)
        return undefined;
      try {
        const parsed = JSON.parse(row.paperContextsJson) as unknown;
        const normalized = normalizePaperContextRefs(parsed);
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const pdfPaperContexts = (() => {
      if (
        typeof row.pdfPaperContextsJson !== "string" ||
        !row.pdfPaperContextsJson
      )
        return undefined;
      try {
        const normalized = normalizePaperContextRefs(
          JSON.parse(row.pdfPaperContextsJson) as unknown,
        ).map((context) => ({
          ...context,
          contentSourceMode: "pdf" as const,
        }));
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const fullTextPaperContexts = (() => {
      if (
        typeof row.fullTextPaperContextsJson !== "string" ||
        !row.fullTextPaperContextsJson
      )
        return undefined;
      try {
        const parsed = JSON.parse(row.fullTextPaperContextsJson) as unknown;
        const normalized = normalizePaperContextRefs(parsed);
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const citationPaperContexts = (() => {
      if (
        typeof row.citationPaperContextsJson !== "string" ||
        !row.citationPaperContextsJson
      )
        return undefined;
      try {
        const parsed = JSON.parse(row.citationPaperContextsJson) as unknown;
        const normalized = normalizePaperContextRefs(parsed);
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const quoteCitations: QuoteCitation[] | undefined = (() => {
      if (typeof row.quoteCitationsJson !== "string" || !row.quoteCitationsJson)
        return undefined;
      try {
        const parsed = JSON.parse(row.quoteCitationsJson) as unknown;
        const normalized = restoreQuoteSourceFileStates(
          parsed,
          normalizeQuoteCitations(parsed),
        );
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const selectedCollectionContexts = (() => {
      if (
        typeof row.collectionContextsJson !== "string" ||
        !row.collectionContextsJson
      )
        return undefined;
      try {
        const normalized = normalizeCollectionContextRefs(
          JSON.parse(row.collectionContextsJson) as unknown,
        );
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const selectedTagContexts = (() => {
      if (typeof row.tagContextsJson !== "string" || !row.tagContextsJson)
        return undefined;
      try {
        const normalized = normalizeTagContextRefs(
          JSON.parse(row.tagContextsJson) as unknown,
        );
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const attachedConversations = (() => {
      if (
        typeof row.attachedConversationsJson !== "string" ||
        !row.attachedConversationsJson
      )
        return undefined;
      try {
        const normalized = normalizeAttachedConversationRefs(
          JSON.parse(row.attachedConversationsJson) as unknown,
        );
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const screenshotImages = (() => {
      if (typeof row.screenshotImages !== "string" || !row.screenshotImages)
        return undefined;
      try {
        const parsed = JSON.parse(row.screenshotImages) as unknown;
        const normalized = Array.isArray(parsed)
          ? parsed.filter(
              (entry): entry is string =>
                typeof entry === "string" && Boolean(entry.trim()),
            )
          : [];
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const attachments = (() => {
      if (typeof row.attachmentsJson !== "string" || !row.attachmentsJson)
        return undefined;
      try {
        const parsed = JSON.parse(row.attachmentsJson) as unknown;
        const normalized = Array.isArray(parsed)
          ? parsed.filter(
              (
                entry,
              ): entry is NonNullable<
                StoredChatMessage["attachments"]
              >[number] =>
                Boolean(entry) &&
                typeof entry === "object" &&
                typeof (entry as { id?: unknown }).id === "string" &&
                Boolean(String((entry as { id?: string }).id || "").trim()),
            )
          : [];
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const generatedImages: GeneratedChatImage[] | undefined = (() => {
      if (
        typeof row.generatedImagesJson !== "string" ||
        !row.generatedImagesJson
      )
        return undefined;
      try {
        const normalized = normalizeGeneratedChatImages(
          JSON.parse(row.generatedImagesJson) as unknown,
        );
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const forcedSkillIds = parseForcedSkillIdsJson(row.forcedSkillIdsJson);

    messages.push({
      id:
        Number.isFinite(Number(row.id)) && Number(row.id) > 0
          ? Math.floor(Number(row.id))
          : undefined,
      role,
      text: typeof row.text === "string" ? row.text : "",
      timestamp: Number.isFinite(Number(row.timestamp))
        ? Math.floor(Number(row.timestamp))
        : Date.now(),
      runMode:
        row.runMode === "agent"
          ? "agent"
          : row.runMode === "chat"
            ? "chat"
            : undefined,
      agentRunId:
        typeof row.agentRunId === "string" ? row.agentRunId : undefined,
      documentId:
        typeof row.documentId === "string" ? row.documentId : undefined,
      selectedText: selectedTextContexts[0]?.text,
      selectedTextContexts: selectedTextContexts.length
        ? selectedTextContexts
        : undefined,
      selectedTexts: selectedTextContexts.length
        ? selectedTextContexts.map((context) => context.text)
        : undefined,
      selectedTextSources: selectedTextContexts.length
        ? selectedTextContexts.map((context) => context.source)
        : undefined,
      selectedTextPaperContexts: selectedTextContexts.length
        ? selectedTextContexts.map((context) => context.paperContext)
        : undefined,
      selectedTextNoteContexts: selectedTextContexts.length
        ? selectedTextContexts.map((context) => context.noteContext)
        : undefined,
      forcedSkillIds:
        role === "user" && forcedSkillIds.length ? forcedSkillIds : undefined,
      paperContexts,
      pdfPaperContexts,
      fullTextPaperContexts,
      citationPaperContexts,
      quoteCitations,
      selectedCollectionContexts,
      selectedTagContexts,
      attachedConversations,
      screenshotImages,
      attachments,
      generatedImages,
      modelName: typeof row.modelName === "string" ? row.modelName : undefined,
      modelEntryId:
        typeof row.modelEntryId === "string" ? row.modelEntryId : undefined,
      modelProviderLabel:
        typeof row.modelProviderLabel === "string"
          ? row.modelProviderLabel
          : undefined,
      interrupted: Number(row.interrupted) === 1 ? true : undefined,
      webchatRunState:
        row.webchatRunState === "done" ||
        row.webchatRunState === "incomplete" ||
        row.webchatRunState === "error"
          ? row.webchatRunState
          : undefined,
      webchatCompletionReason:
        row.webchatCompletionReason === "settled" ||
        row.webchatCompletionReason === "forced_cancel" ||
        row.webchatCompletionReason === "timeout" ||
        row.webchatCompletionReason === "error"
          ? row.webchatCompletionReason
          : null,
      reasoningSummary:
        typeof row.reasoningSummary === "string"
          ? row.reasoningSummary
          : undefined,
      reasoningDetails:
        typeof row.reasoningDetails === "string"
          ? row.reasoningDetails
          : undefined,
      compactMarker: Boolean(row.compactMarker),
      contextTokens:
        Number.isFinite(Number(row.contextTokens)) &&
        Number(row.contextTokens) > 0
          ? Math.floor(Number(row.contextTokens))
          : undefined,
      contextWindow:
        Number.isFinite(Number(row.contextWindow)) &&
        Number(row.contextWindow) > 0
          ? Math.floor(Number(row.contextWindow))
          : undefined,
    });
  }
  return messages;
}
