declare const Zotero: any;

import { config } from "../../package.json";
import {
  getCurrentProfileSignature,
  initConversationRegistryStore,
  registerPaperRestoreTargetInvalidationListener,
  type PaperRestoreTargetInvalidation,
} from "./conversationRegistry";
import {
  hasConversationSchemaMigration,
  markConversationSchemaMigrationApplied,
} from "./conversationSchemaMigrations";
import type { ConversationSystem } from "./types";

export type PaperRestoreScope = {
  system: ConversationSystem;
  libraryID: number;
  paperItemID: number;
  profileSignature?: string;
};

export type PaperRestoreRuntimeReadiness = {
  chatStoreReady: boolean;
  claudeStoreReady: boolean;
  codexStoreReady: boolean;
};

type RestoreEntry = {
  conversationKey: number;
  instanceID: string;
};

type EligibleRegistryRow = RestoreEntry & {
  system: ConversationSystem;
  profileSignature: string;
  libraryID: number;
  paperItemID: number;
  isPaperRestoreTarget: boolean;
};

type LegacyCandidate = {
  conversationKey: number;
  libraryID: number;
  paperItemID: number;
  priority: number;
};

const REGISTRY_TABLE = "llm_for_zotero_conversation_registry";

const RUNTIME_CONFIG: Record<
  ConversationSystem,
  {
    preference: string;
    migrationID: string;
    description: string;
  }
> = {
  upstream: {
    preference: "lastUsedPaperConversationMap",
    migrationID: "paper-restore-selection-v1:upstream",
    description: "Move upstream paper restore selections from preferences",
  },
  claude_code: {
    preference: "claudeCodePaperConversationMap",
    migrationID: "paper-restore-selection-v1:claude-code",
    description: "Move Claude Code paper restore selections from preferences",
  },
  codex: {
    preference: "codexAppServerPaperConversationMap",
    migrationID: "paper-restore-selection-v1:codex",
    description: "Move Codex paper restore selections from preferences",
  },
};

const restoreCache = new Map<string, RestoreEntry>();
const committedRestoreCache = new Map<string, RestoreEntry>();
const scopeGenerations = new Map<string, number>();
const stagedStartupCandidates = new Map<string, LegacyCandidate>();
const writableSystems = new Set<ConversationSystem>();
const initializedSystems = new Set<ConversationSystem>();

let writeQueue: Promise<void> = Promise.resolve();
let acceptingWrites = true;
let unregisterRegistryInvalidation: (() => void) | null = null;
let shutdownPhase: {
  addBlocker?: (name: string, condition: () => Promise<void>) => void;
  removeBlocker?: (condition: () => Promise<void>) => void;
} | null = null;
let shutdownBlocker: (() => Promise<void>) | null = null;

function normalizePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeScope(
  scope: PaperRestoreScope,
): Required<PaperRestoreScope> | null {
  const libraryID = normalizePositiveInt(scope.libraryID);
  const paperItemID = normalizePositiveInt(scope.paperItemID);
  if (!libraryID || !paperItemID) return null;
  return {
    system: scope.system,
    libraryID,
    paperItemID,
    profileSignature:
      normalizeText(scope.profileSignature) || getCurrentProfileSignature(),
  };
}

function buildScopeKey(scope: Required<PaperRestoreScope>): string {
  return [
    scope.profileSignature,
    scope.system,
    scope.libraryID,
    scope.paperItemID,
  ].join(":");
}

function logRestoreError(message: string, error?: unknown): void {
  const suffix =
    error === undefined
      ? ""
      : `: ${error instanceof Error ? error.message : String(error)}`;
  Zotero?.debug?.(`[llm-for-zotero] ${message}${suffix}`);
}

function getDb(): {
  queryAsync?: (sql: string, params?: unknown[]) => Promise<unknown>;
  executeTransaction?: <T>(task: () => Promise<T>) => Promise<T>;
} | null {
  return Zotero?.DB || null;
}

