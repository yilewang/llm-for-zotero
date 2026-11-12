/**
 * Native acceptance fixture for a long job: only the model is scripted. The
 * runtime pages a folder's papers through the real task_update tool, the
 * real event handling and the real Task progress view; paper_read is a stub
 * that returns each paper's text, sized to the page share the host sets.
 */
import { sendAgentTurn } from "./agentMode/agentEngine";
import { buildAgentEngineDepsForTests, getConversationKey } from "./chat";
import { flushTaskProgressPanels } from "./taskProgress/panel";
import { getConversationWriteGeneration } from "../../shared/conversationWriteFence";
import {
  getAgentRunTrace,
  initAgentTraceStore,
} from "../../agent/store/traceStore";
import { clearAgentTranscriptStore } from "../../agent/store/transcriptStore";
import { clearAgentToolResultHandleStore } from "../../agent/store/toolResultHandles";
import { clearAgentEvidenceCache } from "../../agent/context/cacheManagement";
import { clearAgentCoverageLedger } from "../../agent/context/coverageLedger";
import { latestExecutionCheckpoint } from "../../agent/execution/checkpoint";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../../agent/originalAgentPermissionMode";
import { reopenTaskProgressConversation } from "./taskProgressReplay";
import { AgentRuntime } from "../../agent/runtime";
import { AgentToolRegistry } from "../../agent/tools/registry";
import { ActionContractService } from "../../agent/contracts/actionContract";
import { ZoteroGateway } from "../../agent/services/zoteroGateway";
import type { CollectionContextRef } from "../../shared/types";
import type { TaskPaperScopeSet } from "../../agent/context/taskPaperScopeListing";
import type { TurnSafetyLimits } from "../../agent/loop/turnBoundary";
import type {
  AgentActionReceipt,
  AgentModelMessage,
  AgentModelStep,
  AgentToolCall,
  AgentToolContext,
} from "../../agent/types";

/** About this many characters of text per paper, before the page share. */
const PAPER_TEXT_CHARACTERS = 16_000;

/**
 * paper_read as the fixtures script it: each paper's text, its finding
 * first, no longer than the page share the host set for an overview read.
 */
export function stubPaperReadTool(
  libraryID: number,
  paperCharacters = PAPER_TEXT_CHARACTERS,
) {
  return {
    spec: {
      name: "paper_read",
      description: "Read one paper",
      inputSchema: { type: "object" },
      executionClass: "read",
      workCategory: "retrieval",
    },
    validate: (args: unknown) => ({ ok: true, value: args as never }),
    execute: async (args: unknown, context: AgentToolContext) => {
      const target = (args as { target?: { itemId?: number } }).target;
      const itemId = Number(target?.itemId);
      // An overview read takes no more than the page share the host set.
      const share = context.request.runtimeContextBudget?.maxTokensPerPaper;
      const characters = Math.min(
        paperCharacters,
        share ? share * 4 : paperCharacters,
      );
      const text =
        `Finding ${itemId}: drift was measured in this paper. ${"Representational drift details. ".repeat(
          characters / 31,
        )}`.slice(0, characters);
      return {
        mode: "targeted",
        results: [],
        papers: [
          {
            paperContext: { itemId, contextItemId: itemId, libraryID },
            passages: [{ text, sectionLabel: "Results", pageLabel: "2" }],
          },
        ],
      };
    },
  } as never;
}

function contentText(message: AgentModelMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n");
}

