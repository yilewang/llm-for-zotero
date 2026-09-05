import type {
  AgentActionParameters,
  AgentJournalActionScope,
  AgentJournalStepOutcome,
  AgentWriteToolDefinition,
} from "../../types";
import type { AgentToolRegistry } from "../registry";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import type { ActionRegistry } from "../../actions";
import type { ActionCheckpoint } from "../../actions/types";
import { buildActionExecutionContext } from "../../actions/toolContextBridge";
import { summarizeMutationOutcomes } from "../../services/mutationCoordinator";
import { getAgentLibraryWriteMode } from "../../libraryWriteMode";
import {
  advanceBatchJob,
  createBatchJob,
  finishBatchJob,
  getBatchJob,
  listInterruptedBatchJobs,
  markBatchJobRunning,
  type BatchJobRecord,
} from "../../store/batchJobStore";
import {
  createJournalId,
  isAgentChangeJournalAvailable,
  prepareJournalAction,
  updateJournalAction,
} from "../../store/changeJournal";
import { ok, fail, validateObject, normalizePositiveInt } from "../shared";
import { capabilityForLibraryMutation } from "../../services/libraryMutation/handlerOperations";

type RunBatchInput = {
  kind: "run";
  job: string;
  jobArgs: Record<string, unknown>;
};

type ResumeBatchInput = {
  kind: "resume";
  resumeJobId: string;
};

type ListBatchInput = {
  kind: "list";
};

type LibraryBatchInput = RunBatchInput | ResumeBatchInput | ListBatchInput;

export type LibraryBatchJobStore = {
  createBatchJob: typeof createBatchJob;
  advanceBatchJob: typeof advanceBatchJob;
  finishBatchJob: typeof finishBatchJob;
  getBatchJob: typeof getBatchJob;
  listInterruptedBatchJobs: typeof listInterruptedBatchJobs;
  markBatchJobRunning: typeof markBatchJobRunning;
};

const defaultBatchJobStore: LibraryBatchJobStore = {
  createBatchJob,
  advanceBatchJob,
  finishBatchJob,
  getBatchJob,
  listInterruptedBatchJobs,
  markBatchJobRunning,
};

/** Jobs that ask an inline question and therefore cannot run headlessly. */
const INTERACTIVE_ONLY_JOBS: Record<string, string> = {
  discover_related:
    "discover_related is an interactive review workflow — it presents candidate papers for you to pick from — so it cannot run unattended.",
};

const DURABLE_BATCH_JOBS = new Set([
  "auto_tag",
  "organize_unfiled",
  "audit_library",
]);

function operationForBatchJob(job: string) {
  return job === "auto_tag"
    ? ("apply_tags" as const)
    : job === "organize_unfiled"
      ? ("move_to_collection" as const)
      : job === "audit_library"
        ? ("update_metadata" as const)
        : null;
}

function unresolvedCollectionContractTargets(
  job: string,
  context: import("../../types").AgentToolContext,
  durableRemainingItemIds?: number[],
  proposalParameters?: AgentActionParameters,
): number[] | null {
  const operation = operationForBatchJob(job);
  if (!operation) return null;
  const obligations =
    context.request.actionContract?.obligations.filter(
      (entry) =>
        entry.operation === operation &&
        entry.proofDomain === "zotero_state" &&
        entry.scopeRole !== "destination" &&
        entry.targetBoundary?.kind === "collection" &&
        entry.targetBoundary.libraryID === context.request.libraryID &&
        Object.entries(entry.parameters || {}).every(([key, expected]) => {
          if (expected === undefined) return true;
          const actual =
            proposalParameters?.[key as keyof AgentActionParameters];
          return Array.isArray(expected)
            ? Array.isArray(actual) &&
                expected.length === actual.length &&
                [...expected].every((value) => actual.includes(value as never))
            : actual === expected;
        }) &&
        !(
          entry.constraints?.collectionMode === "move" &&
          proposalParameters?.sourceCollectionId === undefined
        ),
    ) || [];
  if (!obligations.length) return null;
  const unresolved = obligations.flatMap((obligation) => {
    const progress = context.request.actionProgress?.obligations.find(
      (entry) => entry.obligationId === obligation.id,
    );
    if (
      progress?.status === "fulfilled" ||
      progress?.status === "already_satisfied" ||
      progress?.status === "cancelled"
    ) {
      return [];
    }
    if (progress) {
      return progress.unresolvedTargetIds
        .map((target) => Number(target.match(/^item:(\d+)$/)?.[1]))
        .filter((itemId) => Number.isInteger(itemId) && itemId > 0);
    }
    return obligation.targetBoundary?.frozenTargetIds || [];
  });
  const union = [...new Set(unresolved)].sort((left, right) => left - right);
  if (!durableRemainingItemIds) return union;
  const durableRemaining = new Set(durableRemainingItemIds);
  return union.filter((itemId) => durableRemaining.has(itemId));
}

