import { assert } from "chai";
import { buildZoteroEnvironmentManifest } from "../src/codexAppServer/nativeClient";
import { actionContractFixture } from "./helpers/semanticIntent";

describe("native semantic contract presentation", function () {
  it("carries the resolved filing parameters instead of asking the executor to reinterpret move", function () {
    const contract = actionContractFixture("move_to_collection", {
      destinationCollectionId: 5,
    });
    contract.obligations[0].targetSelectors = [
      { kind: "item_id", value: 3977 },
    ];
    const text = buildZoteroEnvironmentManifest({
      scope: {
        kind: "paper",
        libraryID: 1,
        conversationKey: 1,
        activeItemId: 3977,
      } as any,
      mcpEnabled: true,
      mcpReady: true,
      actionContract: contract,
    } as any);
    assert.include(text, '"destinationCollectionId":5');
    assert.include(text, '"value":3977');
    assert.include(text, "absence of sourceCollectionId means add-only filing");
    assert.include(text, contract.intent!.semantic!.id);
  });
});

describe("semantic integration", function () {
  it("shows unresolved preparation issues instead of inventing a read-only permission mode", function () {
    const text = buildZoteroEnvironmentManifest({
      scope: { kind: "paper", libraryID: 1, conversationKey: 1 } as any,
      mcpEnabled: true,
      mcpReady: true,
      actionPreparation: {
        state: "needs_input",
        issues: ["Two collections share this name"],
      },
    } as any);
    assert.include(text, "Two collections share this name");
    assert.include(text, "request_user_input");
  });
});