function preferenceKey(system: ConversationSystem): string {
  return `${config.prefsPrefix}.${RUNTIME_CONFIG[system].preference}`;
}

function readLegacyPreference(system: ConversationSystem): string {
  const value = Zotero?.Prefs?.get?.(preferenceKey(system), true);
  return typeof value === "string" ? value.trim() : "";
}

function clearLegacyPreference(system: ConversationSystem): void {
  if (typeof Zotero?.Prefs?.clear !== "function") {
    throw new Error("Zotero.Prefs.clear is unavailable");
  }
  Zotero.Prefs.clear(preferenceKey(system), true);
}

async function requireExactlyOneChangedRow(
  queryAsync: (sql: string, params?: unknown[]) => Promise<unknown>,
): Promise<void> {
  const rows = (await queryAsync("SELECT changes() AS count")) as
    | Array<{ count?: unknown }>
    | undefined;
  if (Number(rows?.[0]?.count) !== 1) {
    throw new Error("Paper restore target changed before it could be marked");
  }
}

function parseLegacyPreference(
  system: ConversationSystem,
  raw: string,
  profileSignature: string,
): LegacyCandidate[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];

  const candidates = new Map<string, LegacyCandidate>();
  for (const [rawScope, rawConversationKey] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    const conversationKey = normalizePositiveInt(rawConversationKey);
    if (!conversationKey) continue;
    const parts = rawScope.split(":");
    let libraryID: number | null = null;
    let paperItemID: number | null = null;
    let priority = 0;
    if (system === "upstream" && parts.length === 2) {
      libraryID = normalizePositiveInt(parts[0]);
      paperItemID = normalizePositiveInt(parts[1]);
      priority = 2;
    } else if (system === "claude_code" && parts.length === 2) {
      libraryID = normalizePositiveInt(parts[0]);
      paperItemID = normalizePositiveInt(parts[1]);
      priority = 1;
    } else if (
      system !== "upstream" &&
      parts.length === 3 &&
      parts[0] === profileSignature
    ) {
      libraryID = normalizePositiveInt(parts[1]);
      paperItemID = normalizePositiveInt(parts[2]);
      priority = 2;
    }
    if (!libraryID || !paperItemID || !priority) continue;
    const scopeKey = `${libraryID}:${paperItemID}`;
    const current = candidates.get(scopeKey);
    if (!current || priority > current.priority) {
      candidates.set(scopeKey, {
        conversationKey,
        libraryID,
        paperItemID,
        priority,
      });
    }
  }
  return [...candidates.values()];
}

function getStagedStartupCandidates(
  system: ConversationSystem,
  profileSignature: string,
): LegacyCandidate[] {
  const prefix = `${profileSignature}:${system}:`;
  return [...stagedStartupCandidates.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, candidate]) => candidate);
}

function mergeLegacyCandidates(
  legacy: LegacyCandidate[],
  staged: LegacyCandidate[],
): LegacyCandidate[] {
  const merged = new Map<string, LegacyCandidate>();
  for (const candidate of [...legacy, ...staged]) {
    const key = `${candidate.libraryID}:${candidate.paperItemID}`;
    const current = merged.get(key);
    if (!current || candidate.priority > current.priority) {
      merged.set(key, candidate);
    }
  }
  return [...merged.values()];
}

