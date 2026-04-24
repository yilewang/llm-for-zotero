import type { ActionExecutionContext, ActionRequestContext } from "./types";
import type {
  LibraryItemTarget,
  LibraryPaperTarget,
} from "../services/zoteroGateway";

export type PaperScopedActionTargetMode = "single" | "multi" | "single_or_multi";
export type PaperScopedActionAllowedScope =
  | "current"
  | "selection"
  | "collection"
  | "all";
export type PaperScopedActionDefaultEmptyInput =
  | "current"
  | "selection_or_prompt"
  | "prompt";
export type PaperScopedActionPaperRequirement = "bibliographic" | "pdf_backed";

export type PaperScopedActionInput = {
  itemId?: number;
  itemIds?: number[];
  collectionId?: number;
  collectionIds?: number[];
  scope?: "all" | "collection";
  limit?: number;
};

export type PaperScopedActionPromptOption = {
  label: string;
  input: PaperScopedActionInput;
};

export type PaperScopedActionProfile = {
  targetMode: PaperScopedActionTargetMode;
  allowedScopes: PaperScopedActionAllowedScope[];
  defaultEmptyInput: PaperScopedActionDefaultEmptyInput;
  paperRequirement: PaperScopedActionPaperRequirement;
  supportsLimit: boolean;
  scopePromptOptions?: {
    first?: PaperScopedActionPromptOption;
    all?: PaperScopedActionPromptOption;
  };
};

export type PaperScopedActionCollectionCandidate = {
  collectionId: number;
  name: string;
  path?: string;
};

export type ResolvePaperScopedCommandInputResult =
  | { kind: "input"; input: PaperScopedActionInput }
  | { kind: "scope_required" }
  | { kind: "error"; error: string };

export type PaperScopedSelection = {
  itemIds: number[];
  collectionIds: number[];
};

export type PaperScopedActionTarget = {
  itemId: number;
  title: string;
  firstCreator?: string;
  year?: string;
  tags: string[];
  collectionIds: number[];
  hasPdf: boolean;
};

