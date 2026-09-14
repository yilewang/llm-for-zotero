import type { OriginalAgentPermissionMode } from "../../shared/originalAgentPermissionMode";

export type ActionDomain =
  | "zotero_library"
  | "filesystem"
  | "local_execution"
  | "network"
  | "privileged_zotero";

export type ActionEffect =
  | "read"
  | "create"
  | "modify"
  | "delete"
  | "execute"
  | "egress";

export type ActionMechanism = "none" | "shell" | "zotero_script";

export type ActionConstraint = Readonly<
  | {
      kind: "deny_effects";
      effects: ActionEffect[];
      domains: ActionDomain[];
      /** Narrow native operations explicitly permitted by a qualified prohibition. */
      exceptOperations?: string[];
      /** Restrict this denial to named native operations; opaque effects remain denied. */
      operations?: string[];
      description: string;
    }
  | {
      kind: "deny_mechanisms";
      mechanisms: Exclude<ActionMechanism, "none">[];
      description: string;
    }
>;

export type ActionRiskSignal =
  | "ambiguous_target"
  | "scope_expansion"
  | "sensitive_egress"
  | "broad_delete"
  | "protected_target"
  | "privilege_escalation"
  | "package_system_modification"
  | "download_to_shell"
  | "authorization_tampering"
  | "raw_database";

export type ActionProposal = {
  version: 2;
  runtime: "original" | "claude" | "codex" | "external";
  toolName: string;
  operation: string;
  capabilities: string[];
  domains: ActionDomain[];
  effects: ActionEffect[];
  targets: string[];
  summary: string;
  reversibility: "full" | "partial" | "none";
  riskSignals: ActionRiskSignal[];
  invocationPlan: import("../types").AgentInvocationPlan;
  intentBinding: {
    conversationKey?: number;
    conversationGeneration?: number;
    actionContractId?: string;
    userIntentDigest?: string;
  };
  payloadDigest: string;
};

export type AuthorizationDecision =
  | {
      kind: "execute";
      authority:
        | "safe_read"
        | "external_runtime"
        | "requested_note"
        | "auto_policy"
        | "yolo"
        | "yolo_judgment"
        | "plan_approval";
    }
  | { kind: "confirm"; reason: string }
  | { kind: "block"; reason: string };

export type ActionInteraction = Readonly<{
  entryPoint: "action_ui" | "conversation";
  reviewPreference: "default" | "review" | "direct";
}>;

export type OriginalAuthorizationContext = {
  /** Resolved by the host from entry point and frozen action intent. */
  interaction?: ActionInteraction;
  mode: OriginalAgentPermissionMode;
  semantic?: import("../model/semanticDecisions").SemanticIntent;
  constraints?: readonly ActionConstraint[];
  /** The exact typed proposal passed the current turn's Action Contract. */
  hasMatchingActionIntent?: boolean;
  /** Host-verified approved-plan scope; never supplied by model tool input. */
  hasApprovedPlanAuthority?: boolean;
};
