import { assert } from "chai";
import {
  getHistoryDayGroupLabel,
  getHistoryEntryLabelType,
  groupHistoryEntriesByDay,
  formatHistoryPaperScopeLabel,
  isOrphanHistoryEntry,
  maybeSelectPaperHistoryTarget,
  normalizeHistoryPaperItemID,
  readHistoryPaperDisplayMetadata,
  resolveHistoryEntryPaperBaseItem,
  resolveHistoryEntryPaperDisplayMetadata,
  resolveHistoryEntryPaperItem,
  resolveHistoryEntrySourceState,
  resolvePaperHistoryNavigationDecision,
} from "../src/modules/contextPanel/setupHandlers/controllers/conversationHistoryController";

describe("conversationHistoryController", function () {
  const noon = new Date(2026, 3, 30, 12).getTime();
  const todayStart = new Date(2026, 3, 30).getTime();

  it("labels history timestamps by relative day buckets", function () {
    assert.equal(getHistoryDayGroupLabel(todayStart, { now: noon }), "Today");
    assert.equal(
      getHistoryDayGroupLabel(todayStart - 86_400_000, { now: noon }),
      "Yesterday",
    );
    assert.equal(
      getHistoryDayGroupLabel(todayStart - 3 * 86_400_000, { now: noon }),
      "Last 7 days",
    );
    assert.equal(
      getHistoryDayGroupLabel(todayStart - 10 * 86_400_000, { now: noon }),
      "Last 30 days",
    );
    assert.equal(
      getHistoryDayGroupLabel(todayStart - 40 * 86_400_000, { now: noon }),
      "Older",
    );
  });

  it("groups sorted history entries with translated labels", function () {
    const entries = [
      { id: 1, lastActivityAt: todayStart + 1 },
      { id: 2, lastActivityAt: todayStart + 2 },
      { id: 3, lastActivityAt: todayStart - 86_400_000 },
    ];
    const groups = groupHistoryEntriesByDay(entries, {
      now: noon,
      translate: (label) => `t:${label}`,
    });
    assert.deepEqual(
      groups.map((group) => ({
        label: group.label,
        ids: group.items.map((item) => item.id),
      })),
      [
        { label: "t:Today", ids: [1, 2] },
        { label: "t:Yesterday", ids: [3] },
      ],
    );
  });

  it("resolves a paper history entry by item id without requiring Zotero pane selection", function () {
    const calls: number[] = [];
    const resolved = resolveHistoryEntryPaperItem(
      { paperItemID: 42.9 },
      (paperItemID) => {
        calls.push(paperItemID);
        return { id: paperItemID, title: "Paper" };
      },
    );

    assert.deepEqual(calls, [42]);
    assert.deepEqual(resolved, { id: 42, title: "Paper" });
    assert.equal(
      resolveHistoryEntryPaperItem({}, () => ({ id: 1 })),
      null,
    );
    assert.equal(normalizeHistoryPaperItemID("not-a-number"), 0);
  });

  it("resolves child attachment history to its paper and keeps note history on its note", function () {
    const parent = {
      id: 42,
      isRegularItem: () => true,
      isAttachment: () => false,
      isNote: () => false,
    };
    const attachment = {
      id: 99,
      parentID: 42,
      isRegularItem: () => false,
      isAttachment: () => true,
      isNote: () => false,
    };
    const note = {
      id: 100,
      parentID: 42,
      isRegularItem: () => false,
      isAttachment: () => false,
      isNote: () => true,
    };
    const items = new Map<
      number,
      typeof parent | typeof attachment | typeof note
    >([
      [42, parent],
      [99, attachment],
      [100, note],
    ]);

    assert.equal(
      resolveHistoryEntryPaperBaseItem({ paperItemID: 99 }, (id) =>
        items.get(id),
      ),
      parent,
    );
    assert.equal(
      resolveHistoryEntryPaperBaseItem({ paperItemID: 100 }, (id) =>
        items.get(id),
      ),
      note,
    );
  });

  it("reads paper display metadata with Zotero field fallbacks", function () {
    const metadata = readHistoryPaperDisplayMetadata({
      id: 42,
      firstCreator: "Fallback Creator",
      isRegularItem: () => true,
      getDisplayTitle: () => "Display title",
      getField: (field) => {
        if (field === "date") return "2017-06-01";
        return "";
      },
    });

    assert.deepEqual(metadata, {
      itemID: 42,
      title: "Display title",
      firstCreator: "Fallback Creator",
      year: "2017",
    });
    assert.equal(
      formatHistoryPaperScopeLabel(metadata),
      "Fallback Creator, 2017",
    );
  });

  it("resolves paper display metadata through child-item parent IDs", function () {
    const parent = {
      id: 42,
      isRegularItem: () => true,
      isAttachment: () => false,
      getField: (field: string) => {
        if (field === "title") return "Parent paper";
        if (field === "firstCreator") return "Mensch and Kording";
        if (field === "year") return "2017";
        return "";
      },
    };
    const attachment = {
      id: 99,
      parentID: 42,
      isRegularItem: () => false,
      isAttachment: () => true,
      getField: () => "",
    };
    const items = new Map<number, typeof parent | typeof attachment>([
      [42, parent],
      [99, attachment],
    ]);

    const metadata = resolveHistoryEntryPaperDisplayMetadata(
      { paperItemID: 99 },
      (id) => items.get(id),
    );

    assert.deepEqual(metadata, {
      itemID: 42,
      title: "Parent paper",
      firstCreator: "Mensch and Kording",
      year: "2017",
    });
  });

  it("marks paper history with a live regular item as active", function () {
    const item = {
      id: 42,
      isRegularItem: () => true,
      isAttachment: () => false,
      isNote: () => false,
    };

    assert.equal(
      resolveHistoryEntrySourceState(
        { kind: "paper", paperItemID: 42 },
        (id) => (id === 42 ? item : null),
      ),
      "active",
    );
    assert.equal(
      getHistoryEntryLabelType({ kind: "paper", sourceState: "active" }),
      "paper",
    );
  });

  it("marks missing paper history parents as orphan", function () {
    assert.equal(
      resolveHistoryEntrySourceState(
        { kind: "paper", paperItemID: 42 },
        () => null,
      ),
      "orphan",
    );
    assert.isTrue(
      isOrphanHistoryEntry({ kind: "paper", sourceState: "orphan" }),
    );
    assert.equal(
      getHistoryEntryLabelType({ kind: "paper", sourceState: "orphan" }),
      "orphan",
    );
  });

  it("marks trashed regular paper history items as orphan", function () {
    const trashedItem = {
      id: 42,
      deleted: true,
      isRegularItem: () => true,
      isAttachment: () => false,
      isNote: () => false,
    };

    assert.equal(
      resolveHistoryEntrySourceState(
        { kind: "paper", paperItemID: 42 },
        (id) => (id === 42 ? trashedItem : null),
      ),
      "orphan",
    );
  });

  it("keeps child-item paper history active when the parent item is live", function () {
    const parent = {
      id: 42,
      isRegularItem: () => true,
      isAttachment: () => false,
      isNote: () => false,
    };
    const attachment = {
      id: 99,
      parentID: 42,
      isRegularItem: () => false,
      isAttachment: () => true,
      isNote: () => false,
    };
    const items = new Map<number, typeof parent | typeof attachment>([
      [42, parent],
      [99, attachment],
    ]);

    assert.equal(
      resolveHistoryEntrySourceState({ kind: "paper", paperItemID: 99 }, (id) =>
        items.get(id),
      ),
      "active",
    );
  });

  it("keeps top-level supported attachment paper history active", function () {
    const attachment = {
      id: 99,
      parentID: undefined,
      attachmentContentType: "application/pdf",
      attachmentFilename: "standalone.pdf",
      isRegularItem: () => false,
      isAttachment: () => true,
      isNote: () => false,
      getField: (field: string) => (field === "title" ? "Standalone PDF" : ""),
    };

    assert.equal(
      resolveHistoryEntrySourceState(
        { kind: "paper", paperItemID: 99 },
        (id) => (id === 99 ? attachment : null),
      ),
      "active",
    );
    assert.deepEqual(
      resolveHistoryEntryPaperDisplayMetadata({ paperItemID: 99 }, (id) =>
        id === 99 ? attachment : null,
      ),
      {
        itemID: 99,
        title: "Standalone PDF",
        firstCreator: "",
        year: "",
      },
    );
  });

  it("marks unsupported top-level attachment paper history orphan", function () {
    const attachment = {
      id: 99,
      parentID: undefined,
      attachmentContentType: "application/zip",
      attachmentFilename: "archive.zip",
      isRegularItem: () => false,
      isAttachment: () => true,
      isNote: () => false,
    };

    assert.equal(
      resolveHistoryEntrySourceState(
        { kind: "paper", paperItemID: 99 },
        (id) => (id === 99 ? attachment : null),
      ),
      "orphan",
    );
  });

  it("marks child-item paper history orphan when the parent item is missing", function () {
    const attachment = {
      id: 99,
      parentID: 42,
      isRegularItem: () => false,
      isAttachment: () => true,
      isNote: () => false,
    };

    assert.equal(
      resolveHistoryEntrySourceState(
        { kind: "paper", paperItemID: 99 },
        (id) => (id === 99 ? attachment : null),
      ),
      "orphan",
    );
  });

  it("marks child-item paper history orphan when the parent item is trashed", function () {
    const parent = {
      id: 42,
      deleted: true,
      isRegularItem: () => true,
      isAttachment: () => false,
      isNote: () => false,
    };
    const attachment = {
      id: 99,
      parentID: 42,
      isRegularItem: () => false,
      isAttachment: () => true,
      isNote: () => false,
    };
    const items = new Map<number, typeof parent | typeof attachment>([
      [42, parent],
      [99, attachment],
    ]);

    assert.equal(
      resolveHistoryEntrySourceState({ kind: "paper", paperItemID: 99 }, (id) =>
        items.get(id),
      ),
      "orphan",
    );
  });

  it("keeps child-item paper history active when only the child is trashed", function () {
    const parent = {
      id: 42,
      isRegularItem: () => true,
      isAttachment: () => false,
      isNote: () => false,
    };
    const attachment = {
      id: 99,
      deleted: true,
      parentID: 42,
      isRegularItem: () => false,
      isAttachment: () => true,
      isNote: () => false,
    };
    const items = new Map<number, typeof parent | typeof attachment>([
      [42, parent],
      [99, attachment],
    ]);

    assert.equal(
      resolveHistoryEntrySourceState({ kind: "paper", paperItemID: 99 }, (id) =>
        items.get(id),
      ),
      "active",
    );
  });

  it("keeps library history entries active with the library label type", function () {
    assert.equal(
      resolveHistoryEntrySourceState({ kind: "global" }, () => null),
      "active",
    );
    assert.equal(
      getHistoryEntryLabelType({ kind: "global", sourceState: "active" }),
      "library",
    );
  });

  it("decides whether paper history should load in place or select the target paper", function () {
    assert.equal(
      resolvePaperHistoryNavigationDecision({
        entryPaperItemID: 101,
        currentPaperItemID: 101,
      }),
      "load-in-place",
    );
    assert.equal(
      resolvePaperHistoryNavigationDecision({
        entryPaperItemID: 202,
        currentPaperItemID: 101,
      }),
      "select-target-paper",
    );
    assert.equal(
      resolvePaperHistoryNavigationDecision({
        currentPaperItemID: 101,
      }),
      "missing-target-paper",
    );
  });

  it("does not touch Zotero pane selection for same-paper history targets", async function () {
    let paneRequested = false;
    const selected = await maybeSelectPaperHistoryTarget({
      decision: "load-in-place",
      paperItemID: 101,
      getPane: () => {
        paneRequested = true;
        return {
          selectItems: () => {
            throw new Error("selectItems should not be called");
          },
        };
      },
    });

    assert.isTrue(selected);
    assert.isFalse(paneRequested);
  });

  it("selects the target paper for different-paper history targets", async function () {
    const calls: Array<{
      ids: number[];
      options?: boolean | { selectInLibrary?: boolean };
    }> = [];
    const selected = await maybeSelectPaperHistoryTarget({
      decision: "select-target-paper",
      paperItemID: 202,
      getPane: () => ({
        selectItems: (ids, options) => {
          calls.push({ ids, options });
        },
      }),
    });

    assert.isTrue(selected);
    assert.deepEqual(calls, [
      { ids: [202], options: { selectInLibrary: true } },
    ]);
  });

  it("does not select a paper for missing paper history metadata", async function () {
    let paneRequested = false;
    const selected = await maybeSelectPaperHistoryTarget({
      decision: "missing-target-paper",
      getPane: () => {
        paneRequested = true;
        return {};
      },
    });

    assert.isFalse(selected);
    assert.isFalse(paneRequested);
  });
});
