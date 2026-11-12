declare const Zotero: any;

import { resolveAddonRootUri } from "../agent/services/pdfPageService";
import { appLogger } from "../core/logging";
import { getAbortController } from "../utils/apiHelpers";
import { registerAppQuitBlocker } from "../utils/appQuitBlocker";
import { fnv1a32 } from "../utils/fnv1a";
import {
  ensureDir,
  getIOUtils,
  pathExists,
  readFileBytes,
  writeFileBytes,
} from "../utils/geckoFs";
import {
  loadGeckoSubprocess,
  type GeckoSubprocess,
  type GeckoSubprocessProcess,
} from "../utils/geckoSubprocess";
import { getLocalParentPath, joinLocalPath } from "../utils/localPath";
import { getRuntimePlatformInfo } from "../utils/runtimePlatform";
import {
  assertSupportedNodeVersion,
  listClaudeBridgeToolDirs,
  resolveClaudeBridgeBinary,
} from "./bridgeBinaries";
import {
  clearManagedClaudeBridgeBaseUrl,
  matchManagedClaudeBridgeBase,
  setManagedClaudeBridgeBaseUrl,
} from "./bridgeEndpoint";
import {
  DEFAULT_CLAUDE_BRIDGE_URL,
  getClaudeBridgeExtraArgsPref,
  getClaudeBridgeMode,
  getCustomClaudeBridgeUrl,
  isClaudeBridgeModeImplicit,
  setClaudeBridgeMode,
  getClaudeBridgeNodePathPref,
  getClaudeCliPathPref,
  hasShownClaudeLegacyDaemonNotice,
  isClaudeLegacyDaemonCheckEnabled,
  isClaudeCodeModeEnabled,
  markClaudeLegacyDaemonNoticeShown,
} from "./prefs";
import { getClaudeUserHomeDir } from "./projectSkills";

/**
 * Starts, watches and stops the Claude Code bridge the plugin ships.
 *
 * Zotero cannot run the bridge itself (it needs Node), so the plugin copies
 * the bundled bridge out of the XPI and starts it with the user's Node. The
 * bridge picks a free port and only answers requests that carry this Zotero
 * session's random token in the URL path. It exits on its own when Zotero
 * closes its stdin, which also happens if Zotero crashes.
 *
 * Nothing here runs unless Claude Code mode is on and the bridge mode is
 * "managed".
 */

export type ClaudeBridgeState = "stopped" | "starting" | "running" | "failed";

export type ClaudeBridgeStatus = {
  state: ClaudeBridgeState;
  /** Plain-language problem description when state is "failed". */
  message?: string;
  nodePath?: string;
  nodeVersion?: string;
  claudePath?: string;
  port?: number;
  bridgeVersion?: string;
  logFile?: string;
  stateDir?: string;
};

type ReadyInfo = {
  port: number;
  version?: string;
  stateDir?: string;
  logFile?: string;
};

type RunningBridge = {
  proc: GeckoSubprocessProcess;
  baseUrl: string;
  stopping: boolean;
  exited: Promise<void>;
};

const READY_PREFIX = "CLAUDE_BRIDGE_READY ";
const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 4_000;
const OUTPUT_TAIL_MAX = 6_000;
const CRASH_WINDOW_MS = 2 * 60_000;
const MAX_CRASHES_IN_WINDOW = 3;
const LEGACY_DAEMON_LABEL = "com.toha.ccbridge";

let status: ClaudeBridgeStatus = { state: "stopped" };
const statusListeners = new Set<(status: ClaudeBridgeStatus) => void>();
let running: RunningBridge | null = null;
let startPromise: Promise<string> | null = null;
let crashTimes: number[] = [];
let unregisterQuitBlocker: (() => void) | null = null;
let authToken = "";
let shuttingDown = false;

