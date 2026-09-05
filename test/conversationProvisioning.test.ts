import { assert } from "chai";
import { buildDefaultClaudePaperConversationKey } from "../src/claudeCode/constants";
import { createClaudePaperPortalItem } from "../src/claudeCode/portal";
import {
  buildDefaultCodexGlobalConversationKey,
  buildDefaultCodexPaperConversationKey,
} from "../src/codexAppServer/constants";
import { createCodexPaperPortalItem } from "../src/codexAppServer/portal";
import {
  provisionConversationScopeForItem,
  resolveConversationStorageSystemForItem,
} from "../src/modules/contextPanel/conversationProvisioning";
import { buildDefaultConversationKey } from "../src/shared/conversationKeySpace";
import { validateConversationScope } from "../src/shared/conversationRegistry";

type QueryRecord = {
  sql: string;
  params: unknown[];
};

type RuntimeConversationRow = {
  instanceID?: string;
  conversationID?: string;
  conversationKey: number;
  libraryID: number;
  kind: "global" | "paper";
  paperItemID?: number | null;
  createdAt: number;
  updatedAt: number;
  title?: string | null;
};

type RegistryRow = RuntimeConversationRow & {
  conversationID: string;
  system: "upstream" | "claude_code" | "codex";
  profileSignature: string;
  valid: number;
  invalidReason?: string | null;
};

type LedgerRow = {
  conversationKey: number;
  instanceID: string;
  conversationID: string;
  system: string;
  kind: string;
  profileSignature: string;
  libraryID: number;
  paperItemID?: number | null;
  issuedAt: number;
  retiredAt?: number | null;
};

