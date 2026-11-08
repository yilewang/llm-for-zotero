import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeRuntimeAdapter } from "../src/bridge/claude-code-runtime-adapter.js";
import { Llm4ZoteroAgentBackendAdapter } from "../src/bridge/llm4zotero-agent-backend-adapter.js";
import type { ClaudeCodeRuntimeClient, ProviderEvent } from "../src/runtime.js";
import { InMemorySessionMapper } from "../src/session-link/session-mapper.js";

/** A runtime folder with one project slash command, so tool lists do not depend on ~/.claude. */
function createRuntimeWithCommand(): string {
  const runtimeCwd = mkdtempSync(join(tmpdir(), "bridge-tools-"));
  mkdirSync(join(runtimeCwd, ".claude", "commands"), { recursive: true });
  writeFileSync(
    join(runtimeCwd, ".claude", "commands", "summarize.md"),
    "---\ndescription: Summarize a paper\n---\nSummarize $ARGUMENTS\n",
  );
  return runtimeCwd;
}

function providerEvents(events: ProviderEvent[]): AsyncIterable<ProviderEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe("Llm4ZoteroAgentBackendAdapter", () => {
  it("maps canonical adapter events to llm-for-zotero event contract", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "run-z-1",
          events: providerEvents([
            { type: "status", payload: { label: "running" } },
            { type: "message_delta", payload: { delta: "hello " } },
            {
              type: "tool_call",
              payload: { id: "call_1", name: "Read", input: { path: "a.ts" } },
            },
            {
              type: "tool_result",
              payload: { toolUseId: "call_1", name: "Read", content: "ok" },
            },
            { type: "final", payload: { output: "hello world" } },
          ]),
        };
      },
    };

    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper(),
    });

    const compat = new Llm4ZoteroAgentBackendAdapter({ adapter: base });

    const seen: Array<{ type: string; payload: unknown }> = [];

    const outcome = await compat.runTurn({
      request: {
        conversationKey: 42,
        userText: "test",
      },
      onEvent(event) {
        if (
          event.type === "provider_event" &&
          (event as any).providerType === "profiling"
        )
          return;
        seen.push({ type: event.type, payload: event });
      },
    });

    expect(outcome.kind).toBe("completed");
    expect(outcome.text).toBe("hello world");
    expect(seen.map((x) => x.type)).toEqual([
      "status",
      "message_delta",
      "tool_call",
      "tool_result",
      "final",
    ]);
  });

  it("returns fallback outcome when runtime fails", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "run-z-2",
          events: providerEvents([
            { type: "status", payload: { text: "starting" } },
          ]),
        };
      },
    };

    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient: {
        async startTurn(request) {
          const stream = await runtimeClient.startTurn(request);
          return {
            ...stream,
            events: (async function* () {
              for await (const ev of stream.events) {
                yield ev;
              }
              throw new Error("boom");
            })(),
          };
        },
      },
      sessionMapper: new InMemorySessionMapper(),
    });

    const compat = new Llm4ZoteroAgentBackendAdapter({ adapter: base });
    const outcome = await compat.runTurn({
      request: { conversationKey: "conv-fail", userText: "x" },
    });

    expect(outcome.kind).toBe("fallback");
    expect(outcome.usedFallback).toBe(true);
  });

  it("forwards provider_event for unknown runtime events", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "run-z-3",
          events: providerEvents([
            { type: "unknown", payload: { sourceType: "stream_event" } },
            { type: "message_delta", payload: { delta: "hello" } },
            { type: "final", payload: { output: "hello" } },
          ]),
        };
      },
    };

    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper(),
    });

    const compat = new Llm4ZoteroAgentBackendAdapter({ adapter: base });
    const seen: string[] = [];

    const outcome = await compat.runTurn({
      request: { conversationKey: "conv-noise", userText: "x" },
      onEvent(event) {
        if (
          event.type === "provider_event" &&
          (event as any).providerType === "profiling"
        )
          return;
        seen.push(event.type);
      },
    });

    expect(outcome.kind).toBe("completed");
    expect(seen).toEqual(["provider_event", "message_delta", "final"]);
  });

  it("blocks catastrophic action arguments before runtime execution", async () => {
    let turnCalls = 0;
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        turnCalls += 1;
        return {
          runId: "run-z-blocked",
          events: providerEvents([
            { type: "final", payload: { output: "should not run" } },
          ]),
        };
      },
    };

    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper(),
    });
    const compat = new Llm4ZoteroAgentBackendAdapter({
      adapter: base,
      runtimeCwd: createRuntimeWithCommand(),
    });
    const candidateTool = (
      await compat.listTools({ settingSources: ["project"] })
    )[0];
    expect(candidateTool).toBeDefined();

    const seen: string[] = [];
    const outcome = await compat.runAction({
      request: {
        conversationKey: "conv-danger",
        toolName: candidateTool!.name,
        args: { arguments: "rm -rf /" },
        approved: true,
      },
      onEvent(event) {
        seen.push(event.type);
      },
    });

    expect(outcome.kind).toBe("fallback");
    expect(outcome.reason).toBe("dangerous_command_blocked");
    expect(turnCalls).toBe(0);
    expect(seen).toContain("status");
  });
});
