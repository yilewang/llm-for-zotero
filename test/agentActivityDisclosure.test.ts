import { assert } from "chai";
import type { AgentRunEventRecord } from "../src/agent/types";
import type { Message } from "../src/modules/contextPanel/types";
import {
  disposeAgentTrace,
  renderAgentTrace,
} from "../src/modules/contextPanel/agentTrace/render";
import { fakeDocument, FakeElement } from "./helpers/fakeDom";

describe("agent activity disclosure completion", function () {
  function fixture() {
    const message: Message = {
      role: "assistant",
      text: "",
      timestamp: 1_000,
      runMode: "agent",
      modelProviderLabel: "Codex",
      streaming: true,
    };
    const events: AgentRunEventRecord[] = [
      {
        runId: "activity-completion",
        seq: 1,
        eventType: "codex_progress",
        payload: {
          type: "codex_progress",
          itemId: "answer",
          text: "The answer is ready.",
          status: "running",
        },
        createdAt: 1_000,
      },
    ];
    const trace = renderAgentTrace({ doc: fakeDocument, message, events })!;
    const disclosure = (trace as unknown as FakeElement).findByClass(
      "llm-agent-activity-details",
    )!;
    const finish = () => {
      message.streaming = false;
      message.text = "The answer is ready.";
      events.push({
        runId: "activity-completion",
        seq: 2,
        eventType: "final",
        payload: { type: "final", text: message.text },
        createdAt: 2_000,
      });
    };
    return { message, events, trace, disclosure, finish };
  }

  function loadingFixture(streaming?: boolean) {
    // Stored messages omit the transient streaming flag on a fresh start.
    const message: Message = {
      role: "assistant",
      text: streaming ? "" : "The saved answer.",
      timestamp: 73_000,
      runMode: "agent",
      agentRunId: "saved-codex-run",
      modelProviderLabel: "Codex",
      streaming,
    };
    const events: AgentRunEventRecord[] = [
      {
        runId: "saved-codex-run",
        seq: 1,
        eventType: "status",
        payload: { type: "status", text: "Request sent to Codex." },
        createdAt: 1_000,
      },
    ];
    const trace = renderAgentTrace({
      doc: fakeDocument,
      message,
      events: [],
      onTraceMissing: () => {},
    })!;
    const disclosure = (trace as unknown as FakeElement).findByClass(
      "llm-agent-activity-details",
    )!;
    return { message, events, trace, disclosure };
  }

  for (const streaming of [undefined, false]) {
    for (const retained of [true, false]) {
      it(`keeps a restored completed activity collapsed through loading (${streaming}, ${retained ? "retained" : "rebuilt"})`, function () {
        const { message, events, trace, disclosure } =
          loadingFixture(streaming);
        assert.isFalse(disclosure.open, "loading history must not expand it");
        // Let the loading view's native toggle arrive before durable events.
        disclosure.dispatchFakeEvent("toggle");
        const loaded = renderAgentTrace({
          doc: fakeDocument,
          message,
          events,
          ...(retained ? { previous: trace } : {}),
        })!;
        const root = loaded as unknown as FakeElement;
        assert.isFalse(root.findByClass("llm-agent-activity-details")!.open);
        assert.match(
          root.findByClass("llm-agent-activity-summary")!.textContent,
          /^Worked for /,
        );
        disposeAgentTrace(trace);
        if (loaded !== trace) disposeAgentTrace(loaded);
      });
    }
  }

  it("keeps an explicit expansion or collapse while historical activity loads", function () {
    const { message, events, trace, disclosure } = loadingFixture();
    disclosure.open = true;
    disclosure.dispatchFakeEvent("toggle");
    renderAgentTrace({
      doc: fakeDocument,
      message,
      events: [],
      previous: trace,
      onTraceMissing: () => {},
    });
    assert.isTrue(disclosure.open);
    disclosure.open = false;
    disclosure.dispatchFakeEvent("toggle");
    renderAgentTrace({
      doc: fakeDocument,
      message,
      events: [],
      previous: trace,
      onTraceMissing: () => {},
    });
    assert.isFalse(disclosure.open, "loading must honor the reader's collapse");
    renderAgentTrace({ doc: fakeDocument, message, events, previous: trace });
    assert.isFalse(disclosure.open);
    disposeAgentTrace(trace);
  });

  it("opens live activity by default but honors a manual collapse during loading", function () {
    const { message, events, trace, disclosure } = loadingFixture(true);
    assert.isTrue(disclosure.open);
    disclosure.open = false;
    disclosure.dispatchFakeEvent("toggle");
    renderAgentTrace({
      doc: fakeDocument,
      message,
      events: [],
      previous: trace,
      onTraceMissing: () => {},
    });
    assert.isFalse(disclosure.open);
    renderAgentTrace({ doc: fakeDocument, message, events, previous: trace });
    assert.isFalse(disclosure.open);
    disposeAgentTrace(trace);
  });

  for (const retained of [true, false]) {
    it(`collapses after a delayed running toggle before a ${retained ? "retained" : "rebuilt"} completed render`, function () {
      const { message, events, trace, disclosure, finish } = fixture();
      assert.isTrue(disclosure.open);
      finish();
      // Native details dispatches toggle asynchronously. The initial opening
      // can arrive after the message is marked complete, before its UI updates.
      disclosure.dispatchFakeEvent("toggle");
      const completed = renderAgentTrace({
        doc: fakeDocument,
        message,
        events,
        ...(retained ? { previous: trace } : {}),
      })!;
      const completedDisclosure = (
        completed as unknown as FakeElement
      ).findByClass("llm-agent-activity-details")!;
      assert.isFalse(completedDisclosure.open);
      assert.match(
        (completed as unknown as FakeElement).findByClass(
          "llm-agent-activity-summary",
        )!.textContent,
        /^Worked for /,
      );
      assert.include(
        completedDisclosure
          .findAllByClass("llm-agent-process-message")
          .map((node) => node.textContent + node.innerHTML)
          .join("\n"),
        "The answer is ready.",
        "completion keeps the recorded activity available to reopen",
      );
      disposeAgentTrace(trace);
      if (completed !== trace) disposeAgentTrace(completed);
    });
  }

  it("preserves a user's completed expansion through later redraws", function () {
    const { message, events, trace, disclosure, finish } = fixture();
    finish();
    renderAgentTrace({ doc: fakeDocument, message, events, previous: trace });
    assert.isFalse(disclosure.open);
    disclosure.dispatchFakeEvent("toggle");

    disclosure.open = true;
    disclosure.dispatchFakeEvent("toggle");
    renderAgentTrace({ doc: fakeDocument, message, events, previous: trace });
    assert.isTrue(disclosure.open);
    const rebuilt = renderAgentTrace({ doc: fakeDocument, message, events })!;
    assert.isTrue(
      (rebuilt as unknown as FakeElement).findByClass(
        "llm-agent-activity-details",
      )!.open,
      "completion only closes once, not on every render",
    );
    disposeAgentTrace(trace);
    disposeAgentTrace(rebuilt);
  });
});
