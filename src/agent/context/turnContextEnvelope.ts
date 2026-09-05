import type {
  AgentRuntimeRequestInput,
  ResolvedAgentRuntimeRequest,
} from "../types";
import type {
  ActiveNoteContext,
  ChatAttachment,
  NoteContextRef,
  PaperContextRef,
  SelectedTextSource,
} from "../../shared/types";
import { safeJsonStringify } from "../../utils/safeJsonStringify";
import {
  buildTurnPaperScope,
  getActiveTurnPaper,
  getSelectedPassagePaper,
  type ResolvedTurnSelectedTextAnchor,
  type ResolvedTurnSelectedTextContext,
  type TurnLocalDocument,
  type TurnPaperRef,
  type TurnPaperRole,
  type TurnPaperScope,
  type TurnPaperScopeWarning,
} from "./turnPaperScope";

type LegacyTurnContextEnvelopeInput = Pick<
  AgentRuntimeRequestInput,
  | "activeItemId"
  | "attachments"
  | "conversationKind"
  | "fullTextPaperContexts"
  | "pdfPaperContexts"
  | "localDocuments"
  | "libraryID"
  | "pinnedPaperContexts"
  | "screenshots"
  | "selectedCollectionContexts"
  | "selectedPaperContexts"
  | "selectedTagContexts"
  | "selectedTextContexts"
  | "selectedTextNoteContexts"
  | "selectedTextPaperContexts"
  | "resolvedSelectedTextAnchors"
  | "selectedTextSources"
  | "selectedTexts"
> & {
  activeNoteContext?: ActiveNoteContext;
  activePaperContext?: PaperContextRef;
  activePaperTitle?: string;
  libraryName?: string;
};

type ResolvedTurnContextEnvelopeInput = Pick<
  ResolvedAgentRuntimeRequest,
  | "activeItemId"
  | "activeNoteContext"
  | "attachments"
  | "conversationKind"
  | "localDocuments"
  | "resolvedSelectedTextAnchors"
  | "screenshots"
  | "selectedTextContexts"
  | "selectedTextNoteContexts"
  | "selectedTextSources"
  | "selectedTexts"
  | "turnPaperScope"
  | "turnPaperScopeWarnings"
  | "zoteroMetadataContext"
> & {
  activePaperTitle?: string;
};

export type TurnContextEnvelopeInput =
  | LegacyTurnContextEnvelopeInput
  | ResolvedTurnContextEnvelopeInput;

export type TurnContextEnvelope = Readonly<{
  paperScope: TurnPaperScope;
  zoteroMetadataContext?: ResolvedAgentRuntimeRequest["zoteroMetadataContext"];
  activeItemId?: number;
  activePaperTitle?: string;
  selectedTextCount: number;
  selectedTextContexts: readonly ResolvedTurnSelectedTextContext[];
  resolvedSelectedTextAnchors: readonly ResolvedTurnSelectedTextAnchor[];
  selectedTextSources: readonly SelectedTextSource[];
  selectedTextLocators: readonly string[];
  selectedTextNotes: readonly Readonly<{
    index: number;
    noteId?: number;
    title: string;
    noteKind: NoteContextRef["noteKind"];
    parentItemId?: number;
  }>[];
  screenshotCount: number;
  attachments: readonly ChatAttachment[];
  localDocuments: readonly TurnLocalDocument[];
  paperScopeWarnings: readonly TurnPaperScopeWarning[];
  activeNote?: Pick<
    ActiveNoteContext,
    "noteId" | "noteKind" | "parentItemId" | "title"
  >;
}>;

