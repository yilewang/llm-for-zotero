import type {
  AgentEvent,
  AgentToolDefinition,
  AgentToolInputValidation,
} from "../../types";
import type { ConversationSystem } from "../../../shared/types";
import { fail, ok, validateObject } from "../shared";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import {
  TASK_PAPER_COVERAGE_MAX_LIMIT,
  buildTaskPaperCoverage,
  foldTaskPaperLedgerFromRuns,
  taskPaperCoverageRunsFromMessages,
  type TaskPaperCoverage,
  type TaskPaperCoverageDecisionFilter,
  type TaskPaperCoverageMessage,
} from "../../context/taskPaperCoverage";
import {
  TASK_PAPER_STATES,
  type TaskPaperState,
} from "../../context/taskPaperLedger";
import {
  PAST_CHAT_LOAD_MESSAGE_LIMIT,
  defaultPastConversationSource,
} from "../../../services/pastConversations/pastConversationLoader";
import { listAgentRunEventsForRuns } from "../../store/traceStore";

/**
 * review_coverage: this conversation's reads and decisions so far, as one
 * page of papers with counts, so an agent that resumes a large review knows
 * which papers it already listed, read or decided.
 *
 * Built from storage, never from the panel: the conversation's stored
 * messages number its questions and name each answer's run (the loader
 * past_chat_read reads transcripts with), and each run's stored
 * `paper_ledger_update` events fold into the task paper ledger
 * (taskPaperCoverage.ts).
 *
 * Only earlier answers count. The answer being written has no stored
 * message naming its run yet, in every mode, and its events are still being
 * written (in batches in the built-in runtime, one by one for Codex and
 * Claude Code), so it is left out rather than read half-stored.
 *
 * It is not proof of coverage: answer citations and a document's sources are
 * not rebuilt from events, so no paper reaches `cited` here, and a paper with
 * no row was never listed, read or decided.
 */

export const REVIEW_COVERAGE_TOOL_NAME = "review_coverage";

const NO_CONVERSATION =
  "Coverage is available only in a conversation in Zotero.";
const FAILED = "This conversation's coverage could not be read right now.";

const DECISION_FILTERS: ReadonlyArray<TaskPaperCoverageDecisionFilter> = [
  "include",
  "exclude",
  "defer",
  "none",
];

/** Where the conversation's messages and run events are read from; tests pass a fake. */
export type ReviewCoverageSource = {
  loadMessages(target: {
    system: ConversationSystem;
    conversationKey: number;
    limit: number;
  }): Promise<ReadonlyArray<TaskPaperCoverageMessage>>;
  /** The runs' stored `paper_ledger_update` events, each run's in order. */
  listLedgerEvents(
    runIds: readonly string[],
  ): Promise<ReadonlyArray<{ runId: string; payload: AgentEvent }>>;
};

export const defaultReviewCoverageSource: ReviewCoverageSource = {
  loadMessages: (target) => defaultPastConversationSource.loadMessages(target),
  listLedgerEvents: (runIds) =>
    listAgentRunEventsForRuns(runIds, ["paper_ledger_update"]),
};

type ReviewCoverageInput = {
  offset?: number;
  limit?: number;
  states?: TaskPaperState[];
  decision?: TaskPaperCoverageDecisionFilter;
};

type ReviewCoverageResult =
  | ({ ok: true } & TaskPaperCoverage)
  | { ok: false; error: string };

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function validateReviewCoverageInput(
  args: unknown,
): AgentToolInputValidation<ReviewCoverageInput> {
  const input = args === undefined || args === null ? {} : args;
  if (!validateObject<Record<string, unknown>>(input)) {
    return fail(`${REVIEW_COVERAGE_TOOL_NAME} expects an object input`);
  }
  const out: ReviewCoverageInput = {};
  if (input.offset !== undefined) {
    if (!nonNegativeInteger(input.offset))
      return fail("offset must be a non-negative integer");
    out.offset = input.offset;
  }
  if (input.limit !== undefined) {
    if (
      !nonNegativeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > TASK_PAPER_COVERAGE_MAX_LIMIT
    )
      return fail(
        `limit must be an integer from 1 to ${TASK_PAPER_COVERAGE_MAX_LIMIT}`,
      );
    out.limit = input.limit;
  }
  if (input.states !== undefined) {
    if (
      !Array.isArray(input.states) ||
      input.states.some(
        (state) => !TASK_PAPER_STATES.includes(state as TaskPaperState),
      )
    )
      return fail(`states takes ${TASK_PAPER_STATES.join(", ")}`);
    if (input.states.length) out.states = input.states as TaskPaperState[];
  }
  if (input.decision !== undefined) {
    if (
      !DECISION_FILTERS.includes(
        input.decision as TaskPaperCoverageDecisionFilter,
      )
    )
      return fail("decision must be include, exclude, defer or none");
    out.decision = input.decision as TaskPaperCoverageDecisionFilter;
  }
  return ok(out);
}

