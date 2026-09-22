import { assert } from "chai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import type { AgentToolContext, AgentToolResult } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

type TestGlobals = typeof globalThis & {
  IOUtils?: { read?: (path: string) => Promise<Uint8Array> };
  btoa?: (value: string) => string;
};

function context(inputMode: "vision_allowed" | "text_only"): AgentToolContext {
  return {
    request: resolvedAgentRequest({
      conversationKey: 5,
      mode: "agent",
      userText: "Does the paper state this formula?",
      model: "gpt-5.4",
      advanced: { inputMode },
    }),
    item: null,
    currentAnswerText: "",
    modelName: "gpt-5.4",
  };
}

function tool() {
  return createPaperReadTool(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

function partTypes(message: unknown): string[] {
  const content = (message as { content?: unknown } | null)?.content;
  return Array.isArray(content)
    ? content.map((part: { type: string }) => part.type)
    : [];
}

describe("paper_read image follow-up", function () {
  const globals = globalThis as TestGlobals;
  let tempDir = "";
  let imagePath = "";
  let restoreIOUtils: TestGlobals["IOUtils"];
  let restoreBtoa: TestGlobals["btoa"];

  beforeEach(function () {
    tempDir = mkdtempSync(join(tmpdir(), "llm-zotero-paper-read-images-"));
    imagePath = join(tempDir, "figure.png");
    writeFileSync(imagePath, Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 4]));
    restoreIOUtils = globals.IOUtils;
    restoreBtoa = globals.btoa;
    globals.IOUtils = {
      read: async (path: string) => new Uint8Array(readFileSync(path)),
    };
    globals.btoa = (value: string) =>
      Buffer.from(value, "binary").toString("base64");
  });

  afterEach(function () {
    rmSync(tempDir, { recursive: true, force: true });
    globals.IOUtils = restoreIOUtils;
    globals.btoa = restoreBtoa;
  });

  function result(content: Record<string, unknown>): AgentToolResult {
    return {
      callId: "call-1",
      name: "paper_read",
      ok: true,
      content,
      artifacts: [
        {
          kind: "image",
          mimeType: "image/png",
          storedPath: imagePath,
          title: "(Mapping, n.d.) — p. 50 embedded image",
          pageIndex: 49,
          pageLabel: "50",
        },
      ],
    };
  }

  it("shows a targeted read's retrieved images to the model", async function () {
    const followup = await tool().buildFollowupMessage?.(
      result({ mode: "targeted", results: [], images: [{ page: 50 }] }),
      context("vision_allowed"),
    );
    assert.deepEqual(partTypes(followup), ["text", "image_url"]);
  });

  it("shows figures-mode crops to the model", async function () {
    const followup = await tool().buildFollowupMessage?.(
      result({
        mode: "figures",
        status: "ok",
        figures: [{ label: "Figure 1" }],
      }),
      context("vision_allowed"),
    );
    assert.deepEqual(partTypes(followup), ["text", "image_url"]);
  });

  it("tells a text-only model the images were withheld instead of sending them", async function () {
    const followup = await tool().buildFollowupMessage?.(
      result({ mode: "targeted", results: [], images: [{ page: 50 }] }),
      context("text_only"),
    );
    assert.notInclude(partTypes(followup), "image_url");
    assert.isString(followup?.content);
  });

  it("sends nothing when the result carries no image", async function () {
    const followup = await tool().buildFollowupMessage?.(
      {
        callId: "call-1",
        name: "paper_read",
        ok: true,
        content: { mode: "targeted", results: [] },
      },
      context("vision_allowed"),
    );
    assert.isNull(followup);
  });
});
