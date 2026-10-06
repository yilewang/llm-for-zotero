import { clearRetrievalCandidateCache } from "../../src/modules/contextPanel/multiContextPlanner";
import { configureRetrievalCandidateInvalidator } from "../../src/services/retrieval/cacheInvalidation";

/**
 * Panel-owned capabilities that services reach through `src/services/**`
 * bridges. The plugin composes them once at startup (see
 * `src/modules/contextPanel/hostSurfaces.ts`); a unit suite that drives one of
 * those code paths stands in for that surface with the same implementation,
 * rather than depending on whichever module another test file imported first.
 *
 * Each function returns a disposer to be called from the suite's `after`.
 */
export function composeRetrievalCandidateInvalidation(): () => void {
  return configureRetrievalCandidateInvalidator(clearRetrievalCandidateCache);
}
