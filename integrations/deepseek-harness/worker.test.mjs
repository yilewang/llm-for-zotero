import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableConversation } from "./durable.mjs";

async function fixture(t, respond) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    respond(response, requests.at(-1), requests.length);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let child;
  let stderr = "";
  const pending = new Map();
  const events = [];
  let sequence = 0;
  let onTool = async () => ({ ok: true, content: { count: 7 } });
  const send = (value) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  const launch = () => {
    child = spawn(process.execPath, [
      fileURLToPath(new URL("./worker.mjs", import.meta.url)),
    ]);
    const owner = child;
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "event") events.push(message.params);
      else if (message.method === "tool_call") {
        void onTool(message.params).then((result) =>
          owner.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n",
          ),
        );
      } else {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
      }
    });
    child.on("exit", () => {
      for (const entry of pending.values())
        entry.reject(new Error(`Worker exited: ${stderr}`));
    });
  };
  launch();
  t.after(async () => {
    const exit = once(child, "exit");
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    await exit;
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  const configuration = {
    model: "fixture-model",
    apiBase: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: "fixture-secret",
    systemPrompt: "Answer using the tools.",
    tools: [
      {
        name: "library_search",
        description: "Search the library",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ],
  };
  return {
    diagnostics: () => stderr,
    request,
    send,
    requests,
    events,
    configuration,
    setTool: (handler) => {
      onTool = handler;
    },
    restart: async () => {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      launch();
    },
  };
}

function stream(response, delta, finish = "stop") {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const choice of [
    { delta: { role: "assistant", ...delta }, finish_reason: null },
    { delta: {}, finish_reason: finish },
  ])
    response.write(
      `data: ${JSON.stringify({ id: "completion-1", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, ...choice }] })}\n\n`,
    );
  response.write(
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

test(
  "real Harness loop calls a host tool, continues, streams, and preserves history roles",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, (response, _request, round) => {
      if (round === 1)
        stream(
          response,
          {
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                type: "function",
                function: {
                  name: "library_search",
                  arguments: '{"query":"test"}',
                },
              },
            ],
          },
          "tool_calls",
        );
      else stream(response, { content: "Found 7 papers." });
    });
    await f.request("initialize", {
      ...f.configuration,
      temperature: 0.2,
      maxTokens: 1024,
      history: [
        { role: "user", content: "Remember fixture-42" },
        { role: "assistant", content: "I remember fixture-42" },
      ],
    });
    const calls = [];
    f.setTool(async (call) => {
      calls.push(call);
      return { ok: true, content: { count: 7 } };
    });
    const result = await f.request("run", { text: "Count the papers." });
    assert.equal(result.text, "Found 7 papers.");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, { query: "test" });
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[0].temperature, 0.2);
    assert.equal(
      f.requests[0].max_tokens ?? f.requests[0].max_completion_tokens,
      1024,
    );
    assert(
      f.requests[0].messages.some(
        (m) => m.role === "assistant" && m.content.includes("fixture-42"),
      ),
    );
    assert(
      f.requests[1].messages.some(
        (m) => m.role === "tool" && m.content.includes('"count":7'),
      ),
    );
    assert.equal(
      f.events
        .filter((e) => e.type === "message_delta")
        .map((e) => e.text)
        .join(""),
      result.text,
    );
    assert(f.events.some((e) => e.type === "usage" && e.promptTokens === 20));
  },
);

test(
  "a denied tool is an error result and the model can answer",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, (response, _request, round) =>
      round === 1
        ? stream(
            response,
            {
              tool_calls: [
                {
                  index: 0,
                  id: "call-2",
                  type: "function",
                  function: {
                    name: "library_search",
                    arguments: '{"query":"test"}',
                  },
                },
              ],
            },
            "tool_calls",
          )
        : stream(response, { content: "Permission denied." }),
    );
    f.setTool(async () => ({
      ok: false,
      content: { error: "Permission denied" },
    }));
    await f.request("initialize", f.configuration);
    const result = await f.request("run", { text: "Use the search tool." });
    assert.equal(result.text, "Permission denied.");
    assert(
      f.requests[1].messages.some(
        (m) => m.role === "tool" && m.content.includes("Permission denied"),
      ),
    );
  },
);

