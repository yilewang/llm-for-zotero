import { initLocale } from "./utils/locale";
import { initI18n } from "./utils/i18n";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { config, PREFERENCES_PANE_ID } from "./modules/contextPanel/constants";
import {
  registerReaderContextPanel,
  registerLLMStyles,
  registerNoteEditingSelectionTracking,
  registerReaderSelectionTracking,
  unregisterAllNoteEditingSelectionTracking,
  unregisterNoteEditingSelectionTracking,
  unregisterReaderSelectionTracking,
  openStandaloneChat,
} from "./modules/contextPanel";
import { resolveActiveLibraryID } from "./modules/contextPanel/portalScope";
import { zoteroChangeDispatcher } from "./services/zoteroChangeDispatcher";
import { registerZoteroItemContextMenu } from "./modules/contextPanel/zoteroItemContextMenu";
import { initChatStore } from "./utils/chatStore";
import { initClaudeCodeStore } from "./claudeCode/store";
import { initCodexAppServerStore } from "./codexAppServer/store";
import { pendingDeletionStore } from "./core/conversations/pendingDeletionStore";
import { configurePendingDeletionSubsystem } from "./modules/contextPanel/pendingDeletionWiring";
import {
  runDeferredLegacyMigrations,
  runStartupPreferenceMigrations,
} from "./utils/migrations";
import { createZToolkit } from "./utils/ztoolkit";
import { clearAllState, initFontScale } from "./modules/contextPanel/state";
import { clearQueuedFollowUpState } from "./modules/contextPanel/queuedFollowUps";
import { closeAllAddonDialogs } from "./utils/dialogRegistry";
import {
  initializePaperRestoreSelections,
  shutdownPaperRestoreSelections,
} from "./shared/paperConversationRestore";
import {
  registerPaperConversationRestoreNotifications,
  unregisterPaperConversationRestoreNotifications,
} from "./services/paperConversationRestoreNotifications";

type ConversationStoreReadiness = {
  chatStoreReady: boolean;
  claudeStoreReady: boolean;
  codexStoreReady: boolean;
  pendingDeletionReady: boolean;
};

let startupUserSkillsLoadTask: Promise<void> | null = null;

function getStartupPrefKey(key: string): string {
  return `${config.prefsPrefix}.${key}`;
}

function getStartupBoolPref(key: string, defaultValue = false): boolean {
  const value = Zotero.Prefs.get(getStartupPrefKey(key), true);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return defaultValue;
}

async function measureStartupPhase<T>(
  label: string,
  task: () => Promise<T> | T,
): Promise<T> {
  const start = Date.now();
  try {
    return await task();
  } finally {
    ztoolkit.log(`LLM startup: ${label} completed in ${Date.now() - start}ms`);
  }
}

function runDeferredStartupTask(
  label: string,
  task: () => Promise<void> | void,
): void {
  void (async () => {
    const start = Date.now();
    try {
      await task();
      ztoolkit.log(
        `LLM startup deferred: ${label} completed in ${Date.now() - start}ms`,
      );
    } catch (err) {
      ztoolkit.log(`LLM: Deferred startup task failed: ${label}`, err);
    }
  })();
}

async function ensureStartupUserSkillsLoaded(): Promise<void> {
  if (!startupUserSkillsLoadTask) {
    startupUserSkillsLoadTask = (async () => {
      const { initUserSkills, loadUserSkills } =
        await import("./agent/skills/userSkills");
      const { setUserSkills } = await import("./agent/skills");
      await initUserSkills();
      setUserSkills(await loadUserSkills());
    })();
  }
  await startupUserSkillsLoadTask;
}

