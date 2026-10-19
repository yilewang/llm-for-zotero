import { CodexAppServerProcess } from "../utils/codexAppServerProcess";
import { getHarnessPreference } from "./prefs";

export type HarnessConfiguration = {
  model: string;
  apiBase: string;
  apiKey: string;
  systemPrompt: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  tools: Array<{ name: string; description: string; inputSchema: object }>;
  contextWindow: number;
  maxTokens?: number;
  temperature?: number;
  session?: {
    root: string;
    key: string;
    userText: string;
    history: Array<{ role: "user" | "assistant"; content: string }>;
  };
  turnText?: string;
};

export async function runHarnessProcess(
  configuration: HarnessConfiguration,
  text: string,
  options: {
    signal: AbortSignal;
    onStop: () => void;
    onEvent: (event: unknown) => Promise<void>;
    /** Inactivity budget between completed model steps; tools and approvals pause it. */
    modelTimeoutMs?: number;
    onToolCall: (call: {
      callId: string;
      name: string;
      args: unknown;
    }) => Promise<unknown>;
  },
): Promise<{ text: string }> {
  if (options.signal.aborted) throw new Error("Cancelled");
  const nodePath = getHarnessPreference("deepseekHarnessNodePath");
  const workerPath = getHarnessPreference("deepseekHarnessWorkerPath");
  if (!nodePath || !workerPath) {
    throw new Error(
      "Set the Node executable and DeepSeek Harness worker paths in Settings → Agent → Original Agent.",
    );
  }
  const subprocess = await CodexAppServerProcess.loadSubprocessModule();
  const process = await subprocess.call({
    command: nodePath,
    arguments: [workerPath],
    stderr: "pipe",
  });
  const pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      pause: () => void;
      resume: (reset?: boolean) => void;
    }
  >();
  const hostTasks = new Set<Promise<void>>();
  let sequence = 0;
  let events = Promise.resolve();
  let stopped = false;
  let stderr = "";
  const redact = (message: string) =>
    message.split(configuration.apiKey).join("[redacted]");
  const fail = (error: Error) => {
    stopped = true;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  const send = async (message: object) => {
    await process.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n",
    );
  };
  const request = (method: string, params: unknown, timeout: number) => {
    if (stopped) return Promise.reject(new Error("Harness process closed"));
    const id = ++sequence;
    return new Promise<any>((resolve, reject) => {
      let remaining = timeout;
      let startedAt = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pause = () => {
        if (timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
        remaining = Math.max(0, remaining - (Date.now() - startedAt));
      };
      const resume = (reset = false) => {
        if (reset) {
          pause();
          remaining = timeout;
        }
        if (timer !== undefined || stopped) return;
        startedAt = Date.now();
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Harness ${method} timed out`));
        }, remaining);
      };
      pending.set(id, {
        pause,
        resume,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      resume();
      void send({ id, method, params }).catch((error) => fail(error));
    });
  };
  const onAbort = () => {
    void send({ method: "cancel" }).catch(() => undefined);
    fail(new Error("Cancelled"));
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  const read = (async () => {
    let buffer = "";
    try {
      while (true) {
        const chunk = await process.stdout.readString();
        if (!chunk) break;
        buffer += chunk;
        if (buffer.length > 32 * 1024 * 1024)
          throw new Error("Harness response exceeded 32 MiB");
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          const entry = pending.get(message.id);
          if (entry) {
            pending.delete(message.id);
            if (message.error) {
              entry.reject(
                new Error(redact(message.error.message || "Harness error")),
              );
            } else {
              entry.resolve(message.result);
            }
          } else if (message.method === "event") {
            if (message.params?.type === "usage" && !hostTasks.size)
              for (const entry of pending.values()) entry.resume(true);
            events = events.then(() => options.onEvent(message.params));
            void events.catch((error) => fail(error));
          } else if (
            message.method === "tool_call" &&
            !options.signal.aborted
          ) {
            // Host tools can wait for user input; only model time uses the run budget.
            for (const entry of pending.values()) entry.pause();
            const task = (async () => {
              try {
                const result = await options.onToolCall(message.params);
                await send({ id: message.id, result });
              } catch (error) {
                await send({
                  id: message.id,
                  error: { code: -32603, message: redact(String(error)) },
                });
              }
            })();
            hostTasks.add(task);
            void task
              .finally(() => {
                hostTasks.delete(task);
                if (!hostTasks.size)
                  for (const entry of pending.values()) entry.resume(true);
              })
              .catch((error) => fail(error));
          }
        }
      }
      fail(new Error(`Harness exited${stderr ? `: ${redact(stderr)}` : ""}`));
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  })();
  const errors = (async () => {
    try {
      while (true) {
        const chunk = await process.stderr.readString();
        if (!chunk) break;
        stderr = (stderr + chunk).slice(-2000);
      }
    } catch {
      /* Closing the process closes its diagnostic pipe. */
    }
  })();
  try {
    if (options.signal.aborted) onAbort();
    await request("initialize", { ...configuration, turnText: text }, 30000);
    const timeout = options.modelTimeoutMs ?? 600000;
    let result;
    try {
      result = await request("run", { text }, timeout);
    } catch (error) {
      if (
        options.signal.aborted ||
        !(error instanceof Error) ||
        error.message !== "Harness run timed out"
      )
        throw error;
      await request("checkpoint", {}, 30000);
      await options.onEvent({
        type: "status",
        text: "Model step timed out; session checkpoint saved. Resuming once without replaying completed tools.",
      });
      try {
        result = await request(
          "run",
          {
            text: "Continue the interrupted turn from the saved session.",
            resume: true,
          },
          timeout,
        );
      } catch (resumedError) {
        if (
          !options.signal.aborted &&
          resumedError instanceof Error &&
          resumedError.message === "Harness run timed out"
        )
          await request("checkpoint", {}, 30000);
        throw resumedError;
      }
    }
    await events;
    if (!result || typeof result.text !== "string")
      throw new Error("Invalid Harness result");
    return result;
  } finally {
    options.onStop();
    options.signal.removeEventListener("abort", onAbort);
    fail(new Error("Harness process closed"));
    await Promise.allSettled([...hostTasks]);
    await process.stdin.close().catch(() => undefined);
    const timer = setTimeout(() => process.kill(9), 2000);
    try {
      await process.wait();
    } finally {
      clearTimeout(timer);
    }
    await Promise.allSettled([read, errors]);
  }
}
