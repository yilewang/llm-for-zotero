import { assert } from "chai";
import {
  CLAUDE_BRIDGE_COMPLETION_TIMEOUT_MS,
  createClaudeBridgeCompletion,
} from "../src/claudeCode/structuredCompletion";
import { parseStatusFromErrorMessage } from "../src/utils/llmClient";

type Call = { url: string; init?: RequestInit };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeBridge(
  options: {
    capabilities?: string[];
    completion?: () => Response | Promise<Response>;
  } = {},
) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/healthz")) {
      return jsonResponse(200, {
        ok: true,
        capabilities: options.capabilities ?? ["structured_completion_v1"],
      });
    }
    return (
      options.completion?.() ?? jsonResponse(200, { text: '{"digest":"d"}' })
    );
  }) as unknown as typeof fetch;
  const completion = createClaudeBridgeCompletion({
    bridgeUrl: () => "http://127.0.0.1:4444/token/",
    fetchImpl,
  });
  const posts = () =>
    calls.filter((call) => call.url.endsWith("/structured-completion"));
  const health = () => calls.filter((call) => call.url.endsWith("/healthz"));
  return { calls, completion, posts, health };
}

describe("Claude bridge structured completion adapter", function () {
  it("checks the capability once per adapter and posts the model, prompt and deadline", async function () {
    const bridge = fakeBridge();
    const first = await bridge.completion("Read this", {
      model: "sonnet",
      systemMessages: ["You are a reader."],
    });
    await bridge.completion("Read that", { model: "sonnet" });

    assert.equal(first.text, '{"digest":"d"}');
    assert.lengthOf(bridge.health(), 1, "one /healthz check per session");
    assert.lengthOf(bridge.posts(), 2);
    assert.equal(
      bridge.posts()[0].url,
      "http://127.0.0.1:4444/token/structured-completion",
    );
    const body = JSON.parse(String(bridge.posts()[0].init?.body));
    assert.deepEqual(body, {
      prompt: "You are a reader.\n\nRead this",
      model: "sonnet",
      timeoutMs: CLAUDE_BRIDGE_COMPLETION_TIMEOUT_MS,
    });
    assert.equal(CLAUDE_BRIDGE_COMPLETION_TIMEOUT_MS, 180_000);
  });

  it("forwards the caller's deadline within the bridge's bounds", async function () {
    const bridge = fakeBridge();
    await bridge.completion("a", { model: "sonnet", timeoutMs: 900_000 });
    await bridge.completion("b", { model: "sonnet", timeoutMs: 10 });
    assert.deepEqual(
      bridge
        .posts()
        .map((post) => JSON.parse(String(post.init?.body)).timeoutMs),
      [300_000, 1_000],
    );
  });

  it("refuses a bridge without structured_completion_v1 and checks again next time", async function () {
    const bridge = fakeBridge({ capabilities: ["local_pdf_paths"] });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let error: Error | undefined;
      try {
        await bridge.completion("x", { model: "sonnet" });
      } catch (caught) {
        error = caught as Error;
      }
      assert.match(error?.message || "", /structured_completion_v1/);
    }
    assert.lengthOf(bridge.posts(), 0);
    assert.lengthOf(bridge.health(), 2, "a failed check is not remembered");
  });

  it("refuses an empty model without calling the bridge", async function () {
    const bridge = fakeBridge();
    for (const model of ["", "   "]) {
      let error: Error | undefined;
      try {
        await bridge.completion("x", { model });
      } catch (caught) {
        error = caught as Error;
      }
      assert.match(error?.message || "", /concrete Claude model/);
    }
    assert.lengthOf(bridge.calls, 0);
  });

  it("passes the token usage the bridge reported", async function () {
    const bridge = fakeBridge({
      completion: () =>
        jsonResponse(200, {
          text: "ok",
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            cacheCreationInputTokens: 3,
            cacheReadInputTokens: 40,
            model: "claude-sonnet-4-5",
          },
        }),
    });
    const result = await bridge.completion("x", { model: "sonnet" });
    assert.deepEqual(result, {
      text: "ok",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationInputTokens: 3,
        cacheReadInputTokens: 40,
        model: "claude-sonnet-4-5",
      },
    });
  });

  it("returns text alone when the bridge reports no usable usage", async function () {
    const bridge = fakeBridge({
      completion: () =>
        jsonResponse(200, { text: "ok", usage: { inputTokens: "many" } }),
    });
    assert.deepEqual(await bridge.completion("x", { model: "sonnet" }), {
      text: "ok",
    });
  });

  it("maps a 429 to an error the reader's rate-limit backoff recognizes", async function () {
    const bridge = fakeBridge({
      completion: () => jsonResponse(429, { error: "You hit your limit" }),
    });
    let error: Error | undefined;
    try {
      await bridge.completion("x", { model: "sonnet" });
    } catch (caught) {
      error = caught as Error;
    }
    assert.equal(parseStatusFromErrorMessage(error?.message || ""), 429);
    assert.include(error?.message, "You hit your limit");
  });

  it("maps a 500 to an error that is not a rate limit", async function () {
    const bridge = fakeBridge({
      completion: () =>
        jsonResponse(500, { error: "Semantic completion failed" }),
    });
    let error: Error | undefined;
    try {
      await bridge.completion("x", { model: "sonnet" });
    } catch (caught) {
      error = caught as Error;
    }
    assert.equal(parseStatusFromErrorMessage(error?.message || ""), 500);
    assert.include(error?.message, "Semantic completion failed");
  });

  it("fails on an empty completion", async function () {
    const bridge = fakeBridge({
      completion: () => jsonResponse(200, { text: "  " }),
    });
    let error: Error | undefined;
    try {
      await bridge.completion("x", { model: "sonnet" });
    } catch (caught) {
      error = caught as Error;
    }
    assert.match(error?.message || "", /empty completion/);
  });

  it("does not call the bridge when the signal is already aborted", async function () {
    const bridge = fakeBridge();
    const controller = new AbortController();
    controller.abort();
    let error: Error | undefined;
    try {
      await bridge.completion("x", {
        model: "sonnet",
        signal: controller.signal,
      });
    } catch (caught) {
      error = caught as Error;
    }
    assert.equal(error?.name, "AbortError");
    assert.lengthOf(bridge.calls, 0);
  });

  it("aborts the in-flight request and reports an AbortError", async function () {
    const controller = new AbortController();
    let forwardedSignal: AbortSignal | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/healthz")) {
        return jsonResponse(200, {
          capabilities: ["structured_completion_v1"],
        });
      }
      forwardedSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("The operation was aborted")),
        );
        setTimeout(() => controller.abort(), 5);
      });
    }) as unknown as typeof fetch;
    const completion = createClaudeBridgeCompletion({
      bridgeUrl: () => "http://127.0.0.1:4444/token",
      fetchImpl,
    });
    let error: Error | undefined;
    try {
      await completion("x", { model: "sonnet", signal: controller.signal });
    } catch (caught) {
      error = caught as Error;
    }
    assert.equal(error?.name, "AbortError");
    assert.isTrue(forwardedSignal?.aborted, "the fetch signal was aborted");
  });
});
