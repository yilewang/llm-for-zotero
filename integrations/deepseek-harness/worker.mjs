import { createInterface } from "node:readline";
import process from "node:process";
import { URL } from "node:url";
import { randomUUID } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import Compaction from "@deepseek-ai/dsh-compaction-basic";
import ToolResultPruner from "@deepseek-ai/dsh-compaction-tool-result-pruner";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import Agents from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import Llm, {
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
} from "@deepseek-ai/dsh-llm";
import * as PiAi from "@deepseek-ai/dsh-llm-pi-ai";
import Sessions from "@deepseek-ai/dsh-session";
import Projections from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import Persistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import * as Retry from "@deepseek-ai/dsh-llm-retry";
import { DurableConversation } from "./durable.mjs";

process.umask(0o077);

// Private, newline-delimited RPC over the owning Zotero process's pipes.
// The worker loads the agent kernel and proxies the registered Zotero tools.
const input = createInterface({ input: process.stdin });
const pending = new Map();
let context;
let agent;
let initialized = false;
let running = false;
let cancelled = false;
let nextId = 0;
let apiKey = "";
let durable;
let checkpointing = false;
let activeRun;

const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const event = (value) => send({ method: "event", params: value });
const safeError = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  return apiKey ? message.split(apiKey).join("[redacted]") : message;
};

function callHost(name, args, signal) {
  if (signal.aborted) return Promise.reject(new Error("Cancelled"));
  const id = `tool-${++nextId}`;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      pending.delete(id);
      reject(new Error("Cancelled"));
    };
    pending.set(id, {
      resolve: (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      reject,
    });
    signal.addEventListener("abort", onAbort, { once: true });
    send({ id, method: "tool_call", params: { name, args, callId: id } });
  });
}

