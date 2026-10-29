/**
 * Tool that gives the agent the ability to run shell commands.
 * This turns the Zotero agent into a coding-capable agent that can
 * run analysis scripts, process data, invoke external tools, etc.
 *
 * Uses Mozilla's Subprocess module (Gecko runtime).
 */
import type {
  AgentActionEvidence,
  AgentToolEffect,
  AgentWriteToolDefinition,
} from "../../types";
import { getRuntimePlatformInfo } from "../../../utils/runtimePlatform";
import { neverSelected } from "../guidance";
import { ok, fail, validateObject } from "../shared";
import { executeExternalMutation } from "../../services/externalMutationCoordinator";
import { sha256Bytes } from "../../store/journalRecoveryBlobStore";
import { fingerprintText } from "../../contracts/actionOperationEvidence";

import {
  classifyRunCommandInvocation,
  pathExists,
  resolveReversibleOutputPath,
  identifyCommandOutput,
  type RunCommandInput,
} from "./commandAnalysis";
export { classifyRunCommandInvocation } from "./commandAnalysis";

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
type CommandOutcome =
  | "succeeded"
  | "failed"
  | "uncertain"
  | "timed_out"
  | "cancelled"
  | "launch_failed";

export async function executeCommand(params: {
  command: string;
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  outcome: CommandOutcome;
}> {
  const { command, timeoutMs } = params;
  const { shell, shellFlag } = resolveShellPath();
  if (params.signal?.aborted)
    return {
      stdout: "",
      stderr: "Command cancelled before launch.",
      exitCode: -1,
      outcome: "cancelled",
    };
  let subprocess: any;
  const chromeUtils = (globalThis as any).ChromeUtils;
  try {
    if (chromeUtils?.importESModule) {
      const mod = chromeUtils.importESModule(
        "resource://gre/modules/Subprocess.sys.mjs",
      );
      subprocess = mod.Subprocess || mod.default || mod;
    }
  } catch {
    /* try the older module below, before any process is launched */
  }
  if (!subprocess && chromeUtils?.import) {
    try {
      const mod = chromeUtils.import("resource://gre/modules/Subprocess.jsm");
      subprocess = mod.Subprocess || mod;
    } catch {
      /* reported below */
    }
  }
  if (typeof subprocess?.call !== "function")
    return {
      stdout: "",
      stderr:
        "Controllable host command execution is unavailable in this Zotero environment. No command was launched.",
      exitCode: -1,
      outcome: "launch_failed",
    };

  const info = getRuntimePlatformInfo();
  let tempOut = "";
  let process: any;
  try {
    let launchedCommand = command;
    if (info.platform === "windows") {
      const Components = (globalThis as any).Components;
      const tempDir =
        (globalThis as any).Services?.dirsvc?.get(
          "TmpD",
          Components?.interfaces?.nsIFile,
        )?.path || "C:\\Windows\\Temp";
      tempOut = `${tempDir}\\zotero-llm-cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
      launchedCommand = `( ${command} ) > "${tempOut}" 2>&1`;
    }
    process = await subprocess.call({
      command: shell,
      arguments: [shellFlag, launchedCommand],
      workdir: params.cwd || undefined,
    });
  } catch (error) {
    return {
      stdout: "",
      stderr: `Command launch failed; no fallback execution was attempted: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: -1,
      outcome: "launch_failed",
    };
  }
  if (params.signal?.aborted) {
    try {
      process.kill();
    } catch {
      /* best effort */
    }
    return {
      stdout: "",
      stderr:
        "Command cancelled; termination was requested, but detached descendants may still be running.",
      exitCode: -1,
      outcome: "cancelled",
    };
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const stop = <T extends "timed_out" | "cancelled">(outcome: T): T => {
    try {
      process.kill();
    } catch {
      /* termination is best effort; the outcome states the uncertainty */
    }
    return outcome;
  };
  const timeout = new Promise<"timed_out">((resolve) => {
    timeoutHandle = setTimeout(() => resolve(stop("timed_out")), timeoutMs);
  });
  const cancellation = new Promise<"cancelled">((resolve) => {
    abortListener = () => resolve(stop("cancelled"));
    params.signal?.addEventListener("abort", abortListener, { once: true });
  });
  const resultPromise = (async () => {
    const [stdout, stderr, waited] = await Promise.all([
      drainPipe(process.stdout),
      drainPipe(process.stderr),
      process.wait(),
    ]);
    return { stdout, stderr, exitCode: Number(waited.exitCode) };
  })();
  resultPromise.catch(() => undefined);
  try {
    const settled = await Promise.race([resultPromise, timeout, cancellation]);
    if (settled === "timed_out" || settled === "cancelled") {
      return {
        stdout: "",
        stderr:
          settled === "timed_out"
            ? "Command timed out; termination was requested, but detached descendants may still be running."
            : "Command cancelled; termination was requested, but detached descendants may still be running.",
        exitCode: -1,
        outcome: settled,
      };
    }
    let stdout = settled.stdout;
    if (tempOut) {
      try {
        const bytes = await (globalThis as any).IOUtils.read(tempOut);
        stdout = new TextDecoder("utf-8").decode(
          bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
        );
      } catch {
        /* keep captured output */
      }
    }
    return {
      stdout,
      stderr: settled.stderr,
      exitCode: settled.exitCode,
      outcome: settled.exitCode === 0 ? "succeeded" : "failed",
    };
  } catch (error) {
    return {
      stdout: "",
      stderr: `Command outcome is uncertain after launch: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: -1,
      outcome: "uncertain",
    };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (abortListener)
      params.signal?.removeEventListener("abort", abortListener);
    if (tempOut) {
      try {
        await (globalThis as any).IOUtils?.remove?.(tempOut, {
          ignoreAbsent: true,
        });
      } catch {
        /* managed temporary output cleanup is best effort */
      }
    }
  }
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
    effectOperations: ["command_execute"],
    spec: {
      name: "run_command",
      description:
        "Run a host shell command. cwd selects the process working directory; it does not confine filesystem access. The command string is passed directly to the native shell (cmd.exe on Windows, zsh on macOS, bash on Linux). " +
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
      workCategory: "external_system",
    },

    guidance: {
      matches: neverSelected,
      instruction:
        "Use run_command to execute shell commands for data analysis, running scripts, or invoking external tools. " +
        "Do not use run_command for ordinary Zotero paper/library reading when semantic Zotero tools can answer. " +
        "Use native shell syntax for the current OS: for example `dir %USERPROFILE%\\\\Desktop` on Windows or `ls ~/Desktop` on macOS/Linux. " +
        "Pass the complete command as a single string — pipes, redirects, globbing, and all shell features work. " +
        "Do NOT split the command into separate command/args fields.",
    },

    presentation: {
      label: "Run Command",
      traceIcon: "code",
      // The command itself is the row's content, so the row shows the tool's
      // label and the block carries the text rather than saying it twice.
      buildTraceCodeBlock: ({ args }) => {
        const command =
          args && typeof args === "object" && !Array.isArray(args)
            ? (args as Record<string, unknown>).command
            : undefined;
        return typeof command === "string" && command.trim()
          ? { code: command, replacesSummary: true }
          : null;
      },
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
      input.cwd ||= context.request.workingDirectory;
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
      const reversibleWrite = identifyCommandOutput(input.command);
      let outputPath: string | undefined;
      const run = () =>
        executeCommand({
          command: input.command,
          cwd: input.cwd,
          timeoutMs: input.timeoutMs,
          signal: context.signal,
        });
      const formatResult = (
        commandResult: Awaited<ReturnType<typeof executeCommand>>,
        effect: AgentToolEffect,
        actionEvidence?: AgentActionEvidence[],
      ) => {
        if (commandResult.exitCode === 0 && input.cwd)
          context.request.workingDirectory = input.cwd;
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
            ...(input.cwd ? { cwd: input.cwd } : {}),
            outcome: commandResult.outcome,
          },
          effect,
          ...(actionEvidence ? { actionEvidence } : {}),
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
      return formatResult(result.content, result.effect, result.actionEvidence);
    },
  };
}