test(
  "cancel interrupts an outstanding provider stream",
  { timeout: 20000 },
  async (t) => {
    let providerStarted;
    const started = new Promise((resolve) => {
      providerStarted = resolve;
    });
    const f = await fixture(t, (response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(": ready\n\n");
      providerStarted();
    });
    await f.request("initialize", f.configuration);
    const run = f.request("run", { text: "Wait for cancellation." });
    const rejected = assert.rejects(run, /Cancelled/);
    await started;
    f.send({ method: "cancel" });
    await rejected;
  },
);

test(
  "provider failures reject the run and redact the key",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, (response) => {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "Invalid fixture-secret",
            type: "authentication_error",
          },
        }),
      );
    });
    await f.request("initialize", f.configuration);
    await assert.rejects(f.request("run", { text: "Hello" }), (error) => {
      assert(!error.message.includes("fixture-secret"));
      return true;
    });
  },
);

const isSummary = (request) =>
  JSON.stringify(request.messages.at(-1)).includes(
    "acting as a compaction engine",
  );
const longHistory = () =>
  Array.from({ length: 24 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content:
      `Archive checkpoint ${i}. Preserve KEY-42 and /vault/paper.md. ` +
      "Earlier research discussion with details. ".repeat(100),
  }));
const checkpoint =
  "## Goal\nPreserve KEY-42 and /vault/paper.md. Continue the current user task. Earlier work is complete.";
const overflow = (response) => {
  response.writeHead(400, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({
      error: {
        message:
          "This model's maximum context length is 4096 tokens. Your messages resulted in 9000 tokens.",
        code: "context_length_exceeded",
        type: "invalid_request_error",
      },
    }),
  );
};

test(
  "compacts imported history before the first answer and accounts for summary usage",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, (response, request) =>
      stream(response, {
        content: isSummary(request) ? checkpoint : "KEY-42 preserved.",
      }),
    );
    await f.request("initialize", {
      ...f.configuration,
      contextWindow: 4096,
      maxTokens: 512,
      history: longHistory(),
    });
    const result = await f.request("run", {
      text: "CURRENT-TASK: recall the key.",
    });
    assert.equal(result.text, "KEY-42 preserved.");
    assert(
      isSummary(f.requests[0]),
      "First request must summarize imported history: " + f.diagnostics(),
    );
    const answer = f.requests.at(-1);
    assert(!isSummary(answer));
    assert(JSON.stringify(answer.messages).includes("<compacted-summary>"));
    assert(JSON.stringify(answer.messages).includes("CURRENT-TASK"));
    assert(
      answer.messages.some(
        (m) =>
          m.role === "system" && m.content.includes("Answer using the tools"),
      ),
    );
    assert(
      JSON.stringify(answer.messages).length <
        JSON.stringify(f.requests[0].messages).length,
    );
    assert(f.events.some((e) => e.type === "context_compacted" && e.automatic));
    const usage = f.events.filter((e) => e.type === "usage");
    assert.equal(usage.length, f.requests.length);
    assert.equal(new Set(usage.map((e) => e.round)).size, usage.length);
    assert.equal(
      f.events
        .filter((e) => e.type === "message_delta")
        .map((e) => e.text)
        .join(""),
      result.text,
    );
  },
);