async function initialize(config) {
  if (initialized || context) throw new Error("Already initialized");
  if (
    !config ||
    typeof config.model !== "string" ||
    !config.model.trim() ||
    typeof config.apiKey !== "string" ||
    !config.apiKey ||
    !Array.isArray(config.tools)
  )
    throw new Error("Invalid Harness configuration");
  const contextWindow = config.contextWindow ?? 131072;
  const maxTokens =
    config.maxTokens ?? Math.min(8192, Math.floor(contextWindow / 4));
  if (
    !Number.isSafeInteger(contextWindow) ||
    contextWindow <= 0 ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens <= 0 ||
    maxTokens >= contextWindow
  )
    throw new Error(
      `Expected positive token limits with output below context capacity (context: ${contextWindow}, output: ${maxTokens})`,
    );
  const headroomTokens = Math.min(
    8192,
    Math.floor((contextWindow - maxTokens) / 8),
  );
  const url = new URL(config.apiBase);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Expected an HTTP(S) provider endpoint");
  apiKey = config.apiKey;
  process.env.LFZ_HARNESS_API_KEY = apiKey;
  context = new Context();
  await context.plugin(Llm);
  await context.plugin(Sessions);
  await context.plugin(Projections);
  if (config.session) {
    durable = new DurableConversation(config);
    await context.plugin(Persistence, { root: durable.root });
  }
  await context.plugin(SystemPrompt, {
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
    personaPrefix: config.systemPrompt || "",
  });
  await context.plugin(Tools, { mode: "native" });
  await context.plugin(Agents);
  await context.plugin(PiAi, {
    providers: {
      "zotero-provider": {
        api: "openai-completions",
        apiKeyEnv: "LFZ_HARNESS_API_KEY",
        baseURL: url.href.replace(/\/$/, ""),
        models: [
          {
            id: config.model,
            contextWindow,
            maxTokens,
          },
        ],
        compat: { supportsStore: false },
        retryPolicy: {
          mode: "normal",
          maxRetries: 3,
          backoff: {
            initialDelayMs: 1000,
            maxDelayMs: 10000,
            jitterRatio: 0.2,
          },
        },
      },
    },
  });
  for (const tool of config.tools) {
    context.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: value }],
      },
      async execute(args, execution) {
        await context.sessions.flush(agent.session);
        const dispatch = () => callHost(tool.name, args, execution.signal);
        const result = durable
          ? await durable.execute(tool, args, dispatch, (text) =>
              event({ type: "status", text }),
            )
          : await dispatch();
        if (!result.ok) throw new Error(JSON.stringify(result));
        return JSON.stringify(result);
      },
    });
  }
  await context.plugin(TokenMeter);
  await context.plugin(ToolResultPruner);
  await context.plugin(Compaction, {
    auto: true,
    headroomTokens,
    maxTokens: Math.min(4096, maxTokens),
    maxOverflowRetries: 1,
  });
  await context.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
  await context.plugin(Retry);
  if (Number.isFinite(config.temperature)) {
    context.on("agent/request", async (_payload, next) => ({
      ...(await next()),
      temperature: config.temperature,
    }));
  }
  const agentOptions = {
    provider: "zotero-provider",
    model: config.model,
    maxTokens,
  };
  const existing =
    durable &&
    (await context.sessionPersistence.stat(durable.binding.sessionId));
  const seed = [];
  const append = (type, data, options = {}) =>
    seed.push({ type, data, seq: seed.length, time: Date.now(), ...options });
  if (!existing) {
    append("turn/start", { turn: 1 });
    append("step/start", { turn: 1, step: 1 });
    append(
      "system/message",
      {
        turn: 1,
        step: 1,
        message: createSystemMessage(config.systemPrompt || ""),
      },
      { surfaceOp: "append" },
    );
    append("step/end", { turn: 1, step: 1 });
    let historyStep = 2;
    for (const message of config.history || []) {
      if (
        !message ||
        !["user", "assistant"].includes(message.role) ||
        typeof message.content !== "string"
      )
        throw new Error("Invalid text history");
      const content = [{ type: "text", text: message.content }];
      if (message.role === "user") {
        append(
          "user/message",
          createUserMessage({ content, source: { kind: "user" } }),
          { surfaceOp: "append" },
        );
      } else {
        const step = historyStep++;
        append("step/start", { turn: 1, step });
        append(
          "assistant/message",
          {
            turn: 1,
            step,
            message: createAssistantMessage({
              content,
              source: { provider: "zotero-provider", model: config.model },
            }),
            stream: [],
          },
          { surfaceOp: "append" },
        );
        append("step/end", { turn: 1, step });
      }
    }
    // The pre-step pressure check also applies to imported Zotero history.
    append("request/header", {
      header: {
        config: { provider: "zotero-provider", model: config.model, maxTokens },
        ...(config.tools.length
          ? {
              tools: config.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              })),
            }
          : {}),
      },
      reason: "initial",
    });
    append("turn/end", { turn: 1, reason: { kind: "completed" } });
  }
  const handle = existing
    ? await context.agents.resume({
        resumeSessionId: durable.binding.sessionId,
        agentOptions,
      })
    : await context.agents.create({
        sessionId: durable?.binding.sessionId || `zotero-${randomUUID()}`,
        agentOptions,
        seed,
      });
  agent = handle.agent;
  await context.sessions.flush(agent.session);
  durable?.commit();
  if (existing)
    event({
      type: "status",
      text: `Resumed Harness session ${agent.id}; completed tool results and compaction history restored`,
    });
  initialized = true;
  return { version: "0.2.0-rc.2", sessionId: agent.id };
}

