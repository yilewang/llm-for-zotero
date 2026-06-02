import type { ActionExecutionContext, ActionRequestContext } from "./types";
import type {
  LibraryItemTarget,
  LibraryPaperTarget,
} from "../services/zoteroGateway";
import type { TagContextRef } from "../../shared/types";
import type {
  PaperScopedActionCollectionCandidate,
  PaperScopedActionInput,
  PaperScopedActionProfile,
  PaperScopedActionTagCandidate,
} from "./paperScopeTypes";

export type {
  PaperScopedActionAllowedScope,
  PaperScopedActionCollectionCandidate,
  PaperScopedActionDefaultEmptyInput,
  PaperScopedActionInput,
  PaperScopedActionPaperRequirement,
  PaperScopedActionProfile,
  PaperScopedActionPromptOption,
  PaperScopedActionTagCandidate,
  PaperScopedActionTargetMode,
} from "./paperScopeTypes";

export type ResolvePaperScopedCommandInputResult =
  | { kind: "input"; input: PaperScopedActionInput }
  | { kind: "scope_required" }
  | { kind: "error"; error: string };

export type PaperScopedSelection = {
  itemIds: number[];
  collectionIds: number[];
  tagContexts: TagContextRef[];
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

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const label = value.trim();
    const key = normalizeText(label);
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

function normalizeTagScopes(
  values: unknown,
): Array<"allTagged" | "untagged"> {
  if (!Array.isArray(values)) return [];
  const out: Array<"allTagged" | "untagged"> = [];
  for (const value of values) {
    if ((value === "allTagged" || value === "untagged") && !out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}

function normalizeTagContext(ref: TagContextRef | undefined): TagContextRef | null {
  if (!ref) return null;
  const libraryID = Number.isFinite(ref.libraryID)
    ? Math.floor(ref.libraryID)
    : 0;
  const scope =
    ref.scope === "allTagged" || ref.scope === "untagged"
      ? ref.scope
      : undefined;
  const name =
    (ref.name || "").trim() ||
    (scope === "allTagged"
      ? "All Tagged"
      : scope === "untagged"
        ? "Untagged"
        : "");
  if (!libraryID || !name) return null;
  const normalizedName =
    (ref.normalizedName || name).trim().toLowerCase() || undefined;
  return {
    name,
    libraryID,
    normalizedName,
    scope,
    includeAutomatic: ref.includeAutomatic === true || undefined,
  };
}

function tagContextKey(ref: TagContextRef): string {
  if (ref.scope) {
    return `${ref.libraryID}:scope:${ref.scope}:${ref.includeAutomatic ? "auto" : "manual"}`;
  }
  return `${ref.libraryID}:tag:${ref.normalizedName || ref.name.toLowerCase()}`;
}

function buildTagContextsFromInput(
  input: PaperScopedActionInput,
  libraryID: number,
): TagContextRef[] {
  const out: TagContextRef[] = [];
  const seen = new Set<string>();
  const add = (ref: TagContextRef): void => {
    const normalized = normalizeTagContext(ref);
    if (!normalized) return;
    const key = tagContextKey(normalized);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(normalized);
  };
  for (const name of input.tagNames || []) {
    add({
      name,
      normalizedName: normalizeText(name),
      libraryID,
      includeAutomatic: input.includeAutomaticTags === true || undefined,
    });
  }
  for (const scope of input.tagScopes || []) {
    add({
      name: scope === "allTagged" ? "All Tagged" : "Untagged",
      libraryID,
      scope,
      includeAutomatic: input.includeAutomaticTags === true || undefined,
    });
  }
  return out;
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
  const tagNames = normalizeStringArray(input?.tagNames);
  const tagScopes = normalizeTagScopes(input?.tagScopes);
  if (tagNames.length) normalized.tagNames = tagNames;
  if (tagScopes.length) normalized.tagScopes = tagScopes;
  if (input?.includeAutomaticTags === true) normalized.includeAutomaticTags = true;
  if (
    input?.scope === "all" ||
    input?.scope === "collection" ||
    input?.scope === "tag"
  ) {
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
  const tagContexts: TagContextRef[] = [];
  const seenTags = new Set<string>();
  for (const entry of requestContext?.selectedTagContexts || []) {
    const normalized = normalizeTagContext(entry);
    if (!normalized) continue;
    const key = tagContextKey(normalized);
    if (seenTags.has(key)) continue;
    seenTags.add(key);
    tagContexts.push(normalized);
  }
  return { itemIds, collectionIds, tagContexts };
}

function buildSelectionScopeInput(
  requestContext: ActionRequestContext | undefined,
): PaperScopedActionInput | null {
  const selection = resolvePaperScopedSelection(requestContext);
  if (
    !selection.itemIds.length &&
    !selection.collectionIds.length &&
    !selection.tagContexts.length
  ) {
    return null;
  }
  const input: PaperScopedActionInput = {};
  if (selection.itemIds.length) input.itemIds = selection.itemIds;
  if (selection.collectionIds.length) input.collectionIds = selection.collectionIds;
  const tagNames = selection.tagContexts
    .filter((entry) => !entry.scope)
    .map((entry) => entry.name);
  const tagScopes = selection.tagContexts
    .map((entry) => entry.scope)
    .filter((scope): scope is "allTagged" | "untagged" => Boolean(scope));
  if (tagNames.length) input.tagNames = tagNames;
  if (tagScopes.length) input.tagScopes = tagScopes;
  if (selection.tagContexts.some((entry) => entry.includeAutomatic === true)) {
    input.includeAutomaticTags = true;
  }
  return input;
}

function describeCollection(candidate: PaperScopedActionCollectionCandidate): string {
  return candidate.path || candidate.name;
}

function describeTag(candidate: PaperScopedActionTagCandidate): string {
  return candidate.name;
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

function resolveTagScopeInput(
  rawName: string,
  tags: PaperScopedActionTagCandidate[],
): ResolvePaperScopedCommandInputResult {
  const normalizedQuery = normalizeText(rawName);
  if (!normalizedQuery) {
    return {
      kind: "error",
      error: "Specify a tag name after the tag scope.",
    };
  }
  if (
    normalizedQuery === "all tagged" ||
    normalizedQuery === "all-tagged" ||
    normalizedQuery === "tagged"
  ) {
    return {
      kind: "input",
      input: { tagScopes: ["allTagged"], scope: "tag" },
    };
  }
  if (normalizedQuery === "untagged" || normalizedQuery === "no tags") {
    return {
      kind: "input",
      input: { tagScopes: ["untagged"], scope: "tag" },
    };
  }
  if (!tags.length) {
    return {
      kind: "input",
      input: { tagNames: [rawName.trim()], scope: "tag" },
    };
  }

  const exactMatches = tags.filter(
    (candidate) => normalizeText(candidate.name) === normalizedQuery,
  );
  const partialMatches = exactMatches.length
    ? exactMatches
    : tags.filter((candidate) =>
        normalizeText(candidate.name).includes(normalizedQuery),
      );

  if (!partialMatches.length) {
    return {
      kind: "error",
      error: `No tag matches "${rawName.trim()}".`,
    };
  }

  if (partialMatches.length > 1) {
    const options = partialMatches
      .slice(0, 3)
      .map((candidate) => describeTag(candidate))
      .join(", ");
    const suffix = partialMatches.length > 3 ? ", ..." : "";
    return {
      kind: "error",
      error: `Tag "${rawName.trim()}" is ambiguous: ${options}${suffix}.`,
    };
  }

  return {
    kind: "input",
    input: {
      tagNames: [partialMatches[0].name],
      scope: "tag",
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
  if (profile.allowedScopes.includes("tag")) {
    suggestions.push('"tag <name>"');
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
  tags: PaperScopedActionTagCandidate[] = [],
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
    normalized === "selected collections" ||
    normalized === "selected tags"
  ) {
    if (!profile.allowedScopes.includes("selection")) {
      return buildUnsupportedScopeError(profile);
    }
    const selectionInput = buildSelectionScopeInput(requestContext);
    if (!selectionInput) {
      return {
        kind: "error",
        error: "No paper, collection, or tag context is selected in this chat.",
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

  const tagMatch = /^(?:for\s+)?tag\s+(.+)$/i.exec(trimmed);
  if (tagMatch) {
    if (!profile.allowedScopes.includes("tag")) {
      return buildUnsupportedScopeError(profile);
    }
    return resolveTagScopeInput(tagMatch[1], tags);
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

function filterTargetsByRequirement(
  targets: PaperScopedActionTarget[],
  profile: PaperScopedActionProfile,
): PaperScopedActionTarget[] {
  if (profile.paperRequirement !== "pdf_backed") return targets;
  return targets.filter((target) => target.hasPdf);
}

function dedupeTargets(
  targets: PaperScopedActionTarget[],
): PaperScopedActionTarget[] {
  const out: PaperScopedActionTarget[] = [];
  const seen = new Set<number>();
  for (const target of targets) {
    if (seen.has(target.itemId)) continue;
    seen.add(target.itemId);
    out.push(target);
  }
  return out;
}

async function listTargetsForTagContexts(
  tagContexts: TagContextRef[],
  ctx: ActionExecutionContext,
  profile: PaperScopedActionProfile,
): Promise<PaperScopedActionTarget[]> {
  const targets: PaperScopedActionTarget[] = [];
  for (const tagContext of tagContexts) {
    const result = await ctx.zoteroGateway.listTagItemTargets({
      libraryID: ctx.libraryID,
      tagContext,
    });
    targets.push(
      ...filterTargetsByRequirement(
        result.items.map(mapBibliographicTarget),
        profile,
      ),
    );
  }
  return targets;
}

async function resolveTargetsForSelection(
  selection: PaperScopedSelection,
  limit: number | undefined,
  ctx: ActionExecutionContext,
  profile: PaperScopedActionProfile,
): Promise<PaperScopedActionTarget[]> {
  const filtered: PaperScopedActionTarget[] = [];
  if (selection.itemIds.length) {
    filtered.push(
      ...filterTargetsByRequirement(
        getTargetsByItemIds(ctx, profile, selection.itemIds),
        profile,
      ),
    );
  }
  if (selection.collectionIds.length) {
    const collectionIdSet = new Set(selection.collectionIds);
    const allTargets = await listAllTargets(ctx, profile, undefined);
    filtered.push(
      ...allTargets.filter((target) =>
        target.collectionIds.some((collectionId) =>
          collectionIdSet.has(collectionId),
        ),
      ),
    );
  }
  if (selection.tagContexts.length) {
    filtered.push(
      ...(await listTargetsForTagContexts(selection.tagContexts, ctx, profile)),
    );
  }
  return applyLimit(dedupeTargets(filtered), limit);
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
  const collectionIds = normalizePositiveIntArray(normalized.collectionIds);
  const explicitSelection: PaperScopedSelection = {
    itemIds: normalizePositiveIntArray(normalized.itemIds),
    collectionIds,
    tagContexts: buildTagContextsFromInput(normalized, ctx.libraryID),
  };

  if (
    explicitSelection.itemIds.length ||
    explicitSelection.collectionIds.length ||
    explicitSelection.tagContexts.length
  ) {
    return applyTargetMode(
      await resolveTargetsForSelection(explicitSelection, limit, ctx, profile),
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
