import type { ConversationSystem } from "../types";

/**
 * The tables of the three conversation stores, in one place.
 *
 * The upstream store keeps a catalog per kind (global and paper) and one
 * messages table; each runtime store (Claude Code, Codex) keeps one catalog
 * with a `kind` column and one messages table.  The names are persisted, so
 * they never change.
 *
 * Satellites that scan every store (integrity, registry, key ledger, search
 * index, paper restore, attachment cleanup) read their table lists from here.
 * The order is fixed: upstream global, upstream paper, Claude Code, Codex.
 * Callers that build SQL from these lists depend on it.
 */
export type ConversationCatalogKind = "global" | "paper";

export type ConversationStoreTables = {
  system: ConversationSystem;
  messageTable: string;
  /** The catalog each kind's rows sit in (one table for a runtime store). */
  catalogTables: Readonly<Record<ConversationCatalogKind, string>>;
};

export type ConversationCatalogTable = {
  system: ConversationSystem;
  catalogTable: string;
  messageTable: string;
  /**
   * The kind of every row in the catalog, or null when the catalog holds
   * both kinds and says which in its `kind` column.
   */
  kind: ConversationCatalogKind | null;
};

const UPSTREAM_MESSAGES_TABLE = "llm_for_zotero_chat_messages";
const UPSTREAM_GLOBAL_CATALOG_TABLE = "llm_for_zotero_global_conversations";
const UPSTREAM_PAPER_CATALOG_TABLE = "llm_for_zotero_paper_conversations";
const CLAUDE_MESSAGES_TABLE = "llm_for_zotero_claude_messages";
const CLAUDE_CATALOG_TABLE = "llm_for_zotero_claude_conversations";
const CODEX_MESSAGES_TABLE = "llm_for_zotero_codex_messages";
const CODEX_CATALOG_TABLE = "llm_for_zotero_codex_conversations";

/** Each store's tables, by store. */
export const CONVERSATION_STORE_TABLES_BY_SYSTEM: Readonly<
  Record<ConversationSystem, ConversationStoreTables>
> = {
  upstream: {
    system: "upstream",
    messageTable: UPSTREAM_MESSAGES_TABLE,
    catalogTables: {
      global: UPSTREAM_GLOBAL_CATALOG_TABLE,
      paper: UPSTREAM_PAPER_CATALOG_TABLE,
    },
  },
  claude_code: {
    system: "claude_code",
    messageTable: CLAUDE_MESSAGES_TABLE,
    catalogTables: {
      global: CLAUDE_CATALOG_TABLE,
      paper: CLAUDE_CATALOG_TABLE,
    },
  },
  codex: {
    system: "codex",
    messageTable: CODEX_MESSAGES_TABLE,
    catalogTables: { global: CODEX_CATALOG_TABLE, paper: CODEX_CATALOG_TABLE },
  },
};

/** Every store's tables, in store order: upstream, Claude Code, Codex. */
export const CONVERSATION_STORE_TABLES: readonly ConversationStoreTables[] = [
  CONVERSATION_STORE_TABLES_BY_SYSTEM.upstream,
  CONVERSATION_STORE_TABLES_BY_SYSTEM.claude_code,
  CONVERSATION_STORE_TABLES_BY_SYSTEM.codex,
];

/**
 * Every catalog table once, in store order: upstream global, upstream paper,
 * Claude Code, Codex.
 */
export const CONVERSATION_CATALOG_TABLES: readonly ConversationCatalogTable[] =
  CONVERSATION_STORE_TABLES.flatMap((store): ConversationCatalogTable[] =>
    store.catalogTables.global === store.catalogTables.paper
      ? [
          {
            system: store.system,
            catalogTable: store.catalogTables.global,
            messageTable: store.messageTable,
            kind: null,
          },
        ]
      : (["global", "paper"] as const).map((kind) => ({
          system: store.system,
          catalogTable: store.catalogTables[kind],
          messageTable: store.messageTable,
          kind,
        })),
  );

/** Every messages table, in store order: upstream, Claude Code, Codex. */
export const CONVERSATION_MESSAGE_TABLES: readonly string[] =
  CONVERSATION_STORE_TABLES.map((store) => store.messageTable);

/** The tables of one store, or undefined for a value that names no store. */
export function getConversationStoreTables(
  system: unknown,
): ConversationStoreTables | undefined {
  return CONVERSATION_STORE_TABLES.find((store) => store.system === system);
}

/** The store's catalogs, in order (upstream: global then paper). */
export function getConversationCatalogTables(
  system: ConversationSystem,
): ConversationCatalogTable[] {
  return CONVERSATION_CATALOG_TABLES.filter(
    (catalog) => catalog.system === system,
  );
}

/**
 * The catalog a conversation of this store and kind sits in, or undefined for
 * a value that names no store or no kind.
 */
export function getConversationCatalogTable(
  system: unknown,
  kind: unknown,
): string | undefined {
  if (kind !== "global" && kind !== "paper") return undefined;
  return getConversationStoreTables(system)?.catalogTables[kind];
}
