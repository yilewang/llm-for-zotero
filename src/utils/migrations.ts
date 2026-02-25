import { config } from "../../package.json";

declare const Services:
  | {
      prefs?: {
        prefHasUserValue(prefName: string): boolean;
      };
    }
  | undefined;

const LEGACY_PREFS_PREFIX = "extensions.zotero.zoterollm";
const PREF_MIGRATION_MARKER_KEY = `${config.prefsPrefix}.migrationFromZoterollmV1Done`;

const MIGRATABLE_PREF_KEYS = [
  "enable",
  "input",
  "apiBase",
  "apiKey",
  "model",
  "systemPrompt",
  "showPopupAddText",
  "embeddingModel",
  "apiBasePrimary",
  "apiKeyPrimary",
  "modelPrimary",
  "apiBaseSecondary",
  "apiKeySecondary",
  "modelSecondary",
  "apiBaseTertiary",
  "apiKeyTertiary",
  "modelTertiary",
  "apiBaseQuaternary",
  "apiKeyQuaternary",
  "modelQuaternary",
  "temperaturePrimary",
  "maxTokensPrimary",
  "inputTokenCapPrimary",
  "temperatureSecondary",
  "maxTokensSecondary",
  "inputTokenCapSecondary",
  "temperatureTertiary",
  "maxTokensTertiary",
  "inputTokenCapTertiary",
  "temperatureQuaternary",
  "maxTokensQuaternary",
  "inputTokenCapQuaternary",
  "shortcuts",
  "shortcutLabels",
  "shortcutDeleted",
  "customShortcuts",
  "shortcutOrder",
  "assistantNoteMap",
] as const;

function hasUserPref(prefKey: string): boolean {
  try {
    if (typeof Services !== "undefined" && Services?.prefs?.prefHasUserValue) {
      return Services.prefs.prefHasUserValue(prefKey);
    }
  } catch (_err) {
    // fall back to value-based detection below
  }
  return Zotero.Prefs.get(prefKey, true) !== undefined;
}

function migrateLegacyPrefs(): void {
  if (config.prefsPrefix === LEGACY_PREFS_PREFIX) return;
  if (Zotero.Prefs.get(PREF_MIGRATION_MARKER_KEY, true)) return;

  let migrated = 0;
  for (const key of MIGRATABLE_PREF_KEYS) {
    const legacyPrefKey = `${LEGACY_PREFS_PREFIX}.${key}`;
    const nextPrefKey = `${config.prefsPrefix}.${key}`;
    if (!hasUserPref(legacyPrefKey) || hasUserPref(nextPrefKey)) {
      continue;
    }

    const legacyValue = Zotero.Prefs.get(legacyPrefKey, true);
    if (legacyValue === undefined) {
      continue;
    }
    Zotero.Prefs.set(nextPrefKey, legacyValue as never, true);
    migrated += 1;
  }

  Zotero.Prefs.set(PREF_MIGRATION_MARKER_KEY, true, true);
  if (migrated > 0) {
    ztoolkit.log(`LLM: Migrated ${migrated} legacy preference value(s).`);
  }
}

export async function runLegacyMigrations(): Promise<void> {
  migrateLegacyPrefs();
}
