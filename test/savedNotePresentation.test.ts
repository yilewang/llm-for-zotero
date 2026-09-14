import { assert } from "chai";
import { savedNoteIsPrimaryOutcome } from "../src/modules/contextPanel/agentTrace/savedNoteCard";
import { actionContractFixture } from "./helpers/semanticIntent";
import type { AgentEvent } from "../src/agent/types";

describe("saved note primary outcome", function () {
  it("uses the frozen deliverable to preserve separate documents and plans", function () {
    const contract = actionContractFixture("note_create");
    const events = [
      {
        type: "provider_event",
        providerType: "agent_action_contract",
        payload: { contract },
      },
    ] as AgentEvent[];
    assert.isTrue(savedNoteIsPrimaryOutcome(events, false));
    assert.isFalse(savedNoteIsPrimaryOutcome(events, true));
    contract.intent!.deliverableIntent = "document";
    assert.isFalse(savedNoteIsPrimaryOutcome(events, false));
    assert.isFalse(savedNoteIsPrimaryOutcome([], false));
  });
});
