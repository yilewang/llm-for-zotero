import { assert } from "chai";
import {
  ActionContractService,
  type ActionContractGateway,
} from "../src/agent/contracts/actionContract";
import {
  inferActionIntentsFromRequest,
  parseClassifiedTurnIntent,
} from "../src/agent/model/skillClassifier";
import type { AgentRuntimeRequestInput } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

function request(
  input: Partial<AgentRuntimeRequestInput>,
): ReturnType<typeof resolvedAgentRequest> {
  return resolvedAgentRequest({
    conversationKey: 1,
    mode: "agent",
    libraryID: 1,
    userText: "",
    ...input,
  });
}

describe("Agent action intent", function () {
  it("fails closed when required intent has no valid obligations", async function () {
    const service = new ActionContractService({} as ActionContractGateway);
    let message = "";
    try {
      await service.createContract(
        request({
          conversationKey: 1,
          mode: "agent",
          model: "test",
          userText: "Apply the requested mutation.",
          classifiedIntent: {
            retrievalIntent: "none",
            wantedSections: [],
            writeDisposition: "required",
            actionInterpretationSource: "classifier",
            actionIntents: [],
          },
        }),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.include(message, "no valid typed obligations");
  });

  it("does not infer writes from questions, advice, hypotheticals, or negation", function () {
    const prompts = [
      "Which papers should I tag as reviewed?",
      "If I add the tag reviewed, which papers would be candidates?",
      "Please do not add or remove any tags; only explain the options.",
      "How could I tag these papers later?",
    ];
    for (const userText of prompts) {
      assert.deepEqual(
        inferActionIntentsFromRequest(request({ userText })),
        [],
      );
    }
  });

  it("uses a successful classifier as the exact authoritative operation", function () {
    const parsed = parseClassifiedTurnIntent(
      JSON.stringify({
        retrievalIntent: "none",
        wantedSections: [],
        writeDisposition: "required",
        actionIntents: [
          {
            operation: "remove_tags",
            coverage: "all",
            targetKind: "papers",
            parameters: { tags: ["reviewed"] },
          },
        ],
      }),
    );
    assert.equal(parsed?.writeDisposition, "required");
    assert.deepEqual(
      parsed?.actionIntents.map((intent) => intent.operation),
      ["remove_tags"],
    );
  });

  it("infers only high-confidence imperative operations on classifier failure", function () {
    const add = inferActionIntentsFromRequest(
      request({
        userText: 'Add the tag "topic:drift" to every paper.',
      }),
    );
    assert.equal(add[0]?.operation, "apply_tags");
    assert.deepEqual(add[0]?.parameters?.tags, ["topic:drift"]);

    const create = inferActionIntentsFromRequest(
      request({
        userText: 'Create collection "Methods".',
      }),
    );
    assert.equal(create[0]?.operation, "create_collection");
    assert.equal(create[0]?.parameters?.collectionName, "Methods");

    const mixed = inferActionIntentsFromRequest(
      request({
        userText:
          'Create a standalone Zotero note and independently export a Markdown file at "/tmp/acv2-vault/ACV2 Mixed.md".',
      }),
    );
    assert.deepEqual(
      mixed.map((intent) => intent.operation),
      ["note_create", "file_write"],
    );
    assert.equal(
      mixed.find((intent) => intent.operation === "file_write")?.parameters
        ?.filePath,
      "/tmp/acv2-vault/ACV2 Mixed.md",
    );
  });
});
