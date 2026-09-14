/**
 * Tool that gives the agent the ability to run shell commands.
 * This turns the Zotero agent into a coding-capable agent that can
 * run analysis scripts, process data, invoke external tools, etc.
 *
 * Uses Mozilla's Subprocess module (Gecko runtime).
 */
import type {
  AgentToolContext,
  AgentToolEffect,
  AgentWriteToolDefinition,
} from "../../types";
import {
  ambiguousInvocationPlan,
  prohibitedInvocationPlan,
  readOnlyInvocationPlan,
  stateChangeInvocationPlan,
} from "../../authorization/invocationPlan";
import type { ActionRiskSignal } from "../../authorization/types";
import { getRuntimePlatformInfo } from "../../../utils/runtimePlatform";
import {
  isLocalPathInsideOrEqual,
  parseNotesDirectoryWritePolicy,
} from "../../../utils/notesDirectoryConfig";
import { ok, fail, validateObject } from "../shared";
import { executeExternalMutation } from "../../services/externalMutationCoordinator";
import { sha256Bytes } from "../../store/journalRecoveryBlobStore";
import { fingerprintText } from "../../contracts/actionOperationEvidence";

type RunCommandInput = {
  command: string;
  cwd?: string;
  timeoutMs: number;
};

type ReversibleCommandWrite = {
  kind: "file" | "directory";
  path: string;
  sourcePath?: string;
  description: string;
};

/**
 * Resolve the absolute path of the shell executable.
 * Mozilla Subprocess requires an absolute path.
 */
function resolveShellPath(): { shell: string; shellFlag: string } {
  const info = getRuntimePlatformInfo();
  return { shell: info.shellPath, shellFlag: info.shellFlag };
}

/**
 * Read all available data from a Subprocess pipe (stdout/stderr).
 */
async function drainPipe(pipe: any): Promise<string> {
  if (!pipe?.readString) return "";
  let result = "";
  try {
    while (true) {
      const chunk = await pipe.readString();
      if (!chunk) break;
      result += chunk;
    }
  } catch {
    /* pipe closed */
  }
  return result;
}

/**
 * Run a shell command using Mozilla's Subprocess module.
 */
