import { buildCodexReasoningConfig } from "../codex/catalogSelection";
import type { ReasoningConfig } from "../shared/llm";

export function buildCodexAppServerReasoningConfig(
  mode: string,
): ReasoningConfig | undefined {
  return buildCodexReasoningConfig(mode);
}
