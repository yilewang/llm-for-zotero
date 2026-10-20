import { CodexAppServerProcess } from "../utils/codexAppServerProcess";
import { pathExists } from "../utils/geckoFs";
import { getRuntimePlatformInfo } from "../utils/runtimePlatform";
import { appLogger } from "../core/logging";
import { getCliProxyOverride, parseScutilProxy } from "../utils/cliProxy";
import {
  describeAgyFailure,
  encodeAgyUserEvent,
  isAgyAuthenticationFailure,
  parseAgyStreamLine,
  type AgyEvent,
} from "./agyStream";

/**
 * Runs one turn of the Antigravity CLI in headless stream-json mode.
 *
 * Every turn is its own `agy` process: the conversation lives on agy's side
 * and is resumed with `--conversation <id>`, so nothing has to stay running
 * between turns. The prompt goes in as one stdin `user` event; stdin stays
 * open until the turn's `result` arrives, then closing it ends the session.
 *
 * Authentication is agy's own: it uses the Google sign-in saved by an
 * interactive `agy` run. The plugin never reads or forwards those credentials.
 */

export type AgyTurnOptions = {
  binaryPath?: string;
  prompt: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  mode?: "plan";
  skipPermissions?: boolean;
  conversationId?: string;
  /** Folders agy may read besides its workspace (`--add-dir`). */
  addDirs?: string[];
  cwd?: string;
  signal?: AbortSignal;
  onEvent: (event: AgyEvent) => void;
};

export type AgyTurnResult = Extract<AgyEvent, { kind: "result" }>;

const AGY_ENV_KEYS = [
  "AGY_PATH",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "PATH",
];

