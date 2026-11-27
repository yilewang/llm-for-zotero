/**
 * Workflow-test fixture: Antigravity turns through the real panel, agent
 * engine, turn host, Antigravity transport, and ACP client, with only agy
 * replaced. The test supplies the agy side (a scripted fake agent behind
 * the stdio child surface), so no process starts.
 *
 * The panel's paper gets a real Antigravity conversation, so session ids are
 * saved where a user's would be. Clients stay alive between turns of one
 * test until `resetAntigravityReplay` stops them, which lets a test resume a
 * session in the same agy process or, with a new child, in a fresh one.
 */

import { config } from "../../../package.json";
import { retryAgentTurn, sendAgentTurn } from "./agentMode/agentEngine";
import { buildAgentEngineDepsForTests } from "./chat";
import { bindProvisionedConversationKey } from "./conversationIdentity";
import { getAbortController, setAbortController } from "./state";
import { getCoreAgentRuntime } from "../../agent";
import { getAgentRunTrace } from "../../agent/store/traceStore";
import type { AgentEvent, AgentRuntimeOutcome } from "../../agent/types";
import { AcpClient } from "../../antigravity/acpClient";
import {
  createAntigravityRuntime,
  createAntigravityTransport,
} from "../../antigravity/runtime";
import {
  getAntigravityPermissionModePref,
  setAntigravityPermissionModePref,
  type AntigravityPermissionMode,
} from "../../antigravity/prefs";
import { antigravityConversationStore } from "../../antigravity/store";
import {
  isNativeZoteroMcpToolsEnabled,
  setNativeZoteroMcpToolsEnabled,
} from "../../codexAppServer/prefs";
import {
  bumpConversationWriteGeneration,
  getConversationWriteGeneration,
} from "../../shared/conversationWriteFence";
import { createAbortController } from "../../utils/apiHelpers";
import type { StdioJsonRpcChild } from "../../utils/stdioJsonRpcConnection";
import {
  buildAgyPoolKey,
  startAgyClient,
  type AgyLaunchOptions,
} from "../../antigravity/agyProcess";
import type { ChatAttachment, SelectedTextContext } from "../../shared/types";
import {
  encodeReaderSelection,
  READER_RUNTIME_KEYS,
  type ReaderRuntimeKey,
  type ReaderSelection,
} from "../../shared/readerSelection";
import {
  getReaderChoicePref,
  setReaderChoicePref,
} from "../../utils/readerChoicePrefs";
import { listAntigravitySlashCommands } from "../../antigravity/commands";

export type AntigravityTurnScenario = {
  question: string;
  /**
   * Starts a fake agy; called when the turn needs a new process. Without it
   * the turn runs the installed agy (the live tests).
   */
  createChild?: (launch: AgyLaunchOptions) => StdioJsonRpcChild;
  /** Starts a new agy process even if this test already has one. */
  newProcess?: boolean;
  /** Continues this conversation; a new one is created otherwise. */
  conversationKey?: number;
  mcp?: boolean;
  /** Answers every review card; unset leaves them open. */
  approve?: boolean;
  permissionMode?: AntigravityPermissionMode;
  /** The surface's picks, as the panel sends them with the turn. */
  model?: string;
  thoughtLevel?: string;
  /** Stops the turn once the answer contains this text. */
  abortWhenText?: string;
  /** Clears the conversation once the answer contains this text. */
  clearWhenText?: string;
  /** Screenshots sent with the turn (data URLs). */
  images?: string[];
  /** Files sent with the turn. */
  attachments?: ChatAttachment[];
  /** Passages the user selected or quoted for the turn. */
  selectedTextContexts?: SelectedTextContext[];
  /** The reader model picked in the composer for each runtime. */
  readerSelections?: Partial<Record<ReaderRuntimeKey, ReaderSelection>>;
  /** Retries the turn after it ends, as the panel's Retry does. */
  retry?: boolean;
};

