import { annotationMatchesPayload } from "../../services/pdf/pdfAnnotationState";
import {
  buildQuoteTextIndex,
  findQuoteSourceSpansAllowingLayoutArtifacts,
} from "../../services/quotes/quoteTextNormalization";
import type {
  AgentActionEvidence,
  AgentActionProposal,
  AgentActionReceipt,
  AgentExternalMutationEvidence,
  AgentLibraryMutationEvidence,
  AgentToolDefinition,
  AgentToolEffect,
  AgentToolContext,
} from "../types";
import {
  itemTarget,
  prepareActionExecution,
  nativeNoteWriteFacts,
  verifyNoteWriteTarget,
  type ActionContractGateway,
  type PreparedActionExecution,
} from "./actionOperationEvidence";
import { canonicalJsonEqual } from "../services/libraryMutation/canonicalJson";
import type { LibraryMutationOperation } from "../services/libraryMutation/contracts";
import type { MutationTargetJudgment } from "../services/libraryMutation/handlerDefinition";
import {
  actionDetailsForLibraryMutation,
  judgeLibraryMutationTargets,
  mutationPostconditionIsSatisfied,
  mutationNoChangeOutcome,
  mutationReachedFromHandler,
  mutationTargetCountFromHandler,
} from "../services/libraryMutation/handlerOperations";
import { describeItemIds } from "../services/libraryMutation/handlerUtilities";
import {
  verifyRecordedPostImage,
  type PostImageReader,
} from "../services/recordedPostImage";
import type { RevertedStep } from "../services/changeReverter";
import { innermostToolResult, toolResultString } from "./toolResultEnvelope";
import { readFlatMaterialRef } from "../documents/materialRef";

export type {
  ActionContractGateway,
  PreparedActionExecution,
} from "./actionOperationEvidence";
export {
  describeLibraryMutationActions,
  describeLibraryMutationInput,
  extractLibraryMutationOperations,
} from "./actionOperationEvidence";

/**
 * What the action contract can read back for itself.
 *
 * It holds its own narrow Zotero gateway, not the mutation service, so a
 * post-image whose shape needs the mutation handlers reads back as "not
 * re-readable" here rather than as agreement.
 */
function contractPostImageReader(
  gateway: ActionContractGateway,
): PostImageReader {
  return {
    getItem: (itemId) => gateway.getItem(itemId),
    ...(gateway.getSettingNativeState
      ? { readSetting: (key) => gateway.getSettingNativeState!(key).value }
      : {}),
  };
}

function readEvidenceRef(content: unknown): string | undefined {
  return toolResultString(content, ["actionId", "journalStepId"]);
}

function evidenceTargets(evidence: AgentLibraryMutationEvidence): string[] {
  return [
    ...(evidence.postState.items || []).map((item) => `item:${item.itemId}`),
    ...(evidence.postState.collections || []).map(
      (collection) => `collection:${collection.collectionId}`,
    ),
    ...(evidence.postState.savedSearches || []).map(
      (search) => `saved-search:${search.savedSearchId}`,
    ),
  ];
}

/**
 * A write's requested targets one by one, from the handler's own judgment of
 * the states captured around it: the targets it refused before running, the
 * ones whose postcondition now holds (already before the write, or made true
 * by it), and the ones whose postcondition does not hold.
 *
 * Null leaves the receipt to the whole-set postcondition, which happens when
 * the split adds nothing to it or cannot be trusted: the handler did not
 * judge every requested target; every target landed; or nothing was refused
 * and nothing landed, where no reason says why and the outcome is genuinely
 * unknown. `reason` covers every rejected target on its own, because the
 * ledger and the action card read only a receipt's first reason.
 */
