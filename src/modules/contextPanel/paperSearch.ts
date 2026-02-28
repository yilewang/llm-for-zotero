import type { PaperContextRef } from "./types";
import { sanitizeText } from "./textUtils";

export type PaperSearchAttachmentCandidate = {
  contextItemId: number;
  title: string;
  score: number;
};

export type PaperSearchGroupCandidate = Omit<
  PaperContextRef,
  "contextItemId"
> & {
  attachments: PaperSearchAttachmentCandidate[];
  score: number;
  modifiedAt: number;
};

export type PaperSearchSlashToken = {
  query: string;
  slashStart: number;
  caretEnd: number;
};

export type PaperBrowseCollectionCandidate = {
  collectionId: number;
  name: string;
  childCollections: PaperBrowseCollectionCandidate[];
  papers: PaperSearchGroupCandidate[];
};

type IndexedPaperAttachment = {
  contextItemId: number;
  title: string;
  normalizedTitle: string;
};

type IndexedPaperCandidate = {
  itemId: number;
  title: string;
  citationKey?: string;
  firstCreator?: string;
  year?: string;
  attachments: IndexedPaperAttachment[];
  modifiedAt: number;
  collectionIDs: number[];
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

type PaperSearchLibraryIndex = {
  libraryID: number;
  candidates: IndexedPaperCandidate[];
  collections: IndexedCollection[];
};

type PaperSearchScore = {
  score: number;
  matchedTokens: Set<string>;
};

const DEFAULT_PAPER_SEARCH_LIMIT = 20;
const MATCH_FIELD_PRIORITY = [
  "citationKey",
  "doi",
  "title",
  "creator",
  "venue",
  "year",
  "attachmentTitle",
] as const;

const paperSearchLibraryIndexCache = new Map<number, PaperSearchLibraryIndex>();
const paperSearchLibraryLoadTasks = new Map<
  number,
  Promise<PaperSearchLibraryIndex>
>();

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

function extractYear(value: string): string | undefined {
  const match = value.match(/\b(19|20)\d{2}\b/);
  return match?.[0];
}

function toModifiedTimestamp(value: unknown): number {
  const text = normalizeText(value);
  if (!text) return 0;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getItemFieldText(
  item: Zotero.Item,
  field: _ZoteroTypes.Item.ItemField,
): string {
  try {
    return normalizeText(item.getField(field));
  } catch (_err) {
    return "";
  }
}

function getPdfChildAttachments(item: Zotero.Item): Zotero.Item[] {
  const out: Zotero.Item[] = [];
  if (!item?.isRegularItem?.()) return out;
  const attachments = item.getAttachments();
  for (const attachmentId of attachments) {
    const attachment = Zotero.Items.get(attachmentId);
    if (
      attachment &&
      attachment.isAttachment() &&
      attachment.attachmentContentType === "application/pdf"
    ) {
      out.push(attachment);
    }
  }
  return out;
}

function resolveAttachmentTitle(
  attachment: Zotero.Item,
  index: number,
  total: number,
): string {
  const title = getItemFieldText(attachment, "title");
  if (title) return title;
  const filename = normalizeText(
    (attachment as unknown as { attachmentFilename?: string })
      .attachmentFilename || "",
  );
  if (filename) return filename;
  if (total > 1) return `PDF ${index + 1}`;
  return "PDF";
}

function buildIndexedAttachments(
  attachments: Zotero.Item[],
): IndexedPaperAttachment[] {
  return attachments.map((attachment, index) => {
    const title = resolveAttachmentTitle(attachment, index, attachments.length);
    return {
      contextItemId: attachment.id,
      title,
      normalizedTitle: normalizePaperSearchText(title),
    };
  });
}

function getCreatorDisplayName(
  creator: _ZoteroTypes.Item.Creator | null | undefined,
): string {
  if (!creator) return "";
  const parts = [normalizeText(creator.firstName), normalizeText(creator.lastName)]
    .filter(Boolean)
    .join(" ")
    .trim();
  return parts || normalizeText(creator.lastName);
}

function collectCreators(item: Zotero.Item): string[] {
  const creators: string[] = [];
  const seen = new Set<string>();
  try {
    const rawCreators = item.getCreators();
    for (const creator of rawCreators) {
      const name = getCreatorDisplayName(creator);
      const normalizedName = normalizePaperSearchText(name);
      if (!normalizedName || seen.has(normalizedName)) continue;
      seen.add(normalizedName);
      creators.push(name);
    }
  } catch (_err) {
    void _err;
  }
  const firstCreator =
    normalizeText(item.firstCreator) || getItemFieldText(item, "firstCreator");
  const normalizedFirst = normalizePaperSearchText(firstCreator);
  if (normalizedFirst && !seen.has(normalizedFirst)) {
    creators.unshift(firstCreator);
  }
  return creators;
}

function collectVenue(item: Zotero.Item): string {
  const fields: _ZoteroTypes.Item.ItemField[] = [
    "publicationTitle",
    "journalAbbreviation",
    "proceedingsTitle",
    "conferenceName",
  ];
  const values = fields.map((field) => getItemFieldText(item, field)).filter(Boolean);
  if (!values.length) return "";
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizePaperSearchText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(value);
  }
  return deduped.join(" ");
}

function getCollectionIDs(item: Zotero.Item): number[] {
  try {
    return item
      .getCollections()
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0)
      .map((id) => Math.floor(id));
  } catch (_err) {
    return [];
  }
}

