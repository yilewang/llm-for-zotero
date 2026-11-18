/**
 * Runs the ACP conformance checks (test/helpers/acp/conformance.ts).
 *
 *   npm run check:acp-conformance                 # fake agent, in-process and stdio
 *   npm run check:acp-conformance -- --live       # also the installed agy (spends quota)
 *   npm run check:acp-conformance -- --live-only [--agy <path>] [--keep]
 *
 * Exits non-zero when any check fails. `info` results are printed, not judged.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { AcpMcpServer } from "../src/shared/acpProtocol";
import type { AcpByteDuplex } from "../test/helpers/acp/acpTestClient";
import {
  CONFORMANCE_FAKE_SCENARIOS,
  CONFORMANCE_MCP_SERVER_NAME,
  CONFORMANCE_MCP_TOOL,
  CONFORMANCE_TOOL_RESULT,
  runAcpConformance,
  type ConformanceResult,
  type ConformanceTarget,
} from "../test/helpers/acp/conformance";
import {
  FakeAcpAgent,
  createMemoryFakeAcpSessionStore,
} from "../test/helpers/acp/fakeAcpAgent";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

// ------------------------------------------------------------ MCP stub

const MCP_BEARER = "conformance-token";

function startMcpStub(): Promise<{
  server: Server;
  url: string;
  calls: string[];
}> {
  const calls: string[] = [];
  const tools = [
    {
      name: CONFORMANCE_MCP_TOOL,
      description: "Look up a paper by keyword in the user's Zotero library.",
      inputSchema: {
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      },
    },
  ];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.method !== "POST") return void res.writeHead(405).end();
      if (req.headers.authorization !== `Bearer ${MCP_BEARER}`) {
        return void res.writeHead(401).end();
      }
      const message = JSON.parse(body) as {
        id?: number;
        method: string;
        params?: any;
      };
      calls.push(
        message.params?.name
          ? `${message.method}:${message.params.name}`
          : message.method,
      );
      if (message.id === undefined) return void res.writeHead(202).end();
      const reply = (payload: object) =>
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...payload }));
      switch (message.method) {
        case "initialize":
          return reply({
            result: {
              protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "zotero-conformance-stub", version: "0" },
            },
          });
        case "tools/list":
          return reply({ result: { tools } });
        case "tools/call":
          return reply({
            result: {
              content: [{ type: "text", text: CONFORMANCE_TOOL_RESULT }],
            },
          });
        case "ping":
          return reply({ result: {} });
        default:
          return reply({
            error: {
              code: -32601,
              message: `Method not found: ${message.method}`,
            },
          });
      }
    });
  });
  return new Promise((resolveStart) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolveStart({ server, url: `http://127.0.0.1:${port}/mcp`, calls });
    });
  });
}

// ------------------------------------------------------------ connections

function spawnDuplex(
  command: string,
  commandArgs: string[],
  cwd: string,
): AcpByteDuplex {
  const child = spawn(command, commandArgs, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on(
    "data",
    (chunk: string) => (stderr = (stderr + chunk).slice(-4000)),
  );
  child.on("exit", (code, signal) => {
    if (code && code !== 0 && signal === null) {
      process.stderr.write(`[${command}] exited ${code}\n${stderr}\n`);
    }
  });
  return {
    write: (chunk) => void child.stdin.write(chunk),
    onOutput: (listener) => {
      child.stdout.on("data", listener);
      return () => void child.stdout.off("data", listener);
    },
    close: () => {
      child.stdin.end();
      child.kill();
    },
  };
}

function inProcessDuplex(agent: FakeAcpAgent): AcpByteDuplex {
  return {
    write: (chunk) => queueMicrotask(() => agent.write(chunk)),
    onOutput: (listener) =>
      agent.onOutput((chunk) => queueMicrotask(() => listener(chunk))),
    close: () => agent.close(),
  };
}

function findAgy(): string {
  const explicit = option("--agy");
  if (explicit) return explicit;
  const candidates = [
    join(homedir(), ".local", "bin", "agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("agy not found; pass --agy <path>");
  return found;
}

// ------------------------------------------------------------ run

type NamedTarget = {
  name: string;
  build: (mcp: AcpMcpServer, dir: string) => ConformanceTarget;
};

const targets: NamedTarget[] = [];
if (!flag("--live-only")) {
  targets.push({
    name: "fake (in-process)",
    build: (mcpServer, dir) => {
      const store = createMemoryFakeAcpSessionStore();
      return {
        connect: async () =>
          inProcessDuplex(
            new FakeAcpAgent({
              store,
              authPendingRequests: 2,
              scenarios: CONFORMANCE_FAKE_SCENARIOS,
            }),
          ),
        sessionCwd: join(dir, "session"),
        mcpServer,
        readiness: { attempts: 5, delayMs: 10 },
        turnTimeoutMs: 10_000,
      };
    },
  });
  targets.push({
    name: "fake (stdio)",
    build: (mcpServer, dir) => ({
      connect: async () =>
        spawnDuplex(
          join(REPO_ROOT, "node_modules", ".bin", "tsx"),
          [
            join(REPO_ROOT, "scripts", "fake-acp-agent.ts"),
            "--store",
            join(dir, "fake-sessions.json"),
            "--auth-pending",
            "1",
            "--scenarios",
            "conformance",
          ],
          dir,
        ),
      sessionCwd: join(dir, "session"),
      mcpServer,
      readiness: { attempts: 5, delayMs: 50 },
      turnTimeoutMs: 15_000,
    }),
  });
}
if (flag("--live") || flag("--live-only")) {
  targets.push({
    name: "agy (live)",
    build: (mcpServer, dir) => {
      const agy = findAgy();
      const sessionDir = join(dir, "session");
      return {
        connect: async () => spawnDuplex(agy, ["acp"], sessionDir),
        sessionCwd: sessionDir,
        mcpServer,
        readiness: { attempts: 20, delayMs: 500 },
        turnTimeoutMs: 180_000,
        workingDirectoryProbe: {
          connectInDir: async (processDir) =>
            spawnDuplex(agy, ["acp"], processDir),
          sessionDir: join(dir, "probe-session"),
          processDir: join(dir, "probe-process"),
          fileExists: async (path) => existsSync(path),
        },
      };
    },
  });
}

async function main(): Promise<void> {
  const stub = await startMcpStub();
  const mcpServer: AcpMcpServer = {
    type: "http",
    name: CONFORMANCE_MCP_SERVER_NAME,
    url: stub.url,
    headers: [{ name: "Authorization", value: `Bearer ${MCP_BEARER}` }],
  };
  let failures = 0;
  try {
    for (const target of targets) {
      // realpath matters on macOS, where tmpdir() is a /var -> /private/var symlink.
      const real = realpathSync(
        mkdtempSync(join(tmpdir(), "llm4z-acp-conformance-")),
      );
      for (const sub of ["session", "probe-session", "probe-process"]) {
        mkdirSync(join(real, sub), { recursive: true });
      }
      console.log(`\n=== ${target.name} (${real})`);
      const callsBefore = stub.calls.length;
      let results: ConformanceResult[];
      try {
        results = await runAcpConformance({
          ...target.build(mcpServer, real),
          log: (line) => console.log(`  ${line}`),
        });
      } catch (error) {
        console.log(`  FAIL run aborted: ${(error as Error)?.stack ?? error}`);
        failures += 1;
        continue;
      } finally {
        if (!flag("--keep")) rmSync(real, { recursive: true, force: true });
      }
      console.log(
        `  MCP stub saw: ${stub.calls.slice(callsBefore).join(", ") || "nothing"}`,
      );
      const failed = results.filter((result) => result.status === "fail");
      failures += failed.length;
      console.log(
        `  ${results.filter((r) => r.status === "pass").length} passed, ${failed.length} failed, ` +
          `${results.filter((r) => r.status === "info").length} info`,
      );
    }
  } finally {
    stub.server.close();
  }
  if (failures > 0) {
    console.log(`\n${failures} conformance failure(s).`);
    process.exit(1);
  }
  console.log("\nAll conformance checks passed.");
}

void main();
