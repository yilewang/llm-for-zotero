import { assert } from "chai";
import {
  buildCodexRuntimeModelEntries,
  loadCodexAppServerModelCatalog,
} from "../src/codexAppServer/modelCatalog";

describe("Codex app-server model catalog", function () {
  it("loads all model/list pages and normalizes visible models for the menu", async function () {
    const calls: Array<{
      cursor?: string;
      includeHidden?: boolean;
      limit?: number;
    }> = [];

    const catalog = await loadCodexAppServerModelCatalog({
      codexPath: "/opt/codex/bin/codex",
      listModels: async (params) => {
        calls.push({
          cursor: params.cursor,
          includeHidden: params.includeHidden,
          limit: params.limit,
        });
        if (!params.cursor) {
          return {
            data: [
              {
                id: "model-fast",
                model: "gpt-5.5-fast",
                displayName: "GPT-5.5 Fast",
                description: "Fast Codex model",
                hidden: false,
                supportedReasoningEfforts: [
                  { reasoningEffort: "low", description: "Low" },
                  { reasoningEffort: "high", description: "High" },
                ],
                defaultReasoningEffort: "high",
                inputModalities: ["text", "image"],
              },
              {
                id: "model-hidden",
                model: "gpt-5.5-hidden",
                displayName: "Hidden",
                hidden: true,
              },
            ],
            nextCursor: "page-2",
          };
        }
        return {
          data: [
            {
              id: "model-thinking",
              model: "gpt-5.5-thinking",
              displayName: "",
              description: "Thinking Codex model",
              hidden: false,
              supportedReasoningEfforts: [
                { reasoningEffort: "medium", description: "Medium" },
              ],
              defaultReasoningEffort: "medium",
              inputModalities: ["text"],
            },
          ],
          nextCursor: null,
        };
      },
    });

    assert.deepEqual(calls, [
      { cursor: undefined, includeHidden: false, limit: 100 },
      { cursor: "page-2", includeHidden: false, limit: 100 },
    ]);
    assert.deepEqual(
      catalog.models.map((model) => ({
        model: model.model,
        displayName: model.displayName,
        hidden: model.hidden,
        efforts: model.supportedReasoningEfforts,
        defaultEffort: model.defaultReasoningEffort,
        inputModalities: model.inputModalities,
      })),
      [
        {
          model: "gpt-5.5-fast",
          displayName: "GPT-5.5 Fast",
          hidden: false,
          efforts: ["low", "high"],
          defaultEffort: "high",
          inputModalities: ["text", "image"],
        },
        {
          model: "gpt-5.5-thinking",
          displayName: "gpt-5.5-thinking",
          hidden: false,
          efforts: ["medium"],
          defaultEffort: "medium",
          inputModalities: ["text"],
        },
      ],
    );

    const entries = buildCodexRuntimeModelEntries({
      models: catalog.models,
      selectedModel: "gpt-5.5-fast",
      codexPath: "/opt/codex/bin/codex",
    });

    assert.deepEqual(
      entries.map((entry) => ({
        entryId: entry.entryId,
        model: entry.model,
        apiBase: entry.apiBase,
        providerLabel: entry.providerLabel,
        displayModelLabel: entry.displayModelLabel,
        authMode: entry.authMode,
        providerProtocol: entry.providerProtocol,
        advanced: entry.advanced,
      })),
      [
        {
          entryId: "codex_app_server::gpt-5.5-fast",
          model: "gpt-5.5-fast",
          apiBase: "/opt/codex/bin/codex",
          providerLabel: "Codex",
          displayModelLabel: "GPT-5.5 Fast",
          authMode: "codex_app_server",
          providerProtocol: "codex_responses",
          advanced: { temperature: 0.3, maxTokens: 4096 },
        },
        {
          entryId: "codex_app_server::gpt-5.5-thinking",
          model: "gpt-5.5-thinking",
          apiBase: "/opt/codex/bin/codex",
          providerLabel: "Codex",
          displayModelLabel: "gpt-5.5-thinking",
          authMode: "codex_app_server",
          providerProtocol: "codex_responses",
          advanced: { temperature: 0.3, maxTokens: 4096 },
        },
      ],
    );
  });

  it("keeps the currently selected Codex model as a fallback entry when it is not listed", function () {
    const entries = buildCodexRuntimeModelEntries({
      models: [
        {
          id: "model-fast",
          model: "gpt-5.5-fast",
          displayName: "GPT-5.5 Fast",
          hidden: false,
          description: "",
          supportedReasoningEfforts: [],
          inputModalities: [],
        },
      ],
      selectedModel: "gpt-5.5-custom",
      codexPath: "",
    });

    assert.deepEqual(
      entries.map((entry) => ({
        entryId: entry.entryId,
        model: entry.model,
        displayModelLabel: entry.displayModelLabel,
      })),
      [
        {
          entryId: "codex_app_server::gpt-5.5-custom",
          model: "gpt-5.5-custom",
          displayModelLabel: "gpt-5.5-custom",
        },
        {
          entryId: "codex_app_server::gpt-5.5-fast",
          model: "gpt-5.5-fast",
          displayModelLabel: "GPT-5.5 Fast",
        },
      ],
    );
  });
});