function setStatus(next: ClaudeBridgeStatus): void {
  status = next;
  for (const listener of statusListeners) {
    try {
      listener(status);
    } catch (error) {
      appLogger.debug("LLM: Claude bridge status listener failed", error);
    }
  }
}

export function getClaudeBridgeStatus(): ClaudeBridgeStatus {
  return { ...status };
}

export function onClaudeBridgeStatusChange(
  listener: (status: ClaudeBridgeStatus) => void,
): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

function getAuthToken(): string {
  if (authToken) return authToken;
  const cryptoApi = (globalThis as any).crypto;
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(24);
    cryptoApi.getRandomValues(bytes);
    authToken = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return authToken;
  }
  // Some plugin scopes have no Web Crypto; nsIUUIDGenerator is also random.
  const uuid = () =>
    String((globalThis as any).Services?.uuid?.generateUUID?.() || "").replace(
      /[^0-9a-f]/gi,
      "",
    );
  authToken = `${uuid()}${uuid()}`.toLowerCase().slice(0, 48);
  if (authToken.length < 32) {
    throw new Error(
      "Could not create a private token for the Claude Code bridge.",
    );
  }
  return authToken;
}

function getZoteroDataDir(): string {
  const dir = (Zotero as any)?.DataDirectory?.dir;
  return typeof dir === "string" ? dir.trim() : "";
}

/** The folder the extracted bridge lives in, beside the user's Zotero data. */
function getBridgeInstallDir(): string {
  const dataDir = getZoteroDataDir();
  const base = dataDir || joinLocalPath(getClaudeUserHomeDir(), "Zotero");
  return joinLocalPath(base, "llm-for-zotero", "claude-bridge");
}

async function fileHasByteLength(
  path: string,
  length: number,
): Promise<boolean> {
  try {
    const stat = await (getIOUtils() as any)?.stat?.(path);
    if (typeof stat?.size === "number") return stat.size === length;
    const bytes = await readFileBytes(path);
    return bytes?.length === length;
  } catch {
    return false;
  }
}

/**
 * Node cannot read inside the XPI, so the bundled bridge is written to disk.
 * The file name carries a content hash: a plugin update writes a new file and
 * removes the old ones, and an unchanged, complete bridge is not rewritten.
 */
async function materializeBridgeScript(): Promise<string> {
  const rootUri = resolveAddonRootUri();
  if (!rootUri) throw new Error("Could not locate the plugin's files.");
  const resourceUri = `${rootUri.replace(/\/?$/, "/")}content/claude-bridge/bridge.mjs`;
  const response = await fetch(resourceUri);
  if (!response.ok) {
    throw new Error(
      "This build of the plugin does not include the Claude Code bridge.",
    );
  }
  const text = await response.text();
  const bytes = new TextEncoder().encode(text);
  const installDir = getBridgeInstallDir();
  const fileName = `bridge-${fnv1a32(text)}.mjs`;
  const scriptPath = joinLocalPath(installDir, fileName);
  // A file left by a killed or out-of-space write has the right name but the
  // wrong size, so reuse it only when its size matches.
  if (
    (await pathExists(scriptPath)) &&
    (await fileHasByteLength(scriptPath, bytes.length))
  ) {
    return scriptPath;
  }
  await ensureDir(installDir);
  const written = await writeFileBytes(scriptPath, bytes, { atomic: true });
  if (!written) throw new Error("Could not write the Claude Code bridge file.");
  const io = getIOUtils() as any;
  try {
    const children: string[] = (await io?.getChildren?.(installDir)) || [];
    for (const child of children) {
      const name = child.split(/[\\/]/).pop() || "";
      if (/^bridge-[0-9a-f]+\.mjs$/.test(name) && name !== fileName) {
        await io?.remove?.(child, { ignoreAbsent: true });
      }
    }
  } catch (error) {
    appLogger.debug("LLM: could not remove old Claude bridge files", error);
  }
  return scriptPath;
}

