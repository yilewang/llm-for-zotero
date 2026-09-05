import { config } from "../../package.json";
import {
  normalizeAgentLibraryWriteMode,
  type AgentLibraryWriteMode,
} from "../shared/agentLibraryWriteMode";

const PREF_KEY = `${config.prefsPrefix}.agentLibraryWriteMode`;

/**
 * Reads the in-plugin agent's library write mode.
 *
 * A missing or unset pref normalises to `auto`, the shipped default. A pref
 * that cannot be READ at all falls back to `safe`, which is deliberately
 * stricter than the default: a corrupt or inaccessible preference must never
 * be the reason a write goes unreviewed.
 */
export function getAgentLibraryWriteMode(): AgentLibraryWriteMode {
  try {
    const raw = (
      Zotero as unknown as {
        Prefs?: { get?: (key: string, global?: boolean) => unknown };
      }
    ).Prefs?.get?.(PREF_KEY, true);
    return normalizeAgentLibraryWriteMode(
      typeof raw === "string" ? raw.trim().toLowerCase() : raw,
    );
  } catch {
    return "safe";
  }
}

export function setAgentLibraryWriteMode(mode: AgentLibraryWriteMode): void {
  try {
    (
      Zotero as unknown as {
        Prefs?: {
          set?: (key: string, value: unknown, global?: boolean) => void;
        };
      }
    ).Prefs?.set?.(PREF_KEY, mode === "yolo" ? "yolo" : "safe", true);
  } catch {
    /* a pref we cannot write is not worth failing a turn over */
  }
}
