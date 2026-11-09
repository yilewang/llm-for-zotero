import type { ConversationSystem } from "../shared/types";
import {
  getConversationSystemPref,
  setConversationSystemPref,
} from "../claudeCode/prefs";
import { setAntigravityModeEnabled } from "./prefs";

type AntigravityModePreferenceChangeDeps = {
  setAntigravityModeEnabled: (enabled: boolean) => void;
  getConversationSystemPref: () => ConversationSystem;
  setConversationSystemPref: (system: ConversationSystem) => void;
};

export function applyAntigravityModePreferenceChange(
  enabled: boolean,
  deps: AntigravityModePreferenceChangeDeps = {
    setAntigravityModeEnabled,
    getConversationSystemPref,
    setConversationSystemPref,
  },
): void {
  deps.setAntigravityModeEnabled(enabled);
  if (!enabled && deps.getConversationSystemPref() === "antigravity") {
    deps.setConversationSystemPref("upstream");
  }
}
