import { assert } from "chai";
import {
  DEFAULT_COPILOT_API_BASE,
  transitionProviderAuthMode,
} from "../src/modules/preferences/providerAuthModeTransition";
import type {
  ModelProviderAuthMode,
  ModelProviderGroup,
} from "../src/utils/modelProviders";
import { createProviderCardModeSpec } from "../src/modules/preferences/providerCards/providerCardFactory";

const ALL_AUTH_MODES: Record<ModelProviderAuthMode, true> = {
  api_key: true,
  codex_app_server: true,
  codex_auth: true,
  copilot_auth: true,
  webchat: true,
};

function standardGroup(): ModelProviderGroup {
  return {
    id: "provider",
    apiBase: "https://api.example.test/v1",
    apiKey: "secret",
    authMode: "api_key",
    providerProtocol: "openai_chat_compat",
    presetIdOverride: "customized",
    models: [
      {
        id: "first-row",
        model: "first-model",
        temperature: 0.4,
        maxTokens: 2048,
        maxTokensExplicit: true,
        inputTokenCap: 32_000,
        inputMode: "text_only",
        providerProtocol: "responses_api",
        profileOverride: {
          limits: { contextWindowTokens: 64_000 },
          extraBody: { top_k: 40 },
        },
      },
      {
        id: "second-row",
        model: "second-model",
        temperature: 0.5,
        maxTokens: 4096,
      },
    ],
  };
}

describe("provider auth-mode transitions", function () {
  it("dispatches every auth mode through the exhaustive card factory", function () {
    assert.deepEqual(
      (Object.keys(ALL_AUTH_MODES) as ModelProviderAuthMode[]).map(
        (authMode) => createProviderCardModeSpec(authMode).kind,
      ),
      ["api_key", "codex_app_server", "codex_direct", "copilot", "webchat"],
    );
  });

  it("covers every auth mode through one pure transition boundary", function () {
    const authModes = Object.keys(ALL_AUTH_MODES) as ModelProviderAuthMode[];
    let matrixCases = 0;
    for (const sourceMode of authModes) {
      const source = transitionProviderAuthMode(standardGroup(), sourceMode);
      for (const targetMode of authModes) {
        const next = transitionProviderAuthMode(source, targetMode);
        matrixCases += 1;
        assert.equal(next.authMode, targetMode);
        assert.equal(next.id, source.id);
        assert.equal(next.models[0].id, source.models[0].id);

        const sourceIsConfigurable =
          sourceMode === "api_key" ||
          sourceMode === "codex_app_server" ||
          sourceMode === "copilot_auth";
        const targetIsConfigurable =
          targetMode === "api_key" ||
          targetMode === "codex_app_server" ||
          targetMode === "copilot_auth";
        if (sourceIsConfigurable && targetIsConfigurable) {
          assert.deepEqual(next.models[0], source.models[0]);
        } else if (targetIsConfigurable) {
          assert.containsAllKeys(next.models[0], [
            "id",
            "model",
            "temperature",
            "maxTokens",
          ]);
        } else {
          assert.deepEqual(Object.keys(next.models[0]).sort(), ["id", "model"]);
        }
        if (targetMode === "webchat") {
          assert.notProperty(next, "apiBase");
          assert.notProperty(next, "apiKey");
          assert.notProperty(next, "presetIdOverride");
        }
      }
    }
    assert.equal(matrixCases, 25);
  });

  it("preserves every advanced row field between configurable modes", function () {
    const configurableModes = [
      "api_key",
      "codex_app_server",
      "copilot_auth",
    ] as const;
    for (const sourceMode of configurableModes) {
      const source = transitionProviderAuthMode(standardGroup(), sourceMode);
      for (const targetMode of configurableModes) {
        const next = transitionProviderAuthMode(source, targetMode);
        assert.equal(next.authMode, targetMode);
        if (next.authMode === "codex_auth" || next.authMode === "webchat") {
          assert.fail("expected configurable provider");
        }
        assert.deepEqual(next.models[0], source.models[0]);
      }
    }
  });

  it("enters Direct with fixed credentials while preserving row IDs", function () {
    const next = transitionProviderAuthMode(standardGroup(), "codex_auth");

    assert.equal(next.authMode, "codex_auth");
    assert.equal(
      next.apiBase,
      "https://chatgpt.com/backend-api/codex/responses",
    );
    assert.equal(next.apiKey, "");
    assert.equal(next.providerProtocol, "codex_responses");
    assert.deepEqual(
      next.models.map((row) => ({ id: row.id, model: row.model })),
      [
        { id: "first-row", model: "first-model" },
        { id: "second-row", model: "second-model" },
      ],
    );
  });

  it("leaves Direct without changing the selected row identity", function () {
    const direct = transitionProviderAuthMode(standardGroup(), "codex_auth");
    const next = transitionProviderAuthMode(direct, "api_key");

    assert.equal(next.authMode, "api_key");
    assert.equal(next.models[0].id, "first-row");
    assert.equal(next.models[0].model, "first-model");
    assert.equal(next.apiBase, "");
    assert.equal(next.apiKey, "");
    assert.equal(next.providerProtocol, "openai_chat_compat");
  });

  it("normalizes WebChat and Copilot mode-specific defaults", function () {
    const webchat = transitionProviderAuthMode(standardGroup(), "webchat");
    assert.equal(webchat.authMode, "webchat");
    assert.equal(webchat.providerProtocol, "web_sync");
    assert.deepEqual(
      webchat.models.map((row) => ({ id: row.id, model: row.model })),
      [{ id: "first-row", model: "chatgpt.com" }],
    );
    assert.deepEqual(Object.keys(webchat.models[0]).sort(), ["id", "model"]);
    assert.notProperty(webchat, "apiBase");
    assert.notProperty(webchat, "apiKey");

    const blank = standardGroup();
    blank.apiBase = "";
    const copilot = transitionProviderAuthMode(blank, "copilot_auth");
    assert.equal(copilot.authMode, "copilot_auth");
    assert.equal(copilot.apiBase, DEFAULT_COPILOT_API_BASE);
    assert.equal(copilot.providerProtocol, "openai_chat_compat");
  });

  it("creates configurable defaults when leaving target-only modes", function () {
    const webchat = transitionProviderAuthMode(standardGroup(), "webchat");
    const fromWebChat = transitionProviderAuthMode(webchat, "api_key");
    const direct = transitionProviderAuthMode(standardGroup(), "codex_auth");
    const fromDirect = transitionProviderAuthMode(direct, "api_key");

    for (const next of [fromWebChat, fromDirect]) {
      assert.equal(next.authMode, "api_key");
      if (next.authMode !== "api_key") assert.fail("expected API provider");
      assert.equal(next.models[0].temperature, 0.3);
      assert.equal(next.models[0].maxTokens, 4096);
      assert.isUndefined(next.models[0].inputTokenCap);
      assert.isUndefined(next.models[0].profileOverride);
    }
  });

  it("drops a Codex CLI path when returning to an API mode", function () {
    const appServer = transitionProviderAuthMode(
      standardGroup(),
      "codex_app_server",
    );
    appServer.apiBase = "/opt/codex";

    const next = transitionProviderAuthMode(appServer, "api_key");

    assert.equal(next.apiBase, "");
    assert.equal(next.providerProtocol, "openai_chat_compat");
  });
});
