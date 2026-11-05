import { assert } from "chai";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import type { AgentActionReceipt, AgentToolContext } from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

/**
 * A Zotero item as the metadata path sees it. Zotero stores a date as a
 * multipart string ("2024" becomes "2024-00-00 2024") and getField reads the
 * entered form back unless asked for the raw value; the fake keeps both.
 */
type FakeItem = {
  id: number;
  libraryID: number;
  key: string;
  stored: Record<string, string>;
  isRegularItem: () => boolean;
  getField: (field: string, unformatted?: boolean) => string;
};

function multipart(date: string): string {
  return /^\d{4}$/.test(date) ? `${date}-00-00 ${date}` : date;
}

function fakeItem(id: number, stored: Record<string, string>): FakeItem {
  const item: FakeItem = {
    id,
    libraryID: 1,
    key: `ITEM${id}`,
    stored: { ...stored, date: multipart(stored.date || "") },
    isRegularItem: () => true,
    getField: (field, unformatted) => {
      const value = item.stored[field] ?? "";
      return field === "date" && !unformatted
        ? value.replace(/^\d{4}-\d{2}-\d{2} /, "")
        : value;
    },
  };
  return item;
}

/**
 * The gateway surface the metadata write and its receipt use, resolving
 * targets the way ItemCapability.resolveMetadataWriteTarget does (a named
 * item exactly, else the paper context, then the active item) and reading
 * fields back formatted.
 */
function gatewayFor(
  items: FakeItem[],
  options: { dropOnWrite?: string[] } = {},
) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const writes: Array<{ itemId: number; metadata: Record<string, string> }> =
    [];
  const get = (id: unknown) => byId.get(Number(id)) || null;
  return {
    writes,
    gateway: {
      getItem: get,
      resolveLibraryID: () => 1,
      resolveRegularItem: (item: FakeItem | null) => item,
      resolveMetadataWriteTarget: (params: {
        itemId?: number;
        paperContext?: { itemId?: number } | null;
        request?: { activeItemId?: number };
      }) => {
        const target = params.itemId
          ? get(params.itemId)
          : get(params.paperContext?.itemId) ||
            get(params.request?.activeItemId);
        return target ? { item: target } : { refusal: "No item to update" };
      },
      getEditableArticleMetadata: (item: FakeItem | null) =>
        item
          ? {
              itemId: item.id,
              itemType: "journalArticle",
              title: item.stored.title || `Item ${item.id}`,
              fields: Object.fromEntries(
                ["title", "date", "DOI", "volume", "pages"].map((field) => [
                  field,
                  item.getField(field),
                ]),
              ),
              creators: [],
            }
          : null,
      updateArticleMetadata: async ({
        item,
        metadata,
      }: {
        item: FakeItem;
        metadata: Record<string, string>;
      }) => {
        writes.push({ itemId: item.id, metadata });
        for (const [field, value] of Object.entries(metadata)) {
          if (options.dropOnWrite?.includes(field)) continue;
          item.stored[field] = field === "date" ? multipart(value) : value;
        }
        return {
          status: "updated" as const,
          itemId: item.id,
          title: item.stored.title,
          changedFields: Object.keys(metadata),
        };
      },
    },
  };
}

/** A paper-chat turn on `activeItemId`, as the live run's was. */
function paperChatContext(activeItemId: number): AgentToolContext {
  return {
    request: {
      conversationKey: 1,
      mode: "agent",
      userText: "fix this paper's metadata",
      libraryID: 1,
      activeItemId,
      executionContext: {
        version: 1,
        executionId: "metadata-receipt",
        conversationKey: 1,
        conversationGeneration: 0,
        chatLibraryID: 1,
        permissionOwner: "original_agent",
        workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
        configuredAccess: { libraryIDs: [1], outputDirectories: [] },
      },
    },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
    runId: "metadata-receipt-run",
  } as never;
}

