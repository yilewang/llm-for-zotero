import type { ProviderEvent } from "../runtime.js";
import { globalPermissionStore } from "../permissions/permission-store.js";

interface ClaudeContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
}

interface MessageContainer {
  content?: ClaudeContentBlock[];
  usage?: Record<string, unknown>;
}

interface ModelUsageEntry {
  contextWindow?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function getSessionId(msg: unknown): string | undefined {
  const record = asRecord(msg);
  if (typeof record.sessionId === "string" && record.sessionId.trim())
    return record.sessionId.trim();
  if (typeof record.session_id === "string" && record.session_id.trim())
    return record.session_id.trim();
  return undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function formatApiRetryStatus(msg: Record<string, unknown>): string {
  const status = asFiniteNumber(msg.error_status);
  const error =
    typeof msg.error === "string" && msg.error.trim()
      ? msg.error.trim()
      : undefined;
  const attempt = asFiniteNumber(msg.attempt);
  const maxRetries = asFiniteNumber(msg.max_retries);
  const retrySuffix =
    attempt !== undefined && maxRetries !== undefined
      ? ` (attempt ${attempt}/${maxRetries})`
      : attempt !== undefined
        ? ` (attempt ${attempt})`
        : "";

  if (status === 429 || error === "rate_limit") {
    return `Claude API rate limited. Retrying request${retrySuffix}.`;
  }
  if (status !== undefined || error) {
    const detail = [status !== undefined ? `HTTP ${status}` : undefined, error]
      .filter(Boolean)
      .join(", ");
    return `Claude API request failed (${detail}). Retrying${retrySuffix}.`;
  }
  return `Claude API request failed. Retrying${retrySuffix}.`;
}

function normalizeUsagePayload(args: {
  usage?: Record<string, unknown> | undefined;
  modelUsage?: Record<string, ModelUsageEntry> | undefined;
  sessionId?: string;
  includeOutputTokens?: boolean;
}): ProviderEvent | null {
  const inputTokens =
    asFiniteNumber(args.usage?.input_tokens) ??
    asFiniteNumber(args.usage?.inputTokens) ??
    0;
  const outputTokens =
    asFiniteNumber(args.usage?.output_tokens) ??
    asFiniteNumber(args.usage?.outputTokens) ??
    0;
  const cacheCreationInputTokens =
    asFiniteNumber(args.usage?.cache_creation_input_tokens) ??
    asFiniteNumber(args.usage?.cacheCreationInputTokens) ??
    0;
  const cacheReadInputTokens =
    asFiniteNumber(args.usage?.cache_read_input_tokens) ??
    asFiniteNumber(args.usage?.cacheReadInputTokens) ??
    0;
  const contextTokens = Math.max(
    0,
    inputTokens +
      cacheCreationInputTokens +
      cacheReadInputTokens +
      (args.includeOutputTokens === true ? outputTokens : 0),
  );

  let model: string | undefined;
  let contextWindow: number | undefined;
  const modelUsageEntries = args.modelUsage
    ? Object.entries(args.modelUsage)
    : [];
  if (modelUsageEntries.length === 1) {
    const [modelName, entry] = modelUsageEntries[0]!;
    model = modelName || undefined;
    contextWindow = asFiniteNumber(entry?.contextWindow);
  }

  if (
    contextTokens <= 0 &&
    !(
      typeof contextWindow === "number" &&
      Number.isFinite(contextWindow) &&
      contextWindow > 0
    )
  ) {
    return null;
  }

  const percentage =
    typeof contextWindow === "number" &&
    Number.isFinite(contextWindow) &&
    contextWindow > 0
      ? Math.max(
          0,
          Math.min(100, Math.round((contextTokens / contextWindow) * 100)),
        )
      : undefined;

  return {
    type: "usage",
    payload: {
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      contextTokens,
      contextWindow,
      contextWindowIsAuthoritative:
        typeof contextWindow === "number" &&
        Number.isFinite(contextWindow) &&
        contextWindow > 0,
      percentage,
      sessionId: args.sessionId,
      model,
    },
  };
}

function normalizeContextWindowPayload(args: {
  modelUsage?: Record<string, ModelUsageEntry> | undefined;
  sessionId?: string;
}): ProviderEvent | null {
  const modelUsageEntries = args.modelUsage
    ? Object.entries(args.modelUsage)
    : [];
  if (modelUsageEntries.length !== 1) return null;
  const [modelName, entry] = modelUsageEntries[0]!;
  const contextWindow = asFiniteNumber(entry?.contextWindow);
  if (
    !(
      typeof contextWindow === "number" &&
      Number.isFinite(contextWindow) &&
      contextWindow > 0
    )
  ) {
    return null;
  }
  return {
    type: "usage",
    payload: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      contextTokens: 0,
      contextWindow,
      contextWindowIsAuthoritative: true,
      sessionId: args.sessionId,
      model: modelName || undefined,
    },
  };
}

function normalizeToolResultContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const block = asRecord(item);
        if (typeof block.text === "string") {
          return block.text;
        }
        return JSON.stringify(block);
      })
      .join("\n");
  }
  if (content === undefined || content === null) {
    return "";
  }
  return JSON.stringify(content);
}