export type AntigravityTurnResult = {
  conversationKey: number;
  outcomeKind: AgentRuntimeOutcome["kind"] | "threw";
  outcomeText: string;
  deliveredEvents: string[];
  deliveredText: string;
  storedEvents: string[];
  runStatus?: string;
  messageText?: string;
  /** The run the turn started (or recorded its failure under). */
  runId: string;
  /** The chat's messages as the Antigravity store saved them. */
  storedMessages: Array<{ role: string; text: string; agentRunId?: string }>;
  /** With `retry`: the chat's agy session before the retry. */
  sessionIdBeforeRetry?: string;
  /** Review cards the turn showed. */
  confirmations: number;
  /** The agy session saved on the conversation after the turn. */
  storedSessionId?: string;
  storedCwd?: string;
  /** The launch options the runtime asked for. */
  launches: AgyLaunchOptions[];
  /** How many agy processes the test has started so far. */
  processes: number;
  /** The slash commands agy has announced, as the menu would list them. */
  slashCommands: string[];
  /** The reader model the turn's request carried. */
  readerSelection?: ReaderSelection;
};

let replayClient: AcpClient | null = null;
let replayPoolKey = "";
let processCount = 0;

/** Stops the test's agy clients. */
export async function resetAntigravityReplay(): Promise<void> {
  const client = replayClient;
  replayClient = null;
  replayPoolKey = "";
  processCount = 0;
  await client?.destroyAndWait().catch(() => undefined);
}

function setPref(name: string, value: unknown): void {
  const key = `${config.prefsPrefix}.${name}`;
  if (value === undefined) Zotero.Prefs.clear(key, true);
  else Zotero.Prefs.set(key, value as boolean, true);
}

