import type {
  AgentActionCapability,
  AgentActionContract,
  AgentActionObligation,
  AgentActionOperation,
  AgentActionProgressLedger,
  AgentActionReceipt,
  AgentToolEffect,
} from "../types";
import { innermostToolResult } from "./toolResultEnvelope";

export type ContractEvaluation = {
  state:
    | "pending"
    | "satisfied"
    | "partial"
    | "cancelled"
    | "failed"
    | "unverified";
  correction?: string;
  failure?: string;
};

const ACTION_CORRECTION_GUIDANCE: Partial<
  Record<AgentActionCapability, string>
> = {
  "zotero.tags":
    "Use library_search to resolve IDs, then library_update with the exact tag verb and values.",
  "zotero.metadata":
    "Use library_search to resolve IDs, then library_update with the exact metadata operation.",
  "zotero.collections":
    "Use collection_update or library_update with the exact collection operation.",
  "zotero.notes":
    "Use note_write or note_write_batch with the requested edit mode.",
  "zotero.import": "Use library_import with the requested import mode.",
  "zotero.trash":
    "Use library_delete with the exact trash, restore, or merge operation.",
  "zotero.attachments":
    "Use attachment_update with the exact attachment operation.",
  "zotero.read": "Use paper_read with mode:'full'.",
  "zotero.settings": "Use library_settings with the exact key and value.",
  "zotero.undo": "Use the requested undo or revert operation.",
  "file.write": "Use file_io with the exact path and content.",
  "command.execute": "Use run_command for the explicitly requested command.",
  "zotero.script":
    "Use zotero_script only for the explicitly requested execution.",
};

export function actionToolGuidanceForCapabilities(
  capabilities: Iterable<AgentActionCapability>,
): string {
  return [
    ...new Set(
      [...capabilities]
        .map((capability) => ACTION_CORRECTION_GUIDANCE[capability])
        .filter((entry): entry is string => Boolean(entry)),
    ),
  ].join(" ");
}

export function createUnverifiedReceipt(params: {
  capability?: AgentActionCapability;
  operation?: AgentActionOperation;
  proofDomain?: AgentActionReceipt["proofDomain"];
  status?: AgentActionReceipt["status"];
  reason: string;
}): AgentActionReceipt {
  const operation = params.operation || "read_full";
  return {
    version: 2,
    id: `unverified:${operation}:${Date.now()}`,
    proposalId: `unverified:${operation}`,
    proofDomain: params.proofDomain || "zotero_state",
    capability: params.capability || "zotero.read",
    operation,
    verification:
      params.status === "cancelled" ? "not_applicable" : "unverified",
    status: params.status || "failed",
    requestedTargets: [],
    appliedTargets: [],
    alreadySatisfiedTargets: [],
    rejectedTargets: [],
    reasons: [params.reason],
    verifiedFacts: [],
  };
}

