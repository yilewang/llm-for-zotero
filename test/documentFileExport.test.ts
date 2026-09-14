import { assert } from "chai";
import { createFileIOTool } from "../src/agent/tools/write/fileIO";
import { sha256Bytes } from "../src/agent/store/journalRecoveryBlobStore";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import { classifiedFixture } from "./helpers/semanticIntent";

describe("finalized document file export", function () {
  const originalZotero = globalThis.Zotero;
  const originalIO = (globalThis as any).IOUtils;
  let files: Map<string, Uint8Array>;
  let document: any;
  let context: any;
  beforeEach(async function () {
    const bytes = new Uint8Array([137, 80, 78, 71, 255]);
    files = new Map([["/durable/figure.png", bytes]]);
    document = {
      version: 2,
      documentId: "export-doc",
      documentVersion: 1,
      conversationKey: 555,
      documentKind: "report",
      integrityPolicy: "authored",
      origin: {
        kind: "direct",
        runId: "export-run",
        sourceMessageTimestamp: 1,
      },
      title: "Figure report",
      visibleMarkdown: "# Figure report\n\nVerified explanation.",
      visibleHtml: "<p>Verified explanation.</p>",
      citationBundle: {
        clusters: [],
        bibliographyEntries: [],
        style: { id: "apa", title: "APA" },
        locale: "en-US",
      },
      verifiedQuotes: [],
      coverageItems: [],
      validation: {
        integrityValidated: true,
        groundingReviewed: "not_run",
        quoteVerified: "not_applicable",
        issues: [],
      },
      contentHash: "sha256:fixture",
      createdAt: 1,
      assets: [
        {
          assetId: "figure-1",
          contentHash: `sha256:${await sha256Bytes(bytes)}`,
          byteLength: bytes.length,
          mimeType: "image/png",
          caption: "Figure 1",
          durablePath: "/durable/figure.png",
          provenance: {
            origin: "generated",
            generator: "fixture",
            generatorVersion: "1",
            evidenceRefs: [],
          },
        },
      ],
    };
    globalThis.Zotero = {
      DB: {
        queryAsync: async (sql: string) => {
          if (
            sql.includes(
              "SELECT document_id AS documentId FROM llm_for_zotero_plan_documents",
            )
          )
            return [{ documentId: document.documentId }];
          if (
            sql.includes(
              "SELECT payload_json AS payloadJson FROM llm_for_zotero_plan_documents",
            )
          )
            return [{ payloadJson: JSON.stringify(document) }];
          return [];
        },
      },
    } as any;
    (globalThis as any).IOUtils = {
      exists: async (path: string) => files.has(path),
      read: async (path: string) => files.get(path) || new Uint8Array(),
      write: async (path: string, bytes: Uint8Array) => {
        files.set(path, new Uint8Array(bytes));
      },
      makeDirectory: async () => {},
    };
    context = {
      runId: "export-run",
      request: resolvedAgentRequest({
        conversationKey: 555,
        mode: "agent",
        userText: "Export the figure report",
        model: "fixture",
        libraryID: 1,
        classifiedIntent: classifiedFixture({
          deliverableIntent: "document",
          documentKind: "report",
        }),
      }),
      journalFallbackApproved: true,
    };
    context.request.documentOutcomePolicy = {
      required: true,
      documentKind: "report",
      integrityPolicy: "authored",
      trigger: "document_intent",
    };
    context.request.classifiedIntent.semantic.noteDestination = "file";
  });
  afterEach(function () {
    globalThis.Zotero = originalZotero;
    (globalThis as any).IOUtils = originalIO;
  });
  it("binds and exports finalized Markdown and verified image bytes without a shell command", async function () {
    const tool = createFileIOTool();
    const validated = tool.validate({
      action: "write",
      filePath: "/vault/report.md",
      content: document.visibleMarkdown,
    });
    if (!validated.ok) throw new Error(validated.error);
    const service = new ActionContractService({} as any);
    const prepared = await service.prepare(tool, validated.value, context);
    assert.equal(
      prepared.proposals[0].parameters?.documentId,
      document.documentId,
    );
    assert.equal(
      prepared.proposals[0].parameters?.contentHash,
      document.contentHash,
    );
    const plan = await tool.planInvocation(validated.value, context);
    assert.include(plan.targets, "/vault/report_assets/figure-1.png");
    const result = await tool.execute(validated.value, context);
    assert.deepEqual(
      files.get("/vault/report_assets/figure-1.png"),
      files.get("/durable/figure.png"),
    );
    const markdown = new TextDecoder().decode(files.get("/vault/report.md"));
    assert.include(markdown, "![Figure 1](report_assets/figure-1.png)");
    assert.equal(
      service.finalize(undefined, prepared, {
        ok: true,
        effect: result.effect,
        content: result.content,
      })[0].verification,
      "verified",
    );
    const corrupted = { ...(result.content as any), exportedFiles: [] };
    assert.equal(
      service.finalize(undefined, prepared, {
        ok: true,
        effect: result.effect,
        content: corrupted,
      })[0].verification,
      "unverified",
    );
  });
  it("resumes a partial bundle without rewriting its verified images", async function () {
    const tool = createFileIOTool();
    const validated = tool.validate({
      action: "write",
      filePath: "/vault/report.md",
      content: document.visibleMarkdown,
    });
    if (!validated.ok) throw new Error(validated.error);
    const io = (globalThis as any).IOUtils;
    const write = io.write;
    const writes: string[] = [];
    let interrupt = true;
    io.write = async (path: string, bytes: Uint8Array) => {
      writes.push(path);
      if (path === "/vault/report.md" && interrupt)
        throw new Error("Disk unavailable for the main document");
      await write(path, bytes);
    };
    let failure = "";
    try {
      await tool.execute(validated.value, context);
    } catch (error) {
      failure = String(error);
    }
    assert.include(failure, "Disk unavailable");
    assert.isTrue(files.has("/vault/report_assets/figure-1.png"));
    assert.equal(
      document.visibleMarkdown,
      "# Figure report\n\nVerified explanation.",
    );
    interrupt = false;
    await tool.execute(validated.value, context);
    assert.equal(writes.filter((path) => path.endsWith(".png")).length, 1);
    const repeated = await tool.execute(validated.value, context);
    assert.equal(repeated.effect, "none");
    assert.equal(writes.filter((path) => path.endsWith(".png")).length, 1);
  });
  it("rejects changed finalized payloads and corrupt assets before creating any export files", async function () {
    const tool = createFileIOTool();
    for (const content of ["Changed material", document.visibleMarkdown]) {
      if (content === document.visibleMarkdown)
        files.set("/durable/figure.png", new Uint8Array([0]));
      const validated = tool.validate({
        action: "write",
        filePath: "/vault/report.md",
        content,
      });
      if (!validated.ok) throw new Error(validated.error);
      let error = "";
      try {
        await tool.execute(validated.value, context);
      } catch (reason) {
        error = String(reason);
      }
      assert.isNotEmpty(error);
      assert.isFalse(files.has("/vault/report.md"));
    }
  });
});
