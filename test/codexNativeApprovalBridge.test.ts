import { assert } from "chai";
import type {
  AgentConfirmationResolution,
  AgentPendingAction,
} from "../src/agent/types";
import { resolveCodexNativeApprovalWithOptionalReviewCard } from "../src/modules/contextPanel/chat";

describe("Codex native approval bridge", function () {
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

  it("fails closed without rendering a card when native approvals are disabled", async function () {
    const statuses = recordStatuses();
    let rendered = false;

    const response = await resolveCodexNativeApprovalWithOptionalReviewCard({
      body,
      request: commandRequest,
      setStatusSafely: statuses.setStatusSafely,
      isNativeApprovalsEnabled: () => false,
      showActionCard: async () => {
        rendered = true;
        return { approved: true };
      },
    });

    assert.deepEqual(response, { decision: "decline" });
    assert.equal(rendered, false);
    assert.include(
      statuses.entries.at(-1)?.text,
      "denied a built-in or untrusted approval request",
    );
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
      isNativeApprovalsEnabled: () => true,
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
      isNativeApprovalsEnabled: () => true,
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
      isNativeApprovalsEnabled: () => true,
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
});
