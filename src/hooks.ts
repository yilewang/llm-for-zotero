import { appLogger } from "./core/logging";
import {
  createStartupLifecycle,
  waitWithTimeout,
  watchStartupPhase,
} from "./core/startupLifecycle";
import { initLocale } from "./utils/locale";
import { initI18n } from "./utils/i18n";
import { initializeModelCapabilityRegistry } from "./modelCapabilities";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { config, PREFERENCES_PANE_ID } from "./modules/contextPanel/constants";
import {
  registerReaderContextPanel,
  unregisterReaderContextPanel,
  registerLLMStyles,
  unregisterLLMStyles,
  registerNoteEditingSelectionTracking,
  registerReaderSelectionTracking,
  unregisterAllNoteEditingSelectionTracking,
  unregisterNoteEditingSelectionTracking,
  unregisterReaderSelectionTracking,
  openStandaloneChat,
  getStandaloneActivePaperItemID,
} from "./modules/contextPanel";
import { composeHostSurfaces } from "./modules/contextPanel/hostSurfaces";
import { composePanelSurfaces } from "./modules/contextPanel/panelSurfaces";
import { installDedicatedChatPane } from "./modules/contextPanel/dedicatedChatPane";
import { resolveActiveLibraryID } from "./utils/zoteroLibraryScope";
import { zoteroChangeDispatcher } from "./services/zoteroChangeDispatcher";
import { registerZoteroItemContextMenu } from "./modules/contextPanel/zoteroItemContextMenu";
import { initChatStore } from "./utils/chatStore";
import { initUsageStore } from "./utils/usageStore";
import { initClaudeCodeStore } from "./claudeCode/store";
import { initCodexAppServerStore } from "./codexAppServer/store";
import { pendingDeletionStore } from "./core/conversations/pendingDeletionStore";
import {
  configurePendingDeletionSubsystem,
  disposePendingDeletionSubsystem,
} from "./modules/contextPanel/pendingDeletionWiring";
import {
  runDeferredLegacyMigrations,
  runStartupPreferenceMigrations,
} from "./utils/migrations";
import { disposeAppLogging } from "./utils/ztoolkit";
import {
  activeContextPanels,
  unregisterContextPanel,
  clearAllState,
  initFontScale,
} from "./modules/contextPanel/state";
import { disposeSetupHandlers } from "./modules/contextPanel/setupHandlers";
import { clearQueuedFollowUpState } from "./modules/contextPanel/queuedFollowUps";
import { closeAllAddonDialogs } from "./utils/dialogRegistry";
import { closeAllTornChatWindows } from "./modules/contextPanel/tornChatWindows";
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

/** Passed by addon/bootstrap.js; isUpgrade is true for an in-place update. */
type PluginLifecycleReason = { isUpgrade?: boolean };

const STANDALONE_SHORTCUT_KEY_ID = "llmforzotero-key-standalone";
// Zotero waits for shutdown before it loads an update, so a Codex child that
// never exits must not hold the update back. Matches the bridge's stop bound.
const CODEX_SHUTDOWN_TIMEOUT_MS = 4_000;
// Shutdown waits this long for an unfinished startup sequence before teardown,
// with the same bound as the Codex stop, so a stuck store cannot hold back an
// update or a disable.
const STARTUP_SHUTDOWN_WAIT_MS = 4_000;
// A startup phase that runs longer than this is named in a warning, so a
// startup that never finishes can be traced to its phase.
const STARTUP_PHASE_WATCHDOG_MS = 15_000;

