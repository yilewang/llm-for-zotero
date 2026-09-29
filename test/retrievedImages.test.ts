import { assert } from "chai";
import { buildRetrievedImageDelivery } from "../src/agent/tools/read/retrievedImages";

const paperContext = { itemId: 1, contextItemId: 11, title: "Dynamics" };

const image = (overrides = {}) => ({
  paperContext,
  citationLabel: "Dynamics, n.d.",
  sourceLabel: "(Dynamics, n.d.)",
  imageId: "a",
  pageIndex: 11,
  label: "Figure 3",
  caption: "Figure 3: Loss curve",
  score: 0.61234,
  why: "figure_label" as const,
  imagePath: "C:/cache/11/a.png",
  mimeType: "image/png",
  source: "embedded" as "embedded" | "vector",
  ...overrides,
});

describe("retrieved image delivery", function () {
  it("builds result entries and image artifacts", async function () {
    const persisted: Array<[string, string]> = [];
    const delivery = await buildRetrievedImageDelivery([image()], {
      persistFromPath: async (path, fileName) => {
        persisted.push([path, fileName]);
        return { storedPath: `blob/${fileName}`, contentHash: "h" };
      },
    });
    assert.deepEqual(delivery.entries, [
      {
        displayLabel: "(Dynamics, n.d.)",
        page: 12,
        kind: "embedded image",
        label: "Figure 3",
        caption: "Figure 3: Loss curve",
        similarity: 0.612,
        why: "figure_label",
      },
    ]);
    assert.deepEqual(delivery.artifacts, [
      {
        kind: "image",
        mimeType: "image/png",
        storedPath: "blob/dynamics-p12-a.png",
        contentHash: "h",
        title: "(Dynamics, n.d.) — p. 12 embedded image — Figure 3",
        pageIndex: 11,
        pageLabel: "12",
        paperContext,
      },
    ]);
    assert.deepEqual(persisted, [["C:/cache/11/a.png", "dynamics-p12-a.png"]]);
  });

  it("gives each entry a ready-made Markdown link to the image's page", async function () {
    const requested: Array<[number, number]> = [];
    const delivery = await buildRetrievedImageDelivery([image()], {
      persistFromPath: async () => ({
        storedPath: "blob/x.png",
        contentHash: "h",
      }),
      pageUri: (contextItemId, pageIndex) => {
        requested.push([contextItemId, pageIndex]);
        return "zotero://open-pdf/library/items/ABCD1234?page=12";
      },
    });
    assert.deepEqual(requested, [[11, 11]]);
    assert.equal(
      delivery.entries[0].pageLink,
      "[p. 12](zotero://open-pdf/library/items/ABCD1234?page=12)",
    );
    assert.isString(delivery.note);
    assert.include(delivery.note!, "pageLink");
  });

  it("omits the link and its note when the attachment cannot be resolved", async function () {
    const delivery = await buildRetrievedImageDelivery([image()], {
      persistFromPath: async () => ({
        storedPath: "blob/x.png",
        contentHash: "h",
      }),
      pageUri: () => null,
    });
    assert.notProperty(delivery.entries[0], "pageLink");
    assert.isUndefined(delivery.note);
  });

  it("titles a MinerU figure as a figure", async function () {
    const delivery = await buildRetrievedImageDelivery(
      [image({ source: "mineru" })],
      {
        persistFromPath: async () => ({
          storedPath: "blob/x.jpg",
          contentHash: "h",
        }),
      },
    );
    assert.equal(delivery.entries[0].kind, "figure");
    assert.equal(
      (delivery.artifacts[0] as { title?: string }).title,
      "(Dynamics, n.d.) — p. 12 figure — Figure 3",
    );
  });

  it("titles rendered vector regions as figure regions", async function () {
    const delivery = await buildRetrievedImageDelivery(
      [image({ source: "vector", label: undefined })],
      {
        persistFromPath: async () => ({
          storedPath: "blob/x.png",
          contentHash: "h",
        }),
      },
    );
    assert.equal(delivery.entries[0].kind, "figure region");
    assert.equal(
      (delivery.artifacts[0] as { title?: string }).title,
      "(Dynamics, n.d.) — p. 12 figure region",
    );
  });

  it("skips images whose file cannot be read", async function () {
    const delivery = await buildRetrievedImageDelivery([image()], {
      persistFromPath: async () => {
        throw new Error("missing");
      },
    });
    assert.lengthOf(delivery.entries, 0);
    assert.lengthOf(delivery.artifacts, 0);
  });
});