async function updateMetadata(
  gateway: unknown,
  args: Record<string, unknown>,
  activeItemId: number,
): Promise<AgentActionReceipt[]> {
  const registry = createBuiltInToolRegistry({
    zoteroGateway: gateway as never,
    pdfService: {} as never,
    pdfPageService: {} as never,
    retrievalService: {} as never,
  });
  let prepared = await registry.prepareExecution(
    { id: "call-metadata", name: "library_update", arguments: args },
    paperChatContext(activeItemId),
  );
  if (prepared.kind === "confirmation")
    prepared = await prepared.execute({ approved: true });
  assert.equal(prepared.kind, "result", "the update never reached execution");
  if (prepared.kind !== "result") throw new Error("unreachable");
  assert.isTrue(
    prepared.execution.result.ok,
    JSON.stringify(prepared.execution.result.content),
  );
  return prepared.execution.result.actionReceipts || [];
}

/** The live run's request: year 2024 and a DOI, on paper 520. */
const LIVE_METADATA = { date: "2024", DOI: "10.1234/abcd.loopmupo0g23" };

describe("library_update metadata receipts", function () {
  const originalZotero = globalThis.Zotero;
  beforeEach(async function () {
    globalThis.Zotero = {
      DB: new ChangeJournalTestDb(),
      Prefs: { get: () => "auto" },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
  });
  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  it("verifies the live run's year and DOI fix on the item the model named in itemIds", async function () {
    const paper = fakeItem(520, { title: "Drift fixture", date: "2019" });
    const { gateway, writes } = gatewayFor([paper]);
    const receipts = await updateMetadata(
      gateway,
      { kind: "metadata", itemIds: [520], metadata: LIVE_METADATA },
      520,
    );
    assert.deepEqual(writes, [{ itemId: 520, metadata: LIVE_METADATA }]);
    assert.equal(paper.stored.date, "2024-00-00 2024", "stored as Zotero does");
    assert.lengthOf(receipts, 1);
    assert.equal(receipts[0].verification, "verified");
    assert.equal(receipts[0].status, "applied");
    assert.deepEqual(receipts[0].appliedTargets, ["item:520"]);
  });

  it("verifies an update aimed at the open paper without naming it", async function () {
    const paper = fakeItem(520, { title: "Drift fixture", date: "2019" });
    const { gateway } = gatewayFor([paper]);
    const receipts = await updateMetadata(
      gateway,
      { kind: "metadata", metadata: LIVE_METADATA },
      520,
    );
    assert.lengthOf(receipts, 1);
    assert.equal(receipts[0].verification, "verified");
    assert.equal(receipts[0].status, "applied");
  });

  it("writes the paper itemIds names, not the open one", async function () {
    const open = fakeItem(520, { title: "Open paper", date: "2019" });
    const named = fakeItem(521, { title: "Named paper", date: "2019" });
    const { gateway, writes } = gatewayFor([open, named]);
    const receipts = await updateMetadata(
      gateway,
      { kind: "metadata", itemIds: [521], metadata: LIVE_METADATA },
      520,
    );
    assert.deepEqual(
      writes.map((write) => write.itemId),
      [521],
    );
    assert.equal(open.stored.DOI ?? "", "", "the open paper is untouched");
    assert.equal(receipts[0].verification, "verified");
    assert.deepEqual(receipts[0].appliedTargets, ["item:521"]);
  });

  it("applies one uniform change to every item itemIds names", async function () {
    const first = fakeItem(520, { title: "First", date: "2019" });
    const second = fakeItem(521, { title: "Second", date: "2019" });
    const { gateway, writes } = gatewayFor([first, second]);
    const receipts = await updateMetadata(
      gateway,
      { kind: "metadata", itemIds: [520, 521], metadata: { date: "2024" } },
      520,
    );
    assert.sameMembers(
      writes.map((write) => write.itemId),
      [520, 521],
    );
    assert.isNotEmpty(receipts);
    assert.isTrue(
      receipts.every((receipt) => receipt.verification === "verified"),
      JSON.stringify(receipts.map((receipt) => receipt.reasons)),
    );
  });

  it("still reports an update Zotero did not keep as unverified", async function () {
    const paper = fakeItem(520, { title: "Drift fixture", date: "2019" });
    const { gateway } = gatewayFor([paper], { dropOnWrite: ["DOI"] });
    const receipts = await updateMetadata(
      gateway,
      { kind: "metadata", itemIds: [520], metadata: LIVE_METADATA },
      520,
    );
    assert.lengthOf(receipts, 1);
    assert.equal(receipts[0].verification, "unverified");
    assert.notEqual(receipts[0].status, "applied");
    assert.deepEqual(receipts[0].appliedTargets, []);
  });
});
