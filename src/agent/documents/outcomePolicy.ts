import type { AgentRuntimeRequest } from "../types";
import type { DocumentOutcomePolicy, DocumentSpec } from "./types";

const NO_DOCUMENT: DocumentOutcomePolicy = {
  required: false,
  documentKind: "custom",
  integrityPolicy: "authored",
  trigger: "none",
};

export function resolveDocumentOutcomePolicy(params: {
  request: Pick<AgentRuntimeRequest, "classifiedIntent" | "planContext">;
  plannedDocumentKind?: DocumentSpec["kind"];
  plannedResearch?: boolean;
}): DocumentOutcomePolicy {
  if (params.request.planContext?.phase === "planning") return NO_DOCUMENT;
  if (params.request.classifiedIntent?.semantic?.materialOutputs?.length) {
    return {
      required: true,
      documentKind: params.request.classifiedIntent.documentKind || "custom",
      integrityPolicy: "authored",
      trigger: "workflow_material",
    };
  }
  if (params.request.planContext?.phase === "executing") {
    return params.plannedDocumentKind
      ? {
          required: true,
          documentKind: params.plannedDocumentKind,
          integrityPolicy:
            params.plannedResearch ||
            params.plannedDocumentKind === "literature_review"
              ? "research_grounded"
              : "authored",
          trigger: "plan_deliverable",
        }
      : NO_DOCUMENT;
  }
  if (params.request.classifiedIntent?.deliverableIntent === "document") {
    const documentKind =
      params.request.classifiedIntent.documentKind || "custom";
    return {
      required: true,
      documentKind,
      integrityPolicy:
        documentKind === "literature_review" ? "research_grounded" : "authored",
      trigger:
        documentKind === "literature_review"
          ? "literature_review_intent"
          : "document_intent",
    };
  }
  return NO_DOCUMENT;
}
