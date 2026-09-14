import type { AgentRuntimeRequest } from "../types";

export type SemanticReferenceCandidate = {
  id: number;
  libraryID: number;
  label: string;
  details: string;
};
export type SemanticReferenceResult =
  | {
      state: "resolved";
      ids: number[];
      reason: string;
      literalEvidence?: Array<{ id: number; quote: string }>;
    }
  | { state: "needs_input"; question: string }
  | { state: "unavailable"; reason: string };

/** The interpreter can select supplied evidence identities; it cannot grant effects. */
export interface SemanticReferenceResolver {
  resolve(input: {
    request: AgentRuntimeRequest;
    entity: "item" | "collection";
    description: string;
    referenceKind?: "literal" | "descriptive";
    candidates: readonly SemanticReferenceCandidate[];
  }): Promise<SemanticReferenceResult>;
}
