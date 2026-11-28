import { getAgentRuntime } from "../../../agent";
import type { AgentToolPresentation } from "../../../agent/types";
import { resolveClaudeCodeToolPresentation } from "./claudeCodeToolPresentation";

/**
 * How the trace asks a tool how to present itself.
 *
 * The lookup is by tool name, and the name is used as identity and nothing
 * else: the renderer never asks "is this tool called X" to decide what a row
 * means. Everything a row says comes either from the event that produced it
 * or from the hooks this returns, which the tool that ran wrote itself.
 *
 * A name the registry does not know falls back to Claude Code's own
 * built-ins (Bash, Read, Edit...), which describe themselves from their
 * arguments. Anything else -- a tool since renamed or removed -- resolves to
 * nothing, and every caller falls back to what the event alone says.
 */
export function resolveAgentToolPresentation(
  name: string,
): AgentToolPresentation | undefined {
  let registered: AgentToolPresentation | undefined;
  try {
    registered = getAgentRuntime().getToolDefinition(name)?.presentation;
  } catch {
    registered = undefined;
  }
  return registered || resolveClaudeCodeToolPresentation(name);
}
