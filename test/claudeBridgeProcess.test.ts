import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import {
  claudeBridgeFetch,
  ensureClaudeBridgeRunning,
  filterClaudeBridgeExtraArgs,
  getClaudeBridgeStatus,
  isManagedClaudeBridgeIdle,
  parseClaudeBridgeExtraArgs,
  parseClaudeBridgeReadyLine,
  resetClaudeBridgeProcessForTests,
  restartClaudeBridge,
  shutdownClaudeBridge,
  stopClaudeBridge,
  detectLegacyClaudeBridge,
  describeLegacyClaudeBridgeRemoval,
} from "../src/claudeCode/bridgeProcess";
import { runGeckoSubprocessForOutput } from "../src/utils/geckoSubprocess";
import { parseNodeMajorVersion } from "../src/claudeCode/bridgeBinaries";
import {
  MANAGED_CLAUDE_BRIDGE_PLACEHOLDER_URL,
  getManagedClaudeBridgeBaseUrl,
  matchManagedClaudeBridgeBase,
  resetManagedClaudeBridgeEndpointForTests,
  setManagedClaudeBridgeBaseUrl,
} from "../src/claudeCode/bridgeEndpoint";
import {
  getClaudeBridgeMode,
  getClaudeBridgeUrl,
  setClaudeBridgeUrl,
} from "../src/claudeCode/prefs";

type SpawnRecord = {
  command: string;
  arguments: string[];
  environment: Record<string, string>;
};

type FakeBridge = {
  exit: () => void;
  stdinClosed: boolean;
};

const PREFIX = "extensions.zotero.llmforzotero.";

