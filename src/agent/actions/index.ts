import { ActionRegistry } from "./registry";
import { auditLibraryAction } from "./auditLibrary";
import { organizeUnfiledAction } from "./organizeUnfiled";
import { autoTagAction } from "./autoTag";
import { discoverRelatedAction } from "./discoverRelated";
import { completeMetadataAction } from "./completeMetadata";

export function createBuiltInActionRegistry(): ActionRegistry {
  const registry = new ActionRegistry();
  registry.register(auditLibraryAction);
  registry.register(organizeUnfiledAction);
  registry.register(autoTagAction);
  registry.register(discoverRelatedAction);
  registry.register(completeMetadataAction);
  return registry;
}

export { ActionRegistry } from "./registry";
export type {
  AgentAction,
  ActionExecutionContext,
  ActionConfirmationMode,
  ActionProgressEvent,
  ActionCheckpoint,
  ActionResult,
  ActionLLMConfig,
  ActionRequestContext,
} from "./types";
export type {
  PaperScopedActionProfile,
  PaperScopedActionInput,
  PaperScopedActionCollectionCandidate,
  PaperScopedActionTagCandidate,
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
