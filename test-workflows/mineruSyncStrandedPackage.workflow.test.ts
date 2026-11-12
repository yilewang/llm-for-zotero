import { assert } from "chai";
import { createPdfFixture } from "../test/helpers/pdfFixture";
import { composeRetrievalCandidateInvalidation } from "../test/helpers/hostSurfaces";
import {
  getMineruItemDir,
  invalidateMineruMd,
  writeMineruCacheFiles,
} from "../src/services/mineru/mineruCache";
import {
  MINERU_SYNC_ATTACHMENT_TITLE_PREFIX,
  cleanupMineruArtifactsForRemovedAttachment,
  deleteMineruCacheArtifactsForAttachment,
  ensureMineruRuntimeCacheForAttachment,
  getMineruAvailabilityForAttachment,
  publishMineruCachePackageForAttachment,
  repairSyncedMineruCacheForAttachment,
} from "../src/services/mineru/sync";

type Fixture = {
  libraryID: number;
  createParent: (title: string) => Promise<Zotero.Item>;
  createPdf: (parent?: Zotero.Item) => Promise<Zotero.Item>;
};

/**
 * Ids of the packages titled for `sourceKey`, without trashed ones unless
 * asked. Children of a trashed parent count: they are not in the trash.
 */
async function packageIdsForKey(
  libraryID: number,
  sourceKey: string,
  includeTrashed = false,
): Promise<number[]> {
  const title = `${MINERU_SYNC_ATTACHMENT_TITLE_PREFIX} ${sourceKey}.zip`;
  const items = await Zotero.Items.getAll(libraryID, false, true, false);
  return items
    .filter(
      (item: Zotero.Item) =>
        item.isAttachment() &&
        (includeTrashed || !item.deleted) &&
        String(item.getField("title")) === title,
    )
    .map((item: Zotero.Item) => item.id)
    .sort((a: number, b: number) => a - b);
}

function parentOf(itemId: number): number | false {
  return Zotero.Items.get(itemId).parentID || false;
}

/** Moves the PDF as Retrieve Metadata or drag and drop does. */
async function setPdfParent(
  pdf: Zotero.Item,
  parent: Zotero.Item | false,
): Promise<void> {
  pdf.parentID = parent ? parent.id : false;
  await pdf.saveTx();
}

async function waitFor(check: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await Zotero.Promise.delay(100);
  }
  return check();
}

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const io = (globalThis as any).IOUtils;
  const libraryID = Zotero.Libraries.userLibraryID;
  const parents: Zotero.Item[] = [];
  const pdfs: Zotero.Item[] = [];
  const files: string[] = [];
  const fixture: Fixture = {
    libraryID,
    async createParent(title) {
      const parent = new Zotero.Item("journalArticle");
      parent.setField("title", title);
      await parent.saveTx();
      parents.push(parent);
      return parent;
    },
    async createPdf(parent) {
      const file = PathUtils.join(
        Zotero.getTempDirectory().path,
        `mineru-stranded-${Date.now()}-${files.length}.pdf`,
      );
      files.push(file);
      await io.write(file, createPdfFixture(1));
      const pdf = await Zotero.Attachments.linkFromFile({
        file,
        parentItemID: parent?.id,
        contentType: "application/pdf",
      } as any);
      pdfs.push(pdf);
      return pdf;
    },
  };
  try {
    await run(fixture);
  } finally {
    for (const pdf of pdfs) {
      await invalidateMineruMd(pdf.id);
      for (const id of await packageIdsForKey(libraryID, pdf.key, true)) {
        const item = Zotero.Items.get(id);
        if (item) await item.eraseTx();
      }
      const live = Zotero.Items.get(pdf.id);
      if (live) await live.eraseTx();
    }
    for (const parent of parents) {
      const live = Zotero.Items.get(parent.id);
      if (live) await live.eraseTx();
    }
    for (const file of files) await io.remove(file, { ignoreAbsent: true });
  }
}

async function publishFresh(
  pdf: Zotero.Item,
  markdown: string,
): Promise<number> {
  await invalidateMineruMd(pdf.id);
  await writeMineruCacheFiles(pdf.id, markdown, []);
  const published = await publishMineruCachePackageForAttachment(pdf.id);
  assert.equal(published.status, "published", published.reason);
  return published.packageAttachmentId!;
}

