import { assert } from "chai";
import {
  buildCodexRuntimeModelEntries,
  getCodexAppServerReasoningChoices,
  loadCodexAppServerModelCatalog,
  reconcileCodexAppServerReasoningMode,
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
      })),
      [
        {
          model: "gpt-5.5-fast",
          displayName: "GPT-5.5 Fast",
          hidden: false,
          efforts: ["low", "high"],
          defaultEffort: "high",
        },
        {
          model: "gpt-5.5-thinking",
          displayName: "gpt-5.5-thinking",
          hidden: false,
          efforts: ["medium"],
          defaultEffort: "medium",
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

  it("uses the selected catalog model's advertised reasoning efforts", function () {
    const choices = getCodexAppServerReasoningChoices({
      models: [
        {
          id: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6-Sol",
          description: "",
          hidden: false,
          supportedReasoningEfforts: [
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra",
            "ULTRA",
          ],
          defaultReasoningEffort: "low",
        },
      ],
      selectedModel: "GPT-5.6-SOL",
    });

    assert.deepEqual(choices, [
      { value: "auto", label: "Auto" },
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "XHigh" },
      { value: "max", label: "Max" },
      { value: "ultra", label: "Ultra" },
    ]);
  });

  it("falls back to legacy reasoning efforts when the model is not cataloged", function () {
    assert.deepEqual(
      getCodexAppServerReasoningChoices({
        models: [],
        selectedModel: "gpt-custom",
      }),
      [
        { value: "auto", label: "Auto" },
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "XHigh" },
      ],
    );
  });

  it("preserves future wire values and reconciles stale selections", function () {
    const solChoices = getCodexAppServerReasoningChoices({
      models: [
        {
          id: "future",
          model: "future",
          displayName: "Future",
          description: "",
          hidden: false,
          supportedReasoningEfforts: ["very-high", "ultra"],
        },
      ],
      selectedModel: "future",
    });
    const lunaChoices = getCodexAppServerReasoningChoices({
      models: [
        {
          id: "luna",
          model: "luna",
          displayName: "Luna",
          description: "",
          hidden: false,
          supportedReasoningEfforts: ["max"],
        },
      ],
      selectedModel: "luna",
    });

    assert.deepEqual(solChoices[1], {
      value: "very-high",
      label: "Very High",
    });
    assert.equal(
      reconcileCodexAppServerReasoningMode("ULTRA", solChoices),
      "ultra",
    );
    assert.equal(
      reconcileCodexAppServerReasoningMode("ultra", lunaChoices),
      "auto",
    );
    assert.equal(reconcileCodexAppServerReasoningMode("", solChoices), "auto");
  });
});