function bindFrozenTargets(
  jobArgs: Record<string, unknown>,
  frozenItemIds: number[],
): Record<string, unknown> {
  const {
    scope: _scope,
    collectionId: _collectionId,
    collectionIds: _collectionIds,
    itemIds: _itemIds,
    tagNames: _tagNames,
    tagScopes: _tagScopes,
    _batchItemIds: _previousBatchItemIds,
    ...retained
  } = jobArgs;
  return { ...retained, _batchItemIds: frozenItemIds };
}

/**
 * Runs and resumes durable library-wide jobs.
 *
 * Paged actions checkpoint an exact remaining-item plan after each applied
 * page. The checkpoint is awaited, so the next page never starts while the
 * durable row still describes the previous one. An interrupted run is listed
 * explicitly and resumed only through a new confirmation card.
 */
export function createLibraryBatchTool(deps: {
  actionRegistry: ActionRegistry;
  toolRegistry: AgentToolRegistry;
  zoteroGateway: ZoteroGateway;
  now?: () => number;
  batchJobStore?: LibraryBatchJobStore;
}): AgentWriteToolDefinition<LibraryBatchInput, unknown> {
  const now = deps.now ?? (() => Date.now());
  const store = deps.batchJobStore ?? defaultBatchJobStore;

  const describeBatchOperation = (
    job: string,
    jobArgs: Record<string, unknown>,
    identity: string,
    context?: import("../../types").AgentToolContext,
    durableRemainingItemIds?: number[],
  ) => {
    const operation = operationForBatchJob(job);
    if (!operation) return [];
    const requestedItemIds = Array.isArray(jobArgs.itemIds)
      ? jobArgs.itemIds
          .map(Number)
          .filter((itemId) => Number.isInteger(itemId) && itemId > 0)
      : [];
    const targetCollectionId = normalizePositiveInt(jobArgs.targetCollectionId);
    const proposalParameters = targetCollectionId
      ? { destinationCollectionId: targetCollectionId }
      : undefined;
    const contractTargets = context
      ? unresolvedCollectionContractTargets(
          job,
          context,
          durableRemainingItemIds,
          proposalParameters,
        )
      : null;
    const itemIds =
      contractTargets ?? durableRemainingItemIds ?? requestedItemIds;
    return [
      {
        id: `${operation}:library_batch:${identity}`,
        proofDomain: "zotero_state" as const,
        capability: capabilityForLibraryMutation(operation),
        operation,
        source: "library_mutation" as const,
        parameters: proposalParameters,
        requestedTargets: itemIds.map((itemId) => `item:${itemId}`),
        destinationCollectionIds: targetCollectionId
          ? [targetCollectionId]
          : [],
      },
    ];
  };

  return {
    describeAction: async (input, context) => {
      if (input.kind === "list") return [];
      if (input.kind === "run") {
        return describeBatchOperation(
          input.job,
          input.jobArgs,
          input.job,
          context,
        );
      }
      const job = await store.getBatchJob(input.resumeJobId);
      let args: Record<string, unknown> = {};
      let durableRemainingItemIds: number[] | undefined;
      if (job) {
        try {
          const parsed = JSON.parse(job.inputJson);
          if (validateObject<Record<string, unknown>>(parsed)) args = parsed;
        } catch {
          args = {};
        }
        try {
          const plan = JSON.parse(job.planJson || "{}");
          if (validateObject<Record<string, unknown>>(plan)) {
            durableRemainingItemIds =
              normalizeItemIds(plan.remainingItemIds) || undefined;
          }
        } catch {
          durableRemainingItemIds = undefined;
        }
      }
      return job
        ? describeBatchOperation(
            job.action,
            args,
            job.jobId,
            context,
            durableRemainingItemIds,
          )
        : [];
    },
    spec: {
      name: "library_batch",
      description:
        "Run, inspect, or explicitly resume a durable library-wide batch job such as auto-tagging, organising unfiled items, or auditing metadata. New and resumed runs require the agent library write mode to be 'yolo'; interrupted jobs can be listed without changing the library.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          job: {
            type: "string",
            description:
              "Which new batch job to run. Call with an unknown name to receive the available jobs.",
          },
          jobArgs: {
            type: "object",
            description:
              "Arguments for a new job. Always set an explicit scope.",
          },
          listInterrupted: {
            type: "boolean",
            description:
              "List interrupted jobs for this conversation without changing the library.",
          },
          resumeJobId: {
            type: "string",
            description:
              "Explicitly resume one interrupted job from its durable remaining-item checkpoint.",
          },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    presentation: {
      label: "Library Batch Job",
      summaries: {
        onCall: ({ args }) => {
          const record = validateObject<Record<string, unknown>>(args)
            ? args
            : {};
          if (record.listInterrupted === true) {
            return "Checking interrupted batch jobs";
          }
          if (typeof record.resumeJobId === "string") {
            return `Preparing batch resume: ${record.resumeJobId}`;
          }
          return `Preparing batch job${typeof record.job === "string" ? `: ${record.job}` : ""}`;
        },
        onPending: "Waiting for confirmation on a library-wide batch job",
        onApproved: "Running batch job",
        onDenied: "Batch job cancelled",
        onSuccess: ({ content }) => {
          const record =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          if (Array.isArray(record.interruptedJobs)) {
            return `${record.interruptedJobs.length} interrupted batch job${record.interruptedJobs.length === 1 ? "" : "s"}`;
          }
          const applied = record.appliedCount;
          return typeof applied === "number"
            ? `Batch job changed ${applied} item${applied === 1 ? "" : "s"}`
            : "Batch job finished";
        },
      },
    },

    validate(args) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          'Expected an object. Example: { job: "auto_tag", jobArgs: { scope: "all" } }',
        );
      }
      if (args.listInterrupted === true) {
        return ok({ kind: "list" });
      }
      const resumeJobId =
        typeof args.resumeJobId === "string" ? args.resumeJobId.trim() : "";
      if (resumeJobId) {
        return ok({ kind: "resume", resumeJobId });
      }

      const job = typeof args.job === "string" ? args.job.trim() : "";
      if (!job) {
        return fail(
          `job is required. Available jobs: ${availableJobNames(deps)}`,
        );
      }
      const action = deps.actionRegistry.getAction(job);
      if (!action) {
        return fail(
          `Unknown job "${job}". Available: ${availableJobDetails(deps)}`,
        );
      }
      const interactiveReason = INTERACTIVE_ONLY_JOBS[job];
      if (interactiveReason) {
        return fail(
          `${interactiveReason} Run it from the chat surface with /${job} instead.`,
        );
      }
      if (!DURABLE_BATCH_JOBS.has(job)) {
        return fail(
          `Action "${job}" does not implement durable remaining-item checkpoints and cannot run unattended. Available batch jobs: ${availableJobNames(deps)}`,
        );
      }
      const jobArgs = validateObject<Record<string, unknown>>(args.jobArgs)
        ? args.jobArgs
        : {};
      if (job === "audit_library" && jobArgs.saveNote === true) {
        return fail(
          "audit_library saveNote is not part of the durable batch transaction. Run /audit_library for an interactive audit note, or run the batch without saveNote and create a note from its result afterward.",
        );
      }
      return ok({ kind: "run", job, jobArgs });
    },

    shouldRequireConfirmation(input) {
      return input.kind !== "list";
    },

    planMutation(input) {
      if (input.kind === "list") {
        return { effect: "none", reversibility: "full" };
      }
      return {
        effect: "write",
        reversibility: "partial",
        reason:
          "Each applied page is journalled, while external model work and an interrupted remainder are checkpointed separately.",
        requiresConfirmation: input.kind === "resume",
      };
    },

    createPendingAction(input, context) {
      if (input.kind === "list") {
        throw new Error(
          "Listing interrupted jobs does not require confirmation",
        );
      }
      if (input.kind === "resume") {
        return store.getBatchJob(input.resumeJobId).then((record) => {
          const job =
            record?.conversationKey === context.request.conversationKey
              ? record
              : null;
          return {
            toolName: "library_batch",
            title: `Resume interrupted batch job "${input.resumeJobId}"`,
            description: job
              ? `Resume ${job.action} after ${job.cursor} processed item${job.cursor === 1 ? "" : "s"}. ${job.appliedCount} library object${job.appliedCount === 1 ? " has" : "s have"} already been changed and will not be repeated.`
              : "The job will be rechecked before execution. No work runs until you approve.",
            confirmLabel: "Resume job",
            cancelLabel: "Cancel",
            fields: job
              ? [
                  {
                    type: "text" as const,
                    id: "action",
                    label: "Job",
                    value: job.action,
                  },
                  {
                    type: "text" as const,
                    id: "progress",
                    label: "Durable progress",
                    value: `${job.cursor}${job.totalCount ? ` / ${job.totalCount}` : ""} processed; ${job.appliedCount} changed`,
                  },
                ]
              : [],
          };
        });
      }

      const action = deps.actionRegistry.getAction(input.job);
      const scope =
        typeof input.jobArgs.scope === "string"
          ? input.jobArgs.scope
          : "the current selection";
      const limit = normalizePositiveInt(input.jobArgs.limit);
      void context;
      return {
        toolName: "library_batch",
        title: `Run "${input.job}" across your library`,
        description:
          `${action?.description || input.job}\n\n` +
          `Scope: ${scope}${limit ? `, up to ${limit} items` : ""}. ` +
          "This runs unattended and can change many items at once. Each applied page and its inverse are recorded durably, so it can be reverted and an interruption can be resumed without restarting from zero.",
        confirmLabel: "Run job",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "text" as const,
            id: "job",
            label: "Job",
            value: input.job,
          },
          {
            type: "code_preview" as const,
            id: "jobArgs",
            label: "Arguments",
            value: JSON.stringify(input.jobArgs, null, 2),
            language: "json",
          },
        ],
      };
    },

    applyConfirmation(input) {
      return ok(input);
    },

    async execute(input, context) {
      if (input.kind === "list") {
        const jobs = await store.listInterruptedBatchJobs(
          context.request.conversationKey,
        );
        return {
          content: {
            interruptedJobs: jobs.map(summarizeInterruptedJob),
          },
          effect: "none",
        };
      }

      const mode = getAgentLibraryWriteMode();
      if (mode !== "yolo") {
        const actionName = input.kind === "run" ? input.job : "the batch job";
        throw new Error(
          `Library batch jobs run unattended, so they require the agent library write mode to be "yolo" (currently "${mode}"). Either change it in the plugin preferences, or run this from the chat surface with /${actionName}, which reviews each page before applying it.`,
        );
      }

      const prepared = await prepareBatchRun({
        requested: input,
        conversationKey: context.request.conversationKey,
        now,
        store,
      });
      const durableRemainingItemIds = prepared.resumed
        ? normalizeItemIds(prepared.jobArgs._batchItemIds) || []
        : undefined;
      const contractTargets = unresolvedCollectionContractTargets(
        prepared.job,
        context,
        durableRemainingItemIds,
        normalizePositiveInt(prepared.jobArgs.targetCollectionId)
          ? {
              destinationCollectionId: normalizePositiveInt(
                prepared.jobArgs.targetCollectionId,
              ),
            }
          : undefined,
      );
      if (contractTargets !== null) {
        prepared.jobArgs = bindFrozenTargets(prepared.jobArgs, contractTargets);
        if (!prepared.resumed) prepared.totalCount = contractTargets.length;
      }
      const action = deps.actionRegistry.getAction(prepared.job);
      if (!action) {
        await store.finishBatchJob({
          jobId: prepared.jobId,
          status: "failed",
          now: now(),
        });
        throw new Error(`Unknown batch job "${prepared.job}"`);
      }

      const progress: string[] = [];
      let checkpointSeen = false;
      let lastCursor = prepared.baseCursor;
      let lastAppliedCount = prepared.baseAppliedCount;
      let lastTotalCount = prepared.totalCount;
      const journalOutcomes: AgentJournalStepOutcome[] = [];
      let journalSequence = 0;
      let journalActionId: string | null = null;
      let journalFinalized = false;
      if (isAgentChangeJournalAvailable()) {
        journalActionId = createJournalId("action");
        try {
          await prepareJournalAction({
            actionId: journalActionId,
            runId: context.runId || prepared.jobId,
            conversationKey: context.request.conversationKey,
            toolName: context.journalToolName || "library_batch",
            description: `${prepared.resumed ? "Resume" : "Run"} ${prepared.job} batch job`,
            effect: "write",
            reversibility: "partial",
            recovery:
              "The durable batch checkpoint and each applied mutation step are recorded separately.",
          });
        } catch (error) {
          await store.finishBatchJob({
            jobId: prepared.jobId,
            status: "failed",
            now: now(),
          });
          throw error;
        }
      }
      const journalActionScope: AgentJournalActionScope | undefined =
        journalActionId
          ? {
              actionId: journalActionId,
              allocateSequence: () => {
                journalSequence += 1;
                return journalSequence;
              },
              recordStep: (outcome) => {
                journalOutcomes.push(outcome);
              },
            }
          : undefined;
      const finalizeJournal = async (
        failed: boolean,
        error?: unknown,
      ): Promise<void> => {
        if (!journalActionId || journalFinalized) return;
        const summary = summarizeMutationOutcomes(journalOutcomes);
        const { affectedCount, effect, reversibility } = summary;
        const uncertain = journalOutcomes.some(
          (outcome) => outcome.status === "uncertain",
        );
        await updateJournalAction({
          actionId: journalActionId,
          status: failed
            ? affectedCount > 0
              ? "partially_applied"
              : uncertain
                ? "uncertain"
                : "failed"
            : effect === "none"
              ? "no_effect"
              : effect === "partial"
                ? "partially_applied"
                : reversibility === "none"
                  ? "irreversible"
                  : "applied",
          reversibility,
          affectedCount,
          error:
            failed && error !== undefined
              ? error instanceof Error
                ? error.message
                : String(error)
              : undefined,
          recovery: failed
            ? "Previously applied batch steps retain their durable inverses; inspect any uncertain step before retrying."
            : undefined,
        });
        journalFinalized = true;
      };
      const checkpoint = async (value: ActionCheckpoint): Promise<void> => {
        const cursor = prepared.baseCursor + Math.max(0, value.cursor);
        const appliedCount =
          prepared.baseAppliedCount + Math.max(0, value.appliedCount);
        const totalCount =
          value.totalCount === undefined
            ? prepared.totalCount
            : prepared.baseCursor + Math.max(0, value.totalCount);
        await store.advanceBatchJob({
          jobId: prepared.jobId,
          cursor,
          appliedCount,
          plan: value.plan,
          totalCount,
          now: now(),
        });
        await context.checkpointActionProgress?.();
        checkpointSeen = true;
        lastCursor = cursor;
        lastAppliedCount = appliedCount;
        lastTotalCount = totalCount;
      };

      const actionContext = buildActionExecutionContext({
        context,
        registry: deps.toolRegistry,
        zoteroGateway: deps.zoteroGateway,
        confirmationMode: "auto_approve",
        runId: prepared.jobId,
        journalActionScope,
        journalToolName: context.journalToolName || "library_batch",
        checkpoint,
        onProgress: (event) => {
          if (event.type === "step_done" && event.summary) {
            progress.push(event.summary);
          } else if (event.type === "status" && event.message) {
            progress.push(event.message);
          }
        },
      });

      try {
        const result = await action.execute(prepared.jobArgs, actionContext);
        const output =
          result.ok && result.output && typeof result.output === "object"
            ? (result.output as Record<string, unknown>)
            : {};
        const localAppliedCount = readAppliedCount(output);

        if (!checkpointSeen) {
          lastCursor =
            prepared.baseCursor +
            (readCount(output.processed) ?? localAppliedCount);
          lastAppliedCount = prepared.baseAppliedCount + localAppliedCount;
          await store.advanceBatchJob({
            jobId: prepared.jobId,
            cursor: lastCursor,
            appliedCount: lastAppliedCount,
            totalCount: prepared.totalCount,
            now: now(),
          });
        }

        const stopped = output.stopped === true;
        if (!result.ok) {
          const failure = new Error(
            result.error || `Batch job "${prepared.job}" failed`,
          );
          await finalizeJournal(true, failure);
          await store.finishBatchJob({
            jobId: prepared.jobId,
            status: "failed",
            now: now(),
          });
          throw failure;
        }
        await finalizeJournal(false);
        await store.finishBatchJob({
          jobId: prepared.jobId,
          status: stopped ? "cancelled" : "completed",
          now: now(),
        });

        return {
          content: {
            job: prepared.job,
            jobId: prepared.jobId,
            resumed: prepared.resumed || undefined,
            cursor: lastCursor,
            totalCount: lastTotalCount,
            appliedCount: lastAppliedCount,
            output,
            progress: progress.slice(-20),
          },
          effect: summarizeMutationOutcomes(journalOutcomes).effect,
        };
      } catch (error) {
        await finalizeJournal(true, error).catch(() => undefined);
        await store.finishBatchJob({
          jobId: prepared.jobId,
          status: "failed",
          now: now(),
        });
        throw error;
      }
    },
  };
}