async function run(text, resume = false) {
  if (!initialized || running || typeof text !== "string")
    throw new Error("Invalid run request");
  running = true;
  durable?.finish("running");
  let finalText = "";
  let failure;
  let stopReason;
  const disposers = [];
  let usageSequence = 0;
  const reportUsage = (usage) =>
    event({
      type: "usage",
      round: ++usageSequence,
      promptTokens:
        usage.inputTokens +
        (usage.cacheReadTokens || 0) +
        (usage.cacheWriteTokens || 0),
      completionTokens: usage.outputTokens,
      totalTokens:
        usage.totalTokens ??
        usage.inputTokens +
          (usage.cacheReadTokens || 0) +
          (usage.cacheWriteTokens || 0) +
          usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    });
  try {
    disposers.push(
      context.on("agent/assistant-stream", ({ frame }) => {
        if (frame.type !== "chunk") return;
        const chunk = frame.chunk;
        if (chunk.type === "text-delta")
          event({ type: "message_delta", text: chunk.text });
        if (chunk.type === "reasoning-delta")
          event({
            type: "reasoning",
            round: frame.revision,
            details: chunk.text,
          });
        if (chunk.type === "usage") reportUsage(chunk.usage);
      }),
    );
    disposers.push(
      context.on("agent/error", ({ error }) => {
        failure = error;
      }),
    );
    disposers.push(
      context.on("session/event", (_session, entry) => {
        if (entry.type === "assistant/message") {
          finalText = entry.data.message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
        }
        if (entry.type === "compaction/start")
          event({ type: "status", text: "Compacting context" });
        if (entry.type === "compaction/summary" && entry.data.usage)
          reportUsage(entry.data.usage);
        if (entry.type === "compaction/end" && !entry.data.error)
          event({ type: "context_compacted", automatic: true });
        if (entry.type === "tool/result" && entry.surfaceOp?.op === "replace")
          event({ type: "status", text: "Trimmed a large tool result" });
        if (entry.type === "turn/end") stopReason = entry.data.reason;
        if (entry.type === "llm/retry")
          event({
            type: "status",
            text: `Retrying model request (${entry.data.retry}/${entry.data.maxRetries}) after ${entry.data.failure.code}`,
          });
      }),
    );
    await new Promise((resolve) => {
      const dispose = context.on("agent/status", ({ status }) => {
        if (status === "idle") {
          dispose();
          resolve();
        }
      });
      agent.followup(
        createUserMessage({
          content: [
            {
              type: "text",
              text:
                resume || durable?.recovering
                  ? `${text}\n\nContinue from this session's completed steps and tool results. Do not repeat completed reads or effects. Inspect targets for any unconfirmed tool outcome before proposing a write.`
                  : text,
            },
          ],
          source: { kind: "user" },
        }),
      );
    });
    if (cancelled) throw new Error("Cancelled");
    if (failure) throw failure;
    if (stopReason && stopReason.kind !== "completed")
      throw new Error(`Harness turn ended: ${JSON.stringify(stopReason)}`);
    if (!finalText.trim()) throw new Error("Harness returned no answer");
    durable?.finish("completed");
    return { text: finalText, sessionId: agent.id };
  } finally {
    if (durable && durable.binding.status !== "completed")
      durable.finish("interrupted");
    await context.sessions.flush(agent.session);
    for (const dispose of disposers) dispose();
    running = false;
  }
}

input.on("line", (line) => {
  void (async () => {
    let message;
    try {
      message = JSON.parse(line);
      if (pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        message.error
          ? entry.reject(new Error(message.error.message))
          : entry.resolve(message.result);
        return;
      }
      let result;
      if (message.method === "initialize")
        result = await initialize(message.params);
      else if (message.method === "run")
        result = await (activeRun = run(
          message.params?.text,
          message.params?.resume,
        ));
      else if (message.method === "checkpoint") {
        if (checkpointing) throw new Error("Checkpoint already in progress");
        checkpointing = true;
        try {
          agent.cancel({ kind: "user" });
          await agent.whenIdle();
          await activeRun?.catch(() => undefined);
          await context.sessions.flush(agent.session);
          durable?.recover();
          result = { sessionId: agent.id };
        } finally {
          checkpointing = false;
        }
      } else if (message.method === "cancel") {
        cancelled = true;
        agent?.cancel({ kind: "user" });
        return;
      } else throw new Error("Unknown Harness method");
      send({ id: message.id, result });
    } catch (error) {
      send({
        id: message?.id ?? null,
        error: { code: -32603, message: safeError(error) },
      });
    }
  })();
});
input.on("close", () => {
  cancelled = true;
  agent?.cancel({ kind: "user" });
  for (const entry of pending.values())
    entry.reject(new Error("Host disconnected"));
  pending.clear();
  void context?.fiber.dispose().finally(() => process.exit(0));
});
