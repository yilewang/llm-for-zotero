import { assert } from "chai";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  parsePdfWithMineru,
  publishMineruParsedResult,
} from "../../src/services/mineru/mineruParser";
import {
  getMineruItemDir,
  readCachedMineruMd,
  readMineruContentListFromDir,
  readManifest,
} from "../../src/services/mineru/mineruCache";
import { testMineruLocalConnection } from "../../src/utils/mineruClient";
import { composeRetrievalCandidateInvalidation } from "../../test/helpers/hostSurfaces";

// Explicit opt-in suite. Start MinerU 4 with --tier flash --port 18746 first.
// Auto must pick flash on that server without any settings change.
describe("live: MinerU V1 in Zotero", function () {
  this.timeout(120000);

  it("parses a two-page PDF with an image through the real service with Flash selected and publishes the cache", async function () {
    await parseLiveTwoPagePdf("flash");
  });

  it("parses the same PDF with Auto on a Flash-only server and publishes the cache", async function () {
    await parseLiveTwoPagePdf("auto");
  });
});

async function parseLiveTwoPagePdf(tier: "flash" | "auto") {
  const prefix = "extensions.zotero.llmforzotero.";
  const settings = {
    mineruMode: "local",
    mineruLocalApiBase: "http://127.0.0.1:18746",
    mineruLocalTier: tier,
    mineruLocalApiKey: "",
    mineruForceOcr: false,
    mineruSyncEnabled: false,
    libraryTextIndexEnabled: false,
  };
  const old = Object.fromEntries(
    Object.keys(settings).map((key) => [
      key,
      Zotero.Prefs.get(prefix + key, true),
    ]),
  );
  const io = (globalThis as any).IOUtils;
  const oldToolkit = (globalThis as any).ztoolkit;
  const restoreInvalidator = composeRetrievalCandidateInvalidation();
  const source = PathUtils.join(Zotero.DataDirectory.dir, "mineru-live-v1.pdf");
  const parent = new Zotero.Item("journalArticle");
  parent.setField("title", "MinerU V1 live validation");
  await parent.saveTx();
  let attachment: Zotero.Item | undefined;
  const stages: string[] = [];
  try {
    for (const [key, value] of Object.entries(settings))
      Zotero.Prefs.set(prefix + key, value, true);
    (globalThis as any).ztoolkit = (Zotero as any).LLMForZotero.data.ztoolkit;
    const service = await testMineruLocalConnection(
      settings.mineruLocalApiBase,
    );
    assert.equal(service.api, "v1");
    assert.deepEqual(
      service.api === "v1" ? service.tiers : [],
      ["flash"],
      "start the live server with --tier flash",
    );
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const first = pdf.addPage([612, 792]);
    first.drawText("MinerU live compatibility test", {
      x: 60,
      y: 720,
      font,
      size: 20,
    });
    first.drawText(
      "The quick brown fox provides a reproducible text extraction check.",
      { x: 60, y: 690, font, size: 12 },
    );
    const png = await pdf.embedPng(
      Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/e8AAAAASUVORK5CYII=",
        ),
        (c) => c.charCodeAt(0),
      ),
    );
    first.drawImage(png, { x: 60, y: 600, width: 80, height: 60 });
    first.drawText("Figure 1. Test rectangle.", {
      x: 60,
      y: 580,
      font,
      size: 12,
    });
    pdf
      .addPage([612, 792])
      .drawText("Second page verifies complete extraction.", {
        x: 60,
        y: 720,
        font,
        size: 12,
      });
    await io.write(source, await pdf.save());
    attachment = await Zotero.Attachments.linkFromFile({
      file: source,
      parentItemID: parent.id,
      contentType: "application/pdf",
    });
    const result = await parsePdfWithMineru(
      source,
      (stage) => stages.push(stage),
      undefined,
      { attachmentId: attachment.id },
    );
    assert.isNotNull(result, stages.join("\n"));
    assert.notInclude(stages.join("\n"), "isn't offered");
    assert.equal(result!.pageCount, 2);
    assert.include(
      result!.mdContent,
      "Second page verifies complete extraction.",
    );
    assert.isTrue(
      result!.files.some((file) => file.relativePath.startsWith("images/")),
    );
    await publishMineruParsedResult(attachment, result!);
    assert.include(
      await readCachedMineruMd(attachment.id),
      "Second page verifies complete extraction.",
    );
    const manifest = await readManifest(attachment.id);
    assert.equal(manifest!.totalPages, 2);
    const content = await readMineruContentListFromDir(
      getMineruItemDir(attachment.id),
    );
    assert.isTrue(
      content.some((entry) => entry.type === "image" && entry.page_idx === 0),
    );
    await io.write(
      PathUtils.join(
        Zotero.DataDirectory.dir,
        `mineru-live-evidence-${tier}.json`,
      ),
      new TextEncoder().encode(
        JSON.stringify(
          {
            service,
            tier,
            stages,
            pageCount: result!.pageCount,
            files: result!.files.map((file) => file.relativePath),
            content,
          },
          null,
          2,
        ),
      ),
    );
  } finally {
    (globalThis as any).ztoolkit = oldToolkit;
    restoreInvalidator();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) Zotero.Prefs.clear(prefix + key, true);
      else Zotero.Prefs.set(prefix + key, value as any, true);
    }
    await parent.eraseTx();
    await io.remove(source, { ignoreAbsent: true });
    if (attachment)
      await io.remove(getMineruItemDir(attachment.id), {
        recursive: true,
        ignoreAbsent: true,
      });
  }
}
