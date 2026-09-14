import type {
  AgentConfirmationResolution,
  AgentPendingAction,
  AgentPendingField,
} from "../agent/types";

export type NativeQuestion = {
  id: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
};

/** Tool-access approvals have their own structured server/tool identity. */
export function readNativeQuestions(request: {
  method: string;
  params: unknown;
}): NativeQuestion[] | null {
  if (request.method !== "item/tool/requestUserInput") return null;
  const value = request.params as Record<string, unknown> | null;
  if (
    !value ||
    !value.threadId ||
    !value.turnId ||
    !value.itemId ||
    value.serverName ||
    value.server ||
    value.toolName ||
    value.tool ||
    !Array.isArray(value.questions)
  )
    return null;
  if (!value.questions.length || value.questions.length > 3)
    throw new Error("Invalid Codex planning questions");
  const ids = new Set<string>();
  return value.questions.map((raw) => {
    if (
      !raw ||
      typeof raw.id !== "string" ||
      !raw.id.trim() ||
      ids.has(raw.id) ||
      typeof raw.question !== "string" ||
      !raw.question.trim()
    )
      throw new Error("Invalid Codex planning question");
    if (raw.isSecret)
      throw new Error(
        "Secret input is not supported by the planning question card",
      );
    ids.add(raw.id);
    const options = raw.options == null ? [] : raw.options;
    if (
      !Array.isArray(options) ||
      options.some(
        (option) =>
          !option || typeof option.label !== "string" || !option.label.trim(),
      )
    ) {
      throw new Error("Invalid Codex planning options");
    }
    return { id: raw.id, question: raw.question, options };
  });
}

export function buildNativeQuestionAction(
  questions: NativeQuestion[],
): AgentPendingAction {
  return {
    toolName: "request_user_input",
    title: "Plan needs your input",
    mode: "review",
    confirmLabel: "Continue planning",
    cancelLabel: "Cancel plan",
    fields: questions.map<AgentPendingField>((question) => ({
      type: "choice",
      id: question.id,
      label: question.question,
      requiredForActionIds: ["continue"],
      allowCustom: true,
      customPlaceholder: question.options.length
        ? "Something else…"
        : "Your answer…",
      options: question.options.map((option, i) => ({
        ...option,
        id: `option-${i + 1}`,
      })),
    })),
    actions: [
      { id: "continue", label: "Continue planning", approved: true },
      { id: "cancel", label: "Cancel plan", approved: false },
    ],
    defaultActionId: "continue",
    cancelActionId: "cancel",
  };
}

export function nativeQuestionAnswers(
  questions: NativeQuestion[],
  resolution: AgentConfirmationResolution,
): { answers: Record<string, { answers: string[] }> } {
  const answers: Record<string, { answers: string[] }> = {};
  if (!resolution.approved) return { answers };
  const data = (resolution.data || {}) as Record<string, any>;
  for (const question of questions) {
    const raw = data[question.id];
    const answer =
      typeof raw === "string"
        ? raw.trim()
        : raw?.kind === "custom"
          ? String(raw.text || "").trim()
          : raw?.kind === "option"
            ? question.options.find(
                (_option, i) => raw.optionId === `option-${i + 1}`,
              )?.label
            : undefined;
    if (!answer)
      throw new Error("Answer every planning question before continuing");
    answers[question.id] = { answers: [answer] };
  }
  return { answers };
}
