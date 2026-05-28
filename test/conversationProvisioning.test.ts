import { assert } from "chai";
import { buildDefaultClaudePaperConversationKey } from "../src/claudeCode/constants";
import { createClaudePaperPortalItem } from "../src/claudeCode/portal";
import { buildDefaultCodexPaperConversationKey } from "../src/codexAppServer/constants";
import { createCodexPaperPortalItem } from "../src/codexAppServer/portal";
import {
  provisionConversationScopeForItem,
  resolveConversationStorageSystemForItem,
} from "../src/modules/contextPanel/conversationProvisioning";
import { validateConversationScope } from "../src/shared/conversationRegistry";

type QueryRecord = {
  sql: string;
  params: unknown[];
};

type RuntimeConversationRow = {
  conversationKey: number;
  libraryID: number;
  kind: "global" | "paper";
  paperItemID?: number | null;
  createdAt: number;
  updatedAt: number;
  title?: string | null;
};

type RegistryRow = RuntimeConversationRow & {
  system: "claude_code" | "codex";
  profileSignature: string;
  valid: number;
  invalidReason?: string | null;
};

function installProvisioningDb(): {
  queries: QueryRecord[];
  conversations: Map<number, RuntimeConversationRow>;
  registry: Map<number, RegistryRow>;
  restore: () => void;
} {
  const originalZotero = globalThis.Zotero;
  const queries: QueryRecord[] = [];
  const conversations = new Map<number, RuntimeConversationRow>();
  const registry = new Map<number, RegistryRow>();
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
          (sql.includes("FROM llm_for_zotero_codex_conversations c") ||
            sql.includes("FROM llm_for_zotero_claude_conversations c")) &&
          sql.includes("WHERE c.conversation_key = ?")
        ) {
          const row = conversations.get(Number(queryParams[0]));
          return row
            ? [
                {
                  conversationKey: row.conversationKey,
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
          sql.includes("FROM llm_for_zotero_conversation_registry") &&
          sql.includes("WHERE conversation_key = ?")
        ) {
          const row = registry.get(Number(queryParams[0]));
          return row
            ? [
                {
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
            conversationKey,
            system,
            kind,
            profileSignature,
            libraryID,
            paperItemID,
          ] = queryParams;
          registry.set(Number(conversationKey), {
            conversationKey: Number(conversationKey),
            system: system as "claude_code" | "codex",
            kind: kind as "global" | "paper",
            profileSignature: String(profileSignature),
            libraryID: Number(libraryID),
            paperItemID:
              Number.isFinite(Number(paperItemID)) && Number(paperItemID) > 0
                ? Number(paperItemID)
                : null,
            createdAt: Number(queryParams[6]),
            updatedAt: Number(queryParams[7]),
            title: typeof queryParams[8] === "string" ? queryParams[8] : null,
            valid: 1,
          });
          return [];
        }
        if (
          sql.includes("INSERT INTO llm_for_zotero_codex_conversations") ||
          sql.includes("INSERT INTO llm_for_zotero_claude_conversations")
        ) {
          const [
            conversationKey,
            libraryID,
            kind,
            paperItemID,
            createdAt,
            updatedAt,
            title,
          ] = queryParams;
          conversations.set(Number(conversationKey), {
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
        return [];
      },
      executeTransaction: async (callback: () => Promise<unknown>) =>
        await callback(),
    },
    debug: () => undefined,
  } as unknown as typeof Zotero;
  return {
    queries,
    conversations,
    registry,
    restore: () => {
      (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
        originalZotero;
    },
  };
}

describe("conversation provisioning", function () {
  const originalZotero = globalThis.Zotero;

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("registers a fresh Codex default paper conversation before validation", async function () {
    const { registry, restore } = installProvisioningDb();
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
    const { registry, restore } = installProvisioningDb();
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

  it("keeps active note transcripts in upstream storage even with Codex runtime", function () {
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
      "upstream",
    );
    restore();
  });
});
