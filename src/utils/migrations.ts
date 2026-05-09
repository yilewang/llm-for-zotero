import { config } from "../../package.json";
import { joinLocalPath } from "./localPath";

declare const Services:
  | {
      prefs?: {
        prefHasUserValue(prefName: string): boolean;
      };
    }
  | undefined;

const LEGACY_PREFS_PREFIX = "extensions.zotero.zoterollm";
const PREF_MIGRATION_MARKER_KEY = `${config.prefsPrefix}.migrationFromZoterollmV1Done`;
const PREF_MINERU_CONTENT_MD_CLEANUP = `${config.prefsPrefix}.migrationMineruContentMdCleanupDone`;
const PREF_MINERU_MANIFEST_BUILD = `${config.prefsPrefix}.migrationMineruManifestBuildDone`;
const PREF_NICKNAME_MIGRATION = `${config.prefsPrefix}.migrationNicknameAutoSetDone`;
const PREF_ATTACHMENTS_VAULT_RELATIVE = `${config.prefsPrefix}.migrationAttachmentsVaultRelativeDone`;

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

async function migrateMineruContentMdCleanup(): Promise<void> {
  if (Zotero.Prefs.get(PREF_MINERU_CONTENT_MD_CLEANUP, true)) return;
  try {
    const { cleanupLegacyContentMdFiles } =
      await import("../modules/contextPanel/mineruCache");
    await cleanupLegacyContentMdFiles();
  } catch {
    /* ignore – cache dir may not exist yet */
  }
  Zotero.Prefs.set(PREF_MINERU_CONTENT_MD_CLEANUP, true, true);
}

/**
 * Build manifest.json for existing MinerU cached papers that don't have one yet.
 * Runs in the background — non-blocking best-effort.
 */
async function migrateMineruManifestBuild(): Promise<void> {
  if (Zotero.Prefs.get(PREF_MINERU_MANIFEST_BUILD, true)) return;
  try {
    const { getMineruCacheDir, buildAndWriteManifest } =
      await import("../modules/contextPanel/mineruCache");
    const cacheDir = getMineruCacheDir();
    const IOUtils = (globalThis as Record<string, unknown>).IOUtils as
      | {
          getChildren?: (path: string) => Promise<string[]>;
          exists?: (path: string) => Promise<boolean>;
        }
      | undefined;
    if (!IOUtils?.getChildren || !IOUtils?.exists) {
      Zotero.Prefs.set(PREF_MINERU_MANIFEST_BUILD, true, true);
      return;
    }
    if (!(await IOUtils.exists(cacheDir))) {
      Zotero.Prefs.set(PREF_MINERU_MANIFEST_BUILD, true, true);
      return;
    }
    const entries = await IOUtils.getChildren(cacheDir);
    let built = 0;
    for (const entry of entries) {
      const basename = entry.split(/[\\/]/).pop() || "";
      if (!/^\d+$/.test(basename)) continue;
      const id = parseInt(basename, 10);
      // Skip if manifest already exists
      const manifestPath = entry + "/manifest.json";
      if (await IOUtils.exists(manifestPath)) continue;
      // Skip if no full.md
      const mdPath = entry + "/full.md";
      if (!(await IOUtils.exists(mdPath))) continue;
      try {
        await buildAndWriteManifest(id);
        built += 1;
      } catch {
        // Non-critical — skip this paper
      }
    }
    if (built > 0) {
      ztoolkit.log(
        `LLM: Built manifest.json for ${built} existing MinerU cached paper(s).`,
      );
    }
  } catch {
    /* ignore – cache dir may not exist yet */
  }
  Zotero.Prefs.set(PREF_MINERU_MANIFEST_BUILD, true, true);
}

/**
 * Auto-set notesDirectoryNickname to "Obsidian" for existing users who have
 * obsidianVaultPath configured but no nickname set. This ensures the nickname-
 * based skill activation works for users who configured Obsidian before the
 * nickname feature was added.
 */
function migrateNickname(): void {
  if (Zotero.Prefs.get(PREF_NICKNAME_MIGRATION, true)) return;

  const vaultPath = Zotero.Prefs.get(
    `${config.prefsPrefix}.obsidianVaultPath`,
    true,
  );
  const nickname = Zotero.Prefs.get(
    `${config.prefsPrefix}.notesDirectoryNickname`,
    true,
  );

  if (
    typeof vaultPath === "string" &&
    vaultPath.trim() &&
    (typeof nickname !== "string" || !nickname.trim())
  ) {
    Zotero.Prefs.set(
      `${config.prefsPrefix}.notesDirectoryNickname`,
      "Obsidian",
      true,
    );
    ztoolkit.log(
      "LLM: Auto-set notes directory nickname to 'Obsidian' for existing Obsidian user.",
    );
  }

  Zotero.Prefs.set(PREF_NICKNAME_MIGRATION, true, true);
}

/**
 * Migrate attachments folder from notes-folder-relative to vault-relative.
 *
 * Previously the attachments folder (e.g., "imgs") was treated as a subfolder
 * of the notes folder (e.g., vault/Logs/imgs). Now it's relative to the vault
 * root. To preserve existing behavior, prepend the target folder:
 *   "imgs" with targetFolder "Logs" → "Logs/imgs"
 */
function migrateAttachmentsVaultRelative(): void {
  if (Zotero.Prefs.get(PREF_ATTACHMENTS_VAULT_RELATIVE, true)) return;

  const vaultPath = Zotero.Prefs.get(
    `${config.prefsPrefix}.obsidianVaultPath`,
    true,
  );

  // Only users with an existing Obsidian configuration had the old
  // notes-folder-relative semantic. Fresh users are already on the new
  // semantic (defaults were updated alongside this migration), so there's
  // nothing to rewrite — marking the migration done prevents silent mutation
  // of default prefs for non-Obsidian users.
  if (typeof vaultPath !== "string" || !vaultPath.trim()) {
    Zotero.Prefs.set(PREF_ATTACHMENTS_VAULT_RELATIVE, true, true);
    return;
  }

  const targetFolder = Zotero.Prefs.get(
    `${config.prefsPrefix}.obsidianTargetFolder`,
    true,
  );
  const attachments = Zotero.Prefs.get(
    `${config.prefsPrefix}.obsidianAttachmentsFolder`,
    true,
  );

  if (
    typeof targetFolder === "string" &&
    targetFolder.trim() &&
    typeof attachments === "string" &&
    attachments.trim()
  ) {
    // Only migrate if the attachments folder doesn't already start with the
    // target folder (avoid double-prefixing on re-run edge cases).
    const tf = targetFolder.trim();
    const af = attachments.trim();
    if (!af.startsWith(tf + "/") && !af.startsWith(tf + "\\")) {
      const migrated = joinLocalPath(tf, af);
      Zotero.Prefs.set(
        `${config.prefsPrefix}.obsidianAttachmentsFolder`,
        migrated,
        true,
      );
      ztoolkit.log(
        `LLM: Migrated attachments folder to vault-relative: "${af}" → "${migrated}"`,
      );
    }
  }

  Zotero.Prefs.set(PREF_ATTACHMENTS_VAULT_RELATIVE, true, true);
}

export async function runLegacyMigrations(): Promise<void> {
  migrateLegacyPrefs();
  migrateNickname();
  migrateAttachmentsVaultRelative();
  await migrateMineruContentMdCleanup();
  // Run manifest build in background — non-blocking
  migrateMineruManifestBuild().catch(() => {});
}
