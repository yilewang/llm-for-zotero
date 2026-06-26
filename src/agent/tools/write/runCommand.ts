/**
 * Tool that gives the agent the ability to run shell commands.
 * This turns the Zotero agent into a coding-capable agent that can
 * run analysis scripts, process data, invoke external tools, etc.
 *
 * Uses Mozilla's Subprocess module (Gecko runtime).
 */
import type { AgentToolContext, AgentToolDefinition } from "../../types";
import { getRuntimePlatformInfo } from "../../../utils/runtimePlatform";
import {
  isLocalPathInsideOrEqual,
  parseNotesDirectoryWritePolicy,
} from "../../../utils/notesDirectoryConfig";
import { ok, fail, validateObject } from "../shared";
import { pushUndoEntry } from "../../store/undoStore";

type RunCommandInput = {
  command: string;
  cwd?: string;
  timeoutMs: number;
  allowUnsafe?: boolean;
};

type ReversibleCommandWrite = {
  kind: "file" | "directory";
  path: string;
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

        const timeoutPromise = new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), timeoutMs),
        );

        const resultPromise = (async () => {
          await drainPromise;
          const { exitCode } = await proc.wait();
          return exitCode;
        })();

        const race = await Promise.race([resultPromise, timeoutPromise]);
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

        const timeoutPromise = new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), timeoutMs),
        );

        const resultPromise = (async () => {
          const [stdout, stderr] = await Promise.all([
            drainPipe(proc.stdout),
            drainPipe(proc.stderr),
          ]);
          const { exitCode } = await proc.wait();
          return { stdout, stderr, exitCode };
        })();

        const raceResult = await Promise.race([resultPromise, timeoutPromise]);
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

/** Patterns that indicate a command has destructive or privileged risk. */
const DESTRUCTIVE_COMMANDS =
  /(?:^|\||\;|&&)\s*(?:(?:rm|rmdir|mv|rename|chmod|chown|sudo|mkfs|dd)\b|(?:npm|pnpm|yarn)\s+(?:install|add|remove|uninstall|update|upgrade)\b|(?:pip|pip3)\s+install\b|python3?\s+-m\s+pip\s+install\b|uv\s+pip\s+install\b|brew\s+(?:install|upgrade|update|uninstall)\b|(?:apt|apt-get|dnf|yum|pacman|conda|mamba)\s+(?:install|remove|update|upgrade)\b|cargo\s+install\b|gem\s+install\b|git\s+(?:push|reset|checkout|switch|clean|rebase|filter-branch|rm|branch\s+-D|tag\s+-d)\b|date\s+(?:-s|--set)\b|timedatectl\b|systemsetup\s+-set(?:date|time|timezone)\b)/i;

