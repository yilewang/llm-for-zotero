import type {
  AgentToolCall,
  AgentToolName,
  AgentToolTarget,
} from "./types";

export function normalizePaperToolTarget(
  target: AgentToolTarget | undefined,
): AgentToolTarget | null {
  if (!target) return null;
  switch (target.scope) {
    case "active-paper":
      return { scope: "active-paper" };
    case "selected-paper":
    case "pinned-paper":
    case "recent-paper":
    case "retrieved-paper": {
      const parsed = Math.floor(Number(target.index));
      if (!Number.isFinite(parsed) || parsed < 1) return null;
      return { scope: target.scope, index: parsed };
    }
    default:
      return null;
  }
}

export function validateSinglePaperToolCall(
  expectedName: AgentToolName,
  call: AgentToolCall,
): AgentToolCall | null {
  if (call.name !== expectedName) return null;
  const normalizedTarget = normalizePaperToolTarget(call.target);
  if (!normalizedTarget) return null;
  return {
    name: expectedName,
    target: normalizedTarget,
  };
}