function eligibleRegistryScanSql(system: ConversationSystem): string {
  const upstreamJoin =
    system === "upstream"
      ? `JOIN llm_for_zotero_paper_conversations pc
           ON pc.conversation_key = r.legacy_conversation_key
          AND pc.library_id = r.library_id
          AND pc.paper_item_id = r.paper_item_id
          AND COALESCE(pc.webchat_session, 0) = 0`
      : "";
  return `SELECT r.instance_id AS instanceID,
                 r.legacy_conversation_key AS conversationKey,
                 r.system,
                 r.profile_signature AS profileSignature,
                 r.library_id AS libraryID,
                 r.paper_item_id AS paperItemID,
                 r.is_paper_restore_target AS isPaperRestoreTarget
          FROM ${REGISTRY_TABLE} r
          JOIN items i
            ON i.itemID = r.paper_item_id
           AND i.libraryID = r.library_id
          LEFT JOIN deletedItems di ON di.itemID = i.itemID
          ${upstreamJoin}
          WHERE r.profile_signature = ?
            AND r.system = ?
            AND r.kind = 'paper'
            AND r.valid = 1
            AND r.paper_item_id IS NOT NULL
            AND di.itemID IS NULL`;
}

function staleMarkerClearSql(system: ConversationSystem): string {
  const upstreamPredicate =
    system === "upstream"
      ? `OR NOT EXISTS (
           SELECT 1
           FROM llm_for_zotero_paper_conversations pc
           WHERE pc.conversation_key = ${REGISTRY_TABLE}.legacy_conversation_key
             AND pc.library_id = ${REGISTRY_TABLE}.library_id
             AND pc.paper_item_id = ${REGISTRY_TABLE}.paper_item_id
             AND COALESCE(pc.webchat_session, 0) = 0
         )`
      : "";
  return `UPDATE ${REGISTRY_TABLE}
          SET is_paper_restore_target = 0
          WHERE profile_signature = ?
            AND system = ?
            AND is_paper_restore_target = 1
            AND (
              valid = 0
              OR kind <> 'paper'
              OR paper_item_id IS NULL
              OR NOT EXISTS (
                SELECT 1
                FROM items i
                WHERE i.itemID = ${REGISTRY_TABLE}.paper_item_id
                  AND i.libraryID = ${REGISTRY_TABLE}.library_id
              )
              OR EXISTS (
                SELECT 1
                FROM deletedItems di
                WHERE di.itemID = ${REGISTRY_TABLE}.paper_item_id
              )
              ${upstreamPredicate}
            )`;
}

function normalizeEligibleRows(rows: unknown): EligibleRegistryRow[] {
  if (!Array.isArray(rows)) return [];
  const normalized: EligibleRegistryRow[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const system = row.system;
    const conversationKey = normalizePositiveInt(row.conversationKey);
    const libraryID = normalizePositiveInt(row.libraryID);
    const paperItemID = normalizePositiveInt(row.paperItemID);
    const profileSignature = normalizeText(row.profileSignature);
    if (
      (system !== "upstream" &&
        system !== "claude_code" &&
        system !== "codex") ||
      !conversationKey ||
      !libraryID ||
      !paperItemID ||
      !profileSignature
    ) {
      continue;
    }
    normalized.push({
      instanceID: normalizeText(row.instanceID),
      conversationKey,
      system,
      profileSignature,
      libraryID,
      paperItemID,
      isPaperRestoreTarget: Number(row.isPaperRestoreTarget) === 1,
    });
  }
  return normalized;
}

function installCacheEntries(rows: Iterable<EligibleRegistryRow>): void {
  for (const row of rows) {
    const scopeKey = buildScopeKey(row);
    const entry = {
      conversationKey: row.conversationKey,
      instanceID: row.instanceID,
    };
    restoreCache.set(scopeKey, entry);
    committedRestoreCache.set(scopeKey, entry);
  }
}

function selectValidatedLegacyCandidates(
  system: ConversationSystem,
  profileSignature: string,
  candidates: LegacyCandidate[],
  rows: EligibleRegistryRow[],
): EligibleRegistryRow[] {
  const rowsByKey = new Map<number, EligibleRegistryRow>();
  for (const row of rows) rowsByKey.set(row.conversationKey, row);
  const selected: EligibleRegistryRow[] = [];
  for (const candidate of candidates) {
    const row = rowsByKey.get(candidate.conversationKey);
    if (
      !row ||
      row.system !== system ||
      row.profileSignature !== profileSignature ||
      row.libraryID !== candidate.libraryID ||
      row.paperItemID !== candidate.paperItemID
    ) {
      continue;
    }
    selected.push(row);
  }
  return selected;
}

