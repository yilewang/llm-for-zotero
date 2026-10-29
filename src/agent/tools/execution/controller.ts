import {
  inJournalTransaction,
  recordJournalObservation,
} from "../../store/changeJournal";
import { appLogger } from "../../../core/logging";
import { ToolExecutionFailure, ToolInputRejection } from "./failure";
import { buildActionCallDigest } from "../../authorization/proposal";
import type { ActionContractService } from "../../contracts/actionContract";
import { createFallbackToolReceipts } from "../../contracts/actionEvaluation";
import { canonicalJson } from "../../services/libraryMutation/canonicalJson";
import type {
  AgentActionEvidence,
  AgentActionReceipt,
  AgentConfirmationResolution,
  AgentPendingAction,
  AgentToolCall,
  AgentToolContext,
  AgentToolDefinition,
  AgentToolEffect,
  PreparedToolExecution,
  PreparedToolExecutionOptions,
  PreparedToolExecutionResult,
} from "../../types";
import { validateConfirmationResolution } from "../confirmationValidation";
import { InvocationAssessor, type AssessedInvocation } from "./assessment";
import {
  createProposalConfirmationAction,
  createRequestId,
  invocationExpands,
  normalizeExecutionOutput,
  pendingActionMaterial,
} from "./results";

/**
 * What an execution's evidence records are worth recording in the audit trail.
 *
 * The records themselves carry whole post-images — a script's guarded item
 * JSON, a note body, a captured library state. Every one of those is already
 * durable in the journal step the record names, so the audit row keeps the
 * identity and the verdict and drops the payload: a summary tells a reader
 * which durable step proved what, and nothing is stored twice.
 */
function summarizeActionEvidence(
  evidence: AgentActionEvidence[] | undefined,
  receipts: AgentActionReceipt[],
):
  | Array<{
      source: AgentActionEvidence["source"];
      stepId?: string;
      verification?: AgentActionReceipt["verification"];
      reason?: string;
    }>
  | undefined {
  if (!evidence?.length) return undefined;
  return evidence.map((entry) => {
    const receipt = entry.journalStepId
      ? receipts.find(
          (candidate) => candidate.evidenceRef === entry.journalStepId,
        )
      : undefined;
    const matched =
      receipt || (receipts.length === 1 ? receipts[0] : undefined);
    return {
      source: entry.source,
      ...(entry.journalStepId ? { stepId: entry.journalStepId } : {}),
      ...(matched ? { verification: matched.verification } : {}),
      ...(matched?.reasons.length ? { reason: matched.reasons[0] } : {}),
    };
  });
}

type ReceiptOutcome = {
  ok: boolean;
  effect?: AgentToolEffect;
  cancelled?: boolean;
  reason?: string;
  content?: unknown;
  actionEvidence?: AgentActionEvidence[];
};
/** Authority recorded on the persisted authorization grant for one invocation. */
type GrantAuthority =
  | "external_runtime"
  | "safe_confirmation"
  | "auto_policy"
  | "yolo"
  | "yolo_judgment";

/** Owns the lifetime of one invocation; authority is bound to exact assessed payloads. */
export class InvocationController {
  private readonly assessor: InvocationAssessor;
  private readonly frozenExecutionContext: string;
  private readonly childResults = new Map<
    string,
    import("../../types").AgentToolResult
  >();

  constructor(
    private readonly call: AgentToolCall,
    private readonly tool: AgentToolDefinition<any, any>,
    private readonly context: AgentToolContext,
    private readonly options: PreparedToolExecutionOptions,
    private readonly contracts?: ActionContractService,
  ) {
    this.assessor = new InvocationAssessor(tool, context, options, contracts);
    this.frozenExecutionContext = canonicalJson(
      context.request.executionContext || null,
    );
  }

