import { sanitizeText } from "./textUtils";
import {
  libraryIndexService,
  type LibraryIndexItem,
  type LibraryIndexSnapshot,
} from "../../services/libraryIndexService";
import type {
  PaperBrowseCollectionCandidate,
  PaperSearchAttachmentCandidate,
  PaperSearchGroupCandidate,
  PaperSearchTagCandidate,
} from "../../services/libraryIndexDtos";
export type {
  PaperBrowseCollectionCandidate,
  PaperSearchAttachmentCandidate,
  PaperSearchGroupCandidate,
  PaperSearchTagCandidate,
} from "../../services/libraryIndexDtos";

export type PaperSearchSlashToken = {
  query: string;
  slashStart: number;
  caretEnd: number;
};

export type SkillSearchDollarToken = PaperSearchSlashToken;

type IndexedPaperAttachment = {
  contextItemId: number;
  title: string;
  normalizedTitle: string;
  contentType?: string;
};

type IndexedPaperCandidate = {
  itemId: number;
  title: string;
  citationKey?: string;
  firstCreator?: string;
  year?: string;
  attachments: IndexedPaperAttachment[];
  modifiedAt: number;
  addedAt: number;
  collectionIDs: number[];
  tags: string[];
  tagsAuto: string[];
  itemKind?: "standalone-note";
  normalized: {
    title: string;
    shortTitle: string;
    citationKey: string;
    doi: string;
    creator: string;
    venue: string;
    year: string;
  };
};

type IndexedCollection = {
  collectionId: number;
  name: string;
  parentID: number;
  childCollectionIDs: number[];
  childItemIDs: number[];
};

type PaperSearchScore = {
  score: number;
  matchedTokens: Set<string>;
};

type ZoteroTagLike = string | { tag?: unknown; name?: unknown; type?: unknown };

const DEFAULT_PAPER_SEARCH_LIMIT = 20;
const ZOTERO_NOTE_CONTENT_TYPE = "application/x-zotero-note";
const MATCH_FIELD_PRIORITY = [
  "citationKey",
  "doi",
  "title",
  "creator",
  "venue",
  "year",
  "attachmentTitle",
] as const;

function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return sanitizeText(value).trim();
}

function compactPaperSearchText(value: string): string {
  return value.replace(/\s+/g, "");
}

function safeUnicodeNormalize(value: string, form: "NFKD"): string {
  try {
    return value.normalize(form);
  } catch (_err) {
    return value;
  }
}