function formatSelectionLocator(
  context: ResolvedTurnSelectedTextContext,
  anchor: ResolvedTurnSelectedTextAnchor | undefined,
  paper: TurnPaperRef | undefined,
): string {
  if (context.source !== "pdf") return "";
  const contextItemId =
    normalizeNumber(context.contextItemId) ||
    normalizeNumber(paper?.contextItemId) ||
    anchor?.contextItemId;
  const pageIndex = Number.isFinite(context.pageIndex)
    ? Math.max(0, Math.floor(context.pageIndex as number))
    : anchor?.pageIndex;
  const pageLabel =
    normalizeText(context.pageLabel || anchor?.pageLabel) ||
    (pageIndex !== undefined ? `${pageIndex + 1}` : "");
  return renderFields([
    ["attachmentId", contextItemId],
    ["pageLabel", pageLabel],
    ["pageIndex", pageIndex],
    ["resolution", anchor?.resolution],
  ]);
}

function normalizeText(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

export function buildTurnContextEnvelope(
  input: TurnContextEnvelopeInput,
): TurnContextEnvelope {
  const paperScopeResult =
    "turnPaperScope" in input
      ? {
          ok: true as const,
          scope: input.turnPaperScope,
          selectedTextContexts: input.selectedTextContexts || [],
          resolvedSelectedTextAnchors: input.resolvedSelectedTextAnchors || [],
          localDocuments: input.localDocuments || [],
          warnings: input.turnPaperScopeWarnings || [],
        }
      : buildTurnPaperScope(input);
  if (!paperScopeResult.ok) {
    throw new Error(`${paperScopeResult.code}: ${paperScopeResult.message}`);
  }
  const selectedTextContexts = paperScopeResult.selectedTextContexts;
  const selectedTexts = selectedTextContexts.length
    ? selectedTextContexts.map((context) => context.text)
    : Array.isArray(input.selectedTexts)
      ? input.selectedTexts
      : [];
  const selectedTextSources = selectedTextContexts.length
    ? selectedTextContexts.map((context) => context.source)
    : selectedTexts.map(
        (_, index) => input.selectedTextSources?.[index] || "pdf",
      );
  const anchorsByIndex = new Map(
    paperScopeResult.resolvedSelectedTextAnchors.map((anchor) => [
      anchor.contextIndex,
      anchor,
    ]),
  );
  const selectedTextLocators = selectedTextContexts
    .map((context, index) =>
      formatSelectionLocator(
        context,
        anchorsByIndex.get(index),
        getSelectedPassagePaper(paperScopeResult.scope, index),
      ),
    )
    .filter(Boolean);
  const selectedTextNotes: Array<
    TurnContextEnvelope["selectedTextNotes"][number]
  > = [];
  (input.selectedTextNoteContexts || []).forEach((note, index) => {
    if (!note) return;
    const title = normalizeText(note.title);
    const noteId = normalizeNumber(note.noteItemId);
    const parentItemId = normalizeNumber(note.parentItemId);
    selectedTextNotes.push({
      index: index + 1,
      ...(noteId ? { noteId } : {}),
      title: title || (noteId ? `Note ${noteId}` : "Zotero note"),
      noteKind: note.noteKind,
      ...(parentItemId ? { parentItemId } : {}),
    });
  });
  const activeNote = input.activeNoteContext
    ? {
        noteId: input.activeNoteContext.noteId,
        title: input.activeNoteContext.title,
        noteKind: input.activeNoteContext.noteKind,
        parentItemId: input.activeNoteContext.parentItemId,
      }
    : undefined;

  return {
    paperScope: paperScopeResult.scope,
    zoteroMetadataContext:
      "zoteroMetadataContext" in input
        ? input.zoteroMetadataContext
        : undefined,
    activeItemId: normalizeNumber(input.activeItemId),
    activePaperTitle:
      normalizeText(input.activePaperTitle) ||
      getActiveTurnPaper(paperScopeResult.scope)?.title ||
      undefined,
    selectedTextCount: selectedTexts.length,
    selectedTextContexts,
    resolvedSelectedTextAnchors: paperScopeResult.resolvedSelectedTextAnchors,
    selectedTextSources,
    selectedTextLocators,
    selectedTextNotes,
    screenshotCount: (input.screenshots || []).filter(Boolean).length,
    attachments: (input.attachments || []).filter(Boolean),
    localDocuments: paperScopeResult.localDocuments,
    paperScopeWarnings: paperScopeResult.warnings,
    activeNote,
  };
}

function renderField(label: string, value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  return typeof value === "string"
    ? `${label}="${value}"`
    : `${label}=${String(value)}`;
}

function renderFields(fields: Array<[string, unknown]>): string {
  return fields
    .map(([label, value]) => renderField(label, value))
    .filter(Boolean)
    .join(", ");
}

export function renderTurnContextEnvelopeForModel(
  envelope: TurnContextEnvelope,
): string {
  const lines: string[] = [];
  const activePaper = getActiveTurnPaper(envelope.paperScope);
  const libraryFields = renderFields([
    ["libraryID", envelope.paperScope.libraryID || undefined],
    ["name", envelope.paperScope.libraryName],
    ["scope", envelope.paperScope.conversationKind],
    ["activeItemId", envelope.activeItemId],
    [
      "activePaperTitle",
      envelope.paperScope.papers.length
        ? undefined
        : envelope.activePaperTitle || activePaper?.title,
    ],
  ]);
  if (libraryFields) lines.push(`Library scope: ${libraryFields}`);

  envelope.paperScope.papers.forEach((entry, index) => {
    const paper = entry.paper;
    const projected = envelope.zoteroMetadataContext?.papers.find(
      (candidate) =>
        candidate.itemId === paper.itemId &&
        candidate.contextItemId === paper.contextItemId,
    )?.metadata;
    const contentSource = projected?.contentSource;
    lines.push(
      `Paper ${index + 1}: ${renderFields([
        ["title", projected ? projected.title : paper.title],
        ["creators", projected ? projected.creatorDisplay : paper.firstCreator],
        ["publicationDate", projected?.publicationDate],
        ["year", projected ? projected.year : paper.year],
        ["itemId", paper.itemId],
        ["contextItemId", paper.contextItemId],
        ["citationKey", projected ? projected.citationKey : paper.citationKey],
        ["doi", projected?.doi],
        ["containerTitle", projected?.containerTitle],
        ["containerSourceField", projected?.containerSourceField],
        ["eventTitle", projected?.eventTitle],
        ["eventSourceField", projected?.eventSourceField],
        ["journalAbbreviation", projected?.journalAbbreviation],
        ["source", entry.roles.map(renderPaperRole).join(", ")],
        [
          "contentSourceTitle",
          projected ? contentSource?.title : paper.attachmentTitle,
        ],
        ["contentSourceFilename", contentSource?.filename],
        ["contentSourceType", contentSource?.contentType],
        ["contentSourceMode", paper.contentSourceMode],
        [
          "metadataSource",
          projected?.source === "stored_fallback"
            ? "stored fallback; live Zotero item unavailable"
            : undefined,
        ],
      ])}`,
    );
    for (const warning of projected?.warnings || []) {
      lines.push(`Paper ${index + 1} metadata warning: ${warning.message}`);
    }
  });

  envelope.paperScope.collections.forEach((collection, index) => {
    lines.push(
      `Collection ${index + 1}: ${renderFields([
        ["name", collection.name],
        ["collectionId", collection.collectionId],
        ["libraryID", collection.libraryID],
        ["source", "selected resource pool"],
      ])}`,
    );
  });

  envelope.paperScope.tags.forEach((tag, index) => {
    lines.push(
      `Tag ${index + 1}: ${renderFields([
        ["name", tag.name],
        ["normalizedName", tag.normalizedName],
        ["scope", tag.scope],
        ["libraryID", tag.libraryID],
        ["includeAutomatic", tag.includeAutomatic === true ? true : undefined],
        ["source", "selected resource pool"],
      ])}`,
    );
  });

  if (envelope.selectedTextCount) {
    lines.push(
      `Selected text: count=${envelope.selectedTextCount}, sources=${envelope.selectedTextSources.join(", ")}`,
    );
    if (envelope.paperScope.selectedPassagePaperRefs.length) {
      lines.push(
        `Selected text papers: ${envelope.paperScope.selectedPassagePaperRefs
          .map((entry) => {
            const projected = envelope.zoteroMetadataContext?.papers.find(
              (candidate) =>
                candidate.itemId === entry.paper.itemId &&
                candidate.contextItemId === entry.paper.contextItemId,
            )?.metadata;
            return renderFields([
              ["selection", entry.contextIndex + 1],
              ["title", projected ? projected.title : entry.paper.title],
              ["itemId", entry.paper.itemId],
              ["contextItemId", entry.paper.contextItemId],
            ]);
          })
          .join(" | ")}`,
      );
    }
    if (envelope.selectedTextLocators.length) {
      lines.push(
        `Selected text locators: ${envelope.selectedTextLocators.join(" | ")}`,
      );
    }
    if (envelope.selectedTextNotes.length) {
      lines.push(
        `Selected text notes: ${envelope.selectedTextNotes
          .map((note) =>
            renderFields([
              ["index", note.index],
              ["title", note.title],
              ["noteId", note.noteId],
              ["noteKind", note.noteKind],
              ["parentItemId", note.parentItemId],
            ]),
          )
          .join(" | ")}`,
      );
    }
  }

  if (envelope.attachments.length) {
    lines.push(
      `Attachments: ${envelope.attachments
        .map(
          (attachment, index) =>
            `${index + 1}. ${renderFields([
              ["name", attachment.name],
              ["category", attachment.category],
              ["mimeType", attachment.mimeType],
              ["sizeBytes", attachment.sizeBytes],
            ])}`,
        )
        .join(" | ")}`,
    );
  }

  if (envelope.localDocuments.length) {
    lines.push(
      "Raw PDFs explicitly selected for this turn:",
      ...envelope.localDocuments.map(
        ({ paperKey, resource }, index) =>
          `${index + 1}. paperKey=${paperKey}, sourceKey=${resource.sourceKey}, title=${safeJsonStringify(resource.title)}, name=${safeJsonStringify(resource.name)}, path=${safeJsonStringify(resource.absolutePath)}`,
      ),
      "Read exactly these paths. The current-turn list is authoritative. Do not substitute other Zotero attachments, MinerU full.md, extracted text, generic attachments, or PDF paths from earlier turns.",
    );
  }

  if (envelope.screenshotCount) {
    lines.push(`Screenshots: count=${envelope.screenshotCount}`);
  }

  if (envelope.activeNote) {
    lines.push(
      `Active note: ${renderFields([
        ["title", envelope.activeNote.title],
        ["noteId", envelope.activeNote.noteId],
        ["noteKind", envelope.activeNote.noteKind],
        ["parentItemId", envelope.activeNote.parentItemId],
      ])}`,
    );
  }

  for (const warning of envelope.paperScopeWarnings) {
    lines.push(`Paper scope warning: ${warning.message}`);
  }

  if (!lines.length) return "";
  return [
    "Zotero context for this turn:",
    ...lines,
    'Resolve current-resource references only from the context listed above. "This paper" means the active paper. In Paper Chat, "these papers" or "both papers" means the active paper plus visibly added concrete papers; in Library Chat it means all visibly attached concrete papers. Collections and tags remain lazy resource pools and are never silently included in "these papers". Do not infer missing resource identity from old thread history, citation provenance, retrieved candidates, local PDF transport, or local memory.',
  ].join("\n");
}

function renderPaperRole(role: TurnPaperRole): string {
  if (role === "active") return "active paper";
  if (role === "full_text") return "full-text";
  if (role === "raw_pdf") return "raw PDF";
  return role;
}

export function buildVisibleTurnContextBlock(
  input: TurnContextEnvelopeInput,
): string {
  return renderTurnContextEnvelopeForModel(buildTurnContextEnvelope(input));
}
