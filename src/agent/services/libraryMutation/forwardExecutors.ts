import { attachmentImportExecutors } from "./attachmentImportExecutors";
import { collectionSearchExecutors } from "./collectionSearchExecutors";
import type { ForwardExecutorRegistry } from "./forwardExecutionContracts";
import { itemMetadataTagRelationExecutors } from "./itemMetadataTagRelationExecutors";
import { noteLifecycleExecutors } from "./noteLifecycleExecutors";

export type { ForwardExecution } from "./forwardExecutionContracts";

export const forwardExecutors = {
  ...itemMetadataTagRelationExecutors,
  ...collectionSearchExecutors,
  ...noteLifecycleExecutors,
  ...attachmentImportExecutors,
} satisfies ForwardExecutorRegistry;