async function initializeConversationStoresForStartup(): Promise<ConversationStoreReadiness> {
  const readiness: ConversationStoreReadiness = {
    chatStoreReady: false,
    claudeStoreReady: false,
    codexStoreReady: false,
    pendingDeletionReady: false,
  };

  try {
    await measureStartupPhase("upstream chat store", initChatStore);
    readiness.chatStoreReady = true;
  } catch (err) {
    ztoolkit.log("LLM: Failed to initialize chat store", err);
  }
  try {
    await measureStartupPhase("Claude Code store", initClaudeCodeStore);
    readiness.claudeStoreReady = true;
  } catch (err) {
    ztoolkit.log("LLM: Failed to initialize Claude Code store", err);
  }
  try {
    await measureStartupPhase(
      "Codex App Server store",
      initCodexAppServerStore,
    );
    readiness.codexStoreReady = true;
  } catch (err) {
    ztoolkit.log("LLM: Failed to initialize Codex App Server store", err);
  }
  try {
    await measureStartupPhase("pending deletion store", async () => {
      configurePendingDeletionSubsystem();
      await pendingDeletionStore.init();
      // Load durable deletion intents before any panel/window can mount. This
      // re-establishes the process-local write fence synchronously on restart,
      // so a user cannot send into a conversation while its persisted delete
      // intent is still waiting for the deferred startup sweep.  Finalization
      // stays deferred: it does destructive local work and provider cleanup,
      // and must not be able to delay or block the UI.
      await pendingDeletionStore.loadPersistedFence();
      readiness.pendingDeletionReady = true;
    });
  } catch (err) {
    ztoolkit.log("LLM: Failed to initialize pending deletion store", err);
  }

  return readiness;
}

function allConversationStoresReady(
  readiness: ConversationStoreReadiness,
): boolean {
  return (
    readiness.chatStoreReady &&
    readiness.claudeStoreReady &&
    readiness.codexStoreReady &&
    readiness.pendingDeletionReady
  );
}

function scheduleConversationMaintenance(
  readiness: ConversationStoreReadiness,
): void {
  if (!allConversationStoresReady(readiness)) return;

  runDeferredStartupTask("conversation catalog maintenance", async () => {
    const { repairConversationCatalogSummaries } =
      await import("./shared/conversationIntegrity");
    const { markConversationIDTransitionMigrationApplied } =
      await import("./shared/conversationSchemaMigrations");
    await repairConversationCatalogSummaries();
    await markConversationIDTransitionMigrationApplied();
  });

  runDeferredStartupTask("conversation search index refresh", async () => {
    const { refreshConversationSearchIndex } =
      await import("./shared/conversationSearchIndex");
    await refreshConversationSearchIndex();
  });
}

function scheduleConversationIntegrityAudit(): void {
  runDeferredStartupTask("conversation integrity audit", async () => {
    const { auditConversationIntegrity } =
      await import("./shared/conversationIntegrity");
    const report = await auditConversationIntegrity();
    if (!report.ok) {
      ztoolkit.log(
        "LLM: Conversation history integrity audit found issues",
        report,
      );
    }
    // Migration quarantines conflicting identities but nothing read that table
    // back, so a conversation that landed there was neither deleted nor
    // reachable and left no signal. Summarize it so a user reporting a
    // vanished conversation has something actionable in the log.
    const { logConversationKeyQuarantineSummary } =
      await import("./shared/conversationKeyLedger");
    const quarantined = await logConversationKeyQuarantineSummary();
    if (quarantined) {
      ztoolkit.log(
        `LLM: ${quarantined} conversation identity conflict(s) are quarantined; see the ledger log entry for keys and reasons`,
      );
    }
  });
}

function scheduleClaudeProjectBootstrapIfEnabled(): void {
  if (!getStartupBoolPref("enableClaudeCodeMode")) return;
  runDeferredStartupTask("Claude project bootstrap", async () => {
    const { ensureClaudeProjectBootstrapIfEnabled } =
      await import("./claudeCode/bootstrapGate");
    await ensureClaudeProjectBootstrapIfEnabled();
  });
}

function scheduleAgentSubsystemStartup(): void {
  runDeferredStartupTask("agent subsystem", async () => {
    const { getAgentApi, initAgentSubsystem } = await import("./agent");
    await initAgentSubsystem();
    addon.api.agent = getAgentApi();
    const { refreshAllActiveConversationPanels } =
      await import("./modules/contextPanel/chat");
    refreshAllActiveConversationPanels();
    await ensureStartupUserSkillsLoaded();
  });
}

function scheduleUserSkillsLoad(): void {
  runDeferredStartupTask("user skills", async () => {
    await ensureStartupUserSkillsLoaded();
  });
}

