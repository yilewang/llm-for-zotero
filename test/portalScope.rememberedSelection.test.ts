/// <reference types="zotero-types" />

import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { config } from "../package.json";
import {
  buildDefaultClaudeGlobalConversationKey,
  buildDefaultClaudePaperConversationKey,
} from "../src/claudeCode/constants";
import { isClaudeGlobalPortalItem } from "../src/claudeCode/portal";
import {
  setLastUsedClaudeConversationMode,
  setLastUsedClaudeGlobalConversationKey,
  setLastUsedClaudePaperConversationKey,
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
import { isCodexGlobalPortalItem } from "../src/codexAppServer/portal";
import {
  setLastUsedCodexConversationMode,
  setLastUsedCodexGlobalConversationKey,
  setLastUsedCodexPaperConversationKey,
} from "../src/codexAppServer/prefs";
import {
  activeCodexConversationModeByLibrary,
  activeCodexGlobalConversationByLibrary,
  activeCodexPaperConversationByPaper,
  buildCodexLibraryStateKey,
  buildCodexPaperStateKey,
} from "../src/codexAppServer/state";
import {
  buildDefaultUpstreamGlobalConversationKey,
  GLOBAL_CONVERSATION_KEY_BASE,
} from "../src/modules/contextPanel/constants";
import {
  resolveInitialPanelItemState,
  resolvePaperConversationKeyForBaseItem,
  resolveRememberedGlobalPanelItem,
} from "../src/modules/contextPanel/portalScope";
import {
  clearStandaloneSelection,
  remember,
  rememberMode,
} from "../src/modules/contextPanel/conversationSelection";
import {
  buildPaperStateKey,
  getLastUsedUpstreamConversationMode,
  getLastUsedUpstreamGlobalConversationKey,
  setLastUsedPaperConversationKey,
  setLastUsedUpstreamConversationMode,
  setLastUsedUpstreamGlobalConversationKey,
  setLockedGlobalConversationKey,
} from "../src/modules/contextPanel/prefHelpers";
import {
  activeConversationModeByLibrary,
  activeGlobalConversationByLibrary,
  activePaperConversationByPaper,
} from "../src/modules/contextPanel/state";
import { flushPaperRestoreSelectionWrites } from "../src/shared/paperConversationRestore";
import { isGlobalPortalItem } from "../src/services/context/portalItems";
import {
  installPaperRestoreDb,
  type PaperRestoreDb,
} from "./helpers/paperRestoreDb";

/**
 * Characterization of how portalScope recalls the remembered conversation for
 * each runtime: active map first, then the persisted pref, then the runtime
 * default, plus the upstream-only lock, sentinel, and key-band policies.
 */

const PROFILE_DIR = "/tmp/llm-for-zotero-portal-selection-test";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: unknown;
};

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
}

