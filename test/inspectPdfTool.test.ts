import { assert } from "chai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSearchPaperTool } from "../src/agent/tools/read/searchPaper";
import { createReadAttachmentTool } from "../src/agent/tools/read/readAttachment";
import { createViewPdfPagesTool } from "../src/agent/tools/read/viewPdfPages";
import type { AgentToolContext, AgentToolResult } from "../src/agent/types";

describe("search_paper tool", function () {
  const baseContext: AgentToolContext = {
    request: {
      conversationKey: 5,
      mode: "agent",
      userText: "Explain what I'm looking at",
      selectedPaperContexts: [
        { itemId: 1, contextItemId: 101, title: "Paper One" },
        { itemId: 2, contextItemId: 202, title: "Paper Two" },
      ],
    },
    item: null,
    currentAnswerText: "",
    modelName: "gpt-5.4",
  };

  it("retrieves evidence across multiple paper contexts", async function () {
    const tool = createSearchPaperTool(
      {
        retrieveEvidence: async ({
          papers,
        }: {
          papers: Array<{ itemId: number }>;
        }) =>
          papers.map((paper, index) => ({
            paperContext: {
              itemId: paper.itemId,
              contextItemId: paper.itemId * 100,
              title: `Paper ${paper.itemId}`,
            },
            chunkIndex: index,
            text: `Evidence ${paper.itemId}`,
            score: 0.9 - index * 0.1,
            sourceLabel: `Paper ${paper.itemId}`,
          })),
      } as never,
      {
        ensurePaperContext: async () => {},
      } as never,
      {
        listPaperContexts: (request: AgentToolContext["request"]) =>
          request.selectedPaperContexts || [],
      } as never,
    );

    const validated = tool.validate({
      question: "What is the method?",
      targets: [
        { paperContext: { itemId: 1, contextItemId: 101, title: "Paper One" } },
        { paperContext: { itemId: 2, contextItemId: 202, title: "Paper Two" } },
      ],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const result = await tool.execute(validated.value, baseContext);
    assert.lengthOf((result as { results: unknown[] }).results, 2);
  });

  it("uses presentation summaries for evidence retrieval", function () {
    const tool = createSearchPaperTool(
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [],
      } as never,
    );

    const onSuccess = tool.presentation?.summaries?.onSuccess;
    assert.equal(
      typeof onSuccess === "function"
        ? onSuccess({
            content: {
              results: [{}, {}],
            },
          } as never)
        : "",
      "Retrieved 2 evidence passages",
    );
  });
});

describe("read_attachment tool", function () {
  const baseContext: AgentToolContext = {
    request: {
      conversationKey: 5,
      mode: "agent",
      userText: "Explain what I'm looking at",
      attachments: [
        {
          id: "att-1",
          name: "notes.txt",
          mimeType: "text/plain",
          category: "text",
          textContent: "Attached notes",
          storedPath: "/tmp/notes.txt",
        },
      ],
      selectedPaperContexts: [
        { itemId: 1, contextItemId: 101, title: "Paper One" },
        { itemId: 2, contextItemId: 202, title: "Paper Two" },
      ],
    },
    item: null,
    currentAnswerText: "",
    modelName: "gpt-5.4",
  };

  it("requires confirmation before sending an attached file to the model", async function () {
    const tool = createReadAttachmentTool({} as never, {} as never);

    const validated = tool.validate({
      attachFile: true,
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const shouldConfirm = await tool.shouldRequireConfirmation?.(
      validated.value,
      baseContext,
    );
    assert.isTrue(shouldConfirm);
    const pending = await tool.createPendingAction?.(
      validated.value,
      baseContext,
    );
    assert.exists(pending);
    assert.equal(pending?.toolName, "read_attachment");
    assert.equal(pending?.confirmLabel, "Send to model");
  });
});

describe("view_pdf_pages tool", function () {
  const baseContext: AgentToolContext = {
    request: {
      conversationKey: 5,
      mode: "agent",
      userText: "Explain what I'm looking at",
      selectedPaperContexts: [
        { itemId: 1, contextItemId: 101, title: "Paper One" },
        { itemId: 2, contextItemId: 202, title: "Paper Two" },
      ],
    },
    item: null,
    currentAnswerText: "",
    modelName: "gpt-5.4",
  };

  it("builds a multimodal follow-up message for capture", async function () {
    const tempDir = mkdtempSync(join(tmpdir(), "llm-zotero-view-pdf-pages-"));
    const imagePath = join(tempDir, "capture.png");
    const restoreIOUtils = (
      globalThis as typeof globalThis & {
        IOUtils?: { read?: (path: string) => Promise<Uint8Array> };
      }
    ).IOUtils;
    const restoreBtoa = (
      globalThis as typeof globalThis & { btoa?: (value: string) => string }
    ).btoa;
    writeFileSync(imagePath, Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 4]));
    try {
      (
        globalThis as typeof globalThis & {
          IOUtils?: { read?: (path: string) => Promise<Uint8Array> };
        }
      ).IOUtils = {
        read: async (path: string) => new Uint8Array(readFileSync(path)),
      };
      (
        globalThis as typeof globalThis & { btoa?: (value: string) => string }
      ).btoa = (value: string) =>
        Buffer.from(value, "binary").toString("base64");

      const tool = createViewPdfPagesTool(
        {
          getActivePageIndex: () => 3,
          captureActiveView: async () => ({
            target: {
              source: "library" as const,
              title: "Paper One",
              contextItemId: 101,
              itemId: 1,
              paperContext: {
                itemId: 1,
                contextItemId: 101,
                title: "Paper One",
              },
            },
            capturedPage: {
              pageIndex: 3,
              pageLabel: "4",
              imagePath,
              contentHash: "hash-1",
            },
            artifacts: [
              {
                kind: "image" as const,
                mimeType: "image/png",
                storedPath: imagePath,
                pageIndex: 3,
                pageLabel: "4",
              },
            ],
            pageText: "Visible equation text",
          }),
        } as never,
        {
          listPaperContexts: () => [],
        } as never,
      );

      const validated = tool.validate({ capture: true });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;
      const execution = (await tool.execute(validated.value, baseContext)) as {
        content: Record<string, unknown>;
        artifacts: AgentToolResult["artifacts"];
      };
      const followup = await tool.buildFollowupMessage?.(
        {
          callId: "call-1",
          name: "view_pdf_pages",
          ok: true,
          content: execution.content,
          artifacts: execution.artifacts,
        },
        baseContext,
      );
      assert.exists(followup);
      assert.isArray(followup?.content);
      const parts = followup?.content as Array<{ type: string }>;
      assert.deepEqual(
        parts.map((part) => part.type),
        ["text", "image_url"],
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      (
        globalThis as typeof globalThis & {
          IOUtils?: { read?: (path: string) => Promise<Uint8Array> };
        }
      ).IOUtils = restoreIOUtils;
      (
        globalThis as typeof globalThis & { btoa?: (value: string) => string }
      ).btoa = restoreBtoa;
    }
  });

  it("uses presentation summaries for page results", function () {
    const tool = createViewPdfPagesTool(
      {} as never,
      {
        listPaperContexts: () => [],
      } as never,
    );

    const onSuccess = tool.presentation?.summaries?.onSuccess;
    assert.equal(
      typeof onSuccess === "function"
        ? onSuccess({
            content: {
              pageCount: 1,
            },
          } as never)
        : "",
      "Prepared 1 PDF page image",
    );
  });
});
