import { assert } from "chai";
import {
  finalizeConversationDeletion,
  getConversationDeletionFailureMessage,
} from "../src/modules/contextPanel/conversationDeletion";

describe("conversationDeletion", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;

  afterEach(function () {
    globalScope.Zotero = originalZotero;
  });

  function createOperations(calls: string[]) {
    return {
      preflightDeleteLocalConversationRows: async (target: {
        conversationKey: number;
        kind: "global" | "paper";
        conversationSystem: "upstream" | "claude_code" | "codex";
      }) => {
        if (target.conversationSystem === "claude_code") {
          calls.push(`preflight-claude:${target.conversationKey}`);
        } else if (target.conversationSystem === "codex") {
          calls.push(`preflight-codex:${target.conversationKey}`);
        } else {
          calls.push(`preflight-${target.kind}:${target.conversationKey}`);
        }
      },
      deleteLocalConversationRows: async (target: {
        conversationKey: number;
        kind: "global" | "paper";
        conversationSystem: "upstream" | "claude_code" | "codex";
      }) => {
        if (target.conversationSystem === "claude_code") {
          calls.push(`local-claude:${target.conversationKey}`);
        } else if (target.conversationSystem === "codex") {
          calls.push(`local-codex:${target.conversationKey}`);
        } else {
          calls.push(`local-${target.kind}:${target.conversationKey}`);
        }
      },
      clearOwnerAttachmentRefs: async (
        _ownerType: string,
        ownerKey: number,
      ) => {
        calls.push(`refs:${ownerKey}`);
      },
      removeConversationAttachmentFiles: async (conversationKey: number) => {
        calls.push(`files:${conversationKey}`);
      },
      archiveCodexThread: async (threadId: string) => {
        calls.push(`archive:${threadId}`);
      },
      invalidateClaudeConversation: async (conversationKey: number) => {
        calls.push(`invalidate-claude:${conversationKey}`);
      },
      clearRememberedSelection: () => {
        calls.push("selection");
      },
    };
  }

  it("blocks deletion when the registry scope does not match the target", async function () {
    const calls: string[] = [];
    const logs: Array<[string, ...unknown[]]> = [];
    globalScope.Zotero = {
      DB: {
        queryAsync: async (sql: string) => {
          if (
            sql.includes("FROM llm_for_zotero_conversation_registry") &&
            sql.includes("WHERE legacy_conversation_key = ?")
          ) {
            return [
              {
                conversationKey: 7101,
                system: "codex",
                kind: "paper",
                profileSignature: "profile-test",
                libraryID: 1,
                paperItemID: 3196,
                valid: 1,
              },
            ];
          }
          return [];
        },
      },
    };

    const result = await finalizeConversationDeletion(
      {
        conversationKey: 7101,
        kind: "paper",
        conversationSystem: "codex",
        libraryID: 1,
        paperItemID: 3340,
      },
      {
        operations: createOperations(calls),
        log: (message, ...args) => {
          logs.push([message, ...args]);
        },
      },
    );

    assert.isFalse(result.ok);
    assert.isTrue(result.blocked);
    assert.deepEqual(calls, []);
    assert.equal(result.errors[0]?.code, "catalog_row");
    assert.equal(
      logs[0]?.[0],
      "LLM: Refused to delete conversation with mismatched registry scope",
    );
    assert.deepInclude(logs[0]?.[1] as Record<string, unknown>, {
      reason: "scope_mismatch",
    });
    assert.isObject((logs[0]?.[1] as { target?: unknown } | undefined)?.target);
    assert.isObject(
      (logs[0]?.[1] as { registered?: unknown } | undefined)?.registered,
    );
    assert.equal(
      getConversationDeletionFailureMessage(result),
      "Failed to delete conversation because its saved identity is inconsistent. Check logs.",
    );
  });

  it("allows deletion when only the catalog conversation id uses an old alias format", async function () {
    const calls: string[] = [];
    let deletedConversationID = "";
    globalScope.Zotero = {
      Profile: {
        dir: "",
      },
      DB: {
        queryAsync: async (sql: string) => {
          if (
            sql.includes("FROM llm_for_zotero_conversation_registry") &&
            sql.includes("WHERE legacy_conversation_key = ?")
          ) {
            return [
              {
                conversationID:
                  "lfz:profile-default:upstream:paper:lib-1:paper-2776:legacy-2776",
                conversationKey: 2776,
                system: "upstream",
                kind: "paper",
                profileSignature: "profile-default",
                libraryID: 1,
                paperItemID: 2776,
                valid: 1,
              },
            ];
          }
          return [];
        },
      },
    };
    const operations = createOperations(calls);
    operations.deleteLocalConversationRows = async (target) => {
      deletedConversationID = String(target.conversationID || "");
      calls.push(`local-${target.kind}:${target.conversationKey}`);
    };

    const result = await finalizeConversationDeletion(
      {
        conversationID:
          "conv-v1:profile-default:upstream:paper:library-1:paper-2776:legacy-2776",
        conversationKey: 2776,
        kind: "paper",
        conversationSystem: "upstream",
        libraryID: 1,
        paperItemID: 2776,
      },
      {
        operations,
      },
    );

    assert.isTrue(result.ok);
    assert.include(calls, "local-paper:2776");
    assert.equal(
      deletedConversationID,
      "lfz:profile-default:upstream:paper:lib-1:paper-2776:legacy-2776",
    );
  });

  it("deletes upstream global conversations through the shared cleanup path", async function () {
    const calls: string[] = [];
    const result = await finalizeConversationDeletion(
      {
        conversationKey: 7101,
        kind: "global",
        conversationSystem: "upstream",
        libraryID: 1,
      },
      {
        cancelPendingRequest: (conversationKey) => {
          calls.push(`cancel:${conversationKey}`);
        },
        clearTransientComposeStateForItem: (itemId) => {
          calls.push(`compose:${itemId}`);
        },
        resetSessionTokens: (conversationKey) => {
          calls.push(`tokens:${conversationKey}`);
        },
        clearAgentToolCaches: (conversationKey) => {
          calls.push(`tool:${conversationKey}`);
        },
        clearAgentConversationState: async (conversationKey) => {
          calls.push(`agent:${conversationKey}`);
        },
        scheduleAttachmentGc: () => {
          calls.push("gc");
        },
        operations: createOperations(calls),
      },
    );

    assert.isTrue(result.ok);
    assert.deepEqual(calls, [
      "cancel:7101",
      "preflight-global:7101",
      "local-global:7101",
      "tokens:7101",
      "compose:7101",
      "tool:7101",
      "agent:7101",
      "refs:7101",
      "files:7101",
      "selection",
      "gc",
    ]);
  });

  it("resolves the canonical conversation id before deletion scope validation", async function () {
    const calls: string[] = [];
    globalScope.Zotero = {
      DB: {
        queryAsync: async (sql: string) => {
          if (
            sql.includes("FROM llm_for_zotero_conversation_registry") &&
            sql.includes("WHERE legacy_conversation_key = ?")
          ) {
            return [
              {
                conversationID: "opaque-conversation-7103",
                conversationKey: 7103,
                system: "upstream",
                kind: "global",
                profileSignature: "profile-default",
                libraryID: 1,
                paperItemID: null,
                valid: 1,
              },
            ];
          }
          return [];
        },
      },
    };

    const result = await finalizeConversationDeletion(
      {
        conversationKey: 7103,
        kind: "global",
        conversationSystem: "upstream",
        libraryID: 1,
      },
      {
        clearAgentToolCaches: (conversationKey) => {
          calls.push(`tool:${conversationKey}`);
        },
        clearAgentConversationState: async (conversationKey) => {
          calls.push(`agent:${conversationKey}`);
        },
        operations: createOperations(calls),
      },
    );

    assert.isTrue(result.ok);
    assert.includeMembers(calls, [
      "tool:7103",
      "agent:7103",
      "local-global:7103",
    ]);
  });

  it("deletes upstream paper conversations with the paper catalog path", async function () {
    const calls: string[] = [];
    const result = await finalizeConversationDeletion(
      {
        conversationKey: 7102,
        kind: "paper",
        conversationSystem: "upstream",
        libraryID: 1,
        paperItemID: 44,
      },
      {
        clearTransientComposeStateForItem: (itemId) => {
          calls.push(`compose:${itemId}`);
        },
        clearAgentToolCaches: (conversationKey) => {
          calls.push(`tool:${conversationKey}`);
        },
        clearAgentConversationState: async (conversationKey) => {
          calls.push(`agent:${conversationKey}`);
        },
        operations: createOperations(calls),
      },
    );

    assert.isTrue(result.ok);
    assert.include(calls, "compose:44");
    assert.notInclude(calls, "compose:7102");
    assert.includeMembers(calls, ["local-paper:7102"]);
  });

  it("validates local Codex rows before committing local deletion", async function () {
    const calls: string[] = [];
    const result = await finalizeConversationDeletion(
      {
        conversationKey: 8101,
        kind: "global",
        conversationSystem: "codex",
        libraryID: 2,
        providerSessionId: "thread-abc",
      },
      {
        clearAgentToolCaches: (conversationKey) => {
          calls.push(`tool:${conversationKey}`);
        },
        clearAgentConversationState: async (conversationKey) => {
          calls.push(`agent:${conversationKey}`);
        },
        operations: createOperations(calls),
      },
    );

    assert.isTrue(result.ok);
    assert.deepEqual(calls.slice(0, 6), [
      "preflight-codex:8101",
      "local-codex:8101",
      "tool:8101",
      "agent:8101",
      "refs:8101",
      "files:8101",
    ]);
  });

  it("blocks native Codex archival when local row validation fails", async function () {
    const calls: string[] = [];
    const operations = createOperations(calls);
    operations.preflightDeleteLocalConversationRows = async (target) => {
      calls.push(
        `preflight-${target.conversationSystem}:${target.conversationKey}`,
      );
      throw new Error("ambiguous local rows");
    };

    const result = await finalizeConversationDeletion(
      {
        conversationKey: 8105,
        kind: "global",
        conversationSystem: "codex",
        libraryID: 2,
        providerSessionId: "thread-unsafe",
      },
      {
        operations,
      },
    );

    assert.isFalse(result.ok);
    assert.isTrue(result.blocked);
    assert.equal(result.errors[0]?.code, "message_rows");
    assert.deepEqual(calls, ["preflight-codex:8105"]);
  });

  it("does not block local Codex deletion if native thread archival fails", async function () {
    const calls: string[] = [];
    const operations = createOperations(calls);
    operations.archiveCodexThread = async (threadId: string) => {
      calls.push(`archive:${threadId}`);
      throw new Error("archive failed");
    };

    const result = await finalizeConversationDeletion(
      {
        conversationKey: 8102,
        kind: "paper",
        conversationSystem: "codex",
        libraryID: 2,
        paperItemID: 55,
        providerSessionId: "thread-blocked",
      },
      {
        clearAgentToolCaches: (conversationKey) => {
          calls.push(`tool:${conversationKey}`);
        },
        clearAgentConversationState: async (conversationKey) => {
          calls.push(`agent:${conversationKey}`);
        },
        scheduleAttachmentGc: () => {
          calls.push("gc");
        },
        operations,
      },
    );

    assert.isTrue(result.ok);
    assert.isFalse(result.blocked);
    assert.include(calls, "preflight-codex:8102");
    assert.include(calls, "local-codex:8102");
  });

  it("allows local Codex deletion when there is no stored native thread id", async function () {
    const calls: string[] = [];
    const result = await finalizeConversationDeletion(
      {
        conversationKey: 8103,
        kind: "global",
        conversationSystem: "codex",
        libraryID: 2,
      },
      {
        clearAgentToolCaches: (conversationKey) => {
          calls.push(`tool:${conversationKey}`);
        },
        clearAgentConversationState: async (conversationKey) => {
          calls.push(`agent:${conversationKey}`);
        },
        operations: createOperations(calls),
      },
    );

    assert.isTrue(result.ok);
    assert.notInclude(calls.join(","), "archive:");
    assert.includeMembers(calls, ["local-codex:8103"]);
  });

  it("does not clean up attachments when atomic local row deletion fails", async function () {
    const calls: string[] = [];
    const operations = createOperations(calls);
    operations.deleteLocalConversationRows = async (target) => {
      calls.push(
        `local-${target.conversationSystem}:${target.conversationKey}`,
      );
      throw new Error("local transaction failed");
    };

    const result = await finalizeConversationDeletion(
      {
        conversationKey: 8104,
        kind: "global",
        conversationSystem: "codex",
        libraryID: 2,
      },
      {
        clearAgentToolCaches: (conversationKey) => {
          calls.push(`tool:${conversationKey}`);
        },
        clearAgentConversationState: async (conversationKey) => {
          calls.push(`agent:${conversationKey}`);
        },
        operations,
      },
    );

    assert.isFalse(result.ok);
    assert.equal(result.errors[0]?.code, "message_rows");
    assert.include(calls, "local-codex:8104");
    assert.notInclude(calls, "tool:8104");
    assert.notInclude(calls, "agent:8104");
    assert.notInclude(calls, "refs:8104");
    assert.notInclude(calls, "files:8104");
    assert.notInclude(calls, "selection");
  });

  it("deletes local Claude rows before optional provider cleanup", async function () {
    const calls: string[] = [];
    const result = await finalizeConversationDeletion(
      {
        conversationKey: 9101,
        kind: "paper",
        conversationSystem: "claude_code",
        libraryID: 3,
        paperItemID: 66,
      },
      {
        clearAgentToolCaches: (conversationKey) => {
          calls.push(`tool:${conversationKey}`);
        },
        clearAgentConversationState: async (conversationKey) => {
          calls.push(`agent:${conversationKey}`);
        },
        operations: createOperations(calls),
      },
    );

    assert.isTrue(result.ok);
    assert.deepEqual(calls.slice(0, 5), [
      "preflight-claude:9101",
      "local-claude:9101",
      "tool:9101",
      "agent:9101",
      "refs:9101",
    ]);
  });
});