/**
 * Splits the "extra bridge options" setting like a shell would for simple
 * cases: whitespace separates, single or double quotes group.
 */
export function parseClaudeBridgeExtraArgs(value: string): string[] {
  const args: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value || ""))) {
    args.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return args;
}

/** Options the plugin owns; the extra-options setting cannot override them. */
const RESERVED_BRIDGE_FLAGS = new Set([
  "--host",
  "--port",
  "--managed-by",
  "--exit-on-stdin-close",
  "--claude-path",
]);

export function filterClaudeBridgeExtraArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (RESERVED_BRIDGE_FLAGS.has(arg)) {
      index++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

export function parseClaudeBridgeReadyLine(line: string): ReadyInfo | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(READY_PREFIX)) return null;
  try {
    const payload = JSON.parse(trimmed.slice(READY_PREFIX.length));
    const port = Number(payload?.port);
    if (!Number.isInteger(port) || port <= 0) return null;
    return {
      port,
      version:
        typeof payload.version === "string" ? payload.version : undefined,
      stateDir:
        typeof payload.stateDir === "string" ? payload.stateDir : undefined,
      logFile:
        typeof payload.logFile === "string" ? payload.logFile : undefined,
    };
  } catch {
    return null;
  }
}

function buildLaunchPath(binaryDirs: string[], toolDirs: string[]): string {
  const info = getRuntimePlatformInfo();
  const separator = info.platform === "windows" ? ";" : ":";
  const inherited =
    (globalThis as any).Services?.env?.get?.("PATH") ||
    (globalThis as any).Services?.env?.get?.("Path") ||
    "";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of [
    ...binaryDirs,
    ...toolDirs,
    ...String(inherited).split(separator),
  ]) {
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.join(separator);
}

function mergeNoProxy(): string {
  const env = (globalThis as any).Services?.env;
  const entries = [
    env?.get?.("NO_PROXY"),
    env?.get?.("no_proxy"),
    "localhost,127.0.0.1,::1",
  ]
    .flatMap((value) => String(value || "").split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
  return Array.from(new Set(entries)).join(",");
}

/**
 * The old stand-alone adapter kept its data in ~/Zotero/agent-runtime and
 * ~/Zotero/agent-state. The managed bridge uses the same folders so existing
 * Claude sessions carry over. Only when ~/Zotero does not exist does it fall
 * back to the Zotero data directory.
 */
async function buildZoteroRootArgs(): Promise<string[]> {
  const legacyRoot = joinLocalPath(getClaudeUserHomeDir(), "Zotero");
  if (await pathExists(legacyRoot)) return [];
  const dataDir = getZoteroDataDir();
  return dataDir ? ["--zotero-root", dataDir] : [];
}

function appendTail(tail: string, chunk: string): string {
  const next = tail + chunk;
  return next.length > OUTPUT_TAIL_MAX
    ? next.slice(next.length - OUTPUT_TAIL_MAX)
    : next;
}

/** The last few meaningful lines of bridge output, for an error message. */
function summarizeOutput(tail: string): string {
  return tail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(READY_PREFIX))
    .slice(-6)
    .join("\n");
}