export function normalizePaperSearchText(value: string): string {
  const text = normalizeText(value);
  if (!text) return "";
  return safeUnicodeNormalize(text, "NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function getSearchTokens(normalizedQuery: string): string[] {
  if (!normalizedQuery) return [];
  return Array.from(new Set(normalizedQuery.split(/\s+/g).filter(Boolean)));
}

function compareByAddedNewestFirst(
  a: PaperSearchGroupCandidate,
  b: PaperSearchGroupCandidate,
): number {
  const addedDelta = (b.addedAt || 0) - (a.addedAt || 0);
  if (addedDelta !== 0) return addedDelta;
  const modifiedDelta = b.modifiedAt - a.modifiedAt;
  if (modifiedDelta !== 0) return modifiedDelta;
  return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
}

function normalizePaperSearchTagName(value: unknown): string | null {
  const name = typeof value === "string" ? value.trim() : "";
  return name ? name : null;
}

export function getPaperSearchItemTagNames(
  item: Zotero.Item | null | undefined,
): {
  manual: string[];
  automatic: string[];
} {
  const manual = new Set<string>();
  const automatic = new Set<string>();
  try {
    const tags = (
      item as { getTags?: () => ZoteroTagLike[] } | null
    )?.getTags?.();
    if (!Array.isArray(tags)) return { manual: [], automatic: [] };
    for (const raw of tags) {
      const rawName =
        typeof raw === "string" ? raw : (raw?.tag ?? raw?.name ?? "");
      const name = normalizePaperSearchTagName(rawName);
      if (!name) continue;
      const type = typeof raw === "string" ? undefined : Number(raw.type);
      if (type === 1) automatic.add(name);
      else manual.add(name);
    }
  } catch {
    /* ignore malformed Zotero tag records */
  }
  return {
    manual: [...manual].sort((a, b) => a.localeCompare(b)),
    automatic: [...automatic].sort((a, b) => a.localeCompare(b)),
  };
}

function resolveLibraryDisplayName(libraryID: number): string {
  try {
    const libraries = (
      Zotero as unknown as {
        Libraries?: {
          getName?: (targetLibraryID: number) => unknown;
          get?: (
            targetLibraryID: number,
          ) => { name?: unknown } | null | undefined;
        };
      }
    ).Libraries;
    const directName = normalizeText(libraries?.getName?.(libraryID));
    if (directName) return directName;
    const library = libraries?.get?.(libraryID);
    const objectName = normalizeText(library?.name);
    if (objectName) return objectName;
  } catch (_err) {
    void _err;
  }
  return "My Library";
}

function indexedCandidateFromLibraryItem(
  snapshot: LibraryIndexSnapshot,
  item: LibraryIndexItem,
  pdfOnly: boolean,
): IndexedPaperCandidate | null {
  if (item.deleted) return null;
  if (pdfOnly && item.kind !== "regular") return null;
  if (!pdfOnly && item.kind === "standalone-attachment") return null;

  const attachmentIds = pdfOnly
    ? snapshot.pdfAttachmentIdsByItemId.get(item.itemId) || []
    : snapshot.childAttachmentIdsByItemId.get(item.itemId) || [];
  const attachments: IndexedPaperAttachment[] = [];
  for (const attachmentId of attachmentIds) {
    const attachment = snapshot.attachmentById.get(attachmentId);
    if (!attachment || (!pdfOnly && attachment.isMineruPackage)) continue;
    attachments.push({
      contextItemId: attachment.attachmentId,
      title: attachment.title,
      normalizedTitle: normalizePaperSearchText(attachment.title),
      contentType: attachment.contentType,
    });
  }
  if (!pdfOnly) {
    for (const noteId of snapshot.childNoteIdsByItemId.get(item.itemId) || []) {
      const note = snapshot.childNoteById.get(noteId);
      if (!note) continue;
      attachments.push({
        contextItemId: note.noteId,
        title: note.title,
        normalizedTitle: normalizePaperSearchText(note.title),
        contentType: ZOTERO_NOTE_CONTENT_TYPE,
      });
    }
  }
  if (item.kind === "standalone-note") {
    attachments.push({
      contextItemId: item.itemId,
      title: item.title,
      normalizedTitle: normalizePaperSearchText(item.title),
      contentType: ZOTERO_NOTE_CONTENT_TYPE,
    });
  }
  if (pdfOnly && !attachments.length) return null;
  const normalized = snapshot.searchableFieldsByItemId.get(item.itemId);
  return {
    itemId: item.itemId,
    title: item.title,
    citationKey: item.citationKey || undefined,
    firstCreator: item.firstCreator || undefined,
    year: item.year || undefined,
    attachments,
    modifiedAt: item.modifiedAt,
    addedAt: item.addedAt,
    collectionIDs: [...item.collectionIds],
    tags: [...item.tags],
    tagsAuto: [...item.automaticTags],
    itemKind: item.kind === "standalone-note" ? "standalone-note" : undefined,
    normalized: {
      title: normalized?.title || normalizePaperSearchText(item.title),
      shortTitle:
        normalized?.shortTitle || normalizePaperSearchText(item.shortTitle),
      citationKey:
        normalized?.citationKey || normalizePaperSearchText(item.citationKey),
      doi: normalized?.doi || normalizePaperSearchText(item.doi),
      creator:
        normalized?.creators ||
        normalizePaperSearchText(item.creators.join(" ")),
      venue: normalized?.venue || normalizePaperSearchText(item.venue),
      year: normalized?.year || normalizePaperSearchText(item.year),
    },
  };
}

function* indexedCandidates(
  snapshot: LibraryIndexSnapshot,
  pdfOnly: boolean,
): Generator<IndexedPaperCandidate> {
  for (const itemId of snapshot.topLevelItemOrder) {
    const item = snapshot.itemById.get(itemId);
    if (!item) continue;
    const candidate = indexedCandidateFromLibraryItem(snapshot, item, pdfOnly);
    if (candidate) yield candidate;
  }
}

function* indexedCollections(
  snapshot: LibraryIndexSnapshot,
): Generator<IndexedCollection> {
  for (const collection of snapshot.collectionById.values()) {
    if (collection.deleted) continue;
    yield {
      collectionId: collection.collectionId,
      name: collection.name,
      parentID: collection.parentCollectionId,
      childCollectionIDs: [
        ...(snapshot.childCollectionIdsByCollectionId.get(
          collection.collectionId,
        ) || []),
      ],
      childItemIDs: [
        ...(snapshot.directItemIdsByCollectionId.get(collection.collectionId) ||
          []),
      ],
    };
  }
}

export function invalidatePaperSearchCache(libraryID?: number): void {
  if (
    typeof libraryID === "number" &&
    Number.isFinite(libraryID) &&
    libraryID > 0
  ) {
    const normalizedLibraryID = Math.floor(libraryID);
    libraryIndexService.invalidate(normalizedLibraryID);
    return;
  }
  libraryIndexService.invalidate();
}

function buildVisibleCandidate(
  candidate: IndexedPaperCandidate,
  excludeContextItemId?: number | null,
): PaperSearchGroupCandidate | null {
  const excludeId =
    typeof excludeContextItemId === "number" &&
    Number.isFinite(excludeContextItemId) &&
    excludeContextItemId > 0
      ? Math.floor(excludeContextItemId)
      : null;
  const attachments = candidate.attachments
    .filter(
      (attachment) => !excludeId || attachment.contextItemId !== excludeId,
    )
    .map((attachment) => ({
      contextItemId: attachment.contextItemId,
      title: attachment.title,
      score: 0,
    }));
  if (!attachments.length) return null;
  return {
    itemId: candidate.itemId,
    title: candidate.title,
    citationKey: candidate.citationKey,
    firstCreator: candidate.firstCreator,
    year: candidate.year,
    attachments,
    score: 0,
    modifiedAt: candidate.modifiedAt,
    addedAt: candidate.addedAt,
    collectionIds: candidate.collectionIDs,
    tags: candidate.tags,
    tagsAuto: candidate.tagsAuto,
  };
}

function scoreNormalizedField(
  value: string,
  query: string,
  exactScore: number,
  prefixScore: number,
  containsScore: number,
): number {
  const scoreSimpleField = (target: string, search: string): number => {
    if (!target || !search) return 0;
    if (target === search) return exactScore;
    if (target.startsWith(search)) return prefixScore;
    if (target.includes(search)) return containsScore;
    return 0;
  };
  if (!value || !query) return 0;
  const rawScore = scoreSimpleField(value, query);
  const compactValue = compactPaperSearchText(value);
  const compactQuery = compactPaperSearchText(query);
  if (
    !compactValue ||
    !compactQuery ||
    (compactValue === value && compactQuery === query)
  ) {
    return rawScore;
  }
  return Math.max(rawScore, scoreSimpleField(compactValue, compactQuery));
}

function getMatchingTokens(value: string, tokens: string[]): string[] {
  if (!value || !tokens.length) return [];
  const compactValue = compactPaperSearchText(value);
  return tokens.filter((token) => {
    if (value.includes(token)) return true;
    return compactValue.includes(compactPaperSearchText(token));
  });
}

function scoreField(
  scoreState: PaperSearchScore,
  value: string,
  query: string,
  tokens: string[],
  options: {
    exact?: number;
    prefix?: number;
    contains?: number;
    tokenBonus?: number;
  },
): number {
  if (!value) return 0;
  const phraseScore = scoreNormalizedField(
    value,
    query,
    options.exact || 0,
    options.prefix || 0,
    options.contains || 0,
  );
  const matchedTokens = getMatchingTokens(value, tokens);
  for (const token of matchedTokens) {
    scoreState.matchedTokens.add(token);
  }
  const tokenScore =
    options.tokenBonus && matchedTokens.length > 0
      ? matchedTokens.length * options.tokenBonus
      : 0;
  return phraseScore + tokenScore;
}

function scoreAttachmentTitle(
  title: string,
  query: string,
  tokens: string[],
): number {
  const normalizedTitle = normalizePaperSearchText(title);
  if (!normalizedTitle) return 0;
  const scoreState: PaperSearchScore = {
    score: 0,
    matchedTokens: new Set<string>(),
  };
  return scoreField(scoreState, normalizedTitle, query, tokens, {
    exact: 640,
    prefix: 600,
    contains: 560,
    tokenBonus: 65,
  });
}

function scoreCandidate(
  candidate: IndexedPaperCandidate,
  visibleCandidate: PaperSearchGroupCandidate,
  query: string,
  tokens: string[],
): { score: number; matchedTokenCount: number } | null {
  const scoreState: PaperSearchScore = {
    score: 0,
    matchedTokens: new Set<string>(),
  };

  let score = 0;
  score += scoreField(
    scoreState,
    candidate.normalized.citationKey,
    query,
    tokens,
    {
      exact: 1200,
      prefix: 1050,
      contains: 900,
      tokenBonus: 110,
    },
  );
  score += scoreField(scoreState, candidate.normalized.doi, query, tokens, {
    exact: 1150,
    prefix: 1000,
    contains: 850,
    tokenBonus: 110,
  });
  score += scoreField(scoreState, candidate.normalized.title, query, tokens, {
    exact: 900,
    prefix: 820,
    contains: 720,
    tokenBonus: 90,
  });
  if (
    scoreNormalizedField(candidate.normalized.shortTitle, query, 1, 1, 1) > 0
  ) {
    score += 500;
    for (const token of getMatchingTokens(
      candidate.normalized.shortTitle,
      tokens,
    )) {
      scoreState.matchedTokens.add(token);
    }
  }
  score += scoreField(scoreState, candidate.normalized.creator, query, tokens, {
    contains: 450,
    tokenBonus: 70,
  });
  score += scoreField(scoreState, candidate.normalized.venue, query, tokens, {
    contains: 280,
    tokenBonus: 45,
  });
  if (candidate.normalized.year === query) {
    score += 220;
    for (const token of getMatchingTokens(candidate.normalized.year, tokens)) {
      scoreState.matchedTokens.add(token);
    }
  } else {
    const yearTokenMatches = getMatchingTokens(
      candidate.normalized.year,
      tokens,
    );
    if (yearTokenMatches.length > 0) {
      score += yearTokenMatches.length * 40;
      for (const token of yearTokenMatches) {
        scoreState.matchedTokens.add(token);
      }
    }
  }

  let bestAttachmentScore = 0;
  for (const attachment of visibleCandidate.attachments) {
    attachment.score = scoreAttachmentTitle(attachment.title, query, tokens);
    bestAttachmentScore = Math.max(bestAttachmentScore, attachment.score);
    if (attachment.score > 0) {
      for (const token of getMatchingTokens(
        normalizePaperSearchText(attachment.title),
        tokens,
      )) {
        scoreState.matchedTokens.add(token);
      }
    }
  }
  score += bestAttachmentScore;

  if (score <= 0) return null;
  if (tokens.length && scoreState.matchedTokens.size === tokens.length) {
    score += 260;
    const titleAndCreatorBlob = [
      candidate.normalized.title,
      candidate.normalized.shortTitle,
      candidate.normalized.creator,
    ]
      .filter(Boolean)
      .join(" ");
    if (
      getMatchingTokens(titleAndCreatorBlob, tokens).length === tokens.length
    ) {
      score += 120;
    }
  }
  return {
    score,
    matchedTokenCount: scoreState.matchedTokens.size,
  };
}

export function parsePaperSearchSlashToken(
  input: string,
  caret: number,
): PaperSearchSlashToken | null {
  const safeInput = sanitizeText(typeof input === "string" ? input : "");
  const normalizedCaret = Number.isFinite(caret)
    ? Math.max(0, Math.min(safeInput.length, Math.floor(caret)))
    : safeInput.length;

  let slashIndex = safeInput.lastIndexOf("/", normalizedCaret - 1);
  while (slashIndex >= 0) {
    if (slashIndex === 0 || /\s/u.test(safeInput[slashIndex - 1] || "")) {
      let tokenEnd = slashIndex + 1;
      while (
        tokenEnd < safeInput.length &&
        !/\s/u.test(safeInput[tokenEnd] || "")
      ) {
        tokenEnd += 1;
      }
      if (normalizedCaret > tokenEnd) {
        return null;
      }
      return {
        query: sanitizeText(
          safeInput.slice(slashIndex + 1, Math.min(normalizedCaret, tokenEnd)),
        ),
        slashStart: slashIndex,
        caretEnd: normalizedCaret,
      };
    }
    slashIndex = safeInput.lastIndexOf("/", slashIndex - 1);
  }
  return null;
}

export function parseSkillSearchDollarToken(
  input: string,
  caret: number,
): SkillSearchDollarToken | null {
  const safeInput = sanitizeText(typeof input === "string" ? input : "");
  const normalizedCaret = Number.isFinite(caret)
    ? Math.max(0, Math.min(safeInput.length, Math.floor(caret)))
    : safeInput.length;

  let dollarIndex = safeInput.lastIndexOf("$", normalizedCaret - 1);
  while (dollarIndex >= 0) {
    if (dollarIndex === 0 || /\s/u.test(safeInput[dollarIndex - 1] || "")) {
      let tokenEnd = dollarIndex + 1;
      while (
        tokenEnd < safeInput.length &&
        /[A-Za-z0-9_-]/u.test(safeInput[tokenEnd] || "")
      ) {
        tokenEnd += 1;
      }
      if (normalizedCaret > tokenEnd) {
        return null;
      }
      return {
        query: sanitizeText(
          safeInput.slice(dollarIndex + 1, Math.min(normalizedCaret, tokenEnd)),
        ),
        slashStart: dollarIndex,
        caretEnd: normalizedCaret,
      };
    }
    dollarIndex = safeInput.lastIndexOf("$", dollarIndex - 1);
  }
  return null;
}

/**
 * Detects an `@token` at or before the caret position.
 * Mirrors parsePaperSearchSlashToken but uses `@` as the trigger character.
 * The returned value reuses the PaperSearchSlashToken shape (slashStart refers
 * to the `@` character position).
 */
export function parseAtSearchToken(
  input: string,
  caret: number,
): PaperSearchSlashToken | null {
  const safeInput = sanitizeText(typeof input === "string" ? input : "");
  const normalizedCaret = Number.isFinite(caret)
    ? Math.max(0, Math.min(safeInput.length, Math.floor(caret)))
    : safeInput.length;

  let atIndex = safeInput.lastIndexOf("@", normalizedCaret - 1);
  while (atIndex >= 0) {
    if (atIndex === 0 || /\s/u.test(safeInput[atIndex - 1] || "")) {
      let tokenEnd = atIndex + 1;
      while (
        tokenEnd < safeInput.length &&
        !/\s/u.test(safeInput[tokenEnd] || "")
      ) {
        tokenEnd += 1;
      }
      if (normalizedCaret > tokenEnd) {
        return null;
      }
      return {
        query: sanitizeText(
          safeInput.slice(atIndex + 1, Math.min(normalizedCaret, tokenEnd)),
        ),
        slashStart: atIndex,
        caretEnd: normalizedCaret,
      };
    }
    atIndex = safeInput.lastIndexOf("@", atIndex - 1);
  }
  return null;
}

export async function browsePaperCollectionCandidates(
  libraryID: number,
  excludeContextItemId?: number | null,
): Promise<PaperBrowseCollectionCandidate[]> {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return [];
  const snapshot = await libraryIndexService.getSnapshot(Math.floor(libraryID));
  const visibleCandidates = new Map<number, PaperSearchGroupCandidate>();
  const unfiledPapers: PaperSearchGroupCandidate[] = [];
  for (const candidate of indexedCandidates(snapshot, true)) {
    const visible = buildVisibleCandidate(candidate, excludeContextItemId);
    if (visible) {
      visibleCandidates.set(candidate.itemId, visible);
      if (candidate.collectionIDs.length === 0) unfiledPapers.push(visible);
    }
  }

  const collections = [...indexedCollections(snapshot)];
  const collectionMap = new Map<number, PaperBrowseCollectionCandidate>();
  for (const collection of collections) {
    collectionMap.set(collection.collectionId, {
      collectionId: collection.collectionId,
      name: collection.name,
      childCollections: [],
      papers: [],
    });
  }

  for (const collection of collections) {
    const node = collectionMap.get(collection.collectionId);
    if (!node) continue;
    for (const childCollectionID of collection.childCollectionIDs) {
      const child = collectionMap.get(childCollectionID);
      if (child) {
        node.childCollections.push(child);
      }
    }
    for (const childItemID of collection.childItemIDs) {
      const candidate = visibleCandidates.get(childItemID);
      if (candidate) {
        node.papers.push(candidate);
      }
    }
  }

  const topLevelCollections: PaperBrowseCollectionCandidate[] = [];
  for (const collection of collections) {
    const node = collectionMap.get(collection.collectionId);
    if (!node) continue;
    if (!collection.parentID || !collectionMap.has(collection.parentID)) {
      topLevelCollections.push(node);
    }
  }

  unfiledPapers.sort(compareByAddedNewestFirst);

  if (unfiledPapers.length) {
    topLevelCollections.push({
      collectionId: 0,
      name: resolveLibraryDisplayName(libraryID),
      childCollections: [],
      papers: unfiledPapers,
    });
  }

  return topLevelCollections;
}

export async function listLibraryPaperCandidates(
  libraryID: number,
  excludeContextItemId?: number | null,
  limit?: number,
): Promise<PaperSearchGroupCandidate[]> {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return [];
  const snapshot = await libraryIndexService.getSnapshot(Math.floor(libraryID));
  const visibleCandidates: PaperSearchGroupCandidate[] = [];
  for (const candidate of indexedCandidates(snapshot, true)) {
    const visible = buildVisibleCandidate(candidate, excludeContextItemId);
    if (visible) visibleCandidates.push(visible);
  }
  visibleCandidates.sort((a, b) => {
    const modifiedDelta = b.modifiedAt - a.modifiedAt;
    if (modifiedDelta !== 0) return modifiedDelta;
    return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  });
  if (Number.isFinite(limit) && typeof limit === "number" && limit > 0) {
    return visibleCandidates.slice(0, Math.floor(limit));
  }
  return visibleCandidates;
}

export async function searchPaperCandidates(
  libraryID: number,
  query: string,
  excludeContextItemId?: number | null,
  limit = DEFAULT_PAPER_SEARCH_LIMIT,
): Promise<PaperSearchGroupCandidate[]> {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return [];
  const normalizedQuery = normalizePaperSearchText(query);
  if (!normalizedQuery) return [];

  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.floor(limit))
    : DEFAULT_PAPER_SEARCH_LIMIT;
  const queryTokens = getSearchTokens(normalizedQuery);
  if (!queryTokens.length) return [];

  const snapshot = await libraryIndexService.getSnapshot(Math.floor(libraryID));
  const rankedCandidates: Array<{
    candidate: PaperSearchGroupCandidate;
    matchedTokenCount: number;
  }> = [];

  for (const indexedCandidate of indexedCandidates(snapshot, true)) {
    const visibleCandidate = buildVisibleCandidate(
      indexedCandidate,
      excludeContextItemId,
    );
    if (!visibleCandidate) continue;
    const scored = scoreCandidate(
      indexedCandidate,
      visibleCandidate,
      normalizedQuery,
      queryTokens,
    );
    if (!scored) continue;
    visibleCandidate.score = scored.score;
    visibleCandidate.attachments.sort((a, b) => {
      const scoreDelta = b.score - a.score;
      if (scoreDelta !== 0) return scoreDelta;
      return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    });
    rankedCandidates.push({
      candidate: visibleCandidate,
      matchedTokenCount: scored.matchedTokenCount,
    });
  }

  rankedCandidates.sort((a, b) => {
    const scoreDelta = b.candidate.score - a.candidate.score;
    if (scoreDelta !== 0) return scoreDelta;
    const matchedTokenDelta = b.matchedTokenCount - a.matchedTokenCount;
    if (matchedTokenDelta !== 0) return matchedTokenDelta;
    return b.candidate.modifiedAt - a.candidate.modifiedAt;
  });

  return rankedCandidates
    .slice(0, normalizedLimit)
    .map((entry) => entry.candidate);
}