async function initializeRuntime(
  system: ConversationSystem,
  profileSignature: string,
): Promise<void> {
  const db = getDb();
  if (!db?.queryAsync || !db.executeTransaction) {
    initializedSystems.add(system);
    logRestoreError(
      `Paper restore selection unavailable for ${system}: Zotero DB is unavailable`,
    );
    return;
  }
  const runtime = RUNTIME_CONFIG[system];
  const migrationApplied = await hasConversationSchemaMigration(
    runtime.migrationID,
  );
  const legacyRaw = migrationApplied ? "" : readLegacyPreference(system);
  const legacyCandidates = mergeLegacyCandidates(
    parseLegacyPreference(system, legacyRaw, profileSignature),
    migrationApplied
      ? []
      : getStagedStartupCandidates(system, profileSignature),
  );

  let eligibleRows: EligibleRegistryRow[];
  try {
    eligibleRows = normalizeEligibleRows(
      await db.queryAsync(eligibleRegistryScanSql(system), [
        profileSignature,
        system,
      ]),
    );
  } catch (error) {
    initializedSystems.add(system);
    logRestoreError(
      `Paper restore selection scan failed for ${system}; retaining its legacy preference`,
      error,
    );
    return;
  }

  const validatedLegacy = selectValidatedLegacyCandidates(
    system,
    profileSignature,
    legacyCandidates,
    eligibleRows,
  );
  try {
    await db.executeTransaction(async () => {
      await db.queryAsync?.(staleMarkerClearSql(system), [
        profileSignature,
        system,
      ]);
      if (!migrationApplied) {
        for (const row of validatedLegacy) {
          await db.queryAsync?.(
            `UPDATE ${REGISTRY_TABLE}
             SET is_paper_restore_target = 0
             WHERE profile_signature = ?
               AND system = ?
               AND library_id = ?
               AND paper_item_id = ?
               AND kind = 'paper'`,
            [profileSignature, system, row.libraryID, row.paperItemID],
          );
          await db.queryAsync?.(
            `UPDATE ${REGISTRY_TABLE}
             SET is_paper_restore_target = 1
             WHERE legacy_conversation_key = ?
               AND instance_id = ?
               AND profile_signature = ?
               AND system = ?
               AND library_id = ?
               AND paper_item_id = ?
               AND kind = 'paper'
               AND valid = 1`,
            [
              row.conversationKey,
              row.instanceID,
              profileSignature,
              system,
              row.libraryID,
              row.paperItemID,
            ],
          );
          await requireExactlyOneChangedRow(db.queryAsync!.bind(db));
        }
        await markConversationSchemaMigrationApplied(
          runtime.migrationID,
          runtime.description,
        );
      }
    });
  } catch (error) {
    installCacheEntries(eligibleRows.filter((row) => row.isPaperRestoreTarget));
    installCacheEntries(validatedLegacy);
    initializedSystems.add(system);
    logRestoreError(
      `Paper restore selection migration failed for ${system}; using validated legacy state read-only for this session`,
      error,
    );
    return;
  }

  const selectedRows = migrationApplied
    ? eligibleRows.filter((row) => row.isPaperRestoreTarget)
    : validatedLegacy;
  installCacheEntries(selectedRows);
  initializedSystems.add(system);
  writableSystems.add(system);
  try {
    clearLegacyPreference(system);
  } catch (error) {
    logRestoreError(
      `Paper restore selection migration committed for ${system}, but its legacy preference could not be cleared`,
      error,
    );
  }
}