function resolveLibraryDisplayName(libraryID: number): string {
  try {
    const libraries = (Zotero as unknown as {
      Libraries?: {
        getName?: (targetLibraryID: number) => unknown;
        get?: (targetLibraryID: number) => { name?: unknown } | null | undefined;
      };
    }).Libraries;
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

function buildIndexedCandidate(item: Zotero.Item): IndexedPaperCandidate | null {
  if (!item?.isRegularItem?.()) return null;
  const attachments = buildIndexedAttachments(getPdfChildAttachments(item));
  if (!attachments.length) return null;

  const title = getItemFieldText(item, "title") || `Item ${item.id}`;
  const citationKey = getItemFieldText(item, "citationKey") || undefined;
  const creators = collectCreators(item);
  const firstCreator = creators[0] || undefined;
  const year = extractYear(getItemFieldText(item, "date")) || undefined;
  const shortTitle = getItemFieldText(item, "shortTitle");
  const doi = getItemFieldText(item, "DOI");
  const venue = collectVenue(item);

  return {
    itemId: item.id,
    title,
    citationKey,
    firstCreator,
    year,
    attachments,
    modifiedAt: toModifiedTimestamp(item.dateModified),
    collectionIDs: getCollectionIDs(item),
    normalized: {
      title: normalizePaperSearchText(title),
      shortTitle: normalizePaperSearchText(shortTitle),
      citationKey: normalizePaperSearchText(citationKey || ""),
      doi: normalizePaperSearchText(doi),
      creator: normalizePaperSearchText(creators.join(" ")),
      venue: normalizePaperSearchText(venue),
      year: normalizePaperSearchText(year || ""),
    },
  };
}

function buildIndexedCollection(
  collection: Zotero.Collection,
): IndexedCollection {
  return {
    collectionId: collection.id,
    name: normalizeText(collection.name) || `Collection ${collection.id}`,
    parentID:
      Number.isFinite(Number(collection.parentID)) && Number(collection.parentID) > 0
        ? Math.floor(Number(collection.parentID))
        : 0,
    childCollectionIDs: collection
      .getChildCollections(true, false)
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0)
      .map((id) => Math.floor(id)),
    childItemIDs: collection
      .getChildItems(true, false)
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0)
      .map((id) => Math.floor(id)),
  };
}

