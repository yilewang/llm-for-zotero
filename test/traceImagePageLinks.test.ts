import { assert } from "chai";
import { buildAgentTraceDisplayItems } from "../src/modules/contextPanel/agentTrace/render";
import { normalizeGeneratedChatImages } from "../src/shared/generatedImages";

function findImageGrids(value: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const entry of value) findImageGrids(entry, out);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "image_grid") out.push(record);
    for (const entry of Object.values(record)) findImageGrids(entry, out);
  }
  return out;
}

function traceImages(artifacts: unknown[]) {
  const events = [
    {
      runId: "run-images",
      seq: 1,
      eventType: "tool_call",
      payload: {
        type: "tool_call",
        callId: "call-read",
        name: "paper_read",
        args: { mode: "targeted", query: "formula" },
      },
      createdAt: 1,
    },
    {
      runId: "run-images",
      seq: 2,
      eventType: "tool_result",
      payload: {
        type: "tool_result",
        callId: "call-read",
        name: "paper_read",
        ok: true,
        content: { mode: "targeted", results: [] },
        artifacts,
      },
      createdAt: 2,
    },
  ];
  const { items } = buildAgentTraceDisplayItems(events as never, null);
  const grids = findImageGrids(items) as Array<{
    images: Array<{ pdfLocation?: unknown }>;
  }>;
  return grids.flatMap((grid) => grid.images);
}

describe("trace image page links", function () {
  it("keeps the PDF page of an image that came from a paper", function () {
    const images = traceImages([
      {
        kind: "image",
        mimeType: "image/png",
        storedPath: "C:/blob/a.png",
        title: "(Mapping, n.d.) — p. 44 embedded image",
        pageIndex: 43,
        pageLabel: "44",
        paperContext: { itemId: 344, contextItemId: 344, title: "Mapping" },
      },
    ]);
    assert.lengthOf(images, 1);
    assert.deepEqual(images[0].pdfLocation, {
      contextItemId: 344,
      pageIndex: 43,
    });
  });

  it("keeps the PDF page through the normalizer the image renderer applies", function () {
    const images = traceImages([
      {
        kind: "image",
        mimeType: "image/png",
        storedPath: "C:/blob/a.png",
        title: "(Mapping, n.d.) — p. 44 embedded image",
        pageIndex: 43,
        paperContext: { itemId: 344, contextItemId: 344, title: "Mapping" },
      },
    ]);
    const rendered = normalizeGeneratedChatImages(images);
    assert.deepEqual(rendered[0].pdfLocation, {
      contextItemId: 344,
      pageIndex: 43,
    });
  });

  it("drops a malformed PDF page when normalizing", function () {
    const rendered = normalizeGeneratedChatImages([
      {
        id: "a",
        path: "C:/blob/a.png",
        pdfLocation: { contextItemId: "344", pageIndex: -1 },
      },
    ]);
    assert.isUndefined(rendered[0].pdfLocation);
  });

  it("leaves images without a paper page unlinked", function () {
    const images = traceImages([
      { kind: "image", mimeType: "image/png", storedPath: "C:/blob/b.png" },
    ]);
    assert.lengthOf(images, 1);
    assert.isUndefined(images[0].pdfLocation);
  });
});
