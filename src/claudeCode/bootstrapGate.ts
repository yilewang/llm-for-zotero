import type { ConversationSystem } from "../shared/types";
import { ensureClaudeProjectBootstrap } from "./bootstrap";
import {
  getConversationSystemPref,
  isClaudeCodeModeEnabled,
  setClaudeCodeModeEnabled,
  setConversationSystemPref,
} from "./prefs";

type ClaudeProjectBootstrapGateDeps = {
  isClaudeCodeModeEnabled: () => boolean;
  ensureClaudeProjectBootstrap: () => Promise<void>;
};

export async function ensureClaudeProjectBootstrapIfEnabled(
  deps: ClaudeProjectBootstrapGateDeps = {
    isClaudeCodeModeEnabled,
    ensureClaudeProjectBootstrap,
  },
): Promise<boolean> {
  if (!deps.isClaudeCodeModeEnabled()) return false;
  await deps.ensureClaudeProjectBootstrap();
  return true;
}

type ClaudeCodeModePreferenceChangeDeps = {
  setClaudeCodeModeEnabled: (enabled: boolean) => void;
  getConversationSystemPref: () => ConversationSystem;
  setConversationSystemPref: (system: ConversationSystem) => void;
  ensureClaudeProjectBootstrap: () => Promise<void>;
  log: (...args: unknown[]) => void;
};

export async function applyClaudeCodeModePreferenceChange(
  enabled: boolean,
  applyAgentBackendUi: (enabled: boolean) => void,
  deps: ClaudeCodeModePreferenceChangeDeps = {
    setClaudeCodeModeEnabled,
    getConversationSystemPref,
    setConversationSystemPref,
    ensureClaudeProjectBootstrap,
    log: (...args: unknown[]) => ztoolkit.log(...args),
  },
): Promise<void> {
  applyAgentBackendUi(enabled);
  deps.setClaudeCodeModeEnabled(enabled);
  if (enabled) {
    try {
      await deps.ensureClaudeProjectBootstrap();
    } catch (err) {
      deps.log("LLM: Failed to bootstrap Claude project config", err);
    }
    return;
  }
  if (deps.getConversationSystemPref() === "claude_code") {
    deps.setConversationSystemPref("upstream");
  }
}