async function buildPaperSearchLibraryIndex(
  libraryID: number,
): Promise<PaperSearchLibraryIndex> {
  let items: Zotero.Item[] = [];
  let collections: Zotero.Collection[] = [];
  try {
    items = await Zotero.Items.getAll(libraryID, true, false, false);
    collections = Zotero.Collections.getByLibrary(libraryID, true) || [];
  } catch (err) {
    ztoolkit.log("LLM: Failed to build paper picker index", err);
    return { libraryID, candidates: [], collections: [] };
  }

  const candidates: IndexedPaperCandidate[] = [];
  for (const item of items) {
    const candidate = buildIndexedCandidate(item);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return {
    libraryID,
    candidates,
    collections: collections.map((collection) => buildIndexedCollection(collection)),
  };
}

async function getPaperSearchLibraryIndex(
  libraryID: number,
): Promise<PaperSearchLibraryIndex> {
  const cached = paperSearchLibraryIndexCache.get(libraryID);
  if (cached) return cached;

  const pending = paperSearchLibraryLoadTasks.get(libraryID);
  if (pending) return pending;

  const loadTask = buildPaperSearchLibraryIndex(libraryID)
    .then((index) => {
      paperSearchLibraryIndexCache.set(libraryID, index);
      return index;
    })
    .finally(() => {
      paperSearchLibraryLoadTasks.delete(libraryID);
    });
  paperSearchLibraryLoadTasks.set(libraryID, loadTask);
  return loadTask;
}

export function invalidatePaperSearchCache(libraryID?: number): void {
  if (
    typeof libraryID === "number" &&
    Number.isFinite(libraryID) &&
    libraryID > 0
  ) {
    const normalizedLibraryID = Math.floor(libraryID);
    paperSearchLibraryIndexCache.delete(normalizedLibraryID);
    paperSearchLibraryLoadTasks.delete(normalizedLibraryID);
    return;
  }
  paperSearchLibraryIndexCache.clear();
  paperSearchLibraryLoadTasks.clear();
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
    .filter((attachment) => !excludeId || attachment.contextItemId !== excludeId)
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

function scoreAttachmentTitle(title: string, query: string, tokens: string[]): number {
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
    for (const token of getMatchingTokens(candidate.normalized.shortTitle, tokens)) {
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
    const yearTokenMatches = getMatchingTokens(candidate.normalized.year, tokens);
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
    if (getMatchingTokens(titleAndCreatorBlob, tokens).length === tokens.length) {
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
      while (tokenEnd < safeInput.length && !/\s/u.test(safeInput[tokenEnd] || "")) {
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

export async function browsePaperCollectionCandidates(
  libraryID: number,
  excludeContextItemId?: number | null,
): Promise<PaperBrowseCollectionCandidate[]> {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return [];
  const libraryIndex = await getPaperSearchLibraryIndex(Math.floor(libraryID));
  const visibleCandidates = new Map<number, PaperSearchGroupCandidate>();
  for (const candidate of libraryIndex.candidates) {
    const visible = buildVisibleCandidate(candidate, excludeContextItemId);
    if (visible) {
      visibleCandidates.set(candidate.itemId, visible);
    }
  }

  const collectionMap = new Map<number, PaperBrowseCollectionCandidate>();
  for (const collection of libraryIndex.collections) {
    collectionMap.set(collection.collectionId, {
      collectionId: collection.collectionId,
      name: collection.name,
      childCollections: [],
      papers: [],
    });
  }

  for (const collection of libraryIndex.collections) {
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
  for (const collection of libraryIndex.collections) {
    const node = collectionMap.get(collection.collectionId);
    if (!node) continue;
    if (!collection.parentID || !collectionMap.has(collection.parentID)) {
      topLevelCollections.push(node);
    }
  }

  const unfiledPapers = libraryIndex.candidates
    .filter((candidate) => candidate.collectionIDs.length === 0)
    .map((candidate) => visibleCandidates.get(candidate.itemId) || null)
    .filter((candidate): candidate is PaperSearchGroupCandidate => Boolean(candidate))
    .sort((a, b) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
    );

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

  const libraryIndex = await getPaperSearchLibraryIndex(Math.floor(libraryID));
  const rankedCandidates: Array<{
    candidate: PaperSearchGroupCandidate;
    matchedTokenCount: number;
  }> = [];

  for (const indexedCandidate of libraryIndex.candidates) {
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