function splitByTarget(
  operation: LibraryMutationOperation,
  judgment: MutationTargetJudgment,
  requestedTargets: readonly string[],
  effect: AgentToolEffect | undefined,
): {
  applied: string[];
  alreadySatisfied: string[];
  rejected: string[];
  reason: string;
} | null {
  const refused = new Set(
    judgment.refused.flatMap((group) => group.itemIds.map(itemTarget)),
  );
  const landed = judgment.judged.filter((target) => target.after);
  const missed = judgment.judged.filter((target) => !target.after);
  const judged = new Set([
    ...refused,
    ...judgment.judged.map((target) => itemTarget(target.itemId)),
  ]);
  if (
    !requestedTargets.length ||
    requestedTargets.some((target) => !judged.has(target))
  ) {
    return null;
  }
  if (!refused.size && (!missed.length || !landed.length)) return null;
  if (!landed.length && missed.length) return null;
  // A write that changed nothing already held what it found in place.
  const held = new Set(
    landed
      .filter((target) => target.before || effect === "none")
      .map((target) => itemTarget(target.itemId)),
  );
  const made = new Set(
    landed
      .map((target) => itemTarget(target.itemId))
      .filter((target) => !held.has(target)),
  );
  const rejected = new Set([
    ...refused,
    ...missed.map((target) => itemTarget(target.itemId)),
  ]);
  // In the order the write named them, as the requested targets are.
  const inOrder = (targets: Set<string>) =>
    requestedTargets.filter((target) => targets.has(target));
  return {
    applied: inOrder(made),
    alreadySatisfied: inOrder(held),
    rejected: inOrder(rejected),
    reason: [
      ...judgment.refused.map((group) => group.reason),
      ...(missed.length
        ? [
            `The captured native post-state does not show ${operation.type} for ${describeItemIds(
              missed.map((target) => target.itemId),
            )}.`,
          ]
        : []),
    ].join(" "),
  };
}

function matchingNativeEvidence(
  proposal: AgentActionProposal,
  evidence: AgentActionEvidence[] | undefined,
): AgentLibraryMutationEvidence | undefined {
  return evidence?.find(
    (entry): entry is AgentLibraryMutationEvidence =>
      entry.source === "library_mutation" &&
      entry.proofDomain === "zotero_state" &&
      proposal.operationValue !== undefined &&
      canonicalJsonEqual(entry.operationValue, proposal.operationValue),
  );
}

/**
 * The record the mutation boundary attached for a write that no library
 * mutation operation describes.
 *
 * One `executeExternalMutation` call journals exactly one such step and
 * attaches exactly one record, and a proposal that reaches this point has no
 * operation of its own to match evidence against. Identity therefore comes
 * from the call, and a result carrying several records — a multi-file export
 * writes one per file — is not matched at all rather than matched to whichever
 * came first.
 */
function externalMutationEvidence(
  evidence: AgentActionEvidence[] | undefined,
): AgentExternalMutationEvidence | undefined {
  const external = (evidence || []).filter(
    (entry): entry is AgentExternalMutationEvidence =>
      entry.source === "external_mutation",
  );
  return external.length === 1 ? external[0] : undefined;
}

/**
 * The per-step native re-read `revertActions` performed, as the undo and
 * revert tools report it. A result without it proves nothing about native
 * state, so the receipt treats an empty list as "not re-read".
 */
function revertedSteps(result: Record<string, unknown>): RevertedStep[] {
  const entries = Array.isArray(result.revertedSteps)
    ? result.revertedSteps
    : [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const step = entry as Record<string, unknown>;
    const verification = String(step.verification || "");
    if (
      verification !== "matched" &&
      verification !== "mismatched" &&
      verification !== "not_re_readable"
    ) {
      return [];
    }
    return [
      {
        actionId: String(step.actionId || ""),
        sequence: Number(step.sequence) || 0,
        verification,
        ...(typeof step.reason === "string" ? { reason: step.reason } : {}),
      } as RevertedStep,
    ];
  });
}

/**
 * A post-state re-read the tool performed for itself, for effects whose proof
 * domain is `execution`. A shell command has no such state and attaches none,
 * which is what keeps `run_command` at `execution_only`.
 */
function readExecutionPostState(content: unknown): {
  verified: boolean;
  facts: string[];
  reason?: string;
} | null {
  const report = innermostToolResult(content).executionPostState;
  if (!report || typeof report !== "object") return null;
  const record = report as Record<string, unknown>;
  if (typeof record.verified !== "boolean") return null;
  return {
    verified: record.verified,
    facts: Array.isArray(record.facts) ? record.facts.map(String) : [],
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
  };
}

