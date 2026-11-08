import { assert } from "chai";
import {
  getRegisteredConversationScope,
  repairRegisteredConversationScope,
} from "../src/shared/conversationRegistry";
import { initConversationKeyLedgerStore } from "../src/shared/conversationKeyLedger";
import {
  installSqliteZotero,
  resetConversationStoreProcessStateForTests,
} from "./helpers/conversationStoreDb";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
};

describe("repairRegisteredConversationScope on an unchanged row", function () {
  const originalZotero = globalScope.Zotero;

  beforeEach(function () {
    resetConversationStoreProcessStateForTests();
  });

  afterEach(function () {
    globalScope.Zotero = originalZotero;
    resetConversationStoreProcessStateForTests();
  });

  const scope = {
    conversationKey: 2_000_000_101,
    system: "upstream" as const,
    kind: "global" as const,
    libraryID: 1,
    createdAt: 1_000,
    updatedAt: 2_000,
    title: "Opened chat",
  };

  function writesSince(
    harness: ReturnType<typeof installSqliteZotero>,
    from: number,
  ): string[] {
    return (
      harness.statements
        .slice(from)
        .map(({ sql }) => sql.trim())
        // The catalog's blank-instance-ID fill is not a registry write; this
        // harness has no catalog row, so that fill stays a no-op either way.
        .filter(
          (sql) =>
            /^(INSERT|UPDATE|DELETE)/i.test(sql) &&
            sql.includes("llm_for_zotero_conversation_registry"),
        )
    );
  }

  it("skips the transaction and the writes when the row already matches", async function () {
    const harness = installSqliteZotero({ baseZotero: {} });
    await initConversationKeyLedgerStore();
    assert.isTrue(await repairRegisteredConversationScope(scope));
    const firstWrites = writesSince(harness, 0);
    assert.isNotEmpty(firstWrites, "the first repair registers the row");
    const before = await getRegisteredConversationScope(scope.conversationKey);

    const statementsBefore = harness.statements.length;
    const transactionsBefore = harness.transactions();
    assert.isTrue(await repairRegisteredConversationScope(scope));
    assert.deepEqual(writesSince(harness, statementsBefore), []);
    assert.equal(harness.transactions(), transactionsBefore);
    assert.deepEqual(
      await getRegisteredConversationScope(scope.conversationKey),
      before,
    );
  });

  it("still writes when the activity time or title changed", async function () {
    const harness = installSqliteZotero({ baseZotero: {} });
    await initConversationKeyLedgerStore();
    assert.isTrue(await repairRegisteredConversationScope(scope));

    let statementsBefore = harness.statements.length;
    assert.isTrue(
      await repairRegisteredConversationScope({ ...scope, updatedAt: 3_000 }),
    );
    assert.isNotEmpty(writesSince(harness, statementsBefore));
    assert.deepEqual(
      harness.all(
        "SELECT updated_at AS updatedAt FROM llm_for_zotero_conversation_registry",
      ),
      [{ updatedAt: 3_000 }],
    );

    statementsBefore = harness.statements.length;
    assert.isTrue(
      await repairRegisteredConversationScope({
        ...scope,
        updatedAt: 3_000,
        title: "Renamed",
      }),
    );
    assert.isNotEmpty(writesSince(harness, statementsBefore));
  });

  it("keeps a row the upsert would also keep when the repair has no title", async function () {
    const harness = installSqliteZotero({ baseZotero: {} });
    await initConversationKeyLedgerStore();
    assert.isTrue(await repairRegisteredConversationScope(scope));
    const statementsBefore = harness.statements.length;
    assert.isTrue(
      await repairRegisteredConversationScope({ ...scope, title: null }),
    );
    assert.deepEqual(writesSince(harness, statementsBefore), []);
  });
});
