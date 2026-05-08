import { initLocale } from "./utils/locale";
import { initI18n } from "./utils/i18n";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { PREFERENCES_PANE_ID } from "./modules/contextPanel/constants";
import {
  registerReaderContextPanel,
  registerLLMStyles,
  registerNoteEditingSelectionTracking,
  registerReaderSelectionTracking,
  openStandaloneChat,
} from "./modules/contextPanel";
import { resolveActiveLibraryID } from "./modules/contextPanel/portalScope";
import { invalidatePaperSearchCache } from "./modules/contextPanel/paperSearch";
import { initChatStore } from "./utils/chatStore";
import { initClaudeCodeStore } from "./claudeCode/store";
import { initCodexAppServerStore } from "./codexAppServer/store";
import { ensureClaudeProjectBootstrapIfEnabled } from "./claudeCode/bootstrapGate";
import {
  initAttachmentRefStore,
  reconcileNoteAttachmentRefsFromNoteContent,
  collectAndDeleteUnreferencedBlobs,
  ATTACHMENT_GC_MIN_AGE_MS,
} from "./utils/attachmentRefStore";
import { runLegacyMigrations } from "./utils/migrations";
import { createZToolkit } from "./utils/ztoolkit";
import {
  getAgentApi,
  initAgentSubsystem,
  shutdownAgentSubsystem,
} from "./agent";
import { pauseBatchProcessing } from "./modules/mineruBatchProcessor";
import { startAutoWatch, stopAutoWatch } from "./modules/mineruAutoWatch";
import { clearAllState, initFontScale } from "./modules/contextPanel/state";
import { clearQueuedFollowUpState } from "./modules/contextPanel/queuedFollowUps";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  try {
    await runLegacyMigrations();
  } catch (err) {
    ztoolkit.log("LLM: Failed to run legacy migration", err);
  }

  initLocale();
  initI18n();
  initFontScale();

  try {
    await initChatStore();
  } catch (err) {
    ztoolkit.log("LLM: Failed to initialize chat store", err);
  }
  try {
    await initClaudeCodeStore();
  } catch (err) {
    ztoolkit.log("LLM: Failed to initialize Claude Code store", err);
  }
  try {
    await initCodexAppServerStore();
  } catch (err) {
    ztoolkit.log("LLM: Failed to initialize Codex App Server store", err);
  }
  try {
    await ensureClaudeProjectBootstrapIfEnabled();
  } catch (err) {
    ztoolkit.log("LLM: Failed to bootstrap Claude project config", err);
  }
  try {
    await initAgentSubsystem();
    addon.api.agent = getAgentApi();
  } catch (err) {
    ztoolkit.log("LLM: Failed to initialize agent subsystem", err);
  }
  try {
    const { initUserSkills, loadUserSkills } = await import(
      "./agent/skills/userSkills"
    );
    const { setUserSkills } = await import("./agent/skills");
    await initUserSkills();
    const userSkills = await loadUserSkills();
    setUserSkills(userSkills);
  } catch (err) {
    ztoolkit.log("LLM: Failed to load user skills", err);
  }
  try {
    await initAttachmentRefStore();
  } catch (err) {
    ztoolkit.log("LLM: Failed to initialize attachment reference store", err);
  }

  void (async () => {
    try {
      await reconcileNoteAttachmentRefsFromNoteContent();
      await collectAndDeleteUnreferencedBlobs(ATTACHMENT_GC_MIN_AGE_MS);
    } catch (err) {
      ztoolkit.log("LLM: Attachment ref reconciliation/GC failed", err);
    }
  })();

  // Register webchat relay endpoints on Zotero's embedded HTTP server
  try {
    const { registerWebChatRelay } = await import("./webchat/relayServer");
    registerWebChatRelay();
  } catch (err) {
    ztoolkit.log("LLM: Failed to register webchat relay", err);
  }

  try {
    startAutoWatch();
  } catch (err) {
    ztoolkit.log("LLM: Failed to start MinerU auto-watch", err);
  }

  registerPrefsPane();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
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
    image: `chrome://${addon.data.config.addonRef}/content/icons/icon-20.png`,
  });
}

async function onMainWindowUnload(win: Window): Promise<void> {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  addon.data.standaloneWindow?.close();
  win.document.getElementById("llmforzotero-open-standalone")?.remove();
  win.document.getElementById("llmforzotero-key-standalone")?.remove();
}

function onShutdown(): void {
  if (paperSearchInvalidateTimer !== null) {
    clearTimeout(paperSearchInvalidateTimer);
    paperSearchInvalidateTimer = null;
  }
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  addon.data.standaloneWindow?.close();
  try {
    const { unregisterWebChatRelay } = require("./webchat/relayServer");
    unregisterWebChatRelay();
  } catch {
    /* ignore if module not loaded */
  }
  pauseBatchProcessing();
  stopAutoWatch();
  shutdownAgentSubsystem();
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
let paperSearchInvalidateTimer: ReturnType<typeof setTimeout> | null = null;

export function flushPaperSearchInvalidationForTests(): void {
  if (paperSearchInvalidateTimer !== null) {
    clearTimeout(paperSearchInvalidateTimer);
    paperSearchInvalidateTimer = null;
  }
  invalidatePaperSearchCache();
}

async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  const shouldInvalidatePaperSearch =
    (type === "item" || type === "file") &&
    ["add", "modify", "delete", "move", "remove", "trash", "refresh"].includes(
      event,
    );
  if (shouldInvalidatePaperSearch) {
    // Debounce: during bulk operations (import, sync) this fires hundreds
    // of times — coalesce into a single invalidation after 500ms of quiet.
    if (paperSearchInvalidateTimer !== null)
      clearTimeout(paperSearchInvalidateTimer);
    paperSearchInvalidateTimer = setTimeout(() => {
      paperSearchInvalidateTimer = null;
      invalidatePaperSearchCache();
    }, 500);
  }
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