export function invalidateAllItemsSearchCache(libraryID?: number): void {
  if (
    typeof libraryID === "number" &&
    Number.isFinite(libraryID) &&
    libraryID > 0
  ) {
    const id = Math.floor(libraryID);
    libraryIndexService.invalidate(id);
    return;
  }
  libraryIndexService.invalidate();
}

function buildVisibleItemCandidate(
  candidate: IndexedPaperCandidate,
): PaperSearchGroupCandidate {
  return {
    itemId: candidate.itemId,
    title: candidate.title,
    citationKey: candidate.citationKey,
    firstCreator: candidate.firstCreator,
    year: candidate.year,
    itemKind: candidate.itemKind,
    attachments: candidate.attachments.map((att) => ({
      contextItemId: att.contextItemId,
      title: att.title,
      score: 0,
      contentType: att.contentType,
    })),
    score: 0,
    modifiedAt: candidate.modifiedAt,
    addedAt: candidate.addedAt,
    collectionIds: candidate.collectionIDs,
    tags: candidate.tags,
    tagsAuto: candidate.tagsAuto,
  };
}

export async function listAllItemCandidates(
  libraryID: number,
  limit?: number,
): Promise<PaperSearchGroupCandidate[]> {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return [];
  const snapshot = await libraryIndexService.getSnapshot(Math.floor(libraryID));
  const candidates = [...indexedCandidates(snapshot, false)].map((candidate) =>
    buildVisibleItemCandidate(candidate),
  );
  candidates.sort((a, b) => {
    const delta = b.modifiedAt - a.modifiedAt;
    if (delta !== 0) return delta;
    return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  });
  if (Number.isFinite(limit) && typeof limit === "number" && limit > 0) {
    return candidates.slice(0, Math.floor(limit));
  }
  return candidates;
}

