import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import { sha256Text } from "../store/journalRecoveryBlobStore";
import type {
  ReadObservationCapability,
  TrustedReadObservation,
} from "./readObservationTypes";
import { isCatalogToolName } from "./toolNames";
import { digestReadCapabilities, type ReadScope } from "../digests/readScope";

type Candidate = {
  itemId?: number;
  contextItemId?: number;
  pageIndex?: number;
  sourceFingerprint?: string;
};

type ObservationSeed = {
  source: Candidate;
  capabilities: ReadObservationCapability[];
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positive(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegative(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function candidate(value: unknown): Candidate | null {
  const input = record(value);
  if (!input) return null;
  const paper = record(input.paperContext);
  const result = {
    itemId: positive(paper?.itemId ?? input.itemId ?? input.itemID),
    contextItemId: positive(
      paper?.contextItemId ?? input.contextItemId ?? input.contextItemID,
    ),
    pageIndex: nonNegative(input.pageIndex ?? input.pageHintIndex),
    sourceFingerprint: text(
      input.sourceFingerprint ?? input.documentFingerprint,
    ),
  };
  return result.itemId || result.contextItemId ? result : null;
}

function directRows(result: unknown): unknown[] {
  const output = record(result);
  if (!output) return [];
  // moreResults: the rows a sized list view shows briefly (only views carry
  // it), so the evidence refs of a briefly listed paper stay with it.
  return [
    "results",
    "moreResults",
    "papers",
    "paperMatches",
    "items",
    "snippets",
  ].flatMap((key) =>
    Array.isArray(output[key])
      ? (output[key] as unknown[])
      : record(output[key])
        ? Object.values(output[key] as Record<string, unknown>)
        : [],
  );
}

function rowsAt(result: unknown, key: string): unknown[] {
  const output = record(result);
  if (!output) return [];
  const value = output[key];
  if (Array.isArray(value)) return value;
  return record(value) ? Object.values(value as Record<string, unknown>) : [];
}

function hasText(value: unknown, keys: readonly string[]): boolean {
  const input = record(value);
  return Boolean(
    input &&
    keys.some(
      (key) => typeof input[key] === "string" && input[key].trim().length > 0,
    ),
  );
}

function hasRows(value: unknown, keys: readonly string[]): boolean {
  const input = record(value);
  return Boolean(
    input &&
    keys.some((key) => Array.isArray(input[key]) && input[key].length > 0),
  );
}

function positiveCount(value: unknown, key: string): boolean {
  const input = record(value);
  const count = Number(input?.[key]);
  return Number.isFinite(count) && count > 0;
}

function inputCandidates(input: unknown): Candidate[] {
  const args = record(input) || {};
  const directInput = [
    args.target,
    ...(Array.isArray(args.targets) ? args.targets : []),
  ]
    .map(candidate)
    .filter((entry): entry is Candidate => Boolean(entry));
  const itemIds = Array.isArray(args.itemIds)
    ? args.itemIds.map(positive).filter((id): id is number => Boolean(id))
    : [];
  return [
    ...directInput,
    ...itemIds.map((itemId) => ({ itemId })),
    ...(positive(args.itemId) ? [{ itemId: positive(args.itemId)! }] : []),
  ];
}

function seedRows(
  rows: readonly unknown[],
  capabilities: (row: unknown) => ReadObservationCapability[],
): ObservationSeed[] {
  return rows.flatMap((row) => {
    const source = candidate(row);
    const issued = [...new Set(capabilities(row))];
    return source && issued.length ? [{ source, capabilities: issued }] : [];
  });
}

function observationSeeds(
  toolName: string,
  input: unknown,
  result: unknown,
): ObservationSeed[] {
  const args = record(input) || {};
  const output = record(result) || {};
  if (isCatalogToolName(toolName)) {
    return seedRows(directRows(result), () => ["metadata"]);
  }
  if (toolName === "library_read") {
    return seedRows(directRows(result), (row) => {
      const value = record(row) || {};
      const metadata = record(value.metadata);
      const capabilities: ReadObservationCapability[] = [];
      if (metadata && Object.keys(metadata).length)
        capabilities.push("metadata");
      if (
        hasText(metadata, ["abstract", "abstractNote"]) ||
        hasText(value, ["abstract", "abstractNote"])
      ) {
        capabilities.push("abstract");
      }
      if (
        hasText(value, ["content", "text", "body", "fullText"]) ||
        hasRows(value, ["passages", "snippets", "chunks", "notes"])
      ) {
        capabilities.push("body");
      }
      return capabilities;
    });
  }
  if (toolName === "library_retrieve") {
    const metadata = seedRows(
      [...rowsAt(result, "candidates"), ...rowsAt(result, "paperMatches")],
      () => ["metadata"],
    );
    const snippets = seedRows(rowsAt(result, "snippets"), (row) => {
      const value = record(row) || {};
      if (!hasText(value, ["snippet", "surroundingText", "text"])) return [];
      const sourceKind = String(value.sourceKind || "").toLowerCase();
      if (sourceKind === "abstract") return ["metadata", "abstract"];
      if (["pdf_text", "mineru", "attachment"].includes(sourceKind)) {
        return ["metadata", "body"];
      }
      return ["metadata"];
    });
    return [...metadata, ...snippets];
  }

  if (toolName === "paper_digest") {
    // The MCP host's per-paper reader: each digested row read the paper's
    // text, at body depth when the reader read all of it or at least
    // PAPER_DIGEST_BODY_DEPTH_CHARS, else at abstract depth (as a digest
    // part's observation). Failed and pending papers read nothing, and a
    // row an earlier call of the run already returned (its digest repeated)
    // or reported is not read again.
    return seedRows(rowsAt(result, "papers"), (row) => {
      const value = record(row) || {};
      if (
        value.status !== "digested" ||
        value.alreadyReturned === true ||
        value.alreadyReported === true
      )
        return [];
      const source = record(value.source) || {};
      // A scoped row attests what its scope covered (`readScope.ts`).
      return digestReadCapabilities(
        {
          scope: (record(source.scope) || undefined) as ReadScope | undefined,
          complete: source.complete === true,
          readCharacters: Number(source.readCharacters) || 0,
          covered: Array.isArray(source.covered)
            ? source.covered.filter(
                (entry): entry is string => typeof entry === "string",
              )
            : undefined,
        },
        PAPER_DIGEST_BODY_DEPTH_CHARS,
      );
    });
  }
  const direct = directRows(result);
  const sources = direct.length ? direct : inputCandidates(input);
  const mayUseAggregatePayload = direct.length === 0 && sources.length === 1;
  if (toolName === "paper_read") {
    const mode = String(args.mode || output.mode || "overview");
    if (mode === "figures" && Array.isArray(output.figures)) {
      return seedRows(output.figures, (row) =>
        hasText(row, ["cropPath"]) ? ["figure"] : [],
      );
    }
    // Whole named sections attest the body, or the abstract when that is
    // all they read (`readWholeSections`, paperRead.ts).
    if (output.read === "whole_sections") {
      return seedRows(rowsAt(result, "papers"), (row) => {
        // A section the read budget left out (no characters) was not read.
        const sections = rowsAt(row, "sections")
          .filter((entry) => Number(record(entry)?.characters) > 0)
          .map((entry) => text(record(entry)?.section) || "")
          .filter(Boolean);
        if (!sections.length) return [];
        return sections.every((label) => /^\s*abstract\s*$/i.test(label))
          ? ["abstract"]
          : ["body"];
      });
    }
    const aggregateHasAbstract = hasText(output, ["abstract", "abstractNote"]);
    const aggregateHasBody =
      hasText(output, ["content", "text", "body", "fullText"]) ||
      hasRows(output, ["passages", "snippets", "chunks"]);
    const aggregateHasFigure = hasRows(output, ["figures", "images", "pages"]);
    return seedRows(sources, (row) => {
      const value = record(row) || {};
      const capabilities: ReadObservationCapability[] = [];
      if (mode === "overview") {
        const backend = String(value.backend || "").toLowerCase();
        const sourceKind = String(value.sourceKind || "").toLowerCase();
        if (backend === "zotero_metadata" || sourceKind === "zotero_metadata") {
          capabilities.push("metadata");
          if (
            hasText(value, ["abstract", "abstractNote"]) ||
            /(?:^|\n)Abstract:\s*\S/i.test(String(value.text || ""))
          ) {
            capabilities.push("abstract");
          }
        } else if (hasText(value, ["text", "content", "body"])) {
          capabilities.push("body");
        } else if (mayUseAggregatePayload && aggregateHasAbstract) {
          capabilities.push("abstract");
        }
      }
      if (
        (mode === "targeted" || mode === "full") &&
        ((mayUseAggregatePayload && aggregateHasBody) ||
          hasText(row, ["content", "text", "body", "fullText", "snippet"]) ||
          hasRows(row, ["passages", "snippets", "chunks", "exactEvidence"]) ||
          positiveCount(row, "processedChunks"))
      ) {
        capabilities.push("body");
      }
      if (
        ["figures", "visual", "capture"].includes(mode) &&
        ((mayUseAggregatePayload && aggregateHasFigure) ||
          hasRows(row, ["figures", "images", "pages"]))
      ) {
        capabilities.push("figure");
      }
      return capabilities;
    });
  }
  if (toolName === "read_attachment") {
    const aggregateHasBody = hasText(output, ["content", "text", "body"]);
    return seedRows(sources, (row) =>
      (mayUseAggregatePayload && aggregateHasBody) ||
      hasText(row, ["content", "text", "body"])
        ? ["body"]
        : [],
    );
  }
  return [];
}

/** Equal to `DIGEST_BODY_DEPTH_CHARS` (digestJobHost.ts); a test keeps them equal. */
export const PAPER_DIGEST_BODY_DEPTH_CHARS = 5_000;

function zoteroIdentity(source: Candidate): {
  libraryID: number;
  itemKey: string;
  attachmentItemKey?: string;
} | null {
  const items = globalThis.Zotero?.Items;
  if (!items?.get) return null;
  const contextItem = source.contextItemId
    ? items.get(source.contextItemId)
    : null;
  const bibliographicItem = source.itemId ? items.get(source.itemId) : null;
  const parent = contextItem?.parentID
    ? items.get(Number(contextItem.parentID))
    : null;
  const item = bibliographicItem || parent || contextItem;
  const itemKey = text(item?.key);
  const libraryID = positive(item?.libraryID);
  if (!itemKey || !libraryID) return null;
  // The context item is the file that was read. A standalone PDF is also its
  // own bibliographic item, and its figure assets name it as the attachment,
  // so it is named here too; a regular item is never an attachment.
  const attachment =
    contextItem &&
    item &&
    (contextItem.id !== item.id || contextItem.isAttachment?.())
      ? contextItem
      : null;
  return {
    libraryID,
    itemKey,
    attachmentItemKey: text(attachment?.key),
  };
}

/** The source one read observation covers: its identity and page. */
export function readObservationSourceKey(source: {
  libraryID?: unknown;
  itemKey?: unknown;
  attachmentItemKey?: unknown;
  pageIndex?: unknown;
}): string {
  return `${source.libraryID}:${source.itemKey}:${source.attachmentItemKey || ""}:${source.pageIndex ?? ""}`;
}

/**
 * The sources the rows of `result` would issue observations for, keyed as
 * readObservationSourceKey keys them: what a reduced view of a result still
 * shows, so the evidence refs it carries can follow its rows.
 */
export function readObservationSourceKeys(params: {
  toolName: string;
  input: unknown;
  result: unknown;
}): Set<string> {
  const keys = new Set<string>();
  for (const seed of observationSeeds(
    params.toolName,
    params.input,
    params.result,
  )) {
    const identity = zoteroIdentity(seed.source);
    if (identity) {
      keys.add(
        readObservationSourceKey({
          ...identity,
          pageIndex: seed.source.pageIndex,
        }),
      );
    }
  }
  return keys;
}

/** Host-owned, tool-specific read attestation. Unknown tools intentionally
 * return no trusted source/depth observations. */
export async function createTrustedReadObservations(params: {
  toolName: string;
  callId: string;
  input: unknown;
  result: unknown;
}): Promise<TrustedReadObservation[]> {
  const seeds = observationSeeds(params.toolName, params.input, params.result);
  if (!seeds.length) return [];
  const args = record(params.input) || {};
  const readMode =
    params.toolName === "paper_read"
      ? text(args.mode) || text(record(params.result)?.mode) || "overview"
      : params.toolName === "paper_digest"
        ? "digest"
        : undefined;
  const inputDigest = `sha256:${await sha256Text(canonicalJson(params.input))}`;
  const resultDigest = `sha256:${await sha256Text(canonicalJson(params.result))}`;
  const callDigest = `sha256:${await sha256Text(
    canonicalJson({
      toolName: params.toolName,
      callId: params.callId,
      inputDigest,
    }),
  )}`;
  const grouped = new Map<
    string,
    {
      source: Candidate;
      identity: NonNullable<ReturnType<typeof zoteroIdentity>>;
      capabilities: Set<ReadObservationCapability>;
    }
  >();
  for (const seed of seeds) {
    const identity = zoteroIdentity(seed.source);
    if (!identity) continue;
    const key = readObservationSourceKey({
      ...identity,
      pageIndex: seed.source.pageIndex,
    });
    const existing = grouped.get(key);
    if (existing) {
      for (const capability of seed.capabilities) {
        existing.capabilities.add(capability);
      }
      continue;
    }
    grouped.set(key, {
      source: seed.source,
      identity,
      capabilities: new Set(seed.capabilities),
    });
  }
  const observations: TrustedReadObservation[] = [];
  for (const entry of grouped.values()) {
    const observationId = `${callDigest}:${observations.length + 1}`;
    const unsigned = {
      version: 1 as const,
      observationId,
      issuer: "zotero_host" as const,
      toolName: params.toolName,
      callDigest,
      inputDigest,
      resultDigest,
      ...entry.identity,
      capabilities: [...entry.capabilities],
      pageIndex: entry.source.pageIndex,
      sourceFingerprint: entry.source.sourceFingerprint,
      ...(readMode ? { readMode } : {}),
    };
    observations.push({
      ...unsigned,
      certificateDigest: `sha256:${await sha256Text(canonicalJson(unsigned))}`,
    });
  }
  return observations;
}