let startupUserSkillsLoadTask: Promise<void> | null = null;
let disposeHostSurfaces: (() => void) | null = null;
let disposePanelSurfaces: (() => void) | null = null;

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
    return await watchStartupPhase(label, task, {
      trace: (message) => Zotero.debug(message),
      onSlow: (elapsedMs) =>
        appLogger.warn(
          `LLM startup: ${label} has not finished after ${elapsedMs}ms`,
        ),
      slowAfterMs: STARTUP_PHASE_WATCHDOG_MS,
    });
  } finally {
    appLogger.info(
      `LLM startup: ${label} completed in ${Date.now() - start}ms`,
    );
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
      appLogger.info(
        `LLM startup deferred: ${label} completed in ${Date.now() - start}ms`,
      );
    } catch (err) {
      appLogger.warn(`LLM: Deferred startup task failed: ${label}`, err);
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
    appLogger.warn("LLM: Failed to initialize chat store", err);
  }
  if (startupLifecycle.isStopped()) return readiness;
  try {
    // The local usage ledger is a reporting surface, never a gate: a failure
    // here must not hold back conversation readiness.
    await measureStartupPhase("usage store", initUsageStore);
  } catch (err) {
    appLogger.warn("LLM: Failed to initialize usage store", err);
  }
  if (startupLifecycle.isStopped()) return readiness;
  try {
    await measureStartupPhase("Claude Code store", initClaudeCodeStore);
    readiness.claudeStoreReady = true;
  } catch (err) {
    appLogger.warn("LLM: Failed to initialize Claude Code store", err);
  }
  if (startupLifecycle.isStopped()) return readiness;
  try {
    await measureStartupPhase(
      "Codex App Server store",
      initCodexAppServerStore,
    );
    readiness.codexStoreReady = true;
  } catch (err) {
    appLogger.warn("LLM: Failed to initialize Codex App Server store", err);
  }
  if (startupLifecycle.isStopped()) return readiness;
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
    appLogger.warn("LLM: Failed to initialize pending deletion store", err);
  }

  return readiness;
}

/**
 * Undoes what a startup phase that was still running at shutdown may have
 * registered after teardown found nothing to undo. Both steps are idempotent.
 */