export async function searchAllItemCandidates(
  libraryID: number,
  query: string,
  limit = DEFAULT_PAPER_SEARCH_LIMIT,
): Promise<PaperSearchGroupCandidate[]> {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return [];
  const normalizedQuery = normalizePaperSearchText(query);
  if (!normalizedQuery) return [];
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.floor(limit))
    : DEFAULT_PAPER_SEARCH_LIMIT;
  const queryTokens = getSearchTokens(normalizedQuery);
  if (!queryTokens.length) return [];

  const snapshot = await libraryIndexService.getSnapshot(Math.floor(libraryID));
  const rankedCandidates: Array<{
    candidate: PaperSearchGroupCandidate;
    matchedTokenCount: number;
  }> = [];

  for (const indexedCandidate of indexedCandidates(snapshot, false)) {
    const visibleCandidate = buildVisibleItemCandidate(indexedCandidate);
    const scored = scoreCandidate(
      indexedCandidate,
      visibleCandidate,
      normalizedQuery,
      queryTokens,
    );
    if (!scored) continue;
    visibleCandidate.score = scored.score;
    rankedCandidates.push({
      candidate: visibleCandidate,
      matchedTokenCount: scored.matchedTokenCount,
    });
  }

  rankedCandidates.sort((a, b) => {
    const scoreDelta = b.candidate.score - a.candidate.score;
    if (scoreDelta !== 0) return scoreDelta;
    const matchedTokenDelta = b.matchedTokenCount - a.matchedTokenCount;
    if (matchedTokenDelta !== 0) return matchedTokenDelta;
    return b.candidate.modifiedAt - a.candidate.modifiedAt;
  });

  return rankedCandidates.slice(0, normalizedLimit).map((e) => e.candidate);
}