function fileEvidence(
  proposal: AgentActionProposal,
  content: unknown,
): {
  verified: boolean;
  target: string;
  evidenceRef?: string;
  reason?: string;
} {
  const record = innermostToolResult(content);
  const filePath = String(
    record.filePath || proposal.parameters?.filePath || "",
  );
  const actualHash =
    typeof record.contentHash === "string" ? record.contentHash : "";
  const expectedHash =
    proposal.expectedContentHash ||
    proposal.parameters?.contentHash ||
    (typeof record.expectedContentHash === "string"
      ? record.expectedContentHash
      : "");
  const target = filePath ? `file:${filePath}` : "file:unknown";
  if (!filePath || record.exists !== true || !actualHash) {
    return {
      verified: false,
      target,
      reason:
        "The written file was not read back with an exact path and content hash.",
    };
  }
  if (expectedHash && actualHash !== expectedHash) {
    return {
      verified: false,
      target,
      reason: `File readback hash ${actualHash} did not match ${expectedHash}.`,
    };
  }
  if (proposal.expectedFiles?.length) {
    const files = Array.isArray(record.exportedFiles)
      ? (record.exportedFiles as Record<string, unknown>[])
      : [];
    for (const expected of proposal.expectedFiles) {
      const actual = files.find((file) => file.filePath === expected.path);
      if (
        !actual ||
        actual.exists !== true ||
        actual.contentHash !== expected.contentHash ||
        actual.bytesWritten !== expected.byteLength
      )
        return {
          verified: false,
          target,
          reason: `Export member ${expected.path} was not verified against the authorized bytes.`,
        };
    }
  }
  return { verified: true, target, evidenceRef: `sha256:${actualHash}` };
}

export class ActionContractService {
  constructor(private readonly gateway: ActionContractGateway) {}

  async prepare(
    tool: AgentToolDefinition<any, any>,
    input: unknown,
    context?: AgentToolContext,
  ): Promise<PreparedActionExecution> {
    return await prepareActionExecution(tool, input, context);
  }

  /** One receipt for each proposal the invocation made, from its outcome. */
  async finalize(
    prepared: PreparedActionExecution,
    params: {
      ok: boolean;
      effect?: AgentToolEffect;
      cancelled?: boolean;
      reason?: string;
      content?: unknown;
      actionEvidence?: AgentActionEvidence[];
    },
  ): Promise<AgentActionReceipt[]> {
    return Promise.all(
      prepared.proposals.map((proposal) =>
        this.finalizeProposal(proposal, params),
      ),
    );
  }

