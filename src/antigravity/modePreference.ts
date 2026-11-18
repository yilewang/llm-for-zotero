import type { ConversationSystem } from "../shared/types";
import {
  getConversationSystemPref,
  setConversationSystemPref,
} from "../shared/conversationSystemPrefs";
import { setAntigravityModeEnabled } from "./prefs";
import { prepareAntigravityStorage } from "./storage";

type AntigravityModePreferenceChangeDeps = {
  prepareAntigravityStorage: () => Promise<unknown>;
  setAntigravityModeEnabled: (enabled: boolean) => void;
  getConversationSystemPref: () => ConversationSystem;
  setConversationSystemPref: (system: ConversationSystem) => void;
};

/**
 * Turns Antigravity mode on or off from Settings.
 *
 * Turning it on first prepares storage (the one-time rebuild of the shared
 * conversation tables), so no Antigravity row is written before the tables
 * can hold one; if that fails, the mode stays off and the error reaches the
 * caller. Turning it off moves a panel that was on Antigravity back to the
 * built-in runtime.
 */
export async function applyAntigravityModePreferenceChange(
  enabled: boolean,
  deps: AntigravityModePreferenceChangeDeps = {
    prepareAntigravityStorage,
    setAntigravityModeEnabled,
    getConversationSystemPref,
    setConversationSystemPref,
  },
): Promise<void> {
  if (enabled) {
    await deps.prepareAntigravityStorage();
    deps.setAntigravityModeEnabled(true);
    return;
  }
  deps.setAntigravityModeEnabled(false);
  if (deps.getConversationSystemPref() === "antigravity") {
    deps.setConversationSystemPref("upstream");
  }
}