test(
  "trims a large tool result under pressure without repeating the host action",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, (response, request, round) => {
      if (round === 1)
        stream(
          response,
          {
            tool_calls: [
              {
                index: 0,
                id: "large-result",
                type: "function",
                function: {
                  name: "library_search",
                  arguments: '{"query":"large"}',
                },
              },
            ],
          },
          "tool_calls",
        );
      else
        stream(response, {
          content: isSummary(request)
            ? checkpoint
            : "Read the retained result.",
        });
    });
    let calls = 0;
    f.setTool(async () => {
      calls++;
      return {
        ok: true,
        content: {
          text: "HEAD-KEY " + "verbose detail ".repeat(8000) + " TAIL-KEY",
        },
      };
    });
    await f.request("initialize", {
      ...f.configuration,
      contextWindow: 4096,
      maxTokens: 512,
    });
    await f.request("run", { text: "Read once." });
    assert.equal(calls, 1);
    const retained = f.requests.at(-1).messages.find((m) => m.role === "tool");
    assert(retained, "Tool call and result must remain paired");
    assert(
      retained.content.includes("HEAD-KEY") &&
        retained.content.includes("TAIL-KEY"),
    );
    assert(retained.content.length < 8000);
    assert(
      f.events.some((e) => e.type === "status" && e.text.includes("Trimmed")),
    );
  },
);

test(
  "recovers a provider overflow with one summary and a model retry",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, (response, request, round) => {
      if (round === 1) overflow(response);
      else
        stream(response, {
          content: isSummary(request) ? checkpoint : "Recovered KEY-42.",
        });
    });
    await f.request("initialize", {
      ...f.configuration,
      history: longHistory().slice(0, 4),
    });
    assert.equal(
      (await f.request("run", { text: "Continue." })).text,
      "Recovered KEY-42.",
    );
    assert.equal(f.requests.length, 3);
    assert(isSummary(f.requests[1]));
    assert(
      JSON.stringify(f.requests[2].messages).includes("<compacted-summary>"),
    );
    assert(f.events.some((e) => e.type === "context_compacted"));
  },
);

test(
  "repeated context overflows stop after the recovery retry",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, (response, request) =>
      isSummary(request)
        ? stream(response, { content: checkpoint })
        : overflow(response),
    );
    await f.request("initialize", {
      ...f.configuration,
      history: longHistory().slice(0, 4),
    });
    await assert.rejects(
      f.request("run", { text: "Continue." }),
      /context|overflow/i,
    );
    assert.equal(f.requests.length, 3, f.diagnostics());
  },
);

test(
  "a failed summary preserves the provider error and does not retry the answer",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, (response, request) => {
      if (!isSummary(request)) return overflow(response);
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "Invalid fixture-secret",
            type: "authentication_error",
          },
        }),
      );
    });
    await f.request("initialize", {
      ...f.configuration,
      history: longHistory().slice(0, 4),
    });
    await assert.rejects(
      f.request("run", { text: "Continue." }),
      /context|overflow/i,
    );
    assert.equal(f.requests.length, 2);
    assert(!f.events.some((e) => e.type === "context_compacted"));
    assert(!JSON.stringify(f.events).includes("fixture-secret"));
  },
);

test(
  "cancel interrupts summarization and prevents answer requests and host calls",
  { timeout: 20000 },
  async (t) => {
    let started;
    const summarizing = new Promise((resolve) => {
      started = resolve;
    });
    const f = await fixture(t, (response, request) => {
      assert(isSummary(request));
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(": ready\n\n");
      started();
    });
    let calls = 0;
    f.setTool(async () => {
      calls++;
      return { ok: true };
    });
    await f.request("initialize", {
      ...f.configuration,
      contextWindow: 4096,
      maxTokens: 512,
      history: longHistory(),
    });
    const rejected = assert.rejects(
      f.request("run", { text: "Continue." }),
      /Cancelled/,
    );
    await summarizing;
    f.send({ method: "cancel" });
    await rejected;
    assert.equal(f.requests.length, 1);
    assert.equal(calls, 0);
    assert(!f.events.some((e) => e.type === "context_compacted"));
  },
);

test(
  "rejects invalid context budgets before any provider request",
  { timeout: 20000 },
  async (t) => {
    for (const contextWindow of [0, -1, 3.5, "4096", 512]) {
      const f = await fixture(t, () =>
        assert.fail("Invalid budget must not call the provider"),
      );
      await assert.rejects(
        f.request("initialize", {
          ...f.configuration,
          contextWindow,
          maxTokens: 512,
        }),
        /token limits/,
      );
      assert.equal(f.requests.length, 0);
    }
  },
);

