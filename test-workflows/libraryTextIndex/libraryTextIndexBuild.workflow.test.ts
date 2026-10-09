import { assert } from "chai";
import type { WorkflowTestApi } from "../../src/modules/contextPanel/workflowTestTypes";
import {
  writeMineruCacheFiles,
  writeMineruSourceProvenanceForAttachment,
} from "../../src/services/mineru/mineruCache";
import {
  closeLibraryTextIndexDb,
  openLibraryTextIndexDb,
  refuseLibraryTextIndexOpensForQuit,
} from "../../src/services/libraryTextIndex/db";
import { generateSyntheticCorpus } from "../../test/helpers/syntheticLibraryCorpus";

declare const Zotero: any;

// The test bundle's imports are separate module copies; every index step goes
// through the plugin's harness so it hits the plugin's scheduler and connection.
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

describe("library text index fills in the background", function () {
  this.timeout(180000);
  const created: number[] = [];
  const debugMessages: string[] = [];
  const onDebug = (message: unknown) => debugMessages.push(String(message));

  before(function () {
    Zotero.Debug.addListener(onDebug);
  });

  after(async function () {
    try {
      Zotero.Debug.removeListener(onDebug);
      await api().setLibraryTextIndexUserIdle(null);
      for (const id of created.reverse()) {
        try {
          await Zotero.Items.get(id)?.eraseTx();
        } catch {
          /* ignore */
        }
      }
    } finally {
      // This test also opens its own bundled connection, independently of the
      // plugin harness. Close it even if the test or fixture cleanup failed.
      refuseLibraryTextIndexOpensForQuit();
      await closeLibraryTextIndexDb({ throwOnError: true });
    }
  });

  it("indexes new papers in the urgent lane, holds prefetch until idle, persists a question's paper by write-through, and removes a deleted one", async function () {
    Zotero.Prefs.set(
      "extensions.zotero.llmforzotero.mineruEnabled",
      true,
      true,
    );
    await api().setLibraryTextIndexUserIdle(false);
    const corpus = generateSyntheticCorpus({
      papers: 5,
      seed: 3,
      pdfShare: 0.4,
    });
    const attachmentIds: number[] = [];
    for (const paper of corpus.papers) {
      const fixture = await api().createPaperWithPdfFixture({
        title: paper.title,
        pdfTitle: `${paper.title}.pdf`,
        pages: paper.pages,
      });
      created.push(fixture.parentItemId);
      attachmentIds.push(fixture.pdfAttachmentId);
      if (paper.mode === "mineru") {
        const enc = new TextEncoder();
        await writeMineruCacheFiles(fixture.pdfAttachmentId, paper.markdown, [
          { relativePath: "full.md", data: enc.encode(paper.markdown) },
          {
            relativePath: "content_list.json",
            data: enc.encode(JSON.stringify(paper.contentList)),
          },
        ]);
        await writeMineruSourceProvenanceForAttachment(
          Zotero.Items.get(fixture.pdfAttachmentId),
        );
      }
    }
    // Added items are urgent: they index even while the user is active.
    await Zotero.Promise.delay(3000);
    let coverage = await api().libraryTextIndexCoverage(attachmentIds);
    assert.deepEqual(
      coverage.missing,
      [],
      "notifier-added attachments are indexed in the urgent lane",
    );

    // A paper that only exists on disk (no notifier event) is reconciled as prefetch and waits for idle.
    const stray = await api().createPaperWithPdfFixture({
      title: "Stray paper",
      pdfTitle: "stray.pdf",
      pages: ["The zylquant ratio was 0.61 in the stray study."],
    });
    created.push(stray.parentItemId);
    // Let its own add event finish indexing before forgetting it, or that job lands afterwards.
    assert.isTrue(
      await waitFor(
        async () =>
          (await api().libraryTextIndexCoverage([stray.pdfAttachmentId]))
            .missing.length === 0,
        30000,
      ),
      "the stray paper's add event indexed it",
    );
    await api().forgetLibraryTextIndexDocuments([stray.pdfAttachmentId]);
    const reconciled = await api().reconcileLibraryTextIndex();
    assert.isAtLeast(
      reconciled.enqueued,
      1,
      "reconcile queued the stray paper",
    );
    await Zotero.Promise.delay(2000);
    coverage = await api().libraryTextIndexCoverage([stray.pdfAttachmentId]);
    assert.deepEqual(
      coverage.missing,
      [stray.pdfAttachmentId],
      "prefetch does not run while the user is active",
    );

    // Write-through: extracting through the question path persists the paper without idle.
    await api().loadPaperContextForTest(stray.pdfAttachmentId);
    assert.isTrue(
      await waitFor(
        async () =>
          (await api().libraryTextIndexCoverage([stray.pdfAttachmentId]))
            .missing.length === 0,
        5000,
      ),
      "write-through persisted the paper the question path extracted",
    );

    assert.isTrue(
      await api().waitForLibraryTextIndexIdle(120000),
      "queue drained once idle is forced",
    );
    const status = await api().libraryTextIndexStatus();
    // Opening the index after the pane is visible must never lock Zotero: a
    // name-opened connection ran Zotero's unclean-shutdown integrity check
    // behind a pane-wide progress meter it never cleared, and Zotero.locked
    // then swallowed every keystroke. This bundle's db module is its own copy,
    // so this is a second connection opened now, with the plugin's WAL live.
    await openLibraryTextIndexDb();
    await closeLibraryTextIndexDb();
    assert.isNotOk(Zotero.locked, "opening the index left Zotero locked");
    assert.isAtLeast(status.indexed, 6);
    assert.isAbove(status.dbBytes, 0);
    assert.isAbove(status.budgetBytes, status.usedBytes);
    assert.equal(status.failed, 0);

    const victim = created.pop()!;
    await Zotero.Items.get(victim).eraseTx();
    assert.isTrue(
      await waitFor(
        async () =>
          (await api().libraryTextIndexCoverage([stray.pdfAttachmentId]))
            .missing.length === 1,
        5000,
      ),
      "the erased paper's attachment left the index",
    );

    // A normal build is quiet at the default log level: no index warnings.
    assert.isNotEmpty(debugMessages, "the debug listener saw Zotero output");
    assert.deepEqual(
      debugMessages.filter((m) => /\[(?:warn|error)\].*LLM index/.test(m)),
      [],
    );
  });
});
