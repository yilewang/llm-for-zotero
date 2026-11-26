import type { AgentRuntime } from "../agent/runtime";
import type { ClaudeBridgeGateOptions } from "../agent/externalBackendBridge";
import type { ClaudeSlashCommandDescriptor } from "./runtime";
import { listClaudeSlashCommands } from "./runtime";

export function getClaudeCommandCatalog(
  coreRuntime: AgentRuntime,
  options?: ClaudeBridgeGateOptions,
): ClaudeSlashCommandDescriptor[] {
  return listClaudeSlashCommands(coreRuntime, options);
}