export { ZOTERO_NOTE_CONTENT_TYPE };

const DEFAULT_COLLECTION_SEARCH_LIMIT = 5;
const DEFAULT_TAG_SEARCH_LIMIT = 5;

export async function searchCollectionCandidates(
  libraryID: number,
  query: string,
  limit = DEFAULT_COLLECTION_SEARCH_LIMIT,
): Promise<PaperBrowseCollectionCandidate[]> {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return [];
  const normalizedQuery = normalizePaperSearchText(query);
  if (!normalizedQuery) return [];
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.floor(limit))
    : DEFAULT_COLLECTION_SEARCH_LIMIT;
  const queryTokens = getSearchTokens(normalizedQuery);
  if (!queryTokens.length) return [];

  const snapshot = await libraryIndexService.getSnapshot(Math.floor(libraryID));
  const ranked: Array<{
    collection: IndexedCollection;
    score: number;
    matchedTokenCount: number;
  }> = [];

  for (const collection of indexedCollections(snapshot)) {
    const normalizedName = normalizePaperSearchText(collection.name);
    if (!normalizedName) continue;
    const scoreState: PaperSearchScore = { score: 0, matchedTokens: new Set() };
    const nameScore = scoreField(
      scoreState,
      normalizedName,
      normalizedQuery,
      queryTokens,
      { exact: 1000, prefix: 900, contains: 700, tokenBonus: 80 },
    );
    if (nameScore <= 0) continue;
    ranked.push({
      collection,
      score: nameScore,
      matchedTokenCount: scoreState.matchedTokens.size,
    });
  }

  ranked.sort((a, b) => {
    const scoreDelta = b.score - a.score;
    if (scoreDelta !== 0) return scoreDelta;
    const matchedTokenDelta = b.matchedTokenCount - a.matchedTokenCount;
    if (matchedTokenDelta !== 0) return matchedTokenDelta;
    return a.collection.name.localeCompare(b.collection.name, undefined, {
      sensitivity: "base",
    });
  });

  return ranked.slice(0, normalizedLimit).map((e) => ({
    collectionId: e.collection.collectionId,
    name: e.collection.name,
    childCollections: [],
    papers: [],
  }));
}

