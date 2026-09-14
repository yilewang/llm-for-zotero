import type {
  AgentPendingAction,
  AgentRunEventRecord,
} from "../../../agent/types";

/** Retain the same logical card while the agent researches the next batch. */
export function getDiscoveryCardProjection(events: AgentRunEventRecord[]) {
  let current:
    | {
        pending: { requestId: string; action: AgentPendingAction };
        phase: "pending" | "loading" | "closed";
      }
    | undefined;
  for (const { payload } of events) {
    if (payload.type === "confirmation_required" && payload.action.discovery) {
      current = {
        pending: { requestId: payload.requestId, action: payload.action },
        phase: "pending",
      };
    } else if (
      current &&
      payload.type === "confirmation_resolved" &&
      payload.requestId === current.pending.requestId
    ) {
      const selected = (
        payload.data as { selectedPaperIds?: unknown } | undefined
      )?.selectedPaperIds;
      current = {
        pending: {
          ...current.pending,
          action: {
            ...current.pending.action,
            fields: current.pending.action.fields.map((field) =>
              field.type === "paper_result_list" && Array.isArray(selected)
                ? {
                    ...field,
                    rows: field.rows.map((row) => ({
                      ...row,
                      checked: selected.includes(row.id),
                    })),
                  }
                : field,
            ),
          },
        },
        phase:
          payload.approved && payload.actionId === "find_more"
            ? "loading"
            : "closed",
      };
    } else if (current && payload.type === "final") {
      current.phase = "closed";
    }
  }
  return current;
}
