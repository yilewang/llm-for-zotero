import { getAgentApi } from "../../../../agent";
import type {
  AgentConfirmationResolution,
  AgentPendingAction,
} from "../../../../agent/types";
import {
  ACTION_COMPLETION_DISMISS_MS,
  formatActionCompletionCountdown,
  formatActionLabel,
  type ActionCompletionFeedback,
} from "../../actionStatusText";
import { renderPendingActionCard } from "../../agentTrace/render";

const PAGED_REVIEW_TRANSITION_ACTION_IDS = new Set([
  "next",
  "previous",
  "refresh",
]);

export type ActionProgressIndicator = {
  setStep(stepName: string, index: number, total: number): void;
  setSummary(summary: string): void;
  hide(): void;
  remove(): void;
};

export type ActionCommandLifecycle = {
  closeActionHitlPanel: () => void;
  createActionProgressIndicator: (actionName: string) => ActionProgressIndicator;
  showActionCompletionCard: (feedback: ActionCompletionFeedback) => void;
  showActionHitlCard: (
    requestId: string,
    action: AgentPendingAction,
  ) => Promise<AgentConfirmationResolution>;
};

export function renderActionCompletionCard(
  doc: Document,
  feedback: ActionCompletionFeedback,
  secondsRemaining = ACTION_COMPLETION_DISMISS_MS / 1000,
): HTMLDivElement {
  const card = doc.createElement("div");
  card.className = "llm-agent-hitl-card llm-agent-hitl-card-complete";

  const header = doc.createElement("div");
  header.className = "llm-agent-hitl-header";
  header.textContent = feedback.status === "failure" ? "Failed" : "Complete";
  card.appendChild(header);

  const title = doc.createElement("div");
  title.className = "llm-agent-hitl-title";
  title.textContent = feedback.title;
  card.appendChild(title);

  if (feedback.description) {
    const description = doc.createElement("div");
    description.className = "llm-agent-hitl-description";
    description.textContent = feedback.description;
    card.appendChild(description);
  }

  const countdown = doc.createElement("div");
  countdown.className = "llm-agent-hitl-description";
  countdown.setAttribute("data-action-completion-countdown", "true");
  countdown.textContent = formatActionCompletionCountdown(secondsRemaining);
  card.appendChild(countdown);

  return card;
}

export function attachActionCompletionEscapeDismissal(
  doc: Document,
  onDismiss: () => void,
): () => void {
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onDismiss();
  };
  doc.addEventListener("keydown", handleKeyDown, true);
  return () => doc.removeEventListener("keydown", handleKeyDown, true);
}

export function isPagedReviewNavigationResolution(
  action: AgentPendingAction,
  resolution: AgentConfirmationResolution,
): boolean {
  if (resolution.approved || action.mode !== "review") return false;
  const actionId = resolution.actionId || "";
  if (!PAGED_REVIEW_TRANSITION_ACTION_IDS.has(actionId)) return false;
  return Boolean(action.actions?.some((entry) => entry.id === actionId));
}

export function getPagedReviewTransitionText(actionId: string | undefined): {
  title: string;
  description: string;
} {
  if (actionId === "previous") {
    return {
      title: "Rendering previous page",
      description: "Preparing the previous review page.",
    };
  }
  if (actionId === "refresh") {
    return {
      title: "Refreshing review page",
      description: "Reloading the library state and recalculating this page.",
    };
  }
  return {
    title: "Rendering next page",
    description: "Preparing the next review page.",
  };
}

export function renderActionTransitionCard(
  doc: Document,
  actionId?: string,
): HTMLDivElement {
  const card = doc.createElement("div");
  card.className = "llm-agent-hitl-card llm-agent-hitl-card-transition";
  card.setAttribute("role", "status");
  card.setAttribute("aria-live", "polite");

  const header = doc.createElement("div");
  header.className = "llm-agent-hitl-header";
  header.textContent = "Working";
  card.appendChild(header);

  const { title: titleText, description: descriptionText } =
    getPagedReviewTransitionText(actionId);
  const title = doc.createElement("div");
  title.className = "llm-agent-hitl-title";
  title.textContent = titleText;
  card.appendChild(title);

  const description = doc.createElement("div");
  description.className = "llm-agent-hitl-description";
  description.textContent = descriptionText;
  card.appendChild(description);

  const typing = doc.createElement("div");
  typing.className = "llm-typing llm-agent-hitl-transition-typing";
  typing.setAttribute("aria-hidden", "true");
  typing.innerHTML =
    '<span class="llm-typing-dot"></span><span class="llm-typing-dot"></span><span class="llm-typing-dot"></span>';
  card.appendChild(typing);

  return card;
}

