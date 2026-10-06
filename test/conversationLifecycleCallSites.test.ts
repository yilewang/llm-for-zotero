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
});
