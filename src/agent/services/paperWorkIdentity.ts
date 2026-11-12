/**
 * Which library items are versions of one work, such as a preprint and its
 * journal version. Items are marked as one work, never merged: each keeps its
 * own row and passages, so every claim stays linked to the passage it came
 * from.
 */

/** Lowercase a DOI and strip `doi:` / resolver-URL prefixes. */
export function normalizeDoi(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^doi:\s*/, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "")
    .trim();
}

/**
 * Bare, version-free arXiv id from an id, `arXiv:` form or arxiv.org
 * abs/pdf URL; empty when the value is not an arXiv id. Versions of one
 * paper share an id, so they match and dedupe as one paper.
 */
export function normalizeArxivId(value: unknown): string {
  const id = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^arxiv:\s*/, "")
    .replace(
      /^(?:https?:\/\/)?(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\//,
      "",
    )
    .replace(/\.pdf$/, "")
    .replace(/\/$/, "")
    .replace(/v\d+$/, "");
  return /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})$/.test(id) ? id : "";
}

export type PaperWorkFacts = {
  itemId: number;
  title?: string;
  /** The first creator's last name (or single-field name). */
  firstCreatorLastName?: string;
  year?: string;
  doi?: string;
  url?: string;
  /** Zotero's Extra field, which may hold `DOI:` and `arXiv:` lines. */
  extra?: string;
};

/** Titles shorter than this (before any subtitle) never group by title. */
const MIN_TITLE_TOKENS = 4;
/** A CJK title needs at least this many letters to group. */
const MIN_CJK_TITLE_CHARS = 8;
/** A preprint and its journal version may be dated this many years apart. */
const MAX_YEAR_GAP = 2;

function unicodeTokens(value: unknown): string[] {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The DOI and version-free arXiv keys an item names in any of its fields. */
function strongKeys(paper: PaperWorkFacts): string[] {
  const keys = new Set<string>();
  const extra = String(paper.extra || "");
  const dois = [
    paper.doi,
    ...Array.from(extra.matchAll(/^\s*doi:\s*(\S+)/gim), (match) => match[1]),
  ];
  const arxivSources: unknown[] = [
    paper.url,
    ...Array.from(extra.matchAll(/arxiv:\s*([^\s\]]+)/gi), (match) => match[1]),
  ];
  for (const value of dois) {
    const doi = normalizeDoi(value);
    if (!doi) continue;
    keys.add(`doi:${doi}`);
    arxivSources.push(doi.match(/^10\.48550\/arxiv\.(.+)$/)?.[1]);
  }
  for (const value of arxivSources) {
    const arxiv = normalizeArxivId(value);
    if (arxiv) keys.add(`arxiv:${arxiv}`);
  }
  return Array.from(keys);
}

/**
 * The title-and-creator key used when no identifier links two items: the
 * title before any ":" subtitle (the full title if that is too short), of at
 * least MIN_TITLE_TOKENS tokens, or a CJK title of MIN_CJK_TITLE_CHARS
 * letters, plus the first creator's last name. Empty when either part is missing, so a
 * title alone never groups.
 */
function titleCreatorKey(paper: PaperWorkFacts): string {
  const creator = unicodeTokens(paper.firstCreatorLastName).join("");
  if (!creator) return "";
  const title = String(paper.title || "");
  if (
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
      title,
    )
  ) {
    // CJK titles have no spaces: key on their letters and digits.
    const letters = unicodeTokens(title).join("");
    return Array.from(letters).length >= MIN_CJK_TITLE_CHARS
      ? `${letters}|${creator}`
      : "";
  }
  let tokens = unicodeTokens(title.split(":")[0]);
  // A short main title ("BERT: Pre-training of ...") falls back to the full title.
  if (tokens.length < MIN_TITLE_TOKENS) tokens = unicodeTokens(title);
  if (tokens.length < MIN_TITLE_TOKENS) return "";
  return `${tokens.join(" ")}|${creator}`;
}

function yearOf(value: unknown): number | undefined {
  const match = String(value || "").match(/\b(\d{4})\b/);
  return match ? Number(match[1]) : undefined;
}

type TitleForms = { full: string; main: string; hasSubtitle: boolean };