test(
  "overflow recovery after a tool call does not replay the host action",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, (response, request, round) => {
      if (round === 1)
        stream(
          response,
          {
            tool_calls: [
              {
                index: 0,
                id: "committed-action",
                type: "function",
                function: {
                  name: "library_search",
                  arguments: '{"query":"once"}',
                },
              },
            ],
          },
          "tool_calls",
        );
      else if (round === 2) overflow(response);
      else
        stream(response, {
          content: isSummary(request) ? checkpoint : "Action complete.",
        });
    });
    let calls = 0;
    f.setTool(async () => {
      calls++;
      return {
        ok: true,
        content: {
          receipt: "DONE-ONCE",
          details: "Completed operation details. ".repeat(100),
        },
      };
    });
    await f.request("initialize", {
      ...f.configuration,
      history: longHistory().slice(0, 2),
    });
    assert.equal(
      (await f.request("run", { text: "Do the action once." })).text,
      "Action complete.",
    );
    assert.equal(calls, 1);
    assert.equal(f.requests.length, 4);
    assert(f.events.some((e) => e.type === "context_compacted"));
  },
);

test(
  "a truncated proactive summary leaves the original history available",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, (response, request) =>
      isSummary(request)
        ? stream(response, { content: "Incomplete checkpoint" }, "length")
        : stream(response, { content: "Original history available." }),
    );
    await f.request("initialize", {
      ...f.configuration,
      contextWindow: 4096,
      maxTokens: 512,
      history: longHistory(),
    });
    assert.equal(
      (await f.request("run", { text: "Continue." })).text,
      "Original history available.",
    );
    assert.equal(f.requests.length, 2);
    assert(
      JSON.stringify(f.requests[1].messages).includes("Archive checkpoint 0"),
    );
    assert(!f.events.some((e) => e.type === "context_compacted"));
  },
);

function persistentConfig(t, f, text, history = []) {
  const root = mkdtempSync(join(tmpdir(), "zotero-harness-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    ...f.configuration,
    turnText: text,
    history,
    tools: f.configuration.tools.map((tool) => ({
      ...tool,
      executionClass: "read",
    })),
    session: { root, key: "conversation-1", userText: text, history },
  };
}
const toolDelta = (id = "read-1") => ({
  tool_calls: [
    {
      index: 0,
      id,
      type: "function",
      function: {
        name: "library_search",
        arguments: '{"query":"durable-secret-42"}',
      },
    },
  ],
});

test(
  "native resume restores tool results across worker processes without rereading",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, (response, request, round) => {
      if (round === 1) stream(response, toolDelta(), "tool_calls");
      else {
        assert(
          request.messages.some(
            (m) => m.role === "tool" && m.content.includes("durable-result-42"),
          ),
        );
        stream(response, {
          content:
            round === 2 ? "First complete." : "Restored durable-result-42.",
        });
      }
    });
    let executed = 0;
    f.setTool(async () => {
      executed++;
      return { ok: true, effect: "none", content: "durable-result-42" };
    });
    const config = persistentConfig(t, f, "Read once.");
    const first = await f.request("initialize", config);
    await f.request("run", { text: config.turnText });
    await f.restart();
    const history = [
      { role: "user", content: config.turnText },
      { role: "assistant", content: "First complete." },
    ];
    const second = await f.request("initialize", {
      ...config,
      history,
      turnText: "What did you read?",
      session: { ...config.session, history, userText: "What did you read?" },
    });
    assert.equal(second.sessionId, first.sessionId);
    assert.match(
      (await f.request("run", { text: "What did you read?" })).text,
      /durable-result-42/,
    );
    assert.equal(executed, 1);
  },
);