  async prepare(input: unknown): Promise<PreparedToolExecution> {
    try {
      if (this.options.inheritedApproval) {
        const inherited = this.options.inheritedApproval;
        if (
          inherited.approvedCallDigest !==
            buildActionCallDigest(this.call.name, this.call.arguments) ||
          !(await this.tool.acceptInheritedApproval?.(
            input,
            inherited,
            this.context,
          ))
        )
          throw new Error(
            `Inherited approval for ${this.call.name} was refused because it was not bound to this exact invocation.`,
          );
      }
      const assessed = await this.assessor.assess(input);
      if (
        this.options.inheritedApproval &&
        assessed.authorization.kind !== "block"
      )
        return this.execute(assessed, assessed.proposal.payloadDigest);
      return await this.dispatch(assessed);
    } catch (error) {
      return this.result(await this.failure(input, error));
    }
  }

  private result(
    execution: PreparedToolExecutionResult,
  ): PreparedToolExecution {
    return { kind: "result", execution };
  }

  private async receipts(
    outcome: ReceiptOutcome,
    assessed?: AssessedInvocation,
    input?: unknown,
  ) {
    const prepared = assessed?.preparedAction;
    if (prepared?.hasExplicitAdapter && !prepared.proposals.length) return [];
    const receipts =
      prepared && this.contracts
        ? await this.contracts.finalize(prepared, outcome)
        : createFallbackToolReceipts({
            toolName: this.call.name,
            executionClass: this.tool.spec.executionClass,
            input: assessed?.input ?? input,
            ...outcome,
          });
    const allReceipts = [
      ...receipts,
      ...[...this.childResults.values()].flatMap(
        (result) => result.actionReceipts || [],
      ),
    ];
    return this.context.authorization?.kind === "external_runtime" &&
      this.tool.spec.executionClass === "external_effect" &&
      assessed?.plan.impact !== "read_only"
      ? allReceipts.map((receipt) => ({
          ...receipt,
          executionAuthority: "external_runtime" as const,
        }))
      : allReceipts;
  }

