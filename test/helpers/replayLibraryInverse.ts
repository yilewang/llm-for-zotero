import type { AgentToolContext } from "../../src/agent/types";
import type {
  LibraryMutationExecution,
  LibraryMutationService,
} from "../../src/agent/services/libraryMutationService";

export async function replayLibraryInverse(
  service: LibraryMutationService,
  execution: LibraryMutationExecution,
  context: AgentToolContext = {
    request: { conversationKey: 1, libraryID: 1 },
  } as AgentToolContext,
): Promise<void> {
  for (const operation of execution.inverse?.inverseOperations || []) {
    await service.executeOperation(operation, context);
  }
}
