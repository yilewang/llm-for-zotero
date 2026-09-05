import type {
  AgentRuntimeRequestInput,
  ResolvedAgentRuntimeRequest,
} from "../types";
import {
  buildTurnPaperScope,
  type TurnPaperScopeBuildResult,
} from "./turnPaperScope";
import type { PaperContextRef } from "../../shared/types";
import { createZoteroMetadataResolver } from "../../services/zoteroMetadata/resolver";
import { createZoteroTurnMetadataContext } from "../../services/zoteroMetadata/projections";
import type { ZoteroTurnMetadataContext } from "../../services/zoteroMetadata/types";
import type { TurnPaperScope } from "./turnPaperScope";

export type AgentRequestPaperContextResolver = (selector: {
  itemId?: number;
  contextItemId?: number;
}) => PaperContextRef | null;

export class InvalidTurnPaperScopeError extends Error {
  constructor(
    readonly result: Extract<TurnPaperScopeBuildResult, { ok: false }>,
  ) {
    super(result.message);
    this.name = "InvalidTurnPaperScopeError";
  }
}

export function resolveZoteroTurnMetadataContext(
  scope: TurnPaperScope,
): ZoteroTurnMetadataContext {
  const resolver = createZoteroMetadataResolver();
  const refs = [
    ...scope.papers.map(({ paper }) => paper),
    ...scope.selectedPassagePaperRefs.map(({ paper }) => paper),
  ];
  const seen = new Set<string>();
  return createZoteroTurnMetadataContext(
    refs
      .filter((paper) => {
        const key = `${paper.libraryID}:${paper.itemId}:${paper.contextItemId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((paper) => ({
        ref: paper,
        resolution: resolver.resolvePaperMetadata(paper),
      })),
  );
}

/**
 * One-way runtime boundary from UI/persisted compatibility fields to the
 * canonical per-turn paper scope.
 */
export function resolveAgentRuntimeRequest(
  input: AgentRuntimeRequestInput,
  options: { resolvePaperContext?: AgentRequestPaperContextResolver } = {},
): ResolvedAgentRuntimeRequest {
  const scopeResult = buildTurnPaperScope({
    libraryID: input.libraryID,
    conversationKind: input.conversationKind,
    activeItemId: input.activeItemId,
    activePaperContext: input.activePaperContext,
    selectedPaperContexts: input.selectedPaperContexts,
    pdfPaperContexts: input.pdfPaperContexts,
    fullTextPaperContexts: input.fullTextPaperContexts,
    pinnedPaperContexts: input.pinnedPaperContexts,
    selectedCollectionContexts: input.selectedCollectionContexts,
    selectedTagContexts: input.selectedTagContexts,
    selectedTextContexts: input.selectedTextContexts,
    selectedTexts: input.selectedTexts,
    selectedTextSources: input.selectedTextSources,
    selectedTextNoteContexts: input.selectedTextNoteContexts,
    selectedTextPaperContexts: input.selectedTextPaperContexts,
    resolvedSelectedTextAnchors: input.resolvedSelectedTextAnchors,
    localDocuments: input.localDocuments,
    resolvePaperContext: options.resolvePaperContext,
  });
  if (!scopeResult.ok) throw new InvalidTurnPaperScopeError(scopeResult);

  const {
    activePaperContext: _activePaperContext,
    selectedPaperContexts: _selectedPaperContexts,
    pdfPaperContexts: _pdfPaperContexts,
    fullTextPaperContexts: _fullTextPaperContexts,
    citationPaperContexts: _citationPaperContexts,
    pinnedPaperContexts: _pinnedPaperContexts,
    selectedCollectionContexts: _selectedCollectionContexts,
    selectedTagContexts: _selectedTagContexts,
    selectedTextPaperContexts: _selectedTextPaperContexts,
    selectedTextContexts: _selectedTextContexts,
    resolvedSelectedTextAnchors: _resolvedSelectedTextAnchors,
    localDocuments: _localDocuments,
    ...rest
  } = input;
  void _activePaperContext;
  void _selectedPaperContexts;
  void _pdfPaperContexts;
  void _fullTextPaperContexts;
  void _citationPaperContexts;
  void _pinnedPaperContexts;
  void _selectedCollectionContexts;
  void _selectedTagContexts;
  void _selectedTextPaperContexts;
  void _selectedTextContexts;
  void _resolvedSelectedTextAnchors;
  void _localDocuments;

  return {
    ...rest,
    turnPaperScope: scopeResult.scope,
    zoteroMetadataContext: resolveZoteroTurnMetadataContext(scopeResult.scope),
    selectedTextContexts: scopeResult.selectedTextContexts.length
      ? scopeResult.selectedTextContexts
      : undefined,
    resolvedSelectedTextAnchors: scopeResult.resolvedSelectedTextAnchors.length
      ? scopeResult.resolvedSelectedTextAnchors
      : undefined,
    localDocuments: scopeResult.localDocuments.length
      ? scopeResult.localDocuments
      : undefined,
    turnPaperScopeWarnings: scopeResult.warnings.length
      ? scopeResult.warnings
      : undefined,
  };
}
