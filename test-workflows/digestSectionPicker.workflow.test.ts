/**
 * A section-scoped digest reads the parts the user named in the paper's own
 * words, against real Zotero items, a real collection and real MinerU cache
 * files:
 * - the collection holds a Chinese paper (two-character headings 摘要, 方法,
 *   结果) and an English one;
 * - the user asks for the results ("results"); the reader model picks each
 *   paper's matching section from its outline, in any language;
 * - the Chinese 结果 section is read and its 方法 section is not; the
 *   coverage names each paper's native heading;
 * - the MinerU text each paper was read from is read back from native
 *   storage and equals what the test wrote.
 *
 * The reader model is a scripted stub (no live provider); the items, the
 * collection, the MinerU cache, the section picker, the digest worker and
 * paper_digest are the plugin's own.
 */
import { assert } from "chai";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";
import {
  QUESTION,
  fakeReader,
  idOf,
} from "../test/helpers/sectionPickerFixtures";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { PdfService } from "../src/agent/services/pdfService";
import { createZoteroPaperDigestSources } from "../src/agent/digests/digestJobHost";
import { clearSectionPickCache } from "../src/agent/digests/sectionPicker";
import {
  clearPaperDigestRunBounds,
  createPaperDigestTool,
  type PaperDigestResult,
} from "../src/agent/tools/read/paperDigest";
import {
  readCachedMineruMd,
  writeMineruCacheFiles,
  invalidateMineruMd,
} from "../src/services/mineru/mineruCache";
import type { AgentToolContext } from "../src/agent/types";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

declare const Zotero: any;

const ZH_RESULTS = "解码准确率在十天内的每一天都高于随机水平。";
const ZH_METHODS = "我们用双光子成像记录了四十个位置细胞。";
const EN_RESULTS =
  "Decoding of position stayed above chance on every one of the ten days.";
const EN_METHODS = "We imaged forty place cells with two-photon microscopy.";

const ZH_MD = [
  "# 海马位置细胞的表征漂移",
  "",
  "## 摘要",
  "",
  "本文研究表征漂移是否影响位置解码。",
  "",
  "## 方法",
  "",
  ZH_METHODS,
  "",
  "## 结果",
  "",
  ZH_RESULTS,
].join("\n");

const EN_MD = [
  "# Representational drift in hippocampal place cells",
  "",
  "## Abstract",
  "",
  "We ask whether drift impairs the decoding of position.",
  "",
  "## Methods",
  "",
  EN_METHODS,
  "",
  "## Results",
  "",
  EN_RESULTS,
].join("\n");

type DigestRow = PaperDigestResult["papers"][number] & Record<string, any>;

