import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import { after, afterEach, beforeEach, describe, it } from "mocha";
import { config } from "../package.json";
import {
  getClaudeGlobalConversationKeyRange,
  getClaudePaperConversationKeyRange,
} from "../src/claudeCode/constants";
import {
  getLastUsedClaudeConversationMode,
  getLastUsedClaudeGlobalConversationKey,
  getLastUsedClaudePaperConversationKey,
  setLastUsedClaudeConversationMode,
  setLastUsedClaudeGlobalConversationKey,
} from "../src/claudeCode/prefs";
import {
  activeClaudeConversationModeByLibrary,
  activeClaudeGlobalConversationByLibrary,
  activeClaudePaperConversationByPaper,
  buildClaudeLibraryStateKey,
  buildClaudePaperStateKey,
} from "../src/claudeCode/state";
import {
  getCodexGlobalConversationKeyRange,
  getCodexPaperConversationKeyRange,
} from "../src/codexAppServer/constants";
import {
  getLastUsedCodexConversationMode,
  getLastUsedCodexGlobalConversationKey,
  getLastUsedCodexPaperConversationKey,
} from "../src/codexAppServer/prefs";
import {
  activeCodexConversationModeByLibrary,
  activeCodexGlobalConversationByLibrary,
  activeCodexPaperConversationByPaper,
  buildCodexLibraryStateKey,
  buildCodexPaperStateKey,
} from "../src/codexAppServer/state";
import { buildDefaultUpstreamGlobalConversationKey } from "../src/modules/contextPanel/constants";
import { primeHistoryNavigationMode } from "../src/modules/contextPanel/historyNavigationModeSync";
import {
  buildPaperStateKey,
  getLastUsedUpstreamConversationMode,
  getLastUsedUpstreamGlobalConversationKey,
  getLastUsedPaperConversationKey,
  setLastUsedUpstreamConversationMode,
  setLastUsedUpstreamGlobalConversationKey,
  setLastUsedPaperConversationKey,
} from "../src/modules/contextPanel/prefHelpers";
import {
  activeConversationModeByLibrary,
  activeGlobalConversationByLibrary,
  activePaperConversationByPaper,
} from "../src/modules/contextPanel/state";
import { flushPaperRestoreSelectionWrites } from "../src/shared/paperConversationRestore";
import {
  installPaperRestoreDb,
  type PaperRestoreDb,
} from "./helpers/paperRestoreDb";

const here = dirname(fileURLToPath(import.meta.url));

