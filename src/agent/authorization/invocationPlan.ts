import type { AgentInvocationPlan } from "../types";
import type {
  ActionDomain,
  ActionEffect,
  ActionMechanism,
  ActionRiskSignal,
} from "./types";

type PlanFields = {
  mechanism?: ActionMechanism;
  assurance?: AgentInvocationPlan["assurance"];
  domains?: ActionDomain[];
  effects?: ActionEffect[];
  targets?: string[];
  riskSignals?: ActionRiskSignal[];
  reversibility?: AgentInvocationPlan["reversibility"];
  reason: string;
};

export function readOnlyInvocationPlan(
  fields: PlanFields,
): AgentInvocationPlan {
  return {
    mechanism: fields.mechanism || "none",
    impact: "read_only",
    assurance: fields.assurance || "runtime_enforced",
    domains: fields.domains || ["zotero_library"],
    effects: fields.effects || ["read"],
    targets: fields.targets || [],
    riskSignals: fields.riskSignals || [],
    reversibility: fields.reversibility || "full",
    reason: fields.reason,
  };
}

export function stateChangeInvocationPlan(
  fields: PlanFields,
): AgentInvocationPlan {
  return {
    mechanism: fields.mechanism || "none",
    impact: "state_change",
    assurance: fields.assurance || "runtime_enforced",
    domains: fields.domains || ["zotero_library"],
    effects: fields.effects || ["modify"],
    targets: fields.targets || [],
    riskSignals: fields.riskSignals || [],
    reversibility: fields.reversibility || "none",
    reason: fields.reason,
  };
}

export function ambiguousInvocationPlan(
  fields: PlanFields,
): AgentInvocationPlan {
  return {
    mechanism: fields.mechanism || "none",
    impact: "ambiguous",
    assurance: "unknown",
    domains: fields.domains || ["local_execution"],
    effects: fields.effects || ["read", "modify"],
    targets: fields.targets || [],
    riskSignals: fields.riskSignals || [],
    reversibility: fields.reversibility || "none",
    reason: fields.reason,
  };
}

export function prohibitedInvocationPlan(
  fields: PlanFields,
): AgentInvocationPlan {
  return {
    mechanism: fields.mechanism || "none",
    impact: "prohibited",
    assurance: fields.assurance || "statically_recognized",
    domains: fields.domains || ["local_execution"],
    effects: fields.effects || ["modify"],
    targets: fields.targets || [],
    riskSignals: fields.riskSignals || [],
    reversibility: "none",
    reason: fields.reason,
  };
}

export function defaultInvocationPlan(
  executionClass: "read" | "control" | "external_effect",
): AgentInvocationPlan {
  if (executionClass === "external_effect") {
    return ambiguousInvocationPlan({
      domains: ["zotero_library"],
      effects: ["modify"],
      reason:
        "This external-effect tool did not provide an operation-specific invocation plan.",
    });
  }
  return readOnlyInvocationPlan({
    reason:
      executionClass === "control"
        ? "This host-owned control operation has no external effect."
        : "This host-owned tool exposes a read-only operation.",
  });
}
