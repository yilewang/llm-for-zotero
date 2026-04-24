import { assert } from "chai";
import {
  buildAgentTraceDisplayItems,
  getPendingActionButtonLayout,
} from "../src/modules/contextPanel/agentTrace/render";
import type {
  AgentPendingAction,
  AgentRunEventRecord,
} from "../src/agent/types";

describe("agentTrace render", function () {
  it("preserves whitespace when compacting reasoning deltas", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          details: "Let me ",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          details: "read the paper first.",
        },
        createdAt: 2,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const reasoningItem = items.find((item) => item.type === "reasoning");

    assert.deepInclude(reasoningItem, {
      type: "reasoning",
      summary: "Let me read the paper first.",
      label: "Thinking",
    });
  });

  it("renders app-server reasoning item IDs as separate thinking steps", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          stepId: "reasoning-a",
          details: "First thought.",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "file_io",
          args: { action: "read", filePath: "/tmp/manifest.json" },
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          stepId: "reasoning-b",
          details: "Second thought.",
        },
        createdAt: 3,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const reasoningItems = items.filter((item) => item.type === "reasoning");

    assert.deepEqual(
      reasoningItems.map((item) =>
        item.type === "reasoning"
          ? { label: item.label, summary: item.summary }
          : null,
      ),
      [
        { label: "Thinking for step 1", summary: "First thought." },
        { label: "Thinking for step 2", summary: "Second thought." },
      ],
    );
  });

  it("compacts same app-server reasoning item IDs into one thinking step", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          stepId: "reasoning-a",
          details: "Read ",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          stepId: "reasoning-a",
          details: "manifest.",
        },
        createdAt: 2,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const reasoningItems = items.filter((item) => item.type === "reasoning");

    assert.lengthOf(reasoningItems, 1);
    assert.deepInclude(reasoningItems[0], {
      type: "reasoning",
      label: "Thinking for step 1",
      summary: "Read manifest.",
    });
  });

  it("splits reasoning into a new thinking block after a tool call", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          details: "First thought.",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "Read",
          args: {},
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          details: "Second thought.",
        },
        createdAt: 3,
      },
    ];

    const items = buildAgentTraceDisplayItems(events, null).filter(
      (item) => item.type === "reasoning",
    );

    assert.lengthOf(items, 2);
    assert.deepInclude(items[0], { type: "reasoning", summary: "First thought.", label: "Thinking" });
    assert.deepInclude(items[1], { type: "reasoning", summary: "Second thought.", label: "Thinking" });
  });

  it("uses a single primary action surface for multi-action review cards", function () {
    const action: AgentPendingAction = {
      toolName: "search_literature_online",
      mode: "review",
      title: "Review online search results",
      actions: [
        { id: "import", label: "Import selected", style: "primary" },
        { id: "save_note", label: "Save selected as note", style: "secondary" },
        { id: "new_search", label: "Search again", style: "secondary" },
        { id: "cancel", label: "Cancel", style: "secondary" },
      ],
      defaultActionId: "import",
      cancelActionId: "cancel",
      fields: [],
    };

    assert.deepEqual(getPendingActionButtonLayout(action), {
      hasActionChooser: true,
      showsFooterExecuteButton: false,
    });
  });

  it("shows a footer execute button when a multi-action review needs extra input", function () {
    const action: AgentPendingAction = {
      toolName: "search_literature_online",
      mode: "review",
      title: "Review online literature results",
      actions: [
        { id: "import", label: "Import selected", style: "primary" },
        { id: "save_note", label: "Save selected as note", style: "secondary" },
        { id: "new_search", label: "Search again", style: "secondary" },
        { id: "cancel", label: "Cancel", style: "secondary" },
      ],
      defaultActionId: "import",
      cancelActionId: "cancel",
      fields: [
        {
          type: "text",
          id: "nextQuery",
          label: "Next search query",
          value: "plasticity",
          visibleForActionIds: ["new_search"],
          requiredForActionIds: ["new_search"],
        },
      ],
    };

    assert.deepEqual(getPendingActionButtonLayout(action), {
      hasActionChooser: true,
      showsFooterExecuteButton: true,
    });
  });

  it("keeps the footer execute button for legacy confirm-cancel cards", function () {
    const action: AgentPendingAction = {
      toolName: "update_metadata",
      title: "Confirm library change",
      confirmLabel: "Apply",
      cancelLabel: "Cancel",
      fields: [],
    };

    assert.deepEqual(getPendingActionButtonLayout(action), {
      hasActionChooser: false,
      showsFooterExecuteButton: true,
    });
  });

  it("removes repetitive filler chatter between tool steps", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "read_paper",
          args: { operation: "front_matter" },
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "call-1",
          name: "read_paper",
          ok: true,
          content: { operation: "front_matter", results: [{}] },
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-2",
          name: "search_paper",
          args: { operation: "retrieve_evidence" },
        },
        createdAt: 3,
      },
      {
        runId: "run-1",
        seq: 4,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: "Answer text",
        },
        createdAt: 4,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const messageTexts = items
      .filter(
        (item): item is Extract<(typeof items)[number], { type: "message" }> =>
          item.type === "message",
      )
      .map((item) => item.text);
    const actionTexts = items
      .filter(
        (item): item is Extract<(typeof items)[number], { type: "action" }> =>
          item.type === "action",
      )
      .map((item) => item.row.text);

    assert.notInclude(
      messageTexts.join("\n"),
      "I'm ready for the next step, so I'm using",
    );
    assert.notInclude(
      messageTexts.join("\n"),
      "I have enough grounded information now",
    );
    assert.include(actionTexts, "Drafting answer");
  });

  it("does not mark rolled-back scratch text as interleaved", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: "Let me inspect this first.",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "message_rollback",
        payload: {
          type: "message_rollback",
          length: "Let me inspect this first.".length,
          text: "Let me inspect this first.",
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "read_paper",
          args: { operation: "front_matter" },
        },
        createdAt: 3,
      },
    ];

    const { items, isInterleaved } = buildAgentTraceDisplayItems(events, null);

    assert.isFalse(isInterleaved);
    assert.isFalse(items.some((item) => item.type === "inline_text"));
  });

  it("keeps visible text before a tool call marked as interleaved", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: "Working through the evidence.",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "read_paper",
          args: { operation: "front_matter" },
        },
        createdAt: 2,
      },
    ];

    const { items, isInterleaved } = buildAgentTraceDisplayItems(events, null);
    const inlineText = items.find((item) => item.type === "inline_text");

    assert.isTrue(isInterleaved);
    assert.deepEqual(inlineText, {
      type: "inline_text",
      text: "Working through the evidence.",
    });
  });
});
