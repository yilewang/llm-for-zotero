import { assert } from "chai";
import { triageCandidatesWithModel } from "../src/agent/services/libraryRetrieveTriage";

describe("libraryRetrieveTriage", function () {
  it("returns null without model config or candidates", async function () {
    const noConfig = await triageCandidatesWithModel({
      query: "stimulation protocols",
      intent: "enumerate",
      candidates: [
        { itemId: "1", title: "Paper", abstract: "", matchedVia: "" },
      ],
      maxSelect: 5,
    });
    assert.isNull(noConfig);

    const noCandidates = await triageCandidatesWithModel({
      query: "stimulation protocols",
      intent: "enumerate",
      candidates: [],
      maxSelect: 5,
      apiBase: "https://example.invalid",
      apiKey: "key",
    });
    assert.isNull(noCandidates);
  });

  it("passes profile settings through a bounded utility call", async function () {
    let captured: Record<string, unknown> = {};
    const result = await triageCandidatesWithModel({
      query: "stimulation protocols",
      intent: "enumerate",
      candidates: [
        {
          itemId: "1",
          title: "Paper",
          abstract: "Abstract",
          matchedVia: "fts",
        },
      ],
      maxSelect: 1,
      model: "gpt-5.4",
      apiBase: "https://api.openai.com/v1",
      apiKey: "key",
      providerProtocol: "openai_chat_compat",
      profileOverride: { forModel: "gpt-5.4" },
      llmCall: async (params) => {
        captured = params as unknown as Record<string, unknown>;
        return '{"selectedItemIds":["1"]}';
      },
    });

    assert.deepEqual(result?.selectedItemIds, ["1"]);
    assert.deepEqual(captured.reasoning, {
      provider: "openai",
      level: "low",
    });
    assert.equal(captured.maxTokens, 1_424);
  });
});
