import { resolveAgentRuntimeRequest } from "../../src/agent/context/resolvedAgentRequest";
import type {
  AgentRuntimeRequestInput,
  ResolvedAgentRuntimeRequest,
} from "../../src/agent/types";

/**
 * Crosses the same raw-to-resolved boundary as Agent dispatch for focused unit
 * tests that exercise downstream runtime helpers directly.
 */
export function resolvedAgentRequest(
  input: AgentRuntimeRequestInput | ResolvedAgentRuntimeRequest,
): ResolvedAgentRuntimeRequest {
  const record = input as AgentRuntimeRequestInput & {
    turnPaperScope?: ResolvedAgentRuntimeRequest["turnPaperScope"];
  };
  const hasLegacyScope = [
    "selectedPaperContexts",
    "pdfPaperContexts",
    "fullTextPaperContexts",
    "pinnedPaperContexts",
    "selectedCollectionContexts",
    "selectedTagContexts",
    "selectedTextPaperContexts",
  ].some((field) => Object.prototype.hasOwnProperty.call(record, field));
  if (record.turnPaperScope && !hasLegacyScope) {
    return input as ResolvedAgentRuntimeRequest;
  }
  const { turnPaperScope, ...raw } = record;
  return resolveAgentRuntimeRequest({
    ...raw,
    libraryID: raw.libraryID || turnPaperScope?.libraryID,
  });
}
