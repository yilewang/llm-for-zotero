import type { AgentConfirmationResolution } from "../../../../agent/types";

export type ResolvePendingConfirmation = (
  requestId: string,
  resolution: AgentConfirmationResolution,
) => boolean;

export function cancelVisiblePendingConfirmationCards(
  root: ParentNode | null | undefined,
  resolveConfirmation: ResolvePendingConfirmation,
): string[] {
  if (!root) return [];
  const cards = Array.from(
    root.querySelectorAll(".llm-agent-hitl-card[data-request-id]"),
  ) as HTMLElement[];
  const requestIds = Array.from(
    new Set(
      cards
        .map((card) => card.dataset.requestId?.trim() || "")
        .filter(Boolean),
    ),
  );

  for (const requestId of requestIds) {
    resolveConfirmation(requestId, {
      approved: false,
      actionId: "cancel",
    });
  }

  for (const card of cards) {
    const wrapper = card.closest(".llm-action-inline-card");
    if (wrapper) {
      wrapper.remove();
    } else {
      card.remove();
    }
  }

  return requestIds;
}