function getRuntimeEnvValue(key: string): string | undefined {
  const processValue = (globalThis as any).process?.env?.[key];
  if (typeof processValue === "string" && processValue.trim()) {
    return processValue.trim();
  }
  try {
    const servicesValue = (globalThis as any).Services?.env?.get?.(key);
    if (typeof servicesValue === "string" && servicesValue.trim()) {
      return servicesValue.trim();
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function getAgyRuntimeEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of AGY_ENV_KEYS) env[key] = getRuntimeEnvValue(key);
  return env;
}

function joinPath(separator: string, ...parts: string[]): string {
  return parts
    .map((part, index) =>
      index === 0
        ? part.replace(/[\\/]+$/, "")
        : part.replace(/^[\\/]+|[\\/]+$/g, ""),
    )
    .filter(Boolean)
    .join(separator);
}

function normalizeExplicitPath(value?: string | null): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  const quoted = trimmed.match(/^(['"])(.*)\1$/);
  return (quoted?.[2] ?? trimmed).trim();
}

export function listAgyBinaryCandidates(params: {
  platform: "windows" | "macos" | "linux";
  home?: string;
  localAppData?: string;
}): string[] {
  const { platform, home } = params;
  if (platform === "windows") {
    return [
      home ? joinPath("\\", home, ".local", "bin", "agy.exe") : "",
      home ? joinPath("\\", home, ".antigravity", "bin", "agy.exe") : "",
      params.localAppData
        ? joinPath("\\", params.localAppData, "Programs", "agy", "agy.exe")
        : "",
      params.localAppData
        ? joinPath("\\", params.localAppData, "agy", "agy.exe")
        : "",
    ].filter(Boolean);
  }
  return [
    home ? joinPath("/", home, ".local", "bin", "agy") : "",
    home ? joinPath("/", home, ".antigravity", "bin", "agy") : "",
    ...(platform === "macos" ? ["/opt/homebrew/bin/agy"] : []),
    "/usr/local/bin/agy",
    "/usr/bin/agy",
  ].filter(Boolean);
}

async function lookUpAgyOnShellPath(Subprocess: any): Promise<string> {
  const info = getRuntimePlatformInfo();
  try {
    const proc = await Subprocess.call({
      command: info.shellPath,
      arguments:
        info.platform === "windows"
          ? [info.shellFlag, "where agy"]
          : // A login shell reads the profile that usually puts ~/.local/bin
            // on PATH; Zotero launched from the dock does not inherit it.
            ["-lc", "command -v agy"],
    });
    let out = "";
    while (true) {
      const chunk = await proc.stdout?.readString?.();
      if (!chunk) break;
      out += chunk;
    }
    const exit = await proc.wait?.();
    if (typeof exit?.exitCode === "number" && exit.exitCode !== 0) return "";
    const first = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first || "";
  } catch {
    return "";
  }
}

export function createAgyNotFoundError(): Error {
  return new Error(
    "Antigravity CLI (agy) was not found. Install it from https://antigravity.google/docs/cli/install, run `agy` once in a terminal to sign in, " +
      "or set the Antigravity CLI path in the plugin's Agent settings.",
  );
}

export async function resolveAgyBinary(explicitPath?: string): Promise<string> {
  const explicit = normalizeExplicitPath(explicitPath);
  if (explicit) return explicit;
  const env = getAgyRuntimeEnv();
  const fromEnv = normalizeExplicitPath(env.AGY_PATH);
  if (fromEnv) return fromEnv;
  const Subprocess = await CodexAppServerProcess.loadSubprocessModule();
  const found = await lookUpAgyOnShellPath(Subprocess);
  if (found) return found;
  const info = getRuntimePlatformInfo();
  for (const candidate of listAgyBinaryCandidates({
    platform: info.platform,
    home: env.HOME || env.USERPROFILE,
    localAppData: env.LOCALAPPDATA,
  })) {
    if (await pathExists(candidate)) return candidate;
  }
  throw createAgyNotFoundError();
}

export function buildAgyArguments(
  options: Pick<
    AgyTurnOptions,
    | "model"
    | "effort"
    | "mode"
    | "skipPermissions"
    | "conversationId"
    | "addDirs"
  >,
): string[] {
  // --print always takes a value: a bare one swallows the next flag as its
  // prompt (agy 1.4.2). An empty prompt leaves the turns to stream-json stdin.
  const args = [
    "--print=",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    // Paper text and questions are content, never `/command`s or skills.
    "--disable-slash-commands",
  ];
  if (options.model?.trim()) args.push("--model", options.model.trim());
  if (options.effort) args.push("--effort", options.effort);
  if (options.mode) args.push("--mode", options.mode);
  if (options.skipPermissions) args.push("--dangerously-skip-permissions");
  if (options.conversationId?.trim()) {
    args.push("--conversation", options.conversationId.trim());
  }
  for (const dir of options.addDirs ?? []) {
    if (dir.trim()) args.push("--add-dir", dir.trim());
  }
  return args;
}

function buildLaunchPath(binary: string): string {
  const info = getRuntimePlatformInfo();
  const separator = info.platform === "windows" ? ";" : ":";
  const env = getAgyRuntimeEnv();
  const home = env.HOME || env.USERPROFILE || "";
  const binaryDir = binary.replace(/[\\/][^\\/]*$/, "");
  const entries =
    info.platform === "windows"
      ? [binaryDir]
      : [
          binaryDir,
          home ? `${home}/.local/bin` : "",
          ...(info.platform === "macos" ? ["/opt/homebrew/bin"] : []),
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
        ];
  const seen = new Set<string>();
  return [...entries, ...(env.PATH || "").split(separator)]
    .map((entry) => entry.trim())
    .filter((entry) => entry && !seen.has(entry) && seen.add(entry))
    .join(separator);
}

const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
];

let systemProxyCache: { at: number; env: Record<string, string> } | null = null;

async function readMacSystemProxy(): Promise<Record<string, string>> {
  if (systemProxyCache && Date.now() - systemProxyCache.at < 30_000) {
    return systemProxyCache.env;
  }
  let env: Record<string, string> = {};
  try {
    const Subprocess = await CodexAppServerProcess.loadSubprocessModule();
    const proc = await Subprocess.call({
      command: "/usr/sbin/scutil",
      arguments: ["--proxy"],
    });
    let out = "";
    while (true) {
      const chunk = await proc.stdout?.readString?.();
      if (!chunk) break;
      out += chunk;
    }
    await proc.wait?.();
    env = parseScutilProxy(out);
  } catch (error) {
    appLogger.warn("Antigravity: could not read the macOS proxy", error);
  }
  systemProxyCache = { at: Date.now(), env };
  return env;
}

/**
 * PATH plus the proxy from Settings. In "system" mode agy, a Go binary that
 * reads only the *_PROXY variables and never the macOS system proxy, is given
 * that system proxy when Zotero itself (opened from the Dock) has none: with
 * Clash in system-proxy mode it could not reach Google otherwise.
 */
async function buildAgyLaunchEnvironment(
  binary: string,
): Promise<Record<string, string>> {
  const env: Record<string, string> = { PATH: buildLaunchPath(binary) };
  const override = getCliProxyOverride();
  if (override) return Object.assign(env, override);
  const hasProxy = PROXY_ENV_KEYS.some((key) => getRuntimeEnvValue(key));
  if (!hasProxy && getRuntimePlatformInfo().platform === "macos") {
    Object.assign(env, await readMacSystemProxy());
  }
  return env;
}

class AgyTurnError extends Error {
  constructor(
    message: string,
    readonly authRequired = false,
  ) {
    super(message);
    this.name = "AgyTurnError";
  }
}

export function isAgyAuthRequiredError(error: unknown): boolean {
  return error instanceof AgyTurnError && error.authRequired;
}

function createAbortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

const AGY_STDIN_EOF_FALLBACK_MS = 15_000;
const AGY_MODEL_LIST_TIMEOUT_MS = 30_000;
const AGY_EXIT_WAIT_MS = 3_000;
/** How long Subprocess waits after SIGTERM before it sends SIGKILL. */
const AGY_KILL_GRACE_MS = 300;

function killAgy(proc: any): void {
  try {
    const killed = proc?.kill?.(AGY_KILL_GRACE_MS);
    killed?.catch?.(() => undefined);
  } catch {
    /* already exited */
  }
}

/** The promise's value, or undefined once `ms` pass or it rejects. */
async function settleWithin<T>(
  promise: Promise<T> | undefined,
  ms: number,
): Promise<T | undefined> {
  if (!promise) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runAgyTurn(
  options: AgyTurnOptions,
): Promise<AgyTurnResult> {
  if (options.signal?.aborted) throw createAbortError();
  const Subprocess = await CodexAppServerProcess.loadSubprocessModule();
  const binary = await resolveAgyBinary(options.binaryPath);
  const { command, commandArgs } = buildAgyCommand(
    binary,
    buildAgyArguments(options),
  );

  let proc: any;
  try {
    proc = await Subprocess.call({
      command,
      arguments: commandArgs,
      stderr: "pipe",
      environment: await buildAgyLaunchEnvironment(binary),
      environmentAppend: true,
      ...(options.cwd ? { workdir: options.cwd } : {}),
    });
  } catch (error) {
    throw new AgyTurnError(
      `Failed to start Antigravity CLI (${binary}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let stderr = "";
  let stdinClosed = false;
  const closeStdin = async () => {
    if (stdinClosed) return;
    stdinClosed = true;
    try {
      await proc.stdin?.close?.();
    } catch {
      /* already closed */
    }
  };
  const onAbort = () => killAgy(proc);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const stderrLoop = (async () => {
    while (true) {
      let chunk = "";
      try {
        chunk = await proc.stderr?.readString?.();
      } catch {
        break;
      }
      if (!chunk) break;
      stderr = (stderr + chunk).slice(-8000);
    }
  })();

  // agy reads stream-json input line by line, so stdin stays open until the
  // turn's result. Should a build wait for end of input instead, nothing
  // would ever arrive: after a quiet spell stdin is closed so it can start.
  let firstEventSeen = false;
  const eofFallback = setTimeout(() => {
    if (!firstEventSeen) void closeStdin();
  }, AGY_STDIN_EOF_FALLBACK_MS);
  try {
    // agy may exit before it reads the input (a flag it rejects, an input
    // line it cannot take). The write then fails with "File closed"; keep
    // reading so the error agy printed is what the user sees.
    let writeError: unknown = null;
    try {
      await proc.stdin.write(encodeAgyUserEvent(options.prompt));
    } catch (error) {
      writeError = error;
      stdinClosed = true;
    }
    let buffer = "";
    let result: AgyTurnResult | null = null;
    while (!result) {
      let chunk = "";
      try {
        chunk = await proc.stdout.readString();
      } catch {
        break;
      }
      if (!chunk) break;
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseAgyStreamLine(line);
        if (!event) continue;
        firstEventSeen = true;
        options.onEvent(event);
        if (event.kind === "result") {
          result = event;
          break;
        }
      }
    }
    await closeStdin();
    // agy 1.4.2 keeps running once the result is out, even at end of input,
    // and ignores SIGTERM, so the turn ends it. When stdout closed without a
    // result agy is already exiting; give it a moment to report its code.
    if (result) killAgy(proc);
    let exit = await settleWithin<{ exitCode?: number }>(
      proc.wait?.(),
      AGY_EXIT_WAIT_MS,
    );
    if (!exit) {
      killAgy(proc);
      exit = await settleWithin(proc.wait?.(), AGY_EXIT_WAIT_MS);
    }
    await settleWithin(stderrLoop, AGY_EXIT_WAIT_MS);
    if (options.signal?.aborted) throw createAbortError();
    if (result) {
      if (/^(SUCCESS|OK|COMPLETED?)$/i.test(result.status) || result.response) {
        return result;
      }
      const message =
        result.error || describeAgyFailure(stderr) || result.status;
      throw new AgyTurnError(
        `Antigravity CLI failed: ${message}`,
        isAgyAuthenticationFailure(message),
      );
    }
    const writeFailure = writeError
      ? ` (agy stopped reading its input: ${
          writeError instanceof Error ? writeError.message : String(writeError)
        })`
      : "";
    const message =
      describeAgyFailure(stderr) ||
      `agy exited with code ${String(exit?.exitCode ?? "unknown")}${writeFailure}`;
    appLogger.warn("Antigravity CLI turn ended without a result", {
      exitCode: exit?.exitCode,
      writeError,
      stderr: stderr.slice(-2000),
    });
    throw new AgyTurnError(
      isAgyAuthenticationFailure(message)
        ? "Antigravity CLI is not signed in. Run `agy` once in a terminal and sign in with your Google account, then try again."
        : `Antigravity CLI failed: ${message}`,
      isAgyAuthenticationFailure(message),
    );
  } finally {
    clearTimeout(eofFallback);
    options.signal?.removeEventListener("abort", onAbort);
    await closeStdin();
    killAgy(proc);
  }
}

/** A Windows `.cmd`/`.ps1` shim cannot be spawned directly; run it via cmd. */
function buildAgyCommand(
  binary: string,
  args: string[],
): { command: string; commandArgs: string[] } {
  const info = getRuntimePlatformInfo();
  const isWindowsShim =
    info.platform === "windows" && !/\.(exe|com)$/i.test(binary);
  return isWindowsShim
    ? {
        command: info.shellPath,
        commandArgs: [
          "/d",
          "/s",
          "/c",
          [binary, ...args].map(quoteWindowsArg).join(" "),
        ],
      }
    : { command: binary, commandArgs: args };
}

function quoteWindowsArg(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

type AgyCapture = { stdout: string; stderr: string; timedOut: boolean };

async function captureAgy(binary: string, args: string[]): Promise<AgyCapture> {
  const Subprocess = await CodexAppServerProcess.loadSubprocessModule();
  const { command, commandArgs } = buildAgyCommand(binary, args);
  const proc = await Subprocess.call({
    command,
    arguments: commandArgs,
    stderr: "pipe",
    environment: await buildAgyLaunchEnvironment(binary),
    environmentAppend: true,
  });
  // A CLI that is not signed in may wait for a browser sign-in; give up
  // rather than leave the caller spinning.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killAgy(proc);
  }, AGY_MODEL_LIST_TIMEOUT_MS);
  const drain = async (pipe: typeof proc.stdout) => {
    let text = "";
    while (pipe) {
      const chunk = await pipe.readString?.();
      if (!chunk) break;
      text += chunk;
    }
    return text;
  };
  try {
    const [stdout, stderr] = await Promise.all([
      drain(proc.stdout),
      drain(proc.stderr),
    ]);
    await settleWithin(proc.wait?.(), AGY_EXIT_WAIT_MS);
    return { stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The models this account can use. agy 1.4.2 prints a plain table for
 * `agy models`; the JSON form is tried after it for builds that offer one.
 */
export async function listAgyModels(binaryPath?: string): Promise<AgyModel[]> {
  const binary = await resolveAgyBinary(binaryPath);
  let failure = "";
  for (const args of [["models"], ["models", "--output-format", "json"]]) {
    const run = await captureAgy(binary, args);
    if (run.timedOut) {
      throw new AgyTurnError(
        "agy models did not answer. Run `agy` once in a terminal and sign in with your Google account.",
        true,
      );
    }
    const models = parseAgyModelList(run.stdout);
    if (models.length) return models;
    if (run.stderr.trim()) failure = describeAgyFailure(run.stderr);
  }
  if (failure) throw new AgyTurnError(`agy models: ${failure}`, false);
  return [];
}

/**
 * The account's quota as `agy -p /usage --output-format json` prints it.
 * agy answers that command itself: no model turn runs and no quota is used.
 */
export async function readAgyUsage(binaryPath?: string): Promise<string> {
  const binary = await resolveAgyBinary(binaryPath);
  const run = await captureAgy(binary, [
    "-p",
    "/usage",
    "--output-format",
    "json",
  ]);
  if (run.timedOut) throw new AgyTurnError("agy /usage did not answer.", true);
  return run.stdout;
}

/** One model `agy models` lists: the slug `--model` takes and its name. */
export type AgyModel = { id: string; label: string };

export function parseAgyModelList(raw: string): AgyModel[] {
  const models: AgyModel[] = [];
  const text = (value: unknown) =>
    typeof value === "string" ? value.trim() : "";
  const add = (value: unknown) => {
    if (text(value)) models.push({ id: text(value), label: text(value) });
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const id =
        text(record.slug) ||
        text(record.id) ||
        text(record.model) ||
        text(record.name);
      if (!id) return;
      const label =
        text(record.display_name) ||
        text(record.displayName) ||
        text(record.label) ||
        text(record.name) ||
        id;
      models.push({ id, label });
    }
  };
  const visit = (parsed: unknown) => {
    if (Array.isArray(parsed)) parsed.forEach(add);
    else if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      if (Array.isArray(record.models)) record.models.forEach(add);
      else add(record);
    }
  };
  const trimmed = raw.trim();
  try {
    visit(JSON.parse(trimmed));
  } catch {
    // stream-json style: one object per line.
    for (const line of trimmed.split(/\r?\n/)) {
      try {
        visit(JSON.parse(line));
      } catch {
        /* not JSON */
      }
    }
  }
  if (!models.length) models.push(...parseAgyModelText(trimmed));
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

const ANSI_ESCAPE = /\u001b\[[0-9;?]*[A-Za-z]/g;
const MODEL_SLUG = /^[a-z0-9][a-z0-9._:/-]*$/;

/**
 * The plain `agy models` listing, as agy 1.4.2 prints it: one model per
 * line, the slug and then its display name ("gemini-4-argon-high  Gemini 4
 * Argon (High)"), maybe after a bullet or a "current" marker. Only
 * slug-shaped first tokens are kept, so headers and prose drop out.
 */
function parseAgyModelText(raw: string): AgyModel[] {
  const models: AgyModel[] = [];
  for (const rawLine of raw.replace(ANSI_ESCAPE, "").split(/\r?\n/)) {
    const line = rawLine
      .replace(/^[\s*•>✓✔→-]+/u, "")
      .replace(/^\d+[.)]\s+/, "")
      .trim();
    const token = line.split(/[\s,|(]/)[0] || "";
    const id = token.replace(/[:,]$/, "");
    if (
      MODEL_SLUG.test(id) &&
      /[a-z]/.test(id) &&
      /\d/.test(id) &&
      /[-./]/.test(id)
    ) {
      const label = line
        .slice(token.length)
        .replace(/^[\s,|:–—-]+/u, "")
        .trim();
      models.push({ id, label: label || id });
    }
  }
  return models;
}
