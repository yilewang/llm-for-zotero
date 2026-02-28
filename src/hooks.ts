import { initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import {
  registerReaderContextPanel,
  registerLLMStyles,
  registerReaderSelectionTracking,
} from "./modules/contextPanel";
import { invalidatePaperSearchCache } from "./modules/contextPanel/paperSearch";
import { initChatStore } from "./utils/chatStore";
import {
  initAttachmentRefStore,
  reconcileNoteAttachmentRefsFromNoteContent,
  collectAndDeleteUnreferencedBlobs,
  ATTACHMENT_GC_MIN_AGE_MS,
} from "./utils/attachmentRefStore";
import { runLegacyMigrations } from "./utils/migrations";
import { createZToolkit } from "./utils/ztoolkit";

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

  try {
    await initChatStore();
  } catch (err) {
    ztoolkit.log("LLM: Failed to initialize chat store", err);
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
}

function registerPrefsPane() {
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: `chrome://${addon.data.config.addonRef}/content/preferences.xhtml`,
    label: "llm-for-zotero",
    image: `chrome://${addon.data.config.addonRef}/content/icons/icon-20.png`,
  });
}

async function onMainWindowUnload(win: Window): Promise<void> {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

/**
 * This function is just an example of dispatcher for Notify events.
 * Any operations should be placed in a function to keep this funcion clear.
 */
async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  const shouldInvalidatePaperSearch =
    (type === "item" || type === "file") &&
    [
      "add",
      "modify",
      "delete",
      "move",
      "remove",
      "trash",
      "refresh",
    ].includes(event);
  if (shouldInvalidatePaperSearch) {
    invalidatePaperSearchCache();
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
