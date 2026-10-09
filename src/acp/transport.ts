import { appLogger } from "../core/logging";
import { CodexAppServerProcess } from "../utils/codexAppServerProcess";
import { getRuntimePlatformInfo } from "../utils/runtimePlatform";
import { AcpProtocol, type AcpAgentInfo } from "./protocol";

/**
 * Spawns an ACP agent and binds its stdio to `AcpProtocol`.
 *
 * ACP agents are ordinary programs (`hermes acp`, an adapter for another
 * agent, …), so the transport reuses the Subprocess loading that the Codex
 * runtime already proved works inside Zotero.
 */

const ACP_DIAGNOSTIC_BUFFER_MAX = 4000;
const ACP_STDERR_TAIL_WAIT_MS = 100;

export type AcpAgentProcess = {
  protocol: AcpProtocol;
  description: string;
  /** stderr/stdout tail, for the message a failed turn reports. */
  diagnostics(): string;
  isAlive(): boolean;
  onClose(handler: () => void): () => void;
  destroy(): void;
};

type AcpInvocation = {
  command: string;
  args: string[];
};

/**
 * Runs the configured command through the platform shell.
 *
 * The command is user-written (`hermes acp --accept-hooks`, a `.cmd` shim, a
 * wrapper script), so the shell is what resolves it the same way the user's
 * own terminal does.
 *
 * ponytail: shell-wrapped, so killing the wrapper can leave the agent itself
 * running. Upgrade path: resolve the binary and spawn it directly, the way
 * `src/utils/codexAppServerProcess.ts` builds its invocation.
 */
export function buildAcpInvocation(
  rawCommand: string,
  platform: "windows" | "macos" | "linux" = getRuntimePlatformInfo().platform,
): AcpInvocation {
  const command = rawCommand.trim();
  if (!command) throw new Error("ACP agent command is empty");
  if (platform === "windows") {
    const systemRoot =
      (globalThis as { process?: { env?: Record<string, string | undefined> } })
        .process?.env?.SystemRoot || "C:\\Windows";
    return {
      command: `${systemRoot}\\System32\\cmd.exe`,
      args: ["/d", "/s", "/c", command],
    };
  }
  return { command: "/bin/sh", args: ["-c", command] };
}

export async function spawnAcpAgent(params: {
  command: string;
  cwd?: string;
}): Promise<AcpAgentProcess> {
  const Subprocess = await CodexAppServerProcess.loadSubprocessModule();
  const invocation = buildAcpInvocation(params.command);
  const description = `${invocation.command} ${invocation.args.join(" ")}`;

  let proc: {
    stdin: { write(data: string): void };
    stdout: { readString(): Promise<string | null> };
    stderr?: { readString(): Promise<string | null> };
    kill(): void;
    wait?(): Promise<unknown>;
  };
  try {
    proc = await Subprocess.call({
      command: invocation.command,
      arguments: invocation.args,
      stderr: "pipe",
      ...(params.cwd ? { workdir: params.cwd } : {}),
    });
  } catch (error) {
    throw new Error(
      `Failed to start the ACP agent (${description}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let diagnostic = "";
  let alive = true;
  const closeHandlers = new Set<() => void>();

  const protocol = new AcpProtocol(
    (line) => {
      proc.stdin.write(`${line}\n`);
    },
    {
      onProtocolError: (error) => {
        appLogger.debug(`[llm-for-zotero] acp: ${error.message}`);
      },
    },
  );

  const notifyClose = (error: Error): void => {
    if (!alive) return;
    alive = false;
    protocol.close(error);
    for (const handler of closeHandlers) {
      try {
        handler();
      } catch {
        /* a close handler must not mask the failure that closed us */
      }
    }
    closeHandlers.clear();
  };

  const clone = (chunk: unknown): string =>
    typeof chunk === "string" ? chunk : "";

  void (async () => {
    let buffer = "";
    while (alive) {
      let chunk: string | null;
      try {
        chunk = await proc.stdout.readString();
      } catch {
        break;
      }
      if (!chunk) break;
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) protocol.handleLine(line);
    }
    if (buffer.trim()) protocol.handleLine(buffer);
    if (!alive) return;
    notifyClose(
      new Error(
        `ACP agent exited${diagnostic ? `: ${diagnostic}` : " with no stderr output"} (${description})`,
      ),
    );
  })();

  void (async () => {
    if (!proc.stderr?.readString) return;
    while (alive) {
      let chunk: string | null;
      try {
        chunk = await proc.stderr.readString();
      } catch {
        break;
      }
      if (!chunk) break;
      diagnostic = `${diagnostic}${clone(chunk)}`.slice(
        -ACP_DIAGNOSTIC_BUFFER_MAX,
      );
    }
  })();

  return {
    protocol,
    description,
    diagnostics: () => diagnostic.replace(/\s+/g, " ").trim(),
    isAlive: () => alive,
    onClose: (handler) => {
      if (!alive) {
        handler();
        return () => {};
      }
      closeHandlers.add(handler);
      return () => {
        closeHandlers.delete(handler);
      };
    },
    destroy: () => {
      notifyClose(new Error("ACP agent stopped"));
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

/** Waits briefly for the stderr tail so a startup failure can quote it. */
export async function waitForAcpStderrTail(): Promise<void> {
  await new Promise<void>((resolve) =>
    setTimeout(resolve, ACP_STDERR_TAIL_WAIT_MS),
  );
}

export type AcpHandshake = {
  agentInfo?: Partial<AcpAgentInfo>;
  protocolVersion: number;
  loadSession: boolean;
};
