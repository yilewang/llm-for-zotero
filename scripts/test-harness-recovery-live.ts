import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { runHarnessProcess } from "../src/deepseekHarness/process";
import { CodexAppServerProcess } from "../src/utils/codexAppServerProcess";

// Opt-in fault injection. Only model requests reach the configured live provider.
const profile = process.env.LLM_FOR_ZOTERO_LIVE_PROFILE_PATH;
assert(profile, "Set LLM_FOR_ZOTERO_LIVE_PROFILE_PATH to prefs.js");
const prefs = readFileSync(profile, "utf8");
const serialized = prefs.match(
  /user_pref\("extensions\.zotero\.llmforzotero\.modelProviderGroups",\s*("(?:\\.|[^"\\])*")\);/,
)?.[1];
assert(serialized, "Provider groups must be configured");
const group = JSON.parse(JSON.parse(serialized))[1];
assert(
  group?.models?.some((m: any) => m.model === "deepseek-flash"),
  "Provider B must contain deepseek-flash",
);
const worker = resolve("integrations/deepseek-harness/worker.mjs");
(globalThis as any).Zotero = {
  Prefs: {
    get: (key: string) =>
      key.endsWith("deepseekHarnessNodePath") ? process.execPath : worker,
  },
};
const pipe = (stream: any) => {
  const iterator = stream[Symbol.asyncIterator]();
  return {
    readString: async () => {
      const next = await iterator.next();
      return next.done ? "" : next.value.toString();
    },
  };
};
CodexAppServerProcess.loadSubprocessModule = async () =>
  ({
    call: async (options: any) => {
      const child = spawn(options.command, options.arguments, {
        stdio: "pipe",
      });
      const exited = once(child, "exit");
      return {
        stdout: pipe(child.stdout),
        stderr: pipe(child.stderr),
        stdin: {
          write: (value: string) =>
            new Promise<void>((done, reject) =>
              child.stdin.write(value, (error) =>
                error ? reject(error) : done(),
              ),
            ),
          close: async () => {
            child.stdin.end();
          },
        },
        wait: () => exited,
        kill: () => child.kill("SIGKILL"),
      };
    },
  }) as any;
const report: object[] = [];
for (const scenario of [
  "http429",
  "http503",
  "timeout",
  "interruption",
] as const) {
  const root = mkdtempSync(join(tmpdir(), "harness-provider-b-"));
  const controller = new AbortController();
  const events: any[] = [];
  let reads = 0,
    writes = 0,
    requests = 0,
    injected = false,
    enabled = true;
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const hasWrite = body.messages.some(
        (m: any) =>
          m.role === "tool" && String(m.content).includes("WRITE-CONFIRMED-92"),
      );
      requests++;
      if (enabled && !injected && hasWrite) {
        injected = true;
        if (scenario === "http429" || scenario === "http503") {
          response.writeHead(scenario === "http429" ? 429 : 503, {
            "Content-Type": "application/json",
          });
          response.end('{"error":{"message":"injected transient failure"}}');
        } else if (scenario === "interruption")
          setTimeout(() => controller.abort(), 300);
        return;
      }
      const upstreamAbort = new AbortController();
      response.on("close", () => upstreamAbort.abort());
      const upstream = await fetch(
        `${String(group.apiBase).replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${group.apiKey}`,
          },
          body: raw,
          signal: upstreamAbort.signal,
        },
      );
      response.writeHead(upstream.status, {
        "Content-Type":
          upstream.headers.get("content-type") || "application/json",
      });
      if (upstream.body)
        Readable.fromWeb(upstream.body as any)
          .on("error", () => response.destroy())
          .pipe(response);
      else response.end();
    } catch {
      if (!response.destroyed) {
        response.writeHead(502);
        response.end('{"error":{"message":"live fault proxy failed"}}');
      }
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const prompt =
    "This is automatic acceptance testing. First call read_evidence once. Then call save_note once with the evidence. After both tools finish, output the exact evidence and write confirmation. Reuse completed tool results on continuation. Do not repeat tools.";
  const config: any = {
    model: "deepseek-flash",
    apiBase: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    apiKey: group.apiKey,
    contextWindow: 131072,
    maxTokens: 1024,
    temperature: 0,
    systemPrompt:
      "Follow the user's test steps. Tools return the required acceptance tokens.",
    history: [],
    session: { root, key: scenario, userText: prompt, history: [] },
    tools: [
      {
        name: "read_evidence",
        description: "Read acceptance evidence",
        executionClass: "read",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "save_note",
        description: "Save the acceptance note once",
        executionClass: "external_effect",
        inputSchema: {
          type: "object",
          properties: { evidence: { type: "string" } },
          required: ["evidence"],
        },
      },
    ],
  };
  const onToolCall = async (call: any) => {
    if (call.name === "read_evidence") {
      reads++;
      return { ok: true, effect: "none", content: "EVIDENCE-CACHED-42" };
    }
    assert.equal(call.name, "save_note");
    writes++;
    writeFileSync(
      join(root, "verified-note.txt"),
      "WRITE-CONFIRMED-92\nEVIDENCE-CACHED-42",
    );
    return { ok: true, effect: "applied", content: "WRITE-CONFIRMED-92" };
  };
  try {
    let result: any;
    try {
      result = await runHarnessProcess(config, prompt, {
        signal: controller.signal,
        onStop: () => {},
        modelTimeoutMs: scenario === "timeout" ? 30000 : 120000,
        onEvent: async (event) => {
          events.push(event);
        },
        onToolCall,
      });
    } catch (error) {
      if (scenario !== "interruption" || !controller.signal.aborted)
        throw error;
    }
    if (scenario === "interruption") {
      enabled = false;
      const history = [{ role: "user", content: prompt }];
      result = await runHarnessProcess(
        {
          ...config,
          history,
          session: { ...config.session, userText: "继续", history },
        },
        "继续",
        {
          signal: new AbortController().signal,
          onStop: () => {},
          modelTimeoutMs: 120000,
          onEvent: async (event) => {
            events.push(event);
          },
          onToolCall,
        },
      );
      assert(events.some((e) => e.text?.includes("Resumed Harness session")));
    }
    assert(injected, "The intended failure must occur after the write");
    assert.equal(reads, 1);
    assert.equal(writes, 1);
    assert.match(result.text, /EVIDENCE-CACHED-42/);
    assert.match(result.text, /WRITE-CONFIRMED-92/);
    if (scenario.startsWith("http"))
      assert(events.some((e) => e.text?.includes("Retrying model request")));
    if (scenario === "timeout")
      assert(events.some((e) => e.text?.includes("session checkpoint saved")));
    report.push({
      scenario,
      passed: true,
      model: "deepseek-flash",
      reads,
      writes,
      requests,
    });
    console.log(JSON.stringify(report.at(-1)));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  }
}
writeFileSync(
  resolve("tmp/deepseek-harness-recovery-provider-b.json"),
  JSON.stringify({ scenarios: report }, null, 2),
);
