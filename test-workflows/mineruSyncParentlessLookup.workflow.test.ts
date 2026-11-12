import { assert } from "chai";
import { createPdfFixture } from "../test/helpers/pdfFixture";
import { composeRetrievalCandidateInvalidation } from "../test/helpers/hostSurfaces";
import {
  getMineruItemDir,
  invalidateMineruMd,
  writeMineruCacheFiles,
} from "../src/services/mineru/mineruCache";
import {
  buildMineruSyncPackageBytes,
  deleteMineruCacheArtifactsForAttachment,
  ensureMineruRuntimeCacheForAttachment,
  getMineruAvailabilityForAttachment,
  publishMineruCachePackageForAttachment,
} from "../src/services/mineru/sync";

const DECOY_COUNT = 20;
const DECOY_MD_BYTES = 1024 * 1024;

/** A MinerU-like full.md of about `targetBytes`, unique to `label`. */
function buildLargeMarkdown(label: string, targetBytes: number): string {
  const parts = [`# ${label}\n\n`];
  let size = parts[0].length;
  for (let section = 1; size < targetBytes; section++) {
    const block =
      `## Section ${section} of ${label}\n\n` +
      `Paragraph ${section}: neural population activity in ${label} was ` +
      `recorded across ${section * 7} sessions; drift in tuning curves ` +
      `was measured against a stable behavioral readout (n = ${section}).\n\n`;
    parts.push(block);
    size += block.length;
  }
  return parts.join("");
}