function scheduleAttachmentMaintenance(): void {
  runDeferredStartupTask("attachment reference maintenance", async () => {
    const {
      ATTACHMENT_GC_MIN_AGE_MS,
      collectAndDeleteUnreferencedBlobs,
      initAttachmentRefStore,
      reconcileNoteAttachmentRefsFromNoteContent,
    } = await import("./utils/attachmentRefStore");
    await initAttachmentRefStore();
    await reconcileNoteAttachmentRefsFromNoteContent();
    await collectAndDeleteUnreferencedBlobs(ATTACHMENT_GC_MIN_AGE_MS);
  });
}

function scheduleWebChatRelayRegistration(): void {
  runDeferredStartupTask("webchat relay registration", async () => {
    const { registerWebChatRelay } = await import("./webchat/relayServer");
    registerWebChatRelay();
  });
}

function scheduleMineruAutoWatchRegistration(): void {
  runDeferredStartupTask("MinerU auto-watch", async () => {
    const { startAutoWatch } = await import("./modules/mineruAutoWatch");
    startAutoWatch();
  });
}

function scheduleModelCapabilityRefresh(): void {
  if (__env__ === "test") return;
  runDeferredStartupTask("model capability registry", async () => {
    const { refreshModelCapabilityRegistry } =
      await import("./modelCapabilities");
    await refreshModelCapabilityRegistry();
  });
  runDeferredStartupTask("provider model catalogs", async () => {
    const { refreshConfiguredProviderModelCatalogs } =
      await import("./utils/modelProviders");
    await refreshConfiguredProviderModelCatalogs();
  });
}

function scheduleDeferredStartupWork(
  readiness: ConversationStoreReadiness,
): void {
  runDeferredStartupTask(
    "legacy cache migrations",
    runDeferredLegacyMigrations,
  );
  // Finalize intents whose Undo window elapsed while Zotero was closed. The
  // fence itself was already re-established during blocking startup; this is
  // only the destructive/provider half, so it stays off the critical path.
  runDeferredStartupTask("pending deletion sweep", async () => {
    await pendingDeletionStore.sweepAllPersisted("startup-sweep");
  });
  scheduleConversationMaintenance(readiness);
  scheduleConversationIntegrityAudit();
  scheduleClaudeProjectBootstrapIfEnabled();
  scheduleAgentSubsystemStartup();
  scheduleUserSkillsLoad();
  scheduleAttachmentMaintenance();
  scheduleWebChatRelayRegistration();
  scheduleMineruAutoWatchRegistration();
  scheduleModelCapabilityRefresh();
}

async function onStartup() {
  await measureStartupPhase("Zotero readiness", () =>
    Promise.all([
      Zotero.initializationPromise,
      Zotero.unlockPromise,
      Zotero.uiReadyPromise,
    ]),
  );

  try {
    await measureStartupPhase("startup preference migrations", () => {
      runStartupPreferenceMigrations();
    });
  } catch (err) {
    ztoolkit.log("LLM: Failed to run legacy migration", err);
  }

  initLocale();
  initI18n();
  initFontScale();

  const conversationStoreReadiness =
    await initializeConversationStoresForStartup();

  await measureStartupPhase("paper conversation restore selections", () =>
    initializePaperRestoreSelections(conversationStoreReadiness),
  );
  registerPaperConversationRestoreNotifications();

  // A durable deletion intent that was not loaded is an active write fence,
  // but it must NOT abort startup. Throwing here skipped the preferences pane
  // and every window, leaving the user with no plugin at all and no way to
  // recover from the UI, over a failure in the least essential subsystem. The
  // three conversation stores above already degrade rather than abort; this
  // one now behaves the same way. The store retries the load on first write,
  // so a transient database error self-heals instead of persisting.
  if (!conversationStoreReadiness.pendingDeletionReady) {
    ztoolkit.log(
      "LLM: pending deletion fence not loaded at startup; will retry before the next conversation write",
    );
  }

  registerPrefsPane();

  await measureStartupPhase("main window panel registration", () =>
    Promise.all(Zotero.getMainWindows().map((win) => onMainWindowLoad(win))),
  );

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  if (__env__ === "test" || __env__ === "development") {
    const { installWorkflowTestHarness } =
      await import("./modules/contextPanel/workflowTestHarness");
    installWorkflowTestHarness(addon);
  }
  addon.data.initialized = true;

  scheduleDeferredStartupWork(conversationStoreReadiness);
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  registerLLMStyles(win);
  registerReaderContextPanel();
  registerReaderSelectionTracking();
  registerNoteEditingSelectionTracking(win);
  registerZoteroItemContextMenu({
    ztoolkit,
    getSelectedItems: () => {
      try {
        const pane = Zotero.getActiveZoteroPane?.() as
          | { getSelectedItems?: () => Zotero.Item[] }
          | undefined;
        const activeItems = pane?.getSelectedItems?.();
        if (Array.isArray(activeItems)) return activeItems;
      } catch {
        void 0;
      }
      try {
        const pane = (
          win as unknown as {
            ZoteroPane?: { getSelectedItems?: () => Zotero.Item[] };
          }
        ).ZoteroPane;
        const selectedItems = pane?.getSelectedItems?.();
        return Array.isArray(selectedItems) ? selectedItems : [];
      } catch {
        return [];
      }
    },
    openStandaloneChat: (options) => {
      openStandaloneChat({ initialItem: options?.initialItem || null });
    },
  });

  // Keyboard shortcut: Ctrl/Cmd+Shift+L
  const doc = win.document;
  const keyset = doc.getElementById("mainKeyset");
  if (keyset) {
    const key = doc.createXULElement("key");
    key.id = "llmforzotero-key-standalone";
    key.setAttribute("modifiers", "accel,shift");
    key.setAttribute("key", "L");
    key.setAttribute("oncommand", "void(0)");
    key.addEventListener("command", () => {
      let initialItem: Zotero.Item | null = null;
      try {
        const pane = Zotero.getActiveZoteroPane?.() as
          | { getSelectedItems?: () => Zotero.Item[] }
          | undefined;
        initialItem = pane?.getSelectedItems?.()?.[0] || null;
      } catch {
        void 0;
      }
      if (!initialItem && resolveActiveLibraryID()) {
        openStandaloneChat();
        return;
      }
      openStandaloneChat({ initialItem });
    });
    keyset.appendChild(key);
  }
}

