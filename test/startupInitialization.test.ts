import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import { describe, it } from "mocha";

const here = dirname(fileURLToPath(import.meta.url));

function readSource(relativePath: string): string {
  return readFileSync(resolve(here, relativePath), "utf8");
}

describe("plugin startup initialization", function () {
  it("registers the panel and marks startup complete before deferred work", function () {
    const source = readSource("../src/hooks.ts");
    const storeInit = source.indexOf(
      "initializeConversationStoresForStartup()",
    );
    const registerPrefs = source.indexOf("registerPrefsPane();");
    const panelRegistration = source.indexOf("main window panel registration");
    const initialized = source.indexOf("addon.data.initialized = true");
    const deferred = source.indexOf(
      "scheduleDeferredStartupWork(conversationStoreReadiness)",
    );

    assert.isAtLeast(storeInit, 0);
    assert.isAtLeast(registerPrefs, 0);
    assert.isAtLeast(panelRegistration, 0);
    assert.isAtLeast(initialized, 0);
    assert.isAtLeast(deferred, 0);
    assert.isBelow(storeInit, registerPrefs);
    assert.isBelow(registerPrefs, panelRegistration);
    assert.isBelow(panelRegistration, initialized);
    assert.isBelow(initialized, deferred);
  });

  it("does not statically import optional startup subsystems", function () {
    const source = readSource("../src/hooks.ts");

    assert.notMatch(source, /from "\.\/agent";/);
    assert.notMatch(source, /from "\.\/webchat\/relayServer";/);
    assert.notMatch(source, /from "\.\/modules\/mineruAutoWatch";/);
    assert.notMatch(source, /from "\.\/modules\/mineruBatchProcessor";/);
    assert.notMatch(source, /from "\.\/utils\/attachmentRefStore";/);
    assert.notMatch(source, /from "\.\/claudeCode\/bootstrapGate";/);
  });

  it("keeps optional runtime services deferred without blocking startup", function () {
    const source = readSource("../src/hooks.ts");

    assert.include(source, "if (!shouldInitializeAgentSubsystem()) return;");
    assert.include(source, 'getStartupBoolPref("enableClaudeCodeMode")');
    assert.include(source, 'getStartupBoolPref("enableCodexAppServerMode")');
    assert.include(source, "scheduleUserSkillsLoad();");
    assert.include(source, "scheduleWebChatRelayRegistration();");
    assert.include(source, "scheduleMineruAutoWatchRegistration();");
  });
});

describe("legacy startup migrations", function () {
  it("keeps preference migrations separate from deferred cache migrations", function () {
    const source = readSource("../src/utils/migrations.ts");
    const startup = source.indexOf("runStartupPreferenceMigrations");
    const deferred = source.indexOf("runDeferredLegacyMigrations");
    const legacy = source.indexOf("runLegacyMigrations");
    const deferredBody = source.slice(deferred, legacy);

    assert.isAtLeast(startup, 0);
    assert.isAtLeast(deferred, 0);
    assert.isAtLeast(legacy, 0);
    assert.isBelow(startup, deferred);
    assert.isBelow(deferred, legacy);
    assert.include(deferredBody, "migrateMineruContentMdCleanup");
    assert.include(deferredBody, "migrateMineruManifestBuild");
  });
});

describe("conversation store startup maintenance", function () {
  it("skips repeated conversation-id maintenance after the migration ledger is applied", function () {
    const sources = [
      readSource("../src/utils/chatStore.ts"),
      readSource("../src/claudeCode/store.ts"),
      readSource("../src/codexAppServer/store.ts"),
    ];

    for (const source of sources) {
      assert.include(source, "hasConversationSchemaMigration");
      assert.include(source, "CONVERSATION_ID_TRANSITION_MIGRATION_ID");
      assert.include(source, "conversationIDTransitionAlreadyApplied");
      assert.include(source, "if (!conversationIDTransitionAlreadyApplied)");
    }
  });
});
