/**
 * Tool that gives the agent the ability to run shell commands.
 * This turns the Zotero agent into a coding-capable agent that can
 * run analysis scripts, process data, invoke external tools, etc.
 *
 * Uses Mozilla's Subprocess module (Gecko runtime).
 */
import type { AgentToolDefinition } from "../../types";
import { ok, fail, validateObject } from "../shared";

type RunCommandInput = {
  command: string;
  cwd?: string;
  timeoutMs: number;
};

/**
 * Resolve the absolute path of the shell executable.
 * Mozilla Subprocess requires an absolute path.
 */
function resolveShellPath(): { shell: string; shellFlag: string } {
  const isWin =
    (Zotero as any).isWin ||
    (typeof navigator !== "undefined" && /win/i.test(navigator.platform || ""));
  if (isWin) {
    const sysRoot = (globalThis as any).Services?.env?.get?.("SystemRoot") || "C:\\Windows";
    return { shell: `${sysRoot}\\System32\\cmd.exe`, shellFlag: "/c" };
  }
  if ((Zotero as any).isMac) {
    return { shell: "/bin/zsh", shellFlag: "-c" };
  }
  return { shell: "/bin/bash", shellFlag: "-c" };
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
  } catch { /* pipe closed */ }
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
        const mod = CU.importESModule("resource://gre/modules/Subprocess.sys.mjs");
        Subprocess = mod.Subprocess || mod.default || mod;
      } catch { /* fallback below */ }
    }
    if (!Subprocess && CU?.import) {
      try {
        const mod = CU.import("resource://gre/modules/Subprocess.jsm");
        Subprocess = mod.Subprocess || mod;
      } catch { /* fallback below */ }
    }

    if (Subprocess?.call) {
      const proc = await Subprocess.call({
        command: shell,
        arguments: [shellFlag, command],
        environment: {},
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
        try { proc.kill(); } catch { /* ignore */ }
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
      stdout: "(nsIProcess does not capture stdout — check output files instead)",
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

// Per-conversation auto-approve state for run_command and file_io
const autoApprovedConversations = new Set<number>();

export function isCommandAutoApproved(conversationKey: number): boolean {
  return autoApprovedConversations.has(conversationKey);
}

export function setCommandAutoApproved(conversationKey: number, value: boolean): void {
  if (value) {
    autoApprovedConversations.add(conversationKey);
  } else {
    autoApprovedConversations.delete(conversationKey);
  }
}

/** Patterns that indicate a command only reads data (safe to auto-approve). */
const READ_ONLY_COMMANDS = /^\s*(?:cat|head|tail|less|more|ls|find|file|wc|du|stat|which|type|echo|printf|grep|rg|awk|sed\s+-n|sort|uniq|diff|strings|xxd|hexdump|md5|shasum|sha256sum|tesseract|swift|node\s+-e|python3?\s+[-\/])/i;

/** Patterns that indicate a command mutates state (always require confirmation). */
const DESTRUCTIVE_COMMANDS = /(?:^|\||\;|&&)\s*(?:rm\s|rmdir\s|mv\s|cp\s|chmod\s|chown\s|sudo\s|pip\s+install|npm\s+install|brew\s+install|git\s+(?:push|reset|checkout|clean|rebase)|mkfs|dd\s)/i;

/** Redirect to file (overwrite or append) — but not heredoc `<<`. */
const REDIRECT_PATTERN = /(?:^|[^<])\s*>{1,2}\s*[^\s&]/;

function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  // Destructive commands always need confirmation
  if (DESTRUCTIVE_COMMANDS.test(trimmed)) return false;
  // File redirects are writes
  if (REDIRECT_PATTERN.test(trimmed)) return false;
  // Known read-only commands are safe
  if (READ_ONLY_COMMANDS.test(trimmed)) return true;
  // Piped commands starting with a read-only command
  const firstCommand = trimmed.split(/\s*[|;]\s*/)[0];
  if (READ_ONLY_COMMANDS.test(firstCommand)) return true;
  return false;
}

export function createRunCommandTool(): AgentToolDefinition<RunCommandInput, unknown> {
  return {
    spec: {
      name: "run_command",
      description:
        "Run a shell command on the local machine. The command string is passed directly to the shell (zsh on macOS, bash on Linux). " +
        "Use this to run analysis scripts, process data, invoke CLI tools, list files, etc. Returns stdout, stderr, and exit code.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["command"],
        properties: {
          command: {
            type: "string",
            description:
              "The full shell command to run, exactly as you would type it in a terminal. " +
              "Examples: 'ls ~/Desktop/*.pdf', 'python3 /tmp/analyze.py', 'wc -l < file.txt', " +
              "'find ~/Desktop -name \"*.pdf\" | wc -l'. Pipes, redirects, and shell features all work.",
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
        "Pass the complete command as a single string — pipes, redirects, globbing, and all shell features work. " +
        "Do NOT split the command into separate command/args fields.",
    },

    presentation: {
      label: "Run Command",
      summaries: {
        onCall: ({ args }) => {
          const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
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
          return exitCode === 0 ? "Command completed successfully" : `Command exited with code ${exitCode}`;
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
        cwd: typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : undefined,
        timeoutMs,
      });
    },

    shouldRequireConfirmation(input, context) {
      // Skip confirmation if user already approved commands in this conversation
      if (isCommandAutoApproved(context.request.conversationKey)) return false;
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
            ? [{
                type: "text" as const,
                id: "cwd",
                label: "Working directory",
                value: input.cwd,
              }]
            : []),
          {
            type: "select" as const,
            id: "approvalMode",
            label: "Approval mode",
            value: "ask",
            options: [
              { id: "ask", label: "Ask every time" },
              { id: "auto", label: "Auto accept for this chat" },
            ],
          },
        ],
      };
    },

    applyConfirmation(input, resolutionData, context) {
      if (validateObject<Record<string, unknown>>(resolutionData)) {
        if (resolutionData.approvalMode === "auto") {
          setCommandAutoApproved(context.request.conversationKey, true);
        }
      }
      return ok(input);
    },

    async execute(input, context) {
      const result = await executeCommand({
        command: input.command,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
      });

      const maxLen = 8000;
      const stdout =
        result.stdout.length > maxLen
          ? result.stdout.slice(0, maxLen) + `\n... [truncated, ${result.stdout.length} chars total]`
          : result.stdout;
      const stderr =
        result.stderr.length > maxLen
          ? result.stderr.slice(0, maxLen) + `\n... [truncated, ${result.stderr.length} chars total]`
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
