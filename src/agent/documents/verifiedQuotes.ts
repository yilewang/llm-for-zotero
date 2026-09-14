import { Marked } from "marked";
import type { DocumentCitationEvidence } from "./citationService";
import type { PlanVerifiedQuote, SubmitPlanDocumentInput } from "./types";
import { ToolInputRejection } from "../tools/execution/failure";
const QUOTE_TOKEN = /\[\[quote:([A-Za-z0-9._:-]+)\]\]/g;
export async function resolveVerifiedQuotes(params: {
  markdown: string;
  quotes: SubmitPlanDocumentInput["quotes"];
  corpusKeys: ReadonlySet<string>;
  evidenceByRef: ReadonlyMap<string, DocumentCitationEvidence>;
}): Promise<{ markdown: string; verifiedQuotes: PlanVerifiedQuote[] }> {
  const mappings = new Map<string, SubmitPlanDocumentInput["quotes"][number]>();
  for (const quote of params.quotes) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(quote.quoteId) ||
      mappings.has(quote.quoteId)
    ) {
      throw new ToolInputRejection(
        `Duplicate or invalid quote ID: ${quote.quoteId}`,
      );
    }
    mappings.set(quote.quoteId, quote);
  }
  const tokenIds = [...params.markdown.matchAll(QUOTE_TOKEN)].map(
    (match) => match[1],
  );
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
  for (const quoteId of mappings.keys()) {
    if (!tokenIds.includes(quoteId)) {
      throw new ToolInputRejection(
        `Quote ${quoteId} is not used in the document`,
      );
    }
  }
  if (!mappings.size) return { markdown: params.markdown, verifiedQuotes: [] };

  const [{ getAllOpenReaders }, { verifyCompleteQuoteInLivePdfJs }] =
    await Promise.all([
      import("../../modules/contextPanel/contextResolution"),
      import("../../modules/contextPanel/livePdfSelectionLocator"),
    ]);
  const readers = new Map<number, unknown>();
  for (const reader of getAllOpenReaders()) {
    const itemId = Math.floor(Number(reader?._item?.id || reader?.itemID || 0));
    if (itemId && !readers.has(itemId)) readers.set(itemId, reader);
  }
  const verifiedQuotes: PlanVerifiedQuote[] = [];
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
    const attachment = Zotero.Items.getByLibraryAndKey(
      quote.libraryID,
      quote.attachmentItemKey,
    );
    if (
      !paper ||
      paper.deleted ||
      !attachment ||
      attachment.deleted ||
      !attachment.isAttachment?.() ||
      Number(attachment.parentID || 0) !== Number(paper.id)
    ) {
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
    const reader = readers.get(Number(attachment.id));
    if (!reader) {
      throw new ToolInputRejection(
        `Quote ${quoteId} requires the source PDF to be open for strict PDF.js verification`,
      );
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
  const quotesById = new Map(
    verifiedQuotes.map((quote) => [quote.quoteId, quote]),
  );
  // A model can write the literal block and then attach its quote token as
  // provenance. Bind that adjacent pair before expansion, otherwise both
  // copies become independently certified display blocks.
  const blocks = new Marked().lexer(params.markdown);
  let reboundManualQuote = false;
  const normalizeLiteral = (text: string) => text.replace(/\s+/g, " ").trim();
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.type !== "blockquote") continue;
    const inlineAnchor = block.text.match(
      /\s*\[\[quote:([A-Za-z0-9._:-]+)\]\](?:\s*(\[\[cite:[A-Za-z0-9._:-]+\]\]))?(?:\s*\([^()\n]*\b\d{4}[a-z]?\))?\s*$/,
    );
    let nextIndex = index + 1;
    while (blocks[nextIndex]?.type === "space") nextIndex += 1;
    const following = blocks[nextIndex];
    const anchor =
      inlineAnchor ||
      (following?.type === "paragraph"
        ? following.raw
            .trim()
            .match(
              /^(?:\([^()\n]*\b\d{4}[a-z]?\)\s*)?\[\[quote:([A-Za-z0-9._:-]+)\]\](?:\s*(\[\[cite:[A-Za-z0-9._:-]+\]\]))?$/,
            )
        : null);
    const quote = anchor ? quotesById.get(anchor[1]) : undefined;
    const literal = inlineAnchor
      ? block.text.slice(0, inlineAnchor.index)
      : block.text;
    if (!quote || normalizeLiteral(literal) !== normalizeLiteral(quote.text))
      continue;
    block.raw = `[[quote:${quote.quoteId}]]\n${anchor![2] || ""}\n\n`;
    reboundManualQuote = true;
    if (inlineAnchor) continue;
    for (let consumed = index + 1; consumed <= nextIndex; consumed += 1) {
      blocks[consumed].raw = "";
    }
    index = nextIndex;
  }
  return {
    markdown: (reboundManualQuote
      ? blocks.map((block) => block.raw).join("")
      : params.markdown
    ).replace(QUOTE_TOKEN, (_token, quoteId: string) =>
      quotesById
        .get(quoteId)!
        .text.split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join("\n"),
    ),
    verifiedQuotes,
  };
}
