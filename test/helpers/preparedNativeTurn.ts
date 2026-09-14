import { runCodexAppServerNativeTurn as runPreparedNativeTurn } from "../../src/codexAppServer/nativeClient";
import { buildCodexNativeSkillRequest } from "../../src/codexAppServer/nativeSkills";
import type { AgentRuntimeRequest } from "../../src/agent/types";
import { classifiedFixture } from "./semanticIntent";

// Lifecycle tests supply explicit semantic fixtures; the production API accepts
// only a host-prepared request and never reconstructs authority from messages.
type NativeFixtureInput = Omit<
  Parameters<typeof runPreparedNativeTurn>[0],
  "semanticRequest" | "eventJournal"
> & {
  eventJournal?: import("../src/agent/store/traceStore").AgentRunEventJournal;
} & Partial<
    Pick<
      AgentRuntimeRequest,
      | "planContext"
      | "actionContract"
      | "classifiedIntent"
      | "skillRoutingReceipt"
      | "actionPreparation"
    >
  > & {
    semanticRequest?: AgentRuntimeRequest;
    sourceMessageTimestamp?: number;
  };
export const runCodexAppServerNativeTurn = (input: NativeFixtureInput) => {
  const latest = input.messages
    .filter((message) => message.role === "user")
    .at(-1)?.content;
  const request = input.semanticRequest || {
    ...buildCodexNativeSkillRequest({
      scope: input.scope,
      userText: typeof latest === "string" ? latest : "Fixture request",
      model: input.model,
      apiBase: input.codexPath,
      skillContext: input.skillContext,
    }),
    classifiedIntent:
      input.classifiedIntent ||
      input.actionContract?.intent ||
      classifiedFixture(),
    actionContract: input.actionContract,
    actionPreparation: input.actionPreparation || {
      state: "ready" as const,
      issues: [],
    },
    planContext: input.planContext,
    metadata: { sourceMessageTimestamp: input.sourceMessageTimestamp },
  };
  return runPreparedNativeTurn({
    ...input,
    semanticRequest: request,
    eventJournal: input.eventJournal || {
      runId: "fixture-host-run",
      append: async () => {},
      finish: async () => {},
    },
  });
};
