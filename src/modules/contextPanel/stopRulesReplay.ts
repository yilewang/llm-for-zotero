/**
 * Native acceptance fixtures for the agent stop rules
 * (docs/plans/2026-10-13-agent-stop-rules.md, Tests): only the model is
 * scripted, at no API cost. Each turn runs through the panel's real send
 * flow and the real runtime; the library tools are stubs that answer as the
 * real ones shape their results, and scenario 8 drives the real Anthropic
 * adapter over a stubbed fetch to read the request it sends.
 */
import { sendAgentTurn } from "./agentMode/agentEngine";
import { buildAgentEngineDepsForTests, getConversationKey } from "./chat";
import { getConversationWriteGeneration } from "../../shared/conversationWriteFence";
import { getAgentRunTrace } from "../../agent/store/traceStore";
import { latestExecutionCheckpoint } from "../../agent/execution/checkpoint";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../../agent/originalAgentPermissionMode";
import { AgentRuntime } from "../../agent/runtime";
import { AgentToolRegistry } from "../../agent/tools/registry";
import { ActionContractService } from "../../agent/contracts/actionContract";
import { ZoteroGateway } from "../../agent/services/zoteroGateway";
import { AnthropicMessagesAgentAdapter } from "../../agent/model/anthropicMessages";
import type { AgentStepParams } from "../../agent/model/adapter";
import type { TurnSafetyLimits } from "../../agent/loop/turnBoundary";
import type { CollectionContextRef } from "../../shared/types";
import type { TaskPaperScopeSet } from "../../agent/context/taskPaperScopeListing";
import type {
  AgentModelMessage,
  AgentModelStep,
  AgentToolCall,
} from "../../agent/types";
import { scriptedJobTurn, stubPaperReadTool } from "./longJobReplay";

export type StopRuleScenario =
  | "runaway_search"
  | "late_find"
  | "non_library_work"
  | "early_not_found"
  | "proper_not_found"
  | "network_retries"
  | "long_job_clock"
  | "anthropic_final_only"
  | "runaway_few_calls"
  | "checkpoint_then_lookalike"
  | "final_only_refusal"
  | "tool_choice_rejected"
  | "final_only_absence"
  | "prompt_too_long"
  | "abort_during_backoff"
  | "long_job_budget_resume"
  | "final_only_empty"
  | "scripted_analysis"
  | "step_past_tool_limit";

/** The search checkpoint and final-only texts, as the host writes them. */
const CHECKPOINT_MARK = "Search checkpoint.";
const FINAL_ONLY_MARK = "Answer now, without calling any tool.";
const REFUSAL_MARK = "Not run: this step is for the answer";

function contentText(message: AgentModelMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n");
}

const toolStep = (calls: AgentToolCall[]): AgentModelStep => ({
  kind: "tool_calls",
  calls,
  assistantMessage: { role: "assistant", content: "", tool_calls: calls },
});

const finalStep = (text: string): AgentModelStep => ({
  kind: "final",
  text,
  assistantMessage: { role: "assistant", content: text },
});

/** The library tools as the scenarios need them, shaped as the real ones. */
function stubLibraryTools(libraryID: number) {
  const read = (name: string, execute: (args: any) => unknown) =>
    ({
      spec: {
        name,
        description: name,
        inputSchema: { type: "object" },
        executionClass: "read",
        workCategory: "retrieval",
      },
      validate: (args: unknown) => ({ ok: true, value: args as never }),
      execute: async (args: unknown) => execute(args),
    }) as never;
  return [
    // A catalog search lists lookalikes, never the paper asked about.
    // `empty` scripts a title lookup that finds no item.
    read("library_search", (args) =>
      args?.empty
        ? { results: [], totalCount: 0, returnedCount: 0, limited: false }
        : {
            results: [
              {
                itemId: 9001,
                title: `Lookalike for ${String(args?.text || "")}`,
              },
            ],
            totalCount: 1,
            returnedCount: 1,
            limited: false,
          },
    ),
    // Evidence retrieval marks lookalikes strong, as it does in the field.
    read("library_retrieve", (args) => ({
      query: String(args?.query || ""),
      paperMatches: [
        {
          itemId: "9002",
          title: `Strong lookalike for ${String(args?.query || "")}`,
          matchStatus: args?.weak ? "weak" : "strong",
          basis: ["chunk_text"],
          returnedSnippetCount: 2,
          confidence: "high",
          whyMatched: "shared terms",
        },
      ],
    })),
    // Work outside the library whose results are new each time.
    read("run_command", (args) => ({
      stdout: `output of ${String(args?.command || "")}`,
      exitCode: 0,
    })),
    stubPaperReadTool(libraryID),
  ];
}

type TurnRecord = {
  runStatus?: string;
  finalText?: string;
  chatText?: string;
  end?: string;
  stopRule?: string;
  steps: number;
  prompts: string[];
  toolChoices: Array<string | undefined>;
  rounds: Array<Record<string, unknown>>;
  boundaries: Array<Record<string, unknown>>;
  retries: Array<Record<string, unknown>>;
};

