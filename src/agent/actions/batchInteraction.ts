import type { AgentActionContract, ClassifiedTurnIntent } from "../types";
import type { ActionRequestContext } from "./types";

export type BatchInteraction = {
  version: 2;
  entryPoint: "action_ui" | "conversation";
  intentRevision?: number;
  preferences: Array<{
    obligationId: string;
    operation: string;
    reviewPreference: "default" | "review" | "direct";
  }>;
};
export function captureBatchInteraction(request: {
  actionEntryPoint?: "action_ui" | "conversation";
  actionContract?: AgentActionContract;
  classifiedIntent?: ClassifiedTurnIntent;
}): BatchInteraction {
  return {
    version: 2,
    entryPoint: request.actionEntryPoint || "conversation",
    intentRevision: request.classifiedIntent?.semantic?.revision,
    preferences: (request.actionContract?.obligations || []).map((entry) => ({
      obligationId: entry.id,
      operation: entry.operation,
      reviewPreference: entry.reviewPreference || "default",
    })),
  };
}

export function restoreBatchInteraction(
  request: ActionRequestContext,
  stored: unknown,
): ActionRequestContext {
  if (request.classifiedIntent?.semantic?.continuation === "revise")
    return request;
  const value = stored as Partial<BatchInteraction> | undefined;
  const valid =
    value?.version === 2 &&
    ["action_ui", "conversation"].includes(String(value.entryPoint)) &&
    Array.isArray(value.preferences) &&
    value.preferences.every(
      (entry) =>
        typeof entry.obligationId === "string" &&
        typeof entry.operation === "string" &&
        ["default", "review", "direct"].includes(entry.reviewPreference),
    );
  return {
    ...request,
    actionEntryPoint: valid ? value.entryPoint : "conversation",
    actionContract: request.actionContract
      ? {
          ...request.actionContract,
          obligations: request.actionContract.obligations.map((entry) => {
            const matches = valid
              ? value.preferences!.filter(
                  (pref) =>
                    pref.obligationId === entry.id &&
                    pref.operation === entry.operation,
                )
              : [];
            const preference =
              !valid ||
              !matches.length ||
              matches.some((pref) => pref.reviewPreference === "review")
                ? "review"
                : matches[0].reviewPreference;
            return { ...entry, reviewPreference: preference };
          }),
        }
      : request.actionContract,
  };
}