async function importStandalone(
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<Zotero.Item> {
  await IOUtils.write(path, bytes);
  try {
    return await Zotero.Attachments.importFromFile({
      file: path,
      libraryID: Zotero.Libraries.userLibraryID,
      contentType,
    } as any);
  } finally {
    await IOUtils.remove(path, { ignoreAbsent: true });
  }
}

describe("workflow: MinerU sync lookup for a parentless PDF", function () {
  this.timeout(600000);

  // The library index restores synced caches in the background through the
  // plugin's own copy of the cache module, whose write lock this bundle's
  // writes do not share. Pause it so only this test reads and writes caches.
  const indexPref = "extensions.zotero.llmforzotero.libraryTextIndexEnabled";
  let oldIndex: unknown;
  before(function () {
    oldIndex = Zotero.Prefs.get(indexPref, true);
    Zotero.Prefs.set(indexPref, false, true);
  });
  after(function () {
    if (oldIndex === undefined) Zotero.Prefs.clear(indexPref, true);
    else Zotero.Prefs.set(indexPref, oldIndex as boolean, true);
  });

  it("restores, reports, and deletes the source's packages without reading other papers' packages or PDFs", async function () {
    const io = (globalThis as any).IOUtils;
    const tempDir = Zotero.getTempDirectory().path;
    const stamp = Date.now();
    const originalToolkit = (globalThis as any).ztoolkit;
    const pref = "extensions.zotero.llmforzotero.mineruSyncEnabled";
    const oldSync = Zotero.Prefs.get(pref, true);
    const restoreInvalidator = composeRetrievalCandidateInvalidation();
    const createdItemIds: number[] = [];
    const cacheIds: number[] = [];
    const originalReadDescriptor = Object.getOwnPropertyDescriptor(io, "read");
    const originalRead = io.read;
    let reads: string[] | null = null;
    try {
      (globalThis as any).ztoolkit = (Zotero as any).LLMForZotero.data.ztoolkit;
      Zotero.Prefs.set(pref, true, true);

      // Source: a parentless imported PDF whose package is therefore a
      // standalone attachment, found only through the library-wide scan.
      const source = await importStandalone(
        PathUtils.join(tempDir, `mineru-512-source-${stamp}.pdf`),
        createPdfFixture(1),
        "application/pdf",
      );
      createdItemIds.push(source.id);
      cacheIds.push(source.id);
      assert.isFalse(Boolean(source.parentID));
      const sourceMd =
        "# Parentless source paper\n\nThe synced extraction of the source.";
      await writeMineruCacheFiles(source.id, sourceMd, [], { pageCount: 1 });
      const publishedMd = (await Zotero.File.getContentsAsync(
        PathUtils.join(getMineruItemDir(source.id), "full.md"),
      )) as string;
      const published = await publishMineruCachePackageForAttachment(source.id);
      assert.equal(published.status, "published", published.reason);
      const publishedPackage = Zotero.Items.get(published.packageAttachmentId!);
      createdItemIds.push(publishedPackage.id);
      assert.isFalse(Boolean(publishedPackage.parentID));
      const publishedPackagePath =
        (await publishedPackage.getFilePathAsync()) as string;

      // A second package for the source under a plain title, as when a user
      // re-imports an exported package ZIP by hand. Only its metadata names
      // the source, so the lookup must still open it.
      const plainBytes = await buildMineruSyncPackageBytes(source);
      assert.exists(plainBytes);
      const plainPackage = await importStandalone(
        PathUtils.join(tempDir, `shared-mineru-export-${stamp}.zip`),
        plainBytes!,
        "application/zip",
      );
      createdItemIds.push(plainPackage.id);
      plainPackage.setField("title", "Shared MinerU export.zip");
      await plainPackage.saveTx();
      const plainPackagePath =
        (await plainPackage.getFilePathAsync()) as string;
      await invalidateMineruMd(source.id);

      // Decoys: other parentless PDFs with large published packages.
      const decoyPdfPaths: string[] = [];
      const decoyPackagePaths: string[] = [];
      const decoyPackageIds: number[] = [];
      for (let index = 0; index < DECOY_COUNT; index++) {
        const decoy = await importStandalone(
          PathUtils.join(tempDir, `mineru-512-decoy-${index}-${stamp}.pdf`),
          createPdfFixture(1),
          "application/pdf",
        );
        createdItemIds.push(decoy.id);
        cacheIds.push(decoy.id);
        decoyPdfPaths.push((await decoy.getFilePathAsync()) as string);
        await writeMineruCacheFiles(
          decoy.id,
          buildLargeMarkdown(`Decoy paper ${index}`, DECOY_MD_BYTES),
          [],
          { pageCount: 1 },
        );
        const decoyPublished = await publishMineruCachePackageForAttachment(
          decoy.id,
        );
        assert.equal(decoyPublished.status, "published", decoyPublished.reason);
        const decoyPackage = Zotero.Items.get(
          decoyPublished.packageAttachmentId!,
        );
        createdItemIds.push(decoyPackage.id);
        decoyPackageIds.push(decoyPackage.id);
        decoyPackagePaths.push(
          (await decoyPackage.getFilePathAsync()) as string,
        );
        await invalidateMineruMd(decoy.id);
      }

      // Record every file path this bundle's IOUtils.read opens.
      Object.defineProperty(io, "read", {
        configurable: true,
        writable: true,
        value: function (path: string, ...rest: unknown[]) {
          reads?.push(String(path));
          return originalRead.call(io, path, ...rest);
        },
      });
      const phase = async <T>(
        label: string,
        run: () => Promise<T>,
      ): Promise<{ value: T; read: string[]; ms: number }> => {
        reads = [];
        const started = Date.now();
        const value = await run();
        const ms = Date.now() - started;
        const read = reads;
        reads = null;
        console.log(
          `MinerU parentless lookup (${DECOY_COUNT} decoys) ${label}: ${ms} ms, ${read.length} reads`,
        );
        return { value, read, ms };
      };

      const availability = await phase("availability", () =>
        getMineruAvailabilityForAttachment(source),
      );
      assert.equal(availability.value.status, "synced");
      assert.isTrue(availability.value.syncedPackage);

      const restore = await phase("restore", () =>
        ensureMineruRuntimeCacheForAttachment(source),
      );
      assert.equal(restore.value.status, "restored", restore.value.reason);
      assert.equal(
        await Zotero.File.getContentsAsync(
          PathUtils.join(getMineruItemDir(source.id), "full.md"),
        ),
        publishedMd,
      );

      const deletion = await phase("delete", () =>
        deleteMineruCacheArtifactsForAttachment(source.id),
      );
      assert.equal(deletion.value.removedSyncPackages, 2);
      assert.equal(deletion.value.failed, 0);

      // Native post-state: both source packages are gone, decoys remain.
      for (const id of [publishedPackage.id, plainPackage.id]) {
        const item = Zotero.Items.get(id);
        assert.isTrue(!item || Boolean(item.deleted), `package ${id} deleted`);
      }
      for (const id of decoyPackageIds) {
        const item = Zotero.Items.get(id);
        assert.isTrue(Boolean(item) && !item.deleted, `decoy ${id} kept`);
      }

      // Positive controls: the wrapper really records reads of the source's
      // packages, so an empty decoy intersection is meaningful.
      assert.include(availability.read, publishedPackagePath);
      assert.include(restore.read, publishedPackagePath);
      assert.include(restore.read, plainPackagePath);
      assert.include(deletion.read, plainPackagePath);
      for (const step of [availability, restore, deletion]) {
        const decoyReads = step.read.filter(
          (path) =>
            decoyPackagePaths.includes(path) || decoyPdfPaths.includes(path),
        );
        assert.deepEqual(decoyReads, [], "no decoy package or PDF is read");
      }
      assert.deepEqual(
        deletion.read.filter((path) => path.toLowerCase().endsWith(".pdf")),
        [],
        "package deletion reads no PDF bytes",
      );
    } finally {
      if (originalReadDescriptor) {
        Object.defineProperty(io, "read", originalReadDescriptor);
      } else {
        delete io.read;
      }
      for (const id of cacheIds) await invalidateMineruMd(id);
      for (const id of createdItemIds.reverse()) {
        const item = Zotero.Items.get(id);
        if (item) await item.eraseTx();
      }
      if (oldSync === undefined) Zotero.Prefs.clear(pref, true);
      else Zotero.Prefs.set(pref, oldSync, true);
      restoreInvalidator();
      (globalThis as any).ztoolkit = originalToolkit;
    }
  });
});
