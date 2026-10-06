import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { config } from "../package.json";
import {
  buildDefaultClaudeGlobalConversationKey,
  buildDefaultClaudePaperConversationKey,
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
  buildDefaultCodexGlobalConversationKey,
  buildDefaultCodexPaperConversationKey,
} from "../src/codexAppServer/constants";
import {
  getLastUsedCodexConversationMode,
  getLastUsedCodexGlobalConversationKey,
  getLastUsedCodexPaperConversationKey,
  setLastUsedCodexGlobalConversationKey,
} from "../src/codexAppServer/prefs";
import {
  activeCodexConversationModeByLibrary,
  activeCodexGlobalConversationByLibrary,
  activeCodexPaperConversationByPaper,
  buildCodexLibraryStateKey,
  buildCodexPaperStateKey,
} from "../src/codexAppServer/state";
import { buildDefaultUpstreamGlobalConversationKey } from "../src/modules/contextPanel/constants";
import {
  clearStandaloneSelection,
  forget,
  isRemembered,
  prime,
  recall,
  recallActive,
  recallMode,
  recallPersisted,
  remember,
  rememberMode,
  rememberProvisioned,
  type SelectionScope,
} from "../src/modules/contextPanel/conversationSelection";
import {
  buildPaperStateKey,
  getLastUsedPaperConversationKey,
  getLastUsedUpstreamConversationMode,
  getLastUsedUpstreamGlobalConversationKey,
  setLastUsedUpstreamConversationMode,
  setLastUsedUpstreamGlobalConversationKey,
} from "../src/modules/contextPanel/prefHelpers";
import {
  activeConversationModeByLibrary,
  activeGlobalConversationByLibrary,
  activePaperConversationByPaper,
  standaloneConversationModeByLibrary,
  standaloneGlobalConversationByLibrary,
  standalonePaperConversationByPaper,
  webChatIsolatedConversationKeys,
} from "../src/modules/contextPanel/state";
import { flushPaperRestoreSelectionWrites } from "../src/shared/paperConversationRestore";
import type { ConversationSystem } from "../src/shared/types";
import {
  installPaperRestoreDb,
  type PaperRestoreDb,
} from "./helpers/paperRestoreDb";

const PROFILE_DIR = "/tmp/llm-for-zotero-conversation-selection-test";

const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };

type SystemFixture = {
  system: ConversationSystem;
  globalKey: () => number;
  paperKey: () => number;
  globalMap: () => Map<string | number, number>;
  globalStateKey: () => string | number;
  paperMap: () => Map<string, number>;
  paperStateKey: () => string;
  modeMap: () => Map<string | number, "global" | "paper">;
  modeStateKey: () => string | number;
  getGlobal: () => number | null;
  setGlobal: (key: number) => void;
  getPaper: () => number | null;
  getMode: () => "global" | "paper" | null;
};

const LIBRARY_ID = 5;
const PAPER_ID = 42;

