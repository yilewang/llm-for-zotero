import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import type { AgentRunEventRecord } from "../src/agent/types";
import { createFileIOTool } from "../src/agent/tools/write/fileIO";
import { getMineruCacheDir } from "../src/services/mineru/mineruCache";

const getApi = () =>
  (Zotero as any).LLMForZotero.api.workflowTest as WorkflowTestApi;

async function writePng(dir: string, name: string): Promise<string> {
  const doc = Zotero.getMainWindow().document;
  const canvas = doc.createElement("canvas");
  canvas.width = canvas.height = 4;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "rgb(200, 30, 30)";
  context.fillRect(0, 0, 4, 4);
  const base64 = canvas.toDataURL("image/png").split(",")[1];
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const path = PathUtils.join(dir, name);
  await IOUtils.write(path, bytes);
  return path;
}

function toolResult(
  seq: number,
  name: string,
  storedPath: string,
): AgentRunEventRecord {
  return {
    runId: "trace-figure-images",
    seq,
    createdAt: seq,
    eventType: "tool_result",
    payload: {
      type: "tool_result",
      callId: `call-${seq}`,
      name,
      ok: true,
      content: { ok: true },
      actionReceipts: [],
      artifacts: [
        {
          kind: "image",
          mimeType: "image/png",
          storedPath,
          title: "Figure 2",
        },
      ],
    },
  } as AgentRunEventRecord;
}

describe("workflow: Trace figure images", function () {
  this.timeout(30000);

  async function renderTrace(
    secondPath: (first: string, other: string) => string,
  ) {
    const api = getApi();
    const dir = PathUtils.join(
      PathUtils.tempDir,
      `llm-trace-figures-${Date.now()}`,
    );
    await IOUtils.makeDirectory(dir, { createAncestors: true });
    const fixture = await api.createPaperWithPdfFixture({
      title: "Trace figure images",
      pages: ["Disposable UI fixture."],
    });
    try {
      const first = await writePng(dir, "figure-2-p4.png");
      const other = await writePng(dir, "figure-3-p5.png");
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      await api.seedPanelStoredTurn(panel.panelId, "Show figure 2", "", {
        runMode: "agent",
        pendingAgentTraceEvents: [
          toolResult(1, "paper_read", first),
          toolResult(2, "file_io", secondPath(first, other)),
        ],
      });
      const root = Zotero.getMainWindow().document.querySelector<HTMLElement>(
        `[data-workflow-panel-id="${panel.panelId}"] .llm-panel`,
      )!;
      assert.exists(root);
      return {
        images: root.querySelectorAll(".llm-agent-image-artifacts img").length,
        text: root.textContent || "",
      };
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
      await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    }
  }

  it("shows a figure crop once when the agent extracts and then reads it", async function () {
    const same = await renderTrace((first) => first);
    assert.equal(same.images, 1, "same path is shown once");
    assert.notInclude(same.text, "Prepared image artifact");
  });

  it("treats a backslash spelling of the same path as the same figure", async function () {
    const swapped = await renderTrace((first) => first.replace(/\//g, "\\"));
    assert.equal(swapped.images, 1, "separator style does not matter");
  });

  it("shows two images when the second step reads a different figure", async function () {
    const different = await renderTrace((_first, other) => other);
    assert.equal(different.images, 2, "control: distinct files both show");
  });

  it("labels a file_io read of the plugin's cache as reading evidence", function () {
    const tool = createFileIOTool();
    const resolve = tool.resolveWorkCategory!;
    assert.isFunction(resolve);
    const crop = PathUtils.join(
      getMineruCacheDir(),
      "1234",
      "figure_crops",
      "crops",
      "figure-2-p4.png",
    );
    assert.equal(resolve({ action: "read", path: crop }), "retrieval");
    assert.equal(resolve({ action: "read", filePath: crop }), "retrieval");
    const forward = crop.replace(/\\/g, "/");
    assert.equal(resolve({ action: "read", path: forward }), "retrieval");
    assert.equal(
      resolve({ action: "read", path: crop.replace(/\//g, "\\") }),
      "retrieval",
    );
    assert.isUndefined(
      resolve({ action: "write", path: crop, content: "x" }),
      "a write stays an external action",
    );
    assert.isUndefined(
      resolve({
        action: "read",
        path: PathUtils.join(PathUtils.tempDir, "notes.txt"),
      }),
      "a read outside the cache stays an external action",
    );
  });
});