  private async finalizeProposal(
    proposal: AgentActionProposal,
    params: {
      ok: boolean;
      effect?: AgentToolEffect;
      cancelled?: boolean;
      reason?: string;
      content?: unknown;
      actionEvidence?: AgentActionEvidence[];
    },
  ): Promise<AgentActionReceipt> {
    const evidenceRef = readEvidenceRef(params.content);
    const base = {
      version: 2 as const,
      id: `${proposal.id}:unmatched:${evidenceRef || "result"}`,
      proposalId: proposal.id,
      proofDomain: proposal.proofDomain,
      capability: proposal.capability,
      operation: proposal.operation,
      requestedTargets: proposal.requestedTargets,
      rejectedTargets: [] as string[],
      normalizedParameters: proposal.parameters,
      reasons: params.reason ? [params.reason] : [],
      verifiedFacts:
        proposal.operation === "read_full" ? ["read_mode:full"] : [],
      materialRef: readFlatMaterialRef(proposal.parameters),
      evidenceRef,
    };
    if (params.cancelled) {
      return {
        ...base,
        verification: "not_applicable",
        status: "cancelled",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
      };
    }
    if (!params.ok) {
      const noteState = (
        innermostToolResult(params.content)?.noteChange as
          | { state?: string }
          | undefined
      )?.state;
      return {
        ...base,
        verification: "unverified",
        status:
          noteState === "unverified" || noteState === "mismatch"
            ? "unverified"
            : "failed",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
      };
    }
    if (proposal.proofDomain === "execution") {
      const postState = readExecutionPostState(params.content);
      // No re-readable state is the normal case here — a shell command leaves
      // none. An execution that *did* declare an expected effect re-reads it
      // and says so, and then the receipt reports that proof rather than
      // hiding a library write behind "the command ran".
      if (!postState) {
        return {
          ...base,
          verification: "execution_only",
          status: "observed",
          appliedTargets: [],
          alreadySatisfiedTargets: [],
        };
      }
      return {
        ...base,
        verification: postState.verified ? "verified" : "unverified",
        status: postState.verified ? "applied" : "unverified",
        appliedTargets: postState.verified ? proposal.requestedTargets : [],
        alreadySatisfiedTargets: [],
        rejectedTargets: postState.verified ? [] : proposal.requestedTargets,
        // Carried whether or not the re-read confirmed the effect: each fact
        // names its own outcome, so a receipt that could not check is
        // distinguishable from one that checked and disagreed. The tool never
        // emits a "satisfied" fact for a re-read that was not satisfied.
        verifiedFacts: [...base.verifiedFacts, ...postState.facts],
        reasons: [
          ...base.reasons,
          ...(postState.reason ? [postState.reason] : []),
        ],
      };
    }
    if (proposal.proofDomain === "file_state") {
      const proof = fileEvidence(proposal, params.content);
      return {
        ...base,
        id: `${base.id}:${proof.evidenceRef || "unverified"}`,
        evidenceRef: proof.evidenceRef,
        verification: proof.verified ? "verified" : "unverified",
        status: proof.verified
          ? params.effect === "none"
            ? "already_satisfied"
            : "applied"
          : "unverified",
        requestedTargets: proposal.expectedFiles?.map(
          (file) => `file:${file.path}`,
        ) || [proof.target],
        appliedTargets:
          proof.verified && params.effect !== "none"
            ? proposal.requestedTargets
            : [],
        alreadySatisfiedTargets:
          proof.verified && params.effect === "none"
            ? proposal.requestedTargets
            : [],
        verifiedFacts: proof.verified
          ? [
              ...base.verifiedFacts,
              ...(proposal.expectedFiles || []).map(
                (file) => `${file.path}:sha256:${file.contentHash}`,
              ),
            ]
          : base.verifiedFacts,
        reasons: [...base.reasons, ...(proof.reason ? [proof.reason] : [])],
      };
    }
    if (proposal.operation === "read_full") {
      return {
        ...base,
        verification: "verified",
        status: "observed",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
      };
    }
    if (
      proposal.operation === "note_create" ||
      proposal.operation === "note_edit" ||
      proposal.operation === "note_append"
    ) {
      const verification = await verifyNoteWriteTarget(
        proposal,
        params.content,
        this.gateway,
      );
      // A note created for a paper is reported against that paper; the note
      // is its output. Native verification above has already checked that
      // exact parent relationship and the stored content before crediting it.
      const coveredTargets =
        proposal.operation === "note_create" &&
        proposal.parameters?.targetItemId
          ? [itemTarget(proposal.parameters.targetItemId)]
          : verification.targets;
      return verification.targets
        ? {
            ...base,
            verification: "verified",
            status: params.effect === "none" ? "already_satisfied" : "applied",
            requestedTargets: coveredTargets!,
            verifiedFacts: [
              ...base.verifiedFacts,
              ...(proposal.operation === "note_create"
                ? verification.targets.map((target) => `created_note:${target}`)
                : []),
              ...verification.facts,
            ],
            appliedTargets: params.effect === "none" ? [] : coveredTargets!,
            alreadySatisfiedTargets:
              params.effect === "none" ? coveredTargets! : [],
          }
        : {
            ...base,
            verification: "unverified",
            status: "unverified",
            appliedTargets: [],
            alreadySatisfiedTargets: [],
            reasons: [...base.reasons, verification.reason],
          };
    }
    if (proposal.operation === "annotation_write") {
      const result = innermostToolResult(params.content);
      const annotationId = Number(result.annotationId);
      const annotation = annotationId
        ? this.gateway.getItem(annotationId)
        : null;
      const expected = result.expectedAnnotation as
        | import("../../services/pdf/pdfAnnotationState").PdfHighlightPayload
        | undefined;
      const parameters = proposal.parameters;
      const verified = Boolean(
        expected &&
        parameters?.expectedText &&
        expected.source?.documentFingerprint &&
        expected.position &&
        expected.color === parameters.annotationColor &&
        expected.comment === parameters.annotationComment &&
        (expected.type || "highlight") ===
          (parameters.annotationType || "highlight") &&
        (parameters.pageIndex === undefined ||
          expected.position.pageIndex === parameters.pageIndex) &&
        findQuoteSourceSpansAllowingLayoutArtifacts(
          buildQuoteTextIndex(expected.text),
          parameters.expectedText,
        ).length === 1 &&
        annotationMatchesPayload(
          annotation,
          Number(parameters.targetItemId),
          expected,
        ),
      );
      const target = annotationId
        ? `item:${annotationId}`
        : proposal.requestedTargets[0] || "annotation:unknown";
      return {
        ...base,
        verification: verified ? "verified" : "unverified",
        status: verified
          ? params.effect === "none"
            ? "already_satisfied"
            : "applied"
          : "unverified",
        requestedTargets: [target],
        appliedTargets: verified && params.effect !== "none" ? [target] : [],
        alreadySatisfiedTargets:
          verified && params.effect === "none" ? [target] : [],
        rejectedTargets: verified ? [] : [target],
      };
    }
    if (proposal.operation === "undo" || proposal.operation === "revert") {
      const result = innermostToolResult(params.content);
      // The actions this call actually tried to put back. The multi-revert
      // form of `undo` also discloses newer irreversible actions it never
      // attempted, and those must not count against it either way.
      const attempted = Array.isArray(result.actionIds)
        ? result.actionIds.length
        : 0;
      const noWork =
        result.status === "nothing_reversible" ||
        (attempted === 0 &&
          Number(result.reverted) === 0 &&
          Number(result.partiallyReverted) === 0 &&
          params.effect === "none");
      const reverted = revertedSteps(result);
      const reportedComplete =
        proposal.operation === "undo"
          ? result.status === "undone"
          : attempted > 0 &&
            Number(result.reverted) === attempted &&
            Number(result.partiallyReverted) === 0;
      // Replaying an inverse is not proof that the inverse landed. Every step
      // this call replayed re-read its own target afterwards; the receipt is
      // verified only when every attempted action came back and all of those
      // re-reads found the recorded pre-image in place.
      const verified =
        noWork ||
        (reportedComplete &&
          reverted.length > 0 &&
          reverted.every((step) => step.verification === "matched"));
      const unmatched = reverted.filter(
        (step) => step.verification !== "matched",
      );
      return {
        ...base,
        verification: verified ? "verified" : "unverified",
        status: verified
          ? noWork
            ? "already_satisfied"
            : "applied"
          : "unverified",
        appliedTargets: verified && !noWork ? proposal.requestedTargets : [],
        alreadySatisfiedTargets:
          verified && noWork ? proposal.requestedTargets : [],
        rejectedTargets: verified ? [] : proposal.requestedTargets,
        // Named even on an unverified receipt: the reader needs to know how
        // much of the undo was proven, not only that it was not all of it.
        verifiedFacts: [
          ...base.verifiedFacts,
          ...reverted
            .filter((step) => step.verification === "matched")
            .map(
              (step) =>
                `reverted_step:${step.actionId}:${step.sequence}:matched`,
            ),
        ],
        reasons: [
          ...base.reasons,
          ...unmatched.map(
            (step) =>
              `Reverted step ${step.sequence} of ${step.actionId} re-read as ${step.verification}${
                step.reason ? `: ${step.reason}` : ""
              }.`,
          ),
          ...(!verified && !unmatched.length && !reverted.length && !noWork
            ? [
                "No reverted step re-read its target, so nothing proves the inverse landed.",
              ]
            : []),
        ],
        evidenceRef:
          proposal.operation === "undo" && typeof result.actionId === "string"
            ? result.actionId
            : base.evidenceRef,
      };
    }

    const operation = proposal.operationValue;
    if (!operation) {
      return this.externalMutationReceipt(base, proposal, params);
    }
    const evidence = matchingNativeEvidence(proposal, params.actionEvidence);
    // A call the user stopped between its items answers for the items it
    // reached. The rest never started: it neither applied nor refused them,
    // so the receipt names them in neither list and they stay owed.
    const reached = mutationReachedFromHandler(
      operation,
      innermostToolResult(params.content),
    );
    const judged = reached || operation;
    // A call that changed nothing because there was nothing to find is an
    // answer, not work already done: `observed`, with its reason, and its
    // targets excepted rather than counted as done.
    const noChange =
      evidence && !reached && params.effect === "none"
        ? mutationNoChangeOutcome(
            operation,
            innermostToolResult(params.content),
            evidence.preState,
            evidence.postState,
          )
        : undefined;
    if (evidence && noChange) {
      const searched = proposal.requestedTargets.length
        ? proposal.requestedTargets
        : evidenceTargets(evidence);
      return {
        ...base,
        evidenceRef: evidence.journalStepId || base.evidenceRef,
        verification: "verified",
        status: "observed",
        requestedTargets: searched,
        appliedTargets: [],
        alreadySatisfiedTargets: [],
        rejectedTargets: searched,
        reasons: [noChange, ...base.reasons],
      };
    }
    const verified = Boolean(
      evidence && mutationPostconditionIsSatisfied(judged, evidence.postState),
    );
    const targets = proposal.requestedTargets.length
      ? proposal.requestedTargets
      : evidence
        ? evidenceTargets(evidence)
        : [];
    const judgedTargets = reached
      ? actionDetailsForLibraryMutation(reached).requestedTargets
      : targets;
    const wasAlreadySatisfied = Boolean(
      evidence && mutationPostconditionIsSatisfied(judged, evidence.preState),
    );
    const alreadySatisfied =
      verified && (wasAlreadySatisfied || params.effect === "none");
    const stopReason = reached
      ? `Stopped by the user after ${mutationTargetCountFromHandler(
          reached,
        )} of ${mutationTargetCountFromHandler(operation)}; the rest were not started.`
      : undefined;
    // The captured post-state proves the operation's postcondition, which is a
    // claim about the whole set. A write that created notes carries, beside
    // it, the read-back each note's creation forced; those are re-checked here
    // against live state so the receipt names the same per-note content
    // evidence a single note write names. They are additive: each fact stands
    // on its own re-read, so they are minted whether or not the whole-set
    // postcondition held, and a note this call did not write has none. A note
    // whose re-read fails states why instead, so the receipt names the note it
    // could not read back rather than leaving a silent gap in the facts.
    const noteReadBacks = await nativeNoteWriteFacts(
      proposal,
      evidence?.noteWrites,
      this.gateway,
    );
    // The set-level postcondition decides what landed; the per-note re-reads
    // decide what this receipt can vouch for. A note the receipt could not
    // read back leaves the write in place -- the mutation window proved it --
    // but the verdict drops to `unverified`, exactly as the single-note branch
    // does for the same failed re-read. A receipt must never say "verified"
    // beside a reason that names a note it could not confirm.
    const readBackGap = noteReadBacks.reasons.length > 0;
    // Stopped before its first item, the call did nothing there is to prove.
    const stoppedBeforeAny = Boolean(reached && !judgedTargets.length);
    // The whole-set postcondition fails as soon as one target is not as asked,
    // which says nothing about the others. A handler that judges its targets
    // one by one says which landed and which it refused before running, and
    // the receipt then reports that split: verified for what landed, rejected
    // with the reason for the rest. Only an outcome the split cannot explain
    // keeps the whole-set verdict below.
    const judgment =
      evidence && !verified
        ? judgeLibraryMutationTargets(
            judged,
            evidence.preState,
            evidence.postState,
          )
        : undefined;
    const split = judgment
      ? splitByTarget(judged, judgment, judgedTargets, params.effect)
      : null;
    if (evidence && split) {
      const landed = split.applied.length + split.alreadySatisfied.length > 0;
      return {
        ...base,
        verifiedFacts: [...base.verifiedFacts, ...noteReadBacks.facts],
        evidenceRef: evidence.journalStepId || base.evidenceRef,
        // Every target refused means nothing was attempted, so nothing is
        // left to verify.
        verification: landed
          ? readBackGap
            ? "unverified"
            : "verified"
          : "not_applicable",
        status: landed ? "partial" : "failed",
        requestedTargets: targets,
        appliedTargets: split.applied,
        alreadySatisfiedTargets: split.alreadySatisfied,
        rejectedTargets: split.rejected,
        reasons: [...base.reasons, split.reason, ...noteReadBacks.reasons],
      };
    }
    return {
      ...base,
      verifiedFacts: [...base.verifiedFacts, ...noteReadBacks.facts],
      evidenceRef: evidence?.journalStepId || base.evidenceRef,
      verification: stoppedBeforeAny
        ? "not_applicable"
        : verified && !readBackGap
          ? "verified"
          : "unverified",
      status: stoppedBeforeAny
        ? "cancelled"
        : !verified
          ? "unverified"
          : reached
            ? "partial"
            : alreadySatisfied
              ? "already_satisfied"
              : "applied",
      requestedTargets: targets,
      appliedTargets: verified && !alreadySatisfied ? judgedTargets : [],
      alreadySatisfiedTargets: alreadySatisfied ? judgedTargets : [],
      rejectedTargets: verified ? [] : judgedTargets,
      reasons: [
        ...base.reasons,
        ...(stopReason ? [stopReason] : []),
        ...(verified || stoppedBeforeAny
          ? []
          : [
              evidence
                ? `The mutation handler rejected the captured native post-state for ${operation.type}.`
                : `No captured native post-state was attached for ${operation.type}.`,
            ]),
        // Refusals stay named even when the rest of the write is unknown.
        ...(judgment?.refused.map((group) => group.reason) || []),
        ...noteReadBacks.reasons,
      ],
    };
  }