/** Normalized full title, main title (before ":") and whether a subtitle follows. */
function titleForms(paper: PaperWorkFacts): TitleForms {
  const title = String(paper.title || "");
  const colon = title.indexOf(":");
  const main = unicodeTokens(colon >= 0 ? title.slice(0, colon) : title);
  const subtitle = colon >= 0 ? unicodeTokens(title.slice(colon + 1)) : [];
  return {
    full: unicodeTokens(title).join(" "),
    main: main.join(" "),
    hasSubtitle: subtitle.length > 0,
  };
}

/** Whether an equal DOI may group two items: their titles must not conflict. */
function doiTitlesCompatible(left: PaperWorkFacts, right: PaperWorkFacts) {
  const a = titleForms(left);
  const b = titleForms(right);
  if (!a.full || !b.full) return false;
  return (
    a.full === b.full ||
    (!!a.main && (a.main === b.full || a.main === b.main)) ||
    (!!b.main && b.main === a.full)
  );
}

/**
 * Whether two items in one title-and-creator bucket share a work: equal full
 * titles, or at least one of them has no subtitle. Two different subtitles
 * ("Part I. Theory" and "Part II. Experiments") never match.
 */
function titleBucketMatch(left: PaperWorkFacts, right: PaperWorkFacts) {
  const a = titleForms(left);
  const b = titleForms(right);
  return a.full === b.full || !a.hasSubtitle || !b.hasSubtitle;
}

/**
 * Work group ids for items that share a work, keyed by item id; an item no
 * other item shares a work with gets none. Items share a work when they name
 * an equal version-free arXiv id, or an equal DOI with compatible titles, or
 * when their titles (before any subtitle, at least four tokens, and never two
 * different subtitles) and first creators are equal and the years of the
 * whole group stay at most two apart. The id names the group's lowest item
 * id, so it is the same in every call that sees the same items.
 */
export function groupPaperWorks(
  papers: readonly PaperWorkFacts[],
): Map<number, string> {
  const parent = papers.map((_, index) => index);
  const minYear = papers.map((paper) => yearOf(paper.year));
  const maxYear = [...minYear];
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const known = (values: Array<number | undefined>): number[] =>
    values.filter((y): y is number => y !== undefined);
  const merge = (left: number, right: number) => {
    const a = find(left);
    const b = find(right);
    if (a === b) return;
    const root = Math.min(a, b);
    const other = Math.max(a, b);
    parent[other] = root;
    const lows = known([minYear[root], minYear[other]]);
    const highs = known([maxYear[root], maxYear[other]]);
    minYear[root] = lows.length ? Math.min(...lows) : undefined;
    maxYear[root] = highs.length ? Math.max(...highs) : undefined;
  };
  /** A title union needs every member of the merged group within the gap. */
  const unionByTitle = (left: number, right: number) => {
    const a = find(left);
    const b = find(right);
    if (a === b) return;
    const lows = known([minYear[a], minYear[b]]);
    const highs = known([maxYear[a], maxYear[b]]);
    if (lows.length && Math.max(...highs) - Math.min(...lows) > MAX_YEAR_GAP)
      return;
    merge(a, b);
  };

  const holdersByKey = new Map<string, number[]>();
  const byTitleCreator = new Map<string, number[]>();
  papers.forEach((paper, index) => {
    for (const key of strongKeys(paper)) {
      const holders = holdersByKey.get(key) || [];
      for (const holder of holders) {
        if (
          key.startsWith("arxiv:") ||
          doiTitlesCompatible(papers[holder], paper)
        )
          merge(holder, index);
      }
      holders.push(index);
      holdersByKey.set(key, holders);
    }
    const key = titleCreatorKey(paper);
    if (!key || yearOf(paper.year) === undefined) return;
    const bucket = byTitleCreator.get(key) || [];
    bucket.push(index);
    byTitleCreator.set(key, bucket);
  });
  for (const bucket of byTitleCreator.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        if (titleBucketMatch(papers[bucket[i]], papers[bucket[j]]))
          unionByTitle(bucket[i], bucket[j]);
      }
    }
  }

  const members = new Map<number, number[]>();
  papers.forEach((_, index) => {
    const root = find(index);
    const list = members.get(root) || [];
    list.push(index);
    members.set(root, list);
  });
  const groups = new Map<number, string>();
  for (const list of members.values()) {
    const itemIds = Array.from(
      new Set(list.map((index) => papers[index].itemId)),
    );
    if (itemIds.length < 2) continue;
    const id = `work-${Math.min(...itemIds)}`;
    for (const itemId of itemIds) groups.set(itemId, id);
  }
  return groups;
}