function installRegistryInvalidationListener(): void {
  if (unregisterRegistryInvalidation) return;
  unregisterRegistryInvalidation =
    registerPaperRestoreTargetInvalidationListener((target) =>
      invalidatePaperRestoreTargetCache(
        target,
        target.conversationKey,
        target.instanceID || undefined,
      ),
    );
}

function resolveShutdownPhase(): typeof shutdownPhase {
  try {
    const chromeUtils = (globalThis as { ChromeUtils?: any }).ChromeUtils;
    const module = chromeUtils?.importESModule?.(
      "resource://gre/modules/AsyncShutdown.sys.mjs",
    );
    return module?.AsyncShutdown?.profileBeforeChange || null;
  } catch (error) {
    logRestoreError(
      "Could not register the paper restore shutdown blocker",
      error,
    );
    return null;
  }
}

function installShutdownBlocker(): void {
  if (shutdownBlocker) return;
  shutdownPhase = resolveShutdownPhase();
  if (!shutdownPhase?.addBlocker) return;
  shutdownBlocker = async () => {
    beginPaperRestoreSelectionShutdown();
    await flushPaperRestoreSelectionWrites();
  };
  shutdownPhase.addBlocker(
    "LLM for Zotero: flush paper conversation restore selections",
    shutdownBlocker,
  );
}

export async function initializePaperRestoreSelections(
  readiness: PaperRestoreRuntimeReadiness,
): Promise<void> {
  acceptingWrites = true;
  const readySystems: ConversationSystem[] = [];
  if (readiness.chatStoreReady) readySystems.push("upstream");
  if (readiness.claudeStoreReady) readySystems.push("claude_code");
  if (readiness.codexStoreReady) readySystems.push("codex");
  for (const [key] of stagedStartupCandidates) {
    const system = key.split(":")[1] as ConversationSystem | undefined;
    if (system && !readySystems.includes(system)) {
      stagedStartupCandidates.delete(key);
    }
  }
  try {
    await initConversationRegistryStore();
  } catch (error) {
    for (const system of readySystems) {
      initializedSystems.add(system);
      logRestoreError(
        `Paper restore selection schema initialization failed for ${system}; retaining its legacy preference`,
        error,
      );
    }
    return;
  }
  installRegistryInvalidationListener();
  installShutdownBlocker();
  const profileSignature = getCurrentProfileSignature();
  for (const system of readySystems) {
    try {
      await initializeRuntime(system, profileSignature);
    } catch (error) {
      initializedSystems.add(system);
      logRestoreError(
        `Paper restore selection initialization failed for ${system}; retaining its legacy preference`,
        error,
      );
    } finally {
      const prefix = `${profileSignature}:${system}:`;
      for (const [key] of stagedStartupCandidates) {
        if (key.startsWith(prefix)) stagedStartupCandidates.delete(key);
      }
    }
  }
}

export function stagePaperRestoreTargetForStartup(
  scope: PaperRestoreScope,
  conversationKey: number,
): void {
  const normalized = normalizeScope(scope);
  const normalizedKey = normalizePositiveInt(conversationKey);
  if (!normalized || !normalizedKey) return;
  if (initializedSystems.has(normalized.system)) {
    logRestoreError(
      `Ignored late startup paper restore candidate for ${normalized.system}`,
    );
    return;
  }
  stagedStartupCandidates.set(buildScopeKey(normalized), {
    conversationKey: normalizedKey,
    libraryID: normalized.libraryID,
    paperItemID: normalized.paperItemID,
    priority: 3,
  });
}

export function getPaperRestoreTarget(scope: PaperRestoreScope): number | null {
  const normalized = normalizeScope(scope);
  if (!normalized || !initializedSystems.has(normalized.system)) return null;
  return restoreCache.get(buildScopeKey(normalized))?.conversationKey || null;
}

function enqueueWrite(
  label: string,
  run: () => Promise<void>,
  onFailure?: () => void,
): void {
  const attempt = writeQueue.then(run, run);
  writeQueue = attempt.catch((error) => {
    onFailure?.();
    logRestoreError(label, error);
  });
}

