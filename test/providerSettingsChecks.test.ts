import { assert } from "chai";
import { runProviderSettingsChecks } from "../src/utils/providerConnectionTest";

type CapturedRequest = { url: string; body: Record<string, unknown> };

/**
 * A fake Ollama-ish server: records every request body and answers each call
 * from a scripted queue (a Response, or a function of the parsed body).
 */
function makeFetchStub(
  respond: (body: Record<string, unknown>, index: number) => Response,
): { fetchFn: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}")) as Record<
      string,
      unknown
    >;
    requests.push({ url: String(url), body });
    return respond(body, requests.length - 1);
  }) as unknown as typeof fetch;
  return { fetchFn, requests };
}

function ok(): Response {
  return new Response(JSON.stringify({ message: { content: "OK" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function badRequest(error: string): Response {
  return new Response(JSON.stringify({ error }), { status: 400 });
}

const BASE = {
  protocol: "ollama_native" as const,
  authMode: "api_key" as const,
  apiBase: "http://localhost:11434",
  apiKey: "",
  modelName: "qwen3:8b",
};

const OVERRIDE = {
  forModel: "qwen3:8b",
  reasoning: {
    kind: "select" as const,
    options: [
      {
        id: "ultra",
        label: "ultra",
        enabled: true,
        controls: { body: { think: "ultra" } },
      },
      {
        id: "off",
        label: "off",
        enabled: true,
        controls: { body: { think: false } },
      },
    ],
  },
  extraBody: { options: { repeat_penalty: 1.1 } },
};

describe("provider settings checks", function () {
  it("returns nothing (and sends nothing) without a customization", async function () {
    const { fetchFn, requests } = makeFetchStub(() => ok());
    const checks = await runProviderSettingsChecks({
      fetchFn,
      ...BASE,
      profileOverride: undefined,
    });
    assert.deepEqual(checks, []);
    assert.lengthOf(requests, 0);
  });

  it("a dormant override (renamed model) is not tested", async function () {
    const { fetchFn, requests } = makeFetchStub(() => ok());
    const checks = await runProviderSettingsChecks({
      fetchFn,
      ...BASE,
      modelName: "gemma3:4b",
      profileOverride: OVERRIDE,
    });
    assert.deepEqual(checks, []);
    assert.lengthOf(requests, 0);
  });

  it("probes the extra JSON first, then each level with it merged in", async function () {
    const { fetchFn, requests } = makeFetchStub((body) =>
      body.think === "ultra"
        ? badRequest('"qwen3:8b" does not support ultra')
        : ok(),
    );
    const checks = await runProviderSettingsChecks({
      fetchFn,
      ...BASE,
      profileOverride: OVERRIDE,
    });

    assert.deepEqual(
      checks.map((check) => [check.kind, check.id, check.ok]),
      [
        ["extra", undefined, true],
        ["level", "ultra", false],
        ["level", "off", true],
      ],
    );
    assert.match(checks[1].error || "", /does not support ultra/);

    // The level probe carries the real request shape: the level body replaces
    // the base think, and user options merge with the probe's own num_predict
    // rather than replacing it.
    const ultraProbe = requests[1].body;
    assert.equal(ultraProbe.think, "ultra");
    assert.deepEqual(ultraProbe.options, {
      num_predict: 16,
      repeat_penalty: 1.1,
    });
    const offProbe = requests[2].body;
    assert.strictEqual(offProbe.think, false);
  });

  it("keeps attribution clean: failed extra JSON is left out of level probes", async function () {
    const { fetchFn, requests } = makeFetchStub((body) => {
      const options = body.options as Record<string, unknown>;
      return options?.repeat_penalty !== undefined
        ? badRequest("unknown option repeat_penalty")
        : ok();
    });
    const checks = await runProviderSettingsChecks({
      fetchFn,
      ...BASE,
      profileOverride: OVERRIDE,
    });
    assert.deepEqual(
      checks.map((check) => [check.kind, check.ok]),
      [
        ["extra", false],
        ["level", true],
        ["level", true],
      ],
      "levels must not inherit the failure of the extra parameters",
    );
    assert.isUndefined(
      (requests[1].body.options as Record<string, unknown>)?.repeat_penalty,
      "level probes exclude the extra JSON once it failed",
    );
  });

  it("treats a 200 body carrying an error field as a failure", async function () {
    const { fetchFn } = makeFetchStub((body, index) =>
      index === 0
        ? ok()
        : new Response(JSON.stringify({ error: "model reloading" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
    );
    const checks = await runProviderSettingsChecks({
      fetchFn,
      ...BASE,
      profileOverride: OVERRIDE,
    });
    const firstLevel = checks.find((check) => check.kind === "level");
    assert.isFalse(firstLevel?.ok);
    assert.match(firstLevel?.error || "", /model reloading/);
  });

  it("probes a Gemini level where Gemini actually reads it", async function () {
    const { fetchFn, requests } = makeFetchStub(() => ok());
    await runProviderSettingsChecks({
      fetchFn,
      protocol: "gemini_native",
      authMode: "api_key",
      apiBase: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "gemini-test",
      modelName: "gemini-3-pro",
      profileOverride: {
        forModel: "gemini-3-pro",
        reasoning: {
          kind: "select",
          options: [
            {
              id: "ultra",
              label: "ultra",
              enabled: true,
              controls: {
                body: { thinkingConfig: { thinkingLevel: "ultra" } },
              },
            },
          ],
        },
        extraBody: { safetySettings: [] },
      },
    });

    // The probe has to send the shape the plugin sends. A top-level
    // thinkingConfig is not a field of generateContent, so testing it there
    // reports a level that works as broken.
    const levelRequest = requests[requests.length - 1];
    const generationConfig = levelRequest.body.generationConfig as Record<
      string,
      unknown
    >;
    assert.deepEqual(generationConfig?.thinkingConfig, {
      thinkingLevel: "ultra",
    });
    assert.isUndefined(levelRequest.body.thinkingConfig);
    // The open JSON field addresses the request as a whole, so it stays where
    // the user put it.
    assert.deepEqual(levelRequest.body.safetySettings, []);
  });
});