async function launchBridge(): Promise<string> {
  let Subprocess: GeckoSubprocess;
  try {
    Subprocess = loadGeckoSubprocess();
  } catch {
    throw new Error(
      "This version of Zotero cannot start programs, so Claude Code mode cannot start its bridge.",
    );
  }
  const nodePath = await resolveClaudeBridgeBinary(
    "node",
    getClaudeBridgeNodePathPref(),
    Subprocess,
  );
  const nodeVersion = await assertSupportedNodeVersion(nodePath, Subprocess);
  const claudePath = await resolveClaudeBridgeBinary(
    "claude",
    getClaudeCliPathPref(),
    Subprocess,
  );
  setStatus({ state: "starting", nodePath, nodeVersion, claudePath });
  const scriptPath = await materializeBridgeScript();
  const info = getRuntimePlatformInfo();
  const toolDirs = await listClaudeBridgeToolDirs(info.platform);
  const args = [
    scriptPath,
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--managed-by",
    "llm-for-zotero",
    "--exit-on-stdin-close",
    "1",
    "--log-file",
    "1",
    "--claude-path",
    claudePath,
    ...(await buildZoteroRootArgs()),
    ...filterClaudeBridgeExtraArgs(
      parseClaudeBridgeExtraArgs(getClaudeBridgeExtraArgsPref()),
    ),
  ];
  const noProxy = mergeNoProxy();
  const token = getAuthToken();
  let proc: GeckoSubprocessProcess;
  try {
    proc = await Subprocess.call({
      command: nodePath,
      arguments: args,
      stderr: "stdout",
      workdir: getLocalParentPath(scriptPath),
      environmentAppend: true,
      environment: {
        ADAPTER_AUTH_TOKEN: token,
        PATH: buildLaunchPath(
          [getLocalParentPath(nodePath), getLocalParentPath(claudePath)],
          toolDirs,
        ),
        NO_PROXY: noProxy,
        no_proxy: noProxy,
      },
    });
  } catch (error) {
    throw new Error(
      `Could not start the Claude Code bridge with ${nodePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let tail = "";
  let lineBuffer = "";
  let resolveReady!: (info: ReadyInfo) => void;
  const ready = new Promise<ReadyInfo>((resolve) => {
    resolveReady = resolve;
  });
  // Keep draining output for the bridge's whole life: a full pipe would
  // block it.
  const readLoop = (async () => {
    while (proc.stdout?.readString) {
      let chunk = "";
      try {
        chunk = await proc.stdout.readString();
      } catch {
        break;
      }
      if (!chunk) break;
      tail = appendTail(tail, chunk);
      lineBuffer += chunk;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const readyInfo = parseClaudeBridgeReadyLine(line);
        if (readyInfo) resolveReady(readyInfo);
      }
    }
  })();
  const exitPromise = (async () => {
    await readLoop;
    try {
      await proc.wait?.();
    } catch {
      /* already gone */
    }
  })();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    ready.then((readyInfo) => ({ kind: "ready" as const, readyInfo })),
    exitPromise.then(() => ({ kind: "exited" as const })),
    new Promise<{ kind: "timeout" }>((resolve) => {
      timeoutId = setTimeout(
        () => resolve({ kind: "timeout" }),
        READY_TIMEOUT_MS,
      );
    }),
  ]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);

  if (outcome.kind !== "ready") {
    // A bridge that never became ready counts toward the give-up limit, so a
    // broken setup is not relaunched on every request.
    crashTimes.push(Date.now());
    if (outcome.kind === "timeout") {
      await proc.kill?.(500).catch(() => undefined);
    }
    const details = summarizeOutput(tail);
    throw new Error(
      outcome.kind === "timeout"
        ? `The Claude Code bridge did not start within ${READY_TIMEOUT_MS / 1000} seconds.${details ? `\n${details}` : ""}`
        : `The Claude Code bridge stopped while starting.${details ? `\n${details}` : ""}`,
    );
  }

  if (shuttingDown) {
    // Zotero is closing: do not keep a bridge nothing will stop, and do not
    // register a quit blocker after shutdown removed it.
    await proc.stdin?.close?.().catch(() => undefined);
    await proc.kill?.(500).catch(() => undefined);
    throw new Error(
      "Zotero is closing, so the Claude Code bridge was stopped.",
    );
  }
  const { readyInfo } = outcome;
  const baseUrl = `http://127.0.0.1:${readyInfo.port}/${token}`;
  const bridge: RunningBridge = {
    proc,
    baseUrl,
    stopping: false,
    exited: exitPromise,
  };
  running = bridge;
  setManagedClaudeBridgeBaseUrl(baseUrl);
  if (!unregisterQuitBlocker) {
    unregisterQuitBlocker = registerAppQuitBlocker(
      "llm-for-zotero: stop Claude Code bridge",
      () => stopClaudeBridge(),
    );
  }
  setStatus({
    state: "running",
    nodePath,
    nodeVersion,
    claudePath,
    port: readyInfo.port,
    bridgeVersion: readyInfo.version,
    stateDir: readyInfo.stateDir,
    logFile: readyInfo.logFile,
  });
  appLogger.info(
    `LLM: Claude Code bridge running on port ${readyInfo.port} (node ${nodeVersion})`,
  );

  void exitPromise.then(() => {
    if (running !== bridge) return;
    running = null;
    clearManagedClaudeBridgeBaseUrl();
    if (bridge.stopping) return;
    crashTimes.push(Date.now());
    const details = summarizeOutput(tail);
    appLogger.warn(`LLM: Claude Code bridge stopped unexpectedly\n${details}`);
    setStatus({
      ...status,
      state: "failed",
      port: undefined,
      message: `The Claude Code bridge stopped unexpectedly. It will start again when it is next needed.${details ? `\n${details}` : ""}`,
    });
  });

  void maybeShowLegacyDaemonNotice();
  return baseUrl;
}

/**
 * People on Windows often run the bridge in WSL on the default address. While
 * the user has not chosen a mode, an unmarked bridge answering there is their
 * own: save "custom" and return its URL so the managed bridge is not started
 * (node and claude live in WSL, so it would fail). When nothing answers, the
 * mode stays unset so a later run can still find a bridge started afterwards.
 * On macOS the same answer is the old LaunchAgent, which moves to the managed
 * bridge, so this is Windows only. Returns null to start the managed bridge.
 */
async function adoptOwnWindowsBridge(): Promise<string | null> {
  if (getRuntimePlatformInfo().platform !== "windows") return null;
  if (!isClaudeBridgeModeImplicit()) return null;
  if (!(await detectLegacyClaudeBridge())) return null;
  setClaudeBridgeMode("custom");
  appLogger.info(
    "LLM: a Claude Code bridge answers on the default address; using it as your own bridge",
  );
  return getCustomClaudeBridgeUrl().replace(/\/+$/, "");
}

/**
 * Starts the bridge if it is not running, and returns its base URL. Refuses
 * while Claude Code mode is off. Concurrent callers share one start. After
 * repeated crashes it stops trying until the user presses Restart, so a
 * broken setup does not loop.
 */
export async function ensureClaudeBridgeRunning(): Promise<string> {
  if (running) return running.baseUrl;
  if (startPromise) return startPromise;
  // People who do not use Claude Code mode never get a bridge, even when the
  // settings page asks for the model list.
  if (!isClaudeCodeModeEnabled()) {
    throw new Error(
      "Claude Code mode is off, so the Claude Code bridge was not started. Turn on Claude Code mode in the settings to use it.",
    );
  }
  const now = Date.now();
  crashTimes = crashTimes.filter((time) => now - time < CRASH_WINDOW_MS);
  if (crashTimes.length >= MAX_CRASHES_IN_WINDOW) {
    const message =
      "The Claude Code bridge keeps stopping, so it was not started again. Open the Claude Code settings to see the log, then press Restart bridge.";
    setStatus({ ...status, state: "failed", port: undefined, message });
    throw new Error(message);
  }
  setStatus({ state: "starting" });
  startPromise = adoptOwnWindowsBridge()
    .then((ownUrl) => {
      if (ownUrl === null) return launchBridge();
      setStatus({ state: "stopped" });
      return ownUrl;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!shuttingDown) setStatus({ ...status, state: "failed", message });
      throw error;
    })
    .finally(() => {
      startPromise = null;
    });
  return startPromise;
}

export async function stopClaudeBridge(): Promise<void> {
  const pendingStart = startPromise;
  if (pendingStart) await pendingStart.catch(() => undefined);
  const bridge = running;
  if (!bridge) {
    if (status.state !== "failed" && !startPromise) {
      setStatus({ state: "stopped" });
    }
    return;
  }
  bridge.stopping = true;
  running = null;
  clearManagedClaudeBridgeBaseUrl();
  // Closing stdin asks the bridge to shut down by itself.
  await bridge.proc.stdin?.close?.().catch(() => undefined);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const stopped = await Promise.race([
    bridge.exited.then(() => true),
    new Promise<boolean>((resolve) => {
      timeoutId = setTimeout(() => resolve(false), STOP_TIMEOUT_MS);
    }),
  ]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);
  if (!stopped) await bridge.proc.kill?.(500).catch(() => undefined);
  // A start that began while this stop was waiting owns the status now.
  if (!running && !startPromise) setStatus({ state: "stopped" });
}

/** Restart from the settings: also forgets earlier crashes. */
export async function restartClaudeBridge(): Promise<string> {
  crashTimes = [];
  await stopClaudeBridge();
  return ensureClaudeBridgeRunning();
}

export function isManagedClaudeBridgeActive(): boolean {
  return getClaudeBridgeMode() === "managed";
}

/**
 * fetch() for every request to the Claude Code bridge. In managed mode it
 * starts the bridge when needed and points the request at the live bridge,
 * even if the URL was built before the bridge started or restarted. Other
 * URLs go to fetch() unchanged.
 */
export async function claudeBridgeFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const base = matchManagedClaudeBridgeBase(url);
  if (!base || !isManagedClaudeBridgeActive()) return fetch(url, init);
  const liveBase = await ensureClaudeBridgeRunning();
  return fetch(liveBase + url.slice(base.length), init);
}

