import { assert } from "chai";
import { createTrustedReadObservations } from "../src/agent/plans/readObservation";

describe("trusted read observations", function () {
  const priorZotero = (globalThis as { Zotero?: unknown }).Zotero;

  before(function () {
    const items = new Map<number, Record<string, unknown>>([
      [10, { id: 10, key: "AAAA1111", libraryID: 1 }],
      [11, { id: 11, key: "BBBB2222", libraryID: 1 }],
      [20, { id: 20, key: "PDFP1111", libraryID: 1, parentID: 10 }],
    ]);
    (globalThis as { Zotero?: unknown }).Zotero = {
      Items: { get: (itemId: number) => items.get(itemId) || null },
    };
  });

  after(function () {
    (globalThis as { Zotero?: unknown }).Zotero = priorZotero;
  });

  it("does not treat unknown or empty result shapes as provenance", async function () {
    assert.deepEqual(
      await createTrustedReadObservations({
        toolName: "unknown_read",
        callId: "unknown",
        input: { itemId: 10 },
        result: { body: "model-shaped content" },
      }),
      [],
    );
    assert.deepEqual(
      await createTrustedReadObservations({
        toolName: "paper_read",
        callId: "empty",
        input: { mode: "full", target: { itemId: 10 } },
        result: {},
      }),
      [],
    );
    assert.deepEqual(
      await createTrustedReadObservations({
        toolName: "library_search",
        callId: "empty-search",
        input: { query: "none" },
        result: { results: [] },
      }),
      [],
    );
  });

  it("issues capability depth per returned paper instead of per result blob", async function () {
    const observations = await createTrustedReadObservations({
      toolName: "library_retrieve",
      callId: "mixed-depth",
      input: { query: "effect" },
      result: {
        candidates: [{ itemId: 10 }, { itemId: 11 }],
        snippets: [
          {
            itemId: 10,
            sourceKind: "pdf_text",
            snippet: "Body-level evidence",
          },
          {
            itemId: 11,
            sourceKind: "metadata",
            snippet: "Title-only match",
          },
        ],
      },
    });
    const first = observations.find((entry) => entry.itemKey === "AAAA1111");
    const second = observations.find((entry) => entry.itemKey === "BBBB2222");
    assert.sameMembers(first?.capabilities || [], ["metadata", "body"]);
    assert.deepEqual(second?.capabilities, ["metadata"]);
    assert.match(first?.certificateDigest || "", /^sha256:/);
  });

  it("preserves attachment and page identity in host-issued observations", async function () {
    const observations = await createTrustedReadObservations({
      toolName: "paper_read",
      callId: "page-read",
      input: { mode: "full" },
      result: {
        papers: [
          {
            paperContext: { itemId: 10, contextItemId: 20 },
            pageIndex: 4,
            sourceFingerprint: "pdfjs:document-1",
            text: "A verified passage",
          },
        ],
      },
    });
    assert.lengthOf(observations, 1);
    assert.deepInclude(observations[0], {
      libraryID: 1,
      itemKey: "AAAA1111",
      attachmentItemKey: "PDFP1111",
      pageIndex: 4,
      sourceFingerprint: "pdfjs:document-1",
    });
    assert.deepEqual(observations[0].capabilities, ["body"]);
  });

  it("distinguishes metadata fallback, PDF overview, and processed full reads", async function () {
    const metadata = await createTrustedReadObservations({
      toolName: "paper_read",
      callId: "metadata-overview",
      input: { mode: "overview" },
      result: {
        mode: "overview",
        results: [
          {
            paperContext: { itemId: 10, contextItemId: 20 },
            backend: "zotero_metadata",
            text: "Title: Alpha\nAbstract: Actual abstract text",
          },
        ],
      },
    });
    assert.sameMembers(metadata[0].capabilities, ["metadata", "abstract"]);

    const overview = await createTrustedReadObservations({
      toolName: "paper_read",
      callId: "pdf-overview",
      input: { mode: "overview" },
      result: {
        mode: "overview",
        results: [
          {
            paperContext: { itemId: 10, contextItemId: 20 },
            backend: "raw_pdf_text",
            text: "Extracted PDF passage",
          },
        ],
      },
    });
    assert.deepEqual(overview[0].capabilities, ["body"]);

    const full = await createTrustedReadObservations({
      toolName: "paper_read",
      callId: "full-read",
      input: { mode: "full" },
      result: {
        mode: "full",
        papers: [
          {
            paperContext: { itemId: 10, contextItemId: 20 },
            documentFingerprint: "pdfjs:full",
            status: "complete",
            processedChunks: 12,
            totalChunks: 12,
            exactEvidence: [],
          },
        ],
      },
    });
    assert.deepEqual(full[0].capabilities, ["body"]);
    assert.equal(full[0].sourceFingerprint, "pdfjs:full");
  });
});

describe("trusted read observations carry the paper_read mode", function () {
  const priorZotero = (globalThis as { Zotero?: unknown }).Zotero;
  before(function () {
    const items = new Map<number, Record<string, unknown>>([
      [10, { id: 10, key: "AAAA1111", libraryID: 1 }],
      [20, { id: 20, key: "PDFP1111", libraryID: 1, parentID: 10 }],
    ]);
    (globalThis as { Zotero?: unknown }).Zotero = {
      Items: { get: (itemId: number) => items.get(itemId) || null },
    };
  });
  after(function () {
    (globalThis as { Zotero?: unknown }).Zotero = priorZotero;
  });

  it("records targeted and overview modes so edge verification can tell them apart", async function () {
    const targeted = await createTrustedReadObservations({
      toolName: "paper_read",
      callId: "targeted",
      input: { mode: "targeted", target: { itemId: 10, contextItemId: 20 } },
      result: {
        mode: "targeted",
        results: [
          {
            paperContext: { itemId: 10, contextItemId: 20 },
            text: "passage",
            chunkIndex: 3,
          },
        ],
      },
    });
    assert.equal(targeted[0]?.readMode, "targeted");
    assert.include(targeted[0]?.capabilities || [], "body");
    const overview = await createTrustedReadObservations({
      toolName: "paper_read",
      callId: "overview",
      input: { mode: "overview", target: { itemId: 10, contextItemId: 20 } },
      result: {
        mode: "overview",
        results: [
          { paperContext: { itemId: 10, contextItemId: 20 }, text: "body" },
        ],
      },
    });
    assert.equal(overview[0]?.readMode, "overview");
  });
});
