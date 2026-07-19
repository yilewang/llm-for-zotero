import type { ConversationSystem } from "../shared/types";
import {
  getConversationSystemPref,
  setConversationSystemPref,
} from "../claudeCode/prefs";
import { setCodexAppServerModeEnabled } from "./prefs";

type CodexModePreferenceChangeDeps = {
  setCodexAppServerModeEnabled: (enabled: boolean) => void;
  getConversationSystemPref: () => ConversationSystem;
  setConversationSystemPref: (system: ConversationSystem) => void;
};

export function applyCodexAppServerModePreferenceChange(
  enabled: boolean,
  deps: CodexModePreferenceChangeDeps = {
    setCodexAppServerModeEnabled,
    getConversationSystemPref,
    setConversationSystemPref,
  },
): void {
  deps.setCodexAppServerModeEnabled(enabled);
  if (!enabled && deps.getConversationSystemPref() === "codex") {
    deps.setConversationSystemPref("upstream");
  }
}