async function persistScopeSelection(
  scope: Required<PaperRestoreScope>,
  conversationKey: number | null,
): Promise<RestoreEntry | null> {
  const db = getDb();
  if (!db?.queryAsync || !db.executeTransaction) {
    throw new Error("Zotero DB is unavailable");
  }
  let selected: RestoreEntry | null = null;
  await db.executeTransaction(async () => {
    if (conversationKey) {
      const upstreamJoin =
        scope.system === "upstream"
          ? `JOIN llm_for_zotero_paper_conversations pc
               ON pc.conversation_key = r.legacy_conversation_key
              AND pc.library_id = r.library_id
              AND pc.paper_item_id = r.paper_item_id
              AND COALESCE(pc.webchat_session, 0) = 0`
          : "";
      const rows = normalizeEligibleRows(
        await db.queryAsync?.(
          `SELECT r.instance_id AS instanceID,
                  r.legacy_conversation_key AS conversationKey,
                  r.system,
                  r.profile_signature AS profileSignature,
                  r.library_id AS libraryID,
                  r.paper_item_id AS paperItemID,
                  r.is_paper_restore_target AS isPaperRestoreTarget
           FROM ${REGISTRY_TABLE} r
           JOIN items i
             ON i.itemID = r.paper_item_id
            AND i.libraryID = r.library_id
           LEFT JOIN deletedItems di ON di.itemID = i.itemID
           ${upstreamJoin}
           WHERE r.legacy_conversation_key = ?
             AND r.profile_signature = ?
             AND r.system = ?
             AND r.kind = 'paper'
             AND r.library_id = ?
             AND r.paper_item_id = ?
             AND r.valid = 1
             AND di.itemID IS NULL
           LIMIT 1`,
          [
            conversationKey,
            scope.profileSignature,
            scope.system,
            scope.libraryID,
            scope.paperItemID,
          ],
        ),
      );
      const row = rows[0];
      if (!row)
        throw new Error("Conversation is not an eligible paper restore target");
      selected = {
        conversationKey: row.conversationKey,
        instanceID: row.instanceID,
      };
    }
    await db.queryAsync?.(
      `UPDATE ${REGISTRY_TABLE}
       SET is_paper_restore_target = 0
       WHERE profile_signature = ?
         AND system = ?
         AND library_id = ?
         AND paper_item_id = ?
         AND kind = 'paper'
         AND is_paper_restore_target = 1`,
      [
        scope.profileSignature,
        scope.system,
        scope.libraryID,
        scope.paperItemID,
      ],
    );
    if (selected) {
      await db.queryAsync?.(
        `UPDATE ${REGISTRY_TABLE}
         SET is_paper_restore_target = 1
         WHERE legacy_conversation_key = ?
           AND instance_id = ?
           AND profile_signature = ?
           AND system = ?
           AND library_id = ?
           AND paper_item_id = ?
           AND kind = 'paper'
           AND valid = 1`,
        [
          selected.conversationKey,
          selected.instanceID,
          scope.profileSignature,
          scope.system,
          scope.libraryID,
          scope.paperItemID,
        ],
      );
      await requireExactlyOneChangedRow(db.queryAsync!.bind(db));
    }
  });
  return selected;
}

