import { assert } from "chai";
import type {
  AgentConfirmationResolution,
  AgentPendingAction,
} from "../src/agent/types";
import {
  resolveCodexNativeApprovalWithOptionalReviewCard,
  resolveCodexNativeHostInteractionWithTrace,
} from "../src/modules/contextPanel/codexNative/turnCallbacks";

describe("Codex native approval bridge", function () {
  it("lets the trace exclusively own a host-interaction question card", async function () {
    const events: string[] = [];
    let traceOwnsCard = false;
    const action: AgentPendingAction = {
      toolName: "request_user_input",
      title: "Plan needs your input",
      fields: [],
    };

    const resolution = await resolveCodexNativeHostInteractionWithTrace({
      body: {} as Element,
      action,
      nextRequestId: () => "host-question-1",
      trace: {
        noteMcpConfirmationRequired: () => events.push("required"),
        noteMcpConfirmationResolved: () => events.push("resolved"),
      },
      showActionCard: async (
        _body,
        requestId,
        renderedAction,
        _signal,
        ownsCard,
      ) => {
        assert.equal(requestId, "host-question-1");
        assert.strictEqual(renderedAction, action);
        traceOwnsCard = Boolean(ownsCard);
        return { approved: true, actionId: "continue" };
      },
    });

    assert.isTrue(
      traceOwnsCard,
      "the immediate bridge must not mount a duplicate inline card",
    );
    assert.deepEqual(events, ["required", "resolved"]);
    assert.deepEqual(resolution, {
      approved: true,
      actionId: "continue",
    });
  });

  it("does not display a resolved native question or invent an answer", async function () {
    const controller = new AbortController();
    controller.abort();
    let shown = false;
    const response = await resolveCodexNativeApprovalWithOptionalReviewCard({
      body: {} as Element,
      request: {
        method: "item/tool/requestUserInput",
        signal: controller.signal,
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "question",
          questions: [
            {
              id: "q",
              question: "Choose?",
              options: [{ label: "Yes" }, { label: "No" }],
            },
          ],
        },
      },
      setStatusSafely: () => {},
      showActionCard: async () => {
        shown = true;
        return { approved: true };
      },
    });
    assert.isFalse(shown);
    assert.deepEqual(response, { answers: {} });
  });
  it("renders native planning questions and returns exact labels and free text", async function () {
    let action: AgentPendingAction | undefined;
    const questionEvents: string[] = [];
    const result = await resolveCodexNativeApprovalWithOptionalReviewCard({
      body: {} as Element,
      trace: {
        noteMcpConfirmationRequired: () => {
          questionEvents.push("required");
        },
        noteMcpConfirmationResolved: () => {
          questionEvents.push("resolved");
        },
      },
      request: {
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "question",
          questions: [
            {
              id: "format",
              header: "Format",
              question: "Which format?",
              options: [
                { label: "Review", description: "A review" },
                { label: "Table", description: "A table" },
              ],
            },
            {
              id: "focus",
              header: "Focus",
              question: "Which focus?",
              options: null,
            },
          ],
        },
      },
      setStatusSafely: () => {},
      showActionCard: async (_body, _id, pending) => {
        action = pending;
        return {
          approved: true,
          data: {
            format: { kind: "option", optionId: "option-1" },
            focus: "Representational drift",
          },
        };
      },
    });
    assert.equal(action?.toolName, "request_user_input");
    assert.deepEqual(
      questionEvents,
      ["required", "resolved"],
      "the existing trace restores pending questions after a panel is rebuilt and closes resolved cards",
    );
    assert.deepEqual(
      action?.fields.map((field) => field.type),
      ["choice", "choice"],
      "free text uses the shared planning question card",
    );
    assert.deepEqual(result, {
      answers: {
        format: { answers: ["Review"] },
        focus: { answers: ["Representational drift"] },
      },
    });
  });
  const body = {} as Element;
  const commandRequest = {
    method: "item/commandExecution/requestApproval",
    params: { command: "npm test", cwd: "/repo/example" },
  };

  function recordStatuses(): {
    entries: Array<{ text: string; kind: unknown }>;
    setStatusSafely: (text: string, kind: any) => void;
  } {
    const entries: Array<{ text: string; kind: unknown }> = [];
    return {
      entries,
      setStatusSafely: (text: string, kind: any) => {
        entries.push({ text, kind });
      },
    };
  }

  it("always renders built-in approval requests without an enable switch", async function () {
    const statuses = recordStatuses();
    let rendered = false;

    const response = await resolveCodexNativeApprovalWithOptionalReviewCard({
      body,
      request: commandRequest,
      setStatusSafely: statuses.setStatusSafely,
      showActionCard: async () => {
        rendered = true;
        return { approved: true };
      },
    });

    assert.deepEqual(response, { decision: "accept" });
    assert.equal(rendered, true);
    assert.include(statuses.entries.at(-1)?.text, "waiting for your approval");
  });

  it("renders a native approval card and resolves approved command requests", async function () {
    const statuses = recordStatuses();
    let renderedRequestId = "";
    let renderedAction: AgentPendingAction | undefined;
    let requiredTrace: AgentPendingAction | undefined;
    let resolvedTrace: AgentConfirmationResolution | undefined;

    const response = await resolveCodexNativeApprovalWithOptionalReviewCard({
      body,
      request: commandRequest,
      setStatusSafely: statuses.setStatusSafely,
      nextRequestId: () => "native-approval-1",
      trace: {
        noteMcpConfirmationRequired: (_requestId, action) => {
          requiredTrace = action;
        },
        noteMcpConfirmationResolved: (_requestId, resolution) => {
          resolvedTrace = resolution;
        },
      },
      showActionCard: async (_body, requestId, action) => {
        renderedRequestId = requestId;
        renderedAction = action;
        return { approved: true, actionId: "approve" };
      },
    });

    assert.deepEqual(response, { decision: "accept" });
    assert.equal(renderedRequestId, "native-approval-1");
    assert.equal(renderedAction?.toolName, "codex_native_approval");
    assert.equal(renderedAction?.mode, "approval");
    assert.include(JSON.stringify(renderedAction), "npm test");
    assert.equal(requiredTrace, renderedAction);
    assert.deepEqual(resolvedTrace, { approved: true, actionId: "approve" });
    assert.include(
      statuses.entries.map((entry) => entry.text).join("\n"),
      "waiting for your approval",
    );
  });

  it("resolves denied native approval cards with the app-server denial shape", async function () {
    const statuses = recordStatuses();

    const response = await resolveCodexNativeApprovalWithOptionalReviewCard({
      body,
      request: commandRequest,
      setStatusSafely: statuses.setStatusSafely,
      nextRequestId: () => "native-approval-2",
      showActionCard: async () => ({ approved: false, actionId: "deny" }),
    });

    assert.deepEqual(response, { decision: "decline" });
  });

  it("fails closed when the approval card UI is unavailable", async function () {
    const statuses = recordStatuses();

    const response = await resolveCodexNativeApprovalWithOptionalReviewCard({
      body,
      request: commandRequest,
      setStatusSafely: statuses.setStatusSafely,
      showActionCard: async () => {
        throw new Error("missing panel");
      },
    });

    assert.deepEqual(response, { decision: "decline" });
    assert.include(
      statuses.entries.at(-1)?.text,
      "approval UI was unavailable",
    );
  });

  it("denies without rendering when panel ownership is already stale", async function () {
    const statuses = recordStatuses();
    let rendered = false;

    const response = await resolveCodexNativeApprovalWithOptionalReviewCard({
      body,
      request: commandRequest,
      setStatusSafely: statuses.setStatusSafely,
      isCurrent: () => false,
      showActionCard: async () => {
        rendered = true;
        return { approved: true };
      },
    });

    assert.deepEqual(response, { decision: "decline" });
    assert.isFalse(rendered);
    assert.deepEqual(statuses.entries, []);
  });

  it("denies an approval resolved after panel ownership changes", async function () {
    const statuses = recordStatuses();
    let current = true;
    let resolvedTrace: AgentConfirmationResolution | undefined;

    const response = await resolveCodexNativeApprovalWithOptionalReviewCard({
      body,
      request: commandRequest,
      setStatusSafely: statuses.setStatusSafely,
      isCurrent: () => current,
      trace: {
        noteMcpConfirmationResolved: (_requestId, resolution) => {
          resolvedTrace = resolution;
        },
      },
      showActionCard: async () => {
        current = false;
        return { approved: true };
      },
    });

    assert.deepEqual(response, { decision: "decline" });
    assert.isUndefined(resolvedTrace);
  });
});

