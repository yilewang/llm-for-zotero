import { assert } from "chai";
import { parseAntigravityQuota } from "../src/antigravity/quota";
import { buildQuotaPresentation } from "../src/modules/contextPanel/footerQuotaControl";

// Shape of `agy -p /usage --output-format json`, agy 1.4.2 (2026-10-18).
const usage = {
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          description: "Gemini quota",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly",
              window: "weekly",
              remaining_fraction: 0.97,
              reset_time: "2026-10-22T00:00:00Z",
            },
            {
              id: "gemini-5h",
              name: "5 hours",
              window: "5h",
              remaining_fraction: 0.99,
              reset_time: "2026-10-18T18:00:00Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            { id: "3p-weekly", window: "weekly", remaining_fraction: 0.4 },
            { id: "3p-5h", window: "5h", remaining_fraction: 1 },
          ],
        },
      ],
    },
  },
};

describe("Antigravity quota", function () {
  it("turns every /usage bucket into a window and marks the other group secondary", function () {
    const quota = parseAntigravityQuota(
      JSON.stringify(usage, null, 2),
      "gemini-4-argon-high",
    );
    assert.equal(quota?.kind, "usage");
    if (quota?.kind !== "usage") return;
    assert.equal(quota.provider, "antigravity");
    assert.lengthOf(quota.windows, 4);
    const [weekly, fiveHours, thirdWeekly] = quota.windows;
    assert.closeTo(weekly.usedPercent, 3, 1e-9);
    assert.equal(weekly.period, "weekly");
    assert.equal(weekly.label, "Gemini Models");
    assert.equal(weekly.resetsAt, Date.parse("2026-10-22T00:00:00Z") / 1000);
    assert.equal(fiveHours.durationMins, 300);
    assert.isUndefined(weekly.secondary);
    assert.isTrue(thirdWeekly.secondary);

    const view = buildQuotaPresentation({ checkedAt: 1000, quota })!;
    assert.equal(
      view.text,
      "3% used",
      "the Claude/GPT 60% is not the headline",
    );
    assert.include(view.title, "Antigravity quota");
    assert.include(view.title, "Gemini Models · Weekly: 3% used");
    assert.include(view.title, "Claude and GPT models · 5h: 0% used");
    assert.include(view.title, "Claude and GPT models · Weekly: 60% used");
  });

  it("uses the Claude/GPT group for those models and every group for the default", function () {
    const claude = parseAntigravityQuota(
      JSON.stringify(usage),
      "claude-sonnet-5-5",
    );
    assert.equal(
      buildQuotaPresentation({ checkedAt: 1, quota: claude })?.text,
      "60% used",
    );
    const fallback = parseAntigravityQuota(JSON.stringify(usage), "default");
    if (fallback?.kind !== "usage") throw new Error("no quota");
    assert.isTrue(fallback.windows.every((window) => !window.secondary));
  });

  it("reads the stream-json form and rejects output without usage data", function () {
    const stream = [
      JSON.stringify({ event: "command_result", ...usage }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS" } }),
    ].join("\n");
    const quota = parseAntigravityQuota(stream, "gemini-3.8-flash-low");
    assert.equal(quota?.kind === "usage" && quota.windows.length, 4);
    assert.isNull(parseAntigravityQuota("not json", "gemini"));
    assert.isNull(
      parseAntigravityQuota(JSON.stringify({ command: { data: {} } }), ""),
    );
  });
});
