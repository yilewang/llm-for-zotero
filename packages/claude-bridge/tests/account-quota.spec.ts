import { describe, expect, it, vi } from "vitest";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import {
  normalizeAccountQuota,
  probeAccountQuota,
} from "../src/providers/account-quota.js";
import { ClaudeAgentSdkRuntimeClient } from "../src/providers/claude-agent-sdk-runtime-client.js";
import { ClaudeCodeRuntimeAdapter } from "../src/bridge/claude-code-runtime-adapter.js";
import { Llm4ZoteroAgentBackendAdapter } from "../src/bridge/llm4zotero-agent-backend-adapter.js";
import { InMemorySessionMapper } from "../src/session-link/session-mapper.js";
import { startHttpBridgeServer } from "../src/server/http-bridge.js";

const usage = {
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 0, resets_at: "2026-09-29T12:00:00Z" },
    seven_day: { utilization: 42.5, resets_at: null },
  },
  session: { total_cost_usd: 10 },
  subscription_type: "max",
};
const quota = {
  windows: [
    {
      usedPercent: 0,
      durationMins: 300,
      resetsAt: Date.parse("2026-09-29T12:00:00Z") / 1000,
    },
    { usedPercent: 42.5, durationMins: 10080 },
  ],
};

describe("Claude account quota", () => {
  it("preserves percentages and zero while excluding session costs and unrelated limits", () => {
    expect(
      normalizeAccountQuota({
        ...usage,
        rate_limits: {
          ...usage.rate_limits,
          seven_day_opus: { utilization: 98 },
        },
      }),
    ).toEqual(quota);
    expect(
      normalizeAccountQuota({ ...usage, rate_limits_available: false }),
    ).toBeNull();
    for (const value of [
      null,
      {},
      {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: null },
          seven_day: { utilization: NaN },
        },
      },
    ])
      expect(normalizeAccountQuota(value)).toBeNull();
  });

  it("closes the metadata process and completes the input without submitting a message", async () => {
    const close = vi.fn();
    let firstMessage: Promise<IteratorResult<never>> | undefined;
    const result = await probeAccountQuota((prompt) => {
      firstMessage = prompt[Symbol.asyncIterator]().next();
      return {
        close,
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () =>
          usage,
      };
    });
    expect(result).toEqual(quota);
    expect(close).toHaveBeenCalledOnce();
    expect(await firstMessage).toEqual({ done: true, value: undefined });
  });

  it("hides unsupported, failed and timed-out SDK reads and always closes", async () => {
    for (const method of [
      undefined,
      async () => {
        throw new Error("offline");
      },
      () => new Promise<never>(() => {}),
    ]) {
      const close = vi.fn();
      expect(
        await probeAccountQuota(
          () => ({
            close,
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: method,
          }),
          5,
        ),
      ).toBeNull();
      expect(close).toHaveBeenCalledOnce();
    }
  });

  it("carries scoped settings through HTTP and disables work and persistence in the SDK probe", async () => {
    let captured:
      | {
          prompt: string | AsyncIterable<unknown>;
          options: Record<string, unknown>;
        }
      | undefined;
    const client = new ClaudeAgentSdkRuntimeClient({
      cwd: "/tmp",
      queryImpl: (args) => {
        captured = args;
        return {
          close() {},
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () =>
            usage,
        } as unknown as Query;
      },
    });
    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient: client,
      sessionMapper: new InMemorySessionMapper(),
    });
    const server = await startHttpBridgeServer({
      adapter: new Llm4ZoteroAgentBackendAdapter({ adapter: base }),
    });
    try {
      const response = await fetch(
        `http://${server.host}:${server.port}/account-quota?conversationKey=123&scopeType=paper&scopeId=library1-item2&settingSources=project,local`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ quota });
      expect(captured?.options.settingSources).toEqual(["project", "local"]);
      expect(captured?.options.cwd).toContain("library1-item2");
      expect(captured?.options).toMatchObject({
        settings: { disableAllHooks: true },
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        persistSession: false,
      });
      expect(typeof captured?.prompt).not.toBe("string");
      expect(
        (await fetch(`http://${server.host}:${server.port}/account-quota`))
          .status,
      ).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("keeps older runtime clients compatible", async () => {
    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient: {
        async startTurn() {
          throw new Error("not called");
        },
      },
      sessionMapper: new InMemorySessionMapper(),
    });
    expect(await base.getRuntimeAccountQuota({})).toBeNull();
  });
});