export async function exerciseAntigravityTurn(
  panel: { body: HTMLElement; item: Zotero.Item },
  scenario: AntigravityTurnScenario,
): Promise<AntigravityTurnResult> {
  const { body, item } = panel;
  let conversationKey = scenario.conversationKey || 0;
  if (!conversationKey) {
    const created = await antigravityConversationStore.createPaperConversation(
      item.libraryID,
      item.id,
    );
    if (!created) throw new Error("Could not create an Antigravity chat");
    conversationKey = created.conversationKey;
  }
  bindProvisionedConversationKey(item, conversationKey);

  const launches: AgyLaunchOptions[] = [];
  const transport = createAntigravityTransport({
    startClient: async (launch) => {
      launches.push(launch);
      // Like the process pool: one agy per launch, which names the chat's
      // config, so another chat (or permission level) gets another agy.
      const poolKey = buildAgyPoolKey(launch);
      if (
        replayClient &&
        !replayClient.isClosed() &&
        !scenario.newProcess &&
        replayPoolKey === poolKey
      ) {
        return replayClient;
      }
      replayPoolKey = poolKey;
      await replayClient?.destroyAndWait().catch(() => undefined);
      processCount += 1;
      replayClient = scenario.createChild
        ? await AcpClient.connect({
            child: scenario.createChild(launch),
            readiness: { timeoutMs: 2_000, delayMs: 10 },
          })
        : await startAgyClient(launch);
      return replayClient;
    },
  });
  const coreRuntime = getCoreAgentRuntime();
  const runtime = createAntigravityRuntime(coreRuntime, transport);
  const deps = buildAgentEngineDepsForTests(
    item,
    "antigravity",
    getConversationWriteGeneration(conversationKey),
  );
  const deliveredEvents: string[] = [];
  let deliveredText = "";
  let confirmations = 0;
  let outcome: AgentRuntimeOutcome | null = null;
  let threw = "";
  let triggered = false;
  let startedRunId = "";
  let readerSelection: ReaderSelection | undefined;
  deps.getAgentRuntime = () =>
    ({
      ...runtime,
      runTurn: async (params: Parameters<typeof runtime.runTurn>[0]) => {
        readerSelection = params.request.readerSelection;
        try {
          outcome = await runtime.runTurn({
            ...params,
            onStart: async (runId: string) => {
              startedRunId = runId;
              await params.onStart?.(runId);
            },
            onEvent: async (event: AgentEvent) => {
              deliveredEvents.push(event.type);
              if (event.type === "message_delta") deliveredText += event.text;
              if (event.type === "confirmation_required") {
                confirmations += 1;
                if (scenario.approve !== undefined) {
                  const approved = scenario.approve;
                  setTimeout(
                    () =>
                      coreRuntime.resolveConfirmation(
                        event.requestId,
                        approved,
                      ),
                    10,
                  );
                }
              }
              await params.onEvent?.(event);
              if (!triggered && event.type === "message_delta") {
                if (
                  scenario.abortWhenText &&
                  deliveredText.includes(scenario.abortWhenText)
                ) {
                  triggered = true;
                  deps.currentAbortController(conversationKey)?.abort();
                }
                if (
                  scenario.clearWhenText &&
                  deliveredText.includes(scenario.clearWhenText)
                ) {
                  triggered = true;
                  bumpConversationWriteGeneration(conversationKey);
                }
              }
            },
          });
          return outcome;
        } catch (error) {
          threw = error instanceof Error ? error.message : String(error);
          throw error;
        }
      },
    }) as never;

  const before = {
    enable: Zotero.Prefs.get(
      `${config.prefsPrefix}.enableAntigravityMode`,
      true,
    ),
    mode: getAntigravityPermissionModePref(),
    mcp: isNativeZoteroMcpToolsEnabled(),
    readers: READER_RUNTIME_KEYS.map(
      (key) => [key, getReaderChoicePref(key)] as const,
    ),
  };
  for (const [key, selection] of Object.entries(
    scenario.readerSelections || {},
  )) {
    setReaderChoicePref(
      key as ReaderRuntimeKey,
      encodeReaderSelection(selection),
    );
  }
  setPref("enableAntigravityMode", true);
  setAntigravityPermissionModePref(scenario.permissionMode ?? "default");
  setNativeZoteroMcpToolsEnabled(Boolean(scenario.mcp));
  const previousController = getAbortController(conversationKey);
  setAbortController(conversationKey, createAbortController());
  try {
    await sendAgentTurn(
      {
        body,
        item,
        question: scenario.question,
        ...(scenario.images ? { images: scenario.images } : {}),
        ...(scenario.attachments ? { attachments: scenario.attachments } : {}),
        ...(scenario.selectedTextContexts
          ? { selectedTextContexts: scenario.selectedTextContexts }
          : {}),
        ...(scenario.model ? { model: scenario.model } : {}),
        ...(scenario.thoughtLevel
          ? {
              reasoning: {
                provider: "customized" as const,
                level: scenario.thoughtLevel,
              },
            }
          : {}),
      },
      deps,
    ).catch((error) => {
      threw ||= error instanceof Error ? error.message : String(error);
    });
    const sessionIdBeforeRetry = scenario.retry
      ? (await antigravityConversationStore.getSummary(conversationKey))
          ?.providerSessionId
      : undefined;
    if (scenario.retry) {
      setAbortController(conversationKey, createAbortController());
      await retryAgentTurn(
        body,
        item,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        deps,
      ).catch((error) => {
        threw ||= error instanceof Error ? error.message : String(error);
      });
    }
    const message = deps.chatHistory.get(conversationKey)?.at(-1);
    const runId = startedRunId;
    const trace = runId ? await getAgentRunTrace(runId) : null;
    const summary =
      await antigravityConversationStore.getSummary(conversationKey);
    const finished = outcome as AgentRuntimeOutcome | null;
    return {
      conversationKey,
      outcomeKind: finished ? finished.kind : "threw",
      outcomeText: finished
        ? finished.kind === "completed"
          ? finished.text
          : "reason" in finished
            ? String(finished.reason)
            : "message" in finished
              ? String(finished.message)
              : ""
        : threw,
      deliveredEvents,
      deliveredText,
      storedEvents: (trace?.events || []).map((event) =>
        String((event.payload as { type?: unknown }).type),
      ),
      runStatus: trace?.run?.status,
      messageText: message?.text,
      runId,
      storedMessages: (
        await antigravityConversationStore.loadConversation(conversationKey, 20)
      ).map((stored) => ({
        role: stored.role,
        text: stored.text,
        agentRunId: stored.agentRunId,
      })),
      confirmations,
      storedSessionId: summary?.providerSessionId,
      ...(scenario.retry ? { sessionIdBeforeRetry } : {}),
      storedCwd: summary?.cwd,
      launches,
      processes: processCount,
      slashCommands: listAntigravitySlashCommands().map(
        (command) => command.name,
      ),
      ...(readerSelection ? { readerSelection } : {}),
    };
  } finally {
    setAbortController(conversationKey, previousController);
    setPref("enableAntigravityMode", before.enable);
    setAntigravityPermissionModePref(before.mode);
    setNativeZoteroMcpToolsEnabled(before.mcp);
    for (const [key, value] of before.readers) setReaderChoicePref(key, value);
  }
}
