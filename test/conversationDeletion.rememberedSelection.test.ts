import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { config } from "../package.json";
import {
  buildDefaultClaudeGlobalConversationKey,
  buildDefaultClaudePaperConversationKey,
} from "../src/claudeCode/constants";
import {
  getLastUsedClaudeGlobalConversationKey,
  getLastUsedClaudePaperConversationKey,
  setLastUsedClaudeGlobalConversationKey,
  setLastUsedClaudePaperConversationKey,
} from "../src/claudeCode/prefs";
import {
  activeClaudeGlobalConversationByLibrary,
  activeClaudePaperConversationByPaper,
  buildClaudeLibraryStateKey,
  buildClaudePaperStateKey,
} from "../src/claudeCode/state";
import {
  buildDefaultCodexGlobalConversationKey,
  buildDefaultCodexPaperConversationKey,
} from "../src/codexAppServer/constants";
import {
  getLastUsedCodexGlobalConversationKey,
  getLastUsedCodexPaperConversationKey,
  setLastUsedCodexGlobalConversationKey,
  setLastUsedCodexPaperConversationKey,
} from "../src/codexAppServer/prefs";
import {
  activeCodexGlobalConversationByLibrary,
  activeCodexPaperConversationByPaper,
  buildCodexLibraryStateKey,
  buildCodexPaperStateKey,
} from "../src/codexAppServer/state";
import { buildDefaultUpstreamGlobalConversationKey } from "../src/modules/contextPanel/constants";
import { finalizeConversationDeletion } from "../src/modules/contextPanel/conversationDeletion";
import {
  buildPaperStateKey,
  getLastUsedPaperConversationKey,
  getLastUsedUpstreamGlobalConversationKey,
  getLockedGlobalConversationKey,
  setLastUsedPaperConversationKey,
  setLastUsedUpstreamGlobalConversationKey,
  setLockedGlobalConversationKey,
} from "../src/modules/contextPanel/prefHelpers";
import {
  activeGlobalConversationByLibrary,
  activePaperConversationByPaper,
} from "../src/modules/contextPanel/state";
import { flushPaperRestoreSelectionWrites } from "../src/shared/paperConversationRestore";
import type { ConversationSystem } from "../src/shared/types";
import {
  installPaperRestoreDb,
  type PaperRestoreDb,
} from "./helpers/paperRestoreDb";

/**
 * Characterization of the remembered-selection cleanup that runs after a
 * conversation is deleted: for every runtime, the active map entry and the
 * persisted pointer are cleared only when they still name the deleted key.
 */

const PROFILE_DIR = "/tmp/llm-for-zotero-deletion-selection-test";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
  ChromeUtils?: unknown;
};

function stubOperations() {
  return {
    preflightDeleteLocalConversationRows: async () => undefined,
    deleteLocalConversationRows: async () => undefined,
    clearOwnerAttachmentRefs: async () => undefined,
    removeConversationAttachmentFiles: async () => undefined,
    archiveCodexThread: async () => undefined,
    invalidateClaudeConversation: async () => undefined,
    invalidateClaudeConversationWithinWriteLock: async () => undefined,
  };
}

async function deleteConversation(target: {
  conversationKey: number;
  kind: "global" | "paper";
  conversationSystem: ConversationSystem;
  libraryID: number;
  paperItemID?: number;
  instanceID?: string;
}) {
  return finalizeConversationDeletion(target, {
    clearAgentToolCaches: () => undefined,
    clearAgentConversationState: async () => undefined,
    operations: stubOperations(),
  });
}

function clearAllMaps(): void {
  activeGlobalConversationByLibrary.clear();
  activePaperConversationByPaper.clear();
  activeClaudeGlobalConversationByLibrary.clear();
  activeClaudePaperConversationByPaper.clear();
  activeCodexGlobalConversationByLibrary.clear();
  activeCodexPaperConversationByPaper.clear();
}

