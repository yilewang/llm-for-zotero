declare const Zotero: any;

import type { ConversationSystem } from "./types";

export type RegistryConversationKind = "global" | "paper";

export type ConversationRegistryScope = {
  conversationID?: string | null;
  conversationKey: number;
  system: ConversationSystem;
  kind: RegistryConversationKind;
  libraryID: number;
  paperItemID?: number | null;
  profileSignature?: string | null;
  createdAt?: number;
  updatedAt?: number;
  title?: string | null;
};

export type ConversationRegistryRow = Required<
  Pick<
    ConversationRegistryScope,
    "conversationID" | "conversationKey" | "system" | "kind" | "libraryID"
  >
> & {
  profileSignature: string;
  paperItemID: number | null;
  valid: boolean;
  invalidReason?: string;
};

export type ConversationScopeValidationReason =
  | "invalid_target"
  | "missing_registry"
  | "invalid_registry"
  | "conversation_id_mismatch"
  | "scope_mismatch";

export type ConversationScopeValidationDetails = {
  valid: boolean;
  reason?: ConversationScopeValidationReason;
  target?: ConversationRegistryRow;
  registered?: ConversationRegistryRow | null;
};

export type PaperContextJsonColumns = {
  paperContextsJson?: unknown;
  fullTextPaperContextsJson?: unknown;
  selectedTextPaperContextsJson?: unknown;
  citationPaperContextsJson?: unknown;
};

export type PaperContextOwnershipEvidence = {
  paperItemIDs: number[];
  singlePaperItemID: number | null;
};

export const AMBIGUOUS_PAPER_CONTEXT_INVALID_REASON =
  "ambiguous paper context evidence";

const CONVERSATION_REGISTRY_TABLE = "llm_for_zotero_conversation_registry";
const CONVERSATION_REGISTRY_SCOPE_INDEX =
  "llm_for_zotero_conversation_registry_scope_idx";
const CONVERSATION_REGISTRY_LEGACY_KEY_INDEX =
  "llm_for_zotero_conversation_registry_legacy_key_idx";

function normalizePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function normalizeText(value: unknown, maxLength = 256): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, maxLength);
}

function normalizeSystem(value: unknown): ConversationSystem | null {
  return value === "upstream" || value === "claude_code" || value === "codex"
    ? value
    : null;
}

function normalizeKind(value: unknown): RegistryConversationKind | null {
  return value === "global" || value === "paper" ? value : null;
}

function normalizeTimestamp(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : Date.now();
}

function normalizeConversationID(value: unknown): string {
  return normalizeText(value, 512)
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9:._-]/g, "_")
    .slice(0, 512);
}

export function buildProfileSignature(profileDir: string): string {
  const normalized = profileDir.trim().replace(/\\/g, "/");
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `profile-${(hash >>> 0).toString(16)}`;
}

export function getCurrentProfileSignature(): string {
  const profileDir = normalizeText(
    (globalThis as typeof globalThis & { Zotero?: { Profile?: { dir?: unknown } } })
      .Zotero?.Profile?.dir,
    1024,
  );
  return profileDir ? buildProfileSignature(profileDir) : "profile-default";
}

export function buildConversationID(params: {
  conversationKey: number;
  system: ConversationSystem;
  kind: RegistryConversationKind;
  libraryID: number;
  paperItemID?: number | null;
  profileSignature?: string | null;
}): string {
  const conversationKey = normalizePositiveInt(params.conversationKey) || 0;
  const libraryID = normalizePositiveInt(params.libraryID) || 0;
  const paperItemID =
    params.kind === "paper"
      ? normalizePositiveInt(params.paperItemID) || 0
      : 0;
  const profileSignature =
    normalizeText(params.profileSignature, 128) || getCurrentProfileSignature();
  return [
    "lfz",
    profileSignature,
    params.system,
    params.kind,
    `lib-${libraryID}`,
    `paper-${paperItemID}`,
    `legacy-${conversationKey}`,
  ].join(":");
}

