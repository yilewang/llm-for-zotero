import { ActionRegistry } from "./registry";
import { auditLibraryAction } from "./auditLibrary";
import { organizeUnfiledAction } from "./organizeUnfiled";
import { autoTagAction } from "./autoTag";
import { discoverRelatedAction } from "./discoverRelated";
import { completeMetadataAction } from "./completeMetadata";
import { literatureReviewAction } from "./literatureReview";
import { libraryStatisticsAction } from "./libraryStatistics";

export function createBuiltInActionRegistry(): ActionRegistry {
  const registry = new ActionRegistry();
  registry.register(auditLibraryAction);
  registry.register(organizeUnfiledAction);
  registry.register(autoTagAction);
  registry.register(discoverRelatedAction);
  registry.register(completeMetadataAction);
  registry.register(literatureReviewAction);
  registry.register(libraryStatisticsAction);
  return registry;
}

export { ActionRegistry } from "./registry";
export type {
  AgentAction,
  ActionExecutionContext,
  ActionConfirmationMode,
  ActionProgressEvent,
  ActionResult,
  ActionServices,
  ActionLLMConfig,
  ActionRequestContext,
} from "./types";
export type {
  PaperScopedActionProfile,
  PaperScopedActionInput,
  PaperScopedActionCollectionCandidate,
  PaperScopedActionTarget,
} from "./paperScope";
export {
  resolvePaperScopedCommandInput,
  resolvePaperScopedActionTargets,
  normalizePaperScopedActionInput,
  normalizePositiveIntArray,
  normalizeLimit,
  applyLimit,
} from "./paperScope";