describe("workflow: a section-scoped digest picks the named part in any language", function () {
  this.timeout(180000);
  let api: WorkflowTestApi;
  let libraryID: number;
  let collectionID: number;
  let chinese: WorkflowTestFixture;
  let english: WorkflowTestFixture;
  const fixtures: WorkflowTestFixture[] = [];
  const originalToolkit = (globalThis as any).ztoolkit;

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = Zotero.LLMForZotero.api.workflowTest;
    await api.reset();
    libraryID = Zotero.Libraries.userLibraryID;
    (globalThis as any).ztoolkit = (Zotero as any).LLMForZotero.data.ztoolkit;
    const stamp = Date.now();
    chinese = await api.createPaperWithPdfFixture({
      title: `表征漂移 ${stamp}`,
      pages: ["Fixture page for the Chinese paper."],
    });
    english = await api.createPaperWithPdfFixture({
      title: `Representational drift ${stamp}`,
      pages: ["Fixture page for the English paper."],
    });
    fixtures.push(chinese, english);
    await writeMineruCacheFiles(chinese.pdfAttachmentId, ZH_MD, [], {
      pageCount: 1,
    });
    await writeMineruCacheFiles(english.pdfAttachmentId, EN_MD, [], {
      pageCount: 1,
    });
    // The two papers share one collection, as a folder of mixed-language papers.
    const collection = new Zotero.Collection();
    collection.libraryID = libraryID;
    collection.name = `Mixed-language papers ${stamp}`;
    collectionID = await collection.saveTx();
    for (const fixture of fixtures) {
      const parent = Zotero.Items.get(fixture.parentItemId);
      parent.addToCollection(collectionID);
      await parent.saveTx();
    }
  });

  after(async function () {
    clearPaperDigestRunBounds();
    clearSectionPickCache();
    for (const fixture of fixtures) {
      await invalidateMineruMd(fixture.pdfAttachmentId);
      await api.cleanupFixture(fixture);
    }
    const collection = Zotero.Collections.get(collectionID);
    if (collection) await collection.eraseTx();
    (globalThis as any).ztoolkit = originalToolkit;
  });

  function context(runId: string): AgentToolContext {
    const request = resolvedAgentRequest({
      conversationKey: 0,
      mode: "agent",
      userText: QUESTION,
      libraryID,
      model: "gpt-workflow",
    });
    Object.assign(request, {
      authMode: "codex_app_server",
      providerProtocol: "codex_responses",
      exhaustiveReadBackend: "codex_responses",
      executionContext: { permissionOwner: "external_runtime" },
    });
    return {
      request,
      item: null,
      currentAnswerText: "",
      modelName: "workflow",
      runId,
    } as unknown as AgentToolContext;
  }

  it("reads each paper's own results section, not its methods, and names the native headings", async function () {
    // Native readback: the collection holds both papers, and the MinerU
    // text on disk is what the test wrote.
    const collection = Zotero.Collections.get(collectionID);
    const inCollection: number[] = collection.getChildItems(true);
    assert.includeMembers(inCollection, [
      chinese.parentItemId,
      english.parentItemId,
    ]);
    assert.equal(await readCachedMineruMd(chinese.pdfAttachmentId), ZH_MD);
    assert.equal(await readCachedMineruMd(english.pdfAttachmentId), EN_MD);

    // The picker's reply per paper: the section whose heading is the
    // results, in that paper's language.
    const reader = fakeReader((prompt) => ({
      parts: [
        {
          name: "results",
          sections: [
            idOf(
              prompt,
              prompt.includes("Title: 表征漂移") ? "## 结果" : "## Results",
            ),
          ],
        },
      ],
    }));
    const digestTool = createPaperDigestTool({
      ...createZoteroPaperDigestSources({
        zoteroGateway: new ZoteroGateway(),
        pdfService: new PdfService(),
      }),
      readerFactories: reader.factories,
      wait: async () => undefined,
    });
    const validated = digestTool.validate!({
      targets: [chinese.parentItemId, english.parentItemId],
      instruction: "Report each paper's results",
      read: { source: "sections", sections: ["results"] },
    });
    assert.isTrue(validated.ok, JSON.stringify(validated));
    if (!validated.ok) throw new Error("invalid input");
    const result = (await digestTool.execute(
      validated.value,
      context(`section-picker-${Date.now()}`),
    )) as PaperDigestResult;
    const rowOf = (itemId: number) =>
      result.papers.find((row) => row.itemId === itemId) as DigestRow;

    // One pick per paper, in the user's words, with the user's question.
    assert.lengthOf(reader.pickPrompts, 2);
    for (const prompt of reader.pickPrompts) {
      assert.include(prompt, QUESTION);
      assert.include(prompt, '"results"');
    }

    const zh = rowOf(chinese.parentItemId);
    assert.equal(zh.status, "digested", JSON.stringify(zh));
    // The coverage names the paper's native heading for the English name.
    assert.deepEqual(zh.source.covered, ["结果 (for: results)"]);
    assert.isUndefined(zh.source.unmatched);

    const en = rowOf(english.parentItemId);
    assert.equal(en.status, "digested", JSON.stringify(en));
    assert.deepEqual(en.source.covered, ["Results"]);
    assert.isUndefined(en.source.unmatched);

    // The reader model was shown each paper's results and neither paper's methods.
    const digestText = reader.digestPrompts.join("\n");
    assert.lengthOf(reader.digestPrompts, 2);
    assert.include(digestText, ZH_RESULTS);
    assert.include(digestText, EN_RESULTS);
    assert.notInclude(digestText, ZH_METHODS);
    assert.notInclude(digestText, EN_METHODS);
  });
});
