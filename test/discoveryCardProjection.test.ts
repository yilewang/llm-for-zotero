import { assert } from "chai";
import { getDiscoveryCardProjection } from "../src/modules/contextPanel/agentTrace/discoveryCardProjection";
import type { AgentRunEventRecord, AgentEvent } from "../src/agent/types";
const events = (...payloads: AgentEvent[]) =>
  payloads.map((payload) => ({ payload }) as AgentRunEventRecord);
describe("discovery card lifecycle projection", function () {
  const request = {
    type: "confirmation_required" as const,
    requestId: "first",
    action: {
      toolName: "literature_review",
      title: "Relevant papers",
      confirmLabel: "Import",
      cancelLabel: "Cancel",
      discovery: { sessionId: "trh_1", revision: 0 },
      fields: [
        {
          type: "paper_result_list" as const,
          id: "selectedPaperIds",
          label: "Papers",
          rows: [
            { id: "doi:one", title: "One", checked: true },
            { id: "doi:two", title: "Two", checked: true },
          ],
        },
      ],
    },
  };
  it("retains displayed papers and exact selection while additional research runs", function () {
    const result = getDiscoveryCardProjection(
      events(
        request,
        {
          type: "confirmation_resolved",
          requestId: "first",
          approved: true,
          actionId: "find_more",
          data: { selectedPaperIds: ["doi:two"] },
        },
        { type: "status", text: "Searching" },
      ),
    );
    assert.equal(result?.phase, "loading");
    const field = result!.pending.action.fields[0];
    if (field.type !== "paper_result_list") throw new Error("Missing rows");
    assert.deepEqual(
      field.rows.map((r) => r.checked),
      [false, true],
    );
  });
  it("makes retained results inert after cancellation or run completion", function () {
    const result = getDiscoveryCardProjection(
      events(
        request,
        {
          type: "confirmation_resolved",
          requestId: "first",
          approved: true,
          actionId: "find_more",
        },
        { type: "final", text: "Run stopped" },
      ),
    );
    assert.equal(result?.phase, "closed");
  });
});