/**
 * Codex 0.164 asks for an MCP tool approval with `mcpServer/elicitation/request`
 * (approval mode "writes", policy on-request, reviewer user). The payload
 * below is the one captured from the installed Codex 0.164 app-server on
 * 2026-10-31, with only the server name (the probe was "capture_probe") and
 * the ids replaced. The plugin used to decline every elicitation silently;
 * a Zotero write now opens a card, and the answer is Codex's own action.
 */
const ZOTERO_SERVER = "llm_for_zotero_profile_abc123";
const capturedZoteroWriteApproval = {
  method: "mcpServer/elicitation/request",
  params: {
    threadId: "thread-capture",
    turnId: "turn-capture",
    serverName: ZOTERO_SERVER,
    mode: "form",
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      tool_description: "Add a tag to a probe item. Writes data.",
      tool_params: { tag: "probe-a" },
      tool_params_display: [
        { name: "tag", value: "probe-a", display_name: "tag" },
      ],
    },
    message: `Allow the ${ZOTERO_SERVER} MCP server to run tool "library_update"?`,
    requestedSchema: { type: "object", properties: {} },
  },
  // Set by the turn that received it: its own Zotero server's name.
  zoteroMcpServerName: ZOTERO_SERVER,
};

describe("Codex approval card for a Zotero MCP write", function () {
  const body = {} as Element;
  function statuses() {
    const entries: Array<{ text: string; kind: string }> = [];
    return {
      entries,
      setStatusSafely: (text: string, kind: string) =>
        entries.push({ text, kind }),
    };
  }

  it("shows a card naming the tool and its arguments, and accepts on approve", async function () {
    const status = statuses();
    let shown: AgentPendingAction | undefined;
    let traced: AgentPendingAction | undefined;
    let resolved: AgentConfirmationResolution | undefined;
    const response = await resolveCodexNativeApprovalWithOptionalReviewCard({
      body,
      request: capturedZoteroWriteApproval,
      setStatusSafely: status.setStatusSafely,
      nextRequestId: () => "zotero-write-1",
      trace: {
        noteMcpConfirmationRequired: (_id, action) => (traced = action),
        noteMcpConfirmationResolved: (_id, resolution) =>
          (resolved = resolution),
      },
      showActionCard: async (_body, requestId, action) => {
        assert.equal(requestId, "zotero-write-1");
        shown = action;
        return { approved: true, actionId: "approve" };
      },
    });
    assert.deepEqual(response, {
      action: "accept",
      content: null,
      _meta: null,
    });
    assert.exists(shown);
    assert.equal(shown?.mode, "approval");
    assert.include(shown?.title || "", "library_update");
    assert.equal(
      shown?.description,
      "Codex asks to change your Zotero library with library_update.",
    );
    assert.include(JSON.stringify(shown?.fields), "probe-a");
    assert.strictEqual(traced, shown);
    assert.deepEqual(resolved, { approved: true, actionId: "approve" });
    assert.include(
      status.entries.map((entry) => entry.text).join("\n"),
      "waiting for your approval",
    );
  });

  it("declines with Codex's decline action when the user denies", async function () {
    const response = await resolveCodexNativeApprovalWithOptionalReviewCard({
      body,
      request: capturedZoteroWriteApproval,
      setStatusSafely: statuses().setStatusSafely,
      showActionCard: async () => ({ approved: false, actionId: "deny" }),
    });
    assert.deepEqual(response, {
      action: "decline",
      content: null,
      _meta: null,
    });
  });

  it("says so when the card cannot be shown, and declines", async function () {
    const status = statuses();
    const response = await resolveCodexNativeApprovalWithOptionalReviewCard({
      body,
      request: capturedZoteroWriteApproval,
      setStatusSafely: status.setStatusSafely,
      showActionCard: async () => {
        throw new Error("missing panel");
      },
    });
    assert.deepEqual(response, {
      action: "decline",
      content: null,
      _meta: null,
    });
    assert.equal(status.entries.at(-1)?.kind, "error");
    assert.include(status.entries.at(-1)?.text, "approval UI was unavailable");
  });

  it("declines an approval answered after the panel changed owner", async function () {
    let current = true;
    const response = await resolveCodexNativeApprovalWithOptionalReviewCard({
      body,
      request: capturedZoteroWriteApproval,
      setStatusSafely: statuses().setStatusSafely,
      isCurrent: () => current,
      showActionCard: async () => {
        current = false;
        return { approved: true };
      },
    });
    assert.deepEqual(response, {
      action: "decline",
      content: null,
      _meta: null,
    });
  });

  it("names what a command, a file or a script approval does", async function () {
    for (const [tool, text] of [
      ["run_command", "Codex asks to run a command on this computer."],
      ["file_io", "Codex asks to read or write a file on this computer."],
      ["zotero_script", "Codex asks to run a Zotero script."],
    ]) {
      let shown: AgentPendingAction | undefined;
      await resolveCodexNativeApprovalWithOptionalReviewCard({
        body,
        request: {
          ...capturedZoteroWriteApproval,
          params: {
            ...capturedZoteroWriteApproval.params,
            message: `Allow the ${ZOTERO_SERVER} MCP server to run tool "${tool}"?`,
          },
        },
        setStatusSafely: statuses().setStatusSafely,
        showActionCard: async (_body, _id, action) => {
          shown = action;
          return { approved: false };
        },
      });
      assert.equal(shown?.description, text, tool);
    }
  });

  for (const [label, request] of [
    [
      "an elicitation from the Zotero server that is not a tool approval",
      {
        ...capturedZoteroWriteApproval,
        params: {
          ...capturedZoteroWriteApproval.params,
          _meta: { tool_params: { tag: "probe-a" } },
        },
      },
    ],
    [
      "a tool approval from another server that starts with the plugin's name",
      {
        ...capturedZoteroWriteApproval,
        params: {
          ...capturedZoteroWriteApproval.params,
          serverName: "llm_for_zotero_profile_other",
        },
      },
    ],
    [
      "a tool approval that reached no Zotero turn",
      { ...capturedZoteroWriteApproval, zoteroMcpServerName: undefined },
    ],
  ] as const) {
    it(`declines ${label} without a card`, async function () {
      let shown = false;
      const response = await resolveCodexNativeApprovalWithOptionalReviewCard({
        body,
        request,
        setStatusSafely: statuses().setStatusSafely,
        showActionCard: async () => {
          shown = true;
          return { approved: true };
        },
      });
      assert.isFalse(shown);
      assert.equal((response as { action?: string }).action, "decline");
    });
  }

  it("keeps declining an elicitation from another MCP server without a card", async function () {
    let shown = false;
    const response = await resolveCodexNativeApprovalWithOptionalReviewCard({
      body,
      request: {
        ...capturedZoteroWriteApproval,
        params: {
          ...capturedZoteroWriteApproval.params,
          serverName: "some_other_server",
          message:
            'Allow the some_other_server MCP server to run tool "library_update"?',
        },
      },
      setStatusSafely: statuses().setStatusSafely,
      showActionCard: async () => {
        shown = true;
        return { approved: true };
      },
    });
    assert.isFalse(shown);
    assert.equal((response as { action?: string }).action, "decline");
  });
});