export async function exerciseLongJobReplay(
  panel: { body: HTMLElement; item: Zotero.Item },
  input: {
    collection: CollectionContextRef;
    papers: Array<{ itemId: number; title: string }>;
    /** The model's input cap, which sets how many papers a page holds. */
    inputTokenCap: number;
  },
) {
  const { body, item } = panel;
  body.style.left = "0";
  body.style.width = "420px";
  body.style.zIndex = "99999";
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
  registry.register(stubPaperReadTool(item.libraryID));

  // What Task progress showed before each model step: the row's count and
  // the job's step label, as a reader would see them.
  const rowCounts: string[] = [];
  const stepLabels: string[] = [];
  const observe = () => {
    flushTaskProgressPanels();
    const row = body.querySelector("#llm-task-progress") as HTMLElement | null;
    const drawer = body.querySelector(
      "#llm-task-progress-drawer",
    ) as HTMLElement | null;
    if (row && !row.hidden && drawer?.hidden) {
      row.click();
      flushTaskProgressPanels();
    }
    const count =
      body.querySelector(".llm-task-progress-count")?.textContent || "";
    if (count && rowCounts[rowCounts.length - 1] !== count)
      rowCounts.push(count);
    const label =
      body.querySelector(".llm-task-progress-steps .llm-plan-task-label")
        ?.textContent || "";
    if (label && stepLabels[stepLabels.length - 1] !== label)
      stepLabels.push(label);
  };

  const asked = new Set<number>();
  const answer = "Each paper of the folder is summarized from its results.";
  const runtime = new AgentRuntime({
    registry,
    resolveTurnScopePapers: async () => ({
      wholeLibrary: false,
      itemIds: input.papers.map((paper) => paper.itemId),
      withText: input.papers.length,
      papers: Object.fromEntries(
        input.papers.map((paper) => [
          paper.itemId,
          { title: paper.title, text: "pdf" as const },
        ]),
      ),
    }),
    adapterFactory: () => {
      let round = 0;
      const step = (calls: AgentToolCall[]): AgentModelStep => ({
        kind: "tool_calls",
        calls,
        assistantMessage: { role: "assistant", content: "", tool_calls: calls },
      });
      return {
        supportsTools: () => true,
        getCapabilities: () => ({
          streaming: false,
          toolCalls: true,
          multimodal: false,
          fileInputs: false,
          reasoning: false,
        }),
        runStep: async ({ messages }): Promise<AgentModelStep> => {
          observe();
          round += 1;
          if (round === 1)
            return step([
              {
                id: "declare-1",
                name: "task_update",
                arguments: {
                  tasks: [
                    {
                      taskId: "read-all",
                      description: `Read each paper in ${input.collection.name}`,
                      expectedEffect: "read",
                      scope: true,
                    },
                  ],
                },
              },
            ]);
          const host = [...messages]
            .reverse()
            .map(contentText)
            .find((text) => text.startsWith("Long job"));
          const page = host
            ? [...host.matchAll(/^- itemId=(\d+)/gm)]
                .map((match) => Number(match[1]))
                .filter((itemId) => !asked.has(itemId))
                .slice(0, 8)
            : [];
          if (!host || host.startsWith("Long job complete") || !page.length) {
            return {
              kind: "final",
              text: answer,
              assistantMessage: { role: "assistant", content: answer },
            };
          }
          for (const itemId of page) asked.add(itemId);
          return step(
            page.map((itemId) => ({
              id: `read-${itemId}`,
              name: "paper_read",
              arguments: {
                target: {
                  itemId,
                  contextItemId: itemId,
                  libraryID: item.libraryID,
                },
              },
            })),
          );
        },
      };
    },
  });
  deps.getAgentRuntime = () => runtime;
  await sendAgentTurn(
    {
      body,
      item,
      question: `Read every paper in ${input.collection.name} and summarize each`,
      selectedCollectionContexts: [input.collection],
      advanced: {
        temperature: 0,
        outputTokenLimit: { mode: "auto" },
        inputTokenCap: input.inputTokenCap,
      },
    },
    deps,
  );
  observe();
  const message = deps.chatHistory.get(key)?.at(-1);
  const trace = await getAgentRunTrace(message?.agentRunId || "");
  return {
    rowCounts,
    stepLabels,
    runStatus: trace.run?.status,
    finalText: trace.run?.finalText,
    pages: trace.events.flatMap((event) =>
      event.payload.type === "provider_event" &&
      event.payload.providerType === "agent_long_job_page"
        ? [event.payload.payload || {}]
        : [],
    ),
  };
}

