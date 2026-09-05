import type {
  CollectionContextRef,
  LocalDocumentResource,
  NoteContextRef,
  PaperContextRef,
  ResolvedSelectedTextAnchor,
  SelectedTextContext,
  SelectedTextSource,
  TagContextRef,
} from "../../shared/types";
import { isAbsoluteLocalPath } from "../../utils/localPath";

export type TurnPaperKey = `${number}:${number}:${number}`;

export type TurnPaperRef = Readonly<
  PaperContextRef & {
    libraryID: number;
  }
>;

export type TurnPaperRole =
  | "active"
  | "selected"
  | "full_text"
  | "raw_pdf"
  | "pinned";

export type TurnScopedPaper = Readonly<{
  paper: TurnPaperRef;
  roles: readonly TurnPaperRole[];
}>;

export type SelectedPassagePaperRef = Readonly<{
  contextIndex: number;
  paper: TurnPaperRef;
}>;

export type TurnPaperScope = Readonly<{
  libraryID: number;
  libraryName?: string;
  conversationKind: "global" | "paper";
  papers: readonly TurnScopedPaper[];
  collections: readonly Readonly<CollectionContextRef>[];
  tags: readonly Readonly<TagContextRef>[];
  selectedPassagePaperRefs: readonly SelectedPassagePaperRef[];
}>;

export type ResolvedTurnSelectedTextContext = Readonly<
  Omit<SelectedTextContext, "paperContext">
>;

export type ResolvedTurnSelectedTextAnchor = Readonly<
  Omit<ResolvedSelectedTextAnchor, "paperContext">
>;

export type TurnLocalDocument = Readonly<{
  paperKey: TurnPaperKey;
  resource: LocalDocumentResource;
}>;

export type TurnPaperScopeWarning = Readonly<{
  code: "missing_selected_passage_paper";
  contextIndex: number;
  message: string;
}>;

export type TurnPaperScopeInput = Readonly<{
  libraryID?: number;
  libraryName?: string;
  conversationKind?: "global" | "paper";
  activeItemId?: number;
  activePaperContext?: PaperContextRef;
  selectedPaperContexts?: readonly PaperContextRef[];
  pdfPaperContexts?: readonly PaperContextRef[];
  fullTextPaperContexts?: readonly PaperContextRef[];
  pinnedPaperContexts?: readonly PaperContextRef[];
  selectedCollectionContexts?: readonly CollectionContextRef[];
  selectedTagContexts?: readonly TagContextRef[];
  selectedTextContexts?: readonly SelectedTextContext[];
  selectedTexts?: readonly string[];
  selectedTextSources?: readonly SelectedTextSource[];
  selectedTextNoteContexts?: readonly (NoteContextRef | undefined)[];
  selectedTextPaperContexts?: readonly (PaperContextRef | undefined)[];
  resolvedSelectedTextAnchors?: readonly ResolvedSelectedTextAnchor[];
  localDocuments?: readonly LocalDocumentResource[];
  resolvePaperContext?: (selector: {
    itemId?: number;
    contextItemId?: number;
  }) => PaperContextRef | null;
}>;

export type TurnPaperScopeBuildResult =
  | Readonly<{
      ok: true;
      scope: TurnPaperScope;
      selectedTextContexts: readonly ResolvedTurnSelectedTextContext[];
      resolvedSelectedTextAnchors: readonly ResolvedTurnSelectedTextAnchor[];
      localDocuments: readonly TurnLocalDocument[];
      warnings: readonly TurnPaperScopeWarning[];
    }>
  | Readonly<{
      ok: false;
      code: "invalid_turn_paper_scope" | "invalid_turn_pdf_transport";
      message: string;
      resourceIndex?: number;
      resourceKind?: "paper" | "collection" | "tag" | "local_document";
    }>;

function normalizePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function normalizeText(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function buildTurnPaperKey(
  paper: Pick<TurnPaperRef, "libraryID" | "itemId" | "contextItemId">,
): TurnPaperKey {
  return `${Math.floor(paper.libraryID)}:${Math.floor(
    paper.itemId,
  )}:${Math.floor(paper.contextItemId)}`;
}

export function getSelectedPassagePaper(
  scope: TurnPaperScope,
  contextIndex: number,
): TurnPaperRef | undefined {
  return scope.selectedPassagePaperRefs.find(
    (entry) => entry.contextIndex === contextIndex,
  )?.paper;
}

function normalizePaper(
  paper: Partial<PaperContextRef> | undefined,
  libraryID: number,
): TurnPaperRef | null {
  if (!paper) return null;
  const itemId = normalizePositiveInt(paper.itemId);
  const contextItemId = normalizePositiveInt(paper.contextItemId);
  const paperLibraryID = normalizePositiveInt(paper.libraryID);
  if (
    !itemId ||
    !contextItemId ||
    !libraryID ||
    (paperLibraryID !== undefined && paperLibraryID !== libraryID)
  ) {
    return null;
  }
  return {
    libraryID: paperLibraryID || libraryID,
    itemId,
    contextItemId,
    title: normalizeText(paper.title) || `Paper ${itemId}`,
    attachmentTitle: normalizeText(paper.attachmentTitle) || undefined,
    citationKey: normalizeText(paper.citationKey) || undefined,
    firstCreator: normalizeText(paper.firstCreator) || undefined,
    year: normalizeText(paper.year) || undefined,
    contentSourceMode: paper.contentSourceMode,
    mineruCacheDir: normalizeText(paper.mineruCacheDir) || undefined,
  };
}

function normalizePaperWithResolver(
  paper: Partial<PaperContextRef> | undefined,
  libraryID: number,
  resolvePaperContext: TurnPaperScopeInput["resolvePaperContext"],
): TurnPaperRef | null {
  const normalized = normalizePaper(paper, libraryID);
  if (normalized || !paper || !resolvePaperContext) return normalized;
  const itemId = normalizePositiveInt(paper.itemId);
  const contextItemId = normalizePositiveInt(paper.contextItemId);
  if (!itemId && !contextItemId) return null;
  return normalizePaper(
    resolvePaperContext({ itemId, contextItemId }) || undefined,
    libraryID,
  );
}

function mergePaper(existing: TurnPaperRef, next: TurnPaperRef): TurnPaperRef {
  return {
    ...existing,
    title: existing.title || next.title,
    attachmentTitle: existing.attachmentTitle || next.attachmentTitle,
    citationKey: existing.citationKey || next.citationKey,
    firstCreator: existing.firstCreator || next.firstCreator,
    year: existing.year || next.year,
    contentSourceMode: existing.contentSourceMode || next.contentSourceMode,
    mineruCacheDir: existing.mineruCacheDir || next.mineruCacheDir,
  };
}

function normalizeCollections(
  collections: readonly CollectionContextRef[] | undefined,
  libraryID: number,
):
  | { ok: true; collections: readonly Readonly<CollectionContextRef>[] }
  | { ok: false; index: number; message: string } {
  const out: Readonly<CollectionContextRef>[] = [];
  const seen = new Set<string>();
  for (const [index, collection] of (collections || []).entries()) {
    const collectionId = normalizePositiveInt(collection?.collectionId);
    const collectionLibraryID = normalizePositiveInt(collection?.libraryID);
    if (!collectionId || !collectionLibraryID) {
      return {
        ok: false,
        index,
        message: `Selected collection ${index + 1} has an invalid identity. Remove or reselect it.`,
      };
    }
    if (libraryID && collectionLibraryID !== libraryID) {
      return {
        ok: false,
        index,
        message: `Selected collection ${index + 1} belongs to a different Zotero library. Remove or reselect it.`,
      };
    }
    const key = `${collectionLibraryID}:${collectionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      collectionId,
      libraryID: collectionLibraryID,
      name: normalizeText(collection.name) || `Collection ${collectionId}`,
    });
  }
  return { ok: true, collections: out };
}

function normalizeTags(
  tags: readonly TagContextRef[] | undefined,
  libraryID: number,
):
  | { ok: true; tags: readonly Readonly<TagContextRef>[] }
  | { ok: false; index: number; message: string } {
  const out: Readonly<TagContextRef>[] = [];
  const seen = new Set<string>();
  for (const [index, tag] of (tags || []).entries()) {
    const tagLibraryID = normalizePositiveInt(tag?.libraryID);
    const name = normalizeText(tag?.name);
    const normalizedName = normalizeText(tag?.normalizedName);
    const scope = tag?.scope;
    if (
      !tagLibraryID ||
      (!name && scope !== "allTagged" && scope !== "untagged")
    ) {
      return {
        ok: false,
        index,
        message: `Selected tag ${index + 1} has an invalid identity. Remove or reselect it.`,
      };
    }
    if (libraryID && tagLibraryID !== libraryID) {
      return {
        ok: false,
        index,
        message: `Selected tag ${index + 1} belongs to a different Zotero library. Remove or reselect it.`,
      };
    }
    const key = [
      tagLibraryID,
      scope || "",
      normalizedName || name.toLocaleLowerCase(),
      tag.includeAutomatic === true ? "auto" : "manual",
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      libraryID: tagLibraryID,
      normalizedName: normalizedName || undefined,
      scope,
      includeAutomatic: tag.includeAutomatic === true || undefined,
    });
  }
  return { ok: true, tags: out };
}

export function buildTurnPaperScope(
  input: TurnPaperScopeInput,
): TurnPaperScopeBuildResult {
  const libraryID =
    normalizePositiveInt(input.libraryID) ||
    normalizePositiveInt(input.activePaperContext?.libraryID) ||
    normalizePositiveInt(input.selectedCollectionContexts?.[0]?.libraryID) ||
    normalizePositiveInt(input.selectedTagContexts?.[0]?.libraryID) ||
    0;
  const activeItemId = normalizePositiveInt(input.activeItemId);
  const allConcretePapers = [
    input.activePaperContext,
    ...(input.selectedPaperContexts || []),
    ...(input.fullTextPaperContexts || []),
    ...(input.pdfPaperContexts || []),
    ...(input.pinnedPaperContexts || []),
  ].filter((paper): paper is PaperContextRef => Boolean(paper));
  if (allConcretePapers.length && !libraryID) {
    return {
      ok: false,
      code: "invalid_turn_paper_scope",
      message:
        "The selected paper context has no active Zotero library. Reselect the paper and retry.",
      resourceKind: "paper",
    };
  }

  const papers: Array<{
    paper: TurnPaperRef;
    roles: TurnPaperRole[];
  }> = [];
  const indexByKey = new Map<TurnPaperKey, number>();
  const pushPaper = (
    paper: PaperContextRef | undefined,
    role: TurnPaperRole,
    resourceIndex?: number,
  ): TurnPaperScopeBuildResult | null => {
    if (!paper) return null;
    const normalized = normalizePaperWithResolver(
      paper,
      libraryID,
      input.resolvePaperContext,
    );
    if (!normalized) {
      return {
        ok: false,
        code: "invalid_turn_paper_scope",
        message: `Selected paper ${(resourceIndex ?? 0) + 1} has an invalid identity. Remove or reselect it.`,
        resourceIndex,
        resourceKind: "paper",
      };
    }
    const key = buildTurnPaperKey(normalized);
    const existingIndex = indexByKey.get(key);
    if (existingIndex !== undefined) {
      const existing = papers[existingIndex];
      papers[existingIndex] = {
        paper: mergePaper(existing.paper, normalized),
        roles: existing.roles.includes(role)
          ? existing.roles
          : [...existing.roles, role],
      };
      return null;
    }
    indexByKey.set(key, papers.length);
    papers.push({ paper: normalized, roles: [role] });
    return null;
  };

  const activePaper =
    input.activePaperContext ||
    (input.conversationKind === "paper" && activeItemId
      ? allConcretePapers.find(
          (paper) =>
            paper.itemId === activeItemId ||
            paper.contextItemId === activeItemId,
        )
      : undefined);
  const activeFailure = pushPaper(activePaper, "active");
  if (activeFailure) return activeFailure;
  for (const [index, paper] of (input.selectedPaperContexts || []).entries()) {
    if (
      activePaper &&
      paper.itemId === activePaper.itemId &&
      paper.contextItemId === activePaper.contextItemId
    ) {
      continue;
    }
    const failure = pushPaper(paper, "selected", index);
    if (failure) return failure;
  }
  for (const [index, paper] of (input.fullTextPaperContexts || []).entries()) {
    const failure = pushPaper(paper, "full_text", index);
    if (failure) return failure;
  }
  for (const [index, paper] of (input.pdfPaperContexts || []).entries()) {
    const failure = pushPaper(paper, "raw_pdf", index);
    if (failure) return failure;
  }
  for (const [index, paper] of (input.pinnedPaperContexts || []).entries()) {
    const failure = pushPaper(paper, "pinned", index);
    if (failure) return failure;
  }

  const collectionsResult = normalizeCollections(
    input.selectedCollectionContexts,
    libraryID,
  );
  if (!collectionsResult.ok) {
    return {
      ok: false,
      code: "invalid_turn_paper_scope",
      message: collectionsResult.message,
      resourceIndex: collectionsResult.index,
      resourceKind: "collection",
    };
  }
  const tagsResult = normalizeTags(input.selectedTagContexts, libraryID);
  if (!tagsResult.ok) {
    return {
      ok: false,
      code: "invalid_turn_paper_scope",
      message: tagsResult.message,
      resourceIndex: tagsResult.index,
      resourceKind: "tag",
    };
  }

  const rawSelectedTextContexts: readonly SelectedTextContext[] = input
    .selectedTextContexts?.length
    ? input.selectedTextContexts
    : (input.selectedTexts || []).map((text, contextIndex) => ({
        text,
        source: input.selectedTextSources?.[contextIndex] || "pdf",
        noteContext: input.selectedTextNoteContexts?.[contextIndex],
        paperContext: undefined,
      }));
  const selectedTextContexts: ResolvedTurnSelectedTextContext[] = [];
  const selectedPassagePaperRefs: SelectedPassagePaperRef[] = [];
  const warnings: TurnPaperScopeWarning[] = [];
  rawSelectedTextContexts.forEach((context, contextIndex) => {
    const { paperContext: nestedPaperContext, ...resolvedContext } = context;
    selectedTextContexts.push(resolvedContext);
    const anchorPaperContext = input.resolvedSelectedTextAnchors?.find(
      (anchor) => anchor.contextIndex === contextIndex,
    )?.paperContext;
    const candidates = [
      nestedPaperContext,
      input.selectedTextPaperContexts?.[contextIndex],
      anchorPaperContext,
    ].filter((paper): paper is PaperContextRef => Boolean(paper));
    const normalizedCandidates = candidates
      .map((paper) =>
        normalizePaperWithResolver(paper, libraryID, input.resolvePaperContext),
      )
      .filter((paper): paper is TurnPaperRef => Boolean(paper));
    const candidateKeys = new Set(normalizedCandidates.map(buildTurnPaperKey));
    if (candidateKeys.size > 1) {
      warnings.push({
        code: "missing_selected_passage_paper",
        contextIndex,
        message: `Selected passage ${contextIndex + 1} contains conflicting paper identities. The passage remains available, but whole-paper follow-up requires an explicit paper target.`,
      });
      return;
    }
    const sourcePaper = candidates[0];
    if (!sourcePaper) return;
    const normalized = normalizedCandidates[0];
    if (!normalized) {
      warnings.push({
        code: "missing_selected_passage_paper",
        contextIndex,
        message: `Selected passage ${contextIndex + 1} has no resolvable paper identity. The passage remains available, but whole-paper follow-up requires an explicit paper target.`,
      });
      return;
    }
    selectedPassagePaperRefs.push({ contextIndex, paper: normalized });
  });

  const resolvedSelectedTextAnchors: ResolvedTurnSelectedTextAnchor[] = (
    input.resolvedSelectedTextAnchors || []
  ).map(({ paperContext: _paperContext, ...anchor }) => anchor);
  const scope: TurnPaperScope = {
    libraryID,
    libraryName: normalizeText(input.libraryName) || undefined,
    conversationKind: input.conversationKind === "paper" ? "paper" : "global",
    papers,
    collections: collectionsResult.collections,
    tags: tagsResult.tags,
    selectedPassagePaperRefs,
  };

  const rawPdfByKey = new Map<TurnPaperKey, TurnScopedPaper>();
  for (const paper of papers) {
    if (!paper.roles.includes("raw_pdf")) continue;
    rawPdfByKey.set(buildTurnPaperKey(paper.paper), paper);
  }
  const localDocuments: TurnLocalDocument[] = [];
  const seenLocalDocuments = new Set<TurnPaperKey>();
  for (const [index, resource] of (input.localDocuments || []).entries()) {
    const itemId = normalizePositiveInt(resource?.itemId);
    const contextItemId = normalizePositiveInt(resource?.contextItemId);
    if (!libraryID || !itemId || !contextItemId) {
      return {
        ok: false,
        code: "invalid_turn_pdf_transport",
        message: `Raw PDF resource ${index + 1} has an invalid paper identity. Reselect it and retry.`,
        resourceIndex: index,
        resourceKind: "local_document",
      };
    }
    const paperKey = buildTurnPaperKey({
      libraryID,
      itemId,
      contextItemId,
    });
    const expectedSourceKey = `zotero-pdf:${itemId}:${contextItemId}`;
    if (
      resource.kind !== "local_pdf" ||
      resource.mimeType !== "application/pdf" ||
      resource.sourceKey !== expectedSourceKey ||
      !isAbsoluteLocalPath(resource.absolutePath) ||
      !resource.absolutePath.trim()
    ) {
      return {
        ok: false,
        code: "invalid_turn_pdf_transport",
        message: `Raw PDF resource ${index + 1} has invalid provider transport metadata. Reselect it and retry.`,
        resourceIndex: index,
        resourceKind: "local_document",
      };
    }
    if (!rawPdfByKey.has(paperKey)) {
      return {
        ok: false,
        code: "invalid_turn_pdf_transport",
        message: `Raw PDF resource ${index + 1} is not linked to a selected raw-PDF paper. Reselect it and retry.`,
        resourceIndex: index,
        resourceKind: "local_document",
      };
    }
    if (seenLocalDocuments.has(paperKey)) {
      return {
        ok: false,
        code: "invalid_turn_pdf_transport",
        message: `Raw PDF resource ${index + 1} duplicates an existing paper transport. Reselect it and retry.`,
        resourceIndex: index,
        resourceKind: "local_document",
      };
    }
    seenLocalDocuments.add(paperKey);
    localDocuments.push({ paperKey, resource });
  }
  if (
    input.localDocuments?.length &&
    seenLocalDocuments.size !== rawPdfByKey.size
  ) {
    return {
      ok: false,
      code: "invalid_turn_pdf_transport",
      message:
        "Raw PDF provider transport is missing a local document for one or more selected raw-PDF papers. Reselect the papers and retry.",
      resourceKind: "local_document",
    };
  }

  return {
    ok: true,
    scope,
    selectedTextContexts,
    resolvedSelectedTextAnchors,
    localDocuments,
    warnings,
  };
}

export function listTurnPaperRefs(
  scope: TurnPaperScope,
): readonly TurnPaperRef[] {
  return scope.papers.map((entry) => entry.paper);
}

export function listTurnPapersWithRoles(
  scope: TurnPaperScope,
  roles: readonly TurnPaperRole[],
): readonly TurnPaperRef[] {
  return scope.papers
    .filter((entry) => entry.roles.some((role) => roles.includes(role)))
    .map((entry) => entry.paper);
}

export function getActiveTurnPaper(
  scope: TurnPaperScope,
): TurnPaperRef | undefined {
  return scope.papers.find((entry) => entry.roles.includes("active"))?.paper;
}