describe("portalScope remembered selection", function () {
  const originalZotero = globalScope.Zotero;
  const prefStore = new Map<string, unknown>();
  const paperItem = {
    id: 42,
    libraryID: 7,
    parentID: undefined,
    isAttachment: () => false,
    isRegularItem: () => true,
  } as unknown as Zotero.Item;

  function installZotero(): void {
    globalScope.Zotero = {
      Profile: { dir: PROFILE_DIR },
      Items: { get: (id: number) => (id === 42 ? paperItem : null) },
      Prefs: {
        get: (key: string) => prefStore.get(key) ?? "",
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    };
  }

  function enableRuntimes(): void {
    prefStore.set(`${config.prefsPrefix}.enableClaudeCodeMode`, true);
    prefStore.set(`${config.prefsPrefix}.enableCodexAppServerMode`, true);
  }

  beforeEach(function () {
    prefStore.clear();
    clearMaps();
    installZotero();
  });

  afterEach(function () {
    clearMaps();
    globalScope.Zotero = originalZotero;
  });

  describe("global conversation key", function () {
    it("returns null for an invalid library", function () {
      assert.isNull(resolveRememberedGlobalPanelItem(0, "upstream"));
    });

    for (const system of ["claude_code", "codex"] as const) {
      const defaultKey = () =>
        system === "claude_code"
          ? buildDefaultClaudeGlobalConversationKey(7)
          : buildDefaultCodexGlobalConversationKey(7);
      const setActive = (key: number) =>
        system === "claude_code"
          ? activeClaudeGlobalConversationByLibrary.set(
              buildClaudeLibraryStateKey(7),
              key,
            )
          : activeCodexGlobalConversationByLibrary.set(
              buildCodexLibraryStateKey(7),
              key,
            );
      const setPersisted = (key: number) =>
        system === "claude_code"
          ? setLastUsedClaudeGlobalConversationKey(7, key)
          : setLastUsedCodexGlobalConversationKey(7, key);
      const isPortal =
        system === "claude_code"
          ? isClaudeGlobalPortalItem
          : isCodexGlobalPortalItem;

      it(`prefers the ${system} active map over the pref`, function () {
        setActive(defaultKey() + 2);
        setPersisted(defaultKey() + 3);
        const item = resolveRememberedGlobalPanelItem(7, system);
        assert.isTrue(isPortal(item));
        assert.equal(item?.id, defaultKey() + 2);
      });

      it(`falls back to the ${system} pref, then the default`, function () {
        setPersisted(defaultKey() + 3);
        assert.equal(
          resolveRememberedGlobalPanelItem(7, system)?.id,
          defaultKey() + 3,
        );
        prefStore.clear();
        assert.equal(
          resolveRememberedGlobalPanelItem(7, system)?.id,
          defaultKey(),
        );
      });
    }

    it("prefers the upstream lock over the active map and pref", function () {
      const base = buildDefaultUpstreamGlobalConversationKey(7);
      activeGlobalConversationByLibrary.set(7, base + 2);
      setLastUsedUpstreamGlobalConversationKey(7, base + 3);
      setLockedGlobalConversationKey(7, base + 4);
      const item = resolveRememberedGlobalPanelItem(7, "upstream");
      assert.isTrue(isGlobalPortalItem(item));
      assert.equal(item?.id, base + 4);
    });

    it("maps a locked upstream sentinel to the library default", function () {
      setLockedGlobalConversationKey(7, GLOBAL_CONVERSATION_KEY_BASE);
      assert.equal(
        resolveRememberedGlobalPanelItem(7, "upstream")?.id,
        buildDefaultUpstreamGlobalConversationKey(7),
      );
    });

    it("uses the upstream map, then the pref, then the default", function () {
      const base = buildDefaultUpstreamGlobalConversationKey(7);
      activeGlobalConversationByLibrary.set(7, base + 2);
      setLastUsedUpstreamGlobalConversationKey(7, base + 3);
      assert.equal(
        resolveRememberedGlobalPanelItem(7, "upstream")?.id,
        base + 2,
      );
      activeGlobalConversationByLibrary.clear();
      assert.equal(
        resolveRememberedGlobalPanelItem(7, "upstream")?.id,
        base + 3,
      );
      prefStore.clear();
      assert.equal(resolveRememberedGlobalPanelItem(7, "upstream")?.id, base);
    });

    it("maps an upstream sentinel map value to the library default", function () {
      activeGlobalConversationByLibrary.set(7, GLOBAL_CONVERSATION_KEY_BASE);
      assert.equal(
        resolveRememberedGlobalPanelItem(7, "upstream")?.id,
        buildDefaultUpstreamGlobalConversationKey(7),
      );
    });

    it("ignores an upstream map value outside the global key band without trying the pref", function () {
      const base = buildDefaultUpstreamGlobalConversationKey(7);
      activeGlobalConversationByLibrary.set(7, 4207);
      setLastUsedUpstreamGlobalConversationKey(7, base + 3);
      assert.equal(resolveRememberedGlobalPanelItem(7, "upstream")?.id, base);
    });
  });

  describe("library conversation mode", function () {
    it("restores Claude global mode from the pref when the map is empty", function () {
      enableRuntimes();
      setLastUsedClaudeConversationMode(7, "global");
      const resolved = resolveInitialPanelItemState(paperItem, {
        conversationSystem: "claude_code",
      });
      assert.isTrue(isClaudeGlobalPortalItem(resolved.item));
    });

    it("prefers the Claude active mode over the pref", function () {
      enableRuntimes();
      setLastUsedClaudeConversationMode(7, "global");
      activeClaudeConversationModeByLibrary.set(
        buildClaudeLibraryStateKey(7),
        "paper",
      );
      const resolved = resolveInitialPanelItemState(paperItem, {
        conversationSystem: "claude_code",
      });
      assert.isFalse(isClaudeGlobalPortalItem(resolved.item));
    });

    it("restores Codex global mode from the active map or the pref", function () {
      enableRuntimes();
      activeCodexConversationModeByLibrary.set(
        buildCodexLibraryStateKey(7),
        "global",
      );
      assert.isTrue(
        isCodexGlobalPortalItem(
          resolveInitialPanelItemState(paperItem, {
            conversationSystem: "codex",
          }).item,
        ),
      );
      activeCodexConversationModeByLibrary.clear();
      setLastUsedCodexConversationMode(7, "global");
      assert.isTrue(
        isCodexGlobalPortalItem(
          resolveInitialPanelItemState(paperItem, {
            conversationSystem: "codex",
          }).item,
        ),
      );
    });

    it("does not let an upstream lock force global mode on Claude", function () {
      enableRuntimes();
      setLockedGlobalConversationKey(
        7,
        buildDefaultUpstreamGlobalConversationKey(7),
      );
      const resolved = resolveInitialPanelItemState(paperItem, {
        conversationSystem: "claude_code",
      });
      assert.isFalse(isClaudeGlobalPortalItem(resolved.item));
    });

    it("uses the upstream pref mode when the map is empty", function () {
      setLastUsedUpstreamConversationMode(7, "global");
      assert.isTrue(
        isGlobalPortalItem(resolveInitialPanelItemState(paperItem).item),
      );
    });

    it("keeps paper mode for upstream with no remembered mode and no lock", function () {
      const resolved = resolveInitialPanelItemState(paperItem);
      assert.equal(resolved.item, paperItem);
    });
  });

  describe("per-surface selection (sidebar vs standalone window)", function () {
    it("keeps the window's Library chat out of the sidebar's", function () {
      const base = buildDefaultUpstreamGlobalConversationKey(7);
      remember(
        {
          system: "upstream",
          libraryID: 7,
          kind: "global",
          surface: "standalone",
        },
        base + 5,
      );
      assert.equal(resolveRememberedGlobalPanelItem(7, "upstream")?.id, base);
      assert.equal(
        resolveRememberedGlobalPanelItem(7, "upstream", "standalone")?.id,
        base + 5,
      );
      assert.isNull(getLastUsedUpstreamGlobalConversationKey(7));
    });

    it("opens the sidebar's Library chat in the window until the window picks one", function () {
      const base = buildDefaultUpstreamGlobalConversationKey(7);
      activeGlobalConversationByLibrary.set(7, base + 2);
      assert.equal(
        resolveRememberedGlobalPanelItem(7, "upstream", "standalone")?.id,
        base + 2,
      );
    });

    it("applies the upstream library lock to the sidebar only", function () {
      const base = buildDefaultUpstreamGlobalConversationKey(7);
      activeGlobalConversationByLibrary.set(7, base + 2);
      setLockedGlobalConversationKey(7, base + 4);
      assert.equal(
        resolveRememberedGlobalPanelItem(7, "upstream")?.id,
        base + 4,
      );
      assert.equal(
        resolveRememberedGlobalPanelItem(7, "upstream", "standalone")?.id,
        base + 2,
      );
      assert.isTrue(
        isGlobalPortalItem(resolveInitialPanelItemState(paperItem).item),
        "the sidebar follows its lock into Library chat",
      );
      assert.equal(
        resolveInitialPanelItemState(paperItem, { surface: "standalone" }).item,
        paperItem,
        "the window has no lock",
      );
    });

    it("keeps the window's Library mode out of the sidebar's mode", function () {
      rememberMode("upstream", 7, "global", { surface: "standalone" });
      assert.isNull(getLastUsedUpstreamConversationMode(7));
      assert.equal(resolveInitialPanelItemState(paperItem).item, paperItem);
      assert.isTrue(
        isGlobalPortalItem(
          resolveInitialPanelItemState(paperItem, { surface: "standalone" })
            .item,
        ),
      );
    });

    it("reads the sidebar's mode in the window until the window has its own", function () {
      setLastUsedUpstreamConversationMode(7, "global");
      assert.isTrue(
        isGlobalPortalItem(
          resolveInitialPanelItemState(paperItem, { surface: "standalone" })
            .item,
        ),
      );
      rememberMode("upstream", 7, "paper", { surface: "standalone" });
      assert.equal(
        resolveInitialPanelItemState(paperItem, { surface: "standalone" }).item,
        paperItem,
      );
      assert.isTrue(
        isGlobalPortalItem(resolveInitialPanelItemState(paperItem).item),
      );
    });

    for (const system of ["upstream", "claude_code", "codex"] as const) {
      it(`keeps the window's ${system} paper chat apart from the sidebar's`, function () {
        enableRuntimes();
        const sidebarKey =
          system === "claude_code"
            ? buildDefaultClaudePaperConversationKey(42) + 1
            : system === "codex"
              ? buildDefaultCodexPaperConversationKey(42) + 1
              : 4201;
        remember(
          { system, libraryID: 7, kind: "paper", paperItemID: 42 },
          sidebarKey,
          { persist: false },
        );
        remember(
          {
            system,
            libraryID: 7,
            kind: "paper",
            paperItemID: 42,
            surface: "standalone",
          },
          sidebarKey + 1,
        );
        assert.equal(
          resolvePaperConversationKeyForBaseItem(paperItem, system),
          sidebarKey,
        );
        assert.equal(
          resolvePaperConversationKeyForBaseItem(
            paperItem,
            system,
            "standalone",
          ),
          sidebarKey + 1,
        );
        assert.equal(
          resolveInitialPanelItemState(paperItem, {
            conversationSystem: system,
            conversationMode: "paper",
            surface: "standalone",
          }).item?.id,
          sidebarKey + 1,
        );
      });
    }
  });

  describe("paper conversation key", function () {
    let restoreDb: PaperRestoreDb | null = null;

    afterEach(async function () {
      await restoreDb?.close();
      restoreDb = null;
    });

    const cases = [
      {
        system: "upstream" as const,
        defaultKey: () => 42,
        rememberedKey: () => 4207,
        setActive: (key: number) =>
          activePaperConversationByPaper.set(buildPaperStateKey(7, 42), key),
        setPersisted: (key: number) =>
          setLastUsedPaperConversationKey(7, 42, key),
      },
      {
        system: "claude_code" as const,
        defaultKey: () => buildDefaultClaudePaperConversationKey(42),
        rememberedKey: () => buildDefaultClaudePaperConversationKey(42) + 5,
        setActive: (key: number) =>
          activeClaudePaperConversationByPaper.set(
            buildClaudePaperStateKey(7, 42),
            key,
          ),
        setPersisted: (key: number) =>
          setLastUsedClaudePaperConversationKey(7, 42, key),
      },
      {
        system: "codex" as const,
        defaultKey: () => buildDefaultCodexPaperConversationKey(42),
        rememberedKey: () => buildDefaultCodexPaperConversationKey(42) + 5,
        setActive: (key: number) =>
          activeCodexPaperConversationByPaper.set(
            buildCodexPaperStateKey(7, 42),
            key,
          ),
        setPersisted: (key: number) =>
          setLastUsedCodexPaperConversationKey(7, 42, key),
      },
    ];

    for (const testCase of cases) {
      it(`uses the ${testCase.system} map, then the restore target, then the default`, async function () {
        restoreDb = await installPaperRestoreDb({
          profileDir: PROFILE_DIR,
          prefStore,
        });
        restoreDb.addPaperConversation(
          testCase.system,
          testCase.rememberedKey(),
          7,
          42,
        );
        await restoreDb.initializeAllRuntimes();

        assert.equal(
          resolvePaperConversationKeyForBaseItem(paperItem, testCase.system),
          testCase.defaultKey(),
        );

        testCase.setPersisted(testCase.rememberedKey());
        await flushPaperRestoreSelectionWrites();
        assert.equal(
          resolvePaperConversationKeyForBaseItem(paperItem, testCase.system),
          testCase.rememberedKey(),
        );

        testCase.setActive(testCase.rememberedKey() + 1);
        assert.equal(
          resolvePaperConversationKeyForBaseItem(paperItem, testCase.system),
          testCase.rememberedKey() + 1,
        );
      });

      it(`returns the paper item ID for a negative ${testCase.system} map value without trying the restore target`, async function () {
        restoreDb = await installPaperRestoreDb({
          profileDir: PROFILE_DIR,
          prefStore,
        });
        restoreDb.addPaperConversation(
          testCase.system,
          testCase.rememberedKey(),
          7,
          42,
        );
        await restoreDb.initializeAllRuntimes();
        testCase.setPersisted(testCase.rememberedKey());
        await flushPaperRestoreSelectionWrites();
        testCase.setActive(-5);
        assert.equal(
          resolvePaperConversationKeyForBaseItem(paperItem, testCase.system),
          42,
        );
      });
    }
  });
});
