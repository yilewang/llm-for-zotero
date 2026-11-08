import { getIOUtils, pathExists } from "../utils/geckoFs";
import {
  GECKO_LOOKUP_TIMEOUT_MS,
  runGeckoSubprocessForOutput,
  type GeckoSubprocess,
} from "../utils/geckoSubprocess";
import { getLocalParentPath, joinLocalPath } from "../utils/localPath";
import {
  getRuntimePlatformInfo,
  type RuntimePlatform,
} from "../utils/runtimePlatform";

/**
 * Finds the two programs the Claude Code bridge needs: Node.js, which runs the
 * bridge, and the user's own `claude`, which the bridge runs for every turn.
 *
 * Zotero started from the Dock or Start menu does not see the user's shell
 * PATH, so a PATH lookup alone misses NVM, Volta, Homebrew and the native
 * Claude installer. Known install folders are checked after it.
 */

export const MIN_CLAUDE_BRIDGE_NODE_MAJOR = 18;

export type ClaudeBridgeBinaryKind = "node" | "claude";

export class ClaudeBridgeBinaryNotFoundError extends Error {
  readonly kind: ClaudeBridgeBinaryKind;
  constructor(kind: ClaudeBridgeBinaryKind, message: string) {
    super(message);
    this.name = "ClaudeBridgeBinaryNotFoundError";
    this.kind = kind;
  }
}

type BinaryEnv = Record<string, string | undefined>;

function readEnvValue(key: string): string | undefined {
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

const BINARY_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramFiles",
  "NVM_DIR",
  "NVM_HOME",
  "NVM_SYMLINK",
  "VOLTA_HOME",
  "NPM_CONFIG_PREFIX",
  "npm_config_prefix",
  "PATH",
  "Path",
];