async function executeCommand(params: {
  command: string;
  cwd?: string;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { command, timeoutMs } = params;
  const { shell, shellFlag } = resolveShellPath();

  // Try Mozilla Subprocess.call (Zotero 7/8)
  try {
    let Subprocess: any;
    const CU = (globalThis as any).ChromeUtils;
    if (CU?.importESModule) {
      try {
        const mod = CU.importESModule(
          "resource://gre/modules/Subprocess.sys.mjs",
        );
        Subprocess = mod.Subprocess || mod.default || mod;
      } catch {
        /* fallback below */
      }
    }
    if (!Subprocess && CU?.import) {
      try {
        const mod = CU.import("resource://gre/modules/Subprocess.jsm");
        Subprocess = mod.Subprocess || mod;
      } catch {
        /* fallback below */
      }
    }

    if (Subprocess?.call) {
      const info = getRuntimePlatformInfo();

      if (info.platform === "windows") {
        // Windows: Subprocess pipes don't capture cmd.exe output in Zotero's
        // Gecko build. Redirect to a fixed temp file, then read it back.
        const Components = (globalThis as any).Components;
        const tempDir =
          (globalThis as any).Services?.dirsvc?.get(
            "TmpD",
            Components?.interfaces?.nsIFile,
          )?.path || "C:\\Windows\\Temp";
        const tempOut = `${tempDir}\\zotero-llm-cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
        const wrappedCommand = `( ${command} ) > "${tempOut}" 2>&1`;

        const proc = await Subprocess.call({
          command: shell,
          arguments: [shellFlag, wrappedCommand],
          workdir: params.cwd || undefined,
        });

        // Drain pipes (they'll be empty on Windows, but drain to avoid hangs)
        const drainPromise = Promise.all([
          drainPipe(proc.stdout),
          drainPipe(proc.stderr),
        ]);

        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<"timeout">((resolve) => {
          timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
        });

        const resultPromise = (async () => {
          await drainPromise;
          const { exitCode } = await proc.wait();
          return exitCode;
        })();

        let race: number | "timeout";
        try {
          race = await Promise.race([resultPromise, timeoutPromise]);
        } finally {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        }
        if (race === "timeout") {
          try {
            proc.kill();
          } catch {
            /* ignore */
          }
          try {
            const IO = (globalThis as any).IOUtils;
            await IO.remove(tempOut, { ignoreAbsent: true });
          } catch {
            /* ignore */
          }
          return { stdout: "", stderr: "[Command timed out]", exitCode: -1 };
        }

        // Read captured output from temp file
        let stdout = "";
        try {
          const IOUtils = (globalThis as any).IOUtils;
          const data = await IOUtils.read(tempOut);
          stdout = new TextDecoder("utf-8").decode(
            data instanceof Uint8Array ? data : new Uint8Array(data),
          );
          await IOUtils.remove(tempOut, { ignoreAbsent: true });
        } catch {
          /* temp file missing or unreadable */
        }

        return { stdout, stderr: "", exitCode: race };
      } else {
        // macOS / Linux: pipes work normally
        const proc = await Subprocess.call({
          command: shell,
          arguments: [shellFlag, command],
          workdir: params.cwd || undefined,
        });

        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<"timeout">((resolve) => {
          timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
        });

        const resultPromise = (async () => {
          const [stdout, stderr] = await Promise.all([
            drainPipe(proc.stdout),
            drainPipe(proc.stderr),
          ]);
          const { exitCode } = await proc.wait();
          return { stdout, stderr, exitCode };
        })();

        let raceResult:
          | { stdout: string; stderr: string; exitCode: number }
          | "timeout";
        try {
          raceResult = await Promise.race([resultPromise, timeoutPromise]);
        } finally {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        }
        if (raceResult === "timeout") {
          try {
            proc.kill();
          } catch {
            /* ignore */
          }
          const partial = await resultPromise.catch(() => ({
            stdout: "",
            stderr: "",
            exitCode: -1,
          }));
          return {
            stdout: partial.stdout,
            stderr: partial.stderr + "\n[Command timed out]",
            exitCode: -1,
          };
        }
        return raceResult;
      }
    }
  } catch (error) {
    Zotero.debug?.(
      `[llm-for-zotero] Subprocess.call failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Fallback: nsIProcess (no stdout capture)
  try {
    const Components = (globalThis as any).Components;
    if (!Components?.classes) {
      return {
        stdout: "",
        stderr: "Shell execution is not available in this Zotero environment.",
        exitCode: -1,
      };
    }
    const nsILocalFile = Components.classes[
      "@mozilla.org/file/local;1"
    ].createInstance(Components.interfaces.nsIFile);
    nsILocalFile.initWithPath(shell);

    const process = Components.classes[
      "@mozilla.org/process/util;1"
    ].createInstance(Components.interfaces.nsIProcess);
    process.init(nsILocalFile);
    process.run(true, [shellFlag, command], 2);
    return {
      stdout:
        "(nsIProcess does not capture stdout — check output files instead)",
      stderr: "",
      exitCode: process.exitValue,
    };
  } catch (error) {
    return {
      stdout: "",
      stderr: `Failed to execute command: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: -1,
    };
  }
}

/** Downloading code and handing it directly to a shell should never auto-run. */
const NETWORK_TO_SHELL_PATTERN =
  /(?:(?:curl|wget)\b[\s\S]*\|\s*(?:sh|bash|zsh)\b|(?:sh|bash|zsh)\b[\s\S]*<\s*\(\s*(?:curl|wget)\b|(?:sh|bash|zsh)\b[\s\S]*(?:\$\(\s*(?:curl|wget)\b|`\s*(?:curl|wget)\b))/i;

/** macOS/system automation commands can mutate external app or OS state. */
const SYSTEM_AUTOMATION_PATTERN =
  /(?:^|\||;|&&)\s*(?:(?:osascript|launchctl)\b|defaults\s+(?:write|delete|import|rename)\b)/i;

const PACKAGE_SYSTEM_MODIFICATION_PATTERN =
  /(?:^|\||;|&&)\s*(?:(?:npm|pnpm|yarn)\s+(?:install|add|remove|uninstall|update|upgrade)\b|(?:pip|pip3)\s+install\b|python3?\s+-m\s+pip\s+install\b|uv\s+pip\s+install\b|brew\s+(?:install|upgrade|update|uninstall)\b|(?:apt|apt-get|dnf|yum|pacman|conda|mamba)\s+(?:install|remove|update|upgrade)\b|cargo\s+install\b|gem\s+install\b|date\s+(?:-s|--set)\b|timedatectl\b|systemsetup\s+-set(?:date|time|timezone)\b)/i;

const RECOGNIZED_STATE_CHANGE_COMMANDS =
  /(?:^|\||;|&&)\s*(?:(?:touch|mkdir|cp|mv|rm|rmdir|chmod|chown|tee)\b|(?:copy|move|del|erase|ren|rename|md|mkdir|rd|rmdir)\b|git\s+(?:add|commit|push|reset|checkout|switch|clean|rebase|merge|cherry-pick|revert|rm|branch|tag)\b|git\s+diff\b[^\n;&|]*--output(?:=|\s)|(?:npm|pnpm|yarn)\s+(?:install|add|remove|uninstall|update|upgrade)\b|(?:pip|pip3)\s+install\b|python3?\s+-m\s+pip\s+install\b|uv\s+pip\s+install\b|brew\s+(?:install|upgrade|update|uninstall)\b|(?:apt|apt-get|dnf|yum|pacman|conda|mamba)\s+(?:install|remove|update|upgrade)\b|cargo\s+install\b|gem\s+install\b|date\s+(?:-s|--set)\b|timedatectl\b|systemsetup\s+-set(?:date|time|timezone)\b)/i;

/** Append redirects are always an overwrite/append risk. */
const APPEND_REDIRECT_PATTERN =
  /(?:^|[^<])(?:\d*>>|&>>)\s*(?:"[^"]+"|'[^']+'|[^\s;&|]+)/;

const OVERWRITE_REDIRECT_TARGET_PATTERN =
  /(?:^|[^<>=])(?:\d?>|&>)(?!=)\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/;

const ANY_REDIRECT_TARGET_PATTERN =
  /(?:^|[^<>=])(?:\d*>>|&>>|\d?>|&>)(?!=)\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;

const TEE_TARGET_PATTERN =
  /(?:^|[|;&])\s*tee(?:\s+-[A-Za-z]+)*\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;

async function pathExists(path: string): Promise<boolean | null> {
  const IOUtils = (globalThis as any).IOUtils;
  if (IOUtils?.exists) {
    try {
      return Boolean(await IOUtils.exists(path));
    } catch {
      return null;
    }
  }
  const OSFile = (globalThis as any).OS?.File;
  if (OSFile?.exists) {
    try {
      return Boolean(await OSFile.exists(path));
    } catch {
      return null;
    }
  }
  return null;
}

async function pathKind(path: string): Promise<"file" | "directory" | null> {
  const IOUtils = (globalThis as any).IOUtils;
  if (IOUtils?.stat) {
    try {
      const stat = await IOUtils.stat(path);
      if (stat?.type === "directory") return "directory";
      if (stat?.type === "regular" || stat?.type === "file") return "file";
    } catch {
      return null;
    }
  }
  const OSFile = (globalThis as any).OS?.File;
  if (OSFile?.stat) {
    try {
      const stat = await OSFile.stat(path);
      if (stat?.isDir === true) return "directory";
      if (stat) return "file";
    } catch {
      return null;
    }
  }
  return null;
}

function childPath(directory: string, sourcePath: string): string {
  const sourceName = sourcePath
    .replace(/[\\/]+$/g, "")
    .split(/[\\/]/)
    .pop();
  if (!sourceName) return directory;
  const separator =
    directory.includes("\\") && !directory.includes("/") ? "\\" : "/";
  return `${directory.replace(/[\\/]+$/g, "")}${separator}${sourceName}`;
}

async function resolveReversibleOutputPath(
  write: ReversibleCommandWrite,
  cwd: string | undefined,
): Promise<string> {
  const destination = resolveCommandPath(write.path, cwd);
  if (write.sourcePath && (await pathKind(destination)) === "directory") {
    return childPath(destination, write.sourcePath);
  }
  return destination;
}

async function removePathIfExists(path: string): Promise<void> {
  const IOUtils = (globalThis as any).IOUtils;
  if (IOUtils?.remove) {
    await IOUtils.remove(path, { ignoreAbsent: true });
    return;
  }
  const OSFile = (globalThis as any).OS?.File;
  if (OSFile?.remove) {
    await OSFile.remove(path, { ignoreAbsent: true });
    return;
  }
  throw new Error("Path removal is not available in this Zotero environment");
}

function parseSimpleShellWords(value: string): string[] | null {
  const words: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    if (!token) continue;
    if (/[;&|<>]/.test(token)) return null;
    words.push(token.replace(/\\"/g, '"'));
  }
  return words;
}

function hasGlobPattern(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function isAbsolutePath(value: string): boolean {
  return (
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("\\\\")
  );
}

function resolveCommandPath(path: string, cwd: string | undefined): string {
  const normalize = (value: string): string => {
    const slash = value.replace(/\\/g, "/");
    const drive = slash.match(/^([A-Za-z]:)(?:\/|$)/)?.[1];
    const unc = slash.startsWith("//");
    const absolute = slash.startsWith("/") || Boolean(drive);
    const prefix = drive ? `${drive}/` : unc ? "//" : absolute ? "/" : "";
    const body = drive
      ? slash.slice(drive.length + 1)
      : slash.replace(/^\/+/, "");
    const segments: string[] = [];
    for (const segment of body.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        if (segments.length && segments.at(-1) !== "..") segments.pop();
        else if (!absolute) segments.push(segment);
        continue;
      }
      segments.push(segment);
    }
    return `${prefix}${segments.join("/")}` || (absolute ? prefix : ".");
  };
  if (path.startsWith("~")) return path;
  if (isAbsolutePath(path)) return normalize(path);
  return normalize(cwd ? `${cwd.replace(/[\\/]+$/g, "")}/${path}` : path);
}

function splitPipeline(command: string): string[] | null {
  if (/\$\(|`|\$\{|\$[A-Za-z_][A-Za-z0-9_]*|%[^%\s]+%|![^!\s]+!/.test(command))
    return null;
  const stages: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      if (quote === character) quote = null;
      else if (!quote) quote = character;
      current += character;
      continue;
    }
    if (!quote && character === "|") {
      if (!current.trim()) return null;
      stages.push(current.trim());
      current = "";
      continue;
    }
    if (
      !quote &&
      (character === ";" || character === "&" || character === "\n")
    ) {
      return null;
    }
    current += character;
  }
  if (quote || escaped || !current.trim()) return null;
  stages.push(current.trim());
  return stages;
}

function optionAllowed(
  value: string,
  exact: ReadonlySet<string>,
  prefixes: readonly string[] = [],
): boolean {
  return (
    !value.startsWith("-") ||
    exact.has(value) ||
    prefixes.some((prefix) => value.startsWith(prefix))
  );
}

function isRecognizedReadOnlyStage(stage: string): boolean {
  if (/[<>]/.test(stage)) return false;
  const words = parseSimpleShellWords(stage);
  if (!words?.length) return false;
  if (/[\\/]/.test(words[0])) return false;
  const program = words[0].toLowerCase().replace(/\.exe$/, "");
  const args = words.slice(1);
  if (program === "pwd" || program === "echo" || program === "printf") {
    return args.every((arg) => !arg.startsWith("-") || program !== "pwd");
  }
  if (program === "wc") {
    const flags = new Set([
      "-l",
      "-w",
      "-c",
      "-m",
      "-L",
      "--lines",
      "--words",
      "--bytes",
      "--chars",
      "--max-line-length",
    ]);
    return args.every((arg) => optionAllowed(arg, flags));
  }
  if (program === "rg") {
    const flags = new Set([
      "-n",
      "--line-number",
      "-i",
      "--ignore-case",
      "-F",
      "--fixed-strings",
      "-w",
      "--word-regexp",
      "-l",
      "--files-with-matches",
      "-L",
      "--files-without-match",
      "-c",
      "--count",
      "--count-matches",
      "--json",
      "--heading",
      "--no-heading",
      "--hidden",
      "--files",
      "--stats",
      "--version",
      "--help",
      "--no-ignore",
      "--follow",
      "-A",
      "-B",
      "-C",
      "-m",
      "-g",
      "--glob",
      "--type",
      "--type-not",
      "--max-count",
      "--context",
    ]);
    return args.every((arg) =>
      optionAllowed(arg, flags, [
        "--glob=",
        "--type=",
        "--type-not=",
        "--max-count=",
        "--context=",
      ]),
    );
  }
  if (program === "git" && args[0] === "diff") {
    const flags = new Set([
      "--cached",
      "--staged",
      "--stat",
      "--shortstat",
      "--name-only",
      "--name-status",
      "--check",
      "--summary",
      "--no-color",
      "--color",
      "--word-diff",
      "-w",
      "--ignore-all-space",
      "--ignore-space-change",
      "--no-ext-diff",
    ]);
    return args
      .slice(1)
      .every((arg) =>
        optionAllowed(arg, flags, ["--color=", "--word-diff=", "--unified="]),
      );
  }
  const commonFlags: Record<string, ReadonlySet<string>> = {
    cat: new Set([
      "-A",
      "-b",
      "-e",
      "-E",
      "-n",
      "-s",
      "-t",
      "-T",
      "-u",
      "-v",
      "--show-all",
      "--number-nonblank",
      "--show-ends",
      "--number",
      "--squeeze-blank",
      "--show-tabs",
      "--show-nonprinting",
    ]),
    head: new Set(["-q", "-v", "-n", "-c", "--quiet", "--verbose"]),
    tail: new Set(["-q", "-v", "-n", "-c", "--quiet", "--verbose"]),
    ls: new Set([
      "-a",
      "-A",
      "-d",
      "-F",
      "-h",
      "-i",
      "-k",
      "-l",
      "-n",
      "-o",
      "-p",
      "-r",
      "-R",
      "-s",
      "-S",
      "-t",
      "-U",
      "-1",
      "--all",
      "--almost-all",
      "--directory",
      "--human-readable",
      "--inode",
      "--recursive",
      "--reverse",
      "--size",
    ]),
    stat: new Set(["-f", "-L", "-t", "--dereference", "--terse"]),
    file: new Set(["-b", "-i", "-L", "--brief", "--mime", "--dereference"]),
    du: new Set([
      "-a",
      "-h",
      "-k",
      "-s",
      "--all",
      "--human-readable",
      "--summarize",
    ]),
    df: new Set(["-h", "-k", "-P", "-T", "--human-readable"]),
  };
  if (program in commonFlags) {
    const prefixes =
      program === "head" || program === "tail"
        ? ["--lines=", "--bytes="]
        : program === "ls"
          ? ["--color=", "--sort=", "--time=", "--format="]
          : program === "stat"
            ? ["--format=", "--printf="]
            : [];
    return args.every((arg) =>
      optionAllowed(arg, commonFlags[program], prefixes),
    );
  }
  if (program === "find") {
    const flags = new Set([
      "-H",
      "-L",
      "-P",
      "-and",
      "-or",
      "-not",
      "-name",
      "-iname",
      "-path",
      "-ipath",
      "-type",
      "-maxdepth",
      "-mindepth",
      "-size",
      "-mtime",
      "-mmin",
      "-newer",
      "-empty",
      "-readable",
      "-writable",
      "-executable",
      "-print",
      "-print0",
      "-printf",
      "-ls",
      "-true",
      "-false",
    ]);
    return args.every(
      (arg) =>
        !arg.startsWith("-") || flags.has(arg) || arg === "!" || arg === "(",
    );
  }
  const platform = getRuntimePlatformInfo().platform;
  return (
    platform === "windows" &&
    ["dir", "type", "findstr", "where"].includes(program)
  );
}

function resolvedCommandTargets(
  input: Pick<RunCommandInput, "command" | "cwd">,
): string[] {
  const targets = parseCommandWriteTargets(input.command).map((path) =>
    resolveCommandPath(path, input.cwd),
  );
  return [...new Set([...(input.cwd ? [input.cwd] : []), ...targets])];
}

function targetsProtectedBoundary(targets: string[], command: string): boolean {
  if (
    /\b(?:rm|rmdir)\s+(?:-[^\s]+\s+)*(?:\/|~|\$HOME|%USERPROFILE%)(?=[\s"']|$)/i.test(
      command,
    )
  ) {
    return true;
  }
  return targets.some((target) => {
    const normalized = target.replace(/\\/g, "/").replace(/\/+$/g, "");
    return (
      normalized === "" ||
      normalized === "/" ||
      normalized === "~" ||
      /^[A-Za-z]:$/.test(normalized) ||
      ["/System", "/usr", "/bin", "/sbin", "/etc"].some(
        (root) => normalized === root || normalized.startsWith(`${root}/`),
      )
    );
  });
}

function commandRiskSignals(command: string): ActionRiskSignal[] {
  const signals: ActionRiskSignal[] = [];
  if (/\b(?:sudo|doas|runas)\b/i.test(command)) {
    signals.push("privilege_escalation");
  }
  if (
    PACKAGE_SYSTEM_MODIFICATION_PATTERN.test(command) ||
    SYSTEM_AUTOMATION_PATTERN.test(command)
  ) {
    signals.push("package_system_modification");
  }
  if (isNetworkToShellCommand(command)) signals.push("download_to_shell");
  if (
    /\b(?:rm|rmdir)\b[^\n]*(?:-r|-rf|-fr)\b|(?:^|[;&|])\s*(?:rd|rmdir)\s+\/s\b/i.test(
      command,
    )
  ) {
    signals.push("broad_delete");
  }
  if (
    /originalAgentPermissionMode|agentLibraryWriteMode|authorization|grantStore/i.test(
      command,
    )
  ) {
    signals.push("authorization_tampering");
  }
  return signals;
}

export async function classifyRunCommandInvocation(
  input: Pick<RunCommandInput, "command" | "cwd">,
) {
  const command = input.command.trim();
  const targets = resolvedCommandTargets(input);
  const riskSignals = commandRiskSignals(command);
  const stateChange =
    RECOGNIZED_STATE_CHANGE_COMMANDS.test(command) ||
    SYSTEM_AUTOMATION_PATTERN.test(command) ||
    APPEND_REDIRECT_PATTERN.test(command) ||
    Boolean(parseRedirectTarget(command));
  if (
    riskSignals.includes("authorization_tampering") ||
    (stateChange && targetsProtectedBoundary(targets, command))
  ) {
    return prohibitedInvocationPlan({
      mechanism: "shell",
      domains: ["local_execution", "filesystem"],
      effects: ["modify"],
      targets,
      riskSignals: [
        ...riskSignals,
        ...(targetsProtectedBoundary(targets, command)
          ? (["protected_target"] as const)
          : []),
      ],
      reason: "The command crosses an enforced local integrity boundary.",
    });
  }
  if (stateChange) {
    const reversibleWrite = parseReversibleCommandWrite(command);
    const outputPath = reversibleWrite
      ? await resolveReversibleOutputPath(reversibleWrite, input.cwd)
      : undefined;
    const exists = outputPath ? await pathExists(outputPath) : null;
    const effects = /\b(?:rm|rmdir)\b/i.test(command)
      ? (["delete"] as const)
      : exists === false
        ? (["create"] as const)
        : (["modify"] as const);
    return stateChangeInvocationPlan({
      mechanism: "shell",
      assurance: "statically_recognized",
      domains: ["local_execution", "filesystem", "network"],
      effects: [...effects],
      targets,
      riskSignals,
      reversibility: reversibleWrite && exists === false ? "partial" : "none",
      reason:
        reversibleWrite && exists === false
          ? "The recognized new output can be removed, but other shell effects are not proven reversible."
          : "The command contains a recognized state-changing form whose complete inverse cannot be proven.",
    });
  }
  const stages = splitPipeline(command);
  if (stages?.every(isRecognizedReadOnlyStage)) {
    return readOnlyInvocationPlan({
      mechanism: "shell",
      assurance: "statically_recognized",
      domains: ["local_execution", "filesystem"],
      targets,
      reason:
        "Every pipeline stage matches the audited read-only command grammar.",
    });
  }
  return ambiguousInvocationPlan({
    mechanism: "shell",
    domains: ["local_execution", "filesystem", "network"],
    effects: ["read", "create", "modify", "delete", "egress"],
    targets,
    riskSignals,
    reason:
      "The shell form contains an interpreter, expansion, executable, or flag outside the audited read-only grammar.",
  });
}

function isNullRedirectTarget(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return normalized === "/dev/null" || normalized === "nul";
}

function isMarkdownNotePath(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(path.trim());
}

function normalizeParsedCommandTarget(
  value: string,
  options?: { unquoted?: boolean },
): string {
  const path = value.trim();
  return options?.unquoted ? path.replace(/\)+$/g, "") : path;
}

function isRelativeCommandPath(path: string): boolean {
  const trimmed = path.trim();
  return (
    Boolean(trimmed) && !isAbsolutePath(trimmed) && !trimmed.startsWith("~")
  );
}

function commandStartsWithDirectoryChange(command: string): boolean {
  return /^(?:\(\s*)?cd(?:\s+|$)[\s\S]*(?:&&|;)/.test(command.trim());
}

function parseRedirectTarget(command: string): ReversibleCommandWrite | null {
  const match = command.match(OVERWRITE_REDIRECT_TARGET_PATTERN);
  if (!match) return null;
  const path = (match[1] || match[2] || match[3] || "").trim();
  if (!path || isNullRedirectTarget(path) || hasGlobPattern(path)) return null;
  return {
    kind: "file",
    path,
    description: `Delete created file from shell redirect: ${path}`,
  };
}

function parseCommandWriteTargets(command: string): string[] {
  const targets: string[] = [];
  let match: RegExpExecArray | null;
  const redirectPattern = new RegExp(
    ANY_REDIRECT_TARGET_PATTERN.source,
    ANY_REDIRECT_TARGET_PATTERN.flags,
  );
  while ((match = redirectPattern.exec(command)) !== null) {
    const path = normalizeParsedCommandTarget(
      match[1] || match[2] || match[3] || "",
      {
        unquoted: Boolean(match[3]),
      },
    );
    if (path && !isNullRedirectTarget(path)) targets.push(path);
  }

  const teePattern = new RegExp(
    TEE_TARGET_PATTERN.source,
    TEE_TARGET_PATTERN.flags,
  );
  while ((match = teePattern.exec(command)) !== null) {
    const path = normalizeParsedCommandTarget(
      match[1] || match[2] || match[3] || "",
      {
        unquoted: Boolean(match[3]),
      },
    );
    if (path && !isNullRedirectTarget(path)) targets.push(path);
  }

  const words = parseSimpleShellWords(command.trim());
  if (words?.length) {
    const [rawProgram, ...args] = words;
    const program = rawProgram.toLowerCase().replace(/\.exe$/, "");
    if (
      (program === "cp" || program === "mv") &&
      args.length >= 2 &&
      !args.some((arg) => hasGlobPattern(arg))
    ) {
      const positional = args.filter((arg) => !arg.startsWith("-"));
      const target = positional[positional.length - 1];
      if (target) targets.push(target);
    }
    if (
      ["rm", "rmdir", "touch", "mkdir", "md", "rd", "del"].includes(program)
    ) {
      targets.push(...args.filter((arg) => !arg.startsWith("-")));
    }
    if (["chmod", "chown"].includes(program)) {
      targets.push(...args.slice(1).filter((arg) => !arg.startsWith("-")));
    }
  }

  return Array.from(new Set(targets));
}

function getNoteWriteBypassRefusal(
  input: Pick<RunCommandInput, "command" | "cwd">,
  context: AgentToolContext | undefined,
): string | null {
  const policy = parseNotesDirectoryWritePolicy(
    context?.request.metadata?.fileNoteWritePolicy,
  );
  if (!policy) return null;
  const targets = parseCommandWriteTargets(input.command).filter((path) =>
    isMarkdownNotePath(path),
  );
  const relativeMarkdownTargetAfterCd = targets.find(
    (path) =>
      isRelativeCommandPath(path) &&
      commandStartsWithDirectoryChange(input.command),
  );
  if (relativeMarkdownTargetAfterCd) {
    return (
      `Refusing run_command relative Markdown note write after shell directory change: ${relativeMarkdownTargetAfterCd}. ` +
      "Use file_io for external Markdown note files or edit_current_note for Zotero notes so MinerU figure-block completeness can be validated before writing."
    );
  }
  const resolvedTargets = targets.map((path) =>
    resolveCommandPath(path, input.cwd),
  );
  const noteTarget = resolvedTargets.find(
    (path) =>
      isLocalPathInsideOrEqual(path, policy.defaultTargetPath) ||
      isLocalPathInsideOrEqual(path, policy.directoryPath),
  );
  if (!noteTarget) return null;
  return (
    `Refusing run_command Markdown note write to configured notes directory: ${noteTarget}. ` +
    "Use file_io for external Markdown note files or edit_current_note for Zotero notes so MinerU figure-block completeness can be validated before writing."
  );
}

function parseReversibleCommandWrite(
  command: string,
): ReversibleCommandWrite | null {
  const trimmed = command.trim();
  const redirect = parseRedirectTarget(trimmed);
  if (redirect) return redirect;

  const words = parseSimpleShellWords(trimmed);
  if (!words?.length) return null;
  const [program, ...args] = words;
  if (program === "mkdir") {
    const paths = args.filter((arg) => arg !== "-p");
    if (paths.length !== 1 || hasGlobPattern(paths[0])) return null;
    return {
      kind: "directory",
      path: paths[0],
      description: `Remove created directory: ${paths[0]}`,
    };
  }
  if (program === "touch" && args.length === 1 && !hasGlobPattern(args[0])) {
    return {
      kind: "file",
      path: args[0],
      description: `Delete created file: ${args[0]}`,
    };
  }
  if (
    program === "cp" &&
    args.length === 2 &&
    !args.some((arg) => arg.startsWith("-") || hasGlobPattern(arg))
  ) {
    return {
      kind: "file",
      path: args[1],
      sourcePath: args[0],
      description: `Delete copied file: ${args[1]}`,
    };
  }
  return null;
}

function isNetworkToShellCommand(command: string): boolean {
  return NETWORK_TO_SHELL_PATTERN.test(command.trim());
}

export function createRunCommandTool(): AgentWriteToolDefinition<
  RunCommandInput,
  unknown
> {
  return {
    describeAction: (input) => [
      {
        id: `command_execute:${fingerprintText(input.command)}`,
        proofDomain: "execution",
        capability: "command.execute",
        operation: "command_execute",
        source: "command",
        parameters: {
          commandFingerprint: fingerprintText(input.command),
        },
        requestedTargets: [],
        destinationCollectionIds: [],
      },
    ],
    spec: {
      name: "run_command",
      description:
        "Run a shell command on the local machine. The command string is passed directly to the native shell (cmd.exe on Windows, zsh on macOS, bash on Linux). " +
        "Use this for explicit shell tasks, data analysis scripts, conversion, or CLI tools. Not for ordinary Zotero paper/library reading when semantic Zotero tools can answer. Returns stdout, stderr, and exit code.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["command"],
        properties: {
          command: {
            type: "string",
            description:
              "The full shell command to run, exactly as you would type it in a terminal. " +
              "Examples: 'dir %USERPROFILE%\\\\Desktop\\\\*.pdf' (Windows), 'ls ~/Desktop/*.pdf' (macOS), 'find ~/Desktop -name \"*.pdf\"' (Linux), " +
              "'python3 /tmp/analyze.py', 'wc -l < file.txt'. Pipes, redirects, and shell features all work.",
          },
          cwd: {
            type: "string",
            description: "Working directory for the command.",
          },
          timeoutMs: {
            type: "number",
            description:
              "Timeout in milliseconds (default: 60000, max: 300000).",
          },
        },
      },
      executionClass: "external_effect",
      requiresConfirmation: true,
    },

    guidance: {
      matches: (request) =>
        Boolean(
          request.classifiedIntent?.actionIntents.some(
            (action) => action.capability === "command.execute",
          ),
        ),
      instruction:
        "Use run_command to execute shell commands for data analysis, running scripts, or invoking external tools. " +
        "Do not use run_command for ordinary Zotero paper/library reading when semantic Zotero tools can answer. " +
        "Use native shell syntax for the current OS: for example `dir %USERPROFILE%\\\\Desktop` on Windows or `ls ~/Desktop` on macOS/Linux. " +
        "Pass the complete command as a single string — pipes, redirects, globbing, and all shell features work. " +
        "Do NOT split the command into separate command/args fields.",
    },

    presentation: {
      label: "Run Command",
      summaries: {
        onCall: ({ args }) => {
          const a =
            args && typeof args === "object"
              ? (args as Record<string, unknown>)
              : {};
          const cmd = typeof a.command === "string" ? a.command : "command";
          return `Running: ${cmd}`;
        },
        onPending: "Waiting for confirmation to run command",
        onApproved: "Running command",
        onDenied: "Command cancelled",
        onSuccess: ({ content }) => {
          const r =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          const exitCode = Number(r.exitCode ?? -1);
          return exitCode === 0
            ? "Command completed successfully"
            : `Command exited with code ${exitCode}`;
        },
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object with a 'command' string");
      }
      if (typeof args.command !== "string" || !args.command.trim()) {
        return fail("command is required: the full shell command to run");
      }
      const timeoutRaw =
        typeof args.timeoutMs === "number" && args.timeoutMs > 0
          ? args.timeoutMs
          : 60000;
      const timeoutMs = Math.min(timeoutRaw, 300000);

      return ok<RunCommandInput>({
        command: args.command.trim(),
        cwd:
          typeof args.cwd === "string" && args.cwd.trim()
            ? args.cwd.trim()
            : undefined,
        timeoutMs,
      });
    },

    async planInvocation(input, context) {
      if (getNoteWriteBypassRefusal(input, context)) {
        return prohibitedInvocationPlan({
          mechanism: "shell",
          domains: ["filesystem", "local_execution"],
          effects: ["modify"],
          targets: resolvedCommandTargets(input),
          riskSignals: [],
          reason:
            "The command attempts to bypass the validated note-writing path.",
        });
      }
      return classifyRunCommandInvocation(input);
    },

    createPendingAction(input) {
      return {
        toolName: "run_command",
        title: "Run shell command",
        description: "Execute a command on your local machine.",
        confirmLabel: "Run",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "code_preview" as const,
            id: "command",
            label: "Command",
            value: input.command,
            language: "sh",
          },
          ...(input.cwd
            ? [
                {
                  type: "text" as const,
                  id: "cwd",
                  label: "Working directory",
                  value: input.cwd,
                },
              ]
            : []),
        ],
      };
    },

    async execute(input, context) {
      const reversibleWrite = parseReversibleCommandWrite(input.command);
      const noteWriteRefusal = getNoteWriteBypassRefusal(input, context);
      if (noteWriteRefusal) {
        return {
          content: {
            exitCode: -1,
            stdout: "",
            stderr: noteWriteRefusal,
            command: input.command,
          },
          effect: "none",
        };
      }
      let outputPath: string | undefined;
      const run = () =>
        executeCommand({
          command: input.command,
          cwd: input.cwd,
          timeoutMs: input.timeoutMs,
        });
      const formatResult = (
        commandResult: Awaited<ReturnType<typeof executeCommand>>,
        effect: AgentToolEffect,
      ) => {
        const maxLen = 8000;
        const stdout =
          commandResult.stdout.length > maxLen
            ? commandResult.stdout.slice(0, maxLen) +
              `\n... [truncated, ${commandResult.stdout.length} chars total]`
            : commandResult.stdout;
        const stderr =
          commandResult.stderr.length > maxLen
            ? commandResult.stderr.slice(0, maxLen) +
              `\n... [truncated, ${commandResult.stderr.length} chars total]`
            : commandResult.stderr;
        return {
          content: {
            exitCode: commandResult.exitCode,
            stdout,
            stderr,
            command: input.command,
          },
          effect,
        };
      };
      if (context.invocationPlan?.impact === "read_only") {
        return formatResult(await run(), "none");
      }
      let existedBeforeWrite: boolean | null = null;
      const result = await executeExternalMutation({
        context,
        toolName: "run_command",
        plan: async () => {
          outputPath = reversibleWrite
            ? await resolveReversibleOutputPath(reversibleWrite, input.cwd)
            : undefined;
          existedBeforeWrite = outputPath ? await pathExists(outputPath) : null;
          return {
            operation: "run_command",
            description: reversibleWrite
              ? reversibleWrite.description
              : "Run an arbitrary shell command",
            forward: {
              command: input.command,
              cwd: input.cwd,
              declaredOutputPath: outputPath,
            },
            inverse:
              outputPath && existedBeforeWrite === false
                ? {
                    version: 1,
                    kind: "file",
                    operation: "delete",
                    path: outputPath,
                  }
                : undefined,
            precondition: outputPath
              ? {
                  kind: reversibleWrite?.kind === "directory" ? "path" : "file",
                  path: outputPath,
                  exists: existedBeforeWrite === true,
                  ...(reversibleWrite?.kind === "directory"
                    ? { pathKind: "directory" }
                    : { checksum: null }),
                }
              : undefined,
            reversibility:
              outputPath && existedBeforeWrite === false
                ? ("partial" as const)
                : ("none" as const),
            reason:
              outputPath && existedBeforeWrite === false
                ? "The declared new output can be removed, but arbitrary command side effects cannot be proven reversible."
                : "Arbitrary shell command effects have no complete declarative inverse.",
          };
        },
        execute: async () => {
          const commandResult = await run();
          let expectedPostcondition: unknown;
          if (outputPath) {
            const io = (globalThis as { IOUtils?: any }).IOUtils;
            const exists = Boolean(await io?.exists?.(outputPath));
            if (reversibleWrite?.kind === "directory") {
              expectedPostcondition = {
                kind: "path",
                path: outputPath,
                pathKind: "directory",
                exists,
              };
            } else {
              const bytes = exists
                ? new Uint8Array(await io.read(outputPath))
                : null;
              expectedPostcondition = {
                kind: "file",
                path: outputPath,
                exists,
                checksum: bytes ? await sha256Bytes(bytes) : null,
              };
            }
          }
          // A non-zero exit code does not mean that the shell made no changes:
          // redirects are opened before the command runs, and an earlier
          // command in a sequence may have succeeded. Treat every failed
          // execution as potentially mutating. The only no-effect case we can
          // prove here is a successful idempotent mkdir of an existing path.
          const changed =
            commandResult.exitCode !== 0 ||
            !(
              reversibleWrite?.kind === "directory" &&
              existedBeforeWrite === true
            );
          return {
            result: commandResult,
            expectedPostcondition,
            reversibility:
              outputPath && existedBeforeWrite === false
                ? ("partial" as const)
                : ("none" as const),
            affectedCount: changed ? 1 : 0,
            effect: changed ? "applied" : "none",
          };
        },
      });
      return formatResult(result.content, result.effect);
    },
  };
}
