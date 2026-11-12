/**
 * An index built before stemming (surface-token postings, no
 * document_tokenizer table, no tokenizer_version row) upgrades itself after a
 * restart: the re-posting pass rebuilds the postings from the stored chunk
 * text, and a query for "errors" finds a paper that only says "error" —
 * already while the pass may still be running, and after it. Real Zotero
 * items with real PDFs, indexed by the installed plugin's scheduler.
 */
import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

declare const Zotero: any;

function api(): WorkflowTestApi {
  return (Zotero as any).LLMForZotero.api.workflowTest as WorkflowTestApi;
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Zotero.Promise.delay(200);
  }
  return check();
}

describe("workflow: library index stemming upgrade", function () {
  this.timeout(180000);
  const fixtures: WorkflowTestFixture[] = [];
  let singular: WorkflowTestFixture;
  let plural: WorkflowTestFixture;
  let unrelated: WorkflowTestFixture;

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    await api().reset();
    singular = await api().createPaperWithPdfFixture({
      title: "Calibration of a quorvex gauge",
      pdfTitle: "Calibration of a quorvex gauge",
      pages: [
        "Introduction. The quorvex gauge was calibrated against a reference standard.",
        "Results. The calibration error stayed below one percent in every session.",
      ],
    });
    plural = await api().createPaperWithPdfFixture({
      title: "Drift of a quorvex readout",
      pdfTitle: "Drift of a quorvex readout",
      pages: [
        "Introduction. The quorvex readout drifted across sessions.",
        "Results. Readout errors grew with temperature in two cohorts.",
      ],
    });
    unrelated = await api().createPaperWithPdfFixture({
      title: "Quorvex housing design",
      pdfTitle: "Quorvex housing design",
      pages: ["Methods. The quorvex housing was machined from aluminium."],
    });
    fixtures.push(singular, plural, unrelated);
  });

  after(async function () {
    await api().setLibraryTextIndexUserIdle(null);
    for (const fixture of fixtures) await api().cleanupFixture(fixture);
    await api().reset();
  });

  it("re-posts a pre-stemming index from stored chunk text and finds 'error' for 'errors'", async function () {
    const ids = fixtures.map((fixture) => fixture.pdfAttachmentId);
    // Added items are urgent: the scheduler indexes them while the user works.
    assert.isTrue(
      await waitFor(
        async () =>
          (await api().libraryTextIndexCoverage(ids)).missing.length === 0,
        60000,
      ),
      "the three papers are indexed",
    );
    assert.include(
      await api().libraryTextIndexPostingTerms(plural.pdfAttachmentId),
      "error",
      "a fresh index writes stemmed postings",
    );

    await api().restartLibraryTextIndexFromPreStemmingShape(ids);

    // The pass may be running: a waiting paper matches by its surface
    // postings ("error" for the index term, "errors" for the surface term),
    // a re-posted one by its stem. Either way both papers are found.
    const during = await api().searchLibraryTextIndexForTest({
      queries: ["errors"],
      attachmentIds: ids,
    });
    assert.sameMembers(during.paperAttachmentIds, [
      singular.pdfAttachmentId,
      plural.pdfAttachmentId,
    ]);

    assert.isTrue(
      await api().waitForLibraryTextIndexIdle(120000),
      "the re-posting pass finished",
    );
    const state = await api().libraryTextIndexTokenizerState();
    assert.equal(state.documentsNeedingRepost, 0);
    assert.equal(state.recordedVersion, "2");
    const pluralTerms = await api().libraryTextIndexPostingTerms(
      plural.pdfAttachmentId,
    );
    assert.include(pluralTerms, "error");
    assert.notInclude(pluralTerms, "errors", "surface postings were replaced");
    assert.include(pluralTerms, "session", "'sessions' is posted by its stem");
    assert.notInclude(pluralTerms, "sessions");

    const after = await api().searchLibraryTextIndexForTest({
      queries: ["errors"],
      attachmentIds: ids,
    });
    assert.sameMembers(after.paperAttachmentIds, [
      singular.pdfAttachmentId,
      plural.pdfAttachmentId,
    ]);
    assert.include(
      after.matchedTerms,
      "errors",
      "matched terms are what the reader typed, not stems",
    );
    const coverage = await api().libraryTextIndexCoverage(ids);
    assert.deepEqual(coverage.missing, [], "no document left the index");
  });
});
