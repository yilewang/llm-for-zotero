import { config } from "../../package.json";

/**
 * Lets other code open the plugin preferences on a chosen tab. A request
 * made before the pane loads is read once by the pane's init and cleared;
 * if the pane is already open, its tab button is clicked instead.
 */
const REQUEST_TTL_MS = 10000;
let requested: { tab: string; at: number } | null = null;

export function consumeRequestedPreferencesTab(): string | null {
  const request = requested;
  requested = null;
  if (!request || Date.now() - request.at > REQUEST_TTL_MS) return null;
  return request.tab;
}

function clickOpenPreferencesTab(tab: string): boolean {
  try {
    const wm = (
      globalThis as unknown as {
        Services?: {
          wm?: { getEnumerator(type: string): Iterable<Window> & object };
        };
      }
    ).Services?.wm;
    if (!wm) return false;
    const windows = wm.getEnumerator("zotero:pref") as unknown as {
      hasMoreElements(): boolean;
      getNext(): Window;
    };
    while (windows.hasMoreElements()) {
      const win = windows.getNext();
      const doc = win.document;
      const bar = doc.getElementById(`${config.addonRef}-pref-tab-bar`);
      const button = bar?.querySelector(
        `[data-pref-tab="${tab}"]`,
      ) as HTMLElement | null;
      if (button) {
        button.click();
        return true;
      }
    }
  } catch (_err) {
    void _err;
  }
  return false;
}

export function openPluginPreferencesTab(paneId: string, tab: string): void {
  requested = { tab, at: Date.now() };
  Zotero.Utilities.Internal.openPreferences(paneId);
  if (clickOpenPreferencesTab(tab)) requested = null;
}
