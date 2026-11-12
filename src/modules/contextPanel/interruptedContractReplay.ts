/**
 * Native fixture for a run left running by a restart: it stored a legacy
 * agent_action_contract checkpoint, a record the product no longer writes or
 * reads for recovery. Only the model is scripted. The panel's send flow, the
 * runtime's interrupted-run recovery and the real library_update tool are
 * the real ones.
 */
import { sendAgentTurn } from "./agentMode/agentEngine";
import { buildAgentEngineDepsForTests, getConversationKey } from "./chat";
import { getConversationWriteGeneration } from "../../shared/conversationWriteFence";
import {
  appendAgentRunEvent,
  createAgentRun,
  getAgentRunTrace,
  initAgentTraceStore,
} from "../../agent/store/traceStore";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../../agent/originalAgentPermissionMode";
import { AgentRuntime } from "../../agent/runtime";
import { AgentToolRegistry } from "../../agent/tools/registry";
import { ActionContractService } from "../../agent/contracts/actionContract";
import { ZoteroGateway } from "../../agent/services/zoteroGateway";
import type { AgentModelStep, AgentToolCall } from "../../agent/types";

export async function exerciseInterruptedLegacyContract(
  panel: { body: HTMLElement; item: Zotero.Item },
  input: { legacyRunId: string; legacyContractId: string; tag: string },
) {
  const { body, item } = panel;
  const key = getConversationKey(item);
  const legacyContract = {
    version: 4,
    id: input.legacyContractId,
    writeDisposition: "required",
    interpretationSource: "classifier",
    hardConstraints: [],
    obligations: [
      {
        id: "legacy-obligation",
        operation: "command_execute",
        proofDomain: "execution",
        capability: "command.execute",
        coverage: "one",
        targetKind: "command",
      },
    ],
  };
  const legacyProgress = {
    version: 1,
    contractId: input.legacyContractId,
    state: "pending",
    correctionCount: 0,
    obligations: [
      {
        obligationId: "legacy-obligation",
        status: "open",
        verifiedTargetIds: [],
        unresolvedTargetIds: [],
        journalStepIds: [],
        failureReasons: [],
      },
    ],
    appliedReceiptKeys: [],
    authorizationGrants: [],
    updatedAt: 1,
  };
  await createAgentRun({
    runId: input.legacyRunId,
    conversationKey: key,
    mode: "agent",
    status: "running",
    createdAt: Date.now() - 60_000,
  });
  await appendAgentRunEvent(input.legacyRunId, 1, {
    type: "provider_event",
    providerType: "agent_action_contract",
    payload: { contract: legacyContract, progress: legacyProgress },
  } as never);
  // A restart marks the run that was still running as interrupted.
  await initAgentTraceStore();
  const legacyTrace = await getAgentRunTrace(input.legacyRunId);

  const deps = buildAgentEngineDepsForTests(
    item,
    "upstream",
    getConversationWriteGeneration(key),
  );
  const registry = new AgentToolRegistry(
    new ActionContractService(new ZoteroGateway()),
  );
  registry.register(
    deps.getAgentRuntime().getToolDefinition("library_update")!,
  );
  const prompts: string[] = [];
  let step = 0;
  const runtime = new AgentRuntime({
    registry,
    adapterFactory: () => ({
      supportsTools: () => true,
      getCapabilities: () => ({
        streaming: false,
        toolCalls: true,
        multimodal: false,
        fileInputs: false,
        reasoning: false,
      }),
      runStep: async ({ messages }): Promise<AgentModelStep> => {
        prompts.push(JSON.stringify(messages));
        step += 1;
        if (step === 1) {
          const call: AgentToolCall = {
            id: "legacy-write-call",
            name: "library_update",
            arguments: {
              kind: "tags",
              action: "add",
              itemIds: [item.id],
              tags: [input.tag],
            },
          };
          return {
            kind: "tool_calls",
            calls: [call],
            assistantMessage: {
              role: "assistant",
              content: "",
              tool_calls: [call],
            },
          };
        }
        return {
          kind: "final",
          text: "Done.",
          assistantMessage: { role: "assistant", content: "Done." },
        };
      },
    }),
  });
  deps.getAgentRuntime = () => runtime;
  const previousMode = getOriginalAgentPermissionMode();
  setOriginalAgentPermissionMode("auto");
  try {
    await sendAgentTurn(
      {
        body,
        item,
        question: "Continue and tag this paper.",
        advanced: {
          temperature: 0,
          outputTokenLimit: { mode: "auto" },
          inputTokenCap: 100_000,
        },
      },
      deps,
    );
  } finally {
    setOriginalAgentPermissionMode(previousMode);
  }
  const runId = deps.chatHistory.get(key)?.at(-1)?.agentRunId || "";
  const trace = await getAgentRunTrace(runId);
  const events = trace.events.map((event) => event.payload);
  return {
    legacyRun: {
      status: legacyTrace.run?.status,
      finalText: legacyTrace.run?.finalText,
    },
    runId,
    runStatus: trace.run?.status,
    prompts,
    contractEvents: events.filter(
      (event) =>
        event.type === "provider_event" &&
        event.providerType === "agent_action_contract",
    ).length,
    toolResults: events.flatMap((event) =>
      event.type === "tool_result" && event.name === "library_update"
        ? [
            {
              ok: event.ok,
              receipts: (event.actionReceipts || []).map((receipt) => ({
                status: receipt.status,
                verification: receipt.verification,
              })),
            },
          ]
        : [],
    ),
  };
}
