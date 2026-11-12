import type {
  ActionProposal,
  AuthorizationDecision,
  AuthorizationAssessment,
  OriginalAuthorizationContext,
} from "./types";

export function authorizeOriginalAction(
  proposal: ActionProposal,
  context: OriginalAuthorizationContext,
): AuthorizationAssessment {
  const integrityFailure = actionIntegrityFailure(proposal);
  if (integrityFailure) return integrityFailure;
  const trustedRead =
    proposal.invocationPlan.impact === "read_only" &&
    proposal.invocationPlan.assurance !== "unknown";
  if (trustedRead) {
    return { kind: "execute", authority: "safe_read" };
  }
  const chatLibraryID = context.executionContext?.chatLibraryID;
  const isLibraryWrite =
    proposal.domains.includes("zotero_library") &&
    proposal.effects.some((effect) => effect !== "read");
  if (context.executionContext && isLibraryWrite && !chatLibraryID) {
    return {
      kind: "block",
      reason:
        "The chat library is unresolved. Resolve and freeze its native identity before changing Zotero state.",
    };
  }
  // A user-requested review is a workflow requirement, not an automatic permission gate.
  if (context.interaction?.reviewPreference === "review") {
    return {
      kind: "confirm",
      reason: "Review the prepared changes before applying them, as requested.",
    };
  }
  // YOLO delegates permission decisions, including risk and filesystem/library expansion.
  if (context.mode === "yolo") {
    return { kind: "execute", authority: "yolo_judgment" };
  }
  if (context.mode === "safe") {
    return {
      kind: "confirm",
      reason: "Safe mode reviews every external write before it runs.",
    };
  }
  const plan = proposal.invocationPlan;
  // The user's rule for Zotero scripts: Auto runs them directly, as Yolo
  // does; Safe asked above. Hard risk signals were blocked first
  // (`actionIntegrityFailure`). Other mechanisms of unknown effect, such as
  // an unparsed shell command, still go to the model review below.
  if (plan.mechanism === "zotero_script") {
    return { kind: "execute", authority: "auto_policy" };
  }
  const known = plan.impact === "state_change" && plan.assurance !== "unknown";
  const localEffects = proposal.effects.every((effect) =>
    ["read", "create", "modify", "delete"].includes(effect),
  );
  const reversible = known && localEffects && proposal.reversibility === "full";
  const routineWrite =
    known &&
    !proposal.riskSignals.length &&
    proposal.effects.every((effect) =>
      ["read", "create", "modify"].includes(effect),
    ) &&
    (plan.assurance === "runtime_enforced" ||
      (proposal.effects.includes("create") &&
        !proposal.effects.includes("modify")));
  if (reversible || routineWrite) {
    return { kind: "execute", authority: "auto_policy" };
  }
  return {
    kind: "model_review",
    reason:
      "Assess this action against the user's intention and its concrete effects.",
  };
}

/** Execution integrity applies independently of which agent owns permission. */
export function actionIntegrityFailure(
  proposal: ActionProposal,
): AuthorizationDecision | null {
  if (
    proposal.invocationPlan.impact === "prohibited" ||
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
