import { assert } from "chai";
import {
  CLAUDE_GLOBAL_CONVERSATION_KEY_BASE,
  CLAUDE_PAPER_CONVERSATION_KEY_BASE,
  CODEX_GLOBAL_CONVERSATION_KEY_BASE,
  CODEX_PAPER_CONVERSATION_KEY_BASE,
  RUNTIME_ALLOCATED_CONVERSATION_KEY_OFFSET,
  UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE,
  UPSTREAM_PAPER_CONVERSATION_KEY_BASE,
} from "../src/shared/conversationKeySpace";
import { cleanupRememberedConversationKeyPrefs } from "../src/shared/conversationKeyPrefCleanup";

const PREF_PREFIX = "extensions.zotero.llmforzotero";

function prefKey(key: string): string {
  return `${PREF_PREFIX}.${key}`;
}

function readMap(
  store: Map<string, unknown>,
  key: string,
): Record<string, number> {
  const raw = store.get(prefKey(key));
  return typeof raw === "string"
    ? (JSON.parse(raw) as Record<string, number>)
    : {};
}

describe("conversation key preference cleanup", function () {
  const originalZotero = globalThis.Zotero;
  const prefStore = new Map<string, unknown>();

  beforeEach(function () {
    prefStore.clear();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key) ?? "",
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("drops remembered keys that belong to another runtime band", function () {
    prefStore.set(
      prefKey("claudeCodeGlobalConversationMap"),
      JSON.stringify({
        valid: CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 1,
        codex: CODEX_GLOBAL_CONVERSATION_KEY_BASE + 1,
      }),
    );
    prefStore.set(
      prefKey("codexAppServerPaperConversationMap"),
      JSON.stringify({
        valid: CODEX_PAPER_CONVERSATION_KEY_BASE + 1,
        claude: CLAUDE_PAPER_CONVERSATION_KEY_BASE + 1,
      }),
    );
    prefStore.set(
      prefKey("lastUsedPaperConversationMap"),
      JSON.stringify({
        legacy: 42,
        extra: UPSTREAM_PAPER_CONVERSATION_KEY_BASE + 1,
        runtime: CODEX_PAPER_CONVERSATION_KEY_BASE + 1,
      }),
    );
    prefStore.set(
      prefKey("lastUsedGlobalConversationMap"),
      JSON.stringify({
        valid: UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 1,
        paper: UPSTREAM_PAPER_CONVERSATION_KEY_BASE + 1,
        runtime: CODEX_GLOBAL_CONVERSATION_KEY_BASE + 1,
      }),
    );
    prefStore.set(
      prefKey("claudeCodeLastAllocatedConversationKeyMap"),
      JSON.stringify({
        "profile-a:global":
          CLAUDE_GLOBAL_CONVERSATION_KEY_BASE +
          RUNTIME_ALLOCATED_CONVERSATION_KEY_OFFSET +
          2,
        "profile-a:paper": CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 3,
      }),
    );
    prefStore.set(
      prefKey("codexAppServerLastAllocatedGlobalConversationKey"),
      CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 4,
    );
    prefStore.set(
      prefKey("claudeCodeLastAllocatedPaperConversationKey"),
      CLAUDE_PAPER_CONVERSATION_KEY_BASE + 4,
    );

    cleanupRememberedConversationKeyPrefs();

    assert.deepEqual(readMap(prefStore, "claudeCodeGlobalConversationMap"), {
      valid: CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 1,
    });
    assert.deepEqual(readMap(prefStore, "codexAppServerPaperConversationMap"), {
      valid: CODEX_PAPER_CONVERSATION_KEY_BASE + 1,
    });
    assert.deepEqual(readMap(prefStore, "lastUsedPaperConversationMap"), {
      legacy: 42,
      extra: UPSTREAM_PAPER_CONVERSATION_KEY_BASE + 1,
    });
    assert.deepEqual(readMap(prefStore, "lastUsedGlobalConversationMap"), {
      valid: UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 1,
    });
    assert.deepEqual(
      readMap(prefStore, "claudeCodeLastAllocatedConversationKeyMap"),
      {
        "profile-a:global":
          CLAUDE_GLOBAL_CONVERSATION_KEY_BASE +
          RUNTIME_ALLOCATED_CONVERSATION_KEY_OFFSET +
          2,
      },
    );
    assert.equal(
      prefStore.get(
        prefKey("codexAppServerLastAllocatedGlobalConversationKey"),
      ),
      0,
    );
    assert.equal(
      prefStore.get(prefKey("claudeCodeLastAllocatedPaperConversationKey")),
      0,
    );
  });
});
