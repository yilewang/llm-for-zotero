import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";

// The panel and the standalone window share the lifecycle helpers in
// conversationLifecycle.ts but keep their own guards and timing. These pins
// keep each surface's difference visible at its call site.

const here = dirname(fileURLToPath(import.meta.url));
const panelSource = readFileSync(
  resolve(
    here,
    "../src/modules/contextPanel/setupHandlers/controllers/historyLifecycleController.ts",
  ),
  "utf8",
);
const standaloneSource = readFileSync(
  resolve(here, "../src/modules/contextPanel/standaloneWindow.ts"),
  "utf8",
);

function sliceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  assert.isAtLeast(from, 0, `missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.isAbove(to, from, `missing ${end} after ${start}`);
  return source.slice(from, to);
}

describe("conversation lifecycle call sites", function () {
  it("the panel seed guard checks every key; the standalone guard skips keyless ensures", function () {
    const panel = sliceBetween(
      panelSource,
      "const ensureActiveConversationCatalogEntry = async",
      "const touchEmptyDraftActivity",
    );
    assert.include(
      panel,
      "if (!(await shouldSeedConversationCatalogEntry(params))) return null;",
    );
    const standalone = sliceBetween(
      standaloneSource,
      "const ensureActiveConversationCatalogEntry = async",
      "const toSidebarConversation",
    );
    assert.match(
      standalone,
      /key > 0 &&\s+!\(await shouldSeedConversationCatalogEntry\(\{/,
    );
    for (const body of [panel, standalone]) {
      assert.notInclude(body, "getCatalogIdentityWitness");
      assert.notInclude(body, "isConversationPendingDeletion");
    }
  });

  it("the panel tombstones in the subscriber, before it queues the handler", function () {
    const subscriber = sliceBetween(
      panelSource,
      "const onPendingDeletionEvent = (event: PendingDeletionEvent) => {",
      "disposePendingDeletionSubscriptionForBody(body);\n  pendingDeletionSubscriptionsByBody.set(",
    );
    const mark = subscriber.indexOf(
      "markCommittedConversationDeletionTombstone(event);",
    );
    const enqueue = subscriber.indexOf(
      "void enqueueConversationDeletionEvent(",
    );
    assert.isAtLeast(mark, 0);
    assert.isAbove(enqueue, mark);
    const handler = sliceBetween(
      panelSource,
      "const handleConversationPendingDeletionEvent = async (",
      "const onPendingDeletionEvent = ",
    );
    assert.notInclude(handler, "markCommittedConversationDeletionTombstone");
  });

  it("the standalone window tombstones inside its serialized handler", function () {
    const handler = sliceBetween(
      standaloneSource,
      "const handleStandaloneConversationDeletionEvent = async (",
      "unsubscribeStandalonePendingDeletions = pendingDeletionStore.subscribe(",
    );
    const guard = handler.indexOf(
      'if (event.entry.kind !== "conversation") return;',
    );
    const mark = handler.indexOf(
      "markCommittedConversationDeletionTombstone(event);",
    );
    const firstAwait = handler.indexOf("await ");
    assert.isAtLeast(guard, 0);
    assert.isAbove(mark, guard);
    assert.isAbove(firstAwait, mark);
    const subscriber = sliceBetween(
      standaloneSource,
      "unsubscribeStandalonePendingDeletions = pendingDeletionStore.subscribe(",
      'standaloneHistoryUndoBtn.addEventListener("click"',
    );
    assert.include(
      subscriber,
      "void enqueueStandaloneConversationDeletionEvent(",
    );
    assert.notInclude(subscriber, "markCommittedConversationDeletionTombstone");
  });

  const SURFACE_RENAME_GUARDS = [
    "isEntryPendingDelete:",
    "isOrphan:",
    "isRequestPending:",
    "isStillCurrent:",
  ];

  it("the panel rename commit passes all four surface guards", function () {
    const call = sliceBetween(
      panelSource,
      "const renamed = await commitConversationRename({",
      "if (!renamed) return;",
    );
    for (const guard of SURFACE_RENAME_GUARDS) {
      assert.include(call, guard);
    }
    assert.include(call, "Boolean(currentEntry.isPendingDelete)");
    assert.include(call, "isOrphanHistoryEntry(currentEntry)");
    assert.include(call, "isRequestPending(conversationKey)");
    assert.include(
      call,
      'isOwnedPanelOperationCurrent(ownership, "rename-conversation-commit")',
    );
  });

  it("the standalone rename commit passes the panel's guards that the window has", function () {
    const call = sliceBetween(
      standaloneSource,
      "const renamed = await commitConversationRename({",
      "if (!renamed) return;",
    );
    assert.include(call, "toIdentity: getStandaloneRenameIdentity");
    // This used to pass none of them, so a rename confirmed while the chat
    // generated was written. Each guard reads the window's own fact.
    assert.include(call, "isRequestPending(conversationKey)");
    assert.include(
      call,
      "isOrphanHistoryEntry(toStandaloneHistoryEntry(currentEntry))",
    );
    assert.include(call, "isStillCurrent: () => !cancelled");
    // A sidebar row has no pending-delete flag of its own; the shared commit
    // already checks the pending-deletion store.
    assert.notInclude(call, "isEntryPendingDelete:");
  });

  it("the standalone rename refuses an orphan or a generating chat before the dialog opens", function () {
    const fn = sliceBetween(
      standaloneSource,
      "const renameStandaloneHistoryEntry = async (",
      "const renamed = await commitConversationRename({",
    );
    const dialog = fn.indexOf("showConversationRenameDialog(");
    const orphan = fn.indexOf(
      "if (isOrphanHistoryEntry(toStandaloneHistoryEntry(entry))) {",
    );
    const generating = fn.indexOf(
      "if (isRequestPending(target.conversationKey)) {",
    );
    assert.isAtLeast(dialog, 0);
    assert.isAtLeast(orphan, 0);
    assert.isAtLeast(generating, 0);
    assert.isBelow(orphan, dialog);
    assert.isBelow(generating, dialog);
    // The panel's own messages.
    assert.include(fn, 't("This chat\'s source item was deleted")');
    assert.include(fn, 't("History is unavailable while generating")');
  });

  it("the panel deletion passes its ownership and generating check as the final check", function () {
    const fn = sliceBetween(
      panelSource,
      "const queueHistoryDeletion = async (",
      'if (queueResult.status === "refused") return false;',
    );
    const call = fn.slice(
      fn.indexOf("await queueWitnessedConversationDeletion({"),
    );
    assert.match(
      call,
      /finalCheck: \(\) =>\s+isOwnedPanelOperationCurrent\(ownership, "delete-conversation-commit"\) &&\s+!rejectConversationDeletionWhileGenerating\(targetEntry\.conversationKey\)/,
    );
    assert.notInclude(fn, "getCatalogIdentityWitness");
    assert.notInclude(fn, "pendingDeletionStore.queueConversationDeletion");
  });

  it("the standalone deletion refuses a generating chat early and in its final check", function () {
    const fn = sliceBetween(
      standaloneSource,
      "const queueStandaloneHistoryDeletion = async (",
      "// Sidebar click handler",
    );
    const earlyRefusal = fn.indexOf(
      "if (rawKey && rejectStandaloneDeletionWhileGenerating(rawKey)) return;",
    );
    const hydrate = fn.indexOf("await hydrateStandaloneHistoryDeletionEntry(");
    const pendingCheck = fn.indexOf(
      "if (pendingDeletionStore.isConversationPendingDeletion(key)) {",
    );
    const call = fn.indexOf("await queueWitnessedConversationDeletion({");
    assert.isAtLeast(earlyRefusal, 0);
    assert.isAbove(hydrate, earlyRefusal);
    assert.isAbove(pendingCheck, hydrate);
    assert.isAbove(call, pendingCheck);
    assert.include(
      fn.slice(call),
      "finalCheck: () => !rejectStandaloneDeletionWhileGenerating(key),",
    );
    assert.notInclude(fn, "getCatalogIdentityWitness");
    assert.notInclude(fn, "pendingDeletionStore.queueConversationDeletion");
    const reject = sliceBetween(
      standaloneSource,
      "const rejectStandaloneDeletionWhileGenerating = (",
      "const queueStandaloneHistoryDeletion = async (",
    );
    assert.include(
      reject,
      "if (!isRequestPending(conversationKey)) return false;",
    );
    assert.include(reject, 't("Cannot delete while generating")');
  });

  it("closing the standalone window releases its open message edit", function () {
    const cleanup = sliceBetween(
      standaloneSource,
      "const cleanupWindow = () => {",
      'newWin.addEventListener("load", initWindow',
    );
    assert.include(cleanup, "releaseInlineEdit(contentArea);");
    assert.isBelow(
      cleanup.indexOf("disposeSetupHandlers(contentArea);"),
      cleanup.indexOf("releaseInlineEdit(contentArea);"),
    );
  });
});
