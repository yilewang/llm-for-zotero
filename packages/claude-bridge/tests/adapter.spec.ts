import { describe, expect, it } from "vitest";
import { ClaudeCodeRuntimeAdapter } from "../src/bridge/claude-code-runtime-adapter.js";
import type { ClaudeCodeRuntimeClient, ProviderEvent } from "../src/runtime.js";
import type { AgentEvent } from "../src/types.js";
import { InMemorySessionMapper } from "../src/session-link/session-mapper.js";
import { InMemoryTraceStore } from "../src/trace-store/trace-store.js";

function providerEvents(events: ProviderEvent[]): AsyncIterable<ProviderEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe("ClaudeCodeRuntimeAdapter", () => {
  it("coalesces adjacent text deltas before forwarding them", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "run-coalesce",
          providerSessionId: "claude-session-coalesce",
          events: providerEvents([
            { type: "message_delta", payload: { delta: "Hello" } },
            { type: "message_delta", payload: { delta: " " } },
            { type: "message_delta", payload: { delta: "world" } },
            { type: "final", payload: { output: "Hello world" } },
          ]),
        };
      },
    };

    const seen: Array<{ type: string; delta?: string }> = [];
    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper(),
    });

    const outcome = await adapter.runTurn(
      {
        conversationKey: "conv-coalesce",
        userMessage: "hello",
      },
      {
        onEvent(event) {
          if (event.type === "provider_event") return;
          seen.push({
            type: event.type,
            delta:
              event.type === "message_delta" ? event.payload.delta : undefined,
          });
        },
      },
    );

    expect(outcome.status).toBe("completed");
    expect(outcome.finalText).toBe("Hello world");
    expect(seen).toEqual([
      { type: "message_delta", delta: "Hello world" },
      { type: "final", delta: undefined },
    ]);
  });

  it("maps runtime events and persists session mapping + traces", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "run-1",
          providerSessionId: "claude-session-1",
          events: providerEvents([
            { type: "status", payload: { label: "running" } },
            { type: "message_delta", payload: { delta: "Hello " } },
            { type: "message_delta", payload: { delta: "world" } },
            { type: "final", payload: { output: "Hello world" } },
          ]),
        };
      },
    };

    const sessionMapper = new InMemorySessionMapper();
    const traceStore = new InMemoryTraceStore();
    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper,
      traceStore,
    });

    const seenTypes: string[] = [];

    const outcome = await adapter.runTurn(
      {
        conversationKey: "conv-A",
        userMessage: "summarize this",
      },
      {
        onEvent(event) {
          if (event.type === "provider_event") return;
          seenTypes.push(event.type);
        },
      },
    );

    expect(outcome.status).toBe("completed");
    expect(outcome.finalText).toBe("Hello world");
    expect(await sessionMapper.get("conv-A")).toBe("claude-session-1");
    expect(seenTypes).toEqual(["status", "message_delta", "final"]);

    const traces = await traceStore.list("conv-A");
    expect(traces).toHaveLength(3);
    expect(traces[0]?.runId).toBe("run-1");
  });

  it("keeps PDF turns ephemeral, redacts their path, and rebuilds continuity once", async () => {
    const pdfPath = "/private/library/paper a.pdf";
    const split = Math.floor(pdfPath.length / 2);
    const firstPathChunk = pdfPath.slice(0, split);
    const secondPathChunk = pdfPath.slice(split);
    const seenRequests: Array<{
      providerSessionId?: string;
      fallbackHistory?: unknown;
    }> = [];
    let callCount = 0;
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn(request) {
        callCount += 1;
        seenRequests.push({
          providerSessionId: request.providerSessionId,
          fallbackHistory: request.metadata?.claudeResumeFallbackHistory,
        });
        if (callCount === 1) {
          return {
            runId: "run-pdf",
            providerSessionId: "ephemeral-session",
            events: providerEvents([
              {
                type: "provider_event",
                payload: {
                  providerType: "stream_event",
                  sessionId: "ephemeral-session",
                  payload: {
                    event: { delta: { text: `Read ${firstPathChunk}` } },
                  },
                },
              },
              {
                type: "message_delta",
                payload: {
                  delta: `Read ${firstPathChunk}`,
                  sessionId: "ephemeral-session",
                },
              },
              {
                type: "reasoning",
                payload: {
                  round: 1,
                  details: firstPathChunk,
                  sessionId: "ephemeral-session",
                },
              },
              {
                type: "provider_event",
                payload: {
                  providerType: "stream_event",
                  sessionId: "ephemeral-session",
                  payload: { event: { delta: { text: secondPathChunk } } },
                },
              },
              {
                type: "message_delta",
                payload: {
                  delta: secondPathChunk,
                  sessionId: "ephemeral-session",
                },
              },
              {
                type: "reasoning",
                payload: {
                  round: 1,
                  details: secondPathChunk,
                  sessionId: "ephemeral-session",
                },
              },
              {
                type: "tool_call",
                payload: {
                  name: "Read",
                  input: {
                    file_path: pdfPath,
                    session_id: "ephemeral-session",
                  },
                  sessionId: "ephemeral-session",
                },
              },
              {
                type: "final",
                payload: {
                  output: `Read ${pdfPath}`,
                  sessionId: "ephemeral-session",
                },
              },
            ]),
          };
        }
        return {
          runId: "run-normal",
          providerSessionId: "new-persistent-session",
          events: providerEvents([
            { type: "final", payload: { output: "continued" } },
          ]),
        };
      },
    };

    const sessionMapper = new InMemorySessionMapper();
    await sessionMapper.set("conv-pdf-continuity", "old-persistent-session");
    const traceStore = new InMemoryTraceStore();
    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper,
      traceStore,
    });
    const seenEvents: AgentEvent[] = [];

    const pdfOutcome = await adapter.runTurn(
      {
        conversationKey: "conv-pdf-continuity",
        userMessage: "read it",
        providerSessionId: "old-persistent-session",
        runtimeRequest: {
          history: [
            { role: "user", content: "earlier question" },
            { role: "assistant", content: "earlier answer" },
          ],
          localDocuments: [
            {
              kind: "local_pdf",
              sourceKey: "zotero-pdf:10:20",
              itemId: 10,
              contextItemId: 20,
              title: "Paper",
              name: "paper a.pdf",
              mimeType: "application/pdf",
              absolutePath: pdfPath,
            },
          ],
        },
      },
      {
        onEvent(event) {
          seenEvents.push(event);
        },
      },
    );

    expect(seenRequests[0]).toEqual({
      providerSessionId: undefined,
      fallbackHistory: true,
    });
    expect(pdfOutcome.providerSessionId).toBeUndefined();
    expect(pdfOutcome.finalText).not.toContain(pdfPath);
    expect(await sessionMapper.get("conv-pdf-continuity")).toBeUndefined();
    expect(
      await sessionMapper.get("conv-pdf-continuity::local-pdf-history-gap"),
    ).toBe("1");
    const serializedEvents = JSON.stringify(seenEvents);
    expect(serializedEvents).not.toContain(pdfPath);
    expect(serializedEvents).not.toContain(firstPathChunk);
    expect(serializedEvents).not.toContain(secondPathChunk);
    const serializedTraces = JSON.stringify(
      await traceStore.list("conv-pdf-continuity"),
    );
    expect(serializedTraces).not.toContain(pdfPath);
    expect(serializedTraces).not.toContain(firstPathChunk);
    expect(serializedTraces).not.toContain(secondPathChunk);
    expect(serializedTraces).not.toContain("ephemeral-session");

    const normalOutcome = await adapter.runTurn({
      conversationKey: "conv-pdf-continuity",
      userMessage: "continue",
      providerSessionId: "old-persistent-session",
      runtimeRequest: {
        history: [
          { role: "user", content: "read it" },
          { role: "assistant", content: "summary" },
        ],
      },
    });

    expect(seenRequests[1]).toEqual({
      providerSessionId: undefined,
      fallbackHistory: true,
    });
    expect(normalOutcome.providerSessionId).toBe("new-persistent-session");
    expect(await sessionMapper.get("conv-pdf-continuity")).toBe(
      "new-persistent-session",
    );
    expect(
      await sessionMapper.get("conv-pdf-continuity::local-pdf-history-gap"),
    ).toBeUndefined();
  });

  it("resumes the base conversation session when provider identity changes", async () => {
    const seenResumes: Array<string | undefined> = [];
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn(request) {
        seenResumes.push(request.providerSessionId);
        return {
          runId: "run-provider-change",
          providerSessionId: request.providerSessionId,
          events: providerEvents([
            { type: "final", payload: { output: "continued" } },
          ]),
        };
      },
    };

    const sessionMapper = new InMemorySessionMapper();
    await sessionMapper.set("conv-provider", "stable-session");
    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper,
    });

    const outcome = await adapter.runTurn({
      conversationKey: "conv-provider",
      userMessage: "continue",
      metadata: { providerIdentity: "provider-b" },
    });

    expect(outcome.status).toBe("completed");
    expect(seenResumes).toEqual(["stable-session"]);
    expect(await sessionMapper.get("conv-provider")).toBe("stable-session");
  });

  it("migrates legacy provider-scoped session mappings to the base conversation key", async () => {
    const seenResumes: Array<string | undefined> = [];
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn(request) {
        seenResumes.push(request.providerSessionId);
        return {
          runId: "run-legacy",
          providerSessionId: request.providerSessionId,
          events: providerEvents([
            { type: "final", payload: { output: "continued" } },
          ]),
        };
      },
    };

    const sessionMapper = new InMemorySessionMapper();
    await sessionMapper.set(
      "conv-legacy::provider:provider-a",
      "legacy-session",
    );
    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper,
    });

    await adapter.runTurn({
      conversationKey: "conv-legacy",
      userMessage: "continue",
      metadata: { providerIdentity: "provider-b" },
    });

    expect(seenResumes).toEqual(["legacy-session"]);
    expect(await sessionMapper.get("conv-legacy")).toBe("legacy-session");
  });

  it("emits provider_event on unmapped event", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "run-2",
          events: providerEvents([{ type: "unknown", payload: { raw: true } }]),
        };
      },
    };

    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper(),
    });

    const seenTypes: string[] = [];

    await adapter.runTurn(
      {
        conversationKey: "conv-B",
        userMessage: "hello",
      },
      {
        onEvent(event) {
          if (
            event.type === "provider_event" &&
            event.payload &&
            typeof event.payload === "object" &&
            (event.payload as Record<string, unknown>).providerType ===
              "profiling"
          ) {
            return;
          }
          seenTypes.push(event.type);
        },
      },
    );

    expect(seenTypes).toEqual(["provider_event"]);
  });

  it("retries with fresh session when thinking signature is invalid", async () => {
    let callCount = 0;
    const seenResumes: Array<string | undefined> = [];
    const seenFallbackFlags: unknown[] = [];
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn(request) {
        callCount += 1;
        seenResumes.push(request.providerSessionId);
        seenFallbackFlags.push(request.metadata?.claudeResumeFallbackHistory);
        if (callCount === 1) {
          throw new Error("API Error: 400 Invalid signature in thinking block");
        }
        return {
          runId: "run-ok",
          providerSessionId: "fresh-session-id",
          events: providerEvents([
            { type: "message_delta", payload: { delta: "ok" } },
            { type: "final", payload: { output: "ok" } },
          ]),
        };
      },
    };

    const sessionMapper = new InMemorySessionMapper();
    await sessionMapper.set("conv-retry", "stale-session");
    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper,
    });

    const seenStatuses: string[] = [];
    const outcome = await adapter.runTurn(
      {
        conversationKey: "conv-retry",
        userMessage: "retry me",
        runtimeRequest: {
          history: [
            { role: "user", content: "previous question" },
            { role: "assistant", content: "previous answer" },
          ],
        },
      },
      {
        onEvent(event) {
          if (
            event.type === "status" &&
            typeof event.payload.text === "string"
          ) {
            seenStatuses.push(event.payload.text);
          }
        },
      },
    );

    expect(callCount).toBe(2);
    expect(seenResumes).toEqual(["stale-session", undefined]);
    expect(seenFallbackFlags).toEqual([undefined, true]);
    expect(outcome.status).toBe("completed");
    expect(outcome.finalText).toBe("ok");
    expect(await sessionMapper.get("conv-retry")).toBe("fresh-session-id");
    expect(
      seenStatuses.some((line) =>
        line.includes("Claude session resume failed"),
      ),
    ).toBe(true);
  });

  it("clears mapper and hot runtime on explicit invalidation", async () => {
    let invalidatedConversationKey = "";
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "noop",
          events: providerEvents([]),
        };
      },
      async invalidateHotRuntime(conversationKey) {
        invalidatedConversationKey = conversationKey;
      },
    };

    const sessionMapper = new InMemorySessionMapper();
    await sessionMapper.set("conv-invalidate", "stale-session");
    await sessionMapper.set(
      "conv-invalidate::provider:provider-a",
      "stale-session-provider",
    );
    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper,
    });

    await sessionMapper.set(
      "conv-invalidate::provider:provider-b",
      "stale-session-provider-b",
    );

    await adapter.invalidateConversationSession({
      conversationKey: "conv-invalidate",
      metadata: { providerIdentity: "provider-a" },
    });

    expect(await sessionMapper.get("conv-invalidate")).toBeUndefined();
    expect(
      await sessionMapper.get("conv-invalidate::provider:provider-a"),
    ).toBeUndefined();
    expect(
      await sessionMapper.get("conv-invalidate::provider:provider-b"),
    ).toBeUndefined();
    expect(invalidatedConversationKey).toBe("conv-invalidate");
  });

  it("deletes stale mappings before force-fresh retry", async () => {
    const seenResumes: Array<string | undefined> = [];
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn(request) {
        seenResumes.push(request.providerSessionId);
        return {
          runId: "run-fresh",
          providerSessionId: "fresh-session",
          events: providerEvents([
            { type: "final", payload: { output: "fresh" } },
          ]),
        };
      },
      async invalidateHotRuntime() {},
    };

    const sessionMapper = new InMemorySessionMapper();
    await sessionMapper.set("conv-fresh::provider:provider-a", "stale-session");
    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper,
    });

    const outcome = await adapter.runTurn({
      conversationKey: "conv-fresh",
      userMessage: "new chat",
      metadata: { forceFreshSession: true, providerIdentity: "provider-a" },
    });

    expect(outcome.status).toBe("completed");
    expect(seenResumes).toEqual([undefined]);
    expect(await sessionMapper.get("conv-fresh")).toBe("fresh-session");
    expect(
      await sessionMapper.get("conv-fresh::provider:provider-a"),
    ).toBeUndefined();
  });
});