async function cleanUpStoppedStartup(): Promise<void> {
  try {
    await shutdownPaperRestoreSelections();
  } catch (err) {
    appLogger.debug("LLM: cleanup of stopped startup failed", err);
  }
  try {
    disposePendingDeletionSubsystem();
  } catch (err) {
    appLogger.debug("LLM: cleanup of stopped startup failed", err);
  }
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

  // The ledger only started recording when the Usage tab shipped, so rebuild
  // the part of the history the database can still prove. Deferred and
  // marker-guarded: it runs once per profile, never delays readiness, and a
  // failure leaves the marker unwritten so the next start can retry.
  runDeferredStartupTask("usage history backfill", async () => {
    const { backfillUsageHistory } =
      await import("./utils/usageHistoryBackfill");
    const result = await backfillUsageHistory();
    if (result.applied) {
      appLogger.info(
        `LLM: Usage ledger backfilled ${result.rows} estimated turn(s) from ${result.conversations} conversation(s)`,
      );
    }
  });

  // The first backfill could not estimate output tokens at all, and the text
  // only upgrade that followed left a thinking model's hidden reasoning
  // uncounted. This pass RECOMPUTES every reconstructed row from the stored
  // answer and reasoning, so any profile state converges on the same number.
  // It waits for the pass above internally, so these two deferred tasks cannot
  // race, and on a profile that never ran the first pass it correctly finds
  // nothing to do.
  runDeferredStartupTask("usage history output estimate", async () => {
    const { backfillUsageHistoryOutputTokens } =
      await import("./utils/usageHistoryBackfill");
    const result = await backfillUsageHistoryOutputTokens();
    if (result.applied && result.rowsUpdated > 0) {
      appLogger.info(
        `LLM: Usage ledger estimated output tokens for ${result.rowsUpdated} backfilled turn(s) across ${result.conversations} conversation(s)`,
      );
    }
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
      appLogger.warn(
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
      appLogger.warn(
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

function scheduleClaudeBridgeLifecycle(): void {
  runDeferredStartupTask("Claude Code bridge", async () => {
    const [{ installClaudeBridgeLifecycle }, { isClaudeCodeModeEnabled }] =
      await Promise.all([
        import("./claudeCode/bridgeProcess"),
        import("./claudeCode/prefs"),
      ]);
    installClaudeBridgeLifecycle({
      prefsPrefix: config.prefsPrefix,
      isClaudeCodeModeEnabled,
    });
  });
}

function scheduleAgentSubsystemStartup(): void {
  runDeferredStartupTask("agent subsystem", async () => {
    const { getAgentApi, initAgentSubsystem } = await import("./agent");
    await initAgentSubsystem();
    addon.api.agent = getAgentApi();
    const { refreshActiveConversationPanels } =
      await import("./modules/contextPanel/chat");
    refreshActiveConversationPanels();
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

function scheduleLibraryTextIndexStartup(): void {
  runDeferredStartupTask("library text index", async () => {
    const { startLibraryTextIndex } =
      await import("./services/libraryTextIndex");
    await startLibraryTextIndex();
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
  scheduleClaudeBridgeLifecycle();
  scheduleAgentSubsystemStartup();
  scheduleUserSkillsLoad();
  scheduleAttachmentMaintenance();
  scheduleWebChatRelayRegistration();
  scheduleMineruAutoWatchRegistration();
  scheduleLibraryTextIndexStartup();
  scheduleModelCapabilityRefresh();
}

/**
 * Removes every element the plugin adds to a main window's document. Zotero
 * applies an update in the running window, so whatever is left here would
 * keep the old version's CSS and listeners alive next to the new version.
 */
function removePluginWindowDom(win: Window): void {
  const doc = win.document;
  unregisterLLMStyles(doc);
  removeMainWindowFtlLinks(doc);
  // Old versions added this element; nothing creates it any more.
  doc.getElementById("llmforzotero-open-standalone")?.remove();
  doc
    .querySelectorAll(`[id="${STANDALONE_SHORTCUT_KEY_ID}"]`)
    .forEach((el: Element) => el.remove());
}

function removeMainWindowFtlLinks(doc: Document): void {
  const href = `${addon.data.config.addonRef}-mainWindow.ftl`;
  doc
    .querySelectorAll(`link[rel="localization"][href="${href}"]`)
    .forEach((el: Element) => el.remove());
}

/**
 * An update closes the standalone window with the old version. The old
 * shutdown leaves a marker on the Zotero object, which survives the plugin
 * scope swap but not a Zotero restart, so a failed install cannot reopen the
 * window on a later launch. The marker is deleted before the window opens.
 */
const REOPEN_STANDALONE_MARKER = "__llmForZoteroReopenStandalone";
type ReopenStandaloneMarker = { initialItemID: number | null };

function reopenStandaloneAfterUpdate(): void {
  const host = Zotero as unknown as Record<
    string,
    ReopenStandaloneMarker | undefined
  >;
  const marker = host[REOPEN_STANDALONE_MARKER];
  delete host[REOPEN_STANDALONE_MARKER];
  if (!marker) return;
  try {
    const item = marker.initialItemID
      ? Zotero.Items.get(marker.initialItemID) || null
      : null;
    openStandaloneChat(item ? { initialItem: item } : undefined);
  } catch (err) {
    appLogger.warn(
      "LLM: Failed to reopen the standalone window after update",
      err,
    );
  }
}

const startupLifecycle = createStartupLifecycle<_ZoteroTypes.MainWindow>({
  registerWindow: registerMainWindow,
  reportError: reportStartupError,
});

function reportStartupError(
  error: unknown,
  context: { cancelled: boolean; phase: "startup" | "window" },
): void {
  // Teardown disposes the host surfaces, so a step left running by shutdown
  // may throw for that reason alone.
  if (context.cancelled) {
    appLogger.debug("LLM: startup step failed after shutdown began", error);
    return;
  }
  appLogger.error(
    context.phase === "window"
      ? "LLM: main window registration failed"
      : "LLM: startup failed",
    error,
  );
  Zotero.logError(error instanceof Error ? error : new Error(String(error)));
}

async function onStartup(_reason: PluginLifecycleReason = {}) {
  // Host surface composition comes first. Services and agent code reach
  // panel-owned capabilities through bridges that throw when nothing is
  // configured, so every later startup step - stores, the MCP server, any
  // agent path - must run against a composed surface.
  disposeHostSurfaces = composeHostSurfaces();
  // The panel's own internal bridges compose the same way, right after, so a
  // panel mounted by any later startup step already has them.
  disposePanelSurfaces = composePanelSurfaces();

  // Zotero starts the next plugin only after this hook settles, so the
  // sequence runs in the background (issue #528).
  startupLifecycle.start(runStartupSequence);
}

/**
 * Today's startup steps, in order. Each check of isStopped() follows an
 * awaited phase or precedes a step that registers something: a cancelled or
 * failed startup must register nothing more.
 */
async function runStartupSequence(): Promise<void> {
  await measureStartupPhase("Zotero readiness", () =>
    Promise.all([
      Zotero.initializationPromise,
      Zotero.unlockPromise,
      Zotero.uiReadyPromise,
    ]),
  );
  if (startupLifecycle.isStopped()) return;

  zoteroChangeDispatcher.registerNativeObserver();

  try {
    await measureStartupPhase("startup preference migrations", () => {
      runStartupPreferenceMigrations();
    });
  } catch (err) {
    appLogger.warn("LLM: Failed to run legacy migration", err);
  }
  if (startupLifecycle.isStopped()) return;

  initLocale();
  initI18n();
  initFontScale();

  await measureStartupPhase(
    "model capability cache",
    initializeModelCapabilityRegistry,
  );
  if (startupLifecycle.isStopped()) return;

  const conversationStoreReadiness =
    await initializeConversationStoresForStartup();
  if (startupLifecycle.isStopped()) {
    await cleanUpStoppedStartup();
    return;
  }

  await measureStartupPhase("paper conversation restore selections", () =>
    initializePaperRestoreSelections(conversationStoreReadiness),
  );
  if (startupLifecycle.isStopped()) {
    await cleanUpStoppedStartup();
    return;
  }
  registerPaperConversationRestoreNotifications();

  // A durable deletion intent that was not loaded is an active write fence,
  // but it must NOT abort startup. Throwing here skipped the preferences pane
  // and every window, leaving the user with no plugin at all and no way to
  // recover from the UI, over a failure in the least essential subsystem. The
  // three conversation stores above already degrade rather than abort; this
  // one now behaves the same way. The store retries the load on first write,
  // so a transient database error self-heals instead of persisting.
  if (!conversationStoreReadiness.pendingDeletionReady) {
    appLogger.warn(
      "LLM: pending deletion fence not loaded at startup; will retry before the next conversation write",
    );
  }

  registerPrefsPane();

  // Zotero may already call onMainWindowLoad while this sequence runs. The
  // hook registers nothing until this snapshot; the snapshot covers every
  // window open now, and the hook covers every window after it.
  await measureStartupPhase("main window panel registration", () =>
    startupLifecycle.registerMainWindows(Zotero.getMainWindows()),
  );
  if (startupLifecycle.isStopped()) return;

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  if (__env__ === "test" || __env__ === "development") {
    const { installWorkflowTestHarness } =
      await import("./modules/contextPanel/workflowTestHarness");
    if (startupLifecycle.isStopped()) return;
    installWorkflowTestHarness(addon);
  }
  // After the windows: the standalone window mounts against a main window.
  reopenStandaloneAfterUpdate();
  addon.data.initialized = true;

  // Compiled out of normal builds. Only the explicit manual behavior runner
  // supplies this request; this is not part of startup or release validation.
  if (__env__ === "development" && __behaviorSuiteRequest__) {
    void import("../test-behavior/run")
      .then(({ runBehaviorSuite }) =>
        runBehaviorSuite(__behaviorSuiteRequest__),
      )
      .catch((error) => Zotero.logError(error));
  }

  scheduleDeferredStartupWork(conversationStoreReadiness);
}

const dedicatedChatPaneDisposers = new Map<Window, () => void>();

// Zotero awaits this hook before it calls the next plugin's, so it must not
// wait for the startup sequence.
async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  startupLifecycle.onMainWindowLoad(win);
}

function registerMainWindow(win: _ZoteroTypes.MainWindow): void {
  // insertFTLIfNeeded keeps an existing link, and after an in-place update
  // that link belongs to the previous version.
  removeMainWindowFtlLinks(win.document);
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  registerLLMStyles(win);
  registerReaderContextPanel();
  dedicatedChatPaneDisposers.get(win)?.();
  dedicatedChatPaneDisposers.set(
    win,
    installDedicatedChatPane(win.document, Zotero.Notifier),
  );
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
    // A key left by the previous version would still run its old listener.
    doc
      .querySelectorAll(`[id="${STANDALONE_SHORTCUT_KEY_ID}"]`)
      .forEach((el: Element) => el.remove());
    const key = doc.createXULElement("key");
    key.id = STANDALONE_SHORTCUT_KEY_ID;
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
  startupLifecycle.onMainWindowUnload(win as _ZoteroTypes.MainWindow);
  for (const [body] of activeContextPanels) {
    if (body.ownerDocument !== win.document) continue;
    disposeSetupHandlers(body);
    unregisterContextPanel(body);
  }
  dedicatedChatPaneDisposers.get(win)?.();
  dedicatedChatPaneDisposers.delete(win);
  unregisterNoteEditingSelectionTracking(win);
  closeAllAddonDialogs();
  addon.data.standaloneWindow?.close();
  closeAllTornChatWindows();
  removePluginWindowDom(win);
}

async function runShutdownStep(
  label: string,
  step: () => unknown,
): Promise<void> {
  try {
    await step();
  } catch (error) {
    appLogger.warn(`LLM: shutdown step failed: ${label}`, error);
  }
}

async function onShutdown(reason: PluginLifecycleReason = {}): Promise<void> {
  try {
    await shutdownPlugin(reason);
  } finally {
    // Always retire this object, even after a failed step. src/index.ts
    // reuses an object it finds alive, so the next load would run these old
    // hooks. Delete the global only while it is still this object.
    addon.data.alive = false;
    const instanceKey = addon.data.config.addonInstance;
    // @ts-expect-error - Plugin instance is not typed
    if (Zotero[instanceKey] === addon) delete Zotero[instanceKey];
  }
}

async function shutdownPlugin(reason: PluginLifecycleReason): Promise<void> {
  // An unfinished startup stops at its next check. A step stuck in a database
  // call may outlive teardown; the sequence then undoes what that step
  // registered (cleanUpStoppedStartup) and registers nothing more.
  const startupSettled = await startupLifecycle.cancelAndWait(
    STARTUP_SHUTDOWN_WAIT_MS,
  );
  if (!startupSettled) {
    appLogger.warn(
      `LLM: startup did not stop in ${STARTUP_SHUTDOWN_WAIT_MS}ms; continuing shutdown`,
    );
  }
  // Each step is isolated: one failure must not leave the rest running into
  // the next plugin instance.
  await runShutdownStep("standalone reopen marker", () => {
    const standaloneWindow = addon.data.standaloneWindow;
    if (!reason.isUpgrade || !standaloneWindow || standaloneWindow.closed) {
      return;
    }
    (Zotero as unknown as Record<string, ReopenStandaloneMarker>)[
      REOPEN_STANDALONE_MARKER
    ] = { initialItemID: getStandaloneActivePaperItemID() };
  });
  // Dispose while hosts are still registered, before unregisterAll removes
  // their DOM and clearAllState forgets them. Detached callbacks must not run
  // against the next plugin instance during a hot reload.
  await runShutdownStep("panel handlers", () => {
    for (const [body] of activeContextPanels) disposeSetupHandlers(body);
  });
  await runShutdownStep("dedicated chat panes", () => {
    for (const dispose of dedicatedChatPaneDisposers.values()) dispose();
    dedicatedChatPaneDisposers.clear();
  });
  await runShutdownStep("Zotero change dispatcher", async () => {
    zoteroChangeDispatcher.unregisterNativeObserver();
    await zoteroChangeDispatcher.flush();
  });
  try {
    const { stopLibraryTextIndex } =
      await import("./services/libraryTextIndex");
    await stopLibraryTextIndex();
  } catch (error) {
    appLogger.debug("LLM index: shutdown skipped", error);
  }
  await runShutdownStep("mineru local server", async () => {
    try {
      const { stopMineruServer } = await import("./utils/mineruServerManager");
      await stopMineruServer("plugin_shutdown");
    } catch (error) {
      appLogger.debug("MinerU server: shutdown skipped", error);
    }
  });
  await runShutdownStep("paper conversation restore", async () => {
    unregisterPaperConversationRestoreNotifications();
    await shutdownPaperRestoreSelections();
  });
  await runShutdownStep("pending deletion", disposePendingDeletionSubsystem);
  await runShutdownStep("app logging", disposeAppLogging);
  await runShutdownStep("toolkit registrations", () =>
    ztoolkit.unregisterAll(),
  );
  await runShutdownStep(
    "reader selection tracking",
    unregisterReaderSelectionTracking,
  );
  await runShutdownStep(
    "note editing selection tracking",
    unregisterAllNoteEditingSelectionTracking,
  );
  await runShutdownStep("dialogs", closeAllAddonDialogs);
  await runShutdownStep("standalone window", () =>
    addon.data.standaloneWindow?.close(),
  );
  await runShutdownStep("torn-off chat windows", closeAllTornChatWindows);
  // Zotero would keep this section's element, and so these hooks, if the
  // next version registers it again before the item pane renders.
  await runShutdownStep("item pane section", unregisterReaderContextPanel);
  // Zotero does not unload the main windows for a disable or an update, so
  // their plugin DOM is removed here.
  await runShutdownStep("main window DOM", () => {
    for (const win of Zotero.getMainWindows()) removePluginWindowDom(win);
  });
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
    const { uninstallClaudeBridgeLifecycle } =
      await import("./claudeCode/bridgeProcess");
    await uninstallClaudeBridgeLifecycle();
  } catch (error) {
    appLogger.debug("LLM: Claude Code bridge shutdown skipped", error);
  }
  try {
    const { destroyAllCachedCodexAppServerProcesses } =
      await import("./utils/codexAppServerProcess");
    const finished = await waitWithTimeout(
      destroyAllCachedCodexAppServerProcesses(),
      CODEX_SHUTDOWN_TIMEOUT_MS,
    );
    if (!finished) {
      appLogger.warn(
        `LLM: codex app-server shutdown did not finish in ${CODEX_SHUTDOWN_TIMEOUT_MS}ms; continuing`,
      );
    }
  } catch (error) {
    appLogger.debug("LLM: codex app-server shutdown skipped", error);
  }
  try {
    const { shutdownAgentSubsystem } = require("./agent");
    shutdownAgentSubsystem();
  } catch {
    /* ignore if module not loaded */
  }
  await runShutdownStep("queued follow-ups", clearQueuedFollowUpState);
  await runShutdownStep("panel state", clearAllState);
  await runShutdownStep("panel surfaces", () => {
    disposePanelSurfaces?.();
    disposePanelSurfaces = null;
  });
  await runShutdownStep("host surfaces", () => {
    disposeHostSurfaces?.();
    disposeHostSurfaces = null;
  });
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
  appLogger.debug("notify", event, type, ids, extraData);
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