export async function searchTagCandidates(
  libraryID: number,
  query: string,
  limit = DEFAULT_TAG_SEARCH_LIMIT,
): Promise<PaperSearchTagCandidate[]> {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return [];
  const normalizedQuery = normalizePaperSearchText(query);
  if (!normalizedQuery) return [];
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.floor(limit))
    : DEFAULT_TAG_SEARCH_LIMIT;
  const queryTokens = getSearchTokens(normalizedQuery);
  if (!queryTokens.length) return [];

  const snapshot = await libraryIndexService.getSnapshot(Math.floor(libraryID));
  const ranked = new Map<
    string,
    {
      name: string;
      itemIds: Set<number>;
      manualItemIds: Set<number>;
      automaticItemIds: Set<number>;
      score: number;
      matchedTokenCount: number;
    }
  >();

  const addTag = (
    candidate: IndexedPaperCandidate,
    rawName: string,
    isAutomatic: boolean,
  ): void => {
    const name = normalizePaperSearchTagName(rawName);
    if (!name) return;
    const normalizedName = normalizePaperSearchText(name);
    if (!normalizedName) return;
    const scoreState: PaperSearchScore = {
      score: 0,
      matchedTokens: new Set<string>(),
    };
    const tagScore = scoreField(
      scoreState,
      normalizedName,
      normalizedQuery,
      queryTokens,
      { exact: 1000, prefix: 900, contains: 700, tokenBonus: 80 },
    );
    if (tagScore <= 0) return;

    let entry = ranked.get(name);
    if (!entry) {
      entry = {
        name,
        itemIds: new Set<number>(),
        manualItemIds: new Set<number>(),
        automaticItemIds: new Set<number>(),
        score: tagScore,
        matchedTokenCount: scoreState.matchedTokens.size,
      };
      ranked.set(name, entry);
    }
    entry.itemIds.add(candidate.itemId);
    if (isAutomatic) entry.automaticItemIds.add(candidate.itemId);
    else entry.manualItemIds.add(candidate.itemId);
    entry.score = Math.max(entry.score, tagScore);
    entry.matchedTokenCount = Math.max(
      entry.matchedTokenCount,
      scoreState.matchedTokens.size,
    );
  };

  for (const candidate of indexedCandidates(snapshot, false)) {
    for (const tag of candidate.tags) addTag(candidate, tag, false);
    for (const tag of candidate.tagsAuto) addTag(candidate, tag, true);
  }

  return [...ranked.values()]
    .sort((a, b) => {
      const scoreDelta = b.score - a.score;
      if (scoreDelta !== 0) return scoreDelta;
      const matchedTokenDelta = b.matchedTokenCount - a.matchedTokenCount;
      if (matchedTokenDelta !== 0) return matchedTokenDelta;
      const countDelta = b.itemIds.size - a.itemIds.size;
      if (countDelta !== 0) return countDelta;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    })
    .slice(0, normalizedLimit)
    .map((entry) => ({
      name: entry.name,
      normalizedName: entry.name,
      count: entry.itemIds.size,
      includeAutomatic: entry.automaticItemIds.size > 0,
      isAutomatic:
        entry.automaticItemIds.size > 0 && entry.manualItemIds.size === 0,
      score: entry.score,
    }));
}

