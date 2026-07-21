import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import { after, beforeEach, describe, it } from "mocha";
import { getClaudePaperConversationKeyRange } from "../src/claudeCode/constants";
import {
  getLastUsedClaudeConversationMode,
  getLastUsedClaudePaperConversationKey,
} from "../src/claudeCode/prefs";
import {
  activeClaudeConversationModeByLibrary,
  activeClaudePaperConversationByPaper,
  buildClaudeLibraryStateKey,
  buildClaudePaperStateKey,
} from "../src/claudeCode/state";
import { getCodexGlobalConversationKeyRange } from "../src/codexAppServer/constants";
import {
  getLastUsedCodexConversationMode,
  getLastUsedCodexGlobalConversationKey,
} from "../src/codexAppServer/prefs";
import {
  activeCodexConversationModeByLibrary,
  activeCodexGlobalConversationByLibrary,
  buildCodexLibraryStateKey,
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
    activeClaudePaperConversationByPaper.clear();
    activeCodexConversationModeByLibrary.clear();
    activeCodexGlobalConversationByLibrary.clear();
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

  it("primes paper mode and records the searched paper conversation", function () {
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
    assert.equal(getLastUsedPaperConversationKey(7, 42), 2201);

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
    assert.equal(getLastUsedPaperConversationKey(7, 42), 2201);

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
    assert.equal(getLastUsedPaperConversationKey(7, 42), 1101);
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
    assert.equal(getLastUsedClaudePaperConversationKey(7, 42), claudePaperKey);

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
});