/** Used only outside the configured Agent contract service. */
export function createFallbackToolReceipts(params: {
  toolName: string;
  mutability: "read" | "write";
  input: unknown;
  ok: boolean;
  effect?: AgentToolEffect;
  cancelled?: boolean;
  reason?: string;
  content?: unknown;
}): AgentActionReceipt[] {
  if (
    params.mutability === "read" &&
    params.ok &&
    params.input &&
    typeof params.input === "object" &&
    (params.input as { mode?: unknown }).mode === "full"
  ) {
    return [
      {
        version: 2,
        id: "read_full:fallback",
        proposalId: "read_full:fallback",
        proofDomain: "zotero_state",
        capability: "zotero.read",
        operation: "read_full",
        verification: "verified",
        status: "observed",
        requestedTargets: [],
        appliedTargets: [],
        alreadySatisfiedTargets: [],
        rejectedTargets: [],
        reasons: [],
        verifiedFacts: ["read_mode:full"],
      },
    ];
  }
  if (params.mutability === "read") return [];
  const operation: AgentActionOperation =
    params.toolName === "file_io"
      ? "file_write"
      : params.toolName === "run_command"
        ? "command_execute"
        : params.toolName === "zotero_script"
          ? "zotero_script_execute"
          : "read_full";
  const capability: AgentActionCapability =
    params.toolName === "file_io"
      ? "file.write"
      : params.toolName === "run_command"
        ? "command.execute"
        : params.toolName === "zotero_script"
          ? "zotero.script"
          : "zotero.read";
  if (params.toolName === "file_io" && params.ok) {
    const content = innermostToolResult(params.content);
    const filePath = String(content.filePath || "");
    const expected = String(content.expectedContentHash || "");
    const actual = String(content.contentHash || "");
    const verified =
      Boolean(filePath) &&
      content.exists === true &&
      Boolean(actual) &&
      expected === actual;
    return [
      {
        version: 2,
        id: `file_write:fallback:${filePath}`,
        proposalId: `file_write:fallback:${filePath}`,
        proofDomain: "file_state",
        capability: "file.write",
        operation: "file_write",
        verification: verified ? "verified" : "unverified",
        status: verified ? "applied" : "unverified",
        requestedTargets: filePath ? [`file:${filePath}`] : [],
        appliedTargets: verified ? [`file:${filePath}`] : [],
        alreadySatisfiedTargets: [],
        rejectedTargets: verified || !filePath ? [] : [`file:${filePath}`],
        reasons: verified
          ? []
          : [
              "The file write did not include exact-path content readback proof.",
            ],
        verifiedFacts: [],
        evidenceRef: verified ? `sha256:${actual}` : undefined,
      },
    ];
  }
  if (
    (params.toolName === "run_command" ||
      params.toolName === "zotero_script") &&
    params.ok
  ) {
    return [
      {
        version: 2,
        id: `${operation}:fallback`,
        proposalId: `${operation}:fallback`,
        proofDomain: "execution",
        capability,
        operation,
        verification: "execution_only",
        status: "observed",
        requestedTargets: [],
        appliedTargets: [],
        alreadySatisfiedTargets: [],
        rejectedTargets: [],
        reasons: [],
        verifiedFacts: [],
      },
    ];
  }
  return [
    createUnverifiedReceipt({
      operation,
      capability,
      proofDomain:
        params.toolName === "file_io"
          ? "file_state"
          : params.toolName === "run_command" ||
              params.toolName === "zotero_script"
            ? "execution"
            : "zotero_state",
      status: params.cancelled
        ? "cancelled"
        : params.ok && params.effect === "partial"
          ? "partial"
          : params.ok
            ? "unverified"
            : "failed",
      reason:
        params.reason ||
        "No typed action verifier is configured for this execution path.",
    }),
  ];
}

function itemTarget(itemId: number): string {
  return `item:${itemId}`;
}

function receiptMatches(
  receipt: AgentActionReceipt,
  obligation: AgentActionObligation,
): boolean {
  return receipt.obligationId
    ? receipt.obligationId === obligation.id
    : receipt.operation === obligation.operation &&
        receipt.proofDomain === obligation.proofDomain;
}

function receiptVerified(receipt: AgentActionReceipt): boolean {
  return (
    receipt.verification === "verified" &&
    (receipt.status === "applied" ||
      receipt.status === "already_satisfied" ||
      receipt.status === "observed")
  );
}

