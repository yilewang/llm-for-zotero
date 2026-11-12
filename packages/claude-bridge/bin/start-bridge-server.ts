import {
  ClaudeAgentSdkRuntimeClient,
  ClaudeCodeRuntimeAdapter,
  JsonFileSessionMapper,
  JsonFileTraceStore,
  Llm4ZoteroAgentBackendAdapter,
  startHttpBridgeServer,
} from "../src/index.js";
import { resolveLegacyAdapterPaths } from "../src/zotero-profile-paths.js";
import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";

function installFileLogger(filePath: string): void {
  try {
    mkdirSync(resolve(filePath, ".."), { recursive: true });
    const stream = createWriteStream(filePath, { flags: "a" });
    const origLog = console.log.bind(console);
    const origErr = console.error.bind(console);
    const write = (level: string, args: unknown[]): void => {
      try {
        const line =
          `${new Date().toISOString()} [${level}] ` +
          args
            .map((a) =>
              typeof a === "string"
                ? a
                : (() => {
                    try {
                      return JSON.stringify(a);
                    } catch {
                      return String(a);
                    }
                  })(),
            )
            .join(" ") +
          "\n";
        stream.write(line);
      } catch {
        // ignore
      }
    };
    console.log = (...args: unknown[]) => {
      write("log", args);
      origLog(...args);
    };
    console.error = (...args: unknown[]) => {
      write("err", args);
      origErr(...args);
    };
  } catch {
    // ignore
  }
}

