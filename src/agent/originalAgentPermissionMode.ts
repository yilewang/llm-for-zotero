import { config } from "../../package.json";
import {
  normalizeOriginalAgentPermissionMode,
  type OriginalAgentPermissionMode,
} from "../shared/originalAgentPermissionMode";

const PREF_KEY = `${config.prefsPrefix}.originalAgentPermissionMode`;
const LEGACY_PREF_KEY = `${config.prefsPrefix}.agentLibraryWriteMode`;

function readPref(key: string): unknown {
  return (
    Zotero as unknown as {
      Prefs?: { get?: (key: string, global?: boolean) => unknown };
    }
  ).Prefs?.get?.(key, true);
}

/**
 * Read the Original Agent's complete permission mode.
 *
 * The legacy value is a read-only migration source so an existing explicit
 * choice survives the rename. New writes use only the new preference.
 */
export function getOriginalAgentPermissionMode(): OriginalAgentPermissionMode {
  try {
    const current = readPref(PREF_KEY);
    if (current === "safe" || current === "auto" || current === "yolo") {
      return current;
    }
    const legacy = readPref(LEGACY_PREF_KEY);
    return normalizeOriginalAgentPermissionMode(
      typeof legacy === "string" ? legacy.trim().toLowerCase() : legacy,
    );
  } catch {
    // Match normalizeOriginalAgentPermissionMode: a fresh install is auto.
    return "auto";
  }
}

export function setOriginalAgentPermissionMode(
  mode: OriginalAgentPermissionMode,
): void {
  try {
    (
      Zotero as unknown as {
        Prefs?: {
          set?: (key: string, value: unknown, global?: boolean) => void;
        };
      }
    ).Prefs?.set?.(PREF_KEY, mode, true);
  } catch {
    /* A preference failure must not fail the active turn. */
  }
}
