/**
 * The value shapes the gateway's shared internals pass between themselves.
 *
 * These live here rather than on the facade so a capability can build a
 * library target without importing `zoteroGateway.ts` back. The facade
 * re-exports them under their original names, which is the spelling every
 * caller outside this directory still uses.
 */

export type LibraryPaperTargetAttachment = {
  contextItemId: number;
  title: string;
};

export type LibraryPaperTarget = {
  itemId: number;
  libraryID?: number;
  title: string;
  firstCreator?: string;
  year?: string;
  dateAdded?: string;
  dateModified?: string;
  attachments: LibraryPaperTargetAttachment[];
  tags: string[];
  collectionIds: number[];
};

export type LibraryItemTargetAttachment = {
  contextItemId: number;
  title: string;
  filename?: string;
  contentType: string;
  /** For PDF attachments: Zotero full-text indexing state. Omitted for non-PDFs. */
  indexingState?:
    | "indexed"
    | "partial"
    | "unindexed"
    | "queued"
    | "unavailable";
  /** If MinerU has parsed this PDF, the cache directory path containing markdown + images. */
  mineruCacheDir?: string;
  /** Size of the readable text the host already holds for this PDF, when measurable without extraction. */
  readableTextChars?: number;
};

export type LibraryItemTarget = {
  itemId: number;
  libraryID?: number;
  itemType: string;
  title: string;
  firstCreator?: string;
  year?: string;
  dateAdded?: string;
  dateModified?: string;
  attachments: LibraryItemTargetAttachment[];
  tags: string[];
  collectionIds: number[];
  noteKind?: "item" | "standalone";
};

export type CollectionSummary = {
  collectionId: number;
  name: string;
  libraryID: number;
  path?: string;
};

export type AgentLibraryFilters = {
  collectionId?: number;
  unfiled?: boolean;
  hasPdf?: boolean;
  itemType?: string;
  author?: string;
  yearFrom?: number;
  yearTo?: number;
  tag?: string;
  /** List the trash instead of the library. */
  deleted?: boolean;
};

/**
 * One clause of an advanced search, forwarded to `Zotero.Search`.
 *
 * The agent previously had nine hand-written filters against Zotero's own
 * ~130 conditions x 15 operators. Re-implementing that vocabulary a filter at
 * a time is how it stayed nine for so long, so this forwards the vocabulary
 * instead of mirroring it: new Zotero versions add conditions for free.
 */
export type AgentSearchCondition = {
  condition: string;
  operator: string;
  value?: string | number;
  /**
   * Sub-mode for the few conditions that take one, e.g. `fulltextContent`
   * with `phrase` or `regexp`. Zotero spells this `condition/mode`.
   */
  mode?: string;
  /**
   * Keep this clause mandatory under joinMode `any`. Forwarded as Zotero's
   * `required` flag on 7-9 and expressed as a condition group on 10.
   */
  required?: boolean;
};

export type AgentSearchConditionError = {
  condition: string;
  reason: string;
  validOperators?: string[];
};

/**
 * The two item lookups the target builders need.
 *
 * Declared structurally so the builders never name the facade that supplies
 * them: `ZoteroGateway` passes itself — which is what keeps a test's
 * instance-level `getItem` override in effect — and a capability can pass the
 * free functions from `itemResolution.ts` instead.
 */
export type ItemLookup = {
  getItem(itemId: number | undefined): Zotero.Item | null;
  resolveBibliographicItem(
    item: Zotero.Item | null | undefined,
  ): Zotero.Item | null;
};
