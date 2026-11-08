import { assert } from "chai";
import { buildAgentTraceDisplayItemsCanonical } from "../src/modules/contextPanel/agentTrace/render";
import { createFileIOTool } from "../src/agent/tools/write/fileIO";
import { resolveAgentToolCallWorkCategory } from "../src/agent/workCategory";
import type { AgentEvent, AgentRunEventRecord } from "../src/agent/types";

function toolResult(
  callId: string,
  name: string,
  storedPaths: string[],
): AgentEvent {
  return {
    type: "tool_result",
    callId,
    name,
    ok: true,
    actionReceipts: [],
    content: {},
    artifacts: storedPaths.map((storedPath) => ({
      kind: "image",
      mimeType: "image/png",
      storedPath,
    })),
  } as unknown as AgentEvent;
}

function project(payloads: AgentEvent[]) {
  const events = payloads.map(
    (payload, i) =>
      ({
        runId: "run",
        seq: i + 1,
        eventType: payload.type,
        payload,
        createdAt: i + 1,
      }) as AgentRunEventRecord,
  );
  const { items } = buildAgentTraceDisplayItemsCanonical(events, null, null);
  const found: any[] = [];
  const walk = (value: any) => {
    if (!value || typeof value !== "object") return;
    if (value.type === "image_grid") found.push(value);
    for (const child of Object.values(value)) walk(child);
  };
  walk(items);
  return found;
}

describe("agent trace image artifacts", function () {
  it("shows an image once per trace, matching Windows and POSIX separators", function () {
    const grids = project([
      toolResult("a", "paper_read", ["C:\\z\\figure_crops\\f1.png"]),
      toolResult("b", "file_io", ["C:/z/figure_crops/f1.png"]),
    ]);
    assert.lengthOf(grids, 1);
    assert.lengthOf(grids[0].images, 1);
  });

  it("drops only the repeated image from a mixed grid", function () {
    const grids = project([
      toolResult("a", "paper_read", ["/z/f1.png"]),
      toolResult("b", "paper_read", ["/z/f1.png", "/z/f2.png"]),
    ]);
    assert.lengthOf(grids, 2);
    assert.deepEqual(
      grids[1].images.map((image: any) => image.path),
      ["/z/f2.png"],
    );
  });
});

describe("file_io work category", function () {
  const tool = createFileIOTool();
  const category = (args: unknown) =>
    resolveAgentToolCallWorkCategory(tool, args);
  const g = globalThis as any;
  let saved: unknown;
  before(function () {
    saved = g.Zotero;
    g.Zotero = { DataDirectory: { dir: "/Users/u/Zotero" } };
  });
  after(function () {
    g.Zotero = saved;
  });

  it("files a read of the plugin's MinerU cache under retrieval", function () {
    assert.equal(
      category({
        action: "read",
        filePath:
          "/Users/u/Zotero/llm-for-zotero-mineru/12/figure_crops/f1.png",
      }),
      "retrieval",
    );
    assert.equal(
      category({
        action: "read",
        filePath: "\\Users\\u\\Zotero\\llm-for-zotero-mineru\\12\\full.md",
      }),
      "retrieval",
    );
  });

  it("keeps writes and other paths as external_system", function () {
    assert.equal(
      category({
        action: "write",
        filePath: "/Users/u/Zotero/llm-for-zotero-mineru/12/a.py",
        content: "x",
      }),
      "external_system",
    );
    assert.equal(
      category({ action: "read", filePath: "/Users/u/Desktop/data.csv" }),
      "external_system",
    );
  });
});