test(
  "a crashed worker reuses an acknowledged write when the model requests it again",
  { timeout: 20000 },
  async (t) => {
    let stalled;
    const stalledRequest = new Promise((resolve) => {
      stalled = resolve;
    });
    const f = await fixture(t, (response, _request, round) => {
      if (round === 1 || round === 3)
        stream(response, toolDelta(`call-${round}`), "tool_calls");
      else if (round === 2) stalled();
      else
        stream(response, { content: "Recovered without a duplicate write." });
    });
    let executed = 0;
    f.setTool(async () => {
      executed++;
      return { ok: true, effect: "applied", content: "written-once" };
    });
    const config = persistentConfig(t, f, "Write once.");
    config.tools[0].executionClass = "external_effect";
    const first = await f.request("initialize", config);
    const interrupted = f
      .request("run", { text: config.turnText })
      .catch(() => undefined);
    await stalledRequest;
    await f.restart();
    await interrupted;
    const history = [{ role: "user", content: config.turnText }];
    const second = await f.request("initialize", {
      ...config,
      history,
      turnText: "继续",
      session: { ...config.session, history, userText: "继续" },
    });
    assert.equal(second.sessionId, first.sessionId);
    await f.request("run", { text: "继续" });
    assert.equal(executed, 1);
    assert(
      f.events.some((e) => e.text?.includes("Reused completed tool result")),
    );
  },
);

test(
  "crash before a write acknowledgement blocks automatic re-execution",
  { timeout: 20000 },
  async (t) => {
    let dispatched;
    const sent = new Promise((resolve) => {
      dispatched = resolve;
    });
    const f = await fixture(t, (response, _request, round) => {
      if (round <= 2)
        stream(response, toolDelta(`uncertain-${round}`), "tool_calls");
      else stream(response, { content: "Inspect the target before writing." });
    });
    let executed = 0;
    f.setTool(async () => {
      executed++;
      dispatched();
      return new Promise(() => {});
    });
    const config = persistentConfig(t, f, "Write once.");
    config.tools[0].executionClass = "external_effect";
    await f.request("initialize", config);
    const interrupted = f
      .request("run", { text: config.turnText })
      .catch(() => undefined);
    await sent;
    await f.restart();
    await interrupted;
    const history = [{ role: "user", content: config.turnText }];
    await f.request("initialize", {
      ...config,
      history,
      turnText: "继续",
      session: { ...config.session, history, userText: "继续" },
    });
    await f.request("run", { text: "继续" });
    assert.equal(executed, 1);
    assert(
      f.requests
        .at(-1)
        .messages.some(
          (m) => m.role === "tool" && m.content.includes("unconfirmed"),
        ),
    );
  },
);

test(
  "checkpoint interrupts a stalled model and resumes the same live session",
  { timeout: 20000 },
  async (t) => {
    let stalled;
    const waiting = new Promise((resolve) => {
      stalled = resolve;
    });
    const f = await fixture(t, (response, _request, round) => {
      if (round === 1) stream(response, toolDelta(), "tool_calls");
      else if (round === 2) stalled();
      else stream(response, { content: "Continued after checkpoint." });
    });
    let executed = 0;
    f.setTool(async () => {
      executed++;
      return { ok: true, effect: "none", content: "cached evidence" };
    });
    const config = persistentConfig(t, f, "Start.");
    const session = await f.request("initialize", config);
    const interrupted = f
      .request("run", { text: "Start." })
      .catch((e) => e.message);
    await waiting;
    assert.equal(
      (await f.request("checkpoint", {})).sessionId,
      session.sessionId,
    );
    await interrupted;
    assert.equal(
      (await f.request("run", { text: "Continue.", resume: true })).text,
      "Continued after checkpoint.",
    );
    assert.equal(executed, 1);
  },
);