  /**
   * The receipt for a Zotero write that no library mutation operation
   * describes and that has no operation-specific verifier of its own.
   *
   * Its evidence is the pre-image and post-image the mutation boundary
   * journalled. Neither proves anything by itself — both were written by the
   * call being judged — so an image is re-read here, against live Zotero
   * state, at the moment the receipt is minted. When the write declared what
   * it was *authorized* to make true, that is the image compared, and
   * `verified` then means live state holds the authorized change rather than
   * whatever the tool chose to write.
   *
   * Scope. The contract holds its own narrow Zotero gateway, so the shapes it
   * can read back are the single-object ones: a note, a created item, a file,
   * a path, a preference. A post-image that is a captured library-operation
   * state needs the mutation handlers and the operation it was captured for;
   * that is the library branch's evidence, which carries both, and such an
   * image reaching this branch reads back as `not_re_readable` rather than as
   * agreement.
   */
  private async externalMutationReceipt(
    base: Omit<
      AgentActionReceipt,
      "verification" | "status" | "appliedTargets" | "alreadySatisfiedTargets"
    >,
    proposal: AgentActionProposal,
    params: {
      effect?: AgentToolEffect;
      actionEvidence?: AgentActionEvidence[];
    },
  ): Promise<AgentActionReceipt> {
    const evidence = externalMutationEvidence(params.actionEvidence);
    if (!evidence) {
      return {
        ...base,
        verification: "unverified",
        status: "unverified",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
        reasons: [
          ...base.reasons,
          "No native Zotero post-state verifier is registered for this action.",
        ],
      };
    }
    const authorized = evidence.authorizedPostImage !== undefined;
    const postImage = await verifyRecordedPostImage({
      image: {
        expected: authorized
          ? evidence.authorizedPostImage
          : evidence.postImage,
      },
      reader: contractPostImageReader(this.gateway),
    });
    const verified = postImage.kind === "satisfied";
    const targets = proposal.requestedTargets;
    // A write that changed nothing already held the state its post-image
    // records, which is the same "already satisfied" the library path reports
    // for an operation whose pre-image already met its postcondition.
    const alreadySatisfied = verified && params.effect === "none";
    return {
      ...base,
      evidenceRef: evidence.journalStepId || base.evidenceRef,
      verification: verified ? "verified" : "unverified",
      status: verified
        ? alreadySatisfied
          ? "already_satisfied"
          : "applied"
        : "unverified",
      requestedTargets: targets,
      appliedTargets: verified && !alreadySatisfied ? targets : [],
      alreadySatisfiedTargets: alreadySatisfied ? targets : [],
      rejectedTargets: verified ? [] : targets,
      reasons: [
        ...base.reasons,
        ...(verified
          ? []
          : [
              `This ${evidence.operation} write could not be verified: ${
                postImage.kind === "mismatched"
                  ? authorized
                    ? "live Zotero state does not hold what this write was authorized to produce"
                    : "live Zotero state no longer matches what this write recorded when it applied"
                  : postImage.reason ||
                    "its recorded post-image could not be read back"
              }.`,
            ]),
      ],
    };
  }
}
