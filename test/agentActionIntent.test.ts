import { assert } from "chai";
import {
  detectTurnIntent,
  parseClassifiedTurnIntent,
} from "../src/agent/model/semanticIntentService";
import { semanticResponseFixture } from "./helpers/semanticIntent";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

const request = (userText: string) =>
  resolvedAgentRequest({
    conversationKey: 1,
    mode: "agent",
    libraryID: 1,
    userText,
    model: "test",
    apiBase: "https://example.invalid",
    apiKey: "test",
  });

describe("semantic action interpretation", function () {
  it("rejects missing routing decisions and invalid section coverage instead of inventing defaults", function () {
    for (const field of [
      "paperTargetIntent",
      "externalSearchIntent",
      "deliverableIntent",
      "wantedSections",
    ]) {
      const output = semanticResponseFixture();
      delete output[field];
      assert.isNull(parseClassifiedTurnIntent(JSON.stringify(output)), field);
    }
    assert.isNull(
      parseClassifiedTurnIntent(
        JSON.stringify(
          semanticResponseFixture({ wantedSections: ["unknown"] }),
        ),
      ),
    );
  });
  it("does not manufacture fallback authority from imperative or multilingual wording", async function () {
    for (const text of [
      'Add the tag "reviewed".',
      "请创建一条 Zotero 笔记。",
      "Zoteroノートを作成してください。",
      "Crea una nota de Zotero.",
    ]) {
      let calls = 0;
      const result = await detectTurnIntent(request(text), [], {
        llmCall: async () => {
          calls++;
          return { text: "malformed", completion: { status: "complete" } };
        },
      });
      assert.isNull(result.classifiedIntent);
      assert.isTrue(result.degraded);
      assert.equal(calls, 2);
    }
  });
  for (const operation of ["apply_tags", "remove_tags", "set_item_tags"]) {
    it(`retains the exact semantic ${operation} decision without a wording veto`, async function () {
      const output = semanticResponseFixture({
        writeDisposition: "required",
        actionIntents: [
          {
            operation,
            coverage: "some",
            targetKind: "papers",
            parameters: { tags: ["reviewed"] },
            targetSelectors: [{ kind: "item_key", value: "WTI4KW3E" }],
          },
        ],
      });
      for (const text of [
        'Replace their tags with "reviewed".',
        "Remove reviewed, preserving everything else.",
        "请按照刚才的要求整理标签。",
      ]) {
        const result = await detectTurnIntent(request(text), [], {
          llmCall: async () => ({
            text: JSON.stringify(output),
            completion: { status: "complete" },
          }),
        });
        assert.deepEqual(
          result.classifiedIntent?.actionIntents.map(
            (action) => action.operation,
          ),
          [operation],
        );
      }
    });
  }
  for (const params of [
    { tags: ["reviewed", 7] },
    { destinationCollectionId: "not-an-id" },
    { unknownAuthority: true },
  ]) {
    it(`rejects malformed action parameters instead of silently dropping them: ${JSON.stringify(params)}`, function () {
      const output = semanticResponseFixture({
        writeDisposition: "required",
        actionIntents: [
          {
            operation: "apply_tags",
            coverage: "one",
            targetKind: "papers",
            parameters: params,
          },
        ],
      });
      assert.isNull(parseClassifiedTurnIntent(JSON.stringify(output)));
    });
  }
  for (const constraints of [
    { collectionMode: "replace" },
    { readMode: "partial" },
    { tagPrefix: 7 },
    { preserveOtherTags: true },
  ]) {
    it(`rejects unsupported action constraints ${JSON.stringify(constraints)}`, function () {
      assert.isNull(
        parseClassifiedTurnIntent(
          JSON.stringify(
            semanticResponseFixture({
              writeDisposition: "required",
              actionIntents: [
                {
                  operation: "apply_tags",
                  coverage: "one",
                  targetKind: "items",
                  constraints,
                },
              ],
            }),
          ),
        ),
      );
    });
  }
  it("keeps a document request whose required write has no library action, as no write", function () {
    const parsed = parseClassifiedTurnIntent(
      JSON.stringify(
        semanticResponseFixture({
          deliverableIntent: "document",
          documentKind: "literature_review",
          writeDisposition: "required",
          actionIntents: [],
        }),
      ),
    );
    assert.equal(parsed?.writeDisposition, "none");
    assert.deepEqual(parsed?.actionIntents, []);
    assert.isNull(
      parseClassifiedTurnIntent(
        JSON.stringify(
          semanticResponseFixture({
            deliverableIntent: "chat",
            writeDisposition: "required",
            actionIntents: [],
          }),
        ),
      ),
      "a chat answer that claims a required write still needs an action",
    );
  });

  it("rejects a no-write interpretation containing a mutation", function () {
    assert.isNull(
      parseClassifiedTurnIntent(
        JSON.stringify(
          semanticResponseFixture({
            actionIntents: [
              {
                operation: "note_create",
                coverage: "one",
                targetKind: "items",
              },
            ],
          }),
        ),
      ),
    );
  });
});
