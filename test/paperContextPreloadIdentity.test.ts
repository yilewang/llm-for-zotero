import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import { describe, it } from "mocha";
import {
  chooseAutoLoadedContextPanelItem,
  chooseCurrentPaperBaseItemForMode,
  isAutoLoadedSnapshotForCurrentPaper,
} from "../src/modules/contextPanel/paperContextPreloadIdentity";

const here = dirname(fileURLToPath(import.meta.url));

describe("paperContextPreloadIdentity", function () {
  it("prefers the live raw paper over a stale cached base while in library chat", function () {
    const cachedPaper = { id: 42 };
    const selectedPaper = { id: 84 };

    assert.equal(
      chooseCurrentPaperBaseItemForMode({
        isGlobalMode: true,
        liveRawBaseItem: selectedPaper,
        activeReaderBaseItem: null,
        cachedBasePaperItem: cachedPaper,
        currentItemBaseItem: null,
      }),
      selectedPaper,
    );
  });

  it("uses the resolved base paper instead of the portal item for async paper preload", function () {
    const paperPortal = { id: 4207 };
    const selectedPaper = { id: 84 };

    assert.equal(
      chooseAutoLoadedContextPanelItem({
        isGlobalMode: false,
        currentItem: paperPortal,
        currentPaperBaseItem: selectedPaper,
        liveRawPanelItem: selectedPaper,
      }),
      selectedPaper,
    );
  });

  it("preserves a selected supported child attachment for paper preload", function () {
    const paperPortal = { id: 4207 };
    const selectedPaper = { id: 84 };
    const selectedAttachment = { id: 251, parentID: 84 };

    assert.equal(
      chooseAutoLoadedContextPanelItem({
        isGlobalMode: false,
        currentItem: paperPortal,
        currentPaperBaseItem: selectedPaper,
        liveRawPanelItem: selectedAttachment,
        liveRawPanelItemIsSupportedAttachment: true,
      }),
      selectedAttachment,
    );
  });

  it("rejects stale auto-loaded context snapshots from another paper", function () {
    assert.isFalse(
      isAutoLoadedSnapshotForCurrentPaper({
        currentOwnerItemId: 84,
        snapshotOwnerItemId: 42,
      }),
    );
    assert.isTrue(
      isAutoLoadedSnapshotForCurrentPaper({
        currentOwnerItemId: 84,
        snapshotOwnerItemId: 84,
      }),
    );
  });

  it("rejects stale auto-loaded snapshots from another attachment under the same paper", function () {
    assert.isFalse(
      isAutoLoadedSnapshotForCurrentPaper({
        currentOwnerItemId: 84,
        snapshotOwnerItemId: 84,
        currentContextItemId: 251,
        snapshotContextItemId: 252,
        currentContentSourceMode: "html",
        snapshotContentSourceMode: "html",
      }),
    );
    assert.isFalse(
      isAutoLoadedSnapshotForCurrentPaper({
        currentOwnerItemId: 84,
        snapshotOwnerItemId: 84,
        currentContextItemId: 251,
        snapshotContextItemId: 251,
        currentContentSourceMode: "markdown",
        snapshotContentSourceMode: "html",
      }),
    );
  });

  it("keeps an explicit source-menu attachment selection over the active reader", function () {
    assert.isTrue(
      isAutoLoadedSnapshotForCurrentPaper({
        currentOwnerItemId: 84,
        snapshotOwnerItemId: 84,
        currentContextItemId: 251,
        snapshotContextItemId: 252,
        currentContentSourceMode: "mineru",
        snapshotContentSourceMode: "markdown",
        allowExplicitContextOverride: true,
      }),
    );
    assert.isFalse(
      isAutoLoadedSnapshotForCurrentPaper({
        currentOwnerItemId: 84,
        snapshotOwnerItemId: 42,
        currentContextItemId: 251,
        snapshotContextItemId: 252,
        currentContentSourceMode: "mineru",
        snapshotContentSourceMode: "markdown",
        allowExplicitContextOverride: true,
      }),
    );
  });

  it("refreshes paper context when switching from library chat back to paper chat", function () {
    const source = readFileSync(
      resolve(
        here,
        "../src/modules/contextPanel/setupHandlers/controllers/historyLifecycleController.ts",
      ),
      "utf8",
    );
    const switchStart = source.indexOf("const switchPaperConversation = async");
    const syncCall = source.indexOf("syncConversationIdentity();", switchStart);
    const refreshCall = source.indexOf(
      "refreshAutoLoadedPaperContextForCurrentItem();",
      switchStart,
    );
    const shortcutRender = source.indexOf("void renderShortcuts", switchStart);

    assert.isAtLeast(switchStart, 0);
    assert.isAtLeast(syncCall, switchStart);
    assert.isAtLeast(refreshCall, syncCall);
    assert.isBelow(refreshCall, shortcutRender);
  });
});
