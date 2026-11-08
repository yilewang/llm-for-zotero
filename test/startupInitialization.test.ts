import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import { describe, it } from "mocha";

const here = dirname(fileURLToPath(import.meta.url));

function readSource(relativePath: string): string {
  const source = readFileSync(resolve(here, relativePath), "utf8");
  // The absence checks below cannot fail against an empty or stubbed file, so
  // a moved or gutted module would read as a passing scan.
  assert.isAbove(
    source.split("\n").length,
    100,
    `${relativePath} was read but looks empty; the scan would pass vacuously`,
  );
  return source;
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

  it("starts the startup sequence in the background without awaiting it", function () {
    // Zotero awaits each plugin's startup before the next plugin's, and each
    // plugin's window-load hook before the next one's (issue #528).
    const source = readSource("../src/hooks.ts");
    const onStartupStart = source.indexOf("async function onStartup(");
    const sequenceStart = source.indexOf("async function runStartupSequence(");
    const hookStart = source.indexOf("function onMainWindowLoad(");
    const registerStart = source.indexOf("function registerMainWindow(");
    assert.isAtLeast(onStartupStart, 0);
    assert.isBelow(onStartupStart, sequenceStart);
    assert.isAtLeast(hookStart, 0);
    assert.isBelow(hookStart, registerStart);
    const onStartup = source.slice(onStartupStart, sequenceStart);
    const onMainWindowLoad = source.slice(hookStart, registerStart);

    assert.include(onStartup, "startupLifecycle.start(");
    assert.include(onStartup, "runStartupSequence");
    assert.notMatch(onStartup, /\bawait\b/);
    assert.include(onMainWindowLoad, "startupLifecycle.onMainWindowLoad(win)");
    assert.notMatch(onMainWindowLoad, /\bawait\b/);
    assert.include(
      source,
      "startupLifecycle.registerMainWindows(Zotero.getMainWindows())",
    );
  });

  it("checks isStopped() after each awaited startup phase and cleans up when stopped", function () {
    const source = readSource("../src/hooks.ts");
    const body = source.slice(
      source.indexOf("async function runStartupSequence("),
      source.indexOf("const dedicatedChatPaneDisposers"),
    );
    const guard = "if (startupLifecycle.isStopped())";
    let from = 0;
    for (const phase of [
      '"Zotero readiness"',
      '"startup preference migrations"',
      '"model capability cache"',
      "initializeConversationStoresForStartup()",
      '"paper conversation restore selections"',
      '"main window panel registration"',
    ]) {
      const at = body.indexOf(phase, from);
      assert.isAtLeast(at, 0, `${phase} missing`);
      const check = body.indexOf(guard, at);
      assert.isAbove(check, at, `no isStopped() check after ${phase}`);
      from = check + guard.length;
    }
    // The two phases that register global hooks undo them when stopped.
    for (const phase of [
      "initializeConversationStoresForStartup()",
      '"paper conversation restore selections"',
    ]) {
      const at = body.indexOf(phase);
      const check = body.indexOf(guard, at);
      const cleanup = body.indexOf("await cleanUpStoppedStartup()", check);
      assert.isAbove(cleanup, check);
      assert.isBelow(cleanup - check, 80, `no cleanup after ${phase}`);
    }
    const cleanupFn = source.slice(
      source.indexOf("async function cleanUpStoppedStartup("),
      source.indexOf("function allConversationStoresReady("),
    );
    assert.include(cleanupFn, "await shutdownPaperRestoreSelections()");
    assert.include(cleanupFn, "disposePendingDeletionSubsystem()");
    assert.include(cleanupFn, "catch");
    // Each store sub-phase is guarded, so a stopped startup configures nothing.
    const stores = source.slice(
      source.indexOf("async function initializeConversationStoresForStartup("),
      source.indexOf("async function cleanUpStoppedStartup("),
    );
    assert.isAtLeast(stores.split(guard).length - 1, 4);
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

    assert.include(source, "scheduleAgentSubsystemStartup();");
    assert.include(
      source,
      'const { getAgentApi, initAgentSubsystem } = await import("./agent");',
    );
    assert.include(source, "scheduleUserSkillsLoad();");
    assert.include(source, "scheduleWebChatRelayRegistration();");
    assert.include(source, "scheduleMineruAutoWatchRegistration();");
  });

  it("rerenders mounted conversations after the deferred agent runtime is ready", function () {
    const source = readSource("../src/hooks.ts");
    const startup = source.slice(
      source.indexOf("function scheduleAgentSubsystemStartup()"),
      source.indexOf("function scheduleUserSkillsLoad()"),
    );
    const initialized = startup.indexOf("await initAgentSubsystem();");
    const refreshImport = startup.indexOf('"./modules/contextPanel/chat"');
    const refresh = startup.indexOf("refreshActiveConversationPanels();");

    assert.isAtLeast(initialized, 0);
    assert.isAtLeast(refreshImport, 0);
    assert.isAtLeast(refresh, 0);
    assert.isBelow(initialized, refreshImport);
    assert.isBelow(refreshImport, refresh);
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
    // The Claude Code and Codex stores share one runtime store factory.
    const sources = [
      readSource("../src/utils/chatStore.ts"),
      readSource("../src/services/providers/runtimeConversationStore.ts"),
    ];

    for (const source of sources) {
      assert.include(source, "hasConversationSchemaMigration");
      assert.include(source, "CONVERSATION_ID_TRANSITION_MIGRATION_ID");
      assert.include(source, "conversationIDTransitionAlreadyApplied");
      assert.include(source, "if (!conversationIDTransitionAlreadyApplied)");
    }
    for (const runtimeStore of [
      readSource("../src/claudeCode/store.ts"),
      readSource("../src/codexAppServer/store.ts"),
    ]) {
      assert.include(runtimeStore, "createRuntimeConversationStore({");
      assert.include(runtimeStore, "return store.initStore(...args);");
    }
  });
});