export function readClaudeBridgeBinaryEnv(): BinaryEnv {
  const env: BinaryEnv = {};
  for (const key of BINARY_ENV_KEYS) env[key] = readEnvValue(key);
  return env;
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const normalized = (path || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/** Strips matching quotes users paste around a path. */
export function normalizeClaudeBridgeBinaryPref(
  value: string | null | undefined,
): string {
  const trimmed = (value || "").trim();
  const quoted = trimmed.match(/^(['"])(.*)\1$/);
  return (quoted ? quoted[2] : trimmed).trim();
}

async function listChildren(path: string): Promise<string[]> {
  const io = getIOUtils() as any;
  if (!io?.getChildren) return [];
  try {
    const children = await io.getChildren(path);
    return Array.isArray(children)
      ? children.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

/** NVM's installed Node versions, newest first. */
async function listNvmBinDirs(env: BinaryEnv): Promise<string[]> {
  const home = env.HOME;
  const root = env.NVM_DIR || (home ? joinLocalPath(home, ".nvm") : "");
  if (!root) return [];
  const versionsDir = joinLocalPath(root, "versions", "node");
  const children = await listChildren(versionsDir);
  return children
    .map((child) =>
      child.includes("/") ? child : joinLocalPath(versionsDir, child),
    )
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((versionDir) => joinLocalPath(versionDir, "bin"));
}

/** Folders where Node and npm-installed tools usually live, best first. */
export async function listClaudeBridgeToolDirs(
  platform: RuntimePlatform,
  env: BinaryEnv = readClaudeBridgeBinaryEnv(),
): Promise<string[]> {
  if (platform === "windows") {
    const userProfile = env.USERPROFILE;
    const appData =
      env.APPDATA ||
      (userProfile ? joinLocalPath(userProfile, "AppData", "Roaming") : "");
    const localAppData =
      env.LOCALAPPDATA ||
      (userProfile ? joinLocalPath(userProfile, "AppData", "Local") : "");
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    return uniquePaths([
      userProfile ? joinLocalPath(userProfile, ".local", "bin") : "",
      appData ? joinLocalPath(appData, "npm") : "",
      env.NVM_SYMLINK,
      env.VOLTA_HOME ? joinLocalPath(env.VOLTA_HOME, "bin") : "",
      localAppData ? joinLocalPath(localAppData, "Volta", "bin") : "",
      joinLocalPath(programFiles, "nodejs"),
    ]);
  }
  const home = env.HOME || "";
  const prefixes = uniquePaths([
    env.NPM_CONFIG_PREFIX,
    env.npm_config_prefix,
  ]).map((prefix) => joinLocalPath(prefix, "bin"));
  return uniquePaths([
    home ? joinLocalPath(home, ".local", "bin") : "",
    home ? joinLocalPath(home, ".claude", "local") : "",
    ...prefixes,
    ...(await listNvmBinDirs(env)),
    env.VOLTA_HOME ? joinLocalPath(env.VOLTA_HOME, "bin") : "",
    home ? joinLocalPath(home, ".volta", "bin") : "",
    home ? joinLocalPath(home, ".asdf", "shims") : "",
    home ? joinLocalPath(home, ".npm-global", "bin") : "",
    ...(platform === "macos" ? ["/opt/homebrew/bin"] : []),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]);
}

function binaryFileNames(
  kind: ClaudeBridgeBinaryKind,
  platform: RuntimePlatform,
): string[] {
  if (platform !== "windows") return [kind];
  return kind === "node" ? ["node.exe"] : ["claude.exe", "claude.cmd"];
}

async function lookupOnPath(
  kind: ClaudeBridgeBinaryKind,
  Subprocess: GeckoSubprocess | null,
): Promise<string | undefined> {
  if (!Subprocess) return undefined;
  const info = getRuntimePlatformInfo();
  const output = await runGeckoSubprocessForOutput(
    Subprocess,
    {
      command: info.shellPath,
      arguments: [
        info.shellFlag,
        info.platform === "windows" ? `where ${kind}` : `command -v ${kind}`,
      ],
    },
    GECKO_LOOKUP_TIMEOUT_MS,
  );
  const lines = (output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (info.platform !== "windows") {
    // `command -v` prints a bare name for aliases and functions.
    return lines.find((line) => line.startsWith("/"));
  }
  // Prefer a real executable over npm's .cmd shim in the same folder.
  return (
    lines.find((line) => /\.exe$/i.test(line)) ||
    lines.find((line) => /\.cmd$/i.test(line))
  );
}

/**
 * npm installs `claude` on Windows as a .cmd shim, which cannot be started
 * without a shell. The SDK can run the package's cli.js with Node instead.
 */
async function resolveWindowsClaudeShim(path: string): Promise<string> {
  if (!/\.cmd$/i.test(path)) return path;
  const cliJs = joinLocalPath(
    getLocalParentPath(path),
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "cli.js",
  );
  return (await pathExists(cliJs)) ? cliJs : path;
}

export const CLAUDE_BRIDGE_OWN_BRIDGE_HINT =
  "If Claude Code runs in WSL or on another computer, turn on “Use my own bridge” in Settings > Claude Code and enter its address.";

function notFoundMessage(
  kind: ClaudeBridgeBinaryKind,
  explicitPath: string,
): string {
  return `${notFoundMessageBody(kind, explicitPath)} ${CLAUDE_BRIDGE_OWN_BRIDGE_HINT}`;
}

function notFoundMessageBody(
  kind: ClaudeBridgeBinaryKind,
  explicitPath: string,
): string {
  if (explicitPath) {
    return kind === "node"
      ? `Node.js was not found at ${explicitPath}. Fix the Node.js path in the Claude Code settings, or clear it to search automatically.`
      : `Claude Code was not found at ${explicitPath}. Fix the Claude Code path in the Claude Code settings, or clear it to search automatically.`;
  }
  return kind === "node"
    ? `Node.js was not found. Claude Code mode needs Node.js ${MIN_CLAUDE_BRIDGE_NODE_MAJOR} or newer: install it from https://nodejs.org, or set its path in the Claude Code settings.`
    : "Claude Code was not found. Install it (https://code.claude.com/docs/en/installation), run `claude` once in a terminal to log in, or set its path in the Claude Code settings.";
}

/**
 * Returns an absolute path to `kind`. An explicit path from the settings wins
 * and is never second-guessed by the search.
 */
export async function resolveClaudeBridgeBinary(
  kind: ClaudeBridgeBinaryKind,
  explicitPref: string | null | undefined,
  Subprocess: GeckoSubprocess | null,
): Promise<string> {
  const info = getRuntimePlatformInfo();
  const explicitPath = normalizeClaudeBridgeBinaryPref(explicitPref);
  if (explicitPath) {
    if (await pathExists(explicitPath)) {
      return kind === "claude" && info.platform === "windows"
        ? resolveWindowsClaudeShim(explicitPath)
        : explicitPath;
    }
    throw new ClaudeBridgeBinaryNotFoundError(
      kind,
      notFoundMessage(kind, explicitPath),
    );
  }
  const fromPath = await lookupOnPath(kind, Subprocess);
  if (fromPath && (await pathExists(fromPath))) {
    return kind === "claude" && info.platform === "windows"
      ? resolveWindowsClaudeShim(fromPath)
      : fromPath;
  }
  for (const dir of await listClaudeBridgeToolDirs(info.platform)) {
    for (const name of binaryFileNames(kind, info.platform)) {
      const candidate = joinLocalPath(dir, name);
      if (await pathExists(candidate)) {
        return kind === "claude" && info.platform === "windows"
          ? resolveWindowsClaudeShim(candidate)
          : candidate;
      }
    }
  }
  throw new ClaudeBridgeBinaryNotFoundError(kind, notFoundMessage(kind, ""));
}

/** Parses `node --version` output such as "v22.3.0". */
export function parseNodeMajorVersion(output: string | null): number | null {
  const match = (output || "").trim().match(/^v?(\d+)\.\d+/);
  return match ? Number(match[1]) : null;
}

export async function assertSupportedNodeVersion(
  nodePath: string,
  Subprocess: GeckoSubprocess,
): Promise<string> {
  const output = await runGeckoSubprocessForOutput(
    Subprocess,
    { command: nodePath, arguments: ["--version"] },
    GECKO_LOOKUP_TIMEOUT_MS,
  );
  const major = parseNodeMajorVersion(output);
  if (major === null) {
    throw new ClaudeBridgeBinaryNotFoundError(
      "node",
      `Could not run Node.js at ${nodePath}. Check that it works by running \`node --version\` in a terminal.`,
    );
  }
  if (major < MIN_CLAUDE_BRIDGE_NODE_MAJOR) {
    throw new ClaudeBridgeBinaryNotFoundError(
      "node",
      `Claude Code mode needs Node.js ${MIN_CLAUDE_BRIDGE_NODE_MAJOR} or newer, but ${nodePath} is ${String(output).trim()}. Install a newer Node.js from https://nodejs.org.`,
    );
  }
  return String(output).trim();
}