function getArg(name: string): string | undefined {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  const value = process.argv[idx + 1];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseBoolean(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return defaultValue;
}

// Set by the plugin build when it bundles the bridge; absent under tsx.
declare const __CLAUDE_BRIDGE_VERSION__: string | undefined;

function getBridgeVersion(): string {
  return typeof __CLAUDE_BRIDGE_VERSION__ === "string" &&
    __CLAUDE_BRIDGE_VERSION__
    ? __CLAUDE_BRIDGE_VERSION__
    : "dev";
}

const DEFAULT_SETTING_SOURCES: SettingSource[] = ["user", "project", "local"];

function parseSettingSources(value: string | undefined): SettingSource[] {
  const raw = (value || DEFAULT_SETTING_SOURCES.join(","))
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const accepted: SettingSource[] = [];
  for (const source of raw) {
    if (source === "user" || source === "project" || source === "local") {
      accepted.push(source);
    }
  }
  return accepted.length > 0 ? accepted : DEFAULT_SETTING_SOURCES;
}

function normalizePathWithHome(
  value: string,
  homeDir: string | undefined,
): string | undefined {
  const raw = value.trim();
  if (!raw) return undefined;
  if (raw === "~") {
    return homeDir ? resolve(homeDir) : undefined;
  }
  if (raw.startsWith("~/")) {
    return homeDir ? resolve(homeDir, raw.slice(2)) : undefined;
  }
  return resolve(raw);
}

function parseDirectoryList(
  value: string | undefined,
  homeDir: string | undefined,
): string[] {
  if (!value || !value.trim()) return [];
  const normalized = value
    .split(",")
    .map((entry) => normalizePathWithHome(entry, homeDir))
    .filter((entry): entry is string => Boolean(entry));
  return Array.from(new Set(normalized));
}

function parseStringList(value: string | undefined): string[] {
  if (!value || !value.trim()) return [];
  return Array.from(
    new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

function readTextFile(path: string | undefined): string {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return "";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read file: ${path} (${message})`);
  }
}

function readProjectSettingsEnv(path: string): Record<string, string> {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as { env?: Record<string, unknown> };
    const env = parsed?.env;
    if (!env || typeof env !== "object" || Array.isArray(env)) return {};
    return Object.fromEntries(
      Object.entries(env)
        .filter(([, value]) => typeof value === "string" && value.trim())
        .map(([key, value]) => [key, String(value).trim()]),
    );
  } catch {
    return {};
  }
}

async function main() {
  const host = getArg("host") || process.env.ADAPTER_HOST || "127.0.0.1";
  const portRaw = getArg("port") || process.env.ADAPTER_PORT || "19787";
  const port = Number(portRaw);
  // Port 0 asks the system for any free port; the ready line reports it.
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${portRaw}`);
  }

  const homeDir =
    (process.env.HOME || process.env.USERPROFILE || homedir() || "").trim() ||
    undefined;
  const explicitZoteroRoot =
    (getArg("zotero-root") || process.env.ZOTERO_ROOT || "").trim() ||
    undefined;
  const legacyPaths = explicitZoteroRoot
    ? (() => {
        const zoteroRoot = resolve(explicitZoteroRoot);
        return {
          homeDir: homeDir || zoteroRoot,
          zoteroRoot,
          runtimeCwd: resolve(zoteroRoot, "agent-runtime"),
          stateDir: resolve(zoteroRoot, "agent-state"),
        };
      })()
    : resolveLegacyAdapterPaths(homeDir, process.cwd());
  const defaultRuntimeCwd = legacyPaths.runtimeCwd;
  const defaultStateDir = legacyPaths.stateDir;
  const stateDirCandidate =
    getArg("state-dir") || process.env.ADAPTER_STATE_DIR || defaultStateDir;
  const forwardFrontendModel = parseBoolean(
    getArg("forward-frontend-model") ??
      process.env.ADAPTER_FORWARD_FRONTEND_MODEL,
    true,
  );
  const runtimeCwdCandidate =
    getArg("runtime-cwd") ||
    process.env.ADAPTER_RUNTIME_CWD ||
    defaultRuntimeCwd;
  const runtimeCwd = resolve(runtimeCwdCandidate);
  const stateDirResolved = resolve(stateDirCandidate);

  mkdirSync(runtimeCwd, { recursive: true });
  mkdirSync(stateDirResolved, { recursive: true });
  const rawLogFileSetting =
    getArg("log-file") ?? process.env.ADAPTER_LOG_FILE ?? "";
  const logFileSetting = rawLogFileSetting.trim();
  let resolvedLogPath: string | undefined;
  if (logFileSetting) {
    resolvedLogPath = ["1", "true", "yes", "on"].includes(
      logFileSetting.toLowerCase(),
    )
      ? resolve(stateDirResolved, "bridge.log")
      : resolve(logFileSetting);
    installFileLogger(resolvedLogPath);
  }
  const projectClaudeDir = resolve(runtimeCwd, ".claude");
  const projectSettingsFile = resolve(projectClaudeDir, "settings.json");
  mkdirSync(projectClaudeDir, { recursive: true });
  if (!existsSync(projectSettingsFile)) {
    writeFileSync(projectSettingsFile, "{}\n", "utf8");
  }
  const projectSettingsEnv = readProjectSettingsEnv(projectSettingsFile);
  for (const [key, value] of Object.entries(projectSettingsEnv)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
  const settingSources = parseSettingSources(
    getArg("setting-sources") || process.env.ADAPTER_SETTING_SOURCES,
  );
  const appendPromptInline =
    getArg("append-system-prompt") ||
    process.env.ADAPTER_APPEND_SYSTEM_PROMPT ||
    "";
  const appendPromptFile = readTextFile(
    getArg("append-system-prompt-file") ||
      process.env.ADAPTER_APPEND_SYSTEM_PROMPT_FILE,
  );
  const projectInstructionFile = join(runtimeCwd, "CLAUDE.md");
  const projectInstruction = readTextFile(projectInstructionFile);
  const appendSystemPrompt = [
    appendPromptInline.trim(),
    appendPromptFile.trim(),
    projectInstruction.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
  const defaultAdditionalDirs = [
    legacyPaths.zoteroRoot,
    normalizePathWithHome("~/Downloads", homeDir),
    normalizePathWithHome("~/Documents", homeDir),
  ].filter((entry): entry is string => Boolean(entry));
  const configuredAdditionalDirs = parseDirectoryList(
    getArg("additional-directories") ||
      process.env.ADAPTER_ADDITIONAL_DIRECTORIES,
    homeDir,
  );
  const additionalDirectories = Array.from(
    new Set(
      [...defaultAdditionalDirs, ...configuredAdditionalDirs].filter(
        (entry) => entry !== runtimeCwd,
      ),
    ),
  );
  const defaultAllowedTools = parseStringList(
    getArg("default-allowed-tools") ||
      process.env.ADAPTER_DEFAULT_ALLOWED_TOOLS ||
      "WebFetch,WebSearch",
  );
  for (const dir of additionalDirectories) {
    mkdirSync(dir, { recursive: true });
  }

  const claudeCodeExecutablePath =
    (getArg("claude-path") || process.env.ADAPTER_CLAUDE_PATH || "").trim() ||
    undefined;
  // The token stays out of argv so other users cannot read it from `ps`.
  const authToken = (process.env.ADAPTER_AUTH_TOKEN || "").trim() || undefined;
  // Remove it from the environment so the SDK does not hand it to `claude`
  // and the Bash or MCP programs that Claude starts.
  delete process.env.ADAPTER_AUTH_TOKEN;
  const managedBy =
    (getArg("managed-by") || process.env.ADAPTER_MANAGED_BY || "").trim() ||
    undefined;
  const exitOnStdinClose = parseBoolean(
    getArg("exit-on-stdin-close") ?? process.env.ADAPTER_EXIT_ON_STDIN_CLOSE,
    false,
  );

  const runtimeClient = new ClaudeAgentSdkRuntimeClient({
    claudeCodeExecutablePath,
    cwd: runtimeCwd,
    additionalDirectories,
    defaultAllowedTools,
    settingSources,
    includePartialMessages: true,
    appendSystemPrompt: appendSystemPrompt || undefined,
    forwardFrontendModel,
    permissionMode: "default",
  });

  const core = new ClaudeCodeRuntimeAdapter({
    runtimeClient,
    sessionMapper: new JsonFileSessionMapper(
      `${stateDirResolved}/session-links/sessions.json`,
    ),
    traceStore: new JsonFileTraceStore(
      `${stateDirResolved}/turn-traces/trace.json`,
    ),
  });

  const compat = new Llm4ZoteroAgentBackendAdapter({
    adapter: core,
    runtimeCwd,
  });
  const bridgeVersion = getBridgeVersion();
  const server = await startHttpBridgeServer({
    adapter: compat,
    host,
    port,
    authToken,
    bridgeVersion,
    managedBy,
  });

  const baseUrl = `http://${server.host}:${server.port}`;
  console.log(`[cc-llm4zotero-adapter] listening on ${baseUrl}`);
  console.log(
    `[cc-llm4zotero-adapter] healthz: ${baseUrl}${authToken ? "/<token>" : ""}/healthz`,
  );
  if (claudeCodeExecutablePath) {
    console.log(
      `[cc-llm4zotero-adapter] claude executable: ${claudeCodeExecutablePath}`,
    );
  }
  console.log(`[cc-llm4zotero-adapter] runtime cwd: ${runtimeCwd}`);
  console.log(
    `[cc-llm4zotero-adapter] additional directories: ${
      additionalDirectories.length > 0
        ? additionalDirectories.join(", ")
        : "(none)"
    }`,
  );
  console.log(
    `[cc-llm4zotero-adapter] default allowed tools: ${
      defaultAllowedTools.length > 0 ? defaultAllowedTools.join(", ") : "(none)"
    }`,
  );
  console.log(`[cc-llm4zotero-adapter] state dir: ${stateDirResolved}`);
  console.log(
    `[cc-llm4zotero-adapter] settingSources: ${settingSources.join(",")}`,
  );
  if (appendSystemPrompt) {
    console.log("[cc-llm4zotero-adapter] appendSystemPrompt: enabled");
  }
  if (!exitOnStdinClose) {
    console.log("[cc-llm4zotero-adapter] Press Ctrl+C to stop");
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Open streams (a running turn) would keep close() waiting forever.
    const forceExit = setTimeout(() => process.exit(0), 3000);
    forceExit.unref();
    await server.close().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (exitOnStdinClose) {
    // The plugin holds our stdin open. It closes when Zotero stops the bridge
    // or when Zotero itself goes away, crash included.
    process.stdin.on("end", shutdown);
    process.stdin.on("close", shutdown);
    process.stdin.on("error", shutdown);
    process.stdin.resume();
  }

  // One machine-readable line the plugin waits for before it uses the bridge.
  console.log(
    `CLAUDE_BRIDGE_READY ${JSON.stringify({
      host: server.host,
      port: server.port,
      version: bridgeVersion,
      runtimeCwd,
      stateDir: stateDirResolved,
      ...(resolvedLogPath ? { logFile: resolvedLogPath } : {}),
    })}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