async function prepareBatchRun(params: {
  requested: RunBatchInput | ResumeBatchInput;
  conversationKey: number;
  now: () => number;
  store: LibraryBatchJobStore;
}): Promise<{
  job: string;
  jobArgs: Record<string, unknown>;
  jobId: string;
  baseCursor: number;
  baseAppliedCount: number;
  totalCount?: number;
  resumed: boolean;
}> {
  const { requested, conversationKey, now, store } = params;
  if (requested.kind === "run") {
    const jobId = `batch-${requested.job}-${now()}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    const jobArgs = { ...requested.jobArgs, startOffset: 0 };
    await store.createBatchJob({
      jobId,
      conversationKey,
      action: requested.job,
      input: jobArgs,
      now: now(),
    });
    return {
      job: requested.job,
      jobArgs,
      jobId,
      baseCursor: 0,
      baseAppliedCount: 0,
      resumed: false,
    };
  }

  const record = await store.getBatchJob(requested.resumeJobId);
  assertResumableJob(record, requested.resumeJobId, conversationKey);
  if (!DURABLE_BATCH_JOBS.has(record.action)) {
    throw new Error(
      `Batch job "${record.jobId}" uses unsupported legacy action "${record.action}" and cannot be resumed safely`,
    );
  }
  const originalInput = parseJsonRecord(record.inputJson, "job input");
  const plan = parseJsonRecord(record.planJson, "resume plan");
  const remainingItemIds = normalizeItemIds(plan.remainingItemIds);
  if (!remainingItemIds) {
    throw new Error(
      `Batch job "${record.jobId}" predates exact remaining-item checkpoints and cannot be resumed safely. Start a new scoped job instead.`,
    );
  }
  const claimed = await store.markBatchJobRunning({
    jobId: record.jobId,
    now: now(),
  });
  if (!claimed) {
    throw new Error(
      `Batch job "${record.jobId}" is already running or was resumed elsewhere`,
    );
  }
  return {
    job: record.action,
    jobArgs: {
      ...originalInput,
      startOffset: 0,
      pageSize: normalizePositiveInt(plan.pageSize) ?? originalInput.pageSize,
      tagsPerPaper:
        normalizePositiveInt(plan.tagsPerPaper) ?? originalInput.tagsPerPaper,
      _batchItemIds: remainingItemIds,
    },
    jobId: record.jobId,
    baseCursor: record.cursor,
    baseAppliedCount: record.appliedCount,
    totalCount: record.totalCount,
    resumed: true,
  };
}

function availableJobNames(deps: { actionRegistry: ActionRegistry }): string {
  return deps.actionRegistry
    .listActions()
    .filter((entry) => DURABLE_BATCH_JOBS.has(entry.name))
    .map((entry) => entry.name)
    .join(", ");
}

function availableJobDetails(deps: { actionRegistry: ActionRegistry }): string {
  return deps.actionRegistry
    .listActions()
    .filter((entry) => DURABLE_BATCH_JOBS.has(entry.name))
    .map((entry) => `${entry.name} — ${entry.description}`)
    .join("; ");
}

function summarizeInterruptedJob(job: BatchJobRecord): Record<string, unknown> {
  return {
    jobId: job.jobId,
    action: job.action,
    cursor: job.cursor,
    appliedCount: job.appliedCount,
    totalCount: job.totalCount,
    updatedAt: job.updatedAt,
  };
}

function assertResumableJob(
  job: BatchJobRecord | null,
  jobId: string,
  conversationKey: number,
): asserts job is BatchJobRecord {
  if (!job) throw new Error(`Interrupted batch job "${jobId}" was not found`);
  if (job.conversationKey !== conversationKey) {
    throw new Error(`Batch job "${jobId}" belongs to another conversation`);
  }
  if (job.status !== "failed") {
    throw new Error(
      `Batch job "${jobId}" is ${job.status}, not an interrupted job that can be resumed`,
    );
  }
}

function parseJsonRecord(
  value: string | undefined,
  label: string,
): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (validateObject<Record<string, unknown>>(parsed)) return parsed;
  } catch {
    // The durable row is corrupt; the caller gets a precise refusal below.
  }
  throw new Error(`The durable batch ${label} is invalid JSON`);
}

function normalizeItemIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const out: number[] = [];
  const seen = new Set<number>();
  for (const raw of value) {
    const itemId = normalizePositiveInt(raw);
    if (!itemId || seen.has(itemId)) continue;
    seen.add(itemId);
    out.push(itemId);
  }
  return out;
}

function readAppliedCount(output: Record<string, unknown>): number {
  return (
    readCount(output.moved) ??
    readCount(output.tagged) ??
    readCount(output.updated) ??
    readCount(output.metadataFixed) ??
    readCount(output.imported) ??
    largestCount(output) ??
    0
  );
}

function largestCount(output: Record<string, unknown>): number | undefined {
  const counts = Object.entries(output)
    .filter(([key]) => key !== "processed" && key !== "remaining")
    .map(([, value]) => readCount(value))
    .filter((value): value is number => value !== undefined);
  return counts.length ? Math.max(...counts) : undefined;
}

function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