/**
 * What a Zotero restart leaves of the agent: nothing in memory. The stores
 * forget every transcript, handle and evidence entry they held, startup
 * recovery runs again (a run left running becomes interrupted), and the
 * panel loads the conversation from disk, as when Zotero starts.
 */
async function reloadAgentStateAsAtStartup(panel: {
  body: HTMLElement;
  item: Zotero.Item;
}): Promise<void> {
  clearAgentTranscriptStore();
  clearAgentToolResultHandleStore();
  clearAgentEvidenceCache();
  clearAgentCoverageLedger();
  await initAgentTraceStore();
  await reopenTaskProgressConversation(panel);
}

/**
 * One turn of a scripted note job through the panel's send flow, with a
 * fresh runtime: the real task_update and the named real write tool, and
 * the paper_read stub. `step` scripts each model request; its `stop` presses
 * the panel's Stop button while that request is in flight, and the request
 * then ends as an aborted request does, on the signal the button aborted.
 */
export async function scriptedJobTurn(
  panel: { body: HTMLElement; item: Zotero.Item },
  input: {
    collection: CollectionContextRef;
    scope: TaskPaperScopeSet;
    inputTokenCap: number;
    writeTool: "note_write" | "note_write_batch";
    /** Characters of text a paper read returns, before the page share. */
    paperCharacters?: number;
    question: string;
    step: (
      messages: AgentModelMessage[],
      stop: () => Promise<AgentModelStep>,
    ) => AgentModelStep | Promise<AgentModelStep>;
    /** Safety limits for a job stopped by one (turnBoundary.ts, Rule 3). */
    turnLimits?: Partial<TurnSafetyLimits>;
  },
) {
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
  registry.register(deps.getAgentRuntime().getToolDefinition(input.writeTool)!);
  registry.register(stubPaperReadTool(item.libraryID, input.paperCharacters));
  const stopDuring = (signal: AbortSignal | undefined) =>
    new Promise<AgentModelStep>((_resolve, reject) => {
      const aborted = () => {
        const error = new Error("The user stopped the request.");
        error.name = "AbortError";
        reject(error);
      };
      if (!signal) {
        reject(new Error("The model request carries no Stop signal."));
        return;
      }
      signal.addEventListener("abort", aborted, { once: true });
      const button = body.querySelector(
        "#llm-cancel",
      ) as HTMLButtonElement | null;
      if (!button) {
        reject(new Error("The panel shows no Stop button."));
        return;
      }
      button.click();
    });
  let firstPrompt = "";
  const runtime = new AgentRuntime({
    registry,
    ...(input.turnLimits ? { turnLimits: input.turnLimits } : {}),
    resolveTurnScopePapers: async () => input.scope,
    adapterFactory: () => ({
      supportsTools: () => true,
      getCapabilities: () => ({
        streaming: false,
        toolCalls: true,
        multimodal: false,
        fileInputs: false,
        reasoning: false,
      }),
      runStep: async ({ messages, signal }): Promise<AgentModelStep> => {
        if (!firstPrompt) firstPrompt = messages.map(contentText).join("\n");
        return input.step(messages, () => stopDuring(signal));
      },
    }),
  });
  deps.getAgentRuntime = () => runtime;
  await sendAgentTurn(
    {
      body,
      item,
      question: input.question,
      selectedCollectionContexts: [input.collection],
      advanced: {
        temperature: 0,
        outputTokenLimit: { mode: "auto" },
        inputTokenCap: input.inputTokenCap,
      },
    },
    deps,
  );
  const runId = deps.chatHistory.get(key)?.at(-1)?.agentRunId || "";
  const trace = await getAgentRunTrace(runId);
  return {
    runStatus: trace.run?.status,
    end: latestExecutionCheckpoint(trace.events)?.end?.state,
    ledger: latestExecutionCheckpoint(trace.events),
    stopRule: trace.events
      .map((event) => event.payload)
      .flatMap((event) =>
        event.type === "provider_event" &&
        event.providerType === "agent_run_stop"
          ? [String((event.payload as { rule?: unknown })?.rule)]
          : [],
      )[0],
    firstPrompt,
    events: trace.events.map((event) => event.payload),
  };
}