function extractResultOutput(msg: Record<string, unknown>): string {
  if (typeof msg.result === "string" && msg.result.trim()) {
    return msg.result;
  }
  const error = asRecord(msg.error);
  if (typeof error.message === "string" && error.message.trim()) {
    return `Error: ${error.message}`;
  }
  if (Array.isArray(msg.errors) && msg.errors.length > 0) {
    const first = asRecord(msg.errors[0]);
    const message =
      (typeof first.message === "string" && first.message.trim()) ||
      (typeof first.error === "string" && first.error.trim()) ||
      "";
    if (message) {
      return `Error: ${message}`;
    }
    const rawErrors = JSON.stringify(msg.errors);
    if (
      rawErrors.includes("[ede_diagnostic]") &&
      rawErrors.includes("result_type=assistant") &&
      rawErrors.includes("last_content_type=none")
    ) {
      return "Error: The model returned an empty reply. Please retry.";
    }
    return `Error: ${rawErrors}`;
  }
  if (msg.is_error) {
    return "Error: runtime returned an empty error result.";
  }
  return "";
}

const READER_FACING_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  "hook_started",
  "hook_response",
  "init",
  "api_retry",
]);

export function mapSdkMessageToProviderEvents(raw: unknown): ProviderEvent[] {
  const msg = asRecord(raw);
  const type = typeof msg.type === "string" ? msg.type : "unknown";
  const sessionId = getSessionId(msg);
  const providerEvent: ProviderEvent = {
    type: "provider_event",
    payload: {
      providerType: type,
      sessionId,
      ts: Date.now(),
      payload: msg,
    },
  };

  if (type === "confirmation_required") {
    const requestId =
      (typeof msg.requestId === "string" && msg.requestId.trim()) ||
      (typeof msg.request_id === "string" && msg.request_id.trim()) ||
      "";
    if (!requestId) {
      return [providerEvent];
    }
    const actionCandidate =
      (msg.action && typeof msg.action === "object" ? msg.action : undefined) ??
      (msg.pendingAction && typeof msg.pendingAction === "object"
        ? msg.pendingAction
        : undefined) ??
      (msg.pending_action && typeof msg.pending_action === "object"
        ? msg.pending_action
        : undefined);
    const looksLikeSdkPermission = globalPermissionStore.hasPending(requestId);
    const isAskUserQuestion =
      (typeof msg.tool_name === "string" &&
        msg.tool_name === "AskUserQuestion") ||
      (typeof msg.toolName === "string" &&
        msg.toolName === "AskUserQuestion") ||
      (typeof msg.name === "string" && msg.name === "AskUserQuestion") ||
      (typeof msg.message === "string" &&
        msg.message.includes("AskUserQuestion"));
    if (!looksLikeSdkPermission && !isAskUserQuestion && !actionCandidate) {
      return [providerEvent];
    }
    const action = (actionCandidate as Record<string, unknown> | undefined) ?? {
      toolName: isAskUserQuestion ? "AskUserQuestion" : "action",
      title: isAskUserQuestion ? "Question from Claude" : "Approval required",
      mode: isAskUserQuestion ? "question" : "approval",
      confirmLabel: isAskUserQuestion ? "Submit" : "Approve",
      cancelLabel: isAskUserQuestion ? "Cancel" : "Deny",
      description:
        typeof msg.message === "string"
          ? msg.message
          : "The runtime requests confirmation.",
      fields: Array.isArray(msg.fields) ? msg.fields : [],
    };
    return [
      providerEvent,
      {
        type: "confirmation_required",
        payload: {
          requestId,
          action,
          sessionId,
        },
      },
    ];
  }

  if (type === "confirmation_resolved") {
    const requestId =
      (typeof msg.requestId === "string" && msg.requestId.trim()) ||
      (typeof msg.request_id === "string" && msg.request_id.trim()) ||
      "";
    if (!requestId) {
      return [providerEvent];
    }
    return [
      providerEvent,
      {
        type: "confirmation_resolved",
        payload: {
          requestId,
          approved: Boolean(msg.approved),
          actionId: typeof msg.actionId === "string" ? msg.actionId : undefined,
          data: msg.data,
          sessionId,
        },
      },
    ];
  }

  if (type === "assistant") {
    const events: ProviderEvent[] = [providerEvent];
    const message = asRecord(msg.message) as MessageContainer;
    const contentBlocks = Array.isArray(message.content) ? message.content : [];
    const parentToolUseId =
      typeof msg.parent_tool_use_id === "string" &&
      msg.parent_tool_use_id.trim()
        ? msg.parent_tool_use_id.trim()
        : null;
    const usageEvent =
      parentToolUseId === null
        ? normalizeUsagePayload({
            usage: message.usage,
            sessionId,
            includeOutputTokens: true,
          })
        : null;
    if (usageEvent) {
      events.push(usageEvent);
    }
    for (const block of contentBlocks) {
      if (block.type === "text" && typeof block.text === "string") {
        events.push({
          type: "message_delta",
          payload: {
            delta: block.text,
            sessionId,
            source: "assistant",
          },
        });
      }
      // The finished assistant message is the one place a tool call arrives
      // with its arguments (a streamed block starts with empty input), so
      // the trace can say which file was read or what a command was for.
      if (block.type === "tool_use") {
        events.push({
          type: "tool_call",
          payload: {
            id: typeof block.id === "string" ? block.id : undefined,
            name: typeof block.name === "string" ? block.name : undefined,
            input: block.input,
            sessionId,
          },
        });
      }
      if (
        block.type === "tool_use" &&
        (block.name === "ExitPlanMode" ||
          block.name === "TodoWrite" ||
          block.name === "TaskCreate" ||
          block.name === "TaskUpdate")
      ) {
        events.push({
          type: "provider_event",
          payload: {
            providerType:
              block.name === "ExitPlanMode"
                ? "claude_plan"
                : "claude_task_progress",
            sessionId,
            payload: {
              toolUseId: block.id,
              toolName: block.name,
              input: block.input,
              ready: block.name === "ExitPlanMode",
            },
          },
        });
      }
    }

    if (events.length === 0) {
      events.push({
        type: "status",
        payload: {
          phase: "assistant",
          sessionId,
        },
      });
    }

    return events;
  }

  if (type === "user") {
    const events: ProviderEvent[] = [providerEvent];
    const message = asRecord(msg.message) as MessageContainer;
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === "tool_result") {
        events.push({
          type: "tool_result",
          payload: {
            toolUseId: block.tool_use_id,
            content: normalizeToolResultContent(block.content),
            sessionId,
          },
        });
      }
    }

    if (events.length > 1) {
      return events;
    }
    return [providerEvent];
  }

  if (type === "result") {
    const output = extractResultOutput(msg);
    const events: ProviderEvent[] = [providerEvent];
    const contextWindowEvent = normalizeContextWindowPayload({
      modelUsage: asRecord(msg.modelUsage) as
        | Record<string, ModelUsageEntry>
        | undefined,
      sessionId,
    });
    if (contextWindowEvent) {
      events.push(contextWindowEvent);
    }
    events.push({
      type: "final",
      payload: {
        output,
        isError: Boolean(msg.is_error),
        subtype: msg.subtype,
        durationMs: msg.duration_ms,
        numTurns: msg.num_turns,
        sessionId,
      },
    });
    return events;
  }

  if (type === "system") {
    const subtype = typeof msg.subtype === "string" ? msg.subtype.trim() : "";
    if (subtype === "compact_boundary") {
      return [
        providerEvent,
        {
          type: "context_compacted",
          payload: {
            automatic: false,
            phase: "system",
            subtype,
            sessionId,
          },
        },
      ];
    }
    // Only the system messages a reader can act on become status lines.
    // Everything else ("thinking_tokens", "status", "session_state_changed",
    // ...) is Claude Code's own bookkeeping and stays a provider event.
    if (!READER_FACING_SYSTEM_SUBTYPES.has(subtype)) return [providerEvent];
    const text =
      subtype === "hook_started"
        ? `Running ${typeof msg.hook_name === "string" && msg.hook_name.trim() ? msg.hook_name.trim() : "runtime hook"}`
        : subtype === "hook_response"
          ? `Finished ${typeof msg.hook_name === "string" && msg.hook_name.trim() ? msg.hook_name.trim() : "runtime hook"}`
          : subtype === "init"
            ? "Initializing Claude session"
            : formatApiRetryStatus(msg);
    return [
      providerEvent,
      {
        type: "status",
        payload: {
          text,
          phase: "system",
          subtype,
          sessionId,
        },
      },
    ];
  }

  if (type === "tool_progress") {
    return [
      providerEvent,
      {
        type: "status",
        payload: {
          phase: "tool_progress",
          ...msg,
          sessionId,
        },
      },
    ];
  }

  if (type === "stream_event") {
    const event = asRecord(msg.event);
    if (event.type === "message_delta") {
      const usageEvent = normalizeUsagePayload({
        usage: asRecord(event.usage),
        sessionId,
        includeOutputTokens: true,
      });
      return usageEvent ? [providerEvent, usageEvent] : [providerEvent];
    }
    if (event.type === "content_block_delta") {
      const delta = asRecord(event.delta);
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        return [
          providerEvent,
          {
            type: "message_delta",
            payload: {
              delta: delta.text,
              partial: true,
              sessionId,
            },
          },
        ];
      }
      if (delta.type === "thinking_delta") {
        const thinking =
          typeof delta.thinking === "string" ? delta.thinking : "";
        if (thinking) {
          return [
            providerEvent,
            {
              type: "reasoning",
              payload: {
                round: 1,
                details: thinking,
                sessionId,
              },
            },
          ];
        }
      }
    }
  }

  return [providerEvent];
}
