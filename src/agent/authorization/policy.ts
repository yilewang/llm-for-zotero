import type {
  ActionConstraint,
  ActionDomain,
  ActionEffect,
  ActionMechanism,
  ActionProposal,
  AuthorizationDecision,
  OriginalAuthorizationContext,
} from "./types";

function constraint(
  effects: ActionEffect[],
  domains: ActionDomain[],
  description: string,
): Extract<ActionConstraint, { kind: "deny_effects" }> {
  return { kind: "deny_effects", effects, domains, description };
}

function mechanismConstraint(
  mechanisms: Exclude<ActionMechanism, "none">[],
  description: string,
): ActionConstraint {
  return { kind: "deny_mechanisms", mechanisms, description };
}

export function proposalViolatesConstraints(
  proposal: Pick<
    ActionProposal,
    "operation" | "domains" | "effects" | "invocationPlan"
  >,
  constraints: readonly ActionConstraint[],
): ActionConstraint | null {
  return (
    constraints.find((constraint) => {
      if (constraint.kind === "deny_mechanisms") {
        return (
          proposal.invocationPlan.mechanism !== "none" &&
          constraint.mechanisms.includes(proposal.invocationPlan.mechanism)
        );
      }
      if (
        constraint.operations?.length &&
        proposal.invocationPlan.mechanism === "none" &&
        proposal.invocationPlan.assurance === "runtime_enforced" &&
        !proposal.operation
          .split("+")
          .some((operation) => constraint.operations!.includes(operation))
      )
        return false;
      if (
        constraint.exceptOperations?.includes(proposal.operation) &&
        proposal.invocationPlan.mechanism === "none" &&
        proposal.invocationPlan.assurance === "runtime_enforced"
      )
        return false;
      return (
        proposal.domains.some((domain) =>
          constraint.domains.includes(domain),
        ) &&
        proposal.effects.some((effect) => constraint.effects.includes(effect))
      );
    }) || null
  );
}

export function normalizeStoredActionConstraints(
  constraints:
    | readonly (ActionConstraint | { kind: "no_write"; description: string })[]
    | undefined,
): ActionConstraint[] {
  return (constraints || []).flatMap((entry) => {
    if (entry.kind === "deny_mechanisms") return [entry];
    if (entry.kind === "deny_effects") {
      const executeDenied = entry.effects.includes("execute");
      const effects = entry.effects.filter((effect) => effect !== "execute");
      return [
        ...(effects.length ? [{ ...entry, effects }] : []),
        ...(executeDenied
          ? [mechanismConstraint(["shell", "zotero_script"], entry.description)]
          : []),
      ];
    }
    return [
      constraint(
        ["create", "modify", "delete"],
        [
          "zotero_library",
          "filesystem",
          "local_execution",
          "privileged_zotero",
        ],
        entry.description,
      ),
      mechanismConstraint(["shell", "zotero_script"], entry.description),
    ];
  });
}

export function authorizeOriginalAction(
  proposal: ActionProposal,
  context: OriginalAuthorizationContext,
): AuthorizationDecision {
  const violation = proposalViolatesConstraints(
    proposal,
    context.constraints || [],
  );
  if (violation) {
    return {
      kind: "block",
      reason: violation.description,
    };
  }
  if (
    context.semantic?.conversationOnly &&
    (proposal.capabilities.includes("zotero.notes") ||
      proposal.capabilities.includes("file.write"))
  ) {
    return {
      kind: "block",
      reason:
        "Remember this within the conversation only. The user did not request a saved note or file; answer from the paper and retain the discussion in chat.",
    };
  }
  const integrityFailure = actionIntegrityFailure(proposal);
  if (integrityFailure) return integrityFailure;
  const trustedRead =
    proposal.invocationPlan.impact === "read_only" &&
    proposal.invocationPlan.assurance !== "unknown";
  if (trustedRead) {
    return { kind: "execute", authority: "safe_read" };
  }
  const requested = Boolean(
    context.hasMatchingActionIntent || context.hasApprovedPlanAuthority,
  );
  // Yolo delegates judgment: an effect the interpreter did not predict may
  // still run once every hard rail above has passed. Safe and auto require
  // the exact requested authority.
  if (!requested && context.mode !== "yolo") {
    return {
      kind: "block",
      reason: "The proposed effect has no matching semantic action authority.",
    };
  }
  if (
    proposal.capabilities.includes("zotero.import") &&
    (context.semantic?.literature === "discover" ||
      context.semantic?.literature === "select_then_import")
  ) {
    return {
      kind: "block",
      reason:
        "Paper discovery requires user selection in every permission mode. Call literature_review with the ranked candidates; only its approved selection may initiate the import.",
    };
  }
  if (
    context.interaction?.entryPoint === "action_ui" ||
    context.interaction?.reviewPreference === "review"
  ) {
    return {
      kind: "confirm",
      reason: "Review the prepared changes before applying them, as requested.",
    };
  }
  if (context.hasApprovedPlanAuthority) {
    return { kind: "execute", authority: "plan_approval" };
  }
  // Creating requested research material is not a review step. This exemption
  // applies only after the exact native note action matched the turn contract;
  // edits, scripts, extra effects, ambiguity and explicit prohibitions retain
  // their normal authorization path.
  if (
    context.hasMatchingActionIntent &&
    proposal.operation === "note_create" &&
    proposal.capabilities.length === 1 &&
    proposal.capabilities[0] === "zotero.notes" &&
    proposal.invocationPlan.mechanism === "none" &&
    proposal.invocationPlan.impact === "state_change" &&
    proposal.invocationPlan.assurance === "runtime_enforced" &&
    proposal.domains.length === 1 &&
    proposal.domains[0] === "zotero_library" &&
    proposal.effects.length === 1 &&
    proposal.effects[0] === "create" &&
    !proposal.riskSignals.length
  ) {
    return { kind: "execute", authority: "requested_note" };
  }
  if (context.mode === "safe") {
    return {
      kind: "confirm",
      reason: "Safe mode reviews this action before it runs.",
    };
  }
  if (context.mode === "yolo") {
    return {
      kind: "execute",
      authority: requested ? "yolo" : "yolo_judgment",
    };
  }
  const exceptionalDanger = proposal.riskSignals.some((signal) =>
    [
      "ambiguous_target",
      "scope_expansion",
      "sensitive_egress",
      "broad_delete",
      "privilege_escalation",
      "package_system_modification",
      "download_to_shell",
    ].includes(signal),
  );
  if (exceptionalDanger) {
    return {
      kind: "confirm",
      reason:
        "Auto mode found genuine ambiguity or exceptional danger in the exact action.",
    };
  }
  if (context.hasMatchingActionIntent) {
    return { kind: "execute", authority: "auto_policy" };
  }
  return {
    kind: "block",
    reason: "The proposed effect has no matching semantic action authority.",
  };
}

/** Execution integrity applies independently of which agent owns permission. */
export function actionIntegrityFailure(
  proposal: ActionProposal,
): AuthorizationDecision | null {
  if (
    proposal.invocationPlan.impact === "prohibited" ||
    proposal.riskSignals.includes("protected_target") ||
    proposal.riskSignals.includes("raw_database") ||
    proposal.riskSignals.includes("authorization_tampering")
  ) {
    return {
      kind: "block",
      reason: "The proposed action targets a protected integrity boundary.",
    };
  }
  return null;
}

export function authorizeExternalAction(
  proposal: ActionProposal,
): AuthorizationDecision {
  return (
    actionIntegrityFailure(proposal) || {
      kind: "execute",
      authority: "external_runtime",
    }
  );
}