/**
 * True when `url` is for the managed bridge and no bridge is running. Calls
 * that only touch a running bridge's memory (keeping a warm session alive,
 * dropping warm sessions) have nothing to do then, and must not start one.
 */
export function isManagedClaudeBridgeIdle(url: string): boolean {
  return (
    isManagedClaudeBridgeActive() &&
    Boolean(matchManagedClaudeBridgeBase(url)) &&
    !running
  );
}

/**
 * The text that tells the user how to remove the old stand-alone bridge.
 * The one-time notice and the Settings page both use it, so they cannot drift.
 */
export function describeLegacyClaudeBridgeRemoval(isMac: boolean): string[] {
  const removal = isMac
    ? [
        "To remove it, open Terminal in your old cc-llm4zotero-adapter folder and run:",
        "    npm run daemon:uninstall",
        "",
        "If you already deleted that folder, run these two commands instead:",
        `    launchctl bootout gui/$(id -u)/${LEGACY_DAEMON_LABEL}`,
        `    rm ~/Library/LaunchAgents/${LEGACY_DAEMON_LABEL}.plist`,
      ]
    : [
        "You can stop it the way you started it (for example, close the terminal running `npm run serve:bridge`).",
      ];
  return [
    "Zotero now runs the Claude Code bridge for you, so you no longer need to start it yourself.",
    "",
    `Your old bridge is still running at ${DEFAULT_CLAUDE_BRIDGE_URL}. It does not get in the way, but it is no longer used.`,
    "",
    ...removal,
  ];
}