export function rememberPaperRestoreTarget(
  scope: PaperRestoreScope,
  conversationKey: number,
): void {
  const normalized = normalizeScope({
    system: scope.system,
    libraryID: scope.libraryID,
    paperItemID: Number(scope.paperItemID),
    profileSignature: scope.profileSignature,
  });
  const normalizedKey = normalizePositiveInt(conversationKey);
  if (!normalized || !normalizedKey) return;
  if (!acceptingWrites || !writableSystems.has(normalized.system)) {
    logRestoreError(
      `Ignored paper restore selection before ${normalized.system} initialization`,
    );
    return;
  }
  const scopeKey = buildScopeKey(normalized);
  if (restoreCache.get(scopeKey)?.conversationKey === normalizedKey) return;
  const generation = (scopeGenerations.get(scopeKey) || 0) + 1;
  scopeGenerations.set(scopeKey, generation);
  restoreCache.set(scopeKey, {
    conversationKey: normalizedKey,
    instanceID: "",
  });
  enqueueWrite(
    `Could not persist paper restore selection for ${normalized.system}/${normalized.libraryID}/${normalized.paperItemID}`,
    async () => {
      const selected = await persistScopeSelection(normalized, normalizedKey);
      if (!selected) throw new Error("Restore target was not persisted");
      committedRestoreCache.set(scopeKey, selected);
      if (scopeGenerations.get(scopeKey) === generation) {
        restoreCache.set(scopeKey, selected);
      }
    },
    () => {
      if (scopeGenerations.get(scopeKey) !== generation) return;
      const committed = committedRestoreCache.get(scopeKey);
      if (committed) restoreCache.set(scopeKey, committed);
      else restoreCache.delete(scopeKey);
    },
  );
}

export function forgetPaperRestoreTarget(
  scope: PaperRestoreScope,
  expectedKey?: number,
): void {
  const normalized = normalizeScope(scope);
  if (!normalized) return;
  const scopeKey = buildScopeKey(normalized);
  const current = restoreCache.get(scopeKey);
  const normalizedExpected = normalizePositiveInt(expectedKey);
  if (normalizedExpected && current?.conversationKey !== normalizedExpected)
    return;
  if (!current) return;
  if (!acceptingWrites || !writableSystems.has(normalized.system)) return;
  const generation = (scopeGenerations.get(scopeKey) || 0) + 1;
  scopeGenerations.set(scopeKey, generation);
  restoreCache.delete(scopeKey);
  enqueueWrite(
    `Could not clear paper restore selection for ${normalized.system}/${normalized.libraryID}/${normalized.paperItemID}`,
    async () => {
      await persistScopeSelection(normalized, null);
      committedRestoreCache.delete(scopeKey);
    },
    () => {
      if (scopeGenerations.get(scopeKey) !== generation) return;
      const committed = committedRestoreCache.get(scopeKey);
      if (committed) restoreCache.set(scopeKey, committed);
    },
  );
}

export function invalidatePaperRestoreTargetCache(
  scope: PaperRestoreScope | PaperRestoreTargetInvalidation,
  expectedKey: number,
  expectedInstanceID?: string,
): void {
  const normalized = normalizeScope({
    system: scope.system,
    libraryID: scope.libraryID,
    paperItemID: Number(scope.paperItemID),
    profileSignature: scope.profileSignature,
  });
  const normalizedExpected = normalizePositiveInt(expectedKey);
  if (!normalized || !normalizedExpected) return;
  const scopeKey = buildScopeKey(normalized);
  const current = restoreCache.get(scopeKey);
  if (!current || current.conversationKey !== normalizedExpected) return;
  const instanceID = normalizeText(expectedInstanceID);
  if (instanceID && current.instanceID !== instanceID) return;
  restoreCache.delete(scopeKey);
  const committed = committedRestoreCache.get(scopeKey);
  if (
    committed?.conversationKey === normalizedExpected &&
    (!instanceID || committed.instanceID === instanceID)
  ) {
    committedRestoreCache.delete(scopeKey);
  }
  scopeGenerations.set(scopeKey, (scopeGenerations.get(scopeKey) || 0) + 1);
}

