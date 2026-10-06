import { Marked } from "marked";
import type { DocumentCitationEvidence } from "./citationService";
import type {
  PlanCitationCluster,
  PlanVerifiedQuote,
  SubmitPlanDocumentInput,
} from "./types";
import { ToolInputRejection } from "../tools/execution/failure";
import { getAllOpenReaders } from "../../services/pdf/zoteroReaderTabs";
import { verifyCompleteQuoteInLivePdfJs } from "../../services/pdf/livePdfSelectionLocator";
import {
  isQuoteTokenId,
  quoteTokenPattern,
  quoteTokenSource,
} from "../../services/quotes/quoteTokenIds";
const QUOTE_TOKEN = quoteTokenPattern("quote");
const CITE_TOKEN = quoteTokenPattern("cite");
const WHOLE_QUOTE_TOKEN = new RegExp(
  `^${quoteTokenSource("quote", { capture: false })}$`,
);
/** A quote token at the end of a block, then its citation and a year. */
const TRAILING_QUOTE_ANCHOR = new RegExp(
  `\\s*${quoteTokenSource("quote")}(?:\\s*(${quoteTokenSource("cite", { capture: false })}))?(?:\\s*\\([^()\\n]*\\b\\d{4}[a-z]?\\))?\\s*$`,
);
/** A paragraph that is only a quote token, its citation and a year. */
const STANDALONE_QUOTE_ANCHOR = new RegExp(
  `^(?:\\([^()\\n]*\\b\\d{4}[a-z]?\\)\\s*)?${quoteTokenSource("quote")}(?:\\s*(${quoteTokenSource("cite", { capture: false })}))?$`,
);
/** The longest quote id a plan document may submit. */
const MAX_PLAN_QUOTE_ID_LENGTH = 80;
/** Opening and closing quotation marks: straight, curly, CJK corner brackets, guillemets. */
const OPEN_MARKS = "\"'\u201c\u2018\u300c\u300e\u00ab";
const CLOSE_MARKS = "\"'\u201d\u2019\u300d\u300f\u00bb";
/**
 * A quote token with the quotation marks around it (a space may separate a
 * mark from the token), sentence punctuation inside or outside the closing
 * mark, and the citation tokens the draft placed right after it.
 */
const DOWNGRADE_TOKEN = new RegExp(
  `(?:([${OPEN_MARKS}])([ \\t\\u00a0]*))?${quoteTokenSource("quote")}([.,;:!?]*)(?:([ \\t\\u00a0]*)([${CLOSE_MARKS}]))?([.,;:!?]*)((?:\\s*${quoteTokenSource("cite", { capture: false })})*)`,
  "g",
);
/** Quotation marks around a literal, removed before it is compared with a quote. */
const ENCLOSING_MARKS = new RegExp(
  `^[${OPEN_MARKS}]\\s*([\\s\\S]*?)\\s*[${CLOSE_MARKS}]([.,;:!?]*)$`,
);
/** A raw HTML blockquote, which the Markdown blockquote pass does not see. */
const HTML_BLOCKQUOTE = /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/gi;
/** A line that opens a blockquote, possibly inside a list item. */
const BLOCKQUOTE_LINE = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)*>/;
/** Anything shaped like a quote token, to catch ones the strict form misses. */
const QUOTE_TOKEN_LIKE = /\[\[quote:[^\]]*\]\]/g;
/**
 * A submitted quote id: an id under the shared token rule that starts with a
 * letter or digit and has at most {@link MAX_PLAN_QUOTE_ID_LENGTH} characters.
 */
function isPlanQuoteId(quoteId: string): boolean {
  return (
    isQuoteTokenId(quoteId) &&
    quoteId.length <= MAX_PLAN_QUOTE_ID_LENGTH &&
    !/^[._:-]/.test(quoteId)
  );
}
/**
 * Resolve quote tokens into verified blockquotes.
 *
 * Problems the host can repair without changing what the document claims are
 * repaired and reported: an unused quote mapping is dropped, and a quote the
 * host cannot verify (its PDF is not open, or the attachment does not resolve)
 * is kept as prose cited to its paper. Unresolved tokens, fabricated evidence,
 * and wording the open PDF does not contain still reject.
 */
