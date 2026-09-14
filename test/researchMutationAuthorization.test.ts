import { assert } from "chai";
import { researchMutationAuthorization } from "../src/agent/research/mutationAuthorization";
import type { AgentActionIntent } from "../src/agent/contracts/types";
import type { AgentToolContext } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import { classifiedFixture } from "./helpers/semanticIntent";

function contextFor(): AgentToolContext {
  return {
    request: resolvedAgentRequest({
      conversationKey: 1,
      mode: "agent",
      userText: "tag the drift papers after research",
      classifiedIntent: classifiedFixture(),
      libraryID: 1,
    }),
    item: null,
    currentAnswerText: "",
    modelName: "test",
  } as unknown as AgentToolContext;
}

function intent(
  reviewPreference?: AgentActionIntent["reviewPreference"],
): AgentActionIntent {
  return {
    capability: "zotero.tags",
    operation: "apply_tags",
    proofDomain: "zotero_state",
    coverage: "all",
    targetKind: "papers",
    parameters: { tags: ["drift"] },
    ...(reviewPreference ? { reviewPreference } : {}),
  };
}

const operations = [
  {
    operation: "apply_tags",
    capability: "zotero.tags",
    parameters: { tags: ["drift"] },
    targets: [{ libraryID: 1, itemKey: "ABCD1234" }],
  },
];

describe("research mutation authorization", function () {
  const originalZotero = globalThis.Zotero;
  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  function withMode(mode: "safe" | "auto" | "yolo") {
    globalThis.Zotero = {
      Prefs: {
        get: (key: string) =>
          key.endsWith("originalAgentPermissionMode") ? mode : undefined,
      },
    } as never;
  }

  it("executes without review in auto and yolo when no preference was stated", function () {
    for (const [mode, authority] of [
      ["auto", "auto_policy"],
      ["yolo", "yolo"],
    ] as const) {
      withMode(mode);
      assert.deepEqual(
        researchMutationAuthorization({
          context: contextFor(),
          intents: [intent()],
          operations,
        }),
        { kind: "execute", authority },
      );
    }
  });

  it("still reviews in safe mode and whenever the intent asks for review", function () {
    withMode("safe");
    assert.equal(
      researchMutationAuthorization({
        context: contextFor(),
        intents: [intent()],
        operations,
      }).kind,
      "confirm",
    );
    for (const mode of ["auto", "yolo"] as const) {
      withMode(mode);
      assert.equal(
        researchMutationAuthorization({
          context: contextFor(),
          intents: [intent("review")],
          operations,
        }).kind,
        "confirm",
      );
    }
  });
});
