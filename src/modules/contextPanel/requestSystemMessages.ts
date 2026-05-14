import type { InputCapEffects } from "../../utils/modelInputCap";
import type { ContextAssemblyStrategy } from "./types";

export function buildContextPlanSystemMessages(params: {
  strategy: ContextAssemblyStrategy;
  assistantInstruction?: string;
  inputCapEffects?: InputCapEffects;
}): string[] {
  const messages: string[] = [];
  if (params.strategy === "paper-followup-retrieval") {
    messages.push(
      [
        "Paper chat has access to the paper's full text.",
        "The retrieved snippets in this request are a focused grounding subset",
        "chosen for this answer, not a statement about limited access.",
        "Never say that you do not have full access to the paper or that you",
        "only have the provided snippets.",
        "If the user asks about access, say that you can access the full paper",
        "and that this answer is grounded in the most relevant retrieved chunks.",
      ].join(" "),
    );
  }

  const assistantInstruction = (params.assistantInstruction || "").trim();
  if (assistantInstruction) {
    messages.push(assistantInstruction);
  }

  const effects = params.inputCapEffects;
  if (
    (params.strategy === "paper-first-full" ||
      params.strategy === "paper-cache-full" ||
      params.strategy === "paper-manual-full") &&
    effects &&
    (effects.documentContextTrimmed || effects.documentContextDropped)
  ) {
    messages.push(
      [
        "Before answering, briefly note that the paper text included for this",
        "reply had to be truncated to fit the model input limit, so coverage",
        "may be incomplete.",
      ].join(" "),
    );
  }

  return messages;
}