describe("workflow: MinerU sync package left behind when its PDF moves", function () {
  this.timeout(120000);

  // The library index restores synced caches in the background through the
  // plugin's own copy of the cache module, whose write lock this bundle's
  // writes do not share. Pause it so only this test writes the cache.
  const indexPref = "extensions.zotero.llmforzotero.libraryTextIndexEnabled";
  const syncPref = "extensions.zotero.llmforzotero.mineruSyncEnabled";
  let oldIndex: unknown;
  let oldSync: unknown;
  let originalToolkit: unknown;
  let restoreInvalidator: () => void = () => undefined;
  before(function () {
    oldIndex = Zotero.Prefs.get(indexPref, true);
    Zotero.Prefs.set(indexPref, false, true);
    oldSync = Zotero.Prefs.get(syncPref, true);
    Zotero.Prefs.set(syncPref, true, true);
    originalToolkit = (globalThis as any).ztoolkit;
    (globalThis as any).ztoolkit = (Zotero as any).LLMForZotero.data.ztoolkit;
    restoreInvalidator = composeRetrievalCandidateInvalidation();
  });
  after(function () {
    restoreInvalidator();
    (globalThis as any).ztoolkit = originalToolkit;
    if (oldSync === undefined) Zotero.Prefs.clear(syncPref, true);
    else Zotero.Prefs.set(syncPref, oldSync as boolean, true);
    if (oldIndex === undefined) Zotero.Prefs.clear(indexPref, true);
    else Zotero.Prefs.set(indexPref, oldIndex as boolean, true);
  });

  it("finds a standalone package after Retrieve Metadata, and moves it on write only", async function () {
    await withFixture(async ({ libraryID, createParent, createPdf }) => {
      const pdf = await createPdf();
      const packageId = await publishFresh(
        pdf,
        "# Extraction\n\nPublished while the PDF had no parent.",
      );
      assert.isFalse(parentOf(packageId), "package is standalone");
      const fullMdPath = PathUtils.join(getMineruItemDir(pdf.id), "full.md");
      const publishedMd = await Zotero.File.getContentsAsync(fullMdPath);

      // Retrieve Metadata creates a parent and moves only the PDF under it.
      const parent = await createParent("Recognized parent fixture");
      await setPdfParent(pdf, parent);

      const availability = await getMineruAvailabilityForAttachment(pdf);
      assert.equal(availability.status, "both");
      assert.isFalse(parentOf(packageId), "availability moves nothing");

      const republish = await publishMineruCachePackageForAttachment(pdf.id);
      assert.equal(republish.status, "up_to_date", republish.reason);
      assert.equal(republish.packageAttachmentId, packageId);
      assert.equal(parentOf(packageId), parent.id, "package moved to the PDF");

      // Another device: no local cache, only the synced package.
      await invalidateMineruMd(pdf.id);
      assert.equal(
        (await getMineruAvailabilityForAttachment(pdf)).status,
        "synced",
      );
      const restored = await ensureMineruRuntimeCacheForAttachment(pdf);
      assert.equal(restored.status, "restored", restored.reason);
      assert.equal(restored.packageAttachmentId, packageId);
      assert.equal(await Zotero.File.getContentsAsync(fullMdPath), publishedMd);
      assert.deepEqual(await packageIdsForKey(libraryID, pdf.key), [packageId]);
    });
  });

  it("restores a package left under the old parent and moves it to the new one", async function () {
    await withFixture(async ({ libraryID, createParent, createPdf }) => {
      const parentA = await createParent("Old parent fixture");
      const parentB = await createParent("New parent fixture");
      const pdf = await createPdf(parentA);
      const packageId = await publishFresh(pdf, "# Extraction\n\nUnder A.");
      assert.equal(parentOf(packageId), parentA.id);

      // The user drags the PDF to another parent.
      await setPdfParent(pdf, parentB);
      await invalidateMineruMd(pdf.id);
      const restored = await ensureMineruRuntimeCacheForAttachment(pdf);
      assert.equal(restored.status, "restored", restored.reason);
      assert.equal(restored.packageAttachmentId, packageId);
      assert.isTrue(
        await waitFor(() => parentOf(packageId) === parentB.id),
        "package moved to the new parent after the restore",
      );
      assert.deepEqual(await packageIdsForKey(libraryID, pdf.key), [packageId]);
    });
  });

  it("moves the package to standalone when the PDF becomes standalone again", async function () {
    await withFixture(async ({ libraryID, createParent, createPdf }) => {
      const parentA = await createParent("Former parent fixture");
      const pdf = await createPdf(parentA);
      const packageId = await publishFresh(pdf, "# Extraction\n\nUnder A.");
      assert.equal(parentOf(packageId), parentA.id);

      await setPdfParent(pdf, false);
      const repaired = await repairSyncedMineruCacheForAttachment(pdf);
      assert.equal(repaired.status, "already_cached", repaired.reason);
      assert.equal(repaired.packageAttachmentId, packageId);
      assert.isFalse(parentOf(packageId), "package is standalone");
      assert.deepEqual(await packageIdsForKey(libraryID, pdf.key), [packageId]);
    });
  });

  it("publishes changed content beside the PDF and prunes the stranded package", async function () {
    await withFixture(async ({ libraryID, createParent, createPdf }) => {
      const pdf = await createPdf();
      const strandedId = await publishFresh(pdf, "# Extraction\n\nOld.");
      const parent = await createParent("Recognized parent fixture");
      await setPdfParent(pdf, parent);

      const freshId = await publishFresh(pdf, "# Extraction\n\nReparsed.");
      assert.notEqual(freshId, strandedId);
      assert.equal(parentOf(freshId), parent.id);
      assert.deepEqual(await packageIdsForKey(libraryID, pdf.key), [freshId]);
    });
  });

  it("deletes a stranded package when the PDF is trashed", async function () {
    await withFixture(async ({ libraryID, createParent, createPdf }) => {
      const parentA = await createParent("Old parent fixture");
      const parentB = await createParent("New parent fixture");
      const pdf = await createPdf(parentA);
      await publishFresh(pdf, "# Extraction\n\nUnder A.");
      await setPdfParent(pdf, parentB);

      // The plugin's own trash observer may run the same cleanup.
      await Zotero.Items.trashTx([pdf.id]);
      await cleanupMineruArtifactsForRemovedAttachment(pdf.id);
      assert.deepEqual(await packageIdsForKey(libraryID, pdf.key), []);
    });
  });

  it("finds and rescues a package whose old parent is in the trash", async function () {
    await withFixture(async ({ libraryID, createParent, createPdf }) => {
      const parentA = await createParent("Trashed parent fixture");
      const parentB = await createParent("New parent fixture");
      const pdf = await createPdf(parentA);
      const packageId = await publishFresh(pdf, "# Extraction\n\nUnder A.");
      await setPdfParent(pdf, parentB);
      await Zotero.Items.trashTx([parentA.id]);

      assert.equal(
        (await getMineruAvailabilityForAttachment(pdf)).status,
        "both",
      );
      const republish = await publishMineruCachePackageForAttachment(pdf.id);
      assert.equal(republish.status, "up_to_date", republish.reason);
      assert.equal(republish.packageAttachmentId, packageId);
      assert.equal(parentOf(packageId), parentB.id, "package rescued");
      assert.deepEqual(await packageIdsForKey(libraryID, pdf.key), [packageId]);
    });
  });

  it("deletes a stranded package with the PDF's MinerU cache", async function () {
    await withFixture(async ({ libraryID, createParent, createPdf }) => {
      const parentA = await createParent("Old parent fixture");
      const parentB = await createParent("New parent fixture");
      const pdf = await createPdf(parentA);
      await publishFresh(pdf, "# Extraction\n\nUnder A.");
      await setPdfParent(pdf, parentB);

      const cleanup = await deleteMineruCacheArtifactsForAttachment(pdf.id);
      assert.equal(cleanup.removedSyncPackages, 1);
      assert.equal(cleanup.failed, 0);
      assert.deepEqual(await packageIdsForKey(libraryID, pdf.key), []);
    });
  });
});
