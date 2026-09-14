import { assert } from "chai";
import {
  createWebChatModeController,
  resolveWebChatExitModelEntryId,
  type WebChatModeControllerDeps,
} from "../src/modules/contextPanel/setupHandlers/controllers/webChatModeController";
import {
  activePaperConversationByPaper,
  chatHistory,
  loadedConversationKeys,
  webChatIsolatedConversationKeys,
} from "../src/modules/contextPanel/state";
import type { RuntimeModelEntry } from "../src/utils/modelProviders";

const API_ENTRY = {
  entryId: "api-1",
  authMode: "api_key",
} as RuntimeModelEntry;
const OTHER_API_ENTRY = {
  entryId: "api-2",
  authMode: "api_key",
} as RuntimeModelEntry;
const WEB_ENTRY = {
  entryId: "web-1",
  authMode: "webchat",
} as RuntimeModelEntry;

const WEBCHAT_KEY = 900_001;
const PAPER_STATE_KEY = "1:42";

type Harness = {
  deps: WebChatModeControllerDeps;
  calls: string[];
  selected: string[];
  composerWrites: string[];
  setComposer: (text: string) => void;
  setWebChat: (active: boolean) => void;
};

function createHarness(
  overrides: Partial<WebChatModeControllerDeps> = {},
): Harness {
  const calls: string[] = [];
  const selected: string[] = [];
  const composerWrites: string[] = [];
  let composerText = "";
  let webChatActive = true;
  let selectedEntryId: string | null = API_ENTRY.entryId;
  const item = { id: 42 } as unknown as Zotero.Item;
  const deps: WebChatModeControllerDeps = {
    getItem: () => item,
    isWebChatMode: () => webChatActive,
    getConversationKey: () => WEBCHAT_KEY,
    getAvailableModelEntries: () => [API_ENTRY, WEB_ENTRY, OTHER_API_ENTRY],
    getSelectedModelEntryId: () => selectedEntryId,
    setSelectedModelEntry: (entryId) => {
      selected.push(entryId);
      selectedEntryId = entryId;
      webChatActive = false;
      calls.push("setSelectedModelEntry");
    },
    abortPreload: () => calls.push("abortPreload"),
    removePreloadOverlay: () => calls.push("removePreloadOverlay"),
    stopConnectionCheck: () => calls.push("stopConnectionCheck"),
    clearNewChatIntent: () => calls.push("clearNewChatIntent"),
    applyWebChatModeUI: () => calls.push("applyWebChatModeUI"),
    updateModelButton: () => calls.push("updateModelButton"),
    updateReasoningButton: () => calls.push("updateReasoningButton"),
    readComposerText: () => composerText,
    writeComposerText: (text) => {
      composerWrites.push(text);
      composerText = text;
    },
    switchPaperConversation: async () => {
      calls.push("switchPaperConversation");
      composerText = "";
      return true;
    },
    refreshChatPreservingScroll: () =>
      calls.push("refreshChatPreservingScroll"),
    resetComposePreviewUI: () => calls.push("resetComposePreviewUI"),
    log: () => {},
    ...overrides,
  };
  return {
    deps,
    calls,
    selected,
    composerWrites,
    setComposer: (text) => {
      composerText = text;
    },
    setWebChat: (active) => {
      webChatActive = active;
    },
  };
}

function seedIsolatedWebChatSession(): void {
  webChatIsolatedConversationKeys.add(WEBCHAT_KEY);
  chatHistory.set(WEBCHAT_KEY, [
    { role: "user", text: "web turn", timestamp: 1 } as any,
  ]);
  loadedConversationKeys.add(WEBCHAT_KEY);
  activePaperConversationByPaper.set(PAPER_STATE_KEY, WEBCHAT_KEY);
}