async function executeReviewCoverage(
  input: ReviewCoverageInput,
  context: {
    request: { conversationKey?: number };
    conversationSystem?: ConversationSystem;
    runId?: string;
  },
  source: ReviewCoverageSource,
): Promise<ReviewCoverageResult> {
  const conversationKey = Math.floor(Number(context.request.conversationKey));
  if (!(conversationKey > 0)) return { ok: false, error: NO_CONVERSATION };
  try {
    const messages = await source.loadMessages({
      system: context.conversationSystem || "upstream",
      conversationKey,
      limit: PAST_CHAT_LOAD_MESSAGE_LIMIT,
    });
    const runs = taskPaperCoverageRunsFromMessages(messages, {
      excludeRunIds: [context.runId],
    });
    const runIds = [...new Set(runs.map((run) => run.runId))];
    const events = runIds.length ? await source.listLedgerEvents(runIds) : [];
    const eventsByRun = new Map<string, AgentEvent[]>();
    for (const event of events) {
      const list = eventsByRun.get(event.runId);
      if (list) list.push(event.payload);
      else eventsByRun.set(event.runId, [event.payload]);
    }
    const ledger = foldTaskPaperLedgerFromRuns(
      runs.map((run) => ({
        ...run,
        events: eventsByRun.get(run.runId) || [],
      })),
    );
    return {
      ok: true,
      ...buildTaskPaperCoverage(ledger, {
        offset: input.offset,
        limit: input.limit,
        filter: { states: input.states, decision: input.decision },
      }),
    };
  } catch {
    return { ok: false, error: FAILED };
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createReviewCoverageTool(
  source: ReviewCoverageSource = defaultReviewCoverageSource,
): AgentToolDefinition<ReviewCoverageInput, ReviewCoverageResult> {
  return {
    spec: {
      name: REVIEW_COVERAGE_TOOL_NAME,
      description:
        "This conversation's reads and decisions so far: a page of papers, each with its state, deepest read and latest decision, and counts. Earlier answers only, not this answer's calls. Page with offset and nextOffset.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          offset: { type: "integer" },
          limit: { type: "integer", maximum: TASK_PAPER_COVERAGE_MAX_LIMIT },
          states: {
            type: "array",
            items: { type: "string", enum: [...TASK_PAPER_STATES] },
          },
          decision: {
            type: "string",
            enum: [...DECISION_FILTERS],
          },
        },
      },
      executionClass: "read",
      workCategory: "retrieval",
    },
    /**
     * For Codex and Claude Code over MCP only. The plugin's own Agent keeps
     * its stored history in its context and does not list this tool. A request
     * without an execution context is the plugin Agent's, so only an external
     * runtime sees it.
     */
    isAvailable: (request) =>
      request.executionContext?.permissionOwner === "external_runtime",
    validate: validateReviewCoverageInput,
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: [],
        effects: ["read"],
        reason:
          "Read this conversation's stored paper reads and decisions (plugin state only).",
      }),
    execute: (input, context) => executeReviewCoverage(input, context, source),
    presentation: {
      label: "Review Coverage",
      summaries: {
        onCall: "Reviewing coverage",
        onSuccess: ({ content }) => {
          const result = record(content);
          if (result.ok !== true) return "Could not review coverage";
          const total = Number(record(result.counts).total) || 0;
          return total === 1
            ? "Coverage so far: 1 paper"
            : `Coverage so far: ${total} papers`;
        },
      },
    },
  };
}