describe("Claude Code bridge process", function () {
  const globalScope = globalThis as any;
  const saved: Record<string, unknown> = {};
  let prefs: Record<string, unknown>;
  let files: Map<string, Uint8Array>;
  let existing: Set<string>;
  let spawns: SpawnRecord[];
  let writes: Array<{ path: string; tmpPath?: string }>;
  let bridges: FakeBridge[];
  let fetched: string[];
  let nodeVersion: string;
  let readyPort: number;
  let exitBeforeReady = false;
  let closeGate: Promise<void> | null = null;
  let legacyHealth: unknown;
  let notices: Array<{ text: string; closeMs?: number }>;

  function makeBridgeProcess(): any {
    let readyLines = exitBeforeReady
      ? ["[cc-llm4zotero-adapter] crashing\n"]
      : [
          "[cc-llm4zotero-adapter] listening\n",
          `CLAUDE_BRIDGE_READY ${JSON.stringify({ host: "127.0.0.1", port: readyPort, version: "3.9.12", stateDir: "/home/u/Zotero/agent-state", logFile: "/home/u/Zotero/agent-state/bridge.log" })}\n`,
        ];
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const bridge: FakeBridge = {
      stdinClosed: false,
      exit: () => finish(),
    };
    bridges.push(bridge);
    if (exitBeforeReady) finish();
    return {
      stdout: {
        readString: async () => {
          if (readyLines.length) return readyLines.shift();
          await finished;
          readyLines = [];
          return "";
        },
      },
      stdin: {
        close: async () => {
          await closeGate;
          bridge.stdinClosed = true;
          finish();
        },
      },
      wait: async () => {
        await finished;
        return { exitCode: 0 };
      },
      kill: async () => {
        finish();
        return { exitCode: 1 };
      },
    };
  }

  function makeOutputProcess(output: string): any {
    let sent = false;
    return {
      stdout: {
        readString: async () => {
          if (sent) return "";
          sent = true;
          return output;
        },
      },
      wait: async () => ({ exitCode: 0 }),
    };
  }

  const fakeSubprocess = {
    call: async (options: any) => {
      const args: string[] = options.arguments || [];
      if (args[1] === "command -v node")
        return makeOutputProcess("/usr/bin/node\n");
      if (args[1] === "command -v claude") {
        return makeOutputProcess("/home/u/.local/bin/claude\n");
      }
      if (options.command === "/usr/bin/node" && args[0] === "--version") {
        return makeOutputProcess(`${nodeVersion}\n`);
      }
      if (options.command === "/usr/bin/node") {
        spawns.push({
          command: options.command,
          arguments: args,
          environment: options.environment || {},
        });
        return makeBridgeProcess();
      }
      throw new Error(`unexpected command ${options.command}`);
    },
  };

  beforeEach(function () {
    for (const key of [
      "Zotero",
      "IOUtils",
      "ChromeUtils",
      "Services",
      "rootURI",
      "fetch",
      "ztoolkit",
    ]) {
      saved[key] = globalScope[key];
    }
    prefs = { enableClaudeCodeMode: true };
    files = new Map();
    existing = new Set(["/usr/bin/node", "/home/u/.local/bin/claude"]);
    exitBeforeReady = false;
    closeGate = null;
    spawns = [];
    writes = [];
    bridges = [];
    fetched = [];
    nodeVersion = "v22.3.0";
    readyPort = 43210;
    legacyHealth = null;
    notices = [];
    globalScope.ztoolkit = {
      ProgressWindow: function () {
        const entry: { text: string; closeMs?: number } = { text: "" };
        const win: any = {
          createLine: (opts: { text: string }) => {
            entry.text = opts.text;
            return win;
          },
          show: () => {
            notices.push(entry);
            return win;
          },
          startCloseTimer: (ms: number) => {
            entry.closeMs = ms;
            return win;
          },
        };
        return win;
      },
    };
    resetClaudeBridgeProcessForTests();
    resetManagedClaudeBridgeEndpointForTests();
    globalScope.Zotero = {
      Prefs: {
        get: (key: string) => prefs[key.replace(PREFIX, "")],
        set: (key: string, value: unknown) => {
          prefs[key.replace(PREFIX, "")] = value;
        },
      },
      DataDirectory: { dir: "/data" },
      Profile: { dir: "/profile" },
      getMainWindow: () => null,
    };
    globalScope.IOUtils = {
      exists: async (path: string) => existing.has(path) || files.has(path),
      write: async (
        path: string,
        bytes: Uint8Array,
        options?: { tmpPath?: string },
      ) => {
        writes.push({ path, tmpPath: options?.tmpPath });
        files.set(path, bytes);
        return bytes.length;
      },
      stat: async (path: string) => ({ size: files.get(path)?.length ?? 0 }),
      makeDirectory: async () => undefined,
      getChildren: async () => [...files.keys()],
      remove: async (path: string) => {
        files.delete(path);
      },
    };
    globalScope.ChromeUtils = {
      importESModule: (url: string) =>
        url.includes("Subprocess") ? { Subprocess: fakeSubprocess } : {},
    };
    globalScope.Services = { env: { get: () => "" } };
    globalScope.rootURI = "jar:file:///profile/extensions/llm.xpi!/";
    globalScope.fetch = async (url: string) => {
      fetched.push(url);
      if (url.endsWith("content/claude-bridge/bridge.mjs")) {
        return new Response("// bundled bridge", { status: 200 });
      }
      if (url === "http://127.0.0.1:19787/healthz") {
        if (!legacyHealth) throw new TypeError("connection refused");
        return new Response(JSON.stringify(legacyHealth), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
  });

  afterEach(async function () {
    for (const bridge of bridges) bridge.exit();
    resetClaudeBridgeProcessForTests();
    resetManagedClaudeBridgeEndpointForTests();
    for (const [key, value] of Object.entries(saved)) globalScope[key] = value;
  });

  it("uses the managed bridge unless the user pointed the Bridge URL elsewhere", function () {
    assert.equal(getClaudeBridgeMode(), "managed");
    assert.equal(getClaudeBridgeUrl(), MANAGED_CLAUDE_BRIDGE_PLACEHOLDER_URL);
    prefs.agentBackendBridgeUrl = "http://127.0.0.1:19787";
    assert.equal(getClaudeBridgeMode(), "managed");
    prefs.agentBackendBridgeUrl = "http://192.168.1.4:19787";
    assert.equal(getClaudeBridgeMode(), "custom");
    assert.equal(getClaudeBridgeUrl(), "http://192.168.1.4:19787");
    prefs.claudeCodeBridgeMode = "managed";
    assert.equal(getClaudeBridgeMode(), "managed");
    prefs.agentBackendBridgeUrl = "";
    prefs.claudeCodeBridgeMode = "custom";
    assert.equal(getClaudeBridgeUrl(), "http://127.0.0.1:19787");
  });

  it("keeps the bridge mode when the user types a Bridge URL", function () {
    prefs.agentBackendBridgeUrl = "http://192.168.1.4:19787";
    assert.equal(getClaudeBridgeMode(), "custom");
    setClaudeBridgeUrl("http://127.0.0.1:19787");
    assert.equal(prefs.claudeCodeBridgeMode, "custom");
    assert.equal(getClaudeBridgeMode(), "custom");
    // An explicit choice is not overwritten.
    prefs.claudeCodeBridgeMode = "managed";
    setClaudeBridgeUrl("http://192.168.1.9:19787");
    assert.equal(getClaudeBridgeMode(), "managed");
    // A managed user stays managed after typing a remote URL.
    prefs.claudeCodeBridgeMode = "";
    prefs.agentBackendBridgeUrl = "";
    setClaudeBridgeUrl("http://192.168.1.4:19787");
    assert.equal(getClaudeBridgeMode(), "managed");
  });

  it("starts the bridge on the first request and points the request at it", async function () {
    const response = await claudeBridgeFetch(
      `${MANAGED_CLAUDE_BRIDGE_PLACEHOLDER_URL}/models?settingSources=user`,
    );
    assert.isTrue(response.ok);
    assert.lengthOf(spawns, 1);
    const [spawn] = spawns;
    const token = spawn.environment.ADAPTER_AUTH_TOKEN;
    assert.match(token, /^[0-9a-f]{48}$/);
    assert.equal(
      fetched.at(-1),
      `http://127.0.0.1:43210/${token}/models?settingSources=user`,
    );
    assert.notInclude(
      spawn.arguments.join(" "),
      token,
      "token stays out of argv",
    );
    assert.match(
      spawn.arguments[0],
      /^\/data\/llm-for-zotero\/claude-bridge\/bridge-[0-9a-f]+\.mjs$/,
    );
    assert.isTrue(files.has(spawn.arguments[0]));
    const flag = (name: string) =>
      spawn.arguments[spawn.arguments.indexOf(name) + 1];
    assert.equal(flag("--port"), "0");
    assert.equal(flag("--host"), "127.0.0.1");
    assert.equal(flag("--claude-path"), "/home/u/.local/bin/claude");
    assert.equal(flag("--exit-on-stdin-close"), "1");
    assert.equal(flag("--managed-by"), "llm-for-zotero");
    // ~/Zotero does not exist here, so the Zotero data directory is the root.
    assert.equal(flag("--zotero-root"), "/data");
    assert.include(spawn.environment.NO_PROXY, "127.0.0.1");
    assert.include(spawn.environment.PATH, "/home/u/.local/bin");
    assert.equal(
      getManagedClaudeBridgeBaseUrl(),
      `http://127.0.0.1:43210/${token}`,
    );
    assert.deepInclude(getClaudeBridgeStatus(), {
      state: "running",
      port: 43210,
      nodePath: "/usr/bin/node",
      nodeVersion: "v22.3.0",
      claudePath: "/home/u/.local/bin/claude",
      logFile: "/home/u/Zotero/agent-state/bridge.log",
    });
  });

  it("writes the bridge file atomically and rewrites a truncated one", async function () {
    await ensureClaudeBridgeRunning();
    const scriptPath = spawns[0].arguments[0];
    assert.deepEqual(writes, [
      { path: scriptPath, tmpPath: `${scriptPath}.tmp` },
    ]);
    assert.equal(
      new TextDecoder().decode(files.get(scriptPath)),
      "// bundled bridge",
    );
    // A complete file is reused.
    await stopClaudeBridge();
    await ensureClaudeBridgeRunning();
    assert.lengthOf(writes, 1);
    // A truncated file with the right name is replaced.
    await stopClaudeBridge();
    files.set(scriptPath, new TextEncoder().encode("// bundled"));
    await ensureClaudeBridgeRunning();
    assert.lengthOf(writes, 2);
    assert.equal(
      new TextDecoder().decode(files.get(scriptPath)),
      "// bundled bridge",
    );
  });

  it("keeps the old ~/Zotero data folders when they exist", async function () {
    const home = (globalThis as any).process?.env?.HOME;
    existing.add(`${home}/Zotero`);
    await ensureClaudeBridgeRunning();
    assert.notInclude(spawns[0].arguments, "--zotero-root");
  });

  it("shares one start between concurrent requests", async function () {
    await Promise.all([
      claudeBridgeFetch(`${MANAGED_CLAUDE_BRIDGE_PLACEHOLDER_URL}/healthz`),
      claudeBridgeFetch(`${MANAGED_CLAUDE_BRIDGE_PLACEHOLDER_URL}/tools`),
      ensureClaudeBridgeRunning(),
    ]);
    assert.lengthOf(spawns, 1);
  });

  it("stops by closing stdin and starts again on the next request", async function () {
    const firstBase = await ensureClaudeBridgeRunning();
    await stopClaudeBridge();
    assert.isTrue(bridges[0].stdinClosed);
    assert.equal(getClaudeBridgeStatus().state, "stopped");
    assert.equal(
      getManagedClaudeBridgeBaseUrl(),
      MANAGED_CLAUDE_BRIDGE_PLACEHOLDER_URL,
    );
    assert.isTrue(isManagedClaudeBridgeIdle(firstBase));

    readyPort = 43211;
    // A URL built from the old bridge still reaches the new one.
    await claudeBridgeFetch(`${firstBase}/session-info?conversationKey=1`);
    assert.lengthOf(spawns, 2);
    assert.match(
      fetched.at(-1) || "",
      /^http:\/\/127\.0\.0\.1:43211\/[0-9a-f]+\/session-info/,
    );
  });

  it("does not mark a bridge stopped when a start overlaps the stop", async function () {
    await ensureClaudeBridgeRunning();
    let releaseClose!: () => void;
    closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const stopping = stopClaudeBridge();
    closeGate = null;
    readyPort = 43211;
    await ensureClaudeBridgeRunning();
    releaseClose();
    await stopping;
    assert.equal(getClaudeBridgeStatus().state, "running");
    assert.equal(getClaudeBridgeStatus().port, 43211);
  });

  it("stops a bridge that finishes starting during shutdown and registers no quit blocker", async function () {
    const blockers: string[] = [];
    globalScope.ChromeUtils = {
      importESModule: (url: string) =>
        url.includes("Subprocess")
          ? { Subprocess: fakeSubprocess }
          : {
              AsyncShutdown: {
                profileBeforeChange: {
                  addBlocker: (name: string) => blockers.push(name),
                  removeBlocker: () => undefined,
                },
              },
            },
    };
    const starting = ensureClaudeBridgeRunning().catch(() => undefined);
    const shutdown = shutdownClaudeBridge();
    await Promise.all([starting, shutdown]);
    assert.isTrue(bridges.every((bridge) => bridge.stdinClosed));
    assert.equal(getClaudeBridgeStatus().state, "stopped");
    assert.lengthOf(blockers, 0);
  });

  it("reports an unexpected exit and gives up after repeated crashes", async function () {
    for (let attempt = 0; attempt < 3; attempt++) {
      await ensureClaudeBridgeRunning();
      bridges.at(-1)!.exit();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(getClaudeBridgeStatus().state, "failed");
      assert.include(getClaudeBridgeStatus().message, "stopped unexpectedly");
    }
    let error: unknown;
    try {
      await ensureClaudeBridgeRunning();
    } catch (caught) {
      error = caught;
    }
    assert.include(String(error), "keeps stopping");
    assert.lengthOf(spawns, 3);
    await restartClaudeBridge();
    assert.lengthOf(spawns, 4, "Restart forgets earlier crashes");
  });

  it("counts bridges that exit before they are ready and shows the give-up in the status", async function () {
    exitBeforeReady = true;
    for (let attempt = 0; attempt < 3; attempt++) {
      let error: unknown;
      try {
        await ensureClaudeBridgeRunning();
      } catch (caught) {
        error = caught;
      }
      assert.include(String(error), "stopped while starting");
    }
    assert.lengthOf(spawns, 3);
    let giveUp: unknown;
    try {
      await ensureClaudeBridgeRunning();
    } catch (caught) {
      giveUp = caught;
    }
    assert.include(String(giveUp), "keeps stopping");
    assert.lengthOf(spawns, 3, "no fourth launch");
    assert.equal(getClaudeBridgeStatus().state, "failed");
    assert.include(getClaudeBridgeStatus().message, "keeps stopping");
    exitBeforeReady = false;
    await restartClaudeBridge();
    assert.lengthOf(spawns, 4, "Restart forgets earlier failures");
    assert.equal(getClaudeBridgeStatus().state, "running");
  });

  it("explains an old Node.js instead of starting the bridge", async function () {
    nodeVersion = "v16.20.0";
    let error: unknown;
    try {
      await ensureClaudeBridgeRunning();
    } catch (caught) {
      error = caught;
    }
    assert.include(String(error), "Node.js 18 or newer");
    assert.lengthOf(spawns, 0);
    assert.equal(getClaudeBridgeStatus().state, "failed");
  });

  it("explains a missing Claude Code path the user typed", async function () {
    prefs.claudeCodeCliPath = "/opt/missing/claude";
    let error: unknown;
    try {
      await ensureClaudeBridgeRunning();
    } catch (caught) {
      error = caught;
    }
    assert.include(
      String(error),
      "Claude Code was not found at /opt/missing/claude",
    );
  });

  it("does not start the bridge while Claude Code mode is off", async function () {
    prefs.enableClaudeCodeMode = false;
    let error: unknown;
    try {
      await claudeBridgeFetch(
        `${MANAGED_CLAUDE_BRIDGE_PLACEHOLDER_URL}/models`,
      );
    } catch (caught) {
      error = caught;
    }
    assert.include(String(error), "Claude Code mode is off");
    await restartClaudeBridge().catch(() => undefined);
    assert.lengthOf(spawns, 0);
    assert.equal(getClaudeBridgeStatus().state, "stopped");
    prefs.enableClaudeCodeMode = true;
    await claudeBridgeFetch(`${MANAGED_CLAUDE_BRIDGE_PLACEHOLDER_URL}/models`);
    assert.lengthOf(spawns, 1);
  });

  it("leaves requests to the user's own bridge alone", async function () {
    prefs.claudeCodeBridgeMode = "custom";
    await claudeBridgeFetch("http://127.0.0.1:19787/healthz").catch(
      () => undefined,
    );
    await claudeBridgeFetch(`${MANAGED_CLAUDE_BRIDGE_PLACEHOLDER_URL}/healthz`);
    assert.lengthOf(spawns, 0);
  });

  describe("a bridge the user runs in WSL on Windows", function () {
    const url = `${MANAGED_CLAUDE_BRIDGE_PLACEHOLDER_URL}/models`;

    beforeEach(function () {
      // Windows looks for node.exe; explicit paths keep the fake binaries.
      prefs.claudeCodeNodePath = "/usr/bin/node";
      prefs.claudeCodeCliPath = "/home/u/.local/bin/claude";
    });

    it("is kept: mode saved as custom, nothing spawned, request goes to it", async function () {
      globalScope.Zotero.isWin = true;
      legacyHealth = { ok: true, protocolVersion: 2 };
      const response = await claudeBridgeFetch(url);
      assert.isTrue(response.ok);
      assert.equal(prefs.claudeCodeBridgeMode, "custom");
      assert.lengthOf(spawns, 0);
      assert.equal(fetched.at(-1), "http://127.0.0.1:19787/models");
      assert.equal(getClaudeBridgeUrl(), "http://127.0.0.1:19787");
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.lengthOf(notices, 0);
      assert.equal(getClaudeBridgeStatus().state, "stopped");
    });

    it("starts the managed bridge and leaves the mode unset when nothing answers", async function () {
      globalScope.Zotero.isWin = true;
      await claudeBridgeFetch(url);
      assert.lengthOf(spawns, 1);
      assert.isUndefined(prefs.claudeCodeBridgeMode);
      assert.include(fetched, "http://127.0.0.1:19787/healthz");
    });

    it("does not probe when the user chose managed", async function () {
      globalScope.Zotero.isWin = true;
      prefs.claudeCodeBridgeMode = "managed";
      // The one-time notice probes the port too; keep it out of this check.
      prefs.claudeCodeLegacyDaemonNoticeShown = true;
      legacyHealth = { ok: true, protocolVersion: 2 };
      await claudeBridgeFetch(url);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.lengthOf(spawns, 1);
      assert.equal(prefs.claudeCodeBridgeMode, "managed");
      assert.notInclude(fetched, "http://127.0.0.1:19787/healthz");
    });

    it("still moves the old LaunchAgent bridge on macOS to the managed bridge", async function () {
      globalScope.Zotero.isWin = false;
      globalScope.Zotero.isMac = true;
      legacyHealth = { ok: true, protocolVersion: 2 };
      await claudeBridgeFetch(url);
      assert.lengthOf(spawns, 1);
      assert.isUndefined(prefs.claudeCodeBridgeMode);
    });

    it("adds the own-bridge hint to a not-found message", async function () {
      delete prefs.claudeCodeCliPath;
      existing.delete("/home/u/.local/bin/claude");
      let error: unknown;
      try {
        await ensureClaudeBridgeRunning();
      } catch (caught) {
        error = caught;
      }
      assert.include(String(error), "Claude Code was not found.");
      assert.include(
        String(error),
        "If Claude Code runs in WSL or on another computer, turn on “Use my own bridge” in Settings > Claude Code and enter its address.",
      );
    });
  });

  it("passes extra bridge options through, except the ones the plugin owns", async function () {
    prefs.claudeCodeBridgeExtraArgs =
      '--additional-directories "~/My Papers" --port 9999 --setting-sources user';
    await ensureClaudeBridgeRunning();
    const args = spawns[0].arguments;
    assert.include(args, "~/My Papers");
    assert.include(args, "--setting-sources");
    assert.notInclude(args, "9999");
    assert.equal(args.filter((arg) => arg === "--port").length, 1);
  });

  it("tells the user once, without a blocking alert, about the old background bridge", async function () {
    legacyHealth = { ok: true, protocolVersion: 2 };
    const alerts: string[] = [];
    globalScope.Services = {
      env: { get: () => "" },
      prompt: { alert: (...args: unknown[]) => alerts.push(String(args[2])) },
    };
    await ensureClaudeBridgeRunning();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.lengthOf(alerts, 0);
    assert.lengthOf(notices, 1);
    assert.include(notices[0].text, "old Claude Code bridge is still running");
    assert.include(notices[0].text, "Settings > Claude Code");
    assert.equal(notices[0].closeMs, 8000);
    assert.isTrue(prefs.claudeCodeLegacyDaemonNoticeShown as boolean);
    await restartClaudeBridge();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.lengthOf(notices, 1);
    assert.lengthOf(alerts, 0);
  });

  it("does not probe the old port when the check is switched off", async function () {
    prefs.claudeCodeLegacyDaemonCheck = false;
    legacyHealth = { ok: true };
    assert.isFalse(await detectLegacyClaudeBridge());
    await ensureClaudeBridgeRunning();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.notInclude(fetched, "http://127.0.0.1:19787/healthz");
    assert.lengthOf(notices, 0);
    assert.isNotTrue(prefs.claudeCodeLegacyDaemonNoticeShown as boolean);
  });

  it("detects the old bridge only when it answers ok without managedBy", async function () {
    legacyHealth = { ok: true, protocolVersion: 2 };
    assert.isTrue(await detectLegacyClaudeBridge());
    legacyHealth = { ok: true, managedBy: "llm-for-zotero" };
    assert.isFalse(await detectLegacyClaudeBridge());
    legacyHealth = null;
    assert.isFalse(await detectLegacyClaudeBridge());
  });

  it("gives the same removal text for the notice and Settings", function () {
    const mac = describeLegacyClaudeBridgeRemoval(true).join("\n");
    assert.include(mac, "npm run daemon:uninstall");
    assert.include(mac, "launchctl bootout gui/$(id -u)/com.toha.ccbridge");
    assert.include(mac, "rm ~/Library/LaunchAgents/com.toha.ccbridge.plist");
    const other = describeLegacyClaudeBridgeRemoval(false).join("\n");
    assert.notInclude(other, "launchctl");
    assert.include(other, "npm run serve:bridge");
  });

  it("does not mistake its own bridge on the old port for the old one", async function () {
    legacyHealth = { ok: true, managedBy: "llm-for-zotero" };
    const alerts: string[] = [];
    globalScope.Services = {
      env: { get: () => "" },
      prompt: {
        alert: (_win: unknown, _title: string, text: string) =>
          alerts.push(text),
      },
    };
    await ensureClaudeBridgeRunning();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.lengthOf(alerts, 0);
  });
});

describe("Claude Code bridge helpers", function () {
  afterEach(function () {
    resetManagedClaudeBridgeEndpointForTests();
  });

  it("matches only whole managed base URLs", function () {
    setManagedClaudeBridgeBaseUrl("http://127.0.0.1:5000/abc");
    assert.equal(
      matchManagedClaudeBridgeBase("http://127.0.0.1:5000/abc/healthz"),
      "http://127.0.0.1:5000/abc",
    );
    assert.equal(
      matchManagedClaudeBridgeBase("http://127.0.0.1:5000/abcd/healthz"),
      "",
    );
    assert.equal(
      matchManagedClaudeBridgeBase("http://127.0.0.1:19787/healthz"),
      "",
    );
    setManagedClaudeBridgeBaseUrl("http://127.0.0.1:5001/abc");
    assert.equal(
      matchManagedClaudeBridgeBase("http://127.0.0.1:5000/abc/tools"),
      "http://127.0.0.1:5000/abc",
      "a base from an earlier bridge still matches",
    );
  });

  it("reads the ready line", function () {
    assert.deepEqual(
      parseClaudeBridgeReadyLine(
        'CLAUDE_BRIDGE_READY {"port":1234,"version":"1.0.0","logFile":"/l"}',
      ),
      { port: 1234, version: "1.0.0", stateDir: undefined, logFile: "/l" },
    );
    assert.isNull(parseClaudeBridgeReadyLine("[cc] listening"));
    assert.isNull(parseClaudeBridgeReadyLine('CLAUDE_BRIDGE_READY {"port":0}'));
    assert.isNull(parseClaudeBridgeReadyLine("CLAUDE_BRIDGE_READY not json"));
  });

  it("splits extra options and drops plugin-owned flags", function () {
    assert.deepEqual(parseClaudeBridgeExtraArgs(`--a "b c" --d 'e f' g`), [
      "--a",
      "b c",
      "--d",
      "e f",
      "g",
    ]);
    assert.deepEqual(
      filterClaudeBridgeExtraArgs(["--claude-path", "/x", "--log-file", "1"]),
      ["--log-file", "1"],
    );
  });

  it("reads node --version output", function () {
    assert.equal(parseNodeMajorVersion("v20.11.1\n"), 20);
    assert.equal(parseNodeMajorVersion("18.0.0"), 18);
    assert.isNull(parseNodeMajorVersion("command not found"));
    assert.isNull(parseNodeMajorVersion(null));
  });
});

describe("Gecko subprocess lookups", function () {
  it("kills a command that hangs past the timeout", async function () {
    let killed = false;
    let release!: () => void;
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });
    const Subprocess = {
      call: async () => ({
        stdout: {
          readString: async () => {
            await hung;
            return "";
          },
        },
        wait: async () => {
          await hung;
          return { exitCode: 0 };
        },
        kill: async () => {
          killed = true;
          release();
          return { exitCode: 1 };
        },
      }),
    };
    const output = await runGeckoSubprocessForOutput(
      Subprocess,
      { command: "/bin/zsh", arguments: ["-lc", "command -v node"] },
      20,
    );
    assert.isNull(output);
    assert.isTrue(killed);
  });

  it("returns the output of a command that finishes in time", async function () {
    let sent = false;
    const Subprocess = {
      call: async () => ({
        stdout: {
          readString: async () => {
            if (sent) return "";
            sent = true;
            return "/usr/bin/node\n";
          },
        },
        wait: async () => ({ exitCode: 0 }),
      }),
    };
    assert.equal(
      await runGeckoSubprocessForOutput(Subprocess, { command: "x" }, 1000),
      "/usr/bin/node\n",
    );
  });
});
