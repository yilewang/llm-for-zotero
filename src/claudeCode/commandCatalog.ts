import type { AgentRuntime } from "../agent/runtime";
import type { ClaudeBridgeGateOptions } from "../agent/externalBackendBridge";
import type { ClaudeSlashCommandDescriptor } from "./runtime";
import { listClaudeSlashCommands, refreshClaudeSlashCommands } from "./runtime";

export async function refreshClaudeCommandCatalog(
  coreRuntime: AgentRuntime,
  force = false,
): Promise<void> {
  await refreshClaudeSlashCommands(coreRuntime, force);
}

export function getClaudeCommandCatalog(
  coreRuntime: AgentRuntime,
  options?: ClaudeBridgeGateOptions,
): ClaudeSlashCommandDescriptor[] {
  return listClaudeSlashCommands(coreRuntime, options);
}
