import { assert } from "chai";
import {
  defaultReaderRoute,
  resolveReaderCompletion,
  type ReaderRequest,
} from "../src/agent/reader/resolveReader";
import {
  ReaderCompletionError,
  classifyReaderCompletionError,
  createReaderCallLimiter,
  limitReaderCompletion,
  LIMITED_READER_CALL_TIMEOUT_MS,
  type ReaderCompletion,
} from "../src/shared/readerCompletion";
import { createReaderBatchAnalyzer } from "../src/agent/reader/readerBatchAnalyzer";
import type { ResolvedReader } from "../src/agent/reader/resolveReader";
import { createUtilityReaderCompletion } from "../src/utils/utilityReaderCompletion";
import { createCodexResponsesCompletion } from "../src/codexAppServer/readerCompletion";
import {
  DEFAULT_CODEX_API_BASE,
  type ChatParams,
} from "../src/utils/llmClient";

const complete = (text: string) => ({
  text,
  completion: { status: "complete" as const },
});

/** A factory that records the config it was built with and the calls made. */
function recordingFactory(tag: string) {
  const built: unknown[] = [];
  const calls: Array<{ prompt: string; model: string }> = [];
  const factory = (config?: unknown): ReaderCompletion => {
    built.push(config);
    return async (prompt, options) => {
      calls.push({ prompt, model: options.model });
      return { text: tag };
    };
  };
  return { factory, built, calls };
}

const PLUGIN_REQUEST: ReaderRequest = {
  model: "deepseek-v4-flash",
  apiBase: "https://api.deepseek.com",
  apiKey: "key",
  providerProtocol: "openai_chat_compat",
  runtimeContextBudget: { contextWindowTokens: 64_000, usedContextTokens: 0 },
};

describe("reader completion resolver", function () {
  it("reads with the turn's provider in the plugin Agent, sized by the turn's window", async function () {
    const turn = recordingFactory("turn");
    const resolution = resolveReaderCompletion({
      request: PLUGIN_REQUEST,
      factories: { turnModel: turn.factory },
    });
    assert.isTrue(resolution.ok);
    if (!resolution.ok) return;
    assert.equal(resolution.reader.route, "turn_model");
    assert.equal(resolution.reader.model, "deepseek-v4-flash");
    assert.equal(resolution.reader.windowTokens, 64_000);
    assert.deepInclude(turn.built[0] as object, {
      apiBase: "https://api.deepseek.com",
      apiKey: "key",
      providerProtocol: "openai_chat_compat",
    });
    const reply = await resolution.reader.complete("p", { model: "x" });
    assert.equal(reply.text, "turn");
  });

  it("reads through Codex Responses with the chat's model in a Codex scope", function () {
    const codex = recordingFactory("codex");
    const turn = recordingFactory("turn");
    const resolution = resolveReaderCompletion({
      request: {
        model: "gpt-5.4",
        authMode: "codex_app_server",
        providerProtocol: "codex_responses",
        exhaustiveReadBackend: "codex_responses",
      },
      factories: { codexResponses: codex.factory, turnModel: turn.factory },
    });
    assert.isTrue(resolution.ok);
    if (!resolution.ok) return;
    assert.equal(resolution.reader.route, "codex_responses");
    assert.equal(resolution.reader.model, "gpt-5.4");
    assert.lengthOf(codex.built, 1);
    assert.lengthOf(turn.built, 0, "never the turn model");
  });

  it("reads through Codex Responses in a plugin chat on the Codex login", function () {
    assert.equal(
      defaultReaderRoute({ authMode: "codex_app_server" }),
      "codex_responses",
    );
  });

  it("refuses a Codex chat with no concrete model instead of defaulting", function () {
    for (const model of ["", "codex-app-server"]) {
      const resolution = resolveReaderCompletion({
        request: { model, exhaustiveReadBackend: "codex_responses" },
      });
      assert.isFalse(resolution.ok);
      if (!resolution.ok) assert.include(resolution.detail, "Codex reader");
    }
  });

  it("reads through the Claude bridge with the chat's model in a Claude scope", function () {
    const claude = recordingFactory("claude");
    const resolution = resolveReaderCompletion({
      request: {
        model: "claude-sonnet-4-5",
        exhaustiveReadBackend: "claude_bridge",
      },
      factories: { claudeBridge: claude.factory },
    });
    assert.isTrue(resolution.ok);
    if (!resolution.ok) return;
    assert.equal(resolution.reader.route, "claude_bridge");
    assert.equal(resolution.reader.model, "claude-sonnet-4-5");
    assert.isAbove(resolution.reader.windowTokens, 0);
    const empty = resolveReaderCompletion({
      request: { model: " ", exhaustiveReadBackend: "claude_bridge" },
    });
    assert.isFalse(empty.ok);
  });

  it("has no reader for an MCP client without a native runtime", function () {
    const resolution = resolveReaderCompletion({
      request: { model: "x", exhaustiveReadBackend: "unavailable" },
    });
    assert.isFalse(resolution.ok);
  });

  it("lets an explicit reader choice override the runtime's own model", function () {
    const turn = recordingFactory("turn");
    const claude = recordingFactory("claude");
    const resolution = resolveReaderCompletion({
      request: {
        model: "claude-opus-4-1",
        exhaustiveReadBackend: "claude_bridge",
      },
      choice: {
        route: "turn_model",
        model: "deepseek-v4-flash",
        apiBase: "https://api.deepseek.com",
        apiKey: "reader-key",
      },
      factories: { turnModel: turn.factory, claudeBridge: claude.factory },
    });
    assert.isTrue(resolution.ok);
    if (!resolution.ok) return;
    assert.equal(resolution.reader.route, "turn_model");
    assert.equal(resolution.reader.model, "deepseek-v4-flash");
    assert.deepInclude(turn.built[0] as object, { apiKey: "reader-key" });
    assert.lengthOf(claude.built, 0);
  });
});

