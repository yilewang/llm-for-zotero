import type { ReasoningConfig } from "../shared/llm";

export function buildCodexAppServerReasoningConfig(
  mode: string,
): ReasoningConfig | undefined {
  const effort = mode.trim();
  if (!effort || effort.toLowerCase() === "auto") return undefined;
  return {
    provider: "openai",
    level: "default",
    effort,
  };
}