for (const code of [429, 503])
  test(
    `transient HTTP ${code} retries the failed request without repeating its completed tool`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t, (response, request, round) => {
        if (round === 1) stream(response, toolDelta(), "tool_calls");
        else if (round === 2) {
          response.writeHead(code, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              error: { message: "temporary provider failure" },
            }),
          );
        } else {
          assert(request.messages.some((m) => m.role === "tool"));
          stream(response, { content: "Retry succeeded." });
        }
      });
      let executed = 0;
      f.setTool(async () => {
        executed++;
        return { ok: true, content: "done" };
      });
      await f.request("initialize", f.configuration);
      assert.equal(
        (await f.request("run", { text: "Start." })).text,
        "Retry succeeded.",
      );
      assert.equal(executed, 1);
      assert.equal(f.requests.length, 3);
      assert(
        f.events.some((e) => e.text?.includes("Retrying model request (1/3)")),
      );
    },
  );

test(
  "transient failures stop after three retries",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, (response) => {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end('{"error":{"message":"unavailable"}}');
    });
    await f.request("initialize", f.configuration);
    await assert.rejects(
      f.request("run", { text: "Start." }),
      /unavailable|503/,
    );
    assert.equal(f.requests.length, 4);
  },
);

test(
  "cancellation during retry backoff stops further requests",
  { timeout: 20000 },
  async (t) => {
    let notify;
    const retry = new Promise((resolve) => {
      notify = resolve;
    });
    const f = await fixture(t, (response) => {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end('{"error":{"message":"unavailable"}}');
    });
    await f.request("initialize", f.configuration);
    const run = f.request("run", { text: "Start." }).catch((e) => e.message);
    const poll = setInterval(() => {
      if (f.events.some((e) => e.text?.includes("Retrying model request"))) {
        clearInterval(poll);
        notify();
      }
    }, 5);
    t.after(() => clearInterval(poll));
    await retry;
    f.send({ method: "cancel" });
    await run;
    assert.equal(f.requests.length, 1);
  },
);

test(
  "imported chat history remains valid after persistence and native resume",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, (response, request) => {
      assert(
        request.messages.some((m) => m.content?.includes?.("imported-marker")),
      );
      stream(response, { content: "ok" });
    });
    const history = [
      { role: "user", content: "Remember imported-marker" },
      { role: "assistant", content: "Remembered." },
    ];
    const config = persistentConfig(t, f, "Start.", history);
    const first = await f.request("initialize", config);
    await f.request("run", { text: "Start." });
    await f.restart();
    const next = [
      ...history,
      { role: "user", content: "Start." },
      { role: "assistant", content: "ok" },
    ];
    const second = await f.request("initialize", {
      ...config,
      history: next,
      turnText: "Continue?",
      session: { ...config.session, history: next, userText: "Continue?" },
    });
    assert.equal(second.sessionId, first.sessionId);
    await f.request("run", { text: "Continue?" });
  },
);

test(
  "conversation identity and edited user history start isolated sessions",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, (response) =>
      stream(response, { content: "ok" }),
    );
    const config = persistentConfig(t, f, "Original.");
    const first = await f.request("initialize", config);
    await f.request("run", { text: "Original." });
    await f.restart();
    const changed = [
      { role: "user", content: "Edited question" },
      { role: "assistant", content: "ok" },
    ];
    const second = await f.request("initialize", {
      ...config,
      history: changed,
      turnText: "Continue?",
      session: { ...config.session, history: changed, userText: "Continue?" },
    });
    assert.notEqual(second.sessionId, first.sessionId);
    await f.request("run", { text: "Continue?" });
    await f.restart();
    const third = await f.request("initialize", {
      ...config,
      session: { ...config.session, key: "different-conversation" },
    });
    assert.notEqual(third.sessionId, first.sessionId);
    await f.request("run", { text: "Original." });
  },
);