function installProvisioningDb(): {
  queries: QueryRecord[];
  conversations: Map<number, RuntimeConversationRow>;
  registry: Map<number, RegistryRow>;
  ledger: Map<number, LedgerRow>;
  restore: () => void;
} {
  const originalZotero = globalThis.Zotero;
  const queries: QueryRecord[] = [];
  const conversations = new Map<number, RuntimeConversationRow>();
  const registry = new Map<number, RegistryRow>();
  let transactionTail: Promise<void> = Promise.resolve();
  const ledger = new Map<number, LedgerRow>();
  (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
    Profile: {
      dir: "/tmp/llm-for-zotero-provisioning-test",
    },
    Items: {
      get: () => null,
    },
    DB: {
      queryAsync: async (sql: string, params?: unknown[]) => {
        const queryParams = Array.isArray(params) ? params : [];
        queries.push({ sql, params: queryParams });
        if (
          sql.includes("FROM llm_for_zotero_conversation_key_ledger") &&
          sql.includes("WHERE conversation_key = ?")
        ) {
          const row = ledger.get(Number(queryParams[0]));
          return row ? [row] : [];
        }
        if (
          sql.includes("SELECT MAX(conversation_key) AS maxKey") &&
          sql.includes("FROM llm_for_zotero_conversation_key_ledger")
        ) {
          const start = Number(queryParams[0]);
          const endExclusive = Number(queryParams[1]);
          const keys = Array.from(ledger.keys()).filter(
            (key) => key >= start && key < endExclusive,
          );
          return [{ maxKey: keys.length ? Math.max(...keys) : null }];
        }
        if (
          sql.includes("INSERT INTO llm_for_zotero_conversation_key_ledger")
        ) {
          const [
            conversationKey,
            instanceID,
            conversationID,
            system,
            kind,
            profileSignature,
            libraryID,
            paperItemID,
            issuedAt,
            retiredAt,
          ] = queryParams;
          ledger.set(Number(conversationKey), {
            conversationKey: Number(conversationKey),
            instanceID: String(instanceID),
            conversationID: String(conversationID),
            system: String(system),
            kind: String(kind),
            profileSignature: String(profileSignature),
            libraryID: Number(libraryID),
            paperItemID: Number.isFinite(Number(paperItemID))
              ? Number(paperItemID)
              : null,
            issuedAt: Number(issuedAt),
            retiredAt: Number.isFinite(Number(retiredAt))
              ? Number(retiredAt)
              : null,
          });
          return [];
        }
        if (
          sql.includes("UPDATE llm_for_zotero_conversation_key_ledger") &&
          sql.includes("SET conversation_id = ?")
        ) {
          const [conversationID, conversationKey, instanceID] = queryParams;
          const row = ledger.get(Number(conversationKey));
          if (row?.instanceID === String(instanceID)) {
            row.conversationID = String(conversationID);
          }
          return [];
        }
        if (
          (sql.includes("FROM llm_for_zotero_codex_conversations c") ||
            sql.includes("FROM llm_for_zotero_claude_conversations c")) &&
          sql.includes("WHERE c.conversation_key = ?")
        ) {
          const row = conversations.get(Number(queryParams[0]));
          return row
            ? [
                {
                  conversationKey: row.conversationKey,
                  conversationID: row.conversationID,
                  instanceID: row.instanceID,
                  libraryID: row.libraryID,
                  kind: row.kind,
                  paperItemID: row.paperItemID,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  title: row.title,
                  userTurnCount: 0,
                },
              ]
            : [];
        }
        if (
          sql.includes("FROM llm_for_zotero_paper_conversations pc") &&
          sql.includes("WHERE pc.conversation_key = ?")
        ) {
          const row = conversations.get(Number(queryParams[0]));
          return row?.kind === "paper"
            ? [
                {
                  conversationID: row.conversationID,
                  conversationKey: row.conversationKey,
                  instanceID: row.instanceID,
                  libraryID: row.libraryID,
                  paperItemID: row.paperItemID,
                  sessionVersion: 1,
                  createdAt: row.createdAt,
                  title: row.title,
                  lastActivityAt: row.updatedAt,
                  userTurnCount: 0,
                },
              ]
            : [];
        }
        if (
          sql.includes("FROM llm_for_zotero_global_conversations gc") &&
          sql.includes("WHERE gc.conversation_key = ?")
        ) {
          const row = conversations.get(Number(queryParams[0]));
          return row?.kind === "global"
            ? [
                {
                  conversationID: row.conversationID,
                  conversationKey: row.conversationKey,
                  instanceID: row.instanceID,
                  libraryID: row.libraryID,
                  createdAt: row.createdAt,
                  title: row.title,
                  lastActivityAt: row.updatedAt,
                  userTurnCount: 0,
                },
              ]
            : [];
        }
        if (
          sql.includes("FROM llm_for_zotero_conversation_registry") &&
          sql.includes("WHERE legacy_conversation_key = ?")
        ) {
          const row = registry.get(Number(queryParams[0]));
          return row
            ? [
                {
                  conversationID: row.conversationID,
                  instanceID: row.instanceID,
                  conversationKey: row.conversationKey,
                  system: row.system,
                  kind: row.kind,
                  profileSignature: row.profileSignature,
                  libraryID: row.libraryID,
                  paperItemID: row.paperItemID,
                  valid: row.valid,
                  invalidReason: row.invalidReason,
                },
              ]
            : [];
        }
        if (sql.includes("INSERT INTO llm_for_zotero_conversation_registry")) {
          const [
            conversationID,
            conversationKey,
            system,
            kind,
            profileSignature,
            libraryID,
            paperItemID,
            createdAt,
            updatedAt,
            title,
            instanceID,
          ] = queryParams;
          registry.set(Number(conversationKey), {
            conversationKey: Number(conversationKey),
            conversationID: String(conversationID),
            instanceID: String(instanceID),
            system: system as "upstream" | "claude_code" | "codex",
            kind: kind as "global" | "paper",
            profileSignature: String(profileSignature),
            libraryID: Number(libraryID),
            paperItemID:
              Number.isFinite(Number(paperItemID)) && Number(paperItemID) > 0
                ? Number(paperItemID)
                : null,
            createdAt: Number(createdAt),
            updatedAt: Number(updatedAt),
            title: typeof title === "string" ? title : null,
            valid: 1,
          });
          return [];
        }
        if (
          sql.includes("INSERT INTO llm_for_zotero_codex_conversations") ||
          sql.includes("INSERT INTO llm_for_zotero_claude_conversations")
        ) {
          const [
            conversationID,
            instanceID,
            conversationKey,
            libraryID,
            kind,
            paperItemID,
            createdAt,
            updatedAt,
            _lastActivityAt,
            title,
          ] = queryParams;
          conversations.set(Number(conversationKey), {
            conversationID: String(conversationID),
            instanceID: String(instanceID),
            conversationKey: Number(conversationKey),
            libraryID: Number(libraryID),
            kind: kind as "global" | "paper",
            paperItemID:
              Number.isFinite(Number(paperItemID)) && Number(paperItemID) > 0
                ? Number(paperItemID)
                : null,
            createdAt: Number(createdAt),
            updatedAt: Number(updatedAt),
            title: typeof title === "string" ? title : null,
          });
          return [];
        }
        if (sql.includes("llm_for_zotero_paper_conversations")) {
          const [
            conversationID,
            instanceID,
            conversationKey,
            libraryID,
            paperItemID,
            createdAt,
            lastActivityAt,
          ] = queryParams;
          conversations.set(Number(conversationKey), {
            conversationID: String(conversationID),
            instanceID: String(instanceID),
            conversationKey: Number(conversationKey),
            libraryID: Number(libraryID),
            kind: "paper",
            paperItemID:
              Number.isFinite(Number(paperItemID)) && Number(paperItemID) > 0
                ? Number(paperItemID)
                : null,
            createdAt: Number(createdAt),
            updatedAt: Number(lastActivityAt),
            title: null,
          });
          return [];
        }
        if (sql.includes("llm_for_zotero_global_conversations")) {
          const [
            conversationID,
            instanceID,
            conversationKey,
            libraryID,
            createdAt,
            lastActivityAt,
          ] = queryParams;
          conversations.set(Number(conversationKey), {
            conversationID: String(conversationID),
            instanceID: String(instanceID),
            conversationKey: Number(conversationKey),
            libraryID: Number(libraryID),
            kind: "global",
            paperItemID: null,
            createdAt: Number(createdAt),
            updatedAt: Number(lastActivityAt),
            title: null,
          });
          return [];
        }
        return [];
      },
      executeTransaction: async (callback: () => Promise<unknown>) => {
        const transaction = transactionTail.then(callback, callback);
        transactionTail = transaction.then(
          () => undefined,
          () => undefined,
        );
        return transaction;
      },
    },
    debug: () => undefined,
  } as unknown as typeof Zotero;
  return {
    queries,
    conversations,
    registry,
    ledger,
    restore: () => {
      (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
        originalZotero;
    },
  };
}

describe("conversation provisioning", function () {
  let originalZotero: typeof Zotero | undefined;

  before(function () {
    originalZotero = globalThis.Zotero;
  });

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("registers a fresh Codex default paper conversation before validation", async function () {
    const { queries, registry, restore } = installProvisioningDb();
    try {
      const paperItem = {
        id: 3340,
        libraryID: 1,
        parentID: undefined,
        isAttachment: () => false,
        isRegularItem: () => true,
      } as unknown as Zotero.Item;
      globalThis.Zotero.Items.get = (itemID: number) =>
        itemID === 3340 ? paperItem : null;
      const conversationKey = buildDefaultCodexPaperConversationKey(3340);
      const portalItem = createCodexPaperPortalItem(
        paperItem,
        conversationKey,
      ) as Zotero.Item;

      assert.equal(
        await provisionConversationScopeForItem({ item: portalItem }),
        true,
      );
      assert.equal(registry.get(conversationKey)?.paperItemID, 3340);
      assert.equal(
        await validateConversationScope({
          conversationKey,
          system: "codex",
          kind: "paper",
          libraryID: 1,
          paperItemID: 3340,
        }),
        true,
      );
    } finally {
      restore();
    }
  });

  it("registers a fresh Claude default paper conversation before validation", async function () {
    const { queries, conversations, registry, restore } =
      installProvisioningDb();
    try {
      const paperItem = {
        id: 3340,
        libraryID: 1,
        parentID: undefined,
        isAttachment: () => false,
        isRegularItem: () => true,
      } as unknown as Zotero.Item;
      globalThis.Zotero.Items.get = (itemID: number) =>
        itemID === 3340 ? paperItem : null;
      const conversationKey = buildDefaultClaudePaperConversationKey(3340);
      const portalItem = createClaudePaperPortalItem(
        paperItem,
        conversationKey,
      ) as Zotero.Item;

      assert.equal(
        await provisionConversationScopeForItem({ item: portalItem }),
        true,
      );
      assert.equal(registry.get(conversationKey)?.paperItemID, 3340);
      assert.equal(
        await validateConversationScope({
          conversationKey,
          system: "claude_code",
          kind: "paper",
          libraryID: 1,
          paperItemID: 3340,
        }),
        true,
      );
    } finally {
      restore();
    }
  });

  it("coalesces concurrent Claude provisioning for a fresh paper", async function () {
    const { queries, conversations, registry, restore } =
      installProvisioningDb();
    try {
      const paperItem = {
        id: 3341,
        libraryID: 1,
        parentID: undefined,
        isAttachment: () => false,
        isRegularItem: () => true,
      } as unknown as Zotero.Item;
      globalThis.Zotero.Items.get = (itemID: number) =>
        itemID === 3341 ? paperItem : null;
      const conversationKey = buildDefaultClaudePaperConversationKey(3341);
      const portalItem = createClaudePaperPortalItem(
        paperItem,
        conversationKey,
      ) as Zotero.Item;

      const results = await Promise.all([
        provisionConversationScopeForItem({ item: portalItem }),
        provisionConversationScopeForItem({ item: portalItem }),
      ]);

      assert.deepEqual(results, [true, true]);
      assert.equal(conversations.get(conversationKey)?.paperItemID, 3341);
      assert.equal(registry.get(conversationKey)?.paperItemID, 3341);
      assert.lengthOf(
        queries.filter((query) =>
          query.sql.includes("INSERT INTO llm_for_zotero_claude_conversations"),
        ),
        1,
        "concurrent render paths must share one catalog creation",
      );
    } finally {
      restore();
    }
  });

  it("coalesces concurrent replacement of a retired Claude paper key", async function () {
    const { queries, ledger, restore } = installProvisioningDb();
    try {
      const paperItem = {
        id: 3342,
        libraryID: 1,
        parentID: undefined,
        isAttachment: () => false,
        isRegularItem: () => true,
      } as unknown as Zotero.Item;
      globalThis.Zotero.Items.get = (itemID: number) =>
        itemID === 3342 ? paperItem : null;
      const retiredKey = buildDefaultClaudePaperConversationKey(3342);
      ledger.set(retiredKey, {
        conversationKey: retiredKey,
        instanceID: "instance-retired-claude-paper",
        conversationID: "conversation-retired-claude-paper",
        system: "claude_code",
        kind: "paper",
        profileSignature: "profile-test",
        libraryID: 1,
        paperItemID: 3342,
        issuedAt: 1,
        retiredAt: 2,
      });
      const firstPortalItem = createClaudePaperPortalItem(
        paperItem,
        retiredKey,
      ) as Zotero.Item;
      const secondPortalItem = createClaudePaperPortalItem(
        paperItem,
        retiredKey,
      ) as Zotero.Item;

      const results = await Promise.all([
        provisionConversationScopeForItem({ item: firstPortalItem }),
        provisionConversationScopeForItem({ item: secondPortalItem }),
      ]);

      assert.deepEqual(results, [true, true]);
      assert.lengthOf(
        queries.filter((query) =>
          query.sql.includes("INSERT INTO llm_for_zotero_claude_conversations"),
        ),
        1,
        "concurrent render paths must share one retired-key replacement",
      );
      assert.equal(firstPortalItem.id, secondPortalItem.id);
      assert.notEqual(firstPortalItem.id, retiredKey);
    } finally {
      restore();
    }
  });

  it("does not register an arbitrary missing Codex paper key", async function () {
    const { queries, restore } = installProvisioningDb();
    try {
      const paperItem = {
        id: 3340,
        libraryID: 1,
        parentID: undefined,
        isAttachment: () => false,
        isRegularItem: () => true,
      } as unknown as Zotero.Item;
      globalThis.Zotero.Items.get = (itemID: number) =>
        itemID === 3340 ? paperItem : null;
      const conversationKey = buildDefaultCodexPaperConversationKey(3340) + 1;
      const portalItem = createCodexPaperPortalItem(
        paperItem,
        conversationKey,
      ) as Zotero.Item;

      assert.equal(
        await provisionConversationScopeForItem({ item: portalItem }),
        false,
      );
      assert.isFalse(
        queries.some((query) =>
          query.sql.includes("INSERT INTO llm_for_zotero_codex_conversations"),
        ),
      );
    } finally {
      restore();
    }
  });

  it("routes active note storage through the requested runtime system", function () {
    const { restore } = installProvisioningDb();
    const noteItem = {
      id: 55,
      libraryID: 1,
      parentID: undefined,
      isAttachment: () => false,
      isRegularItem: () => false,
      isNote: () => true,
      getNoteTitle: () => "Draft note",
    } as unknown as Zotero.Item;

    assert.equal(
      resolveConversationStorageSystemForItem({
        item: noteItem,
        conversationSystem: "codex",
      }),
      "codex",
    );
    assert.equal(
      resolveConversationStorageSystemForItem({
        item: noteItem,
        conversationSystem: "claude_code",
      }),
      "claude_code",
    );
    restore();
  });

  it("provisions a standalone note through the Codex library conversation", async function () {
    const { queries, conversations, registry, restore } =
      installProvisioningDb();
    try {
      const noteItem = {
        id: 55,
        libraryID: 1,
        parentID: undefined,
        isAttachment: () => false,
        isRegularItem: () => false,
        isNote: () => true,
        getNoteTitle: () => "Draft note",
      } as unknown as Zotero.Item;
      globalThis.Zotero.Prefs = {
        get: (key: string) => {
          if (String(key).endsWith("enableCodexAppServerMode")) return true;
          if (String(key).endsWith("conversationSystem")) return "codex";
          return "";
        },
      } as unknown as typeof Zotero.Prefs;

      const provisioned = await provisionConversationScopeForItem({
        item: noteItem,
        conversationSystem: "codex",
      });
      assert.equal(
        provisioned,
        true,
        JSON.stringify({
          queries: queries.map((entry) => entry.sql.slice(0, 120)),
          conversations: Array.from(conversations.entries()),
          registry: Array.from(registry.entries()),
        }),
      );
      const conversationKey = buildDefaultCodexGlobalConversationKey(1);
      assert.equal(registry.get(conversationKey)?.kind, "global");
      assert.equal(
        await validateConversationScope({
          conversationKey,
          system: "codex",
          kind: "global",
          libraryID: 1,
        }),
        true,
      );
    } finally {
      restore();
    }
  });

  it("provisions an item note through the upstream parent paper conversation", async function () {
    const { registry, restore } = installProvisioningDb();
    try {
      const parentItem = {
        id: 3340,
        libraryID: 1,
        parentID: undefined,
        isAttachment: () => false,
        isRegularItem: () => true,
        getField: (field: string) => (field === "title" ? "Parent paper" : ""),
      } as unknown as Zotero.Item;
      const noteItem = {
        id: 55,
        libraryID: 1,
        parentID: 3340,
        isAttachment: () => false,
        isRegularItem: () => false,
        isNote: () => true,
        getNoteTitle: () => "Draft note",
      } as unknown as Zotero.Item;
      globalThis.Zotero.Items.get = (itemID: number) =>
        itemID === 3340 ? parentItem : itemID === 55 ? noteItem : null;

      assert.equal(
        await provisionConversationScopeForItem({
          item: noteItem,
          conversationSystem: "upstream",
        }),
        true,
      );
      const conversationKey = buildDefaultConversationKey(
        "upstream",
        "paper",
        3340,
      );
      assert.equal(registry.get(conversationKey)?.kind, "paper");
      assert.equal(registry.get(conversationKey)?.paperItemID, 3340);
      assert.equal(
        await validateConversationScope({
          conversationKey,
          system: "upstream",
          kind: "paper",
          libraryID: 1,
          paperItemID: 3340,
        }),
        true,
      );
    } finally {
      restore();
    }
  });
});
