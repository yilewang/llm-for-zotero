import { assert } from "chai";
import type {
  AgentConfirmationResolution,
  AgentPendingAction,
} from "../src/agent/types";
import { resolveCodexNativeApprovalWithOptionalReviewCard } from "../src/modules/contextPanel/chat";

describe("Codex native approval bridge", function () {
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
