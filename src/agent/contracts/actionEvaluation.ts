import type {
  AgentActionCapability,
  AgentActionOperation,
  AgentActionReceipt,
  AgentToolEffect,
} from "../types";
import {
  AGENT_ACTION_VERIFICATION_LABELS,
  readAgentActionVerification,
} from "./actionVerificationLabels";
import { innermostToolResult } from "./toolResultEnvelope";
import { collectionAddOnly, operationCatalogEntry } from "./operationCatalog";

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

/**
 * Shared completion boundary for original and native provider turns: what the
 * turn's own receipts prove. A turn carries no contract of obligations, so an
 * effect counts as done when its receipt says so, and an applied effect the
 * host could not re-read is reported instead of claimed.
 */
export function evaluatePreparedActionContract(
  receipts: AgentActionReceipt[],
): ContractEvaluation {
  const delegated = receipts.filter(
    (receipt) =>
      receipt.executionAuthority === "external_runtime" &&
      !isConnectedRuntimeSideEffect(receipt),
  );
  if (delegated.length) {
    // The calling agent owns action intent. Report the actual effects without
    // reinterpreting them through Original Agent obligations or inviting replay.
    if (delegated.every(receiptProved)) return { state: "satisfied" };
    const state = delegated.some((receipt) => receipt.status === "failed")
      ? "failed"
      : delegated.every((receipt) => receipt.status === "cancelled")
        ? "cancelled"
        : delegated.some(
              (receipt) =>
                receipt.status === "partial" || receiptProved(receipt),
            )
          ? "partial"
          : "unverified";
    return {
      state,
      failure: `Delegated action results:\n${formatReceiptStatus(delegated)}`,
    };
  }
  const unverifiableApplied = receipts.filter(
    (receipt) =>
      (receipt.status === "applied" || receipt.status === "partial") &&
      receipt.verification === "unverified",
  );
  return unverifiableApplied.length
    ? {
        state: "unverified",
        failure: `Concrete action results could not be verified:\n${formatReceiptStatus(unverifiableApplied)}`,
      }
    : { state: "satisfied" };
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
  executionClass: "read" | "control" | "external_effect";
  input: unknown;
  ok: boolean;
  effect?: AgentToolEffect;
  cancelled?: boolean;
  reason?: string;
  content?: unknown;
}): AgentActionReceipt[] {
  if (
    params.executionClass === "read" &&
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
  if (params.executionClass !== "external_effect") return [];
  const operation =
    params.toolName === "file_io"
      ? "file_write"
      : params.toolName === "run_command"
        ? "command_execute"
        : params.toolName === "zotero_script"
          ? "zotero_script_execute"
          : null;
  if (!operation) return [];
  const authority = operationCatalogEntry(operation);
  if (!authority) return [];
  const { capability, proofDomain } = authority;
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
        proofDomain,
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
        proofDomain,
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
      proofDomain,
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

/**
 * An effect the connected client ran inside its own runtime.
 *
 * A file Claude Code wrote or a command Codex executed is receipted and
 * journaled so the trace and the audit trail show it, but it says nothing
 * about the Zotero action the turn owes. Reading it as delegated action
 * evidence would break completion in both directions: a shell command would
 * stand in for an unperformed tag write, and an approved command — whose proof
 * can only ever be `execution_only` — would report an otherwise complete turn
 * as unverified.
 *
 * The test is provenance, not capability. A `file.write` receipt can equally
 * come from `file_io` run as a host tool, which the host journaled and
 * verified and which is delegated evidence like any other; reading the
 * capability as a proxy would only work while that tool stays off the MCP
 * surface, and would break silently on the day it is exposed. `origin` is set
 * by exactly one owner and says what actually matters: the host executed
 * nothing here.
 */
function isConnectedRuntimeSideEffect(receipt: AgentActionReceipt): boolean {
  return receipt.origin === "connected_runtime";
}

function receiptTookEffect(receipt: AgentActionReceipt): boolean {
  return (
    receipt.status === "applied" ||
    receipt.status === "already_satisfied" ||
    receipt.status === "observed"
  );
}

/**
 * The receipt carries the strongest proof its proof domain admits.
 *
 * `verified` is a re-read that matched. `execution_only` is the whole proof a
 * shell command or an effect-free script can ever have: it ran, and there is
 * no state to read back. Phase 3 task 3 ruled that such a receipt passes the
 * host's own final gate, so the delegated gate must not read it as a failure
 * either — a client that ran one would be told its complete turn was
 * unverified and invited to run the command a second time.
 *
 * `unverified` stays a failure in both gates: there a re-read was possible
 * and either disagreed or never happened.
 */
function receiptProved(receipt: AgentActionReceipt): boolean {
  return (
    (receipt.verification === "verified" ||
      receipt.verification === "execution_only") &&
    receiptTookEffect(receipt)
  );
}

/**
 * The per-receipt status block, written for the model that reads the answer.
 *
 * This text is appended to the answer the runtime finalizes, which is at once
 * the transcript the model reads next turn, the correction it receives this
 * turn, and the string the panel renders. The first two audiences need the
 * machine-readable statement; the reader gets the same facts as a card at the
 * end of the trace, so the panel removes the block at display time with
 * `stripReceiptStatusForDisplay` and nothing changes about what is persisted.
 * A receipt journaled before the verification field existed states no proof,
 * and the block leaves it out rather than printing an empty claim.
 */
export function formatReceiptStatus(receipts: AgentActionReceipt[]): string {
  return receipts
    .map((receipt) => {
      const verified =
        receipt.appliedTargets.length + receipt.alreadySatisfiedTargets.length;
      const coverage = receipt.requestedTargets.length
        ? ` ${verified}/${receipt.requestedTargets.length}`
        : "";
      const verification = readAgentActionVerification(receipt.verification);
      const proof = verification
        ? ` ${AGENT_ACTION_VERIFICATION_LABELS[verification]};`
        : "";
      // When an item is only added, say that it stays in its other
      // collections. Otherwise, the model can report that it moved.
      const operation = collectionAddOnly(receipt)
        ? `${receipt.operation} (added only; the items stay in their other collections)`
        : receipt.operation;
      return `[Action status: ${operation} — ${receipt.status}${coverage};${proof} proof:${receipt.proofDomain}]`;
    })
    .join("\n");
}

/**
 * The statuses under which a receipt claims the turn did something.
 *
 * Work that landed, work that was already true, work that landed for some of
 * its targets, and an effect that ran with nothing to re-read afterwards. A
 * cancelled or failed action is reported where it failed; counting it here
 * would say the opposite of what happened.
 */
const REPORTED_EFFECT_STATUSES: ReadonlySet<AgentActionReceipt["status"]> =
  new Set(["applied", "already_satisfied", "partial", "observed"]);

/**
 * Whether a receipt states an effect worth reporting as work the turn did.
 *
 * One predicate serves the model-facing status block and the reader-facing
 * summary card, so the two can never come to disagree about what the turn
 * did. Reads are excluded deliberately: a full read journals a receipt to
 * prove the evidence was actually consulted, and answering a question after
 * reading a paper is not an action taken on the library.
 */
export function receiptReportsEffect(
  receipt: Pick<AgentActionReceipt, "capability" | "status">,
): boolean {
  return (
    receipt.capability !== "zotero.read" &&
    REPORTED_EFFECT_STATUSES.has(receipt.status)
  );
}

/** One finished block line, exactly as `formatReceiptStatus` writes it. */
const RECEIPT_STATUS_LINE = /^\[Action status:[^\n]*\]\s*$/;

/**
 * The block's last line while the answer is still streaming, before its
 * closing bracket has arrived.
 */
const RECEIPT_STATUS_PARTIAL_LINE = /^\[Action status:[^\]\n]*$/;

/**
 * The answer without the block `formatReceiptStatus` appended to it.
 *
 * The runtime concatenates the block onto the end of the final text, so this
 * removes the trailing run of block lines and the blank line that separated
 * them from the answer, and nothing else: an action-status line the answer
 * itself quotes sits before other content and is left alone. The incremental
 * render path sees the block one delta at a time, so a last line that has
 * opened the block without closing it goes too, rather than flashing a half
 * written receipt at the reader.
 */
export function stripReceiptStatusForDisplay(text: string): string {
  const lines = text.split("\n");
  let end = lines.length;
  while (end && !lines[end - 1].trim()) end -= 1;
  const blockEnd = end;
  if (end && RECEIPT_STATUS_PARTIAL_LINE.test(lines[end - 1])) end -= 1;
  while (end && RECEIPT_STATUS_LINE.test(lines[end - 1])) end -= 1;
  if (end === blockEnd) return text;
  while (end && !lines[end - 1].trim()) end -= 1;
  return lines.slice(0, end).join("\n");
}
