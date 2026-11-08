import { assert } from "chai";
import {
  TEAR_OFF_MIME,
  classifyTearOffDragEnd,
  decodeTornChatIdentity,
  encodeTornChatIdentity,
  tearOffDropPoint,
  type ScreenRect,
} from "../src/modules/contextPanel/tearOffDrag";
import type { TornChatIdentity } from "../src/modules/contextPanel/tornChatWindows";

const classify = classifyTearOffDragEnd;

const screen: ScreenRect = { left: 0, top: 25, width: 1920, height: 1055 };

const base = {
  userCancelled: false,
  droppedOnSource: false,
  screenX: 900,
  screenY: 300,
  lastDragPoint: null as { screenX: number; screenY: number } | null,
  dropScreen: screen,
  windowSize: { width: 640, height: 760 },
};

describe("tearOffDrag", function () {
  it("uses its own drag data type", function () {
    assert.equal(TEAR_OFF_MIME, "application/x-llmforzotero-chat");
  });

  it("ignores a cancelled drag", function () {
    assert.deepEqual(classify({ ...base, userCancelled: true }), {
      kind: "ignore",
    });
  });

  it("ignores a drag dropped back on its own source region", function () {
    assert.deepEqual(classify({ ...base, droppedOnSource: true }), {
      kind: "ignore",
    });
    // Wherever the drop point is, and whatever the last drag point was.
    assert.deepEqual(
      classify({
        ...base,
        droppedOnSource: true,
        lastDragPoint: { screenX: 700, screenY: 500 },
      }),
      { kind: "ignore" },
    );
  });

  it("opens at a release inside what used to count as a window", function () {
    // The main Zotero window or the standalone window covers this point;
    // windows no longer block a release outside the source region.
    assert.deepEqual(classify({ ...base, screenX: 10, screenY: 30 }), {
      kind: "open",
      screenX: 10,
      screenY: 30,
    });
  });

  it("opens at the drop point when it fits", function () {
    assert.deepEqual(classify(base), {
      kind: "open",
      screenX: 900,
      screenY: 300,
    });
  });

  it("prefers the drop point over the last drag point", function () {
    assert.deepEqual(
      classify({ ...base, lastDragPoint: { screenX: 700, screenY: 200 } }),
      { kind: "open", screenX: 900, screenY: 300 },
    );
  });

  it("falls back to the last drag point when the drop point is not usable", function () {
    const lastDragPoint = { screenX: 700, screenY: 200 };
    const expected = { kind: "open", screenX: 700, screenY: 200 };
    assert.deepEqual(
      classify({ ...base, screenX: 0, screenY: 0, lastDragPoint }),
      expected,
    );
    assert.deepEqual(
      classify({ ...base, screenX: Number.NaN, lastDragPoint }),
      expected,
    );
    assert.deepEqual(
      classify({
        ...base,
        screenY: Number.POSITIVE_INFINITY,
        lastDragPoint,
      }),
      expected,
    );
    assert.deepEqual(tearOffDropPoint(0, 0, lastDragPoint), lastDragPoint);
    assert.deepEqual(tearOffDropPoint(900, 300, lastDragPoint), {
      screenX: 900,
      screenY: 300,
    });
  });

  it("keeps a drop point at (0, y) or (x, 0)", function () {
    assert.deepEqual(classify({ ...base, screenX: 0, screenY: 300 }), {
      kind: "open",
      screenX: 0,
      screenY: 300,
    });
    assert.deepEqual(
      classify({ ...base, screenX: 900, screenY: 0 }).kind,
      "open",
    );
  });

  it("ignores a drag with no usable point at all", function () {
    assert.deepEqual(classify({ ...base, screenX: Number.NaN }), {
      kind: "ignore",
    });
    assert.deepEqual(classify({ ...base, screenX: 0, screenY: 0 }), {
      kind: "ignore",
    });
    assert.deepEqual(
      classify({
        ...base,
        screenX: 0,
        screenY: 0,
        lastDragPoint: { screenX: 0, screenY: 0 },
      }),
      { kind: "ignore" },
    );
    assert.deepEqual(
      classify({
        ...base,
        screenX: Number.NaN,
        lastDragPoint: { screenX: Number.NaN, screenY: 40 },
      }),
      { kind: "ignore" },
    );
    assert.isNull(tearOffDropPoint(0, 0, null));
  });

  it("clamps the window inside the drop screen", function () {
    const corner = classify({
      ...base,
      screenX: screen.left + screen.width - 1,
      screenY: screen.top + screen.height - 1,
    });
    assert.deepEqual(corner, {
      kind: "open",
      screenX: screen.left + screen.width - 640,
      screenY: screen.top + screen.height - 760,
    });
    const second = classify({
      ...base,
      dropScreen: { left: -1280, top: 0, width: 1280, height: 1024 },
      screenX: -1300,
      screenY: -20,
    });
    assert.deepEqual(second, { kind: "open", screenX: -1280, screenY: 0 });
    // The last drag point is clamped the same way.
    const fallback = classify({
      ...base,
      screenX: 0,
      screenY: 0,
      lastDragPoint: {
        screenX: screen.left + screen.width - 1,
        screenY: screen.top + screen.height - 1,
      },
    });
    assert.deepEqual(fallback, corner);
  });

  it("opens the window where the drag image was, not at the pointer", function () {
    const result = classify({
      ...base,
      screenX: screen.left + 300,
      screenY: screen.top + 200,
      grabOffset: { x: 14, y: 14 },
    });
    assert.deepEqual(result, {
      kind: "open",
      screenX: screen.left + 286,
      screenY: screen.top + 186,
    });
  });

  it("keeps the window's top-left on the screen when the screen is smaller", function () {
    const result = classify({
      ...base,
      dropScreen: { left: 100, top: 50, width: 500, height: 600 },
      screenX: 300,
      screenY: 300,
    });
    assert.deepEqual(result, { kind: "open", screenX: 100, screenY: 50 });
  });

  it("round-trips an identity and rejects junk", function () {
    const paper: TornChatIdentity = {
      system: "upstream",
      conversationKey: 42,
      kind: "paper",
      libraryID: 1,
      paperItemID: 7,
    };
    assert.deepEqual(
      decodeTornChatIdentity(encodeTornChatIdentity(paper)),
      paper,
    );
    const library: TornChatIdentity = {
      system: "codex",
      conversationKey: 5_000_000_000_000_123,
      kind: "global",
      libraryID: 3,
    };
    assert.deepEqual(
      decodeTornChatIdentity(encodeTornChatIdentity(library)),
      library,
    );
    assert.isNull(decodeTornChatIdentity("{}"));
    assert.isNull(decodeTornChatIdentity("not json"));
    assert.isNull(decodeTornChatIdentity(""));
    assert.isNull(decodeTornChatIdentity("null"));
    const reject = (patch: Record<string, unknown>) =>
      decodeTornChatIdentity(JSON.stringify({ ...paper, ...patch }));
    assert.isNull(reject({ conversationKey: 0 }));
    assert.isNull(reject({ conversationKey: -3 }));
    assert.isNull(reject({ conversationKey: "42" }));
    assert.isNull(reject({ libraryID: 0 }));
    assert.isNull(reject({ system: "webchat" }));
    assert.isNull(reject({ kind: "note" }));
    assert.isNull(reject({ paperItemID: 0 }));
    assert.isNull(reject({ paperItemID: undefined }));
  });
});
