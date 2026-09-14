import { resolveUtilityReasoningPlan } from "../../utils/utilityLLM";
import type { AgentRuntimeRequest } from "../types";

/** The supplied note selection is sufficient and no broader workflow is needed. */
export function isSelfContainedSelectionEdit(
  request: AgentRuntimeRequest,
): boolean {
  const intent = request.classifiedIntent;
  return Boolean(
    intent?.semantic?.reading.source === "provided_context" &&
    intent.deliverableIntent !== "document" &&
    !request.documentOutcomePolicy?.required &&
    !request.planContext &&
    intent.actionIntents.length === 1 &&
    intent.actionIntents[0].operation === "note_edit" &&
    intent.externalSearchIntent === "none" &&
    !intent.semantic.materialOutputs?.length &&
    !intent.semantic.supportTools?.length &&
    !request.forcedSkillIds?.length &&
    request.selectedTextContexts?.some((c) => c.source === "note-edit"),
  );
}

export function resolveNoteEditModelRequest(
  request: AgentRuntimeRequest,
): AgentRuntimeRequest {
  if (
    !isSelfContainedSelectionEdit(request) ||
    request.classifiedIntent?.semantic?.generationMode !== "transform" ||
    !request.model
  )
    return request;
  // Reuse the existing provider/capability-aware off-or-low policy. This is a
  // per-generation request copy; user preferences and action authority stay intact.
  const plan = resolveUtilityReasoningPlan({
    model: request.model,
    apiBase: request.apiBase,
    authMode: request.authMode,
    providerProtocol: request.providerProtocol,
    profileOverride: request.advanced?.profileOverride,
  });
  return plan ? { ...request, reasoning: plan.reasoning } : request;
}
