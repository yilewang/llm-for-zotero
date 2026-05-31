import {
  getPaperContextOwnershipEvidenceFromRows,
  type ConversationRegistryRow,
  type PaperContextJsonColumns,
} from "./conversationRegistry";
import type { ConversationSystem } from "./types";

type QueryAsync = (sql: string, params?: unknown[]) => Promise<unknown>;

export type ConversationMessageIdentityRepairStatus =
  | "unchanged"
  | "repaired"
  | "refused";

export type ConversationMessageIdentityRepairResult = {
  status: ConversationMessageIdentityRepairStatus;
  reason?: string;
};

export type ConversationCatalogMessageIdentityRepairSummary = {
  checked: number;
  repaired: number;
  refused: number;
};

function normalizeStoredConversationID(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePositiveInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function normalizeKind(value: unknown): "global" | "paper" | null {
  return value === "global" || value === "paper" ? value : null;
}

function canonicalIDConflictsWithRegistered(
  conversationID: string,
  registered: ConversationRegistryRow,
): boolean {
  const match =
    /^lfz:[^:]+:(upstream|claude_code|codex):(global|paper):lib-(\d+):paper-(\d+):legacy-(\d+)$/.exec(
      conversationID,
    );
  if (!match) return false;
  const [, system, kind, libraryID, paperItemID, legacyKey] = match;
  return (
    system !== registered.system ||
    kind !== registered.kind ||
    Number(libraryID) !== registered.libraryID ||
    Number(paperItemID) !== (registered.paperItemID || 0) ||
    Number(legacyKey) !== registered.conversationKey
  );
}

function refused(
  params: {
    registered: ConversationRegistryRow;
    storeLabel: string;
    log?: (message: string) => void;
  },
  reason: string,
): ConversationMessageIdentityRepairResult {
  params.log?.(
    `Refused to repair ${params.storeLabel} conversation ${params.registered.conversationKey}: ${reason}.`,
  );
  return { status: "refused", reason };
}

export async function repairRecoverableMessageConversationIDs(params: {
  queryAsync: QueryAsync;
  tableName: string;
  registered: ConversationRegistryRow;
  getPaperContextRows: (
    conversationKey: number,
  ) => Promise<PaperContextJsonColumns[]>;
  storeLabel: string;
  log?: (message: string) => void;
}): Promise<ConversationMessageIdentityRepairResult> {
  const { registered } = params;
  if (!registered.valid || !registered.conversationID) {
    return { status: "unchanged" };
  }

  const rows = (await params.queryAsync(
    `SELECT DISTINCT conversation_id AS conversationID
     FROM ${params.tableName}
     WHERE conversation_key = ?`,
    [registered.conversationKey],
  )) as Array<{ conversationID?: unknown }> | undefined;
  if (!rows?.length) return { status: "unchanged" };

  const hasBlankID = rows.some(
    (row) => !normalizeStoredConversationID(row.conversationID),
  );
  const staleIDs = Array.from(
    new Set(
      rows
        .map((row) => normalizeStoredConversationID(row.conversationID))
        .filter((id) => id && id !== registered.conversationID),
    ),
  );
  if (!hasBlankID && staleIDs.length === 0) {
    return { status: "unchanged" };
  }
  if (staleIDs.length > 1) {
    return refused(params, "multiple stale conversation ids found");
  }
  if (
    staleIDs[0] &&
    canonicalIDConflictsWithRegistered(staleIDs[0], registered)
  ) {
    return refused(
      params,
      "stale conversation id belongs to a different scope",
    );
  }

  if (registered.kind === "paper") {
    const evidence = getPaperContextOwnershipEvidenceFromRows(
      await params.getPaperContextRows(registered.conversationKey),
    );
    const registeredPaperItemID = registered.paperItemID || 0;
    if (
      evidence.paperItemIDs.length > 0 &&
      registeredPaperItemID &&
      !evidence.paperItemIDs.includes(registeredPaperItemID)
    ) {
      return refused(
        params,
        evidence.singlePaperItemID
          ? `message context points to paper ${evidence.singlePaperItemID}, not ${registeredPaperItemID}`
          : `message context does not include registered paper ${registeredPaperItemID}`,
      );
    }
  }

  const staleID = staleIDs[0] || "";
  await params.queryAsync(
    `UPDATE ${params.tableName}
     SET conversation_id = ?
     WHERE conversation_key = ?
       AND (
         conversation_id IS NULL OR TRIM(conversation_id) = ''
         ${staleID ? "OR conversation_id = ?" : ""}
       )`,
    staleID
      ? [registered.conversationID, registered.conversationKey, staleID]
      : [registered.conversationID, registered.conversationKey],
  );
  return { status: "repaired" };
}

export async function repairRecoverableCatalogMessageConversationIDs(params: {
  queryAsync: QueryAsync;
  catalogTable: string;
  messageTable: string;
  system: ConversationSystem;
  kindSql: string;
  paperItemIDSql: string;
  filterSql?: string;
  filterParams?: unknown[];
  getPaperContextRows: (
    conversationKey: number,
  ) => Promise<PaperContextJsonColumns[]>;
  storeLabel: string;
  log?: (message: string) => void;
}): Promise<ConversationCatalogMessageIdentityRepairSummary> {
  const rows = (await params.queryAsync(
    `SELECT c.conversation_id AS conversationID,
            c.conversation_key AS conversationKey,
            c.library_id AS libraryID,
            ${params.kindSql} AS kind,
            ${params.paperItemIDSql} AS paperItemID
     FROM ${params.catalogTable} c
     WHERE c.conversation_id IS NOT NULL
       AND TRIM(c.conversation_id) <> ''
       ${params.filterSql ? `AND (${params.filterSql})` : ""}`,
    params.filterParams || [],
  )) as Array<{
    conversationID?: unknown;
    conversationKey?: unknown;
    libraryID?: unknown;
    kind?: unknown;
    paperItemID?: unknown;
  }> | undefined;

  const summary: ConversationCatalogMessageIdentityRepairSummary = {
    checked: 0,
    repaired: 0,
    refused: 0,
  };

  for (const row of rows || []) {
    const conversationID = normalizeStoredConversationID(row.conversationID);
    const conversationKey = normalizePositiveInt(row.conversationKey);
    const libraryID = normalizePositiveInt(row.libraryID);
    const kind = normalizeKind(row.kind);
    const paperItemID = normalizePositiveInt(row.paperItemID);
    if (!conversationID || !conversationKey || !libraryID || !kind) continue;
    if (kind === "paper" && !paperItemID) continue;
    summary.checked += 1;
    const result = await repairRecoverableMessageConversationIDs({
      queryAsync: params.queryAsync,
      tableName: params.messageTable,
      registered: {
        conversationID,
        conversationKey,
        system: params.system,
        kind,
        profileSignature: "",
        libraryID,
        paperItemID: kind === "paper" ? paperItemID : null,
        valid: true,
      },
      getPaperContextRows: params.getPaperContextRows,
      storeLabel: params.storeLabel,
      log: params.log,
    });
    if (result.status === "repaired") {
      summary.repaired += 1;
    } else if (result.status === "refused") {
      summary.refused += 1;
    }
  }

  return summary;
}