export function createActionCommandLifecycle(params: {
  body: Element;
  actionHitlPanel: HTMLDivElement | null;
  chatBox: HTMLDivElement | null;
  syncHasActionCardAttr: () => void;
}): ActionCommandLifecycle {
  const { actionHitlPanel, body, chatBox, syncHasActionCardAttr } = params;
  let actionCompletionDismissTimer: ReturnType<typeof setTimeout> | null = null;
  let actionCompletionCountdownTimer: ReturnType<typeof setInterval> | null =
    null;
  let actionCompletionEscapeCleanup: (() => void) | null = null;

  const clearActionCompletionTimers = () => {
    if (actionCompletionDismissTimer) {
      clearTimeout(actionCompletionDismissTimer);
      actionCompletionDismissTimer = null;
    }
    if (actionCompletionCountdownTimer) {
      clearInterval(actionCompletionCountdownTimer);
      actionCompletionCountdownTimer = null;
    }
    actionCompletionEscapeCleanup?.();
    actionCompletionEscapeCleanup = null;
  };

  const closeActionHitlPanel = () => {
    clearActionCompletionTimers();
    if (actionHitlPanel) {
      actionHitlPanel.style.display = "none";
      actionHitlPanel.innerHTML = "";
    }
    chatBox?.querySelector(".llm-action-inline-card")?.remove();
    syncHasActionCardAttr();
  };

  const showPagedReviewTransitionCard = (actionId?: string): void => {
    const ownerDoc = body.ownerDocument;
    if (!ownerDoc || !chatBox) return;
    clearActionCompletionTimers();
    let wrapper = chatBox.querySelector(
      ".llm-action-inline-card-review",
    ) as HTMLDivElement | null;
    if (!wrapper) {
      chatBox.querySelector(".llm-action-inline-card")?.remove();
      wrapper = ownerDoc.createElement("div");
      wrapper.className =
        "llm-action-inline-card llm-action-inline-card-review";
      chatBox.appendChild(wrapper);
    }
    wrapper.innerHTML = "";
    wrapper.appendChild(renderActionTransitionCard(ownerDoc, actionId));
    chatBox.scrollTop = chatBox.scrollHeight;
    syncHasActionCardAttr();
  };

  const showActionHitlCard = (
    requestId: string,
    action: AgentPendingAction,
  ): Promise<AgentConfirmationResolution> =>
    new Promise((resolve) => {
      getAgentApi().registerPendingConfirmation(requestId, (resolution) => {
        if (!resolution.approved) {
          if (isPagedReviewNavigationResolution(action, resolution)) {
            showPagedReviewTransitionCard(resolution.actionId);
          } else {
            closeActionHitlPanel();
          }
        }
        resolve(resolution);
      });
      const ownerDoc = body.ownerDocument;
      if (!ownerDoc || !chatBox) return;
      clearActionCompletionTimers();
      chatBox.querySelector(".llm-action-inline-card")?.remove();
      const wrapper = ownerDoc.createElement("div");
      wrapper.className =
        "llm-action-inline-card llm-action-inline-card-review";
      wrapper.appendChild(
        renderPendingActionCard(ownerDoc, { requestId, action }),
      );
      chatBox.appendChild(wrapper);
      chatBox.scrollTop = chatBox.scrollHeight;
      syncHasActionCardAttr();
    });

  const showActionCompletionCard = (
    feedback: ActionCompletionFeedback,
  ): void => {
    const ownerDoc = body.ownerDocument;
    if (!ownerDoc || !chatBox) return;
    clearActionCompletionTimers();
    chatBox.querySelector(".llm-action-progress-card")?.remove();
    chatBox.querySelector(".llm-action-inline-card")?.remove();
    const wrapper = ownerDoc.createElement("div");
    wrapper.className = "llm-action-inline-card llm-action-inline-card-status";
    const totalMs = feedback.autoDismissMs || ACTION_COMPLETION_DISMISS_MS;
    const startedAt = Date.now();
    const card = renderActionCompletionCard(ownerDoc, feedback, totalMs / 1000);
    wrapper.appendChild(card);
    chatBox.appendChild(wrapper);
    chatBox.scrollTop = chatBox.scrollHeight;
    syncHasActionCardAttr();

    const countdownEl = wrapper.querySelector(
      "[data-action-completion-countdown]",
    );
    const updateCountdown = () => {
      const remainingSeconds = Math.max(
        1,
        Math.ceil((startedAt + totalMs - Date.now()) / 1000),
      );
      if (countdownEl) {
        countdownEl.textContent =
          formatActionCompletionCountdown(remainingSeconds);
      }
    };
    updateCountdown();
    const dismissCompletionCard = () => {
      if (wrapper.isConnected) wrapper.remove();
      clearActionCompletionTimers();
      syncHasActionCardAttr();
    };
    actionCompletionEscapeCleanup = attachActionCompletionEscapeDismissal(
      ownerDoc,
      dismissCompletionCard,
    );
    actionCompletionCountdownTimer = setInterval(updateCountdown, 1000);
    actionCompletionDismissTimer = setTimeout(dismissCompletionCard, totalMs);
  };

  const createActionProgressIndicator = (
    actionName: string,
  ): ActionProgressIndicator => {
    const ownerDoc = body.ownerDocument;
    let element: HTMLDivElement | null = null;
    let stepText: HTMLDivElement | null = null;
    let summaryText: HTMLDivElement | null = null;

    const ensureMounted = () => {
      if (!ownerDoc || !chatBox) return;
      if (element && element.isConnected) return;
      chatBox.querySelector(".llm-action-progress-card")?.remove();
      const wrapper = ownerDoc.createElement("div");
      wrapper.className = "llm-action-progress-card";
      const header = ownerDoc.createElement("div");
      header.className = "llm-action-progress-header";
      const title = ownerDoc.createElement("div");
      title.className = "llm-action-progress-title";
      title.textContent = `${formatActionLabel(actionName)}`;
      const typing = ownerDoc.createElement("div");
      typing.className = "llm-typing llm-action-progress-typing";
      typing.innerHTML =
        '<span class="llm-typing-dot"></span><span class="llm-typing-dot"></span><span class="llm-typing-dot"></span>';
      header.append(title, typing);
      wrapper.appendChild(header);
      stepText = ownerDoc.createElement("div");
      stepText.className = "llm-action-progress-step";
      stepText.textContent = "Starting...";
      wrapper.appendChild(stepText);
      summaryText = ownerDoc.createElement("div");
      summaryText.className = "llm-action-progress-summary";
      summaryText.textContent = "";
      wrapper.appendChild(summaryText);
      chatBox.appendChild(wrapper);
      chatBox.scrollTop = chatBox.scrollHeight;
      element = wrapper;
      syncHasActionCardAttr();
    };

    ensureMounted();
    return {
      setStep(stepName: string, index: number, total: number) {
        ensureMounted();
        if (stepText) stepText.textContent = `${stepName} (${index}/${total})`;
        if (summaryText) summaryText.textContent = "";
      },
      setSummary(summary: string) {
        ensureMounted();
        if (summaryText) summaryText.textContent = summary;
      },
      hide() {
        element?.remove();
        element = null;
        stepText = null;
        summaryText = null;
        syncHasActionCardAttr();
      },
      remove() {
        element?.remove();
        element = null;
        stepText = null;
        summaryText = null;
        syncHasActionCardAttr();
      },
    };
  };

  return {
    closeActionHitlPanel,
    createActionProgressIndicator,
    showActionCompletionCard,
    showActionHitlCard,
  };
}