describe("conversationDeletion remembered selection cleanup", function () {
  const originalZotero = globalScope.Zotero;
  const originalChromeUtils = globalScope.ChromeUtils;
  const prefStore = new Map<string, unknown>();

  function installPrefsOnlyZotero(): void {
    globalScope.Zotero = {
      Profile: { dir: PROFILE_DIR },
      Prefs: {
        get: (key: string) => prefStore.get(key) ?? "",
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    };
  }

  beforeEach(function () {
    prefStore.clear();
    clearAllMaps();
    installPrefsOnlyZotero();
  });

  afterEach(function () {
    clearAllMaps();
    globalScope.Zotero = originalZotero;
    globalScope.ChromeUtils = originalChromeUtils;
  });

  describe("global selection", function () {
    it("clears the Claude map entry and scoped pref that name the deleted key", async function () {
      const key = buildDefaultClaudeGlobalConversationKey(3);
      const otherKey = buildDefaultClaudeGlobalConversationKey(4);
      activeClaudeGlobalConversationByLibrary.set(
        buildClaudeLibraryStateKey(3),
        key,
      );
      activeClaudeGlobalConversationByLibrary.set(
        buildClaudeLibraryStateKey(4),
        otherKey,
      );
      setLastUsedClaudeGlobalConversationKey(3, key);
      setLastUsedClaudeGlobalConversationKey(4, otherKey);

      const result = await deleteConversation({
        conversationKey: key,
        kind: "global",
        conversationSystem: "claude_code",
        libraryID: 3,
      });

      assert.isTrue(result.ok);
      assert.isFalse(
        activeClaudeGlobalConversationByLibrary.has(
          buildClaudeLibraryStateKey(3),
        ),
      );
      assert.isNull(getLastUsedClaudeGlobalConversationKey(3));
      assert.equal(
        activeClaudeGlobalConversationByLibrary.get(
          buildClaudeLibraryStateKey(4),
        ),
        otherKey,
      );
      assert.equal(getLastUsedClaudeGlobalConversationKey(4), otherKey);
    });

    it("keeps a Claude map entry and pref that name a different key", async function () {
      const key = buildDefaultClaudeGlobalConversationKey(3);
      const survivingKey = key + 7;
      activeClaudeGlobalConversationByLibrary.set(
        buildClaudeLibraryStateKey(3),
        survivingKey,
      );
      setLastUsedClaudeGlobalConversationKey(3, survivingKey);

      await deleteConversation({
        conversationKey: key,
        kind: "global",
        conversationSystem: "claude_code",
        libraryID: 3,
      });

      assert.equal(
        activeClaudeGlobalConversationByLibrary.get(
          buildClaudeLibraryStateKey(3),
        ),
        survivingKey,
      );
      assert.equal(getLastUsedClaudeGlobalConversationKey(3), survivingKey);
    });

    it("clears a legacy unscoped Claude pref that names the deleted key", async function () {
      const key = buildDefaultClaudeGlobalConversationKey(3);
      prefStore.set(
        `${config.prefsPrefix}.claudeCodeGlobalConversationMap`,
        JSON.stringify({ "3": key }),
      );
      assert.equal(getLastUsedClaudeGlobalConversationKey(3), key);

      await deleteConversation({
        conversationKey: key,
        kind: "global",
        conversationSystem: "claude_code",
        libraryID: 3,
      });

      assert.isNull(getLastUsedClaudeGlobalConversationKey(3));
    });

    it("clears the Codex map entry and pref that name the deleted key", async function () {
      const key = buildDefaultCodexGlobalConversationKey(3);
      activeCodexGlobalConversationByLibrary.set(
        buildCodexLibraryStateKey(3),
        key,
      );
      setLastUsedCodexGlobalConversationKey(3, key);

      await deleteConversation({
        conversationKey: key,
        kind: "global",
        conversationSystem: "codex",
        libraryID: 3,
      });

      assert.isFalse(
        activeCodexGlobalConversationByLibrary.has(
          buildCodexLibraryStateKey(3),
        ),
      );
      assert.isNull(getLastUsedCodexGlobalConversationKey(3));
    });

    it("keeps a Codex map entry and pref that name a different key", async function () {
      const key = buildDefaultCodexGlobalConversationKey(3);
      const survivingKey = key + 9;
      activeCodexGlobalConversationByLibrary.set(
        buildCodexLibraryStateKey(3),
        survivingKey,
      );
      setLastUsedCodexGlobalConversationKey(3, survivingKey);

      await deleteConversation({
        conversationKey: key,
        kind: "global",
        conversationSystem: "codex",
        libraryID: 3,
      });

      assert.equal(
        activeCodexGlobalConversationByLibrary.get(
          buildCodexLibraryStateKey(3),
        ),
        survivingKey,
      );
      assert.equal(getLastUsedCodexGlobalConversationKey(3), survivingKey);
    });

    it("clears the upstream map entry, pref, and lock that name the deleted key", async function () {
      const key = buildDefaultUpstreamGlobalConversationKey(3) + 11;
      activeGlobalConversationByLibrary.set(3, key);
      setLastUsedUpstreamGlobalConversationKey(3, key);
      setLockedGlobalConversationKey(3, key);

      await deleteConversation({
        conversationKey: key,
        kind: "global",
        conversationSystem: "upstream",
        libraryID: 3,
      });

      assert.isFalse(activeGlobalConversationByLibrary.has(3));
      assert.isNull(getLastUsedUpstreamGlobalConversationKey(3));
      assert.isNull(getLockedGlobalConversationKey(3));
      assert.equal(
        prefStore.get(`${config.prefsPrefix}.lockedGlobalConversation.3`),
        0,
      );
    });

    it("keeps upstream map, pref, and lock that name a different key", async function () {
      const key = buildDefaultUpstreamGlobalConversationKey(3) + 11;
      const survivingKey = key + 1;
      activeGlobalConversationByLibrary.set(3, survivingKey);
      setLastUsedUpstreamGlobalConversationKey(3, survivingKey);
      setLockedGlobalConversationKey(3, survivingKey);

      await deleteConversation({
        conversationKey: key,
        kind: "global",
        conversationSystem: "upstream",
        libraryID: 3,
      });

      assert.equal(activeGlobalConversationByLibrary.get(3), survivingKey);
      assert.equal(getLastUsedUpstreamGlobalConversationKey(3), survivingKey);
      assert.equal(getLockedGlobalConversationKey(3), survivingKey);
    });

    it("clears each upstream pointer independently when only some name the deleted key", async function () {
      const key = buildDefaultUpstreamGlobalConversationKey(3) + 11;
      const survivingKey = key + 1;
      activeGlobalConversationByLibrary.set(3, survivingKey);
      setLastUsedUpstreamGlobalConversationKey(3, key);
      setLockedGlobalConversationKey(3, survivingKey);

      await deleteConversation({
        conversationKey: key,
        kind: "global",
        conversationSystem: "upstream",
        libraryID: 3,
      });

      assert.equal(activeGlobalConversationByLibrary.get(3), survivingKey);
      assert.isNull(getLastUsedUpstreamGlobalConversationKey(3));
      assert.equal(getLockedGlobalConversationKey(3), survivingKey);
    });
  });

  describe("paper selection map", function () {
    const cases: Array<{
      system: ConversationSystem;
      key: () => number;
      map: () => Map<string, number>;
      stateKey: () => string;
    }> = [
      {
        system: "upstream",
        key: () => 42,
        map: () => activePaperConversationByPaper,
        stateKey: () => buildPaperStateKey(3, 42),
      },
      {
        system: "claude_code",
        key: () => buildDefaultClaudePaperConversationKey(42),
        map: () => activeClaudePaperConversationByPaper,
        stateKey: () => buildClaudePaperStateKey(3, 42),
      },
      {
        system: "codex",
        key: () => buildDefaultCodexPaperConversationKey(42),
        map: () => activeCodexPaperConversationByPaper,
        stateKey: () => buildCodexPaperStateKey(3, 42),
      },
    ];

    for (const testCase of cases) {
      it(`deletes the ${testCase.system} paper map entry only when it names the deleted key`, async function () {
        const key = testCase.key();
        testCase.map().set(testCase.stateKey(), key + 1);
        await deleteConversation({
          conversationKey: key,
          kind: "paper",
          conversationSystem: testCase.system,
          libraryID: 3,
          paperItemID: 42,
        });
        assert.equal(testCase.map().get(testCase.stateKey()), key + 1);

        testCase.map().set(testCase.stateKey(), key);
        await deleteConversation({
          conversationKey: key,
          kind: "paper",
          conversationSystem: testCase.system,
          libraryID: 3,
          paperItemID: 42,
        });
        assert.isFalse(testCase.map().has(testCase.stateKey()));
      });
    }
  });

  describe("paper restore target", function () {
    let restoreDb: PaperRestoreDb | null = null;

    afterEach(async function () {
      await restoreDb?.close();
      restoreDb = null;
    });

    const cases: Array<{
      system: ConversationSystem;
      key: () => number;
      set: (libraryID: number, paperItemID: number, key: number) => void;
      get: (libraryID: number, paperItemID: number) => number | null;
    }> = [
      {
        system: "upstream",
        key: () => 4201,
        set: setLastUsedPaperConversationKey,
        get: getLastUsedPaperConversationKey,
      },
      {
        system: "claude_code",
        key: () => buildDefaultClaudePaperConversationKey(42),
        set: setLastUsedClaudePaperConversationKey,
        get: getLastUsedClaudePaperConversationKey,
      },
      {
        system: "codex",
        key: () => buildDefaultCodexPaperConversationKey(42),
        set: setLastUsedCodexPaperConversationKey,
        get: getLastUsedCodexPaperConversationKey,
      },
    ];

    it("invalidates the paper restore target only for the deleted instance", async function () {
      restoreDb = await installPaperRestoreDb({
        profileDir: PROFILE_DIR,
        prefStore,
      });
      const key = 4201;
      restoreDb.addPaperConversation("upstream", key, 3, 42);
      await restoreDb.initializeAllRuntimes();
      setLastUsedPaperConversationKey(3, 42, key);
      await flushPaperRestoreSelectionWrites();
      assert.equal(getLastUsedPaperConversationKey(3, 42), key);

      // The cached restore target now carries the registry instance ID.
      // Deleting the catalog row models a committed delete, so the identity
      // check finds no instance. Deleting the registry row is done only so a
      // mismatched-instance call gets past the scope check and reaches
      // `forget`.
      restoreDb.db.exec("DELETE FROM llm_for_zotero_conversation_registry");
      restoreDb.db.exec("DELETE FROM llm_for_zotero_paper_conversations");

      const target = {
        conversationKey: key,
        kind: "paper" as const,
        conversationSystem: "upstream" as const,
        libraryID: 3,
        paperItemID: 42,
      };
      const otherResult = await deleteConversation({
        ...target,
        instanceID: "instance-upstream-other",
      });
      assert.isTrue(otherResult.ok);
      assert.isFalse(otherResult.blocked);
      assert.equal(
        getLastUsedPaperConversationKey(3, 42),
        key,
        "a different instance's delete must not clear the target",
      );

      await deleteConversation({
        ...target,
        instanceID: `instance-upstream-${key}`,
      });
      assert.isNull(getLastUsedPaperConversationKey(3, 42));
    });

    for (const testCase of cases) {
      it(`invalidates the ${testCase.system} paper restore target only when it names the deleted key`, async function () {
        restoreDb = await installPaperRestoreDb({
          profileDir: PROFILE_DIR,
          prefStore,
        });
        const key = testCase.key();
        restoreDb.addPaperConversation(testCase.system, key, 3, 42);
        restoreDb.addPaperConversation(testCase.system, key + 1, 3, 43);
        await restoreDb.initializeAllRuntimes();
        testCase.set(3, 42, key);
        testCase.set(3, 43, key + 1);
        await flushPaperRestoreSelectionWrites();
        assert.equal(testCase.get(3, 42), key);
        assert.equal(testCase.get(3, 43), key + 1);

        // Run the deletion without a database so registry validation cannot
        // attach an instance witness; the restore cache stays in memory.
        installPrefsOnlyZotero();

        await deleteConversation({
          conversationKey: key + 1,
          kind: "paper",
          conversationSystem: testCase.system,
          libraryID: 3,
          paperItemID: 42,
        });
        assert.equal(testCase.get(3, 42), key);
        assert.equal(testCase.get(3, 43), key + 1);

        await deleteConversation({
          conversationKey: key,
          kind: "paper",
          conversationSystem: testCase.system,
          libraryID: 3,
          paperItemID: 42,
        });
        assert.isNull(testCase.get(3, 42));
        assert.equal(testCase.get(3, 43), key + 1);
      });
    }
  });
});