describe("historyNavigationModeSync", function () {
  const originalZotero = globalThis.Zotero;
  const prefStore = new Map<string, unknown>();

  beforeEach(function () {
    prefStore.clear();
    activeConversationModeByLibrary.clear();
    activeGlobalConversationByLibrary.clear();
    activePaperConversationByPaper.clear();
    activeClaudeConversationModeByLibrary.clear();
    activeClaudeGlobalConversationByLibrary.clear();
    activeClaudePaperConversationByPaper.clear();
    activeCodexConversationModeByLibrary.clear();
    activeCodexGlobalConversationByLibrary.clear();
    activeCodexPaperConversationByPaper.clear();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Profile: {
        dir: "/tmp/llm-for-zotero-history-navigation-test",
      },
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

  it("primes active paper mode before the restore service initializes", function () {
    const snapshot = primeHistoryNavigationMode({
      system: "upstream",
      libraryID: 7,
      mode: "paper",
      conversationKey: 2201,
      paperItemID: 42,
    });

    assert.equal(activeConversationModeByLibrary.get(7), "paper");
    assert.equal(
      activePaperConversationByPaper.get(buildPaperStateKey(7, 42)),
      2201,
    );
    assert.equal(getLastUsedUpstreamConversationMode(7), "paper");
    assert.isNull(getLastUsedPaperConversationKey(7, 42));

    snapshot.restore();
    assert.isFalse(activeConversationModeByLibrary.has(7));
    assert.isFalse(
      activePaperConversationByPaper.has(buildPaperStateKey(7, 42)),
    );
    assert.isNull(getLastUsedUpstreamConversationMode(7));
    assert.isNull(getLastUsedPaperConversationKey(7, 42));
  });

  it("primes global mode and records the searched library conversation", function () {
    const conversationKey = buildDefaultUpstreamGlobalConversationKey(7);

    const snapshot = primeHistoryNavigationMode({
      system: "upstream",
      libraryID: 7,
      mode: "global",
      conversationKey,
    });

    assert.equal(activeConversationModeByLibrary.get(7), "global");
    assert.equal(activeGlobalConversationByLibrary.get(7), conversationKey);
    assert.equal(getLastUsedUpstreamConversationMode(7), "global");
    assert.equal(getLastUsedUpstreamGlobalConversationKey(7), conversationKey);

    snapshot.restore();
    assert.isFalse(activeConversationModeByLibrary.has(7));
    assert.isFalse(activeGlobalConversationByLibrary.has(7));
    assert.isNull(getLastUsedUpstreamConversationMode(7));
    assert.isNull(getLastUsedUpstreamGlobalConversationKey(7));
  });

  it("restores the previous mode state after failed history navigation", function () {
    activeConversationModeByLibrary.set(7, "global");
    activePaperConversationByPaper.set(buildPaperStateKey(7, 42), 1101);
    setLastUsedUpstreamConversationMode(7, "global");
    setLastUsedUpstreamGlobalConversationKey(
      7,
      buildDefaultUpstreamGlobalConversationKey(7),
    );
    setLastUsedPaperConversationKey(7, 42, 1101);

    const snapshot = primeHistoryNavigationMode({
      system: "upstream",
      libraryID: 7,
      mode: "paper",
      conversationKey: 2201,
      paperItemID: 42,
    });

    assert.equal(activeConversationModeByLibrary.get(7), "paper");
    assert.equal(
      activePaperConversationByPaper.get(buildPaperStateKey(7, 42)),
      2201,
    );
    assert.isNull(getLastUsedPaperConversationKey(7, 42));

    snapshot.restore();

    assert.equal(activeConversationModeByLibrary.get(7), "global");
    assert.equal(getLastUsedUpstreamConversationMode(7), "global");
    assert.equal(
      getLastUsedUpstreamGlobalConversationKey(7),
      buildDefaultUpstreamGlobalConversationKey(7),
    );
    assert.equal(
      activePaperConversationByPaper.get(buildPaperStateKey(7, 42)),
      1101,
    );
    assert.isNull(getLastUsedPaperConversationKey(7, 42));
  });

  it("does not restore a stale snapshot over a newer navigation", function () {
    activeConversationModeByLibrary.set(7, "global");
    const snapshot = primeHistoryNavigationMode({
      system: "upstream",
      libraryID: 7,
      mode: "paper",
      conversationKey: 2201,
      paperItemID: 42,
    });

    activeConversationModeByLibrary.set(7, "paper");
    activePaperConversationByPaper.set(buildPaperStateKey(7, 42), 3301);
    snapshot.restore();

    assert.equal(activeConversationModeByLibrary.get(7), "paper");
    assert.equal(
      activePaperConversationByPaper.get(buildPaperStateKey(7, 42)),
      3301,
    );
  });

  it("updates Claude and Codex runtime-specific mode state", function () {
    const claudePaperKey = getClaudePaperConversationKeyRange().start + 1;
    const claudeSnapshot = primeHistoryNavigationMode({
      system: "claude_code",
      libraryID: 7,
      mode: "paper",
      conversationKey: claudePaperKey,
      paperItemID: 42,
    });
    const claudeLibraryKey = buildClaudeLibraryStateKey(7);
    const claudePaperStateKey = buildClaudePaperStateKey(7, 42);

    assert.equal(
      activeClaudeConversationModeByLibrary.get(claudeLibraryKey),
      "paper",
    );
    assert.equal(getLastUsedClaudeConversationMode(7), "paper");
    assert.equal(
      activeClaudePaperConversationByPaper.get(claudePaperStateKey),
      claudePaperKey,
    );
    assert.isNull(getLastUsedClaudePaperConversationKey(7, 42));

    claudeSnapshot.restore();
    assert.isFalse(activeClaudeConversationModeByLibrary.has(claudeLibraryKey));
    assert.isFalse(
      activeClaudePaperConversationByPaper.has(claudePaperStateKey),
    );
    assert.isNull(getLastUsedClaudeConversationMode(7));
    assert.isNull(getLastUsedClaudePaperConversationKey(7, 42));

    const codexGlobalKey = getCodexGlobalConversationKeyRange().start + 1;
    const codexSnapshot = primeHistoryNavigationMode({
      system: "codex",
      libraryID: 7,
      mode: "global",
      conversationKey: codexGlobalKey,
    });
    const codexLibraryKey = buildCodexLibraryStateKey(7);

    assert.equal(
      activeCodexConversationModeByLibrary.get(codexLibraryKey),
      "global",
    );
    assert.equal(getLastUsedCodexConversationMode(7), "global");
    assert.equal(
      activeCodexGlobalConversationByLibrary.get(codexLibraryKey),
      codexGlobalKey,
    );
    assert.equal(getLastUsedCodexGlobalConversationKey(7), codexGlobalKey);

    codexSnapshot.restore();
    assert.isFalse(activeCodexConversationModeByLibrary.has(codexLibraryKey));
    assert.isFalse(activeCodexGlobalConversationByLibrary.has(codexLibraryKey));
    assert.isNull(getLastUsedCodexConversationMode(7));
    assert.isNull(getLastUsedCodexGlobalConversationKey(7));
  });

  it("restores the global entry before the mode entry (reverse priming order)", function () {
    const conversationKey = buildDefaultUpstreamGlobalConversationKey(7);
    const snapshot = primeHistoryNavigationMode({
      system: "upstream",
      libraryID: 7,
      mode: "global",
      conversationKey,
    });
    const writes: string[] = [];
    const prefs = (
      globalThis as typeof globalThis & {
        Zotero: { Prefs: { set: (key: string, value: unknown) => void } };
      }
    ).Zotero.Prefs;
    const originalSet = prefs.set;
    prefs.set = (key: string, value: unknown) => {
      writes.push(key);
      originalSet(key, value);
    };

    snapshot.restore();

    assert.deepEqual(writes, [
      `${config.prefsPrefix}.lastUsedGlobalConversationMap`,
      `${config.prefsPrefix}.lastUsedConversationModeMap`,
    ]);
  });

  it("does not restore anything when only the mode changed after priming", function () {
    const conversationKey = buildDefaultUpstreamGlobalConversationKey(7);
    const snapshot = primeHistoryNavigationMode({
      system: "upstream",
      libraryID: 7,
      mode: "global",
      conversationKey,
    });
    activeConversationModeByLibrary.set(7, "paper");

    snapshot.restore();

    assert.equal(activeConversationModeByLibrary.get(7), "paper");
    assert.equal(activeGlobalConversationByLibrary.get(7), conversationKey);
    assert.equal(getLastUsedUpstreamConversationMode(7), "global");
    assert.equal(getLastUsedUpstreamGlobalConversationKey(7), conversationKey);
  });

  it("primes nothing for an invalid library", function () {
    const snapshot = primeHistoryNavigationMode({
      system: "upstream",
      libraryID: 0,
      mode: "global",
      conversationKey: buildDefaultUpstreamGlobalConversationKey(7),
    });

    assert.equal(activeConversationModeByLibrary.size, 0);
    assert.equal(activeGlobalConversationByLibrary.size, 0);
    assert.equal(prefStore.size, 0);
    snapshot.restore();
    assert.equal(prefStore.size, 0);
  });

  it("primes only the mode when the paper target is incomplete", function () {
    const snapshot = primeHistoryNavigationMode({
      system: "codex",
      libraryID: 7,
      mode: "paper",
      conversationKey: getCodexPaperConversationKeyRange().start + 1,
    });
    const codexLibraryKey = buildCodexLibraryStateKey(7);

    assert.equal(
      activeCodexConversationModeByLibrary.get(codexLibraryKey),
      "paper",
    );
    assert.equal(activeCodexPaperConversationByPaper.size, 0);
    snapshot.restore();
    assert.isFalse(activeCodexConversationModeByLibrary.has(codexLibraryKey));
  });

  it("treats any mode other than global as paper", function () {
    primeHistoryNavigationMode({
      system: "upstream",
      libraryID: 7,
      mode: "library" as unknown as "paper",
    });

    assert.equal(activeConversationModeByLibrary.get(7), "paper");
    assert.equal(getLastUsedUpstreamConversationMode(7), "paper");
  });

  it("primes and restores Claude global and Codex paper state", function () {
    const claudeLibraryKey = buildClaudeLibraryStateKey(7);
    const previousClaudeKey = getClaudeGlobalConversationKeyRange().start + 3;
    activeClaudeConversationModeByLibrary.set(claudeLibraryKey, "paper");
    activeClaudeGlobalConversationByLibrary.set(
      claudeLibraryKey,
      previousClaudeKey,
    );
    setLastUsedClaudeConversationMode(7, "paper");
    setLastUsedClaudeGlobalConversationKey(7, previousClaudeKey);
    const claudeKey = getClaudeGlobalConversationKeyRange().start + 4;

    const claudeSnapshot = primeHistoryNavigationMode({
      system: "claude_code",
      libraryID: 7,
      mode: "global",
      conversationKey: claudeKey,
    });
    assert.equal(
      activeClaudeGlobalConversationByLibrary.get(claudeLibraryKey),
      claudeKey,
    );
    assert.equal(getLastUsedClaudeGlobalConversationKey(7), claudeKey);
    assert.equal(getLastUsedClaudeConversationMode(7), "global");
    claudeSnapshot.restore();
    assert.equal(
      activeClaudeConversationModeByLibrary.get(claudeLibraryKey),
      "paper",
    );
    assert.equal(
      activeClaudeGlobalConversationByLibrary.get(claudeLibraryKey),
      previousClaudeKey,
    );
    assert.equal(getLastUsedClaudeConversationMode(7), "paper");
    assert.equal(getLastUsedClaudeGlobalConversationKey(7), previousClaudeKey);

    const codexPaperKey = getCodexPaperConversationKeyRange().start + 1;
    const codexSnapshot = primeHistoryNavigationMode({
      system: "codex",
      libraryID: 7,
      mode: "paper",
      conversationKey: codexPaperKey,
      paperItemID: 42,
    });
    const codexPaperStateKey = buildCodexPaperStateKey(7, 42);
    assert.equal(
      activeCodexPaperConversationByPaper.get(codexPaperStateKey),
      codexPaperKey,
    );
    assert.isNull(getLastUsedCodexPaperConversationKey(7, 42));
    codexSnapshot.restore();
    assert.isFalse(activeCodexPaperConversationByPaper.has(codexPaperStateKey));
    assert.isNull(getLastUsedCodexConversationMode(7));
  });

  describe("with the paper restore service initialized", function () {
    let restoreDb: PaperRestoreDb | null = null;

    afterEach(async function () {
      await restoreDb?.close();
      restoreDb = null;
    });

    it("writes the paper restore target and restores the previous one", async function () {
      restoreDb = await installPaperRestoreDb({
        profileDir: "/tmp/llm-for-zotero-history-navigation-test",
        prefStore,
      });
      restoreDb.addPaperConversation("upstream", 1101, 7, 42);
      restoreDb.addPaperConversation("upstream", 2201, 7, 42);
      await restoreDb.initializeAllRuntimes();
      setLastUsedPaperConversationKey(7, 42, 1101);
      await flushPaperRestoreSelectionWrites();

      const snapshot = primeHistoryNavigationMode({
        system: "upstream",
        libraryID: 7,
        mode: "paper",
        conversationKey: 2201,
        paperItemID: 42,
      });
      assert.equal(getLastUsedPaperConversationKey(7, 42), 2201);

      snapshot.restore();
      assert.equal(getLastUsedPaperConversationKey(7, 42), 1101);
      assert.isFalse(
        activePaperConversationByPaper.has(buildPaperStateKey(7, 42)),
      );
    });

    it("forgets a primed paper restore target when none existed before", async function () {
      restoreDb = await installPaperRestoreDb({
        profileDir: "/tmp/llm-for-zotero-history-navigation-test",
        prefStore,
      });
      const claudeKey = getClaudePaperConversationKeyRange().start + 1;
      restoreDb.addPaperConversation("claude_code", claudeKey, 7, 42);
      await restoreDb.initializeAllRuntimes();

      const snapshot = primeHistoryNavigationMode({
        system: "claude_code",
        libraryID: 7,
        mode: "paper",
        conversationKey: claudeKey,
        paperItemID: 42,
      });
      assert.equal(getLastUsedClaudePaperConversationKey(7, 42), claudeKey);

      snapshot.restore();
      assert.isNull(getLastUsedClaudePaperConversationKey(7, 42));
    });
  });

  it("primes paper mode before selecting a searched paper in the sidebar", function () {
    const source = readFileSync(
      resolve(
        here,
        "../src/modules/contextPanel/setupHandlers/controllers/historyLifecycleController.ts",
      ),
      "utf8",
    );
    const switchStart = source.indexOf("const switchToHistoryEntry = async");
    const primeCall = source.indexOf(
      "primeHistoryNavigationMode({",
      switchStart,
    );
    const selectCall = source.indexOf(
      "maybeSelectHistoryEntryPaperItem",
      switchStart,
    );
    const switchCall = source.indexOf(
      "switchPaperConversation(entry.conversationKey",
      switchStart,
    );

    assert.isAtLeast(switchStart, 0);
    assert.isAtLeast(primeCall, switchStart);
    assert.isAtLeast(selectCall, switchStart);
    assert.isAtLeast(switchCall, switchStart);
    assert.isBelow(primeCall, selectCall);
    assert.isBelow(primeCall, switchCall);
  });

  it("terminates the source controller after cross-paper Zotero selection", function () {
    const source = readFileSync(
      resolve(
        here,
        "../src/modules/contextPanel/setupHandlers/controllers/historyLifecycleController.ts",
      ),
      "utf8",
    );
    const switchStart = source.indexOf("const switchToHistoryEntry = async");
    const crossPaperStart = source.indexOf(
      'if (navigationDecision === "select-target-paper")',
      switchStart,
    );
    const samePaperStart = source.indexOf(
      "if (!isPanelOperationLeaseCurrent(sourceLease))",
      crossPaperStart,
    );
    const crossPaperBranch = source.slice(crossPaperStart, samePaperStart);

    assert.include(crossPaperBranch, "loaded = true");
    assert.include(crossPaperBranch, "return true");
    assert.notInclude(crossPaperBranch, "switchPaperConversation(");
  });
});