describe("full-read batch analyzer", function () {
  it("puts no deadline on a batch call", async function () {
    const seen: Array<number | undefined> = [];
    const reader: ResolvedReader = {
      route: "turn_model",
      model: "deepseek-v4-flash",
      windowTokens: 64_000,
      complete: async (_prompt, options) => {
        seen.push(options.timeoutMs);
        return { text: '{"digest":"d","relevantChunkIds":[0]}' };
      },
    };
    const analyze = createReaderBatchAnalyzer(reader);
    const out = await analyze({
      paperKey: "p",
      batchIndex: 0,
      batchCount: 1,
      question: "q",
      chunks: [
        {
          paperKey: "p",
          chunkIndex: 0,
          text: "x ".repeat(40_000),
        } as never,
      ],
    } as never);
    assert.equal(out.digest, "d");
    assert.lengthOf(seen, 1);
    assert.isUndefined(seen[0]);
  });
});

describe("turn-model reader completion", function () {
  it("accepts a request with neither API URL nor key, as callLLM does", async function () {
    let reached = false;
    const completeFn = createUtilityReaderCompletion({
      authMode: "copilot_auth",
      llmCall: async () => {
        reached = true;
        return complete("{}");
      },
    });
    const reply = await completeFn("p", { model: "gpt-4.1" });
    assert.isTrue(reached);
    assert.equal(reply.text, "{}");
  });

  it("reads a missing connection from callLLM as not configured", async function () {
    const completeFn = createUtilityReaderCompletion({
      llmCall: async () => {
        throw new Error("API URL is missing in preferences");
      },
    });
    try {
      await completeFn("p", { model: "deepseek-v4-flash" });
      assert.fail("expected a throw");
    } catch (error) {
      assert.equal(
        classifyReaderCompletionError(error).reason,
        "not_configured",
      );
    }
  });

  it("calls the turn's provider with the JSON budget and returns its text", async function () {
    let seen: ChatParams | null = null;
    const completeFn = createUtilityReaderCompletion({
      apiBase: "https://api.deepseek.com",
      apiKey: "key",
      llmCall: async (chat) => {
        seen = chat;
        return complete("{}");
      },
    });
    const reply = await completeFn("prompt", {
      model: "deepseek-v4-flash",
      maxTokens: 2_000,
      timeoutMs: 5_000,
    });
    assert.equal(reply.text, "{}");
    assert.equal(seen!.model, "deepseek-v4-flash");
    assert.equal(seen!.apiBase, "https://api.deepseek.com");
  });

  it("throws the utility layer's reason as a ReaderCompletionError", async function () {
    const unconfigured = createUtilityReaderCompletion({});
    try {
      await unconfigured("p", { model: "" });
      assert.fail("expected a throw");
    } catch (error) {
      assert.instanceOf(error, ReaderCompletionError);
      assert.equal(
        classifyReaderCompletionError(error).reason,
        "not_configured",
      );
    }
    const failing = createUtilityReaderCompletion({
      apiBase: "https://api.deepseek.com",
      apiKey: "key",
      llmCall: async () => {
        throw new Error("429 Too Many Requests");
      },
    });
    try {
      await failing("p", { model: "deepseek-v4-flash", timeoutMs: 5_000 });
      assert.fail("expected a throw");
    } catch (error) {
      const failure = classifyReaderCompletionError(error);
      assert.equal(failure.reason, "transport");
      assert.equal(failure.status, 429);
      // The exhaustive reader's backoff reads the status from the message.
      assert.match((error as Error).message, /^429\b/);
    }
  });
});

