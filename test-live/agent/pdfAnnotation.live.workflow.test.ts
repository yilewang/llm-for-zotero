import { assert } from "chai";
import { resolveLiveAgentCredentials } from "./liveAgentCredentials";
import {
  writeMineruCacheFiles,
  writeMineruSourceProvenanceForAttachment,
} from "../../src/services/mineru/mineruCache";

declare const Zotero: any;
declare const Services: any;
declare const IOUtils: any;
const env = (name: string) => String(Services.env.get(name) || "");
const sourcePdf = env("LLM_FOR_ZOTERO_ANNOTATION_PDF");
const sourceMarkdown = env("LLM_FOR_ZOTERO_ANNOTATION_MARKDOWN");

describe("live model PDF annotation", function () {
  this.timeout(180000);
  before(function () {
    if (!sourcePdf || !sourceMarkdown) this.skip();
  });
  let paper: any;
  let attachment: any;
  after(async function () {
    if (attachment) {
      const reader = Zotero.Reader._readers.find(
        (r: any) => r.itemID === attachment.id,
      );
      if (reader) await reader.close();
      await attachment.eraseTx();
    }
    if (paper) await paper.eraseTx();
  });
  it("annotates the core conclusion through the normal model tool surface", async function () {
    const credentials = await resolveLiveAgentCredentials();
    assert.isOk(credentials, "Live DeepSeek credentials must be configured");
    assert.include(credentials!.model, "deepseek");
    paper = new Zotero.Item("journalArticle");
    paper.libraryID = Zotero.Libraries.userLibraryID;
    paper.setField("title", "Learning continually with representational drift");
    await paper.saveTx();
    attachment = await Zotero.Attachments.importFromFile({
      file: sourcePdf,
      parentItemID: paper.id,
    });
    const markdown = String(await Zotero.File.getContentsAsync(sourceMarkdown));
    await writeMineruCacheFiles(attachment.id, markdown, [
      { relativePath: "full.md", data: new TextEncoder().encode(markdown) },
    ]);
    await writeMineruSourceProvenanceForAttachment(attachment);
    const api = Zotero.LLMForZotero.api.agent;
    const calls: Array<{ name: string; args: any }> = [];
    const receipts: any[] = [];
    const errors: string[] = [];
    const start = Date.now();
    const result = await api.runTurn(
      {
        conversationKey: paper.id,
        mode: "agent",
        conversationKind: "paper",
        libraryID: paper.libraryID,
        activeItemId: paper.id,
        activePaperContext: {
          itemId: paper.id,
          contextItemId: attachment.id,
          libraryID: paper.libraryID,
          title: paper.getField("title"),
        },
        ...credentials,
        userText:
          "make an annotation for me for the core conclusion of this paper",
      },
      (event: any) => {
        if (event.type === "tool_call")
          calls.push({ name: event.name, args: event.args });
        if (event.type === "tool_result")
          receipts.push(...(event.actionReceipts || []));
        if (event.type === "tool_error") errors.push(String(event.error));
        if (event.type === "confirmation_required")
          void api.resolveConfirmation(event.requestId, true);
      },
    );
    const annotations = attachment.getAnnotations();
    const report = {
      elapsedMs: Date.now() - start,
      kind: result.kind,
      calls,
      receipts,
      errors,
      annotations: annotations.map((item: any) => ({
        id: item.id,
        text: item.annotationText,
        comment: item.annotationComment,
        position: JSON.parse(item.annotationPosition),
      })),
    };
    const reportPath = env("LLM_FOR_ZOTERO_ANNOTATION_REPORT");
    if (reportPath) await IOUtils.writeJSON(reportPath, report);
    assert.equal(result.kind, "completed");
    assert.isEmpty(errors, errors.join("; "));
    assert.lengthOf(annotations, 1);
    assert.lengthOf(
      calls.filter((c) => c.name === "annotate_pdf"),
      1,
    );
    assert.isAtMost(
      calls.length,
      6,
      `Tools: ${calls.map((c) => c.name).join(", ")}`,
    );
    assert.isFalse(
      calls.some((c) =>
        ["run_command", "file_io", "zotero_script"].includes(c.name),
      ),
    );
    const position = JSON.parse(annotations[0].annotationPosition);
    assert.equal(position.pageIndex, 7);
    assert.isAtLeast(position.rects.length, 2);
    assert.include(annotations[0].annotationText.toLowerCase(), "plasticity");
    assert.include(annotations[0].annotationText.toLowerCase(), "stability");
    assert.isTrue(
      receipts.some(
        (r) =>
          r.operation === "annotation_write" && r.verification === "verified",
      ),
    );
    Zotero.debug(
      `[annotation-live] ${report.elapsedMs}ms; ${calls.length} calls; ${position.rects.length} lines`,
    );
  });
});
