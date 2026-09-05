import type { AgentToolContext, AgentToolEffect } from "../types";
import type { ZoteroGateway } from "./zoteroGateway";
import {
  executeMutationFromHandler,
  mutationAffectedCountFromHandler,
  mutationTargetCountFromHandler,
  mutationUsesDeferredInverse,
  planMutationInverseFromHandler,
} from "./libraryMutation/handlerOperations";
import type {
  LibraryMutationExecution,
  LibraryMutationOperation,
  LibraryMutationPlan,
  LibraryMutationState,
} from "./libraryMutation/contracts";
import { MutationStateReader } from "./libraryMutation/stateReader";

export * from "./libraryMutation/contracts";

function mutationEffect(
  operation: LibraryMutationOperation,
  affectedCount: number,
): AgentToolEffect {
  if (affectedCount <= 0) return "none";
  const targetCount = mutationTargetCountFromHandler(operation);
  return targetCount > affectedCount ? "partial" : "applied";
}

export class LibraryMutationService {
  private readonly stateReader: MutationStateReader;

  constructor(private readonly zoteroGateway: ZoteroGateway) {
    this.stateReader = new MutationStateReader(zoteroGateway);
  }

  getGateway(): ZoteroGateway {
    return this.zoteroGateway;
  }

  /**
   * Capture the durable inverse before the forward operation starts.
   *
   * Creation/import operations are the deliberate exception: Zotero assigns
   * their IDs at commit time, so their forward intent is prepared first and
   * the inverse is finalized immediately after execution.
   */
  async planOperation(
    operation: LibraryMutationOperation,
    context: AgentToolContext,
  ): Promise<LibraryMutationPlan> {
    const precondition = await this.captureOperationState(operation, context);
    const description = `Apply ${operation.type}`;

    if (mutationUsesDeferredInverse(operation)) {
      return {
        effect: "write",
        reversibility: "partial",
        reason:
          "The created Zotero object IDs are assigned only after commit; an interrupted step is reported as uncertain.",
        description,
        precondition,
        deferredInverse: true,
      };
    }

    const { inverseOperations, reason } = planMutationInverseFromHandler(
      operation,
      precondition,
    );
    const usefulInverse = inverseOperations?.some((inverse) => {
      const record = inverse as unknown as Record<string, unknown>;
      return !Array.isArray(record.itemIds) || record.itemIds.length > 0;
    });
    return {
      effect: "write",
      reversibility: usefulInverse ? (reason ? "partial" : "full") : "none",
      reason: usefulInverse ? reason : reason || "No lossless inverse exists.",
      description,
      inverseOperations: usefulInverse ? inverseOperations : undefined,
      precondition,
    };
  }

  async captureOperationState(
    operation: LibraryMutationOperation,
    context: AgentToolContext,
    executionResult?: unknown,
  ): Promise<LibraryMutationState> {
    return this.stateReader.captureOperationState(
      operation,
      context,
      executionResult,
    );
  }

  async executeOperation(
    operation: LibraryMutationOperation,
    context: AgentToolContext,
  ): Promise<LibraryMutationExecution> {
    const execution = await executeMutationFromHandler(
      operation,
      context,
      this.zoteroGateway,
    );
    const affectedCount = mutationAffectedCountFromHandler(
      operation,
      execution.result.result,
    );
    return {
      ...execution,
      effect: mutationEffect(operation, affectedCount),
      affectedCount,
    };
  }
}