describe("Codex Responses reader completion", function () {
  it("sends one tool-free Responses request on the Codex login", async function () {
    let seen: ChatParams | null = null;
    const completeFn = createCodexResponsesCompletion({
      llmCall: async (chat) => {
        seen = chat;
        return complete("ok");
      },
    });
    const reply = await completeFn("read this", {
      model: "gpt-5.4",
      systemMessages: ["sys"],
    });
    assert.equal(reply.text, "ok");
    assert.equal(seen!.apiBase, DEFAULT_CODEX_API_BASE);
    assert.equal(seen!.authMode, "codex_auth");
    assert.equal(seen!.providerProtocol, "codex_responses");
    assert.equal(seen!.model, "gpt-5.4");
    assert.notProperty(seen!, "tools");
  });

  it("refuses the placeholder model", async function () {
    const completeFn = createCodexResponsesCompletion({
      llmCall: async () => complete("ok"),
    });
    try {
      await completeFn("p", { model: "codex-app-server" });
      assert.fail("expected a throw");
    } catch (error) {
      assert.equal(
        classifyReaderCompletionError(error).reason,
        "not_configured",
      );
    }
  });

  it("bounds a call by timeoutMs when one is given", async function () {
    const completeFn = createCodexResponsesCompletion({
      llmCall: () => new Promise(() => undefined),
    });
    try {
      await completeFn("p", { model: "gpt-5.4", timeoutMs: 20 });
      assert.fail("expected a throw");
    } catch (error) {
      assert.equal(classifyReaderCompletionError(error).reason, "timeout");
    }
  });
});

describe("reader failure classification", function () {
  it("reads plain adapter errors by name and message", function () {
    const abort = new Error("Aborted");
    abort.name = "AbortError";
    assert.equal(classifyReaderCompletionError(abort).reason, "aborted");
    assert.equal(
      classifyReaderCompletionError(
        new Error("The Claude Code bridge did not answer within 180 seconds"),
      ).reason,
      "timeout",
    );
    assert.equal(
      classifyReaderCompletionError(new Error("401 unauthorized")).reason,
      "not_configured",
    );
    assert.equal(
      classifyReaderCompletionError(
        new Error("Codex reader completion did not complete (output_limit)."),
      ).reason,
      "output_limit",
    );
    const busy = classifyReaderCompletionError(new Error("429 slow down"));
    assert.deepEqual([busy.reason, busy.status], ["transport", 429]);
  });
});

describe("reader call limiter", function () {
  it("never runs more than its size at once and hands a freed slot to the next waiter", async function () {
    const limiter = createReaderCallLimiter(2);
    let running = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const task = () =>
      limiter.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => releases.push(resolve));
        running -= 1;
      });
    const all = [task(), task(), task(), task()];
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(limiter.active(), 2);
    assert.equal(limiter.waiting(), 2);
    // A call that arrives as a slot frees must wait behind the queue.
    releases.shift()!();
    const late = task();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(limiter.active(), 2);
    while (releases.length || limiter.active()) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all([...all, late]);
    assert.equal(peak, 2);
  });

  it("drops a waiter on Stop and starts a call's deadline at its slot", async function () {
    const limiter = createReaderCallLimiter(1);
    let release!: () => void;
    const blocker = limiter.run(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const controller = new AbortController();
    const waiting = limiter.run(async () => "ran", controller.signal);
    controller.abort();
    try {
      await waiting;
      assert.fail("expected an abort");
    } catch (error) {
      assert.equal((error as Error).name, "AbortError");
    }
    assert.equal(limiter.waiting(), 0);

    // A call that waits longer than its timeoutMs for a slot still runs,
    // with its full timeoutMs.
    const seenTimeouts: Array<number | undefined> = [];
    const limited = limitReaderCompletion(async (_prompt, options) => {
      seenTimeouts.push(options.timeoutMs);
      return { text: "t" };
    }, limiter);
    const queued = limited("p", { model: "m", timeoutMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    release();
    await blocker;
    assert.equal((await queued).text, "t");
    assert.deepEqual(seenTimeouts, [20]);
  });

  it("bounds a limited call at 15 minutes unless it names its own", async function () {
    const seen: Array<number | undefined> = [];
    const limited = limitReaderCompletion(async (_prompt, options) => {
      seen.push(options.timeoutMs);
      return { text: "t" };
    }, createReaderCallLimiter(1));
    await limited("p", { model: "m" });
    await limited("p", { model: "m", timeoutMs: 7_000 });
    assert.equal(LIMITED_READER_CALL_TIMEOUT_MS, 15 * 60 * 1000);
    assert.deepEqual(seen, [15 * 60 * 1000, 7_000]);
  });
});
