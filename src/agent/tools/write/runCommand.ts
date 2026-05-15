/**
 * Tool that gives the agent the ability to run shell commands.
 * This turns the Zotero agent into a coding-capable agent that can
 * run analysis scripts, process data, invoke external tools, etc.
 *
 * Uses Mozilla's Subprocess module (Gecko runtime).
 */
import type { AgentToolDefinition } from "../../types";
import { getRuntimePlatformInfo } from "../../../utils/runtimePlatform";
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

/** Patterns that indicate a command only reads data (safe to auto-approve). */
const READ_ONLY_COMMANDS =
  /^\s*(?:cat|head|tail|less|more|ls|dir|find|file|wc|du|stat|which|where|type|pwd|echo|printf|grep|rg|awk|sed\s+-n|sort|uniq|diff|strings|xxd|hexdump|md5|shasum|sha256sum|tesseract|swift|node\s+-e|python3?\s+[-\/])/i;

/** Patterns that indicate a command mutates state (always require confirmation). */
const DESTRUCTIVE_COMMANDS =
  /(?:^|\||\;|&&)\s*(?:rm\s|rmdir\s|mv\s|cp\s|chmod\s|chown\s|sudo\s|pip\s+install|npm\s+install|brew\s+install|git\s+(?:push|reset|checkout|clean|rebase)|mkfs|dd\s)/i;

/** Redirect to file (overwrite or append) — but not heredoc `<<`. */
const REDIRECT_PATTERN = /(?:^|[^<])\s*>{1,2}\s*[^\s&]/;

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

function parseRedirectTarget(command: string): ReversibleCommandWrite | null {
  const match = command.match(
    /^\s*((?:echo|printf|cat)\b[\s\S]*?)\s*(?:>{1,2})\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*$/i,
  );
  if (!match) return null;
  const producer = match[1] || "";
  const path = (match[2] || match[3] || match[4] || "").trim();
  if (!path || hasGlobPattern(path) || /[;&|<>]/.test(producer)) return null;
  return {
    kind: "file",
    path,
    description: `Delete created file from shell redirect: ${path}`,
  };
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

function isReadOnlyDateCommand(command: string): boolean {
  const trimmed = command.trim();
  return /^date(?:\s+(?:-u|--utc|\+\S+|"\+[^"]*"|'\+[^']*'))*\s*$/i.test(
    trimmed,
  );
}

function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  // Destructive commands always need confirmation
  if (isDestructiveCommand(trimmed)) return false;
  // Date reads are common for note templates; setting system time is not.
  if (isReadOnlyDateCommand(trimmed)) return true;
  // File redirects are writes
  if (REDIRECT_PATTERN.test(trimmed)) return false;
  // Known read-only commands are safe
  if (READ_ONLY_COMMANDS.test(trimmed)) return true;
  // Piped commands starting with a read-only command
  const firstCommand = trimmed.split(/\s*[|;]\s*/)[0];
  if (READ_ONLY_COMMANDS.test(firstCommand)) return true;
  return false;
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

    async shouldRequireConfirmation(input, _context) {
      const reversibleWrite = parseReversibleCommandWrite(input.command);
      if (reversibleWrite) {
        const exists = await pathExists(reversibleWrite.path);
        if (exists === false) return false;
        return true;
      }
      // Destructive commands always need confirmation.
      if (isDestructiveCommand(input.command)) return true;
      // Auto-approve read-only commands (analysis, inspection, listing)
      if (isReadOnlyCommand(input.command)) return false;
      return true;
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
            type: "text" as const,
            id: "command",
            label: "Command",
            value: input.command,
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
        ? await pathExists(reversibleWrite.path)
        : null;
      if (
        reversibleWrite &&
        existedBeforeWrite !== false &&
        !input.allowUnsafe
      ) {
        return {
          exitCode: -1,
          stdout: "",
          stderr: "Refusing to overwrite an existing path without confirmation",
          command: input.command,
        };
      }
      if (
        !reversibleWrite &&
        !isReadOnlyCommand(input.command) &&
        !input.allowUnsafe
      ) {
        return {
          exitCode: -1,
          stdout: "",
          stderr:
            "Refusing to run a mutating shell command without confirmation",
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
            await removePathIfExists(reversibleWrite.path);
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
