import { describe, expect, it, vi } from "vitest";

import { ClaudeCodeRuntimeAdapter } from "../src/bridge/claude-code-runtime-adapter.js";

/**
 * The host can Clear or delete a conversation while a provider request is
 * still in flight. Without a fence, the late response repopulated the session
 * mapper, hot runtime and trace file the host had just cleared, so the
 * conversation came back on the provider side.
 *
 * These cover the fence itself, which had no coverage.
 */

/** An in-memory SessionMapper with the surface the adapter uses. */
function createSessionMapper(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key)),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    deleteByPrefix: vi.fn(async (prefix: string) => {
      for (const key of Array.from(store.keys())) {
        if (key.startsWith(prefix)) store.delete(key);
      }
    }),
    getByPrefix: vi.fn(async (prefix: string) => {
      for (const [key, value] of store) {
        if (key.startsWith(prefix)) return value;
      }
      return undefined;
    }),
  };
}

describe("ClaudeCodeRuntimeAdapter lifecycle fence", () => {
  it("does not persist a session id that arrives after invalidation", async () => {
    const sessionMapper = createSessionMapper();
    let releaseProvider!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let allowProviderToReturn!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      allowProviderToReturn = resolve;
    });

    const runtimeClient = {
      startTurn: vi.fn(async () => {
        releaseProvider();
        await providerGate;
        return {
          runId: "run-late",
          providerSessionId: "late-session",
          events: (async function* () {
            yield { type: "final", payload: { output: "done" } };
          })(),
        };
      }),
      invalidateHotRuntime: vi.fn(async () => {}),
    };

    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient: runtimeClient as any,
      sessionMapper: sessionMapper as any,
    });

    const turn = adapter.runTurn({
      conversationKey: "conv-late",
      userMessage: "hello",
    });

    // The host deletes the conversation while the provider request is pending.
    await providerStarted;
    await adapter.invalidateConversationSession("conv-late");
    allowProviderToReturn();

    const outcome = await turn;

    expect(sessionMapper.store.get("conv-late")).toBeUndefined();
    expect(outcome.providerSessionId).toBeUndefined();
    expect(runtimeClient.invalidateHotRuntime).toHaveBeenCalledWith(
      "conv-late",
    );
  });

  it("clears provider state and hot runtime on invalidation", async () => {
    const sessionMapper = createSessionMapper({
      "conv-clear": "session-a",
      "conv-clear::provider:identity-1": "session-a",
      "conv-clear::local-pdf-history-gap": "1",
      "conv-other": "session-b",
    });
    const traceStore = { clear: vi.fn(async () => {}), append: vi.fn() };
    const runtimeClient = {
      startTurn: vi.fn(),
      invalidateHotRuntime: vi.fn(async () => {}),
    };

    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient: runtimeClient as any,
      sessionMapper: sessionMapper as any,
      traceStore: traceStore as any,
    });

    await adapter.invalidateConversationSession("conv-clear");

    expect(sessionMapper.store.get("conv-clear")).toBeUndefined();
    expect(
      sessionMapper.store.get("conv-clear::provider:identity-1"),
    ).toBeUndefined();
    expect(
      sessionMapper.store.get("conv-clear::local-pdf-history-gap"),
    ).toBeUndefined();
    expect(traceStore.clear).toHaveBeenCalledWith("conv-clear");
    // An unrelated conversation must be untouched.
    expect(sessionMapper.store.get("conv-other")).toBe("session-b");
  });

  // A stale cleanup job carries the provider session it was created for. If the
  // key has since been bound to a different session, the job is obsolete and
  // must not remove the newer mapping.
  it("refuses to invalidate when the mapping belongs to a newer session", async () => {
    const sessionMapper = createSessionMapper({ "conv-reused": "session-new" });
    const runtimeClient = {
      startTurn: vi.fn(),
      invalidateHotRuntime: vi.fn(async () => {}),
    };
    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient: runtimeClient as any,
      sessionMapper: sessionMapper as any,
    });

    await adapter.invalidateConversationSession({
      conversationKey: "conv-reused",
      metadata: { providerSessionId: "session-old" },
    });

    expect(sessionMapper.store.get("conv-reused")).toBe("session-new");
    expect(runtimeClient.invalidateHotRuntime).not.toHaveBeenCalled();
  });

  it("invalidates when the mapping still belongs to the expected session", async () => {
    const sessionMapper = createSessionMapper({ "conv-match": "session-old" });
    const runtimeClient = {
      startTurn: vi.fn(),
      invalidateHotRuntime: vi.fn(async () => {}),
    };
    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient: runtimeClient as any,
      sessionMapper: sessionMapper as any,
    });

    await adapter.invalidateConversationSession({
      conversationKey: "conv-match",
      metadata: { providerSessionId: "session-old" },
    });

    expect(sessionMapper.store.get("conv-match")).toBeUndefined();
    expect(runtimeClient.invalidateHotRuntime).toHaveBeenCalledWith(
      "conv-match",
    );
  });

  // The legacy-map, prefix-map and request-hint adoption paths all write the
  // canonical mapping. Each must respect the fence rather than resurrecting a
  // mapping for a conversation that has been invalidated.
  it("does not adopt a legacy prefix mapping after invalidation", async () => {
    const sessionMapper = createSessionMapper({
      "conv-legacy::provider:identity-1": "legacy-session",
    });
    const runtimeClient = {
      startTurn: vi.fn(),
      invalidateHotRuntime: vi.fn(async () => {}),
    };
    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient: runtimeClient as any,
      sessionMapper: sessionMapper as any,
    });

    await adapter.invalidateConversationSession("conv-legacy");
    const resolved = await adapter.getMappedProviderSessionId("conv-legacy");

    expect(resolved).toBeUndefined();
    expect(sessionMapper.store.get("conv-legacy")).toBeUndefined();
  });

  // Two turns on one conversation must not interleave their mapping writes.
  it("serializes concurrent invalidations for the same conversation", async () => {
    const sessionMapper = createSessionMapper({ "conv-race": "session-a" });
    const order: string[] = [];
    let inFlight = 0;
    const runtimeClient = {
      startTurn: vi.fn(),
      invalidateHotRuntime: vi.fn(async () => {
        inFlight += 1;
        expect(inFlight).toBe(1);
        order.push("enter");
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("exit");
        inFlight -= 1;
      }),
    };
    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient: runtimeClient as any,
      sessionMapper: sessionMapper as any,
    });

    await Promise.all([
      adapter.invalidateConversationSession("conv-race"),
      adapter.invalidateConversationSession("conv-race"),
    ]);

    expect(order).toEqual(["enter", "exit", "enter", "exit"]);
  });

  it("keeps a session written before invalidation out of the mapper", async () => {
    const sessionMapper = createSessionMapper();
    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient: {
        startTurn: vi.fn(),
        invalidateHotRuntime: vi.fn(async () => {}),
      } as any,
      sessionMapper: sessionMapper as any,
    });

    // A turn resolves a hinted session, then the conversation is invalidated,
    // then a second turn on the same key starts fresh.
    await adapter.getMappedProviderSessionId("conv-seq");
    await adapter.invalidateConversationSession("conv-seq");
    expect(sessionMapper.store.get("conv-seq")).toBeUndefined();

    // A NEW turn after invalidation is allowed to establish a mapping again:
    // the fence blocks stale work, not subsequent legitimate work.
    const runtimeClient = {
      startTurn: vi.fn(async () => ({
        runId: "run-next",
        providerSessionId: "session-next",
        events: (async function* () {
          yield { type: "final", payload: { output: "ok" } };
        })(),
      })),
      invalidateHotRuntime: vi.fn(async () => {}),
    };
    const nextAdapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient: runtimeClient as any,
      sessionMapper: sessionMapper as any,
    });
    const outcome = await nextAdapter.runTurn({
      conversationKey: "conv-seq",
      userMessage: "again",
    });
    expect(outcome.providerSessionId).toBe("session-next");
    expect(sessionMapper.store.get("conv-seq")).toBe("session-next");
  });
});