export async function browseAllItemCandidates(
  libraryID: number,
): Promise<PaperBrowseCollectionCandidate[]> {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return [];
  const snapshot = await libraryIndexService.getSnapshot(Math.floor(libraryID));
  const visibleCandidates = new Map<number, PaperSearchGroupCandidate>();
  const unfiledItems: PaperSearchGroupCandidate[] = [];
  for (const candidate of indexedCandidates(snapshot, false)) {
    const visible = buildVisibleItemCandidate(candidate);
    visibleCandidates.set(candidate.itemId, visible);
    if (candidate.collectionIDs.length === 0) unfiledItems.push(visible);
  }

  const collections = [...indexedCollections(snapshot)];
  const collectionMap = new Map<number, PaperBrowseCollectionCandidate>();
  for (const collection of collections) {
    collectionMap.set(collection.collectionId, {
      collectionId: collection.collectionId,
      name: collection.name,
      childCollections: [],
      papers: [],
    });
  }

  for (const collection of collections) {
    const node = collectionMap.get(collection.collectionId);
    if (!node) continue;
    for (const childCollectionID of collection.childCollectionIDs) {
      const child = collectionMap.get(childCollectionID);
      if (child) node.childCollections.push(child);
    }
    for (const childItemID of collection.childItemIDs) {
      const candidate = visibleCandidates.get(childItemID);
      if (candidate) node.papers.push(candidate);
    }
  }

  const topLevelCollections: PaperBrowseCollectionCandidate[] = [];
  for (const collection of collections) {
    const node = collectionMap.get(collection.collectionId);
    if (!node) continue;
    if (!collection.parentID || !collectionMap.has(collection.parentID)) {
      topLevelCollections.push(node);
    }
  }

  unfiledItems.sort(compareByAddedNewestFirst);

  if (unfiledItems.length) {
    topLevelCollections.push({
      collectionId: 0,
      name: resolveLibraryDisplayName(libraryID),
      childCollections: [],
      papers: unfiledItems,
    });
  }

  return topLevelCollections;
}
