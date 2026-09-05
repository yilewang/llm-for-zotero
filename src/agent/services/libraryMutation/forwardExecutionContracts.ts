import type { AgentToolContext } from "../../types";
import type { ZoteroGateway } from "../zoteroGateway";
import type {
  LibraryMutationExecutionResult,
  LibraryMutationInverse,
  LibraryMutationOperation,
} from "./contracts";

export type ForwardExecution = {
  result: LibraryMutationExecutionResult;
  inverse?: LibraryMutationInverse | null;
};

export type ForwardExecutor<Type extends LibraryMutationOperation["type"]> = (
  operation: Extract<LibraryMutationOperation, { type: Type }>,
  context: AgentToolContext,
  zoteroGateway: ZoteroGateway,
) => Promise<ForwardExecution>;

export type ForwardExecutorRegistry = {
  [Type in LibraryMutationOperation["type"]]: ForwardExecutor<Type>;
};
