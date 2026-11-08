import { assert } from "chai";
import {
  parseApiQuota,
  readApiQuota,
  resolveQuotaTarget,
} from "../src/providers/quota";
import { buildQuotaPresentation } from "../src/modules/contextPanel/footerQuotaControl";

const entry = { authMode: "api_key", apiKey: "fixture-only" };
const resetsAt = "2026-10-01T00:00:00.000Z";
const window = (percent: unknown, status = "ok") => ({
  percent,
  status,
  resetsAt,
});

describe("OpenCode Go quota", function () {
  it("only selects Go inference routes on the official origin", function () {
    for (const path of [
      "/zen/go/v1",
      "/zen/go/v1/",
      "/zen/go/v1/chat/completions",
      "/zen/go/v1/responses",
      "/zen/go/v1/messages",
      "/inference/go/v1",
      "/inference/go/anthropic/v1/messages",
    ])
      assert.deepEqual(
        resolveQuotaTarget({ ...entry, apiBase: `https://opencode.ai${path}` }),
        { kind: "opencode_go", apiKey: entry.apiKey },
      );
    for (const apiBase of [
      "https://opencode.ai/zen/v1",
      "https://opencode.ai/inference/v1",
      "https://opencode.ai/zen/v1/messages",
      "https://opencode.ai/zen/go",
      "https://opencode.ai/zen/go/v10",
      "https://opencode.ai/zen/go/v1/other",
      "https://opencode.ai/workspace",
      "https://opencode.ai.proxy.example/zen/go/v1",
      "https://user@opencode.ai/zen/go/v1",
      "https://opencode.ai:8443/zen/go/v1",
      "http://opencode.ai/zen/go/v1",
    ])
      assert.isNull(resolveQuotaTarget({ ...entry, apiBase }));
  });

  it("displays the most-used window and names all three periods without guessing their durations", function () {
    const quota = parseApiQuota("opencode_go", {
      usage: {
        rolling: window(12),
        weekly: window(75),
        monthly: window(40),
      },
    });
    assert.deepEqual(quota, {
      kind: "usage",
      provider: "opencode",
      windows: [
        {
          period: "rolling",
          usedPercent: 12,
          resetsAt: Date.parse(resetsAt) / 1000,
        },
        {
          period: "weekly",
          usedPercent: 75,
          resetsAt: Date.parse(resetsAt) / 1000,
        },
        {
          period: "monthly",
          usedPercent: 40,
          resetsAt: Date.parse(resetsAt) / 1000,
        },
      ],
    });
    const presentation = buildQuotaPresentation({ quota, checkedAt: 1000 })!;
    assert.equal(presentation.text, "75% used");
    for (const detail of [
      "OpenCode Go quota",
      "Rolling window: 12% used",
      "Weekly: 75% used",
      "Monthly: 40% used",
      new Date(resetsAt).toLocaleString(),
    ])
      assert.include(presentation.title, detail);
    assert.notInclude(presentation.title, "30d");
  });

  it("preserves an unused or exhausted allowance", function () {
    for (const [percent, status] of [
      [0, "ok"],
      [100, "rate-limited"],
    ] as const) {
      const quota = parseApiQuota("opencode_go", {
        usage: { rolling: window(percent, status) },
      });
      assert.equal(
        buildQuotaPresentation({ quota, checkedAt: 1000 })?.text,
        `${percent}% used`,
      );
    }
  });

  it("keeps valid windows when other windows or reset dates are unavailable", function () {
    assert.deepEqual(
      parseApiQuota("opencode_go", {
        usage: {
          rolling: window(null),
          weekly: { percent: 25, status: "ok", resetsAt: "invalid" },
          monthly: { percent: 50, status: "ok" },
        },
      }),
      {
        kind: "usage",
        provider: "opencode",
        windows: [
          { period: "weekly", usedPercent: 25 },
          { period: "monthly", usedPercent: 50 },
        ],
      },
    );
  });

  it("hides missing, malformed, or failed allowance data instead of reporting zero", function () {
    for (const percent of [
      undefined,
      null,
      false,
      "",
      "NaN",
      NaN,
      Infinity,
      -1,
      101,
    ])
      assert.isNull(
        parseApiQuota("opencode_go", { usage: { rolling: window(percent) } }),
      );
    for (const payload of [
      null,
      {},
      { usage: {} },
      { error: { type: "EntitlementError" } },
      { usage: { rolling: { percent: 50 } } },
      { usage: { rolling: window(50, "unavailable") } },
    ])
      assert.isNull(parseApiQuota("opencode_go", payload));
  });

  it("reads with the existing API key and hides an account without a Go subscription", async function () {
    const original = globalThis.fetch;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let entitled = true;
    try {
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return {
          ok: entitled,
          status: entitled ? 200 : 403,
          json: async () => ({ usage: { rolling: window(35) } }),
        };
      }) as typeof fetch;
      const target = { kind: "opencode_go", apiKey: entry.apiKey } as const;
      const quota = await readApiQuota(target);
      assert.equal(
        buildQuotaPresentation({ quota, checkedAt: 1000 })?.text,
        "35% used",
      );
      entitled = false;
      assert.isNull(await readApiQuota(target));
      assert.lengthOf(requests, 2);
      for (const request of requests) {
        assert.equal(request.url, "https://opencode.ai/zen/go/v1/usage");
        assert.equal(
          (request.init?.headers as Record<string, string>).Authorization,
          "Bearer fixture-only",
        );
        assert.equal(request.init?.redirect, "error");
        assert.equal(request.init?.credentials, "omit");
      }
    } finally {
      globalThis.fetch = original;
    }
  });
});