/**
 * True when the old stand-alone bridge answers on the default port. The probe
 * is off when the hidden pref claudeCodeLegacyDaemonCheck is false (tests).
 */
export async function detectLegacyClaudeBridge(): Promise<boolean> {
  try {
    if (!isClaudeLegacyDaemonCheckEnabled()) return false;
    // Zotero's plugin scope has no global AbortController.
    const AbortControllerCtor = getAbortController();
    const controller = AbortControllerCtor
      ? new AbortControllerCtor()
      : undefined;
    const timeoutId = setTimeout(() => controller?.abort(), 1500);
    let payload: any = null;
    try {
      const response = await fetch(`${DEFAULT_CLAUDE_BRIDGE_URL}/healthz`, {
        signal: controller?.signal,
      });
      payload = response.ok ? await response.json() : null;
    } catch {
      payload = null;
    } finally {
      clearTimeout(timeoutId);
    }
    return Boolean(payload?.ok) && !payload.managedBy;
  } catch (error) {
    appLogger.debug("LLM: legacy Claude bridge check failed", error);
    return false;
  }
}

/**
 * The old macOS LaunchAgent may still be running the stand-alone adapter on
 * the default port. It does not get in the way, but it uses memory and runs
 * old code, so tell the user once. The message must never block the UI; the
 * full removal steps are on the Settings page.
 */
