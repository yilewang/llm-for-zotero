import type { DialogHelper } from "zotero-plugin-toolkit";

const inPanelDialogClosers = new Set<() => void>();

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

export function registerAddonInPanelDialog(
  doc: Document,
  close: () => void,
): () => void {
  const ownerWindow = doc.defaultView;
  const closeOnOwnerExit = () => close();
  inPanelDialogClosers.add(close);
  ownerWindow?.addEventListener("pagehide", closeOnOwnerExit, { once: true });
  ownerWindow?.addEventListener("unload", closeOnOwnerExit, { once: true });

  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    inPanelDialogClosers.delete(close);
    ownerWindow?.removeEventListener("pagehide", closeOnOwnerExit);
    ownerWindow?.removeEventListener("unload", closeOnOwnerExit);
  };
}

export function closeAllAddonDialogs(): void {
  const dialogs = getDialogRegistry();
  const activeDialogs = dialogs ? [...dialogs] : [];
  dialogs?.clear();
  for (const dialog of activeDialogs) {
    try {
      dialog.window?.close();
    } catch {
      // A dialog can finish closing while shutdown is iterating the snapshot.
    }
  }

  const activeInPanelDialogClosers = [...inPanelDialogClosers];
  inPanelDialogClosers.clear();
  for (const close of activeInPanelDialogClosers) {
    try {
      close();
    } catch {
      // A dialog can finish settling while shutdown is iterating the snapshot.
    }
  }
}