function registerPrefsPane() {
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    id: PREFERENCES_PANE_ID,
    src: `chrome://${addon.data.config.addonRef}/content/preferences.xhtml`,
    label: "llm-for-zotero",
    image: `chrome://${addon.data.config.addonRef}/content/icons/icon.svg`,
  });
}

async function onMainWindowUnload(win: Window): Promise<void> {
  unregisterNoteEditingSelectionTracking(win);
  ztoolkit.unregisterAll();
  closeAllAddonDialogs();
  addon.data.standaloneWindow?.close();
  win.document.getElementById("llmforzotero-open-standalone")?.remove();
  win.document.getElementById("llmforzotero-key-standalone")?.remove();
}

async function onShutdown(): Promise<void> {
  unregisterPaperConversationRestoreNotifications();
  await shutdownPaperRestoreSelections();
  ztoolkit.unregisterAll();
  unregisterReaderSelectionTracking();
  unregisterAllNoteEditingSelectionTracking();
  closeAllAddonDialogs();
  addon.data.standaloneWindow?.close();
  try {
    const { unregisterWebChatRelay } = require("./webchat/relayServer");
    unregisterWebChatRelay();
  } catch {
    /* ignore if module not loaded */
  }
  try {
    const { pauseBatchProcessing } = require("./modules/mineruBatchProcessor");
    pauseBatchProcessing();
  } catch {
    /* ignore if module not loaded */
  }
  try {
    const { stopAutoWatch } = require("./modules/mineruAutoWatch");
    stopAutoWatch();
  } catch {
    /* ignore if module not loaded */
  }
  try {
    const { shutdownAgentSubsystem } = require("./agent");
    shutdownAgentSubsystem();
  } catch {
    /* ignore if module not loaded */
  }
  clearQueuedFollowUpState();
  clearAllState();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

/**
 * This function is just an example of dispatcher for Notify events.
 * Any operations should be placed in a function to keep this funcion clear.
 */
export async function flushPaperSearchInvalidationForTests(): Promise<void> {
  await zoteroChangeDispatcher.flush();
}

async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  await zoteroChangeDispatcher.dispatch({ event, type, ids, extraData });
  // You can add your code to the corresponding notify type
  ztoolkit.log("notify", event, type, ids, extraData);
  return;
}

/**
 * This function is just an example of dispatcher for Preference UI events.
 * Any operations should be placed in a function to keep this funcion clear.
 * @param type event type
 * @param data event data
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

function onDialogEvents(_type: string) {
  return;
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onDialogEvents,
};