/**
 * One turn through the panel's send flow with a fresh runtime over the stub
 * library tools. `step` scripts each model request from what the model is
 * sent; `adapter` replaces the scripted model with a real adapter.
 */
async function stopRuleTurn(
  panel: { body: HTMLElement; item: Zotero.Item },
  input: {
    question: string;
    step?: (
      messages: AgentModelMessage[],
      params: AgentStepParams,
      index: number,
    ) => AgentModelStep | Promise<AgentModelStep>;
    adapter?: () => AnthropicMessagesAgentAdapter;
    collection?: CollectionContextRef;
    scope?: TaskPaperScopeSet;
    now?: () => number;
    turnLimits?: Partial<TurnSafetyLimits>;
    /** The retry waits; none unless a scenario presses Stop during one. */
    retryBackoffMs?: readonly number[];
    /** Real tools of the plugin's runtime, beside the stubs. */
    realTools?: readonly string[];
  },
): Promise<TurnRecord> {
  const { body, item } = panel;
  const key = getConversationKey(item);
  const deps = buildAgentEngineDepsForTests(
    item,
    "upstream",
    getConversationWriteGeneration(key),
  );
  const registry = new AgentToolRegistry(
    new ActionContractService(new ZoteroGateway()),
  );
  registry.register(deps.getAgentRuntime().getToolDefinition("task_update")!);
  for (const tool of stubLibraryTools(item.libraryID)) registry.register(tool);
  for (const name of input.realTools || [])
    registry.register(deps.getAgentRuntime().getToolDefinition(name)!);
  const prompts: string[] = [];
  const toolChoices: Array<string | undefined> = [];
  let steps = 0;
  const runtime = new AgentRuntime({
    registry,
    ...(input.scope ? { resolveTurnScopePapers: async () => input.scope } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.turnLimits ? { turnLimits: input.turnLimits } : {}),
    // The retry policy's waits are its own; the scenarios need its order.
    modelRetryBackoffMs: input.retryBackoffMs ?? [0, 0],
    adapterFactory: (request) => {
      if (input.adapter) {
        // The real adapter reads the provider from the request.
        Object.assign(request, {
          model: "claude-sonnet-4-5",
          apiBase: "https://api.anthropic.com/v1",
          providerProtocol: "anthropic_messages",
          authMode: "api_key",
          apiKey: "workflow-dummy-key",
        });
        const adapter = input.adapter();
        const runStep = adapter.runStep.bind(adapter);
        adapter.runStep = async (params) => {
          steps += 1;
          prompts.push(params.messages.map(contentText).join("\n"));
          toolChoices.push(params.toolChoice);
          return runStep(params);
        };
        return adapter;
      }
      return {
        supportsTools: () => true,
        getCapabilities: () => ({
          streaming: true,
          toolCalls: true,
          multimodal: false,
          fileInputs: false,
          reasoning: false,
        }),
        runStep: async (params): Promise<AgentModelStep> => {
          steps += 1;
          prompts.push(params.messages.map(contentText).join("\n"));
          toolChoices.push(params.toolChoice);
          return input.step!(params.messages, params, steps);
        },
      };
    },
  });
  deps.getAgentRuntime = () => runtime;
  await sendAgentTurn(
    {
      body,
      item,
      question: input.question,
      ...(input.collection
        ? { selectedCollectionContexts: [input.collection] }
        : {}),
      advanced: { temperature: 0, outputTokenLimit: { mode: "auto" } },
    },
    deps,
  );
  const message = deps.chatHistory.get(key)?.at(-1);
  const trace = await getAgentRunTrace(message?.agentRunId || "");
  const events = trace.events.map((event) => event.payload);
  const provider = (type: string) =>
    events.flatMap((event) =>
      event.type === "provider_event" && event.providerType === type
        ? [{ ...(event.payload || {}) } as Record<string, unknown>]
        : [],
    );
  return {
    runStatus: trace.run?.status,
    finalText: trace.run?.finalText,
    chatText: message?.text,
    end: latestExecutionCheckpoint(trace.events)?.end?.state,
    stopRule: provider("agent_run_stop")[0]?.rule as string | undefined,
    steps,
    prompts,
    toolChoices,
    rounds: provider("agent_round_progress"),
    boundaries: provider("agent_search_boundary"),
    retries: provider("agent_model_retry"),
  };
}

/** A navigation round of three new searches. */
const searchRound = (round: number): AgentModelStep =>
  toolStep([
    {
      id: `search-${round}-a`,
      name: "library_search",
      arguments: { entity: "items", mode: "search", text: `query ${round}a` },
    },
    {
      id: `search-${round}-b`,
      name: "library_retrieve",
      arguments: { query: `query ${round}b` },
    },
    {
      id: `search-${round}-c`,
      name: "library_retrieve",
      arguments: { query: `query ${round}c` },
    },
  ]);