export async function resolveVerifiedQuotes(params: {
  markdown: string;
  quotes: SubmitPlanDocumentInput["quotes"];
  corpusKeys: ReadonlySet<string>;
  evidenceByRef: ReadonlyMap<string, DocumentCitationEvidence>;
  /** Existing clusters, so a downgraded quote can reuse its source's citation. */
  citations: readonly PlanCitationCluster[];
}): Promise<{
  markdown: string;
  verifiedQuotes: PlanVerifiedQuote[];
  /** Clusters to add for downgraded quotes whose source had none. */
  addedCitations: PlanCitationCluster[];
  repairs: string[];
}> {
  const repairs: string[] = [];
  const mappings = new Map<string, SubmitPlanDocumentInput["quotes"][number]>();
  for (const quote of params.quotes) {
    if (!isPlanQuoteId(quote.quoteId) || mappings.has(quote.quoteId)) {
      throw new ToolInputRejection(
        `Duplicate or invalid quote ID: ${quote.quoteId}`,
      );
    }
    mappings.set(quote.quoteId, quote);
  }
  const tokenIds = [...params.markdown.matchAll(QUOTE_TOKEN)].map(
    (match) => match[1],
  );
  for (const [token] of params.markdown.matchAll(QUOTE_TOKEN_LIKE)) {
    if (!WHOLE_QUOTE_TOKEN.test(token)) {
      throw new ToolInputRejection(
        `Document contains malformed quote token ${token}; use one [[quote:ID]] token per quote`,
      );
    }
  }
  if (new Set(tokenIds).size !== tokenIds.length) {
    throw new ToolInputRejection(
      "Each verified quote token may appear only once",
    );
  }
  for (const quoteId of tokenIds) {
    if (!mappings.has(quoteId)) {
      throw new ToolInputRejection(
        `Document contains unresolved quote token ${quoteId}`,
      );
    }
  }
  for (const quoteId of [...mappings.keys()]) {
    if (!tokenIds.includes(quoteId)) {
      mappings.delete(quoteId);
      repairs.push(`dropped unused quote ${quoteId}`);
    }
  }
  if (!mappings.size)
    return {
      markdown: params.markdown,
      verifiedQuotes: [],
      addedCitations: [],
      repairs,
    };

  const readers = new Map<number, unknown>();
  for (const reader of getAllOpenReaders()) {
    const itemId = Math.floor(Number(reader?._item?.id || reader?.itemID || 0));
    if (itemId && !readers.has(itemId)) readers.set(itemId, reader);
  }
  const verifiedQuotes: PlanVerifiedQuote[] = [];
  // Quotes the host cannot verify become cited prose once every quote has
  // passed the checks that do reject.
  const downgraded: Array<{
    quote: SubmitPlanDocumentInput["quotes"][number];
    reason: string;
  }> = [];
  for (const quoteId of tokenIds) {
    const quote = mappings.get(quoteId)!;
    const identity = `${quote.libraryID}:${quote.itemKey}`;
    if (!params.corpusKeys.has(identity)) {
      throw new ToolInputRejection(
        `Quote ${quoteId} references an item outside the corpus`,
      );
    }
    if (!quote.evidenceRefs.length) {
      throw new ToolInputRejection(
        `Quote ${quoteId} requires trusted research evidence`,
      );
    }
    const paper = Zotero.Items.getByLibraryAndKey(
      quote.libraryID,
      quote.itemKey,
    );
    if (!paper || paper.deleted) {
      throw new ToolInputRejection(
        `Quote ${quoteId} has an invalid PDF attachment identity`,
      );
    }
    const evidence = quote.evidenceRefs.map((reference) => {
      const record = params.evidenceByRef.get(reference);
      if (
        !record ||
        record.libraryID !== quote.libraryID ||
        record.itemKey !== quote.itemKey ||
        !["body", "quote"].includes(record.sourceKind) ||
        record.locator?.attachmentItemKey !== quote.attachmentItemKey
      ) {
        throw new ToolInputRejection(
          `Quote ${quoteId} has an invalid evidence reference`,
        );
      }
      return record;
    });
    const attachment = Zotero.Items.getByLibraryAndKey(
      quote.libraryID,
      quote.attachmentItemKey,
    );
    if (
      !attachment ||
      attachment.deleted ||
      !attachment.isAttachment?.() ||
      Number(attachment.parentID || 0) !== Number(paper.id)
    ) {
      downgraded.push({ quote, reason: "PDF attachment not found" });
      continue;
    }
    const reader = readers.get(Number(attachment.id));
    if (!reader) {
      downgraded.push({ quote, reason: "PDF not open" });
      continue;
    }
    const verification = await verifyCompleteQuoteInLivePdfJs(
      reader,
      Number(attachment.id),
      quote.text,
    );
    if (verification.status !== "matched") {
      throw new ToolInputRejection(
        `Quote ${quoteId} failed strict PDF.js verification: ${verification.status === "defer" ? verification.reason : "the literal wording was not found"}`,
      );
    }
    if (
      !evidence.some(
        (record) =>
          record.locator?.pageIndex === undefined ||
          record.locator.pageIndex === verification.certificate.pageIndex,
      )
    ) {
      throw new ToolInputRejection(
        `Quote ${quoteId} is not backed by trusted evidence on its verified PDF page`,
      );
    }
    verifiedQuotes.push({
      quoteId,
      text: quote.text,
      libraryID: quote.libraryID,
      itemKey: quote.itemKey,
      attachmentItemKey: quote.attachmentItemKey,
      evidenceRefs: [...quote.evidenceRefs],
      certificate: {
        contextItemId: verification.certificate.contextItemId,
        sourceFingerprint: `pdfjs:${verification.certificate.documentFingerprint}`,
        pageIndex: verification.certificate.pageIndex,
        sourceMatchText: verification.certificate.sourceMatchText,
        sourceMatchKind: verification.certificate.sourceMatchKind,
        sourceMatchPageOccurrence:
          verification.certificate.sourceMatchPageOccurrence,
      },
    });
  }
  const downgradedById = new Map(
    downgraded.map((entry) => [entry.quote.quoteId, entry.quote]),
  );
  for (const { quote, reason } of downgraded) {
    repairs.push(
      `quote ${quote.quoteId} could not be verified (${reason}); kept as cited text`,
    );
  }
  // A downgraded quote is cited to its paper: through a citation the draft
  // already places next to it, else the paper's own citation (single-source
  // first), else a new one.
  const addedCitations: PlanCitationCluster[] = [];
  const citesPaper = (
    cluster: PlanCitationCluster,
    quote: SubmitPlanDocumentInput["quotes"][number],
  ) =>
    cluster.sources.some(
      (source) =>
        source.libraryID === quote.libraryID &&
        source.itemKey === quote.itemKey,
    );
  const citationFor = (quote: SubmitPlanDocumentInput["quotes"][number]) => {
    const existing =
      params.citations.find(
        (cluster) => cluster.sources.length === 1 && citesPaper(cluster, quote),
      ) ||
      addedCitations.find((cluster) => citesPaper(cluster, quote)) ||
      params.citations.find((cluster) => citesPaper(cluster, quote));
    if (existing) return existing.citationId;
    const created: PlanCitationCluster = {
      citationId: `cite-${quote.quoteId}`,
      sources: [
        {
          libraryID: quote.libraryID,
          itemKey: quote.itemKey,
          evidenceRefs: [...quote.evidenceRefs],
        },
      ],
    };
    addedCitations.push(created);
    return created.citationId;
  };
  const notQuotation = (quoteId: string, where: string) =>
    new ToolInputRejection(
      `Quote ${quoteId} could not be verified and sits ${where}; present it as prose or open the PDF`,
    );
  // Unverified wording is never presented as a quotation: a blockquote that
  // holds a downgraded token becomes ordinary prose.
  const unquoteBlocks = (markdown: string) => {
    const tokens = new Marked().lexer(markdown);
    let changed = false;
    for (const token of tokens) {
      if (token.type !== "blockquote") continue;
      const holdsDowngraded = [...token.raw.matchAll(QUOTE_TOKEN)].some(
        (match) => downgradedById.has(match[1]),
      );
      if (!holdsDowngraded) continue;
      token.raw = token.raw.replace(/^[ \t]{0,3}>[ \t]?/gm, "");
      changed = true;
    }
    const result = changed
      ? tokens.map((token) => token.raw).join("")
      : markdown;
    // Raw HTML is not a Markdown blockquote, so it cannot be unquoted.
    for (const html of result.matchAll(HTML_BLOCKQUOTE)) {
      for (const match of html[1].matchAll(QUOTE_TOKEN)) {
        if (downgradedById.has(match[1]))
          throw notQuotation(match[1], "inside a blockquote");
      }
    }
    // Shapes the block pass cannot reach, such as a blockquote in a list.
    for (const line of result.split(/\r?\n/)) {
      if (!BLOCKQUOTE_LINE.test(line)) continue;
      for (const match of line.matchAll(QUOTE_TOKEN)) {
        if (downgradedById.has(match[1]))
          throw notQuotation(match[1], "inside a blockquote");
      }
    }
    return result;
  };
  const downgradeTokens = (markdown: string) =>
    unquoteBlocks(markdown).replace(
      DOWNGRADE_TOKEN,
      (
        match: string,
        open: string | undefined,
        openSpace: string | undefined,
        quoteId: string,
        innerPunctuation: string,
        closeSpace: string | undefined,
        close: string | undefined,
        outerPunctuation: string,
        followingCites: string,
      ) => {
        const quote = downgradedById.get(quoteId);
        if (!quote) return match;
        // A lone mark a space away belongs to the surrounding prose.
        let prefix = "";
        let suffix = "";
        if (open && !close && openSpace) {
          prefix = `${open}${openSpace}`;
          open = "";
        }
        if (close && !open && closeSpace) {
          suffix = `${closeSpace}${close}${outerPunctuation}${followingCites}`;
          close = "";
          outerPunctuation = "";
          followingCites = "";
        }
        // Enclosing marks are removed; a lone mark means the quotation's
        // extent is unclear, so the draft has to say what it meant.
        if (Boolean(open) !== Boolean(close))
          throw notQuotation(quoteId, "next to a quotation mark");
        const citedHere = [...followingCites.matchAll(CITE_TOKEN)].some(
          (cite) => {
            const cluster = params.citations.find(
              (candidate) => candidate.citationId === cite[1],
            );
            return cluster ? citesPaper(cluster, quote) : false;
          },
        );
        const citation = citedHere ? "" : ` [[cite:${citationFor(quote)}]]`;
        return `${prefix}${quote.text}${citation}${followingCites}${innerPunctuation}${outerPunctuation}${suffix}`;
      },
    );
  // A draft can quote the wording in its prose and then attach the quote
  // token. A downgraded token becomes that wording, so the quoted copy
  // before it goes, or the reader sees it twice.
  const dropQuotedCopies = (markdown: string) => {
    let output = "";
    let last = 0;
    for (const match of markdown.matchAll(QUOTE_TOKEN)) {
      const quote = downgradedById.get(match[1]);
      const head = markdown.slice(last, match.index);
      last = match.index! + match[0].length;
      const copy = quote ? quotedCopyBefore(output + head, quote.text) : null;
      if (!copy) {
        output += head + match[0];
        continue;
      }
      output = `${copy.before}${match[0]}${copy.punctuation}`;
    }
    return output + markdown.slice(last);
  };
  const quotesById = new Map(
    verifiedQuotes.map((quote) => [quote.quoteId, quote]),
  );
  // A model can write the literal block and then attach its quote token as
  // provenance. Bind that adjacent pair before expansion, otherwise both
  // copies become independently certified display blocks.
  const blocks = new Marked().lexer(params.markdown);
  let reboundManualQuote = false;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    // A literal paragraph is the same copy as a literal blockquote.
    if (block.type !== "blockquote" && block.type !== "paragraph") continue;
    const inlineAnchor = block.text.match(TRAILING_QUOTE_ANCHOR);
    let nextIndex = index + 1;
    while (blocks[nextIndex]?.type === "space") nextIndex += 1;
    const following = blocks[nextIndex];
    const anchor =
      inlineAnchor ||
      (following?.type === "paragraph"
        ? following.raw.trim().match(STANDALONE_QUOTE_ANCHOR)
        : null);
    const quote = anchor
      ? quotesById.get(anchor[1]) || downgradedById.get(anchor[1])
      : undefined;
    const literal = inlineAnchor
      ? block.text.slice(0, inlineAnchor.index)
      : block.text;
    if (!quote || !sameWording(literal, quote.text)) continue;
    // A downgraded quote replaces the literal block with its cited prose, so
    // the unverified wording is neither a blockquote nor shown twice.
    block.raw = downgradedById.has(quote.quoteId)
      ? `[[quote:${quote.quoteId}]]${anchor![2] ? ` ${anchor![2]}` : ""}\n\n`
      : `[[quote:${quote.quoteId}]]\n${anchor![2] || ""}\n\n`;
    reboundManualQuote = true;
    if (inlineAnchor) continue;
    for (let consumed = index + 1; consumed <= nextIndex; consumed += 1) {
      blocks[consumed].raw = "";
    }
    index = nextIndex;
  }
  return {
    markdown: downgradeTokens(
      dropQuotedCopies(
        reboundManualQuote
          ? blocks.map((block) => block.raw).join("")
          : params.markdown,
      ),
    ).replace(QUOTE_TOKEN, (_token, quoteId: string) =>
      quotesById
        .get(quoteId)!
        .text.split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join("\n"),
    ),
    verifiedQuotes,
    addedCitations,
    repairs,
  };
}