export function forgetPaperRestoreTargetsForItems(itemIDs: number[]): void {
  if (!itemIDs.length) return;
  const itemIDSet = new Set(itemIDs);
  const affectedScopeKeys = new Set<string>();
  for (const scopeKey of new Set([
    ...restoreCache.keys(),
    ...committedRestoreCache.keys(),
  ])) {
    const paperItemID = normalizePositiveInt(scopeKey.split(":").at(-1));
    if (!paperItemID || !itemIDSet.has(paperItemID)) continue;
    affectedScopeKeys.add(scopeKey);
    restoreCache.delete(scopeKey);
    committedRestoreCache.delete(scopeKey);
    scopeGenerations.set(scopeKey, (scopeGenerations.get(scopeKey) || 0) + 1);
  }
  if (!acceptingWrites || !writableSystems.size) return;
  const placeholders = itemIDs.map(() => "?").join(", ");
  enqueueWrite(
    "Could not clear paper restore selections for removed Zotero items",
    async () => {
      const db = getDb();
      if (!db?.queryAsync || !db.executeTransaction) {
        throw new Error("Zotero DB is unavailable");
      }
      await db.executeTransaction(async () => {
        await db.queryAsync?.(
          `UPDATE ${REGISTRY_TABLE}
           SET is_paper_restore_target = 0
           WHERE paper_item_id IN (${placeholders})
             AND kind = 'paper'
             AND is_paper_restore_target = 1`,
          itemIDs,
        );
      });
      for (const scopeKey of affectedScopeKeys) {
        committedRestoreCache.delete(scopeKey);
      }
    },
  );
}

export function forgetPaperRestoreTargetsForItem(
  _libraryID: number,
  paperItemID: number,
): void {
  const normalized = normalizePositiveInt(paperItemID);
  if (normalized) forgetPaperRestoreTargetsForItems([normalized]);
}

export async function clearPaperRestoreTargetsForWorkflowTests(): Promise<void> {
  await flushPaperRestoreSelectionWrites();
  const profileSignature = getCurrentProfileSignature();
  for (const scopeKey of [...restoreCache.keys()]) {
    if (!scopeKey.startsWith(`${profileSignature}:`)) continue;
    restoreCache.delete(scopeKey);
    committedRestoreCache.delete(scopeKey);
    scopeGenerations.delete(scopeKey);
  }
  const db = getDb();
  if (!db?.queryAsync || !db.executeTransaction) return;
  await db.executeTransaction(async () => {
    await db.queryAsync?.(
      `UPDATE ${REGISTRY_TABLE}
       SET is_paper_restore_target = 0
       WHERE profile_signature = ?
         AND kind = 'paper'
         AND is_paper_restore_target = 1`,
      [profileSignature],
    );
  });
}

export function beginPaperRestoreSelectionShutdown(): void {
  acceptingWrites = false;
}

export async function flushPaperRestoreSelectionWrites(): Promise<void> {
  await writeQueue;
}

export async function shutdownPaperRestoreSelections(): Promise<void> {
  beginPaperRestoreSelectionShutdown();
  await flushPaperRestoreSelectionWrites();
  if (shutdownBlocker && shutdownPhase?.removeBlocker) {
    shutdownPhase.removeBlocker(shutdownBlocker);
  }
  shutdownBlocker = null;
  shutdownPhase = null;
  unregisterRegistryInvalidation?.();
  unregisterRegistryInvalidation = null;
  restoreCache.clear();
  committedRestoreCache.clear();
  scopeGenerations.clear();
  stagedStartupCandidates.clear();
  writableSystems.clear();
  initializedSystems.clear();
}

export function resetPaperRestoreSelectionStateForTests(): void {
  if (shutdownBlocker && shutdownPhase?.removeBlocker) {
    shutdownPhase.removeBlocker(shutdownBlocker);
  }
  shutdownBlocker = null;
  shutdownPhase = null;
  unregisterRegistryInvalidation?.();
  unregisterRegistryInvalidation = null;
  restoreCache.clear();
  committedRestoreCache.clear();
  scopeGenerations.clear();
  stagedStartupCandidates.clear();
  writableSystems.clear();
  initializedSystems.clear();
  writeQueue = Promise.resolve();
  acceptingWrites = true;
}