/**
 * The resume gate (stage 6.4): a note job over a folder's papers, one note a
 * paper, stopped midway with the panel's Stop button while a model request
 * is in flight; the agent's state reloaded as a Zotero restart reloads it;
 * then "continue" finishes the job. Only the model is scripted. The runtime,
 * task_update, note_write (real notes, verified receipts), the Stop button
 * and the panel's send flow are the real ones; paper_read is the stub above.
 * The resumed model first writes a note on a paper the job has already
 * noted, as a model that starts its page over would. The model reads a
 * page in one step, then writes one note_write a paper in the next; it
 * reports each step's note calls and every step the host refused as too
 * many calls, so a page larger than the ordinary limit is seen through.
 */
export async function exerciseLongJobNoteResume(
  panel: { body: HTMLElement; item: Zotero.Item },
  input: {
    collection: CollectionContextRef;
    papers: Array<{ itemId: number; title: string }>;
    inputTokenCap: number;
    /** The user stops the job once this many notes are written. */
    stopAfterNotes: number;
  },
) {
  const { body, item } = panel;
  body.style.left = "0";
  body.style.width = "420px";
  body.style.zIndex = "99999";
  const NOTE_ALL = "Save a note on each paper";
  const scope = {
    wholeLibrary: false,
    itemIds: input.papers.map((paper) => paper.itemId),
    withText: input.papers.length,
    papers: Object.fromEntries(
      input.papers.map((paper) => [
        paper.itemId,
        { title: paper.title, text: "pdf" as const },
      ]),
    ),
  };
  const toolStep = (calls: AgentToolCall[]): AgentModelStep => ({
    kind: "tool_calls",
    calls,
    assistantMessage: { role: "assistant", content: "", tool_calls: calls },
  });
  const final = (text: string): AgentModelStep => ({
    kind: "final",
    text,
    assistantMessage: { role: "assistant", content: text },
  });
  let calls = 0;
  const readCall = (itemId: number): AgentToolCall => ({
    id: `read-${itemId}-${(calls += 1)}`,
    name: "paper_read",
    arguments: {
      target: { itemId, contextItemId: itemId, libraryID: item.libraryID },
    },
  });
  const noteCall = (itemId: number, body = "the finding"): AgentToolCall => ({
    id: `note-${itemId}-${(calls += 1)}`,
    name: "note_write",
    arguments: {
      mode: "create",
      target: "item",
      targetItemId: itemId,
      content: `# Paper ${itemId}\n\nNote on ${body} of paper ${itemId}.`,
    },
  });
  /** The latest page the host named, if any. */
  const latestHost = (messages: AgentModelMessage[]) =>
    [...messages]
      .reverse()
      .map(contentText)
      .find((text) => text.startsWith("Long job"));
  const pageOf = (host: string) =>
    [...host.matchAll(/^- itemId=(\d+)/gm)].map((match) => Number(match[1]));
  // The script counts a paper read or noted only once the runtime confirms
  // it: a read by its tool result, a note by the note Zotero holds. A call
  // the runtime refused or never ran is asked again, a few times at most.
  const itemOf = (call: AgentToolCall) =>
    Number(
      (call.arguments as { targetItemId?: number }).targetItemId ??
        (call.arguments as { target?: { itemId?: number } }).target?.itemId,
    );
  let awaiting: AgentToolCall[] = [];
  const attempts = new Map<string, number>();
  /** How many note calls each of the turn's steps sent. */
  let noteSteps: number[] = [];
  const request = (calls: AgentToolCall[]): AgentModelStep => {
    const notes = calls.filter((call) => call.name === "note_write").length;
    if (notes) noteSteps.push(notes);
    for (const call of calls) {
      const key = `${call.name}:${itemOf(call)}`;
      const count = (attempts.get(key) || 0) + 1;
      if (count > 3)
        throw new Error(`${key} was asked ${count} times, never confirmed.`);
      attempts.set(key, count);
    }
    awaiting = calls;
    return toolStep(calls);
  };
  const confirm = async (
    messages: AgentModelMessage[],
    read: Set<number>,
    noted: Set<number>,
  ) => {
    const succeeded = new Set<string>();
    for (const message of messages) {
      if (message.role !== "tool") continue;
      let content: { error?: unknown } | null = null;
      try {
        content = JSON.parse(contentText(message));
      } catch {
        // A result that is not JSON is no error object.
      }
      if (!content?.error) succeeded.add(message.tool_call_id);
    }
    for (const call of awaiting) {
      const itemId = itemOf(call);
      if (call.name === "paper_read") {
        if (succeeded.has(call.id)) read.add(itemId);
        continue;
      }
      const parent = Zotero.Items.get(itemId);
      await parent.reload(["childItems"], true);
      if (parent.getNotes().length) noted.add(itemId);
    }
    awaiting = [];
  };
  /** Read the page's papers, then save a note on each of them. */
  const workPage = (
    papers: number[],
    read: Set<number>,
    noted: Set<number>,
  ): AgentModelStep | null => {
    const toRead = papers.filter((itemId) => !read.has(itemId));
    if (toRead.length) return request(toRead.map(readCall));
    const toNote = papers.filter((itemId) => !noted.has(itemId));
    if (!toNote.length) return null;
    return request(toNote.map((itemId) => noteCall(itemId)));
  };

  /** One turn through the panel's send flow, with a fresh runtime. */
  const turn = (
    question: string,
    step: (
      messages: AgentModelMessage[],
      stop: () => Promise<AgentModelStep>,
    ) => AgentModelStep | Promise<AgentModelStep>,
  ) =>
    scriptedJobTurn(panel, {
      collection: input.collection,
      scope,
      inputTokenCap: input.inputTokenCap,
      writeTool: "note_write",
      question,
      step,
    });

  const previousMode = getOriginalAgentPermissionMode();
  setOriginalAgentPermissionMode("auto");
  try {
    // Turn 1: declare the parts, then work page by page until the user
    // stops the job, with papers read whose notes are not written yet.
    const read = new Set<number>();
    const noted = new Set<number>();
    let declared = false;
    const first = await turn(
      `Read each paper in ${input.collection.name} and save a note on each`,
      async (messages, stop) => {
        await confirm(messages, read, noted);
        if (!declared) {
          declared = true;
          return toolStep([
            {
              id: "declare-1",
              name: "task_update",
              arguments: {
                tasks: [
                  {
                    taskId: "read-all",
                    description: `Read each paper in ${input.collection.name}`,
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
        if (noted.size >= input.stopAfterNotes && read.size > noted.size)
          return stop();
        const host = latestHost(messages);
        const next =
          host && !host.startsWith("Long job complete")
            ? workPage(pageOf(host), read, noted)
            : null;
        return next || final("Every paper has its note.");
      },
    );

    await reloadAgentStateAsAtStartup(panel);

    // Turn 2: "continue". The model first writes a note again on the last
    // paper it noted before the stop, beside reading the first papers the
    // resume note lists; then it works page by page to the end.
    const again = [...noted].pop()!;
    const resumedRead = new Set<number>();
    const resumedNoted = new Set<number>();
    let resumed = false;
    attempts.clear();
    const firstNoteSteps = noteSteps;
    noteSteps = [];
    const second = await turn("continue", async (messages) => {
      await confirm(messages, resumedRead, resumedNoted);
      const host = latestHost(messages);
      if (!resumed) {
        resumed = true;
        const left =
          /papers? left, in order: ([\d, ]+)\./
            .exec(messages.map(contentText).join("\n"))?.[1]
            ?.split(", ")
            .map(Number) ?? [];
        const firstPapers = left.slice(0, 2);
        return request([
          noteCall(again, "the finding, once more"),
          ...firstPapers.map(readCall),
        ]);
      }
      if (host?.startsWith("Long job complete"))
        return final("Every paper has its note.");
      const papers = host
        ? pageOf(host)
        : [...resumedRead].filter((itemId) => !resumedNoted.has(itemId));
      return (
        workPage(papers, resumedRead, resumedNoted) ||
        final("Every paper has its note.")
      );
    });

    // What the library holds now, and what the receipts proved.
    const notesPerPaper: Record<number, number> = {};
    for (const paper of input.papers) {
      const parent = Zotero.Items.get(paper.itemId);
      await parent.reload(["childItems"], true);
      notesPerPaper[paper.itemId] = parent.getNotes().length;
    }
    const receiptsPerPaper: Record<number, number> = {};
    const skipped: number[] = [];
    for (const event of [...first.events, ...second.events]) {
      if (event.type !== "tool_result" || event.name !== "note_write") continue;
      for (const receipt of event.actionReceipts || []) {
        if (
          receipt.operation !== "note_create" ||
          receipt.verification !== "verified" ||
          receipt.status !== "applied"
        )
          continue;
        for (const target of receipt.appliedTargets) {
          const itemId = Number(target.replace(/^item:/, ""));
          receiptsPerPaper[itemId] = (receiptsPerPaper[itemId] || 0) + 1;
        }
      }
      const content = event.content as { skipped?: unknown; note?: unknown };
      if (content?.skipped === true) {
        const match = /items? (\d+)/.exec(String(content.note || ""));
        if (match) skipped.push(Number(match[1]));
      }
    }
    // The pages the host planned, and the steps it refused as too many calls.
    const paging = (events: typeof first.events) => {
      const payloads = (type: string) =>
        events.flatMap((event) =>
          event.type === "provider_event" && event.providerType === type
            ? [event.payload as { papers?: unknown; complete?: unknown }]
            : [],
        );
      return {
        pages: payloads("agent_long_job_page").flatMap((page) =>
          typeof page.papers === "number" && !page.complete
            ? [page.papers]
            : [],
        ),
        overflows: payloads("agent_tool_call_overflow").length,
      };
    };
    return {
      first: {
        runStatus: first.runStatus,
        end: first.end,
        read: read.size,
        noted: [...noted],
        noteSteps: firstNoteSteps,
        ...paging(first.events),
      },
      second: {
        runStatus: second.runStatus,
        end: second.end,
        resumeNote:
          /Long job to resume:[^\n]*/.exec(second.firstPrompt)?.[0] || "",
        again,
        skipped,
        noteSteps,
        ...paging(second.events),
      },
      notesPerPaper,
      receiptsPerPaper,
    };
  } finally {
    setOriginalAgentPermissionMode(previousMode);
  }
}

/**
 * The Stop gate of a batch write: a note job over a folder's papers whose
 * model reads every paper first and then writes all the notes in one
 * note_write_batch, as models do; the user presses the panel's Stop button
 * while that batch is writing, once `stopAfterNotes` notes exist. The batch
 * stops between two notes, and what it wrote reaches the ledger before the
 * run ends. After the agent's state is reloaded as at startup, "continue":
 * the resumed model first sends the whole batch again, as a model that
 * starts over would, and is refused for the papers already written; then it
 * continues the stopped batch by its id. Only the model is scripted; the
 * batch, its notes and their receipts are the real ones.
 */
export async function exerciseLongJobBatchStop(
  panel: { body: HTMLElement; item: Zotero.Item },
  input: {
    collection: CollectionContextRef;
    papers: Array<{ itemId: number; title: string }>;
    inputTokenCap: number;
    /** The user presses Stop once the batch has written this many notes. */
    stopAfterNotes: number;
  },
) {
  const { body, item } = panel;
  body.style.left = "0";
  body.style.width = "420px";
  body.style.zIndex = "99999";
  const NOTE_ALL = "Write a short reading note on each paper";
  const ids = input.papers.map((paper) => paper.itemId);
  const scope: TaskPaperScopeSet = {
    wholeLibrary: false,
    itemIds: ids,
    withText: ids.length,
    papers: Object.fromEntries(
      input.papers.map((paper) => [
        paper.itemId,
        { title: paper.title, text: "pdf" as const },
      ]),
    ),
  };
  const toolStep = (calls: AgentToolCall[]): AgentModelStep => ({
    kind: "tool_calls",
    calls,
    assistantMessage: { role: "assistant", content: "", tool_calls: calls },
  });
  const final = (text: string): AgentModelStep => ({
    kind: "final",
    text,
    assistantMessage: { role: "assistant", content: text },
  });
  let calls = 0;
  const readCall = (itemId: number): AgentToolCall => ({
    id: `read-${itemId}-${(calls += 1)}`,
    name: "paper_read",
    arguments: {
      target: { itemId, contextItemId: itemId, libraryID: item.libraryID },
    },
  });
  const batchCall = (papers: number[]): AgentToolCall => ({
    id: `batch-${(calls += 1)}`,
    name: "note_write_batch",
    arguments: {
      target: "item",
      notes: papers.map((itemId) => ({
        targetItemId: itemId,
        content: `# Paper ${itemId}\n\nReading note on the finding of paper ${itemId}.`,
      })),
    },
  });
  const notesPerPaper = async (): Promise<Record<number, number>> => {
    const counts: Record<number, number> = {};
    for (const itemId of ids) {
      const parent = Zotero.Items.get(itemId);
      await parent.reload(["childItems"], true);
      counts[itemId] = parent.getNotes().length;
    }
    return counts;
  };
  const withNote = (counts: Record<number, number>) =>
    ids.filter((itemId) => (counts[itemId] || 0) > 0);
  const turn = (
    question: string,
    step: (messages: AgentModelMessage[]) => AgentModelStep,
  ) =>
    scriptedJobTurn(panel, {
      collection: input.collection,
      scope,
      inputTokenCap: input.inputTokenCap,
      writeTool: "note_write_batch",
      // Short texts, so the whole folder is read in one pass and the model
      // can write every note at once, as in the live run this gate repeats.
      paperCharacters: 1_200,
      question,
      step,
    });

  const previousMode = getOriginalAgentPermissionMode();
  setOriginalAgentPermissionMode("auto");
  // The user presses Stop the moment the batch's `stopAfterNotes`th note
  // lands, read from Zotero's own notifications of the notes it adds.
  const paperIds = new Set(ids);
  let notesSeen = 0;
  let notesAtStop: number | undefined;
  const observer = Zotero.Notifier.registerObserver(
    {
      notify(event: string, type: string, addedIds: Array<number | string>) {
        if (event !== "add" || type !== "item" || notesAtStop !== undefined)
          return;
        for (const id of addedIds) {
          const added = Zotero.Items.get(Number(id));
          if (added?.isNote() && paperIds.has(Number(added.parentID)))
            notesSeen += 1;
        }
        if (notesSeen < input.stopAfterNotes) return;
        notesAtStop = notesSeen;
        (
          body.querySelector("#llm-cancel") as HTMLButtonElement | null
        )?.click();
      },
    },
    ["item"],
    "llm-long-job-batch-stop",
  );
  try {
    // Turn 1: declare the parts, read every paper ten at a time, then write
    // all the notes in one batch; the user stops it while it writes.
    let declared = false;
    let readUpTo = 0;
    let batched = false;
    const first = await turn(
      `Write a short reading note for each paper in ${input.collection.name}`,
      () => {
        if (!declared) {
          declared = true;
          return toolStep([
            {
              id: "declare-1",
              name: "task_update",
              arguments: {
                tasks: [
                  {
                    taskId: "read-all",
                    description: `Read each paper in ${input.collection.name}`,
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
        if (readUpTo < ids.length) {
          const papers = ids.slice(readUpTo, readUpTo + 10);
          readUpTo += papers.length;
          return toolStep(papers.map(readCall));
        }
        if (!batched) {
          batched = true;
          return toolStep([batchCall(ids)]);
        }
        return final("Every paper has its note.");
      },
    );
    Zotero.Notifier.unregisterObserver(observer);
    const afterFirst = await notesPerPaper();
    const noted = withNote(afterFirst);
    const firstBatch = first.events.find(
      (event) =>
        event.type === "tool_result" && event.name === "note_write_batch",
    );
    const firstNotePart = first.ledger?.tasks.find((task) =>
      task.taskId.endsWith(":task:note-all"),
    );

    await reloadAgentStateAsAtStartup(panel);

    // Turn 2: "continue". The model first sends every note again, then
    // continues the stopped batch by the id the host names.
    let restarted = false;
    let resumed = false;
    const second = await turn("continue", (messages) => {
      if (!restarted) {
        restarted = true;
        return toolStep([batchCall(ids)]);
      }
      if (!resumed) {
        resumed = true;
        const batchId = /resumeBatchId=([^;\s]+)/.exec(
          messages.map(contentText).join("\n"),
        )?.[1];
        if (batchId)
          return toolStep([
            {
              id: `batch-${(calls += 1)}`,
              name: "note_write_batch",
              arguments: { resumeBatchId: batchId },
            },
          ]);
      }
      return final("Every paper has its note.");
    });
    const results = second.events.filter(
      (event) =>
        event.type === "tool_result" && event.name === "note_write_batch",
    );
    const [refused, resumedBatch] = results;

    // Every paper's receipts across both turns, as the batch receipts name
    // the papers they wrote.
    const receiptsPerPaper: Record<number, number> = {};
    const appliedBy = (receipts: readonly AgentActionReceipt[] | undefined) =>
      (receipts || []).flatMap((receipt) =>
        receipt.verification === "verified" &&
        (receipt.status === "applied" || receipt.status === "partial")
          ? receipt.appliedTargets.map((target) =>
              Number(target.replace(/^item:/, "")),
            )
          : [],
      );
    for (const event of [...first.events, ...second.events]) {
      if (event.type !== "tool_result" || event.name !== "note_write_batch")
        continue;
      for (const itemId of appliedBy(event.actionReceipts))
        receiptsPerPaper[itemId] = (receiptsPerPaper[itemId] || 0) + 1;
    }
    return {
      first: {
        runStatus: first.runStatus,
        end: first.end,
        notesAtStop,
        noted,
        receiptStatus:
          firstBatch?.type === "tool_result"
            ? firstBatch.actionReceipts?.[0]?.status
            : undefined,
        receiptApplied:
          firstBatch?.type === "tool_result"
            ? appliedBy(firstBatch.actionReceipts)
            : [],
        ledgerDone: (firstNotePart?.doneTargets || []).map((target) =>
          Number(target.replace(/^item:/, "")),
        ),
        ledgerStatus: firstNotePart?.status,
      },
      second: {
        runStatus: second.runStatus,
        end: second.end,
        resumeNote:
          /Long job to resume:[^\n]*/.exec(second.firstPrompt)?.[0] || "",
        refused:
          refused?.type === "tool_result"
            ? {
                ok: refused.ok,
                error: String(
                  (refused.content as { error?: unknown })?.error || "",
                ),
              }
            : undefined,
        resumedApplied:
          resumedBatch?.type === "tool_result"
            ? appliedBy(resumedBatch.actionReceipts)
            : [],
      },
      notesPerPaper: await notesPerPaper(),
      receiptsPerPaper,
    };
  } finally {
    Zotero.Notifier.unregisterObserver(observer);
    setOriginalAgentPermissionMode(previousMode);
  }
}
