/**
 * One history list for Agent, Codex and Claude Code chats.
 *
 * Each runtime keeps its own catalog, but conversation keys never overlap
 * across runtimes (shared/conversationKeySpace.ts), so rows of several
 * runtimes can share one list and every cache keyed by conversation key.
 *
 * The rules, decided with the user (2026-10-18):
 * - The list shows the built-in runtime plus the runtimes that are on in
 *   Preferences; rows of a runtime that is off are hidden.
 * - Only the panel's own runtime shows its empty "Draft" row.
 * - Note sessions and side chats list only the panel's own runtime.
 *
 * The "Add past conversation" picker (pastConversationSource.ts) has its own
 * list rules (no drafts, no search fallbacks) and does not use this file.
 */
import { appLogger } from "../../core/logging";
import {
  conversationRepository,
  type ConversationCatalogEntry,
} from "../../core/conversations/repository";
import type { ConversationSystem } from "../../shared/types";

/** Display order of the runtimes; it never decides a row's position. */
export const UNIFIED_HISTORY_SYSTEM_ORDER: readonly ConversationSystem[] = [
  "upstream",
  "codex",
  "claude_code",
];

/**
 * The runtimes whose chats a history list shows.
 * `singleSystem` (a note session or a side chat) keeps only the panel's own.
 * The panel's own runtime is always included, so the chat it shows stays
 * listed even if its runtime was just turned off in Preferences.
 */
export function resolveUnifiedHistorySystems(params: {
  activeSystem: ConversationSystem;
  codexEnabled: boolean;
  claudeEnabled: boolean;
  singleSystem: boolean;
}): ConversationSystem[] {
  if (params.singleSystem) return [params.activeSystem];
  return UNIFIED_HISTORY_SYSTEM_ORDER.filter(
    (system) =>
      system === "upstream" ||
      system === params.activeSystem ||
      (system === "codex" && params.codexEnabled) ||
      (system === "claude_code" && params.claudeEnabled),
  );
}

/**
 * True when a row from another runtime may be listed: it has a user turn.
 * Rows of the panel's own runtime are always kept (its draft rules apply).
 */
export function isUnifiedHistoryRowListed(
  row: { system: ConversationSystem; userTurnCount?: number | null },
  activeSystem: ConversationSystem,
): boolean {
  if (row.system === activeSystem) return true;
  return Number(row.userTurnCount || 0) > 0;
}

/**
 * Merges the catalog rows of several runtimes into one list.
 * Drops web chat session rows, empty rows of other runtimes, rows queued for
 * deletion, and repeats; then sorts newest first (the larger key breaks a
 * tie) and keeps at most `limit` rows.
 */
export function mergeUnifiedHistoryCatalogEntries(
  perSystem: ReadonlyArray<{
    system: ConversationSystem;
    rows: readonly ConversationCatalogEntry[];
  }>,
  options: {
    activeSystem: ConversationSystem;
    limit: number;
    isPendingDeletion?: (conversationKey: number) => boolean;
  },
): ConversationCatalogEntry[] {
  const seen = new Set<number>();
  const merged: ConversationCatalogEntry[] = [];
  for (const { system, rows } of perSystem) {
    for (const row of rows) {
      const conversationKey = Number(row.conversationKey);
      if (!Number.isFinite(conversationKey) || conversationKey <= 0) continue;
      const key = Math.floor(conversationKey);
      if (row.webchatSession === true) continue;
      // A row is listed under the runtime whose catalog returned it.
      const entry = row.system === system ? row : { ...row, system };
      if (!isUnifiedHistoryRowListed(entry, options.activeSystem)) continue;
      if (options.isPendingDeletion?.(key)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }
  const activity = (row: ConversationCatalogEntry) =>
    Number(row.lastActivityAt || row.createdAt || 0) || 0;
  merged.sort((a, b) => {
    const delta = activity(b) - activity(a);
    if (delta !== 0) return delta;
    return b.conversationKey - a.conversationKey;
  });
  const limit = Number.isFinite(options.limit)
    ? Math.max(0, Math.floor(options.limit))
    : merged.length;
  return merged.slice(0, limit);
}

/**
 * Catalog rows of one history scope (library chats, or one paper's chats)
 * from every runtime in `systems`, merged newest first.
 * Each runtime is read with the same limit; only the panel's own runtime
 * reads its empty drafts. A runtime whose catalog cannot be read adds no
 * rows. Rows keep their `system`.
 */
export async function listUnifiedHistoryEntries(params: {
  libraryID: number;
  scope: "global" | "paper";
  paperItemID?: number;
  systems: readonly ConversationSystem[];
  activeSystem: ConversationSystem;
  limit: number;
  isPendingDeletion?: (conversationKey: number) => boolean;
}): Promise<ConversationCatalogEntry[]> {
  if (!(params.libraryID > 0)) return [];
  if (params.scope === "paper" && !(Number(params.paperItemID) > 0)) return [];
  const perSystem = await Promise.all(
    params.systems.map(async (system) => {
      try {
        const rows = await conversationRepository.listCatalogEntries({
          system,
          kind: params.scope,
          libraryID: params.libraryID,
          ...(params.scope === "paper"
            ? { paperItemID: params.paperItemID }
            : {}),
          limit: params.limit,
          includeEmpty: system === params.activeSystem,
        });
        return {
          system,
          rows:
            params.scope === "paper"
              ? rows.filter(
                  (row) =>
                    Number(row.paperItemID) === Number(params.paperItemID),
                )
              : rows,
        };
      } catch (err) {
        appLogger.warn("LLM: Failed to load history rows of a runtime", {
          system,
          scope: params.scope,
          error: err,
        });
        return { system, rows: [] as ConversationCatalogEntry[] };
      }
    }),
  );
  return mergeUnifiedHistoryCatalogEntries(perSystem, {
    activeSystem: params.activeSystem,
    limit: params.limit,
    isPendingDeletion: params.isPendingDeletion,
  });
}
