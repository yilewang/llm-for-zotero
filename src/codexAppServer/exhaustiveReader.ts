import type { ReasoningConfig } from "../shared/llm";
import {
  createExhaustiveBatchAnalyzer,
  type ExhaustiveBatchAnalyzer,
} from "../shared/exhaustiveDocumentReader";
import {
  destroyCachedCodexAppServerProcess,
  extractCodexAppServerThreadId,
  extractCodexAppServerTurnId,
  getOrCreateCodexAppServerProcess,
  resolveCodexAppServerBinaryPath,
  resolveCodexAppServerReasoningParams,
  waitForCodexAppServerTurnCompletion,
  type CodexAppServerProcess,
  type CodexAppServerProcessOptions,
} from "../utils/codexAppServerProcess";

const NATIVE_EXHAUSTIVE_READER_PROCESS_PREFIX =
  "codex_app_server_exhaustive_reader";

export type CodexAppServerExhaustiveReaderSession = {
  analyzeBatch: ExhaustiveBatchAnalyzer;
  dispose: () => void;
};

function createProcessKey(): string {
  return `${NATIVE_EXHAUSTIVE_READER_PROCESS_PREFIX}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Aborted");
  error.name = "AbortError";
  throw error;
}

function normalizeModel(model?: string): string | undefined {
  const normalized = (model || "").trim();
  return normalized && normalized !== "codex-app-server"
    ? normalized
    : undefined;
}

export function createCodexAppServerExhaustiveReaderSession(params: {
  model?: string;
  codexPath?: string;
  reasoning?: ReasoningConfig;
  processKey?: string;
}): CodexAppServerExhaustiveReaderSession {
  const processKey = params.processKey || createProcessKey();
  const processOptions: CodexAppServerProcessOptions = {
    codexPath: resolveCodexAppServerBinaryPath(params.codexPath),
  };
  const model = normalizeModel(params.model);
  let proc: CodexAppServerProcess | null = null;
  let disposed = false;

  const analyzeBatch = createExhaustiveBatchAnalyzer(
    async ({ prompt, systemMessages, signal }) => {
      if (disposed) {
        throw new Error("Codex exhaustive reader session is closed");
      }
      throwIfAborted(signal);
      proc = await getOrCreateCodexAppServerProcess(processKey, processOptions);
      return proc.runTurnExclusive(async () => {
        throwIfAborted(signal);
        const threadResult = await proc!.sendRequest("thread/start", {
          ...(model ? { model } : {}),
          ephemeral: true,
          approvalPolicy: "never",
          config: { features: { shell_tool: false } },
        });
        const threadId = extractCodexAppServerThreadId(threadResult);
        if (!threadId) {
          throw new Error("Codex app-server did not return a worker thread ID");
        }

        throwIfAborted(signal);
        const turnResult = await proc!.sendRequest("turn/start", {
          threadId,
          input: [
            {
              type: "text",
              text: [...systemMessages, prompt].join("\n\n"),
            },
          ],
          ...(model ? { model } : {}),
          ...resolveCodexAppServerReasoningParams(params.reasoning, model),
        });
        const turnId = extractCodexAppServerTurnId(turnResult);
        if (!turnId) {
          throw new Error("Codex app-server did not return a worker turn ID");
        }
        return waitForCodexAppServerTurnCompletion({
          proc: proc!,
          threadId,
          turnId,
          signal,
          interruptOnAbort: true,
          cacheKey: processKey,
          processOptions,
        });
      });
    },
  );

  return {
    analyzeBatch,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      destroyCachedCodexAppServerProcess(
        processKey,
        proc || undefined,
        processOptions,
      );
      proc = null;
    },
  };
}
