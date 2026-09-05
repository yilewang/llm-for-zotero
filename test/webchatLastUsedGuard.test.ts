import { assert } from "chai";
import {
  setLastUsedPaperConversationKey,
  getLastUsedPaperConversationKey,
  setLastUsedUpstreamGlobalConversationKey,
} from "../src/modules/contextPanel/prefHelpers";
import {
  clearAllState,
  webChatIsolatedConversationKeys,
} from "../src/modules/contextPanel/state";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
};
const originalZotero = globalScope.Zotero;

describe("webchat last-used restore-pref guard", function () {
  let prefs: Map<string, unknown>;

  beforeEach(function () {
    prefs = new Map<string, unknown>();
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => {
          prefs.set(key, value);
        },
        clear: (key: string) => {
          prefs.delete(key);
        },
      },
    };
  });

  afterEach(function () {
    clearAllState();
    globalScope.Zotero = originalZotero;
  });

  it("never persists an isolated webchat session key as any restore target", function () {
    // Paper session key space + upstream global key space.
    const webchatPaperKey = 1_500_000_082;
    const webchatGlobalKey = 2_000_000_500;
    webChatIsolatedConversationKeys.add(webchatPaperKey);
    webChatIsolatedConversationKeys.add(webchatGlobalKey);

    setLastUsedPaperConversationKey(5, 300, webchatPaperKey);
    setLastUsedUpstreamGlobalConversationKey(5, webchatGlobalKey);

    assert.isNull(
      getLastUsedPaperConversationKey(5, 300),
      "isolated webchat paper key must not become the restore pref",
    );
    assert.strictEqual(
      prefs.size,
      0,
      "no restore pref may be written for isolated keys",
    );

    // Before startup initializes the registry-backed restore service, even an
    // ordinary key remains unavailable and no legacy preference is recreated.
    // The initialized positive path is covered by paperConversationRestore.
    setLastUsedPaperConversationKey(5, 300, 300);
    assert.isNull(getLastUsedPaperConversationKey(5, 300));
    assert.strictEqual(prefs.size, 0);
  });
});