const lastPrompt = (messages: AgentModelMessage[]) =>
  contentText(messages[messages.length - 1] || { role: "user", content: "" });

/** A ReadableStream that sends `frames` and then breaks like a dropped link. */
function brokenStream(frames: string[]): ReadableStream<Uint8Array> {
  const Stream = ((globalThis as { ReadableStream?: typeof ReadableStream })
    .ReadableStream ??
    ztoolkit.getGlobal("ReadableStream")) as typeof ReadableStream;
  const encoder = new TextEncoder();
  let sent = false;
  return new Stream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        return;
      }
      controller.error(new Error("Error in input stream"));
    },
  });
}

/** Swaps the plugin's fetch for `fetch` while `task` runs. */
async function withStubbedFetch<T>(
  fetch: (url: string, init: RequestInit) => Promise<unknown>,
  task: () => Promise<T>,
): Promise<T> {
  const toolkit = ztoolkit as unknown as {
    getGlobal: (name: string) => unknown;
  };
  const original = toolkit.getGlobal;
  toolkit.getGlobal = function (this: unknown, name: string) {
    return name === "fetch" ? fetch : original.call(this, name);
  };
  try {
    return await task();
  } finally {
    toolkit.getGlobal = original;
  }
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    body: null,
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

export async function exerciseAgentStopRules(
  panel: { body: HTMLElement; item: Zotero.Item },
  input: {
    scenario: StopRuleScenario;
    collection?: CollectionContextRef;
    papers?: Array<{ itemId: number; title: string }>;
  },
): Promise<Record<string, unknown>> {
  const { body, item } = panel;
  body.style.left = "0";
  body.style.width = "420px";
  body.style.zIndex = "99999";
  const previousMode = getOriginalAgentPermissionMode();
  setOriginalAgentPermissionMode("auto");
  try {
    switch (input.scenario) {
      // 1. New searches forever, with strong matches: a checkpoint, then the
      // answer without tools, within 2W + 2 rounds.
      case "runaway_search": {
        const turn = await stopRuleTurn(panel, {
          question: "Which paper in my library is this excerpt citing?",
          step: (messages, params, index) =>
            params.toolChoice === "none" ||
            lastPrompt(messages).includes(FINAL_ONLY_MARK)
              ? finalStep(
                  "Not confirmed: the searches found only lookalikes; the closest items are listed above.",
                )
              : searchRound(index),
        });
        return {
          turn,
          checkpointSeen: turn.prompts.some((prompt) =>
            prompt.includes(CHECKPOINT_MARK),
          ),
        };
      }
      // 2. W - 1 navigation rounds, then the right paper is read: no
      // checkpoint.
      case "late_find": {
        const turn = await stopRuleTurn(panel, {
          question: "Which paper in my library is this excerpt citing?",
          step: (_messages, _params, index) =>
            index <= 7
              ? searchRound(index)
              : index === 8
                ? toolStep([
                    {
                      id: "read-found",
                      name: "paper_read",
                      arguments: {
                        target: {
                          itemId: item.id,
                          contextItemId: item.id,
                          libraryID: item.libraryID,
                        },
                      },
                    },
                  ])
                : finalStep(`The excerpt cites item ${item.id}.`),
        });
        return {
          turn,
          checkpointSeen: turn.prompts.some((prompt) =>
            prompt.includes(CHECKPOINT_MARK),
          ),
        };
      }
      // 3. Thirty rounds of work outside the library, each with new results:
      // no checkpoint.
      case "non_library_work": {
        const turn = await stopRuleTurn(panel, {
          question: "Run the analysis steps one by one.",
          step: (_messages, _params, index) =>
            index <= 30
              ? toolStep([
                  {
                    id: `command-${index}`,
                    name: "run_command",
                    arguments: { command: `step ${index}` },
                  },
                ])
              : finalStep("All thirty steps ran."),
        });
        return {
          turn,
          checkpointSeen: turn.prompts.some((prompt) =>
            prompt.includes(CHECKPOINT_MARK),
          ),
        };
      }
      // 4. "Not in your library" after one search: accepted as written.
      case "early_not_found": {
        const turn = await stopRuleTurn(panel, {
          question: "Which paper in my library is this excerpt citing?",
          step: (_messages, _params, index) =>
            index === 1
              ? toolStep([
                  {
                    id: "retrieve-once",
                    name: "library_retrieve",
                    arguments: { query: "place cell drift" },
                  },
                ])
              : finalStep("The cited paper is not in your library."),
        });
        return { turn };
      }
      // 5. "Not found" after a title lookup and a topical search: it ends
      // the turn.
      case "proper_not_found": {
        const turn = await stopRuleTurn(panel, {
          question: "Which paper in my library is this excerpt citing?",
          step: (_messages, _params, index) =>
            index === 1
              ? toolStep([
                  {
                    id: "lookup-title",
                    name: "library_search",
                    arguments: {
                      entity: "items",
                      mode: "search",
                      text: "Smith 2020 Representational drift",
                    },
                  },
                ])
              : index === 2
                ? toolStep([
                    {
                      id: "topical",
                      name: "library_retrieve",
                      arguments: { query: "place cell drift", weak: true },
                    },
                  ])
                : finalStep("The cited paper is not in your library."),
        });
        // A title lookup and an author lookup that found no item, beside a
        // passage search that ranks a lookalike strong: the answer ends the turn.
        const decisive = await stopRuleTurn(panel, {
          question: "Which paper in my library is this other excerpt citing?",
          step: (_messages, _params, index) =>
            index === 1
              ? toolStep([
                  {
                    id: "lookup-empty",
                    name: "library_search",
                    arguments: {
                      entity: "items",
                      mode: "search",
                      text: "Jones 2019 Grid cell remapping",
                      empty: true,
                    },
                  },
                  {
                    id: "lookup-empty-author",
                    name: "library_search",
                    arguments: {
                      entity: "items",
                      mode: "search",
                      filters: { author: "Jones" },
                      empty: true,
                    },
                  },
                  {
                    id: "topical-strong",
                    name: "library_retrieve",
                    arguments: { query: "grid cell remapping" },
                  },
                ])
              : finalStep("The cited paper is not in your library."),
        });
        return { turn, decisive };
      }
      // 6. Two network failures, then success: one answer, nothing twice.
      // Three failures: interrupted, and "continue" resumes.
      case "network_retries": {
        const networkError = () =>
          new TypeError("NetworkError when attempting to fetch resource.");
        const recovered = await stopRuleTurn(panel, {
          question: "Explain the finding.",
          step: async (_messages, params, index) => {
            if (index === 1) {
              await params.onTextDelta?.("Partial answer that ");
              throw networkError();
            }
            if (index === 2) throw networkError();
            await params.onTextDelta?.("The finding holds.");
            return finalStep("The finding holds.");
          },
        });
        // The real Anthropic adapter: a stream that breaks mid-answer is
        // classified as a broken stream and sent again.
        let anthropicCalls = 0;
        const anthropic = await withStubbedFetch(
          async (url) => {
            if (!String(url).endsWith("/messages"))
              return jsonResponse({ error: "not found" }, 404);
            anthropicCalls += 1;
            if (anthropicCalls === 1)
              return {
                ok: true,
                status: 200,
                statusText: "OK",
                headers: { get: () => "text/event-stream" },
                body: brokenStream([
                  'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
                  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
                  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Broken half "}}\n\n',
                ]),
              };
            return jsonResponse({
              content: [{ type: "text", text: "Whole answer." }],
              stop_reason: "end_turn",
              usage: { input_tokens: 10, output_tokens: 3 },
            });
          },
          () =>
            stopRuleTurn(panel, {
              question: "Explain the finding again.",
              adapter: () => new AnthropicMessagesAgentAdapter(),
            }),
        );
        const lost = await stopRuleTurn(panel, {
          question: "Explain the method.",
          step: async () => {
            throw networkError();
          },
        });
        const resumed = await stopRuleTurn(panel, {
          question: "continue",
          step: () => finalStep("The method, continued."),
        });
        return {
          recovered,
          anthropic: { ...anthropic, calls: anthropicCalls },
          lost,
          resumed,
          resumeNoteSeen: resumed.prompts.some((prompt) =>
            prompt.includes("Resume note:"),
          ),
        };
      }
      // 7. A long job that keeps settling papers runs past every per-turn
      // limit, the clock included, and never stops budget_reached; the same
      // job stops once its papers stop settling.
      case "long_job_clock": {
        const papers = input.papers || [];
        const collection = input.collection!;
        const scope: TaskPaperScopeSet = {
          wholeLibrary: false,
          itemIds: papers.map((paper) => paper.itemId),
          withText: papers.length,
          papers: Object.fromEntries(
            papers.map((paper) => [
              paper.itemId,
              { title: paper.title, text: "pdf" as const },
            ]),
          ),
        };
        // Ten minutes pass with every model request.
        let clock = Date.now();
        const now = () => clock;
        const readCall = (itemId: number, id: string): AgentToolCall => ({
          id,
          name: "paper_read",
          arguments: {
            target: {
              itemId,
              contextItemId: itemId,
              libraryID: item.libraryID,
            },
          },
        });
        const declare = (taskId: string) =>
          toolStep([
            {
              id: `declare-${taskId}`,
              name: "task_update",
              arguments: {
                tasks: [
                  {
                    taskId,
                    description: `Read each paper in ${collection.name}`,
                    expectedEffect: "read",
                    scope: true,
                  },
                ],
              },
            },
          ]);
        const steady = await stopRuleTurn(panel, {
          question: `Read each paper in ${collection.name}, one at a time`,
          collection,
          scope,
          now,
          turnLimits: { modelCalls: 4 },
          step: (_messages, _params, index) => {
            clock += 10 * 60_000;
            if (index === 1) return declare("read-all");
            const paper = papers[index - 2];
            return paper
              ? toolStep([readCall(paper.itemId, `read-${index}`)])
              : finalStep("Every paper is read.");
          },
        });
        const steadyElapsedMinutes = Math.round(
          (steady.steps * 10 * 60_000) / 60_000,
        );
        // The same job whose model keeps reading the first paper again: no
        // paper settles, so the clock reaches 30 minutes.
        const stalled = await stopRuleTurn(panel, {
          question: `Read each paper in ${collection.name} again, one at a time`,
          collection,
          scope,
          now,
          step: (_messages, _params, index) => {
            clock += 10 * 60_000;
            if (index === 1) return declare("read-again");
            if (index === 2)
              return toolStep([readCall(papers[0].itemId, `again-${index}`)]);
            return toolStep([
              {
                id: `stall-${index}`,
                name: "run_command",
                arguments: { command: "status" },
              },
            ]);
          },
        });
        return { steady, steadyElapsedMinutes, stalled };
      }
      // A runaway of one call a round, and of 1.4 calls a round: the
      // checkpoint, then the answer without tools; never a segment stop.
      case "runaway_few_calls": {
        const runaway = (perRound: (index: number) => number) =>
          stopRuleTurn(panel, {
            question: "Which paper in my library is this excerpt citing?",
            step: (messages, params, index) =>
              params.toolChoice === "none" ||
              lastPrompt(messages).includes(FINAL_ONLY_MARK)
                ? finalStep(
                    "Not confirmed: the searches found only lookalikes.",
                  )
                : toolStep(
                    Array.from({ length: perRound(index) }, (_, call) => ({
                      id: `few-${index}-${call}`,
                      name: "library_retrieve",
                      arguments: { query: `query ${index}.${call}` },
                    })),
                  ),
          });
        return {
          one: await runaway(() => 1),
          mixed: await runaway((index) => (index % 5 < 2 ? 2 : 1)),
        };
      }
      // One checkpoint per turn: the model reads a lookalike after it,
      // searches again, and the next full window asks for the answer.
      case "checkpoint_then_lookalike": {
        const turn = await stopRuleTurn(panel, {
          question: "Which paper in my library is this excerpt citing?",
          step: (messages, params, index) =>
            params.toolChoice === "none" ||
            lastPrompt(messages).includes(FINAL_ONLY_MARK)
              ? finalStep("Not confirmed: the lookalike was not the paper.")
              : index === 9
                ? toolStep([
                    {
                      id: "read-lookalike",
                      name: "paper_read",
                      arguments: {
                        target: {
                          itemId: 9002,
                          contextItemId: 9002,
                          libraryID: item.libraryID,
                        },
                      },
                    },
                  ])
                : searchRound(index),
        });
        return { turn };
      }
      // A provider without tool_choice none: the final-only step still calls
      // tools. Each call gets a "Not run" result and the step is asked
      // again; a second time, the host writes the answer from its record.
      // Then a model that answers after one refusal.
      case "final_only_refusal": {
        const stubborn = await stopRuleTurn(panel, {
          question: "Which paper in my library is this excerpt citing?",
          step: (_messages, _params, index) => searchRound(index),
        });
        let refused = false;
        const relenting = await stopRuleTurn(panel, {
          question: "Which paper in my library is this excerpt citing? Again.",
          step: (messages, params, index) => {
            const text = messages.map(contentText).join("\n");
            if (params.toolChoice === "none" && !refused) {
              refused = true;
              return searchRound(index);
            }
            return refused && text.includes(REFUSAL_MARK)
              ? finalStep("Not confirmed: only lookalikes were found.")
              : searchRound(index);
          },
        });
        return {
          stubborn,
          stubbornRefusalSeen: stubborn.prompts.some((prompt) =>
            prompt.includes(REFUSAL_MARK),
          ),
          relenting,
        };
      }
      // A provider that answers tool_choice none with HTTP 400: the step is
      // sent again with the default choice.
      case "tool_choice_rejected": {
        const turn = await stopRuleTurn(panel, {
          question: "Which paper in my library is this excerpt citing?",
          step: (_messages, params, index) => {
            if (params.toolChoice === "none")
              throw Object.assign(
                new Error(
                  "400 Bad Request - tool_choice 'none' is not supported by this model",
                ),
                { status: 400 },
              );
            return index > 2 * 8
              ? finalStep("Not confirmed: only lookalikes were found.")
              : searchRound(index);
          },
        });
        return { turn };
      }
      // The final-only answer claims the paper is absent: it is accepted as
      // written, with no second request without tools.
      case "final_only_absence": {
        const turn = await stopRuleTurn(panel, {
          question: "Which paper in my library is this excerpt citing?",
          step: (_messages, params, index) =>
            params.toolChoice === "none"
              ? finalStep("The cited paper is not in your library.")
              : toolStep(
                  ["a", "b", "c"].map((suffix) => ({
                    id: `absence-${index}-${suffix}`,
                    name: "library_retrieve",
                    arguments: { query: `query ${index}${suffix}` },
                  })),
                ),
        });
        return {
          turn,
          finalOnlyRequests: turn.toolChoices.filter(
            (choice: unknown) => choice === "none",
          ).length,
        };
      }
      // A prompt the provider calls too long: compacted once and sent again;
      // too long again after the compaction, the turn stops resumable.
      case "prompt_too_long": {
        const tooLong = () =>
          new Error(
            "400 Bad Request - prompt is too long: 230000 tokens > 200000 maximum",
          );
        const compacted = await stopRuleTurn(panel, {
          question: "Summarize the earlier discussion.",
          step: (_messages, _params, index) => {
            if (index === 1) throw tooLong();
            return finalStep("The summary.");
          },
        });
        const exceeded = await stopRuleTurn(panel, {
          question: "Summarize it again.",
          step: () => {
            throw tooLong();
          },
        });
        return { compacted, exceeded };
      }
      // Stop pressed while the runtime waits to retry: the turn ends
      // cancelled at once, not after the wait.
      case "abort_during_backoff": {
        const started = Date.now();
        const turn = await stopRuleTurn(panel, {
          question: "Explain the finding.",
          retryBackoffMs: [60_000, 60_000],
          step: async () => {
            setTimeout(() => {
              (
                body.querySelector("#llm-cancel") as HTMLButtonElement | null
              )?.click();
            }, 300);
            throw new TypeError(
              "NetworkError when attempting to fetch resource.",
            );
          },
        });
        return { turn, elapsedMs: Date.now() - started };
      }
      // A final-only reply with thinking and no text: asked once more with
      // the instruction; empty again, the host writes the answer.
      case "final_only_empty": {
        const thinkingOnly = async (params: AgentStepParams) => {
          await params.onReasoning?.({
            details: "Thinking about the lookalikes.",
          });
          return finalStep("");
        };
        const silent = await stopRuleTurn(panel, {
          question: "Which paper in my library is this excerpt citing?",
          step: (_messages, params, index) =>
            params.toolChoice === "none"
              ? thinkingOnly(params)
              : searchRound(index),
        });
        let empties = 0;
        const recovering = await stopRuleTurn(panel, {
          question: "Which paper in my library is this excerpt citing? Again.",
          step: (_messages, params, index) => {
            if (params.toolChoice !== "none") return searchRound(index);
            empties += 1;
            return empties === 1
              ? thinkingOnly(params)
              : finalStep("Not confirmed: only lookalikes were found.");
          },
        });
        return { silent, recovering };
      }
      // A long job stopped mid-page by its safety limit keeps its work;
      // "continue" goes on from the first paper not done, and no paper gets
      // two notes.
      case "long_job_budget_resume": {
        const papers = input.papers || [];
        const collection = input.collection!;
        const scope: TaskPaperScopeSet = {
          wholeLibrary: false,
          itemIds: papers.map((paper) => paper.itemId),
          withText: papers.length,
          papers: Object.fromEntries(
            papers.map((paper) => [
              paper.itemId,
              { title: paper.title, text: "pdf" as const },
            ]),
          ),
        };
        let calls = 0;
        const readCall = (itemId: number): AgentToolCall => ({
          id: `read-${itemId}-${(calls += 1)}`,
          name: "paper_read",
          arguments: {
            target: {
              itemId,
              contextItemId: itemId,
              libraryID: item.libraryID,
            },
          },
        });
        const noteCall = (itemId: number): AgentToolCall => ({
          id: `note-${itemId}-${(calls += 1)}`,
          name: "note_write",
          arguments: {
            mode: "create",
            target: "item",
            targetItemId: itemId,
            content: `# Paper ${itemId}\n\nNote on paper ${itemId}.`,
          },
        });
        const latestHost = (messages: AgentModelMessage[]) =>
          [...messages]
            .reverse()
            .map(contentText)
            .find((text) => text.startsWith("Long job"));
        const pageOf = (host: string) =>
          [...host.matchAll(/^- itemId=(\d+)/gm)].map((match) =>
            Number(match[1]),
          );
        const workPage = (
          page: number[],
          read: Set<number>,
          noted: Set<number>,
        ): AgentModelStep | null => {
          const toRead = page.filter((itemId) => !read.has(itemId));
          if (toRead.length) {
            for (const itemId of toRead) read.add(itemId);
            return toolStep(toRead.map(readCall));
          }
          const toNote = page.filter((itemId) => !noted.has(itemId));
          if (!toNote.length) return null;
          for (const itemId of toNote) noted.add(itemId);
          return toolStep(toNote.map(noteCall));
        };
        const NOTE_ALL = "Save a note on each paper";
        const stopAfterNotes = 4;
        const read = new Set<number>();
        const noted = new Set<number>();
        let declared = false;
        const first = await scriptedJobTurn(panel, {
          collection,
          scope,
          inputTokenCap: 40_000,
          writeTool: "note_write",
          // Three requests without a settled paper stop the job.
          turnLimits: { modelCalls: 3 },
          question: `Read each paper in ${collection.name} and save a note on each`,
          step: (messages) => {
            if (!declared) {
              declared = true;
              return toolStep([
                {
                  id: "declare-job",
                  name: "task_update",
                  arguments: {
                    tasks: [
                      {
                        taskId: "read-all",
                        description: `Read each paper in ${collection.name}`,
                        expectedEffect: "read",
                        scope: true,
                      },
                      {
                        taskId: "note-all",
                        description: NOTE_ALL,
                        expectedEffect: "mutation",
                        expectedCapability: "zotero.notes",
                        scope: true,
                      },
                    ],
                  },
                },
              ]);
            }
            // Mid-page, with papers read whose notes are not written, the
            // model stalls: it reads a paper it already read, settling
            // nothing.
            if (noted.size >= stopAfterNotes && read.size > noted.size)
              return toolStep([readCall([...read][0])]);
            const host = latestHost(messages);
            const next =
              host && !host.startsWith("Long job complete")
                ? workPage(pageOf(host), read, noted)
                : null;
            return next || finalStep("Every paper has its note.");
          },
        });
        const resumedRead = new Set<number>();
        const resumedNoted = new Set<number>();
        let resumed = false;
        const second = await scriptedJobTurn(panel, {
          collection,
          scope,
          inputTokenCap: 40_000,
          writeTool: "note_write",
          question: "continue",
          step: (messages) => {
            const host = latestHost(messages);
            if (!resumed) {
              resumed = true;
              const left =
                /papers? left, in order: ([\d, ]+)\./
                  .exec(messages.map(contentText).join("\n"))?.[1]
                  ?.split(", ")
                  .map(Number) ?? [];
              const firstPapers = left.slice(0, 2);
              for (const itemId of firstPapers) resumedRead.add(itemId);
              return toolStep(firstPapers.map(readCall));
            }
            if (host?.startsWith("Long job complete"))
              return finalStep("Every paper has its note.");
            const page = host
              ? pageOf(host)
              : [...resumedRead].filter((itemId) => !resumedNoted.has(itemId));
            return (
              workPage(page, resumedRead, resumedNoted) ||
              finalStep("Every paper has its note.")
            );
          },
        });
        const notesPerPaper: Record<number, number> = {};
        for (const paper of papers) {
          const parent = Zotero.Items.get(paper.itemId);
          await parent.reload(["childItems"], true);
          notesPerPaper[paper.itemId] = parent.getNotes().length;
        }
        return {
          first: {
            runStatus: first.runStatus,
            end: first.end,
            stopRule: first.stopRule,
            read: read.size,
            noted: [...noted],
          },
          second: {
            runStatus: second.runStatus,
            end: second.end,
            stopRule: second.stopRule,
            resumeNote:
              /Long job to resume:[^\n]*/.exec(second.firstPrompt)?.[0] || "",
          },
          notesPerPaper,
        };
      }
      // 8. final_only over an Anthropic history with tool_use and
      // tool_result blocks: the request keeps its tools and sets
      // tool_choice {type:"none"}.
      case "anthropic_final_only": {
        const requests: Array<Record<string, any>> = [];
        let call = 0;
        const turn = await withStubbedFetch(
          async (url, init) => {
            if (!String(url).endsWith("/messages"))
              return jsonResponse({ error: "not found" }, 404);
            const payload = JSON.parse(String(init.body || "{}"));
            requests.push(payload);
            if (payload.tool_choice?.type === "none")
              return jsonResponse({
                content: [
                  {
                    type: "text",
                    text: "Not confirmed: only lookalikes were found.",
                  },
                ],
                stop_reason: "end_turn",
                usage: { input_tokens: 10, output_tokens: 8 },
              });
            call += 1;
            return jsonResponse({
              content: [
                {
                  type: "tool_use",
                  id: `toolu_${call}_a`,
                  name: "library_search",
                  input: { entity: "items", mode: "search", text: `q${call}a` },
                },
                {
                  type: "tool_use",
                  id: `toolu_${call}_b`,
                  name: "library_retrieve",
                  input: { query: `q${call}b` },
                },
                {
                  type: "tool_use",
                  id: `toolu_${call}_c`,
                  name: "library_retrieve",
                  input: { query: `q${call}c` },
                },
              ],
              stop_reason: "tool_use",
              usage: { input_tokens: 10, output_tokens: 8 },
            });
          },
          () =>
            stopRuleTurn(panel, {
              question: "Which paper in my library is this excerpt citing?",
              adapter: () => new AnthropicMessagesAgentAdapter(),
            }),
        );
        const last = requests[requests.length - 1] || {};
        const lastMessages: Array<{ role?: string; content?: unknown }> =
          last.messages || [];
        const blocksOf = (message?: { content?: unknown }) =>
          Array.isArray(message?.content)
            ? (message!.content as Array<{ type?: string; text?: string }>)
            : [{ type: "text", text: String(message?.content ?? "") }];
        const finalMessage = lastMessages[lastMessages.length - 1];
        const beforeFinal = lastMessages[lastMessages.length - 2];
        const blockTypes = (last.messages || []).flatMap(
          (message: { content?: unknown }) =>
            Array.isArray(message.content)
              ? message.content.map((block: { type?: string }) => block.type)
              : [],
        );
        return {
          turn,
          requests: requests.length,
          lastToolChoice: last.tool_choice,
          lastToolNames: (last.tools || []).map(
            (tool: { name?: string }) => tool.name,
          ),
          lastHasToolUse: blockTypes.includes("tool_use"),
          lastHasToolResult: blockTypes.includes("tool_result"),
          // The instruction is the last thing sent, right after the results.
          finalMessageRole: finalMessage?.role,
          finalMessageText: blocksOf(finalMessage)
            .map((block) => block.text || "")
            .join("\n"),
          beforeFinalRole: beforeFinal?.role,
          beforeFinalTypes: blocksOf(beforeFinal).map((block) => block.type),
          earlierToolChoices: requests
            .slice(0, -1)
            .map((request) => request.tool_choice?.type),
        };
      }
      // Twenty read-only scripts through the real zotero_script: with new
      // results they are progress and get no checkpoint; with the same
      // result (new script text, new log line) they still reach it.
      case "scripted_analysis": {
        const script = (index: number, same: boolean): AgentModelStep =>
          toolStep([
            {
              id: `script-${same ? "same" : "new"}-${index}`,
              name: "zotero_script",
              arguments: {
                access: "library",
                effect: "read",
                description: `Library analysis ${index}`,
                script: [
                  "const items = await Zotero.Items.getAll(env.libraryID, false, false, false);",
                  "const papers = items.filter((item) => item.isRegularItem());",
                  `env.log("pass ${index}");`,
                  same
                    ? "return { hasPapers: papers.length > 0 };"
                    : `return { pass: ${index}, papers: papers.length };`,
                ].join("\n"),
              },
            },
          ]);
        const run = (same: boolean) =>
          stopRuleTurn(panel, {
            question:
              "Make a table of my library's papers per year and journal.",
            realTools: ["zotero_script"],
            step: (messages, params, index) =>
              index <= 20 &&
              params.toolChoice !== "none" &&
              !lastPrompt(messages).includes(FINAL_ONLY_MARK)
                ? script(index, same)
                : finalStep("Papers per year and journal: see the table."),
          });
        const distinct = await run(false);
        const repeated = await run(true);
        return { distinct, repeated };
      }
      // A step of nine calls under the limit of eight: the first eight run
      // (a real tag write among them), the ninth (a real tag write) does not
      // and is made in the next step.
      case "step_past_tool_limit": {
        const stamp = Date.now();
        const withinTag = `w4-within-limit-${stamp}`;
        const pastTag = `w4-past-limit-${stamp}`;
        const tagWrite = (id: string, tag: string): AgentToolCall => ({
          id,
          name: "library_update",
          arguments: {
            kind: "tags",
            action: "add",
            itemIds: [item.id],
            tags: [tag],
          },
        });
        const nativeTags = async () => {
          const current = (await Zotero.Items.getAsync(item.id)) as Zotero.Item;
          return current.getTags().map((entry) => entry.tag);
        };
        let tagsAfterFirstStep: string[] = [];
        let pastResult = "";
        const turn = await stopRuleTurn(panel, {
          question: "Run every step and tag the paper.",
          realTools: ["library_update"],
          step: async (messages, _params, index) => {
            if (index === 1)
              return toolStep([
                ...Array.from({ length: 8 }, (_, call) =>
                  call === 1
                    ? tagWrite("tag-within", withinTag)
                    : {
                        id: `command-${call}`,
                        name: "run_command",
                        arguments: { command: `step ${call}` },
                      },
                ),
                tagWrite("tag-past", pastTag),
              ]);
            if (index === 2) {
              tagsAfterFirstStep = await nativeTags();
              const result = messages.find(
                (message) =>
                  message.role === "tool" &&
                  message.tool_call_id === "tag-past",
              );
              pastResult = result ? contentText(result) : "";
              return toolStep([tagWrite("tag-past-again", pastTag)]);
            }
            return finalStep("Every step ran and the paper is tagged.");
          },
        });
        return {
          turn,
          withinTag,
          pastTag,
          tagsAfterFirstStep,
          pastResult,
        };
      }
    }
  } finally {
    setOriginalAgentPermissionMode(previousMode);
  }
}