test(
  "compacted context survives a cold native resume",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, (response, request) =>
      stream(response, {
        content: isSummary(request) ? checkpoint : "KEY-42 preserved.",
      }),
    );
    const history = longHistory();
    const config = {
      ...persistentConfig(t, f, "Recall.", history),
      contextWindow: 4096,
      maxTokens: 512,
    };
    const first = await f.request("initialize", config);
    await f.request("run", { text: "Recall." });
    assert(f.events.some((e) => e.type === "context_compacted"));
    await f.restart();
    const next = [
      ...history,
      { role: "user", content: "Recall." },
      { role: "assistant", content: "KEY-42 preserved." },
    ];
    const second = await f.request("initialize", {
      ...config,
      history: next,
      turnText: "Again?",
      session: { ...config.session, history: next, userText: "Again?" },
    });
    assert.equal(first.sessionId, second.sessionId);
    await f.request("run", { text: "Again?" });
    assert(JSON.stringify(f.requests.at(-1).messages).includes("KEY-42"));
    assert(
      !JSON.stringify(f.requests.at(-1).messages).includes(
        "Archive checkpoint 0",
      ),
    );
  },
);

test(
  "recovery reuses a completed read with enriched turn context and a new instruction can repeat it",
  { timeout: 20000 },
  async (t) => {
    let stalled;
    const waiting = new Promise((resolve) => (stalled = resolve));
    const f = await fixture(t, (response, _request, round) => {
      if ([1, 3, 5].includes(round))
        stream(response, toolDelta(`call-${round}`), "tool_calls");
      else if (round === 2) stalled();
      else stream(response, { content: "ok" });
    });
    let executed = 0;
    f.setTool(async () => {
      executed++;
      return { ok: true, effect: "none", content: "evidence" };
    });
    const config = persistentConfig(t, f, "Read.");
    await f.request("initialize", config);
    const interrupted = f
      .request("run", { text: "Read." })
      .catch(() => undefined);
    await waiting;
    await f.restart();
    await interrupted;
    const history = [{ role: "user", content: "Read." }];
    await f.request("initialize", {
      ...config,
      history,
      turnText: "Current PDF context\n继续",
      session: { ...config.session, history, userText: "继续" },
    });
    await f.request("run", { text: "Current PDF context\n继续" });
    assert.equal(executed, 1);
    await f.restart();
    const next = [
      ...history,
      { role: "user", content: "继续" },
      { role: "assistant", content: "ok" },
    ];
    await f.request("initialize", {
      ...config,
      history: next,
      turnText: "Refresh now.",
      session: { ...config.session, history: next, userText: "Refresh now." },
    });
    await f.request("run", { text: "Refresh now." });
    assert.equal(executed, 2);
  },
);

for (const code of [400, 401, 403])
  test(
    `HTTP ${code} is not automatically retried`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t, (response) => {
        response.writeHead(code, { "Content-Type": "application/json" });
        response.end('{"error":{"message":"request denied"}}');
      });
      await f.request("initialize", { ...f.configuration, tools: [] });
      await assert.rejects(f.request("run", { text: "Start." }));
      assert.equal(f.requests.length, 1);
    },
  );

test("recovery retains acknowledged commands when later writes invalidate read caches", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "harness-journal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const durable = new DurableConversation({
    apiBase: "http://fixture",
    model: "fixture",
    apiKey: "fixture-secret",
    turnText: "Start.",
    session: { root, key: "commands" },
  });
  const tool = { name: "run_command", executionClass: "external_effect" };
  let calls = 0;
  const dispatch = async () => {
    calls++;
    return { ok: true, effect: "none", content: "command acknowledged" };
  };
  await durable.execute(tool, { command: "first" }, dispatch, () => {});
  durable.recover();
  await durable.execute(
    tool,
    { command: "second" },
    async () => ({ ok: true, effect: "applied", content: "second write" }),
    () => {},
  );
  await durable.execute(tool, { command: "first" }, dispatch, () => {});
  assert.equal(calls, 1);
});

test(
  "quota exhaustion is not retried as a transient rate limit",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, (response) => {
      response.writeHead(429, { "Content-Type": "application/json" });
      response.end(
        '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","code":"insufficient_quota"}}',
      );
    });
    await f.request("initialize", f.configuration);
    await assert.rejects(f.request("run", { text: "Start." }));
    assert.equal(f.requests.length, 1);
  },
);