/** Downloading code and handing it directly to a shell should never auto-run. */
const NETWORK_TO_SHELL_PATTERN =
  /(?:(?:curl|wget)\b[\s\S]*\|\s*(?:sh|bash|zsh)\b|(?:sh|bash|zsh)\b[\s\S]*<\s*\(\s*(?:curl|wget)\b|(?:sh|bash|zsh)\b[\s\S]*(?:\$\(\s*(?:curl|wget)\b|`\s*(?:curl|wget)\b))/i;

/** macOS/system automation commands can mutate external app or OS state. */
const SYSTEM_AUTOMATION_PATTERN =
  /(?:^|\||\;|&&)\s*(?:(?:osascript|launchctl)\b|defaults\s+(?:write|delete|import|rename)\b)/i;

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
  return /[*?\[\]{}]/.test(value);
}

function isAbsolutePath(value: string): boolean {
  return (
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("\\\\")
  );
}

function resolveCommandPath(path: string, cwd: string | undefined): string {
  if (!cwd || isAbsolutePath(path) || path.startsWith("~")) return path;
  return `${cwd.replace(/[\\/]+$/g, "")}/${path}`;
}

function isNullRedirectTarget(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return normalized === "/dev/null" || normalized === "nul";
}

function isMarkdownNotePath(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(path.trim());
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
    const path = (match[1] || match[2] || match[3] || "").trim();
    if (path && !isNullRedirectTarget(path)) targets.push(path);
  }

  const teePattern = new RegExp(
    TEE_TARGET_PATTERN.source,
    TEE_TARGET_PATTERN.flags,
  );
  while ((match = teePattern.exec(command)) !== null) {
    const path = (match[1] || match[2] || match[3] || "").trim();
    if (path && !isNullRedirectTarget(path)) targets.push(path);
  }

  const words = parseSimpleShellWords(command.trim());
  if (words?.length) {
    const [program, ...args] = words;
    if (
      (program === "cp" || program === "mv") &&
      args.length >= 2 &&
      !args.some((arg) => hasGlobPattern(arg))
    ) {
      const positional = args.filter((arg) => !arg.startsWith("-"));
      const target = positional[positional.length - 1];
      if (target) targets.push(target);
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
  const targets = parseCommandWriteTargets(input.command)
    .filter((path) => isMarkdownNotePath(path))
    .map((path) => resolveCommandPath(path, input.cwd));
  const noteTarget = targets.find(
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
      description: `Delete copied file: ${args[1]}`,
    };
  }
  return null;
}

function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_COMMANDS.test(command.trim());
}

function isNetworkToShellCommand(command: string): boolean {
  return NETWORK_TO_SHELL_PATTERN.test(command.trim());
}

function isSystemAutomationCommand(command: string): boolean {
  return SYSTEM_AUTOMATION_PATTERN.test(command.trim());
}

async function getRunCommandConfirmationReason(
  input: Pick<RunCommandInput, "command" | "cwd">,
  context?: AgentToolContext,
): Promise<string | null> {
  const command = input.command.trim();
  const noteWriteBypass = getNoteWriteBypassRefusal(input, context);
  if (noteWriteBypass) return noteWriteBypass;
  if (isNetworkToShellCommand(command)) {
    return "Command downloads code and passes it directly to a shell";
  }
  if (isSystemAutomationCommand(command)) {
    return "Command may automate apps or modify operating system state";
  }
  if (isDestructiveCommand(command)) {
    return "Command may delete, move, install, change permissions, mutate git history/remotes, or modify system state";
  }
  if (APPEND_REDIRECT_PATTERN.test(command)) {
    return "Command appends to a file and needs confirmation";
  }
  const redirectWrite = parseRedirectTarget(command);
  if (redirectWrite) {
    const targetPath = resolveCommandPath(redirectWrite.path, input.cwd);
    const exists = await pathExists(targetPath);
    if (exists === false) return null;
    return "Command may overwrite a redirect target and needs confirmation";
  }
  const reversibleWrite = parseReversibleCommandWrite(command);
  if (reversibleWrite) {
    const targetPath = resolveCommandPath(reversibleWrite.path, input.cwd);
    const exists = await pathExists(targetPath);
    if (exists === false) return null;
    return "Command may overwrite or mutate an existing path and needs confirmation";
  }
  return null;
}

export function createRunCommandTool(): AgentToolDefinition<
  RunCommandInput,
  unknown
> {
  return {
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
      mutability: "write",
      requiresConfirmation: true,
    },

    guidance: {
      matches: (request) =>
        /\b(run|execute|script|python|bash|shell|terminal|command|analyze|analysis|plot|calculate|compute|Rscript)\b/i.test(
          request.userText || "",
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

    async shouldRequireConfirmation(input, context) {
      return Boolean(await getRunCommandConfirmationReason(input, context));
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

    applyConfirmation(input) {
      return ok({ ...input, allowUnsafe: true });
    },

    async execute(input, context) {
      const reversibleWrite = parseReversibleCommandWrite(input.command);
      const existedBeforeWrite = reversibleWrite
        ? await pathExists(resolveCommandPath(reversibleWrite.path, input.cwd))
        : null;
      const noteWriteRefusal = getNoteWriteBypassRefusal(input, context);
      if (noteWriteRefusal) {
        return {
          exitCode: -1,
          stdout: "",
          stderr: noteWriteRefusal,
          command: input.command,
        };
      }
      const confirmationReason = await getRunCommandConfirmationReason(
        input,
        context,
      );
      if (confirmationReason && !input.allowUnsafe) {
        return {
          exitCode: -1,
          stdout: "",
          stderr: confirmationReason,
          command: input.command,
        };
      }
      const result = await executeCommand({
        command: input.command,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
      });
      if (
        result.exitCode === 0 &&
        reversibleWrite &&
        existedBeforeWrite === false
      ) {
        pushUndoEntry(context.request.conversationKey, {
          id: `command-write-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          toolName: "run_command",
          description: reversibleWrite.description,
          revert: async () => {
            await removePathIfExists(
              resolveCommandPath(reversibleWrite.path, input.cwd),
            );
          },
        });
      }

      const maxLen = 8000;
      const stdout =
        result.stdout.length > maxLen
          ? result.stdout.slice(0, maxLen) +
            `\n... [truncated, ${result.stdout.length} chars total]`
          : result.stdout;
      const stderr =
        result.stderr.length > maxLen
          ? result.stderr.slice(0, maxLen) +
            `\n... [truncated, ${result.stderr.length} chars total]`
          : result.stderr;

      return {
        exitCode: result.exitCode,
        stdout,
        stderr,
        command: input.command,
      };
    },
  };
}
