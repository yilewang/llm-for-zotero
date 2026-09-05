import type { AgentToolContext } from "../../types";
import type { ZoteroGateway } from "../zoteroGateway";
import type { LibraryMutationOperation } from "./contracts";
import { attachmentImportExecutors } from "./attachmentImportExecutors";
import { collectionSearchExecutors } from "./collectionSearchExecutors";
import type {
  ForwardExecution,
  ForwardExecutorRegistry,
} from "./forwardExecutionContracts";
import { itemMetadataTagRelationExecutors } from "./itemMetadataTagRelationExecutors";
import { noteLifecycleExecutors } from "./noteLifecycleExecutors";

export type { ForwardExecution } from "./forwardExecutionContracts";

export const forwardExecutors = {
  ...itemMetadataTagRelationExecutors,
  ...collectionSearchExecutors,
  ...noteLifecycleExecutors,
  ...attachmentImportExecutors,
} satisfies ForwardExecutorRegistry;

export function executeLibraryMutation(
  operation: LibraryMutationOperation,
  context: AgentToolContext,
  zoteroGateway: ZoteroGateway,
): Promise<ForwardExecution> {
  return forwardExecutors[operation.type](
    operation as never,
    context,
    zoteroGateway,
  );
}