function normalizeScope(
  params: ConversationRegistryScope,
): (ConversationRegistryRow & { createdAt: number; updatedAt: number; title: string | null }) | null {
  const conversationKey = normalizePositiveInt(params.conversationKey);
  const libraryID = normalizePositiveInt(params.libraryID);
  const system = normalizeSystem(params.system);
  const kind = normalizeKind(params.kind);
  if (!conversationKey || !libraryID || !system || !kind) return null;
  const paperItemID =
    kind === "paper" ? normalizePositiveInt(params.paperItemID) : null;
  if (kind === "paper" && !paperItemID) return null;
  return {
    conversationID:
      normalizeConversationID(params.conversationID) ||
      buildConversationID({
        conversationKey,
        system,
        kind,
        libraryID,
        paperItemID,
        profileSignature:
          normalizeText(params.profileSignature, 128) ||
          getCurrentProfileSignature(),
      }),
    conversationKey,
    system,
    kind,
    profileSignature:
      normalizeText(params.profileSignature, 128) || getCurrentProfileSignature(),
    libraryID,
    paperItemID,
    valid: true,
    createdAt: normalizeTimestamp(params.createdAt),
    updatedAt: normalizeTimestamp(params.updatedAt),
    title: normalizeText(params.title || "", 128) || null,
  };
}

function sameRegistryScope(
  left: ConversationRegistryRow,
  right: ConversationRegistryRow,
): boolean {
  return (
    left.system === right.system &&
    left.kind === right.kind &&
    left.profileSignature === right.profileSignature &&
    left.libraryID === right.libraryID &&
    (left.paperItemID || null) === (right.paperItemID || null)
  );
}

function logRegistryWarning(message: string): void {
  const debug = (globalThis as typeof globalThis & {
    Zotero?: { debug?: (message: string) => void };
  }).Zotero?.debug;
  debug?.(`LLM: ${message}`);
}

function getZoteroDb():
  | { queryAsync?: (sql: string, params?: unknown[]) => Promise<unknown> }
  | null {
  return (
    (globalThis as typeof globalThis & {
      Zotero?: { DB?: { queryAsync?: (sql: string, params?: unknown[]) => Promise<unknown> } };
    }).Zotero?.DB || null
  );
}

async function getTableColumns(tableName: string): Promise<Set<string>> {
  const db = getZoteroDb();
  if (!db?.queryAsync) return new Set();
  const rows = (await db.queryAsync(
    `PRAGMA table_info(${tableName})`,
  )) as Array<{ name?: unknown }> | undefined;
  return new Set(
    (rows || [])
      .map((row) => (typeof row.name === "string" ? row.name : ""))
      .filter(Boolean),
  );
}

async function createConversationRegistryTable(): Promise<void> {
  const db = getZoteroDb();
  if (!db?.queryAsync) return;
  await db.queryAsync(
    `CREATE TABLE IF NOT EXISTS ${CONVERSATION_REGISTRY_TABLE} (
      conversation_id TEXT PRIMARY KEY,
      legacy_conversation_key INTEGER NOT NULL,
      system TEXT NOT NULL CHECK(system IN ('upstream', 'claude_code', 'codex')),
      kind TEXT NOT NULL CHECK(kind IN ('global', 'paper')),
      profile_signature TEXT NOT NULL,
      library_id INTEGER NOT NULL,
      paper_item_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      title TEXT,
      valid INTEGER NOT NULL DEFAULT 1,
      invalid_reason TEXT
    )`,
  );
}