  private async failure(
    input: unknown,
    error: unknown,
    assessed?: AssessedInvocation,
    cancelled = false,
  ): Promise<PreparedToolExecutionResult> {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      tool: this.tool,
      input,
      result: {
        callId: this.call.id,
        name: this.call.name,
        ok: false,
        ...(error instanceof ToolInputRejection
          ? { inputRejected: true as const }
          : {}),
        actionReceipts: await this.receipts(
          {
            ok: false,
            reason,
            cancelled,
            content:
              error instanceof ToolExecutionFailure ? error.content : undefined,
          },
          assessed,
          input,
        ),
        content:
          error instanceof ToolExecutionFailure
            ? error.content
            : { error: reason },
      },
    };
  }

  private async dispatch(
    assessed: AssessedInvocation,
  ): Promise<PreparedToolExecution> {
    if (assessed.authorization.kind === "block")
      return this.result(
        await this.failure(
          assessed.input,
          assessed.authorization.reason,
          assessed,
        ),
      );
    const toolReview =
      this.tool.spec.interaction === "user_input" &&
      ((await this.tool.shouldRequireConfirmation?.(
        assessed.input,
        this.context,
      )) ??
        this.tool.spec.requiresConfirmation);
    const needsReview = assessed.authorization.kind === "confirm" || toolReview;
    if (needsReview) {
      const action = this.tool.createPendingAction
        ? await this.tool.createPendingAction(assessed.input, this.context)
        : createProposalConfirmationAction(assessed.proposal);
      return this.review(assessed, action);
    }
    return this.execute(assessed);
  }

  private review(
    assessed: AssessedInvocation,
    displayedAction: AgentPendingAction,
    applyToolResolution = true,
  ): PreparedToolExecution {
    // The card a tool builds describes its own payload; only the host knows
    // which frozen material the proposal bound, so the host stamps it here
    // rather than asking every tool to repeat it. The interaction kind is
    // stamped for the same reason: the spec already declares that this tool
    // asks the user something, and a view that had to recognise such a tool
    // by name would be reading identity for meaning.
    const material = pendingActionMaterial(assessed.preparedAction?.proposals);
    const action = {
      ...displayedAction,
      ...(assessed.authorization.kind === "confirm"
        ? {
            description: [
              displayedAction.description,
              assessed.authorization.reason,
            ]
              .filter(Boolean)
              .join("\n\n"),
          }
        : {}),
      ...(material ? { material } : {}),
      ...(this.tool.spec.interaction === "user_input"
        ? { interaction: "user_input" as const }
        : {}),
    };
    return {
      kind: "confirmation",
      requestId: createRequestId(),
      action,
      execute: (resolution) =>
        this.resolveReview(assessed, action, resolution, applyToolResolution),
      deny: () =>
        this.failure(assessed.input, "User denied action", assessed, true),
    };
  }

  private async resolveReview(
    displayed: AssessedInvocation,
    action: AgentPendingAction,
    resolution: AgentConfirmationResolution,
    applyToolResolution: boolean,
  ): Promise<PreparedToolExecution> {
    let input = displayed.input;
    try {
      const confirmation = validateConfirmationResolution(action, resolution);
      if (!confirmation.ok)
        throw new Error(
          `Invalid confirmation for ${this.call.name}: ${confirmation.error}`,
        );
      const cancelActionId =
        action.cancelActionId ||
        (action.actions?.length ? undefined : "cancel");
      if (
        (confirmation.actionId && confirmation.actionId === cancelActionId) ||
        (!confirmation.actionId && !resolution.approved)
      )
        return this.result(
          await this.failure(input, "User denied action", displayed, true),
        );
      if (applyToolResolution && this.tool.applyConfirmation) {
        const resolved = this.tool.applyConfirmation(
          input,
          confirmation.data,
          this.context,
        );
        if (!resolved.ok)
          throw new Error(
            `Invalid confirmation input for ${this.call.name}: ${resolved.error}`,
          );
        input = resolved.value;
      }
      const assessed = await this.assessor.assess(input);
      if (assessed.authorization.kind === "block")
        throw new Error(assessed.authorization.reason);
      if (invocationExpands(displayed.plan, assessed.plan))
        return this.review(
          assessed,
          createProposalConfirmationAction({
            ...assessed.proposal,
            summary: `${assessed.proposal.summary}\n\nThe edited input expands the previously displayed targets, impact, or risk and requires a new confirmation.`,
          }),
          false,
        );
      // This digest exists only after a validated, real review resolution.
      return this.execute(assessed, assessed.proposal.payloadDigest);
    } catch (error) {
      return this.result(await this.failure(input, error, displayed));
    }
  }

  /** Whether the conversation this call was prepared in may still be changed. */
  private conversationCurrent(): boolean {
    return (
      (!this.options.isExecutionAllowed || this.options.isExecutionAllowed()) &&
      canonicalJson(this.context.request.executionContext || null) ===
        this.frozenExecutionContext
    );
  }

  /** Whether the tool may start: not stopped, and the conversation current. */
  private lifecycleValid(): boolean {
    return !this.context.signal?.aborted && this.conversationCurrent();
  }

  /**
   * The one authority this invocation executes under, most specific first:
   * a real user review, then the policy's own verdict.
   */
  private grantAuthority(
    assessed: AssessedInvocation,
    userApproval?: string,
  ): GrantAuthority {
    if (this.context.authorization?.kind === "external_runtime")
      return "external_runtime";
    if (userApproval) return "safe_confirmation";
    const policy =
      assessed.authorization.kind === "execute"
        ? assessed.authorization.authority
        : undefined;
    switch (policy) {
      case "yolo_judgment":
        return "yolo_judgment";
      case "yolo":
        return "yolo";
      default:
        return "auto_policy";
    }
  }

  private async stageAuthority(
    assessed: AssessedInvocation,
    userApproval?: string,
  ) {
    if (
      this.context.authorization?.kind === "external_runtime" &&
      assessed.plan.impact !== "read_only"
    ) {
      const grant = {
        version: 2 as const,
        interaction: assessed.interaction,
        proposalDigest: assessed.proposal.payloadDigest,
        toolName: this.call.name,
        authority: "external_runtime" as const,
        status: "staged" as "staged" | "executed" | "failed",
        createdAt: Date.now(),
      };
      // Its own transaction, so another flow's rollback cannot drop the
      // grant. Tool invocations start from the agent loop, MCP, an action
      // page or undo, never inside a Zotero transaction.
      await inJournalTransaction(() =>
        recordJournalObservation({
          event: "external_authorization_prepared",
          objectType: "tool_invocation",
          objectIds: [this.context.runId!, this.call.id],
          extra: {
            grant,
            libraryID: this.context.request.libraryID,
            proposal: assessed.proposal,
            input: this.call.arguments,
          },
        }),
      );
      return grant;
    }
    if (
      !(
        ["model", "mcp"].includes(this.options.callerKind || "model") &&
        this.tool.spec.executionClass === "external_effect" &&
        assessed.plan.impact !== "read_only" &&
        this.context.runId
      )
    )
      return undefined;
    const authority = this.grantAuthority(assessed, userApproval);
    const grant = {
      version: 2 as const,
      interaction: assessed.interaction,
      proposalDigest: assessed.proposal.payloadDigest,
      toolName: this.call.name,
      authority,
      ...(assessed.review ? { review: assessed.review } : {}),
      status: "staged" as "staged" | "executed" | "failed",
      createdAt: Date.now(),
    };
    await inJournalTransaction(() =>
      recordJournalObservation({
        actionId: this.context.journalActionScope?.actionId,
        event: "original_authorization_prepared",
        objectType: "tool_invocation",
        objectIds: [this.context.runId!, this.call.id],
        extra: {
          grant,
          libraryID: this.context.request.executionContext?.chatLibraryID,
          proposal: assessed.proposal,
        },
      }),
    );
    return grant;
  }

  private async recordGrantOutcome(
    grant: Awaited<ReturnType<InvocationController["stageAuthority"]>>,
    status: "executed" | "failed",
    extra: Record<string, unknown>,
  ): Promise<void> {
    const runId = this.context.runId;
    if (!grant || !runId) return;
    const external = grant.authority === "external_runtime";
    await inJournalTransaction(() =>
      recordJournalObservation({
        actionId: this.context.journalActionScope?.actionId,
        event: external
          ? status === "executed"
            ? "external_execution_completed"
            : "external_execution_failed"
          : status === "executed"
            ? "original_execution_completed"
            : "original_execution_failed",
        objectType: "tool_invocation",
        objectIds: [runId, this.call.id],
        extra: { authority: grant.authority, ...extra },
      }),
    ).catch((error) => {
      // Mutation receipts remain authoritative. A supplementary audit failure
      // must not invite replay of an action whose native outcome is already known.
      appLogger.warn(
        `Execution authorization audit could not be recorded: ${String(error)}`,
      );
    });
  }

  private async execute(
    prepared: AssessedInvocation,
    userApproval?: string,
  ): Promise<PreparedToolExecution> {
    let grant: Awaited<ReturnType<InvocationController["stageAuthority"]>>;
    try {
      if (!this.lifecycleValid())
        throw new Error(
          "Conversation lifecycle changed before this tool could execute.",
        );
      grant = await this.stageAuthority(prepared, userApproval);
    } catch (error) {
      return this.result(await this.failure(prepared.input, error, prepared));
    }
    const run = async (): Promise<PreparedToolExecution> => {
      let assessed = prepared;
      try {
        if (!this.lifecycleValid())
          throw new Error(
            "Conversation lifecycle changed before this tool could execute.",
          );
        assessed = await this.assessor.assess(prepared.input);
        if (assessed.authorization.kind === "block")
          throw new Error(assessed.authorization.reason);
        if (
          !userApproval &&
          grant &&
          assessed.proposal.payloadDigest !== grant.proposalDigest
        )
          throw new Error(
            "The prepared action changed after authorization was persisted. Prepare the current exact action again before executing.",
          );
        if (
          userApproval &&
          (assessed.proposal.payloadDigest !== userApproval ||
            invocationExpands(prepared.plan, assessed.plan))
        ) {
          if (grant) grant.status = "failed";
          return this.review(
            assessed,
            createProposalConfirmationAction(assessed.proposal),
            false,
          );
        }
        if (assessed.authorization.kind === "confirm" && !userApproval) {
          if (grant) grant.status = "failed";
          return this.review(
            assessed,
            createProposalConfirmationAction(assessed.proposal),
            false,
          );
        }
        if (!this.lifecycleValid())
          throw new Error(
            "Conversation lifecycle changed before this tool could execute.",
          );
        const output = normalizeExecutionOutput(
          await this.tool.execute(assessed.input, {
            ...this.context,
            invocationPlan: assessed.plan,
            recordChildExecution: (result) =>
              this.childResults.set(result.callId, result),
            nestedExecutionOptions: {
              isExecutionAllowed: this.options.isExecutionAllowed,
              executeWithLock: this.options.executeWithLock,
            },
            executionAuthority: userApproval
              ? "user"
              : assessed.authorization.kind === "execute"
                ? assessed.authorization.authority
                : undefined,
          }),
        );
        if (grant) grant.status = "executed";
        // A Stop pressed while the tool ran ends the run after this call, not
        // the call's record: what it did is real, and its receipts are the
        // only proof of it. A tool that loops stops between its items itself.
        // Only a conversation changed under the call discards its result.
        if (!this.conversationCurrent())
          throw new Error("Conversation lifecycle changed during execution.");
        if (
          this.tool.spec.executionClass === "external_effect" &&
          output.effect === undefined
        )
          throw new Error(
            `${this.call.name} completed without the required explicit write effect. Its outcome is unknown; inspect current state before retrying.`,
          );
        // The staged grant already resolved the one authority; a tool with no
        // staged grant (not an external effect) resolves it the same way.
        const authority = grant
          ? grant.authority
          : this.grantAuthority(assessed, userApproval);
        const effect =
          this.tool.spec.executionClass === "external_effect"
            ? output.effect
            : [...this.childResults.values()].some(
                  (result) => result.effect === "partial",
                )
              ? "partial"
              : [...this.childResults.values()].some(
                    (result) => result.effect === "applied",
                  )
                ? "applied"
                : undefined;
        // Receipts first: the audit row records what this execution proved,
        // and that is only knowable once the receipts have re-read state.
        const actionReceipts = await this.receipts(
          {
            ok: true,
            effect,
            content: output.content,
            actionEvidence: output.actionEvidence,
          },
          assessed,
        );
        await this.recordGrantOutcome(grant, "executed", {
          effect,
          actionEvidence: summarizeActionEvidence(
            output.actionEvidence,
            actionReceipts,
          ),
          content: output.content,
        });
        return this.result({
          tool: this.tool,
          input: assessed.input,
          result: {
            callId: this.call.id,
            name: this.call.name,
            ok: true,
            effect,
            authority:
              authority === "yolo_judgment" ? "yolo_judgment" : undefined,
            actionReceipts,
            content: output.content,
            artifacts: output.artifacts,
            materialRef: output.materialRef,
            materialKind: output.materialKind,
            materialTitle: output.materialTitle,
            materialCitedSources: output.materialCitedSources,
            paperDecisions: output.paperDecisions,
            batchItems: output.batchItems,
          },
        });
      } catch (error) {
        if (grant) grant.status = "failed";
        await this.recordGrantOutcome(grant, "failed", {
          error: String(error),
        });
        return this.result(await this.failure(assessed.input, error, assessed));
      }
    };
    return prepared.plan.impact !== "read_only" && this.options.executeWithLock
      ? this.options.executeWithLock(run)
      : run();
  }
}