describe("webChatModeController", function () {
  afterEach(function () {
    webChatIsolatedConversationKeys.delete(WEBCHAT_KEY);
    chatHistory.delete(WEBCHAT_KEY);
    loadedConversationKeys.delete(WEBCHAT_KEY);
    activePaperConversationByPaper.delete(PAPER_STATE_KEY);
  });

  describe("resolveWebChatExitModelEntryId", function () {
    it("prefers an explicit non-webchat pick over the remembered model", function () {
      assert.equal(
        resolveWebChatExitModelEntryId({
          previousEntryId: API_ENTRY.entryId,
          targetEntryId: OTHER_API_ENTRY.entryId,
          entries: [API_ENTRY, WEB_ENTRY, OTHER_API_ENTRY],
        }),
        OTHER_API_ENTRY.entryId,
      );
    });

    it("restores the remembered model when it is still configured", function () {
      assert.equal(
        resolveWebChatExitModelEntryId({
          previousEntryId: OTHER_API_ENTRY.entryId,
          entries: [API_ENTRY, WEB_ENTRY, OTHER_API_ENTRY],
        }),
        OTHER_API_ENTRY.entryId,
      );
    });

    it("falls back to the first non-webchat entry when the remembered one is gone", function () {
      assert.equal(
        resolveWebChatExitModelEntryId({
          previousEntryId: "removed",
          entries: [WEB_ENTRY, API_ENTRY],
        }),
        API_ENTRY.entryId,
      );
    });

    it("never resolves to a webchat entry", function () {
      assert.isNull(
        resolveWebChatExitModelEntryId({
          previousEntryId: WEB_ENTRY.entryId,
          targetEntryId: WEB_ENTRY.entryId,
          entries: [WEB_ENTRY],
        }),
      );
    });
  });

  describe("leaveWebChatMode", function () {
    it("restores the remembered model, drops the ephemeral session, and returns to the paper's remembered conversation", async function () {
      seedIsolatedWebChatSession();
      const harness = createHarness();
      const controller = createWebChatModeController(harness.deps);
      controller.rememberModelBeforeEnteringWebChat();

      const left = await controller.leaveWebChatMode();

      assert.isTrue(left);
      assert.deepEqual(harness.selected, [API_ENTRY.entryId]);
      assert.isFalse(webChatIsolatedConversationKeys.has(WEBCHAT_KEY));
      assert.isFalse(chatHistory.has(WEBCHAT_KEY));
      assert.isFalse(loadedConversationKeys.has(WEBCHAT_KEY));
      assert.isFalse(
        activePaperConversationByPaper.has(PAPER_STATE_KEY),
        "the hidden session row must not stay the paper's remembered conversation",
      );
      for (const teardown of [
        "abortPreload",
        "removePreloadOverlay",
        "stopConnectionCheck",
        "clearNewChatIntent",
      ]) {
        assert.equal(
          harness.calls.filter((call) => call === teardown).length,
          1,
          teardown,
        );
      }
      assert.isBelow(
        harness.calls.indexOf("applyWebChatModeUI"),
        harness.calls.indexOf("switchPaperConversation"),
        "normal chrome must be restored before the conversation switch re-renders",
      );
      assert.equal(
        harness.calls.filter((call) => call === "switchPaperConversation")
          .length,
        1,
      );
    });

    it("uses the explicitly picked API model instead of the remembered one", async function () {
      seedIsolatedWebChatSession();
      const harness = createHarness();
      const controller = createWebChatModeController(harness.deps);
      controller.rememberModelBeforeEnteringWebChat();

      await controller.leaveWebChatMode({
        targetEntryId: OTHER_API_ENTRY.entryId,
      });

      assert.deepEqual(harness.selected, [OTHER_API_ENTRY.entryId]);
    });

    it("falls back to the first API entry when nothing was remembered", async function () {
      seedIsolatedWebChatSession();
      const harness = createHarness({
        getAvailableModelEntries: () => [WEB_ENTRY, OTHER_API_ENTRY],
      });
      const controller = createWebChatModeController(harness.deps);

      await controller.leaveWebChatMode();

      assert.deepEqual(harness.selected, [OTHER_API_ENTRY.entryId]);
    });

    it("skips the conversation restore when a runtime system switch replaces the conversation", async function () {
      seedIsolatedWebChatSession();
      const harness = createHarness();
      const controller = createWebChatModeController(harness.deps);
      controller.rememberModelBeforeEnteringWebChat();

      const left = await controller.leaveWebChatMode({
        restoreConversation: false,
      });

      assert.isTrue(left);
      assert.deepEqual(harness.selected, [API_ENTRY.entryId]);
      assert.isFalse(webChatIsolatedConversationKeys.has(WEBCHAT_KEY));
      assert.isFalse(activePaperConversationByPaper.has(PAPER_STATE_KEY));
      assert.notInclude(harness.calls, "switchPaperConversation");
    });

    it("carries an unsent composer draft into the restored conversation", async function () {
      seedIsolatedWebChatSession();
      const harness = createHarness();
      harness.setComposer("question typed in webchat");
      const controller = createWebChatModeController(harness.deps);

      await controller.leaveWebChatMode();

      assert.deepEqual(harness.composerWrites, ["question typed in webchat"]);
    });

    it("does not overwrite a draft the restored conversation already has", async function () {
      seedIsolatedWebChatSession();
      const harness = createHarness({
        switchPaperConversation: async () => true,
      });
      harness.setComposer("restored conversation draft");
      const controller = createWebChatModeController(harness.deps);

      await controller.leaveWebChatMode();

      assert.deepEqual(harness.composerWrites, []);
    });

    it("leaves a normal conversation's runtime state alone when the key is not an isolated webchat session", async function () {
      chatHistory.set(WEBCHAT_KEY, [
        { role: "user", text: "api turn", timestamp: 1 } as any,
      ]);
      const harness = createHarness();
      const controller = createWebChatModeController(harness.deps);

      await controller.leaveWebChatMode();

      assert.isTrue(chatHistory.has(WEBCHAT_KEY));
    });

    it("is a no-op outside webchat mode", async function () {
      const harness = createHarness();
      harness.setWebChat(false);
      const controller = createWebChatModeController(harness.deps);

      const left = await controller.leaveWebChatMode();

      assert.isFalse(left);
      assert.deepEqual(harness.calls, []);
      assert.deepEqual(harness.selected, []);
    });
  });
});