export function evaluateActionContract(
  contract: AgentActionContract,
  receipts: AgentActionReceipt[],
  progress?: AgentActionProgressLedger,
): ContractEvaluation {
  if (contract.writeDisposition === "uncertain") {
    return {
      state: "failed",
      failure:
        "I could not determine whether you intended a write, so no mutation was allowed. Please state the exact action and target scope.",
    };
  }
  if (!contract.obligations.length) {
    if (contract.writeDisposition === "none") {
      const blockedWrites = receipts.filter(
        (receipt) =>
          receipt.proposalId === "missing-proposal" ||
          receipt.operation !== "read_full",
      );
      if (!blockedWrites.length) return { state: "satisfied" };
      return {
        state: "failed",
        correction:
          "Correction for this turn: the request authorized no writes, and a mutation attempt was blocked. Do not retry or claim that anything changed; answer the original request using read-only tools only.",
        failure:
          "A model-originated write was blocked because this request authorized no mutations. No library or file change was verified.",
      };
    }
    return {
      state: "failed",
      failure:
        "The requested write could not be represented as a valid typed obligation, so no mutation was allowed.",
    };
  }

  const missing: AgentActionObligation[] = [];
  const failed: AgentActionObligation[] = [];
  let sawPartial = false;
  let sawUnverified = false;
  for (const obligation of contract.obligations) {
    const obligationProgress = progress?.obligations.find(
      (entry) => entry.obligationId === obligation.id,
    );
    if (obligationProgress?.status === "cancelled") {
      return {
        state: "cancelled",
        failure: `The requested ${obligation.operation} action was cancelled; no corrective retry was attempted.`,
      };
    }
    if (
      obligationProgress?.status === "fulfilled" ||
      obligationProgress?.status === "already_satisfied"
    ) {
      continue;
    }
    const matching = receipts.filter((receipt) =>
      receiptMatches(receipt, obligation),
    );
    const verified = matching.filter(receiptVerified);
    if (
      matching.some((receipt) => receipt.status === "cancelled") &&
      !verified.length
    ) {
      return {
        state: "cancelled",
        failure: `The requested ${obligation.operation} action was cancelled; no corrective retry was attempted.`,
      };
    }
    if (matching.some((receipt) => receipt.status === "failed")) {
      failed.push(obligation);
    }
    if (obligation.targetBoundary && obligation.scopeRole !== "destination") {
      const covered = new Set(
        verified.flatMap((receipt) => [
          ...receipt.appliedTargets,
          ...receipt.alreadySatisfiedTargets,
        ]),
      );
      if (
        !obligation.targetBoundary.frozenTargetIds.every((itemId) =>
          covered.has(itemTarget(itemId)),
        )
      ) {
        missing.push(obligation);
      }
    } else if (!verified.length) {
      missing.push(obligation);
    }
    sawPartial ||= matching.some((receipt) => receipt.status === "partial");
    sawUnverified ||= matching.some(
      (receipt) => receipt.verification === "unverified",
    );
  }
  if (!missing.length) return { state: "satisfied" };

  const labels = missing.map((obligation) => {
    const scope = obligation.scope
      ? ` in exact collection "${obligation.scope.collectionPath}" (${obligation.targetBoundary?.frozenTargetIds.length || 0} frozen targets)`
      : obligation.targetBoundary?.kind === "library"
        ? ` in frozen library scope (${obligation.targetBoundary.frozenTargetIds.length} targets)`
        : "";
    return `${obligation.operation} coverage:${obligation.coverage}${scope}`;
  });
  const failureReasons = [
    ...new Set(
      missing.flatMap((obligation) =>
        receipts
          .filter((receipt) => receiptMatches(receipt, obligation))
          .flatMap((receipt) => receipt.reasons),
      ),
    ),
  ];
  const state = failed.length
    ? "failed"
    : sawPartial
      ? "partial"
      : sawUnverified
        ? "unverified"
        : "pending";
  const guidance = actionToolGuidanceForCapabilities(
    missing.map((obligation) => obligation.capability),
  );
  return {
    state,
    correction:
      `Correction for this turn: open typed obligation(s): ${labels.join("; ")}. ` +
      `${guidance} Retry only unresolved targets. Completion requires independently verified post-state; a successful call, command exit, script output, or model prose is not semantic proof.`,
    failure:
      `I could not verify completion of: ${labels.join("; ")}.` +
      (failureReasons.length ? ` ${failureReasons.join("; ")}` : ""),
  };
}

export function formatReceiptStatus(receipts: AgentActionReceipt[]): string {
  return receipts
    .map((receipt) => {
      const verified =
        receipt.appliedTargets.length + receipt.alreadySatisfiedTargets.length;
      const coverage = receipt.requestedTargets.length
        ? ` ${verified}/${receipt.requestedTargets.length}`
        : "";
      return `[Action status: ${receipt.operation} — ${receipt.status}${coverage}; ${receipt.verification}; proof:${receipt.proofDomain}]`;
    })
    .join("\n");
}
