/**
 * Starting and pooling `agy acp` processes.
 *
 * agy runs tools in its own process working directory and ignores the `cwd`
 * a session asks for, so each working directory gets its own process.
 * `--dangerously-skip-permissions` is a process flag, not a session mode, so
 * full access gets its own process too. The pool key names the binary
 * setting, the folder, and the flag; changing any of them starts a fresh
 * process.
 */

import { AcpClient } from "./acpClient";
import {
  buildLoopbackNoProxyEnvironment,
  readRuntimeEnvValue,
} from "../utils/childProcessEnvironment";
import { pathExists } from "../utils/geckoFs";
import {
  loadGeckoSubprocess,
  readGeckoSubprocessPipe,
  type GeckoSubprocess,
} from "../utils/geckoSubprocess";
import { KeyedProcessPool } from "../utils/keyedProcessPool";
import { getRuntimePlatformInfo } from "../utils/runtimePlatform";

export const AGY_BINARY_NAME = "agy";
export const AGY_SKIP_PERMISSIONS_FLAG = "--dangerously-skip-permissions";

export type AgyLaunchOptions = {
  /** The conversation's working directory; agy's process runs there. */
  cwd: string;
  /** Full access: agy approves every tool itself. */
  skipPermissions: boolean;
  /** A configured agy path; empty means look it up. */
  agyPath?: string;
};

export class AgyNotFoundError extends Error {
  constructor() {
    super(
      "The Antigravity CLI (agy) was not found. Install it, and check that `agy` runs in a terminal.",
    );
    this.name = "AgyNotFoundError";
  }
}

export class AgyWorkingDirectoryError extends Error {
  constructor(cwd: string) {
    super(`The Antigravity working folder does not exist: ${cwd}`);
    this.name = "AgyWorkingDirectoryError";
  }
}

function joinPath(separator: string, ...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((part, index) =>
      index === 0
        ? part.replace(/[\\/]+$/, "")
        : part.replace(/^[\\/]+|[\\/]+$/g, ""),
    )
    .join(separator);
}

function unique(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function directoryOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : "";
}

/** The folders agy is commonly installed in, for the PATH and the lookup. */
function commonAgyDirectories(): string[] {
  const info = getRuntimePlatformInfo();
  const home =
    readRuntimeEnvValue("HOME") || readRuntimeEnvValue("USERPROFILE") || "";
  if (info.platform === "windows") {
    const localAppData = readRuntimeEnvValue("LOCALAPPDATA") || "";
    return unique([
      home ? joinPath("\\", home, ".local", "bin") : "",
      localAppData ? joinPath("\\", localAppData, "Programs", "agy") : "",
    ]);
  }
  return unique([
    home ? joinPath("/", home, ".local", "bin") : "",
    info.platform === "macos" ? "/opt/homebrew/bin" : "",
    "/usr/local/bin",
    "/usr/bin",
  ]);
}

async function lookUpOnShellPath(
  Subprocess: GeckoSubprocess,
): Promise<string | undefined> {
  const info = getRuntimePlatformInfo();
  try {
    const proc = await Subprocess.call({
      command: info.shellPath,
      arguments: [
        info.shellFlag,
        info.platform === "windows"
          ? `where ${AGY_BINARY_NAME}`
          : `command -v ${AGY_BINARY_NAME}`,
      ],
    });
    const output = await readGeckoSubprocessPipe(proc.stdout);
    const exit = await proc.wait?.();
    if (exit && exit.exitCode !== undefined && exit.exitCode !== 0) {
      return undefined;
    }
    const first = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first && (await pathExists(first)) ? first : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Finds agy: the configured path, then the `AGY_PATH` environment variable,
 * then the shell's PATH, then common install folders.
 */
export async function resolveAgyBinary(
  configuredPath?: string,
): Promise<string> {
  const explicit =
    String(configuredPath || "").trim() || readRuntimeEnvValue("AGY_PATH");
  if (explicit) {
    if (await pathExists(explicit)) return explicit;
    throw new AgyNotFoundError();
  }
  const found = await lookUpOnShellPath(loadGeckoSubprocess());
  if (found) return found;
  const windows = getRuntimePlatformInfo().platform === "windows";
  for (const directory of commonAgyDirectories()) {
    const candidate = joinPath(
      windows ? "\\" : "/",
      directory,
      windows ? `${AGY_BINARY_NAME}.exe` : AGY_BINARY_NAME,
    );
    if (await pathExists(candidate)) return candidate;
  }
  throw new AgyNotFoundError();
}

export function buildAgyArguments(skipPermissions: boolean): string[] {
  return skipPermissions ? ["acp", AGY_SKIP_PERMISSIONS_FLAG] : ["acp"];
}

/** PATH with agy's own folder and the common folders first; loopback unproxied. */
export function buildAgyEnvironment(binary: string): Record<string, string> {
  const separator = getRuntimePlatformInfo().platform === "windows" ? ";" : ":";
  const inherited =
    readRuntimeEnvValue("PATH") || readRuntimeEnvValue("Path") || "";
  const path = unique([
    directoryOf(binary),
    ...commonAgyDirectories(),
    ...inherited.split(separator),
  ]).join(separator);
  return {
    ...(path ? { PATH: path } : {}),
    ...buildLoopbackNoProxyEnvironment({
      NO_PROXY: readRuntimeEnvValue("NO_PROXY"),
      no_proxy: readRuntimeEnvValue("no_proxy"),
    }),
  };
}

export function buildAgyPoolKey(options: AgyLaunchOptions): string {
  return [
    `agy=${String(options.agyPath || "").trim()}`,
    `cwd=${options.cwd}`,
    `skip=${options.skipPermissions ? 1 : 0}`,
  ].join("\u0000");
}

/** Starts one `agy acp` process and connects an ACP client to it. */
export async function startAgyClient(
  options: AgyLaunchOptions,
): Promise<AcpClient> {
  if (!options.cwd || !(await pathExists(options.cwd))) {
    throw new AgyWorkingDirectoryError(options.cwd);
  }
  const binary = await resolveAgyBinary(options.agyPath);
  const args = buildAgyArguments(options.skipPermissions);
  const Subprocess = loadGeckoSubprocess();
  let child;
  try {
    child = await Subprocess.call({
      command: binary,
      arguments: args,
      workdir: options.cwd,
      stderr: "pipe",
      environment: buildAgyEnvironment(binary),
      environmentAppend: true,
    });
  } catch (error) {
    throw new Error(
      `Failed to start agy (${binary} ${args.join(" ")}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return AcpClient.connect({
    child,
    label: "agy acp",
    launchDescription: `${binary} ${args.join(" ")} (in ${options.cwd})`,
  });
}

const agyPool = new KeyedProcessPool<AcpClient>("LLM for Zotero: stop agy");

/** The pooled client for these launch options, starting agy on first use. */
export function getOrStartAgyClient(
  options: AgyLaunchOptions,
): Promise<AcpClient> {
  return agyPool.get(buildAgyPoolKey(options), () => startAgyClient(options));
}

/** Stops the pooled agy for these options (only `client`, when given). */
export function destroyAgyClient(
  options: AgyLaunchOptions,
  client?: AcpClient,
): void {
  agyPool.destroy(buildAgyPoolKey(options), client);
}

/** Stops every pooled agy process; runs on shutdown and on quit. */
export function destroyAllAgyClients(): Promise<void> {
  return agyPool.destroyAll();
}
