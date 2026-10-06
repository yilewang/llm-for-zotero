import { assert } from "chai";
import {
  createAgentTurnEventHandler,
  type AgentEngineDeps,
} from "../src/modules/contextPanel/agentMode/agentEngine";
import type { Message } from "../src/modules/contextPanel/types";
import { fakeDocument, FakeElement } from "./helpers/fakeDom";

/** A timer the test fires by hand, standing in for the panel window's. */
function createWindowTimers() {
  const pending: Array<{ delay: number; callback: () => void }> = [];
  return {
    setTimeout: (callback: () => void, delay: number) => {
      pending.push({ delay, callback });
      return pending.length;
    },
    fireAll() {
      for (const timer of pending.splice(0)) timer.callback();
    },
    pendingDelays: () => pending.map((timer) => timer.delay),
  };
}

function createTurn() {
  const timers = createWindowTimers();
  const body = new FakeElement("div") as FakeElement & {
    ownerDocument: unknown;
  };
  body.ownerDocument = {
    createElement: fakeDocument.createElement,
    defaultView: { setTimeout: timers.setTimeout },
  };
  const chatBox = new FakeElement("div");
  const assistantMessage: Message = {
    role: "assistant",
    text: "",
    timestamp: 2,
    runMode: "agent",
    streaming: true,
  };
  const handle = createAgentTurnEventHandler({
    deps: {
      appendReasoningPart: (base: string | undefined, next?: string) =>
        `${base || ""}${next || ""}`,
      sanitizeText: (text: string) => text,
    } as unknown as AgentEngineDeps,
    body: body as unknown as Element,
    ui: { chatBox } as never,
    conversationKey: 1,
    runtimeRequest: { conversationKey: 1, mode: "agent", userText: "Q" },
    assistantMessage,
    pairedUserMessage: { role: "user", text: "Q", timestamp: 1 },
    history: [],
    isCompactCommand: false,
    compactStyle: "keep-assistant",
    messageDeltaCoalescer: { pushText: () => {} },
    flushMessageDeltas: () => {},
    queueRefresh: () => {},
    refreshAssistant: () => {},
    refreshChatSafely: () => {},
    setStatusSafely: () => {},
    pushTraceEvent: () => {},
    scheduleQueueDrain: () => {},
  });
  const action = {
    toolName: "apply_tags",
    mode: "review",
    title: "Apply tags",
    confirmLabel: "Apply",
    cancelLabel: "Cancel",
    fields: [],
    actions: [
      { id: "approve", label: "Apply", approved: true },
      { id: "cancel", label: "Cancel", approved: false },
    ],
  };
  const inlineCards = () =>
    chatBox.children.filter((child) =>
      child.classList.contains("llm-action-inline-card"),
    );
  return { handle, timers, action, inlineCards };
}

describe("agent turn approval card repaint", function () {
  it("paints an approval card, then repaints it once after its delay while it is still pending", async function () {
    const { handle, timers, action, inlineCards } = createTurn();
    await handle({
      type: "confirmation_required",
      requestId: "req-1",
      action,
    } as never);
    assert.lengthOf(inlineCards(), 1);
    assert.deepEqual(timers.pendingDelays(), [90]);

    timers.fireAll();
    assert.lengthOf(inlineCards(), 1);
    assert.equal(inlineCards()[0].dataset.requestId, "req-1");
  });

  it("does not bring back an approval settled before the delayed repaint ran", async function () {
    const { handle, timers, action, inlineCards } = createTurn();
    await handle({
      type: "confirmation_required",
      requestId: "req-1",
      action,
    } as never);
    // The same chat open in another surface approves it at once.
    await handle({
      type: "confirmation_resolved",
      requestId: "req-1",
      approved: true,
    } as never);
    assert.lengthOf(inlineCards(), 0);

    timers.fireAll();
    assert.lengthOf(inlineCards(), 0, "a settled approval is not repainted");
  });
});