async function migrateLegacyRegistrySchema(columns: Set<string>): Promise<void> {
  const db = getZoteroDb();
  if (!db?.queryAsync) return;
  if (!columns.has("conversation_key") || columns.has("legacy_conversation_key")) {
    return;
  }
  const legacyTable = `${CONVERSATION_REGISTRY_TABLE}_legacy_keyed`;
  await db.queryAsync(`DROP TABLE IF EXISTS ${legacyTable}`);
  await db.queryAsync(
    `ALTER TABLE ${CONVERSATION_REGISTRY_TABLE}
     RENAME TO ${legacyTable}`,
  );
  await createConversationRegistryTable();
  const rows = (await db.queryAsync(
    `SELECT conversation_key AS conversationKey,
            system,
            kind,
            profile_signature AS profileSignature,
            library_id AS libraryID,
            paper_item_id AS paperItemID,
            created_at AS createdAt,
            updated_at AS updatedAt,
            title,
            valid,
            invalid_reason AS invalidReason
     FROM ${legacyTable}`,
  )) as Array<Record<string, unknown>> | undefined;
  for (const row of rows || []) {
    const system = normalizeSystem(row.system);
    const kind = normalizeKind(row.kind);
    const conversationKey = normalizePositiveInt(row.conversationKey);
    const libraryID = normalizePositiveInt(row.libraryID);
    if (!system || !kind || !conversationKey || !libraryID) continue;
    const paperItemID = normalizePositiveInt(row.paperItemID);
    const profileSignature =
      normalizeText(row.profileSignature, 128) || getCurrentProfileSignature();
    await db.queryAsync(
      `INSERT OR IGNORE INTO ${CONVERSATION_REGISTRY_TABLE}
        (conversation_id, legacy_conversation_key, system, kind, profile_signature, library_id, paper_item_id, created_at, updated_at, title, valid, invalid_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        buildConversationID({
          conversationKey,
          system,
          kind,
          libraryID,
          paperItemID,
          profileSignature,
        }),
        conversationKey,
        system,
        kind,
        profileSignature,
        libraryID,
        kind === "paper" ? paperItemID || null : null,
        normalizeTimestamp(row.createdAt),
        normalizeTimestamp(row.updatedAt),
        normalizeText(row.title, 128) || null,
        Number(row.valid) === 0 ? 0 : 1,
        normalizeText(row.invalidReason, 256) || null,
      ],
    );
  }
  await db.queryAsync(`DROP TABLE IF EXISTS ${legacyTable}`);
}

export async function initConversationRegistryStore(): Promise<void> {
  const db = getZoteroDb();
  if (!db?.queryAsync) return;
  const columns = await getTableColumns(CONVERSATION_REGISTRY_TABLE);
  if (columns.size && columns.has("conversation_key")) {
    await migrateLegacyRegistrySchema(columns);
  } else {
    await createConversationRegistryTable();
  }
  const currentColumns = await getTableColumns(CONVERSATION_REGISTRY_TABLE);
  if (currentColumns.size && !currentColumns.has("conversation_id")) {
    logRegistryWarning(
      "Conversation registry schema is missing conversation_id; refusing to use unsafe registry table.",
    );
    return;
  }
  await db.queryAsync(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${CONVERSATION_REGISTRY_LEGACY_KEY_INDEX}
     ON ${CONVERSATION_REGISTRY_TABLE} (legacy_conversation_key)`,
  );
  await db.queryAsync(
    `CREATE INDEX IF NOT EXISTS ${CONVERSATION_REGISTRY_SCOPE_INDEX}
     ON ${CONVERSATION_REGISTRY_TABLE}
       (profile_signature, system, kind, library_id, paper_item_id, updated_at DESC)`,
  );
}

export async function getRegisteredConversationScope(
  conversationKey: number,
): Promise<ConversationRegistryRow | null> {
  const normalizedKey = normalizePositiveInt(conversationKey);
  if (!normalizedKey) return null;
  const db = getZoteroDb();
  if (!db?.queryAsync) return null;
  await initConversationRegistryStore();
  const rows = (await db.queryAsync(
    `SELECT conversation_id AS conversationID,
            legacy_conversation_key AS conversationKey,
            system,
            kind,
            profile_signature AS profileSignature,
            library_id AS libraryID,
            paper_item_id AS paperItemID,
            valid,
            invalid_reason AS invalidReason
     FROM ${CONVERSATION_REGISTRY_TABLE}
     WHERE legacy_conversation_key = ?
     LIMIT 1`,
    [normalizedKey],
  )) as Array<Record<string, unknown>> | undefined;
  const row = rows?.[0];
  if (!row) return null;
  const system = normalizeSystem(row.system);
  const kind = normalizeKind(row.kind);
  const libraryID = normalizePositiveInt(row.libraryID);
  if (!system || !kind || !libraryID) return null;
  return {
    conversationID:
      normalizeConversationID(row.conversationID) ||
      buildConversationID({
        conversationKey: normalizedKey,
        system,
        kind,
        profileSignature: normalizeText(row.profileSignature, 128),
        libraryID,
        paperItemID: normalizePositiveInt(row.paperItemID),
      }),
    conversationKey: normalizedKey,
    system,
    kind,
    profileSignature: normalizeText(row.profileSignature, 128),
    libraryID,
    paperItemID: normalizePositiveInt(row.paperItemID),
    valid: Number(row.valid) !== 0,
    invalidReason: normalizeText(row.invalidReason, 256) || undefined,
  };
}

export async function registerConversationScope(
  params: ConversationRegistryScope,
): Promise<boolean> {
  const normalized = normalizeScope(params);
  if (!normalized) return false;
  const db = getZoteroDb();
  if (!db?.queryAsync) return false;
  await initConversationRegistryStore();
  const existing = await getRegisteredConversationScope(
    normalized.conversationKey,
  );
  if (existing && !sameRegistryScope(existing, normalized)) {
    logRegistryWarning(
      `Refused to reassign conversation ${normalized.conversationKey} from ${existing.system}/${existing.kind}/${existing.libraryID}/${existing.paperItemID || ""} to ${normalized.system}/${normalized.kind}/${normalized.libraryID}/${normalized.paperItemID || ""}.`,
    );
    return false;
  }
  if (existing && existing.conversationID !== normalized.conversationID) {
    logRegistryWarning(
      `Refused to reassign legacy conversation key ${normalized.conversationKey} from ${existing.conversationID} to ${normalized.conversationID}.`,
    );
    return false;
  }
  await db.queryAsync(
    `INSERT INTO ${CONVERSATION_REGISTRY_TABLE}
      (conversation_id, legacy_conversation_key, system, kind, profile_signature, library_id, paper_item_id, created_at, updated_at, title, valid, invalid_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)
     ON CONFLICT(conversation_id) DO UPDATE SET
       legacy_conversation_key = excluded.legacy_conversation_key,
       updated_at = excluded.updated_at,
       title = COALESCE(excluded.title, ${CONVERSATION_REGISTRY_TABLE}.title)`,
    [
      normalized.conversationID,
      normalized.conversationKey,
      normalized.system,
      normalized.kind,
      normalized.profileSignature,
      normalized.libraryID,
      normalized.paperItemID,
      normalized.createdAt,
      normalized.updatedAt,
      normalized.title,
    ],
  );
  return true;
}

export async function invalidateRegisteredConversationScope(
  conversationKey: number,
  reason: string,
): Promise<void> {
  const normalizedKey = normalizePositiveInt(conversationKey);
  if (!normalizedKey) return;
  const db = getZoteroDb();
  if (!db?.queryAsync) return;
  await initConversationRegistryStore();
  await db.queryAsync(
    `UPDATE ${CONVERSATION_REGISTRY_TABLE}
     SET valid = 0,
         invalid_reason = ?
     WHERE legacy_conversation_key = ?`,
    [normalizeText(reason, 256) || "invalid scope", normalizedKey],
  );
}

export async function repairRegisteredConversationScope(
  params: ConversationRegistryScope,
): Promise<boolean> {
  const normalized = normalizeScope(params);
  if (!normalized) return false;
  const db = getZoteroDb();
  if (!db?.queryAsync) return false;
  await initConversationRegistryStore();
  const existing = await getRegisteredConversationScope(
    normalized.conversationKey,
  );
  if (existing && existing.conversationID !== normalized.conversationID) {
    await db.queryAsync(
      `UPDATE ${CONVERSATION_REGISTRY_TABLE}
       SET conversation_id = ?,
           system = ?,
           kind = ?,
           profile_signature = ?,
           library_id = ?,
           paper_item_id = ?,
           updated_at = ?,
           title = COALESCE(?, title),
           valid = 1,
           invalid_reason = NULL
       WHERE legacy_conversation_key = ?`,
      [
        normalized.conversationID,
        normalized.system,
        normalized.kind,
        normalized.profileSignature,
        normalized.libraryID,
        normalized.paperItemID,
        normalized.updatedAt,
        normalized.title,
        normalized.conversationKey,
      ],
    );
    return true;
  }
  await db.queryAsync(
    `INSERT INTO ${CONVERSATION_REGISTRY_TABLE}
      (conversation_id, legacy_conversation_key, system, kind, profile_signature, library_id, paper_item_id, created_at, updated_at, title, valid, invalid_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)
     ON CONFLICT(conversation_id) DO UPDATE SET
       legacy_conversation_key = excluded.legacy_conversation_key,
       system = excluded.system,
       kind = excluded.kind,
       profile_signature = excluded.profile_signature,
       library_id = excluded.library_id,
       paper_item_id = excluded.paper_item_id,
       updated_at = excluded.updated_at,
       title = COALESCE(excluded.title, ${CONVERSATION_REGISTRY_TABLE}.title),
       valid = 1,
       invalid_reason = NULL`,
    [
      normalized.conversationID,
      normalized.conversationKey,
      normalized.system,
      normalized.kind,
      normalized.profileSignature,
      normalized.libraryID,
      normalized.paperItemID,
      normalized.createdAt,
      normalized.updatedAt,
      normalized.title,
    ],
  );
  return true;
}

export async function validateConversationScope(
  params: ConversationRegistryScope,
): Promise<boolean> {
  return (await getConversationScopeValidationDetails(params)).valid;
}

export async function getConversationScopeValidationDetails(
  params: ConversationRegistryScope,
): Promise<ConversationScopeValidationDetails> {
  const normalized = normalizeScope(params);
  if (!normalized) {
    return { valid: false, reason: "invalid_target" };
  }
  const target: ConversationRegistryRow = {
    conversationID: normalized.conversationID,
    conversationKey: normalized.conversationKey,
    system: normalized.system,
    kind: normalized.kind,
    profileSignature: normalized.profileSignature,
    libraryID: normalized.libraryID,
    paperItemID: normalized.paperItemID,
    valid: normalized.valid,
  };
  const db = getZoteroDb();
  const existing = await getRegisteredConversationScope(
    normalized.conversationKey,
  );
  if (!existing) {
    if (!db?.queryAsync || normalized.system === "upstream") {
      return { valid: true, target, registered: null };
    }
    return {
      valid: false,
      reason: "missing_registry",
      target,
      registered: null,
    };
  }
  if (!existing.valid) {
    return {
      valid: false,
      reason: "invalid_registry",
      target,
      registered: existing,
    };
  }
  if (!sameRegistryScope(existing, normalized)) {
    return {
      valid: false,
      reason: "scope_mismatch",
      target,
      registered: existing,
    };
  }
  const explicitConversationID = normalizeConversationID(params.conversationID);
  if (
    explicitConversationID &&
    existing.conversationID !== normalized.conversationID
  ) {
    return {
      valid: false,
      reason: "conversation_id_mismatch",
      target,
      registered: existing,
    };
  }
  return { valid: true, target, registered: existing };
}

export function isLegacyAmbiguousPaperContextInvalidReason(
  reason: unknown,
): boolean {
  return (
    normalizeText(reason, 256).toLowerCase() ===
    AMBIGUOUS_PAPER_CONTEXT_INVALID_REASON
  );
}

export function canMigrateLegacyAmbiguousPaperRegistryScope(
  registered: ConversationRegistryRow | null | undefined,
  scope: Pick<
    ConversationRegistryScope,
    "system" | "kind" | "libraryID" | "paperItemID"
  >,
): boolean {
  const libraryID = normalizePositiveInt(scope.libraryID);
  const paperItemID = normalizePositiveInt(scope.paperItemID);
  return Boolean(
    registered &&
      !registered.valid &&
      isLegacyAmbiguousPaperContextInvalidReason(registered.invalidReason) &&
      scope.kind === "paper" &&
      libraryID &&
      paperItemID &&
      registered.system === scope.system &&
      registered.kind === "paper" &&
      registered.libraryID === libraryID &&
      (registered.paperItemID || 0) === paperItemID,
  );
}

function collectPaperIdsFromValue(value: unknown, out: Set<number>): void {
  if (typeof value !== "string" || !value.trim()) return;
  try {
    const parsed = JSON.parse(value) as unknown;
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const itemID = normalizePositiveInt(
        (entry as { itemId?: unknown; itemID?: unknown }).itemId ??
          (entry as { itemId?: unknown; itemID?: unknown }).itemID,
      );
      if (itemID) out.add(itemID);
    }
  } catch {
    // Ignore malformed legacy JSON. It cannot safely prove ownership.
  }
}

export function inferSinglePaperItemIdFromContextRows(
  rows: PaperContextJsonColumns[],
): number | "ambiguous" | null {
  const evidence = getPaperContextOwnershipEvidenceFromRows(rows);
  if (evidence.paperItemIDs.length === 0) return null;
  if (evidence.paperItemIDs.length > 1) return "ambiguous";
  return evidence.singlePaperItemID;
}

export function getPaperContextOwnershipEvidenceFromRows(
  rows: PaperContextJsonColumns[],
): PaperContextOwnershipEvidence {
  const ids = new Set<number>();
  for (const row of rows) {
    collectPaperIdsFromValue(row.paperContextsJson, ids);
    collectPaperIdsFromValue(row.fullTextPaperContextsJson, ids);
    collectPaperIdsFromValue(row.selectedTextPaperContextsJson, ids);
    collectPaperIdsFromValue(row.citationPaperContextsJson, ids);
  }
  const paperItemIDs = Array.from(ids).sort((left, right) => left - right);
  return {
    paperItemIDs,
    singlePaperItemID: paperItemIDs.length === 1 ? paperItemIDs[0] : null,
  };
}