const normalizeLiteral = (text: string) => text.replace(/\s+/g, " ").trim();
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/**
 * Whether a draft's literal is the quote's wording, once quotation marks
 * around it are removed. Sentence punctuation may sit inside or outside the
 * closing mark.
 */
function sameWording(literal: string, quoteText: string): boolean {
  const wording = normalizeLiteral(quoteText);
  const plain = normalizeLiteral(literal);
  if (plain === wording) return true;
  const enclosed = ENCLOSING_MARKS.exec(plain);
  if (!enclosed) return false;
  const inner = normalizeLiteral(enclosed[1]);
  return inner === wording || `${inner}${enclosed[2]}` === wording;
}

/**
 * The quoted copy of `quoteText` that `text` ends with, if any: the text
 * before its opening mark, and the punctuation after its closing mark that
 * the quote's own wording does not already end with.
 */
function quotedCopyBefore(
  text: string,
  quoteText: string,
): { before: string; punctuation: string } | null {
  const wording = normalizeLiteral(quoteText);
  if (!wording) return null;
  const trimmed = text.replace(/[ \t]+$/, "");
  const punctuation = /[.,;:!?]*$/.exec(trimmed)![0];
  const closed = trimmed.slice(0, trimmed.length - punctuation.length);
  if (!closed || !CLOSE_MARKS.includes(closed[closed.length - 1])) return null;
  const inside = closed.slice(0, -1);
  // The copy holds the wording, so its opening mark is at most this far back.
  const earliest = Math.max(0, inside.length - quoteText.length * 2 - 8);
  for (let start = inside.length - 1; start >= earliest; start -= 1) {
    if (!OPEN_MARKS.includes(inside[start])) continue;
    const copy = normalizeLiteral(inside.slice(start + 1));
    if (copy !== wording && `${copy}${punctuation}` !== wording) continue;
    return {
      before: inside.slice(0, start),
      punctuation: TRAILING_PUNCTUATION.test(wording) ? "" : punctuation,
    };
  }
  return null;
}
