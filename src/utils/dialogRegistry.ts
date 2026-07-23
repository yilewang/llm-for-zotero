import type { DialogHelper } from "zotero-plugin-toolkit";

function getDialogRegistry(): Set<DialogHelper> | null {
  if (typeof addon === "undefined") return null;
  return addon.data.dialogs;
}

export function registerAddonDialog(dialog: DialogHelper): () => void {
  const dialogs = getDialogRegistry();
  dialogs?.add(dialog);
  let registered = Boolean(dialogs);
  return () => {
    if (!registered) return;
    registered = false;
    dialogs?.delete(dialog);
  };
}

export function closeAllAddonDialogs(): void {
  const dialogs = getDialogRegistry();
  if (!dialogs?.size) return;
  const activeDialogs = [...dialogs];
  dialogs.clear();
  for (const dialog of activeDialogs) {
    try {
      dialog.window?.close();
    } catch {
      // A dialog can finish closing while shutdown is iterating the snapshot.
    }
  }
}
