import { assert } from "chai";
import {
  buildAgentTraceDisplayItems,
  getPendingActionButtonLayout,
} from "../src/modules/contextPanel/agentTrace/render";
import {
  shouldAttachAssistantResponseContextMenu,
  shouldDecorateInterleavedAgentTraceCitations,
  shouldSuppressAssistantResponseContextMenu,
} from "../src/modules/contextPanel/chat";
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

  it("renders Codex traces around app-server concepts", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "status",
        payload: {
          type: "status",
          text: "Running agent",
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
          details: "Inspecting Zotero context.",
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
          name: "search_library",
          args: { query: "memory" },
        },
        createdAt: 3,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null, {
      role: "assistant",
      text: "Done.",
      timestamp: 10,
      modelProviderLabel: "Codex",
    });

    assert.deepInclude(items[0], {
      type: "message",
      tone: "neutral",
      text: "Request sent to Codex.",
    });
    assert.deepInclude(items[1], {
      type: "action",
      row: {
        kind: "plan",
        icon: "↳",
        text: "Codex received the request",
      },
      chips: [],
    });
    assert.deepInclude(
      items.find((item) => item.type === "reasoning"),
      {
        type: "reasoning",
        label: "Codex reasoning 1",
        summary: "Inspecting Zotero context.",
      },
    );
    assert.isFalse(
      items.some(
        (item) =>
          item.type === "action" && item.row.text === "Running agent",
      ),
    );
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

    const { items } = buildAgentTraceDisplayItems(events, null);
    const reasoningItems = items.filter(
      (item) => item.type === "reasoning",
    );

    assert.lengthOf(reasoningItems, 2);
    assert.deepInclude(reasoningItems[0], {
      type: "reasoning",
      summary: "First thought.",
      label: "Thinking",
    });
    assert.deepInclude(reasoningItems[1], {
      type: "reasoning",
      summary: "Second thought.",
      label: "Thinking",
    });
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
    const messageTexts = items
      .filter(
        (item): item is Extract<(typeof items)[number], { type: "message" }> =>
          item.type === "message",
      )
      .map((item) => item.text);

    assert.isFalse(isInterleaved);
    assert.isFalse(items.some((item) => item.type === "inline_text"));
    assert.notInclude(messageTexts, "Let me inspect this first.");
  });

  it("shows rolled-back Codex scratch text inline before the tool call", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: "I'm reading the parsed paper text.",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "message_rollback",
        payload: {
          type: "message_rollback",
          length: "I'm reading the parsed paper text.".length,
          text: "I'm reading the parsed paper text.",
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
          args: { operation: "full_text" },
        },
        createdAt: 3,
      },
      {
        runId: "run-1",
        seq: 4,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "call-1",
          name: "read_paper",
          ok: true,
          content: { ok: true, filePath: "/tmp/full.md", chars: 81283 },
        },
        createdAt: 4,
      },
      {
        runId: "run-1",
        seq: 5,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: "This paper is about working memory.",
        },
        createdAt: 5,
      },
      {
        runId: "run-1",
        seq: 6,
        eventType: "final",
        payload: {
          type: "final",
          text: "This paper is about working memory.",
        },
        createdAt: 6,
      },
    ];

    const { items, isInterleaved } = buildAgentTraceDisplayItems(
      events,
      null,
      {
        role: "assistant",
        text: "This paper is about working memory.",
        timestamp: 1,
        runMode: "agent",
        modelProviderLabel: "Codex",
      },
    );
    const inlineTexts = items
      .filter(
        (
          item,
        ): item is Extract<(typeof items)[number], { type: "inline_text" }> =>
          item.type === "inline_text",
      )
      .map((item) => item.text);
    const scratchIndex = items.findIndex(
      (item) =>
        item.type === "inline_text" &&
        item.text === "I'm reading the parsed paper text.",
    );
    const toolIndex = items.findIndex(
      (item) => item.type === "action" && item.row.kind === "tool",
    );
    const finalIndex = items.findIndex(
      (item) =>
        item.type === "inline_text" &&
        item.text === "This paper is about working memory.",
    );
    const messageTexts = items
      .filter(
        (item): item is Extract<(typeof items)[number], { type: "message" }> =>
          item.type === "message",
      )
      .map((item) => item.text);
    const doneActions = items.filter(
      (item) => item.type === "action" && item.row.kind === "done",
    );

    assert.isTrue(isInterleaved);
    assert.deepEqual(inlineTexts, [
      "I'm reading the parsed paper text.",
      "This paper is about working memory.",
    ]);
    assert.isAtLeast(scratchIndex, 0);
    assert.isAtLeast(toolIndex, 0);
    assert.isAtLeast(finalIndex, 0);
    assert.isBelow(scratchIndex, toolIndex);
    assert.isAbove(finalIndex, toolIndex);
    assert.notInclude(messageTexts, "This paper is about working memory.");
    assert.lengthOf(doneActions, 1);
  });

  it("keeps the response menu available for Codex interleaved final text", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: "I need to read the paper first.",
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
          args: { operation: "full_text" },
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: "The paper argues that context switching changes recall.",
        },
        createdAt: 3,
      },
      {
        runId: "run-1",
        seq: 4,
        eventType: "final",
        payload: {
          type: "final",
          text: "The paper argues that context switching changes recall.",
        },
        createdAt: 4,
      },
    ];

    const { isInterleaved } = buildAgentTraceDisplayItems(events, null, {
      role: "assistant",
      text: "The paper argues that context switching changes recall.",
      timestamp: 1,
      runMode: "agent",
      modelProviderLabel: "Codex",
    });

    assert.isTrue(isInterleaved);
    assert.isTrue(
      shouldAttachAssistantResponseContextMenu({
        text: "The paper argues that context switching changes recall.",
      }),
    );
  });

  it("decorates citations for completed interleaved agent trace text", function () {
    const finalText =
      "Here is the paper evidence.\n\n" +
      "> The scaffold states can be used for content-addressable memory.\n\n" +
      "(Chandra et al., 2025)";
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: "I need to read the paper section first.",
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
          args: {
            action: "read",
            filePath: "/tmp/llm-for-zotero-mineru/51/full.md",
          },
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: finalText,
        },
        createdAt: 3,
      },
      {
        runId: "run-1",
        seq: 4,
        eventType: "final",
        payload: {
          type: "final",
          text: finalText,
        },
        createdAt: 4,
      },
    ];

    const { items, isInterleaved } = buildAgentTraceDisplayItems(
      events,
      null,
      {
        role: "assistant",
        text: finalText,
        timestamp: 1,
        runMode: "agent",
        modelProviderLabel: "Codex",
      },
    );
    const finalInlineText = items.find(
      (item) => item.type === "inline_text" && item.text === finalText,
    );

    assert.isTrue(isInterleaved);
    assert.exists(finalInlineText);
    assert.isTrue(
      shouldDecorateInterleavedAgentTraceCitations({
        agentTraceEl: {} as Element,
        agentUsesInterleavedText: isInterleaved,
        streaming: false,
      }),
    );
    assert.isFalse(
      shouldDecorateInterleavedAgentTraceCitations({
        agentTraceEl: {} as Element,
        agentUsesInterleavedText: isInterleaved,
        streaming: true,
      }),
    );
  });

  it("does not open the response menu from action-card controls", function () {
    const controlTarget = {
      closest: (selector: string) =>
        selector.includes(".llm-agent-hitl-card") ? {} : null,
    } as unknown as EventTarget;
    const textTarget = {
      closest: () => null,
    } as unknown as EventTarget;

    assert.isTrue(shouldSuppressAssistantResponseContextMenu(controlTarget));
    assert.isFalse(shouldSuppressAssistantResponseContextMenu(textTarget));
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

  it("deduplicates repeated interleaved text chunks around tool calls", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: "Now I have everything I need. Let me compose\nand write the note.",
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
          name: "TodoWrite",
          args: {},
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: "Now I have everything I need. Let me compose and write the note.",
        },
        createdAt: 3,
      },
    ];

    const { items, isInterleaved } = buildAgentTraceDisplayItems(events, null);
    const inlineTexts = items
      .filter(
        (item): item is Extract<(typeof items)[number], { type: "inline_text" }> =>
          item.type === "inline_text",
      )
      .map((item) => item.text);

    assert.isTrue(isInterleaved);
    assert.lengthOf(inlineTexts, 1);
  });

  it("omits generic completed rows when a tool already has no specific success summary", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "unknown_tool",
          args: {},
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
          name: "unknown_tool",
          ok: true,
          content: { ok: true },
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "final",
        payload: {
          type: "final",
          text: "Done",
        },
        createdAt: 3,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const actionTexts = items
      .filter(
        (item): item is Extract<(typeof items)[number], { type: "action" }> =>
          item.type === "action",
      )
      .map((item) => item.row.text);

    assert.notInclude(actionTexts, "Completed Unknown tool");
    assert.include(actionTexts, "Response ready");
  });

  it("shows the concrete skill name instead of a generic skill label", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "Skill",
          args: { skill: "graphwalk" },
        },
        createdAt: 1,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const actionTexts = items
      .filter(
        (item): item is Extract<(typeof items)[number], { type: "action" }> =>
          item.type === "action",
      )
      .map((item) => item.row.text);

    assert.include(actionTexts, "Using Skill: graphwalk");
    assert.notInclude(actionTexts, "Using Skill");
  });
});