function normalizeText(value: string | undefined): string {
  return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizePositiveIntArray(
  values: Array<number | undefined> | undefined,
): number[] {
  if (!Array.isArray(values)) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    if (!Number.isFinite(value) || !value || value <= 0) continue;
    const normalized = Math.floor(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function normalizeLimit(value: number | undefined): number | undefined {
  return Number.isFinite(value) && value && value > 0
    ? Math.max(1, Math.floor(value))
    : undefined;
}

export function applyLimit<T>(values: T[], limit: number | undefined): T[] {
  if (!limit || values.length <= limit) return values;
  return values.slice(0, limit);
}

export function normalizePaperScopedActionInput(
  input: PaperScopedActionInput | undefined,
): PaperScopedActionInput {
  const itemIds = normalizePositiveIntArray([
    ...(Array.isArray(input?.itemIds) ? input!.itemIds : []),
    input?.itemId,
  ]);
  const collectionIds = normalizePositiveIntArray([
    ...(Array.isArray(input?.collectionIds) ? input!.collectionIds : []),
    input?.collectionId,
  ]);
  const normalized: PaperScopedActionInput = {};
  if (itemIds.length) normalized.itemIds = itemIds;
  if (collectionIds.length) normalized.collectionIds = collectionIds;
  if (input?.scope === "all" || input?.scope === "collection") {
    normalized.scope = input.scope;
  }
  const limit = normalizeLimit(input?.limit);
  if (limit) normalized.limit = limit;
  return normalized;
}

export function resolvePaperScopedSelection(
  requestContext: ActionRequestContext | undefined,
): PaperScopedSelection {
  const itemIds = normalizePositiveIntArray([
    ...((requestContext?.selectedPaperContexts || []).map((entry) => entry.itemId)),
    ...((requestContext?.fullTextPaperContexts || []).map((entry) => entry.itemId)),
  ]);
  const collectionIds = normalizePositiveIntArray(
    (requestContext?.selectedCollectionContexts || []).map(
      (entry) => entry.collectionId,
    ),
  );
  return { itemIds, collectionIds };
}

function buildSelectionScopeInput(
  requestContext: ActionRequestContext | undefined,
): PaperScopedActionInput | null {
  const selection = resolvePaperScopedSelection(requestContext);
  if (!selection.itemIds.length && !selection.collectionIds.length) {
    return null;
  }
  const input: PaperScopedActionInput = {};
  if (selection.itemIds.length) input.itemIds = selection.itemIds;
  if (selection.collectionIds.length) input.collectionIds = selection.collectionIds;
  return input;
}

function describeCollection(candidate: PaperScopedActionCollectionCandidate): string {
  return candidate.path || candidate.name;
}

function resolveCollectionScopeInput(
  rawName: string,
  collections: PaperScopedActionCollectionCandidate[],
): ResolvePaperScopedCommandInputResult {
  const normalizedQuery = normalizeText(rawName);
  if (!normalizedQuery) {
    return {
      kind: "error",
      error: "Specify a collection name after the collection scope.",
    };
  }

  const exactMatches = collections.filter((candidate) => {
    const path = normalizeText(candidate.path);
    const name = normalizeText(candidate.name);
    return path === normalizedQuery || name === normalizedQuery;
  });
  const partialMatches = exactMatches.length
    ? exactMatches
    : collections.filter((candidate) => {
        const path = normalizeText(candidate.path);
        const name = normalizeText(candidate.name);
        return path.includes(normalizedQuery) || name.includes(normalizedQuery);
      });

  if (!partialMatches.length) {
    return {
      kind: "error",
      error: `No collection matches "${rawName.trim()}".`,
    };
  }

  if (partialMatches.length > 1) {
    const options = partialMatches
      .slice(0, 3)
      .map((candidate) => describeCollection(candidate))
      .join(", ");
    const suffix = partialMatches.length > 3 ? ", ..." : "";
    return {
      kind: "error",
      error: `Collection "${rawName.trim()}" is ambiguous: ${options}${suffix}.`,
    };
  }

  return {
    kind: "input",
    input: {
      collectionIds: [partialMatches[0].collectionId],
    },
  };
}

function resolveDefaultInput(
  profile: PaperScopedActionProfile,
  requestContext: ActionRequestContext | undefined,
): ResolvePaperScopedCommandInputResult {
  if (
    requestContext?.mode === "paper" &&
    requestContext.activeItemId &&
    profile.allowedScopes.includes("current") &&
    profile.defaultEmptyInput !== "prompt"
  ) {
    return {
      kind: "input",
      input: { itemIds: [requestContext.activeItemId] },
    };
  }

  if (
    profile.defaultEmptyInput === "selection_or_prompt" &&
    profile.allowedScopes.includes("selection")
  ) {
    const selectionInput = buildSelectionScopeInput(requestContext);
    if (selectionInput) {
      return {
        kind: "input",
        input: selectionInput,
      };
    }
  }

  if (
    profile.defaultEmptyInput === "current" &&
    requestContext?.activeItemId &&
    profile.allowedScopes.includes("current")
  ) {
    return {
      kind: "input",
      input: { itemIds: [requestContext.activeItemId] },
    };
  }

  return { kind: "scope_required" };
}

function buildUnsupportedScopeError(
  profile: PaperScopedActionProfile,
): ResolvePaperScopedCommandInputResult {
  const suggestions: string[] = [];
  if (profile.allowedScopes.includes("current")) {
    suggestions.push('"this paper"');
  }
  if (profile.allowedScopes.includes("selection")) {
    suggestions.push('"selection"');
  }
  if (profile.allowedScopes.includes("all")) {
    if (profile.supportsLimit) suggestions.push('"first 20 papers"');
    suggestions.push('"all library"');
  }
  if (profile.allowedScopes.includes("collection")) {
    suggestions.push('"collection <name>"');
  }
  const message = suggestions.length
    ? `Unsupported scope. Use ${suggestions.join(", ")}.`
    : "Unsupported scope for this action.";
  return { kind: "error", error: message };
}

export function resolvePaperScopedCommandInput(
  params: string,
  requestContext: ActionRequestContext | undefined,
  profile: PaperScopedActionProfile,
  collections: PaperScopedActionCollectionCandidate[],
): ResolvePaperScopedCommandInputResult {
  const trimmed = params.trim();
  if (!trimmed) {
    return resolveDefaultInput(profile, requestContext);
  }

  const normalized = normalizeText(trimmed);
  if (
    normalized === "this paper" ||
    normalized === "current paper"
  ) {
    if (!profile.allowedScopes.includes("current")) {
      return buildUnsupportedScopeError(profile);
    }
    if (!requestContext?.activeItemId) {
      return {
        kind: "error",
        error: "No active paper is available in this chat.",
      };
    }
    return {
      kind: "input",
      input: { itemIds: [requestContext.activeItemId] },
    };
  }

  if (
    normalized === "selection" ||
    normalized === "selected papers" ||
    normalized === "selected items" ||
    normalized === "selected collections"
  ) {
    if (!profile.allowedScopes.includes("selection")) {
      return buildUnsupportedScopeError(profile);
    }
    const selectionInput = buildSelectionScopeInput(requestContext);
    if (!selectionInput) {
      return {
        kind: "error",
        error: "No paper or collection context is selected in this chat.",
      };
    }
    return { kind: "input", input: selectionInput };
  }

  const firstMatch = /^(?:for\s+)?(?:first|top)\s+(\d+)\s+papers?$/i.exec(trimmed);
  if (firstMatch || (profile.supportsLimit && /^(\d+)$/.exec(trimmed))) {
    if (!profile.allowedScopes.includes("all") || !profile.supportsLimit) {
      return buildUnsupportedScopeError(profile);
    }
    const match = firstMatch || /^(\d+)$/.exec(trimmed);
    return {
      kind: "input",
      input: {
        scope: "all",
        limit: Math.max(1, Math.floor(Number(match?.[1]) || 0)),
      },
    };
  }

  if (
    normalized === "all" ||
    normalized === "all library" ||
    normalized === "whole library" ||
    normalized === "entire library"
  ) {
    if (!profile.allowedScopes.includes("all")) {
      return buildUnsupportedScopeError(profile);
    }
    return {
      kind: "input",
      input: { scope: "all" },
    };
  }

  const collectionMatch = /^(?:for\s+)?collection\s+(.+)$/i.exec(trimmed);
  if (collectionMatch) {
    if (!profile.allowedScopes.includes("collection")) {
      return buildUnsupportedScopeError(profile);
    }
    return resolveCollectionScopeInput(collectionMatch[1], collections);
  }

  return buildUnsupportedScopeError(profile);
}

function mapPaperTarget(target: LibraryPaperTarget): PaperScopedActionTarget {
  return {
    itemId: target.itemId,
    title: target.title,
    firstCreator: target.firstCreator,
    year: target.year,
    tags: Array.isArray(target.tags) ? target.tags : [],
    collectionIds: Array.isArray(target.collectionIds) ? target.collectionIds : [],
    hasPdf: true,
  };
}

function mapBibliographicTarget(target: LibraryItemTarget): PaperScopedActionTarget {
  return {
    itemId: target.itemId,
    title: target.title,
    firstCreator: target.firstCreator,
    year: target.year,
    tags: Array.isArray(target.tags) ? target.tags : [],
    collectionIds: Array.isArray(target.collectionIds) ? target.collectionIds : [],
    hasPdf: Array.isArray(target.attachments)
      ? target.attachments.some(
          (attachment) => attachment.contentType === "application/pdf",
        )
      : false,
  };
}

async function listAllTargets(
  ctx: ActionExecutionContext,
  profile: PaperScopedActionProfile,
  limit: number | undefined,
): Promise<PaperScopedActionTarget[]> {
  if (profile.paperRequirement === "pdf_backed") {
    const result = await ctx.zoteroGateway.listLibraryPaperTargets({
      libraryID: ctx.libraryID,
      limit,
    });
    return result.papers.map(mapPaperTarget);
  }
  const result = await ctx.zoteroGateway.listBibliographicItemTargets({
    libraryID: ctx.libraryID,
    limit,
  });
  return result.items.map(mapBibliographicTarget);
}

function getTargetsByItemIds(
  ctx: ActionExecutionContext,
  profile: PaperScopedActionProfile,
  itemIds: number[],
): PaperScopedActionTarget[] {
  if (profile.paperRequirement === "pdf_backed") {
    return ctx.zoteroGateway.getPaperTargetsByItemIds(itemIds).map(mapPaperTarget);
  }
  return ctx.zoteroGateway
    .getBibliographicItemTargetsByItemIds(itemIds)
    .map(mapBibliographicTarget);
}

async function resolveTargetsForSelection(
  selection: PaperScopedSelection,
  limit: number | undefined,
  ctx: ActionExecutionContext,
  profile: PaperScopedActionProfile,
): Promise<PaperScopedActionTarget[]> {
  const itemIdSet = new Set(selection.itemIds);
  const collectionIdSet = new Set(selection.collectionIds);
  const allTargets = await listAllTargets(ctx, profile, undefined);
  const filtered = allTargets.filter((target) =>
    itemIdSet.has(target.itemId) ||
    target.collectionIds.some((collectionId) => collectionIdSet.has(collectionId)),
  );
  return applyLimit(filtered, limit);
}

function applyTargetMode(
  targets: PaperScopedActionTarget[],
  profile: PaperScopedActionProfile,
  limit: number | undefined,
): PaperScopedActionTarget[] {
  if (profile.targetMode === "single") {
    return applyLimit(targets, 1);
  }
  return applyLimit(targets, limit);
}

function resolveImplicitInput(
  profile: PaperScopedActionProfile,
  requestContext: ActionRequestContext | undefined,
): PaperScopedActionInput | null {
  const resolved = resolveDefaultInput(profile, requestContext);
  return resolved.kind === "input" ? resolved.input : null;
}

export async function resolvePaperScopedActionTargets(
  input: PaperScopedActionInput | undefined,
  ctx: ActionExecutionContext,
  profile: PaperScopedActionProfile,
): Promise<PaperScopedActionTarget[]> {
  const normalized = normalizePaperScopedActionInput(input);
  const limit = normalizeLimit(normalized.limit);

  if (normalized.itemIds?.length) {
    return applyTargetMode(
      getTargetsByItemIds(ctx, profile, normalized.itemIds),
      profile,
      limit,
    );
  }

  const collectionIds = normalizePositiveIntArray(normalized.collectionIds);
  if (collectionIds.length) {
    return applyTargetMode(
      await resolveTargetsForSelection(
        { itemIds: [], collectionIds },
        limit,
        ctx,
        profile,
      ),
      profile,
      limit,
    );
  }

  if (normalized.scope === "all") {
    return applyTargetMode(
      await listAllTargets(ctx, profile, limit),
      profile,
      limit,
    );
  }

  const implicitInput = resolveImplicitInput(profile, ctx.requestContext);
  if (implicitInput) {
    return resolvePaperScopedActionTargets(
      { ...implicitInput, limit },
      ctx,
      profile,
    );
  }

  return applyTargetMode(
    await listAllTargets(ctx, profile, limit),
    profile,
    limit,
  );
}
