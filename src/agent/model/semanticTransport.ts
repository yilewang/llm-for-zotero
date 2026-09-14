import { workflowCheckpointEvidence } from "../contracts/workflowCheckpoint";
import { getAllSkills } from "../skills/catalog";
import type { AgentSkill } from "../skills/skillLoader";
import { OPERATION_CATALOG } from "../contracts/operationCatalog";
import { getAbortController } from "../../utils/apiHelpers";
import { getNotesDirectoryConfig } from "../../utils/notesDirectoryConfig";
import type { AgentRuntimeRequest } from "../types";
import {
  callUtilityLLM,
  type UtilityLLMParams,
  type UtilityLLMResult,
} from "../../utils/utilityLLM";
import { DEFAULT_CODEX_API_BASE } from "../../utils/llmClient";
import { sha256Text } from "../store/journalRecoveryBlobStore";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";

/** Utility interpretation uses the shared provider-aware low/off reasoning policy. */
export const SEMANTIC_COMPLETION_TIMEOUT_MS = 20_000;

export async function semanticInputDigest(
  request: AgentRuntimeRequest,
  destinations = getNotesDirectoryConfig(),
  skills: readonly AgentSkill[] = getAllSkills(),
): Promise<string> {
  return sha256Text(
    canonicalJson({
      conversationKey: request.conversationKey,
      generation: request.conversationGeneration,
      sourceMessageTimestamp: request.metadata?.sourceMessageTimestamp,
      scopeType: request.scopeType,
      scopeId: request.scopeId,
      scopeLabel: request.scopeLabel,
      forcedSkillIds: request.forcedSkillIds,
      userText: request.userText,
      libraryID: request.libraryID,
      activeItemId: request.activeItemId,
      scope: request.turnPaperScope,
      activeNote: request.activeNoteContext,
      destinations,
      configuredInstructions: {
        systemPrompt: request.systemPrompt,
        customInstructions: request.customInstructions,
      },
      attachments: request.attachments,
      screenshots: request.screenshots,
      localDocuments: request.localDocuments,
      selectedTextContexts: request.selectedTextContexts,
      resolvedSelectedTextAnchors: request.resolvedSelectedTextAnchors,
      supportedOperations: OPERATION_CATALOG,
      skills: skills
        .map(
          ({
            id,
            description,
            version,
            contexts,
            activation,
            supersedes,
            instruction,
            source,
          }) => ({
            id,
            description,
            version,
            contexts,
            activation,
            supersedes,
            instruction,
            source,
          }),
        )
        .sort((a, b) => a.id.localeCompare(b.id)),
      workflow: request.planContext,
      workflowCheckpoint: workflowCheckpointEvidence(
        request.workflowCheckpoint,
      ),
      selectedTexts: request.selectedTexts,
      selectedTextSources: request.selectedTextSources,
      history: request.history,
      clarificationHistory: request.clarificationHistory,
    }),
  );
}

export async function callSemanticCompletion(
  request: AgentRuntimeRequest,
  params: UtilityLLMParams,
): Promise<UtilityLLMResult> {
  if (request.semanticProvider?.kind === "claude" && !params.llmCall) {
    const Controller = getAbortController();
    if (!Controller) return { ok: false, reason: "not_configured" };
    const controller = new Controller();
    const abort = () => controller.abort();
    if (params.signal?.aborted) return { ok: false, reason: "transport" };
    params.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, params.timeoutMs);
    try {
      const base = request.semanticProvider.baseUrl.replace(/\/$/, "");
      const health = await fetch(`${base}/healthz`, {
        signal: controller.signal,
      });
      if (!health.ok) return { ok: false, reason: "transport" };
      const capabilities = (await health.json()) as { capabilities?: string[] };
      if (!capabilities.capabilities?.includes("structured_completion_v1"))
        return { ok: false, reason: "not_configured" };
      const response = await fetch(`${base}/structured-completion`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: params.prompt,
          model: request.model,
          timeoutMs: params.timeoutMs,
        }),
      });
      if (!response.ok) return { ok: false, reason: "transport" };
      const result = (await response.json()) as { text?: unknown };
      return typeof result.text === "string" && result.text.trim()
        ? { ok: true, text: result.text }
        : { ok: false, reason: "empty" };
    } catch {
      return {
        ok: false,
        reason: controller.signal.aborted ? "timeout" : "transport",
      };
    } finally {
      clearTimeout(timer);
      params.signal?.removeEventListener("abort", abort);
    }
  }
  const codex = request.authMode === "codex_app_server";
  return callUtilityLLM({
    ...params,
    model: request.model,
    apiBase: codex ? DEFAULT_CODEX_API_BASE : request.apiBase,
    apiKey: request.apiKey,
    authMode: codex ? "codex_auth" : request.authMode || "api_key",
    providerProtocol: codex ? "codex_responses" : request.providerProtocol,
    profileOverride: request.advanced?.profileOverride,
  });
}

/** Cached interpretation is authority only for the same frozen input. */
export async function hasCurrentSemanticIntent(
  request: AgentRuntimeRequest,
): Promise<boolean> {
  return (
    request.classifiedIntent?.semantic?.version === 1 &&
    request.classifiedIntent.semantic.inputDigest ===
      (await semanticInputDigest(request))
  );
}