const FIXTURES: SystemFixture[] = [
  {
    system: "upstream",
    globalKey: () => buildDefaultUpstreamGlobalConversationKey(LIBRARY_ID) + 1,
    paperKey: () => 4201,
    globalMap: () =>
      activeGlobalConversationByLibrary as Map<string | number, number>,
    globalStateKey: () => LIBRARY_ID,
    paperMap: () => activePaperConversationByPaper,
    paperStateKey: () => buildPaperStateKey(LIBRARY_ID, PAPER_ID),
    modeMap: () =>
      activeConversationModeByLibrary as Map<
        string | number,
        "global" | "paper"
      >,
    modeStateKey: () => LIBRARY_ID,
    getGlobal: () => getLastUsedUpstreamGlobalConversationKey(LIBRARY_ID),
    setGlobal: (key) =>
      setLastUsedUpstreamGlobalConversationKey(LIBRARY_ID, key),
    getPaper: () => getLastUsedPaperConversationKey(LIBRARY_ID, PAPER_ID),
    getMode: () => getLastUsedUpstreamConversationMode(LIBRARY_ID),
  },
  {
    system: "claude_code",
    globalKey: () => buildDefaultClaudeGlobalConversationKey(LIBRARY_ID) + 1,
    paperKey: () => buildDefaultClaudePaperConversationKey(PAPER_ID) + 1,
    globalMap: () =>
      activeClaudeGlobalConversationByLibrary as Map<string | number, number>,
    globalStateKey: () => buildClaudeLibraryStateKey(LIBRARY_ID),
    paperMap: () => activeClaudePaperConversationByPaper,
    paperStateKey: () => buildClaudePaperStateKey(LIBRARY_ID, PAPER_ID),
    modeMap: () =>
      activeClaudeConversationModeByLibrary as Map<
        string | number,
        "global" | "paper"
      >,
    modeStateKey: () => buildClaudeLibraryStateKey(LIBRARY_ID),
    getGlobal: () => getLastUsedClaudeGlobalConversationKey(LIBRARY_ID),
    setGlobal: (key) => setLastUsedClaudeGlobalConversationKey(LIBRARY_ID, key),
    getPaper: () => getLastUsedClaudePaperConversationKey(LIBRARY_ID, PAPER_ID),
    getMode: () => getLastUsedClaudeConversationMode(LIBRARY_ID),
  },
  {
    system: "codex",
    globalKey: () => buildDefaultCodexGlobalConversationKey(LIBRARY_ID) + 1,
    paperKey: () => buildDefaultCodexPaperConversationKey(PAPER_ID) + 1,
    globalMap: () =>
      activeCodexGlobalConversationByLibrary as Map<string | number, number>,
    globalStateKey: () => buildCodexLibraryStateKey(LIBRARY_ID),
    paperMap: () => activeCodexPaperConversationByPaper,
    paperStateKey: () => buildCodexPaperStateKey(LIBRARY_ID, PAPER_ID),
    modeMap: () =>
      activeCodexConversationModeByLibrary as Map<
        string | number,
        "global" | "paper"
      >,
    modeStateKey: () => buildCodexLibraryStateKey(LIBRARY_ID),
    getGlobal: () => getLastUsedCodexGlobalConversationKey(LIBRARY_ID),
    setGlobal: (key) => setLastUsedCodexGlobalConversationKey(LIBRARY_ID, key),
    getPaper: () => getLastUsedCodexPaperConversationKey(LIBRARY_ID, PAPER_ID),
    getMode: () => getLastUsedCodexConversationMode(LIBRARY_ID),
  },
];

function clearMaps(): void {
  activeConversationModeByLibrary.clear();
  activeGlobalConversationByLibrary.clear();
  activePaperConversationByPaper.clear();
  activeClaudeConversationModeByLibrary.clear();
  activeClaudeGlobalConversationByLibrary.clear();
  activeClaudePaperConversationByPaper.clear();
  activeCodexConversationModeByLibrary.clear();
  activeCodexGlobalConversationByLibrary.clear();
  activeCodexPaperConversationByPaper.clear();
  clearStandaloneSelection();
  webChatIsolatedConversationKeys.clear();
}