async function maybeShowLegacyDaemonNotice(): Promise<void> {
  try {
    if (hasShownClaudeLegacyDaemonNotice()) return;
    if (!(await detectLegacyClaudeBridge())) return;
    markClaudeLegacyDaemonNoticeShown();
    new ztoolkit.ProgressWindow("Claude Code bridge", {
      closeOnClick: true,
      closeTime: -1,
    })
      .createLine({
        text: "Your old Claude Code bridge is still running. Open Settings > Claude Code to see how to remove it.",
        type: "default",
      })
      .show()
      .startCloseTimer(8000);
  } catch (error) {
    appLogger.debug("LLM: legacy Claude bridge notice failed", error);
  }
}

/** For shutdown: stops the bridge and drops the quit blocker. */
export async function shutdownClaudeBridge(): Promise<void> {
  shuttingDown = true;
  unregisterQuitBlocker?.();
  unregisterQuitBlocker = null;
  await stopClaudeBridge();
}

let lifecycleObserverIds: unknown[] = [];

/**
 * Called once at startup. Starts the bridge early when Claude Code mode is
 * already on (so the model list is ready when the panel opens), and stops it
 * when the user turns the mode off or switches to their own bridge. With the
 * mode off nothing starts; a later request starts the bridge on demand.
 */
export function installClaudeBridgeLifecycle(params: {
  prefsPrefix: string;
  isClaudeCodeModeEnabled: () => boolean;
}): void {
  shuttingDown = false;
  const prefs = (Zotero as any)?.Prefs;
  const stopUnlessWanted = () => {
    if (!params.isClaudeCodeModeEnabled() || !isManagedClaudeBridgeActive()) {
      void stopClaudeBridge();
    }
  };
  try {
    for (const key of ["enableClaudeCodeMode", "claudeCodeBridgeMode"]) {
      lifecycleObserverIds.push(
        prefs?.registerObserver?.(
          `${params.prefsPrefix}.${key}`,
          stopUnlessWanted,
          true,
        ),
      );
    }
  } catch (error) {
    appLogger.debug("LLM: Claude bridge pref observers unavailable", error);
  }
  if (params.isClaudeCodeModeEnabled() && isManagedClaudeBridgeActive()) {
    void ensureClaudeBridgeRunning().catch((error) => {
      appLogger.warn("LLM: Claude Code bridge did not start", error);
    });
  }
}

export async function uninstallClaudeBridgeLifecycle(): Promise<void> {
  const prefs = (Zotero as any)?.Prefs;
  for (const id of lifecycleObserverIds) {
    try {
      if (id !== undefined) prefs?.unregisterObserver?.(id);
    } catch {
      /* already gone */
    }
  }
  lifecycleObserverIds = [];
  await shutdownClaudeBridge();
}

export function resetClaudeBridgeProcessForTests(): void {
  status = { state: "stopped" };
  statusListeners.clear();
  running = null;
  startPromise = null;
  crashTimes = [];
  unregisterQuitBlocker = null;
  authToken = "";
  shuttingDown = false;
  lifecycleObserverIds = [];
}
