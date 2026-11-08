import { fingerprintText } from "./actionOperationEvidence";
import { OPERATION_CATALOG } from "./operationCatalog";
import {
  inJournalTransaction,
  recordJournalObservation,
} from "../store/changeJournal";
import type { AgentActionParameters, AgentActionReceipt } from "./types";
import { appLogger } from "../../core/logging";

/**
 * Receipts for effects a connected client performed inside its own runtime.
 *
 * Codex and Claude Code run their own file changes and shell commands. The host
 * authorizes them — an approval card, or a provider action it dispatched — and
 * then never touches the result: there is no proposal it validated, no journal
 * step it wrote, and no post-state it can re-read on this side. What it can
 * still do is record, in the same vocabulary every in-app effect uses, which
 * catalogued operation was authorized, what it named as its targets, and that
 * the proof stops at "it ran". That is what this module mints.
 *
 * Two rules keep these receipts honest:
 * - `verification` is never better than `execution_only`, because a re-read is
 *   not merely skipped here, it is impossible: the effect happens inside
 *   another process after the host answers.
 * - `executionAuthority` is always `external_runtime`, so the trace says whose
 *   runtime ran it and no reader mistakes it for a host-verified effect.
 */

/** Which connected client ran the effect. */
export type ExternalRuntimeEffectSource = "codex_native" | "claude_code";

/**
 * One catalogued effect a connected client is about to run, or has run.
 *
 * `operation` is restricted to the two the catalog defines for this shape of
 * evidence: a file the client wrote (`file_state` proof domain) and a command
 * it executed (`execution`). Anything else a client does is either a read or
 * reaches the host as a registered tool call, which already has the full path.
 */
export type ExternalRuntimeEffect = {
  source: ExternalRuntimeEffectSource;
  operation: "file_write" | "command_execute";
  /** Paths, or the command fingerprint, exactly as the host displayed them. */
  requestedTargets: string[];
  parameters: AgentActionParameters;
};

/**
 * What became of the effect, from the host's side of the boundary.
 *
 * `executed` means the host authorized it and the client ran it; it never
 * means the host proved anything about the result.
 */
export type ExternalRuntimeEffectOutcome = "executed" | "declined" | "failed";

/** A file change, named by the paths the host displayed. */
export function externalRuntimeFileEffect(
  source: ExternalRuntimeEffectSource,
  paths: readonly string[],
): ExternalRuntimeEffect {
  const filePaths = [...new Set(paths.map((path) => path.trim()))].filter(
    Boolean,
  );
  return {
    source,
    operation: "file_write",
    requestedTargets: filePaths.map((path) => `file:${path}`),
    parameters: filePaths.length ? { filePath: filePaths[0], filePaths } : {},
  };
}

/**
 * A command execution, named by a fingerprint of the command.
 *
 * The command text itself never becomes a durable target — the same ruling
 * `run_command` follows — because a shell line routinely carries secrets and a
 * receipt outlives the turn that showed it.
 */
export function externalRuntimeCommandEffect(
  source: ExternalRuntimeEffectSource,
  command: string,
): ExternalRuntimeEffect {
  const commandFingerprint = fingerprintText(command);
  return {
    source,
    operation: "command_execute",
    requestedTargets: [`command:${commandFingerprint}`],
    parameters: { commandFingerprint },
  };
}

export function buildExternalRuntimeEffectReceipt(params: {
  effect: ExternalRuntimeEffect;
  outcome: ExternalRuntimeEffectOutcome;
  /** Stable identity of the client-side call or approval this receipt covers. */
  callId: string;
  reason?: string;
}): AgentActionReceipt {
  const { effect, outcome } = params;
  const authority = OPERATION_CATALOG[effect.operation];
  const proposalId = `external_runtime:${effect.source}:${effect.operation}:${params.callId}`;
  return {
    version: 2,
    executionAuthority: "external_runtime",
    origin: "connected_runtime",
    id: `${proposalId}:${outcome}`,
    proposalId,
    proofDomain: authority.proofDomain,
    capability: authority.capability,
    operation: effect.operation,
    verification:
      outcome === "executed"
        ? "execution_only"
        : outcome === "declined"
          ? "not_applicable"
          : "unverified",
    status:
      outcome === "executed"
        ? "observed"
        : outcome === "declined"
          ? "cancelled"
          : "failed",
    requestedTargets: effect.requestedTargets,
    // Nothing was re-read on this side, so no target may be claimed as applied
    // however the client reported the run.
    appliedTargets: [],
    alreadySatisfiedTargets: [],
    rejectedTargets: outcome === "executed" ? [] : effect.requestedTargets,
    normalizedParameters: effect.parameters,
    reasons: params.reason ? [params.reason] : [],
    verifiedFacts: [],
  };
}

/**
 * Mint the receipt and record it durably.
 *
 * The observation carries no journal action id on purpose: an effect the host
 * did not perform has no inverse to replay, so it must never be swept up by
 * undo or by an action's recovery. The receipt is the whole audit row, which is
 * why the payload can be stored whole — it holds identities and a verdict, and
 * no content.
 */
export async function recordExternalRuntimeEffect(params: {
  effect: ExternalRuntimeEffect;
  outcome: ExternalRuntimeEffectOutcome;
  callId: string;
  reason?: string;
  /** The run or turn the effect belongs to, when the caller has one. */
  runId?: string;
  conversationKey?: number;
}): Promise<AgentActionReceipt> {
  const receipt = buildExternalRuntimeEffectReceipt(params);
  try {
    // Its own transaction, so another flow's rollback cannot drop the
    // receipt. Callers record it from a runtime's message handler, never
    // inside a Zotero transaction.
    await inJournalTransaction(() =>
      recordJournalObservation({
        event: "external_runtime_effect_observed",
        objectType: "external_runtime_effect",
        objectIds: [params.runId || params.effect.source, params.callId],
        extra: {
          source: params.effect.source,
          conversationKey: params.conversationKey,
          receipt,
        },
      }),
    );
  } catch (error) {
    // The client already ran the effect. A supplementary audit failure must not
    // turn that into a failed decision the caller retries.
    appLogger.warn(
      `External runtime effect audit could not be recorded: ${String(error)}`,
    );
  }
  return receipt;
}