describe("conversationSelection", function () {
  const originalZotero = globalScope.Zotero;
  const prefStore = new Map<string, unknown>();
  let restoreDb: PaperRestoreDb | null = null;

  beforeEach(function () {
    prefStore.clear();
    clearMaps();
    globalScope.Zotero = {
      Profile: { dir: PROFILE_DIR },
      Prefs: {
        get: (key: string) => prefStore.get(key) ?? "",
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    };
  });

  afterEach(async function () {
    await restoreDb?.close();
    restoreDb = null;
    clearMaps();
    globalScope.Zotero = originalZotero;
  });

  async function initializeRestore(
    fixture: SystemFixture,
    keys: number[],
  ): Promise<void> {
    restoreDb = await installPaperRestoreDb({
      profileDir: PROFILE_DIR,
      prefStore,
    });
    for (const key of keys) {
      restoreDb.addPaperConversation(fixture.system, key, LIBRARY_ID, PAPER_ID);
    }
    await restoreDb.initializeAllRuntimes();
  }

  for (const fixture of FIXTURES) {
    const globalScopeFor = (): SelectionScope => ({
      system: fixture.system,
      libraryID: LIBRARY_ID,
      kind: "global",
    });
    const paperScopeFor = (): SelectionScope => ({
      system: fixture.system,
      libraryID: LIBRARY_ID,
      kind: "paper",
      paperItemID: PAPER_ID,
    });

    describe(fixture.system, function () {
      it("recalls the global key from the active map, then the pref, then 0", function () {
        const scope = globalScopeFor();
        assert.equal(recallActive(scope), 0);
        assert.isNull(recallPersisted(scope));
        assert.equal(recall(scope), 0);

        fixture.setGlobal(fixture.globalKey());
        assert.equal(recallActive(scope), 0);
        assert.equal(recallPersisted(scope), fixture.globalKey());
        assert.equal(recall(scope), fixture.globalKey());

        fixture
          .globalMap()
          .set(fixture.globalStateKey(), fixture.globalKey() + 1);
        assert.equal(recallActive(scope), fixture.globalKey() + 1);
        assert.equal(recall(scope), fixture.globalKey() + 1);
      });

      it("reports a key as remembered when either pointer names it", function () {
        const scope = globalScopeFor();
        const key = fixture.globalKey();
        assert.isFalse(isRemembered(scope, key));
        fixture.globalMap().set(fixture.globalStateKey(), key);
        assert.isTrue(isRemembered(scope, key));
        fixture.globalMap().clear();
        fixture.setGlobal(key);
        assert.isTrue(isRemembered(scope, key));
        assert.isFalse(isRemembered(scope, key + 1));
      });

      it("remembers a global key in the map and pref, or the map only", function () {
        const scope = globalScopeFor();
        remember(scope, fixture.globalKey(), { persist: false });
        assert.equal(
          fixture.globalMap().get(fixture.globalStateKey()),
          fixture.globalKey(),
        );
        assert.isNull(fixture.getGlobal());

        remember(scope, fixture.globalKey() + 1);
        assert.equal(
          fixture.globalMap().get(fixture.globalStateKey()),
          fixture.globalKey() + 1,
        );
        assert.equal(fixture.getGlobal(), fixture.globalKey() + 1);
      });

      it("forgets the global selection only where it names the expected key", function () {
        const scope = globalScopeFor();
        const key = fixture.globalKey();
        fixture.globalMap().set(fixture.globalStateKey(), key);
        fixture.setGlobal(key + 1);

        forget(scope, { expectedKey: key });
        assert.isFalse(fixture.globalMap().has(fixture.globalStateKey()));
        assert.equal(fixture.getGlobal(), key + 1);

        fixture.globalMap().set(fixture.globalStateKey(), key + 2);
        forget(scope, { expectedKey: key + 1 });
        assert.equal(
          fixture.globalMap().get(fixture.globalStateKey()),
          key + 2,
        );
        assert.isNull(fixture.getGlobal());
      });

      it("reads paper keys from the map and keeps the restore target null before init", function () {
        const scope = paperScopeFor();
        remember(scope, fixture.paperKey());
        assert.equal(
          fixture.paperMap().get(fixture.paperStateKey()),
          fixture.paperKey(),
        );
        assert.equal(recallActive(scope), fixture.paperKey());
        assert.isNull(recallPersisted(scope));
        assert.isTrue(isRemembered(scope, fixture.paperKey()));
      });

      it("remembers, recalls, and forgets the paper restore target after init", async function () {
        await initializeRestore(fixture, [
          fixture.paperKey(),
          fixture.paperKey() + 1,
        ]);
        const scope = paperScopeFor();

        remember(scope, fixture.paperKey(), { persist: false });
        assert.isNull(fixture.getPaper());

        remember(scope, fixture.paperKey());
        await flushPaperRestoreSelectionWrites();
        assert.equal(fixture.getPaper(), fixture.paperKey());
        fixture.paperMap().clear();
        assert.equal(recallPersisted(scope), fixture.paperKey());
        assert.equal(recall(scope), fixture.paperKey());
        assert.isTrue(isRemembered(scope, fixture.paperKey()));

        fixture.paperMap().set(fixture.paperStateKey(), fixture.paperKey());
        forget(scope, { expectedKey: fixture.paperKey() + 1 });
        assert.equal(
          fixture.paperMap().get(fixture.paperStateKey()),
          fixture.paperKey(),
        );
        assert.equal(fixture.getPaper(), fixture.paperKey());

        forget(scope, {
          expectedKey: fixture.paperKey(),
          instanceID: "a-different-instance",
        });
        assert.isFalse(fixture.paperMap().has(fixture.paperStateKey()));
        assert.equal(fixture.getPaper(), fixture.paperKey());

        forget(scope, { expectedKey: fixture.paperKey() });
        assert.isNull(fixture.getPaper());
      });

      it("recalls the mode from the active map or the pref only", function () {
        assert.isNull(
          recallMode(fixture.system, LIBRARY_ID, {
            source: "active+persisted",
          }),
        );
        rememberMode(fixture.system, LIBRARY_ID, "global", { active: false });
        assert.isFalse(fixture.modeMap().has(fixture.modeStateKey()));
        assert.equal(fixture.getMode(), "global");

        fixture.modeMap().set(fixture.modeStateKey(), "paper");
        assert.equal(
          recallMode(fixture.system, LIBRARY_ID, {
            source: "active+persisted",
          }),
          "paper",
        );
        assert.equal(
          recallMode(fixture.system, LIBRARY_ID, { source: "persisted" }),
          "global",
        );

        rememberMode(fixture.system, LIBRARY_ID, "paper");
        assert.equal(fixture.modeMap().get(fixture.modeStateKey()), "paper");
        assert.equal(fixture.getMode(), "paper");
      });

      describe("standalone surface", function () {
        const windowGlobal = (): SelectionScope => ({
          ...globalScopeFor(),
          surface: "standalone",
        });
        const windowPaper = (): SelectionScope => ({
          ...paperScopeFor(),
          surface: "standalone",
        });

        it("remembers the window's global key in its own slot only", function () {
          remember(windowGlobal(), fixture.globalKey());
          assert.isFalse(fixture.globalMap().has(fixture.globalStateKey()));
          assert.isNull(fixture.getGlobal());
          assert.equal(recallActive(windowGlobal()), fixture.globalKey());
          assert.equal(recall(windowGlobal()), fixture.globalKey());
          assert.equal(recall(globalScopeFor()), 0);
          assert.equal(standaloneGlobalConversationByLibrary.size, 1);
        });

        it("never persists, even when asked to", function () {
          remember(windowGlobal(), fixture.globalKey(), { persist: true });
          assert.isNull(fixture.getGlobal());
        });

        it("reads the sidebar's choice until the window makes its own", function () {
          fixture.setGlobal(fixture.globalKey());
          assert.equal(recall(windowGlobal()), fixture.globalKey());
          fixture
            .globalMap()
            .set(fixture.globalStateKey(), fixture.globalKey() + 1);
          assert.equal(recallActive(windowGlobal()), fixture.globalKey() + 1);
          remember(windowGlobal(), fixture.globalKey() + 2);
          assert.equal(recall(windowGlobal()), fixture.globalKey() + 2);
          assert.equal(recall(globalScopeFor()), fixture.globalKey() + 1);
        });

        it("keeps the window's paper key apart from the sidebar's", function () {
          remember(paperScopeFor(), fixture.paperKey(), { persist: false });
          remember(windowPaper(), fixture.paperKey() + 1);
          assert.equal(recall(paperScopeFor()), fixture.paperKey());
          assert.equal(recall(windowPaper()), fixture.paperKey() + 1);
          assert.equal(
            fixture.paperMap().get(fixture.paperStateKey()),
            fixture.paperKey(),
          );
          assert.equal(standalonePaperConversationByPaper.size, 1);
        });

        it("counts a key the window remembers as remembered for either surface", function () {
          remember(windowPaper(), fixture.paperKey());
          assert.isTrue(isRemembered(paperScopeFor(), fixture.paperKey()));
          assert.isTrue(isRemembered(windowPaper(), fixture.paperKey()));
        });

        it("forgets a deleted key in both surfaces", function () {
          const key = fixture.globalKey();
          fixture.globalMap().set(fixture.globalStateKey(), key);
          remember(windowGlobal(), key);
          forget(globalScopeFor(), { expectedKey: key });
          assert.isFalse(fixture.globalMap().has(fixture.globalStateKey()));
          assert.equal(standaloneGlobalConversationByLibrary.size, 0);
        });

        it("remembers the window's mode without touching the sidebar's mode or the pref", function () {
          rememberMode(fixture.system, LIBRARY_ID, "global", {
            surface: "standalone",
          });
          assert.isFalse(fixture.modeMap().has(fixture.modeStateKey()));
          assert.isNull(fixture.getMode());
          assert.equal(
            recallMode(fixture.system, LIBRARY_ID, {
              source: "active+persisted",
              surface: "standalone",
            }),
            "global",
          );
          assert.isNull(
            recallMode(fixture.system, LIBRARY_ID, {
              source: "active+persisted",
            }),
          );
          assert.equal(standaloneConversationModeByLibrary.size, 1);
        });

        it("reads the sidebar's mode until the window has its own", function () {
          rememberMode(fixture.system, LIBRARY_ID, "paper");
          assert.equal(
            recallMode(fixture.system, LIBRARY_ID, {
              source: "active+persisted",
              surface: "standalone",
            }),
            "paper",
          );
        });

        it("primes and restores the window's own slots, never the sidebar's or a pref", function () {
          fixture.modeMap().set(fixture.modeStateKey(), "paper");
          fixture
            .globalMap()
            .set(fixture.globalStateKey(), fixture.globalKey());
          const snapshot = prime({
            system: fixture.system,
            libraryID: LIBRARY_ID,
            mode: "global",
            conversationKey: fixture.globalKey() + 3,
            surface: "standalone",
          });
          assert.equal(fixture.modeMap().get(fixture.modeStateKey()), "paper");
          assert.equal(
            fixture.globalMap().get(fixture.globalStateKey()),
            fixture.globalKey(),
          );
          assert.isNull(fixture.getMode());
          assert.isNull(fixture.getGlobal());
          assert.equal(recall(windowGlobal()), fixture.globalKey() + 3);

          snapshot.restore();
          assert.equal(recall(windowGlobal()), fixture.globalKey());
          assert.equal(standaloneConversationModeByLibrary.size, 0);
          assert.equal(standaloneGlobalConversationByLibrary.size, 0);
        });

        it("primes a window paper navigation into the window's paper slot", function () {
          prime({
            system: fixture.system,
            libraryID: LIBRARY_ID,
            mode: "paper",
            conversationKey: fixture.paperKey(),
            paperItemID: PAPER_ID,
            surface: "standalone",
          });
          assert.isFalse(fixture.paperMap().has(fixture.paperStateKey()));
          assert.equal(recall(windowPaper()), fixture.paperKey());
        });

        it("re-points only the surfaces that asked for a provisioned conversation", function () {
          const requested = fixture.globalKey();
          const replacement = fixture.globalKey() + 7;
          const sidebarChoice = fixture.globalKey() + 1;
          fixture.globalMap().set(fixture.globalStateKey(), sidebarChoice);
          remember(windowGlobal(), requested);
          rememberProvisioned(globalScopeFor(), requested, replacement);
          assert.equal(recall(windowGlobal()), replacement);
          assert.equal(
            fixture.globalMap().get(fixture.globalStateKey()),
            sidebarChoice,
          );
          assert.isNull(fixture.getGlobal());

          fixture.globalMap().set(fixture.globalStateKey(), requested);
          rememberProvisioned(globalScopeFor(), requested, replacement);
          assert.equal(
            fixture.globalMap().get(fixture.globalStateKey()),
            replacement,
          );
          assert.equal(fixture.getGlobal(), replacement);
        });

        it("records a provisioned conversation for a sidebar that has chosen nothing", function () {
          rememberProvisioned(
            globalScopeFor(),
            fixture.globalKey(),
            fixture.globalKey(),
          );
          assert.equal(
            fixture.globalMap().get(fixture.globalStateKey()),
            fixture.globalKey(),
          );
          assert.equal(fixture.getGlobal(), fixture.globalKey());
          assert.equal(standaloneGlobalConversationByLibrary.size, 0);
        });

        it("drops everything the window chose when cleared", function () {
          remember(windowGlobal(), fixture.globalKey());
          remember(windowPaper(), fixture.paperKey());
          rememberMode(fixture.system, LIBRARY_ID, "global", {
            surface: "standalone",
          });
          clearStandaloneSelection();
          assert.equal(recall(windowGlobal()), 0);
          assert.equal(recall(windowPaper()), 0);
          assert.isNull(
            recallMode(fixture.system, LIBRARY_ID, {
              source: "active+persisted",
              surface: "standalone",
            }),
          );
        });
      });

      it("primes the mode and global key and restores both", function () {
        const snapshot = prime({
          system: fixture.system,
          libraryID: LIBRARY_ID,
          mode: "global",
          conversationKey: fixture.globalKey(),
        });
        assert.equal(fixture.modeMap().get(fixture.modeStateKey()), "global");
        assert.equal(
          fixture.globalMap().get(fixture.globalStateKey()),
          fixture.globalKey(),
        );
        assert.equal(fixture.getGlobal(), fixture.globalKey());

        snapshot.restore();
        assert.isFalse(fixture.modeMap().has(fixture.modeStateKey()));
        assert.isFalse(fixture.globalMap().has(fixture.globalStateKey()));
        assert.isNull(fixture.getGlobal());
        assert.isNull(fixture.getMode());
      });
    });
  }

  it("keeps the upstream webchat guard: an isolated key is remembered in the map only", function () {
    const key = buildDefaultUpstreamGlobalConversationKey(LIBRARY_ID) + 9;
    webChatIsolatedConversationKeys.add(key);
    remember(
      { system: "upstream", libraryID: LIBRARY_ID, kind: "global" },
      key,
    );
    assert.equal(activeGlobalConversationByLibrary.get(LIBRARY_ID), key);
    assert.isNull(getLastUsedUpstreamGlobalConversationKey(LIBRARY_ID));
  });

  it("keeps the Claude key-range guard: an out-of-range key is remembered in the map only", function () {
    const key = buildDefaultCodexGlobalConversationKey(LIBRARY_ID);
    remember(
      { system: "claude_code", libraryID: LIBRARY_ID, kind: "global" },
      key,
    );
    assert.equal(
      activeClaudeGlobalConversationByLibrary.get(
        buildClaudeLibraryStateKey(LIBRARY_ID),
      ),
      key,
    );
    assert.isNull(getLastUsedClaudeGlobalConversationKey(LIBRARY_ID));
  });

  it("keeps each runtime's mode-pref normalization for invalid input", function () {
    const invalid = "library" as unknown as "paper";
    rememberMode("claude_code", LIBRARY_ID, invalid, { active: false });
    rememberMode("codex", LIBRARY_ID, invalid, { active: false });
    rememberMode("upstream", LIBRARY_ID, invalid, { active: false });
    assert.equal(getLastUsedClaudeConversationMode(LIBRARY_ID), "paper");
    assert.equal(getLastUsedCodexConversationMode(LIBRARY_ID), "global");
    assert.equal(getLastUsedUpstreamConversationMode(LIBRARY_ID), "paper");
  });

  it("does not normalize the upstream library ID used as the map key", function () {
    activeGlobalConversationByLibrary.set(0, 2_000_000_123);
    assert.equal(
      recallActive({ system: "upstream", libraryID: 0, kind: "global" }),
      2_000_000_123,
    );
  });

  it("falls back to upstream for a system name that is only an inherited property", function () {
    const system = "constructor" as unknown as ConversationSystem;
    const key = buildDefaultUpstreamGlobalConversationKey(LIBRARY_ID);
    remember({ system, libraryID: LIBRARY_ID, kind: "global" }, key);
    assert.equal(
      recallActive({ system, libraryID: LIBRARY_ID, kind: "global" }),
      key,
    );
    assert.equal(activeGlobalConversationByLibrary.get(LIBRARY_ID), key);
  });

  it("forgets a legacy unscoped Claude global pref", function () {
    const key = buildDefaultClaudeGlobalConversationKey(LIBRARY_ID);
    prefStore.set(
      `${config.prefsPrefix}.claudeCodeGlobalConversationMap`,
      JSON.stringify({ [String(LIBRARY_ID)]: key }),
    );
    const scope: SelectionScope = {
      system: "claude_code",
      libraryID: LIBRARY_ID,
      kind: "global",
    };
    forget(scope, { expectedKey: key });
    assert.isNull(recallPersisted(scope));
  });

  it("keeps another profile's legacy unscoped Claude entry when forgetting", function () {
    const key = buildDefaultClaudeGlobalConversationKey(LIBRARY_ID);
    // An upstream key is outside this profile's Claude range.
    const foreign = buildDefaultUpstreamGlobalConversationKey(LIBRARY_ID);
    const prefKey = `${config.prefsPrefix}.claudeCodeGlobalConversationMap`;
    prefStore.set(prefKey, JSON.stringify({ [String(LIBRARY_ID)]: foreign }));
    const scope: SelectionScope = {
      system: "claude_code",
      libraryID: LIBRARY_ID,
      kind: "global",
    };
    remember(scope, key);
    forget(scope, { expectedKey: key });
    assert.isNull(recallPersisted(scope));
    assert.equal(
      JSON.parse(String(prefStore.get(prefKey)))[String(LIBRARY_ID)],
      foreign,
    );
  });

  it("keeps a legacy unscoped Claude entry that names a different live chat when forgetting", function () {
    const key = buildDefaultClaudeGlobalConversationKey(LIBRARY_ID);
    const other = key + 1;
    const prefKey = `${config.prefsPrefix}.claudeCodeGlobalConversationMap`;
    prefStore.set(prefKey, JSON.stringify({ [String(LIBRARY_ID)]: other }));
    const scope: SelectionScope = {
      system: "claude_code",
      libraryID: LIBRARY_ID,
      kind: "global",
    };
    remember(scope, key);
    forget(scope, { expectedKey: key });
    assert.equal(recallPersisted(scope), other);
  });

  it("primes the persisted mode pref before restoring a previous one", function () {
    setLastUsedUpstreamConversationMode(LIBRARY_ID, "global");
    setLastUsedClaudeConversationMode(LIBRARY_ID, "global");
    const upstream = prime({
      system: "upstream",
      libraryID: LIBRARY_ID,
      mode: "paper",
    });
    const claude = prime({
      system: "claude_code",
      libraryID: LIBRARY_ID,
      mode: "paper",
    });
    assert.equal(getLastUsedUpstreamConversationMode(LIBRARY_ID), "paper");
    assert.equal(getLastUsedClaudeConversationMode(LIBRARY_ID), "paper");
    claude.restore();
    upstream.restore();
    assert.equal(getLastUsedUpstreamConversationMode(LIBRARY_ID), "global");
    assert.equal(getLastUsedClaudeConversationMode(LIBRARY_ID), "global");
  });
});
