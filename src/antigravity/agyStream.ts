import type { ChatMessage, MessageContent, UsageStats } from "../shared/llm";

/**
 * The Antigravity CLI's headless protocol (`agy --print --input-format
 * stream-json --output-format stream-json`): newline-delimited JSON on both
 * pipes. This module holds the pure half (prompt text in, events out) so it
 * can be tested without a subprocess.
 *
 * Output events, in order per turn: one `init`, any number of `step_update`,
 * one `result`. A step's `step_type` is a closed vocabulary; `agent_response`
 * steps stream the answer as `text_delta` fragments while ACTIVE, `tool`
 * steps carry `tool_name`/`tool_info`. The terminal `result` carries the
 * finished `response`, which is the answer of record.
 */

export type AgyUsage = {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
};

export type AgyEvent =
  | {
      kind: "init";
      conversationId: string;
      model?: string;
    }
  | {
      kind: "text";
      stepIndex: number;
      state: "ACTIVE" | "DONE" | string;
      delta: string;
    }
  | {
      kind: "tool";
      stepIndex: number;
      toolName: string;
      state: "ACTIVE" | "DONE" | string;
      summary?: string;
    }
  | {
      kind: "result";
      conversationId: string;
      status: string;
      response: string;
      error?: string;
      usage?: AgyUsage;
      deniedActions: string[];
    };

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finiteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The event's payload. Fields have been seen both at the top level
 * (`{"event":"init","conversation_id":...}`) and nested under a key named
 * after the event (`{"event":"result","result":{...}}`); accept either.
 */
function payloadOf(line: JsonRecord, event: string): JsonRecord {
  const nested = line[event];
  return isRecord(nested) ? { ...line, ...nested } : line;
}

function normalizeUsage(value: unknown): AgyUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: AgyUsage = {
    input_tokens: finiteNumber(value.input_tokens),
    output_tokens: finiteNumber(value.output_tokens),
    thinking_tokens: finiteNumber(value.thinking_tokens),
    cache_read_tokens: finiteNumber(value.cache_read_tokens),
    total_tokens: finiteNumber(value.total_tokens),
  };
  return Object.values(usage).some((n) => n !== undefined) ? usage : undefined;
}

function describeDeniedAction(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!isRecord(value)) return "";
  return (
    text(value.summary) ||
    text(value.action) ||
    text(value.tool_name) ||
    text(value.name)
  ).trim();
}

function summarizeToolInfo(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const summary = text(value.summary) || text(value.header);
  return summary.trim() || undefined;
}

/** Parse one stdout line. Lines that are not protocol events return null. */
export function parseAgyStreamLine(raw: string): AgyEvent | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  let line: JsonRecord;
  try {
    const parsed = JSON.parse(trimmed);
    if (!isRecord(parsed)) return null;
    line = parsed;
  } catch {
    return null;
  }
  const event = text(line.event) || text(line.type);
  if (event === "init") {
    const payload = payloadOf(line, "init");
    return {
      kind: "init",
      conversationId: text(payload.conversation_id).trim(),
      model: text(payload.model).trim() || undefined,
    };
  }
  if (event === "step_update") {
    const payload = payloadOf(line, "step_update");
    const stepType = text(payload.step_type);
    const stepIndex = finiteNumber(payload.step_index) ?? -1;
    if (stepType === "agent_response") {
      const delta = text(payload.text_delta);
      return delta
        ? {
            kind: "text",
            stepIndex,
            state: text(payload.state) || "ACTIVE",
            delta,
          }
        : null;
    }
    if (stepType === "tool") {
      const toolInfo = isRecord(payload.tool_info) ? payload.tool_info : {};
      const toolName =
        text(payload.tool_name).trim() ||
        text(toolInfo.name).trim() ||
        text(toolInfo.tool_name).trim() ||
        "tool";
      return {
        kind: "tool",
        stepIndex,
        toolName,
        state: text(payload.state) || "ACTIVE",
        summary: summarizeToolInfo(toolInfo),
      };
    }
    return null;
  }
  if (event === "result") {
    const payload = payloadOf(line, "result");
    const error = payload.error;
    return {
      kind: "result",
      conversationId: text(payload.conversation_id).trim(),
      status: text(payload.status).trim() || "UNKNOWN",
      response: text(payload.response),
      error: isRecord(error)
        ? text(error.message) || JSON.stringify(error)
        : text(error) || undefined,
      usage: normalizeUsage(payload.usage),
      deniedActions: Array.isArray(payload.denied_actions)
        ? payload.denied_actions.map(describeDeniedAction).filter(Boolean)
        : [],
    };
  }
  return null;
}

/**
 * Turns `agent_response` fragments into display deltas. ACTIVE updates carry
 * new text; a fragment that repeats the step's text so far (a cumulative
 * snapshot) contributes only its new tail. The DONE update restates the
 * step, so it is not shown again: the turn's `result.response` is the
 * answer of record.
 */
export class AgyTextAccumulator {
  private readonly textByStep = new Map<number, string>();
  private lastStep: number | null = null;

  push(stepIndex: number, fragment: string, state = "ACTIVE"): string {
    if (state === "DONE") return "";
    const previous = this.textByStep.get(stepIndex) || "";
    const delta =
      previous && fragment.startsWith(previous)
        ? fragment.slice(previous.length)
        : fragment;
    if (!delta) return "";
    // Separate consecutive answer steps (text before and after a tool call).
    const separator =
      !previous && this.lastStep !== null && this.lastStep !== stepIndex
        ? "\n\n"
        : "";
    this.textByStep.set(stepIndex, previous + delta);
    this.lastStep = stepIndex;
    return separator + delta;
  }

  text(): string {
    return [...this.textByStep.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, value]) => value)
      .join("\n\n");
  }
}

export function toUsageStats(usage: AgyUsage | undefined): UsageStats | null {
  if (!usage) return null;
  const promptTokens =
    (usage.input_tokens || 0) + (usage.cache_read_tokens || 0);
  const completionTokens =
    (usage.output_tokens || 0) + (usage.thinking_tokens || 0);
  const totalTokens = usage.total_tokens || promptTokens + completionTokens;
  if (!totalTokens) return null;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(usage.cache_read_tokens
      ? { cacheReadTokens: usage.cache_read_tokens }
      : {}),
  };
}

function contentText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      part.type === "text" ? part.text : "[An image was attached here.]",
    )
    .join("\n");
}

/**
 * Builds the text of one stdin `user` event from the plugin's prepared chat
 * messages (system context, history, the new question).
 *
 * A fresh agy conversation gets everything, the history as a transcript. A
 * resumed one already holds the history, so it gets the system context only
 * when that changed since the last turn, then the new question.
 */
export function buildAgyPrompt(params: {
  messages: ChatMessage[];
  resumed: boolean;
  includeSystem: boolean;
}): string {
  const { context, question } = splitAgyPrompt(params);
  return context
    ? `${context}\n\n<question>\n${question}\n</question>`
    : question;
}

/**
 * The turn's prompt in two parts: the instructions, paper text and earlier
 * conversation it carries (empty when there is none to send), and the
 * question itself.
 */
export function splitAgyPrompt(params: {
  messages: ChatMessage[];
  resumed: boolean;
  includeSystem: boolean;
}): { context: string; question: string } {
  const system = params.messages
    .filter((message) => message.role === "system")
    .map((message) => contentText(message.content).trim())
    .filter(Boolean);
  const dialogue = params.messages.filter(
    (message) => message.role !== "system",
  );
  const lastUserIndex = dialogue.map((m) => m.role).lastIndexOf("user");
  const question =
    lastUserIndex >= 0 ? contentText(dialogue[lastUserIndex].content) : "";
  const history = lastUserIndex >= 0 ? dialogue.slice(0, lastUserIndex) : [];

  const sections: string[] = [];
  if (params.includeSystem && system.length) {
    sections.push(
      [
        params.resumed ? "<updated_context>" : "<instructions_and_context>",
        system.join("\n\n"),
        params.resumed ? "</updated_context>" : "</instructions_and_context>",
      ].join("\n"),
    );
  }
  if (!params.resumed && history.length) {
    const transcript = history
      .map((message) => {
        const speaker = message.role === "assistant" ? "Assistant" : "User";
        return `${speaker}: ${contentText(message.content).trim()}`;
      })
      .join("\n\n");
    sections.push(
      ["<earlier_conversation>", transcript, "</earlier_conversation>"].join(
        "\n",
      ),
    );
  }
  return { context: sections.join("\n\n"), question };
}

/**
 * agy 1.4.2 silently cuts a stream-json user message at about 68k tokens,
 * keeping the head: a long paper loses its end and the question after it.
 * Prompts longer than this many characters (a CJK-heavy text can approach
 * a token per character) send their context as a file agy reads instead.
 */
export const AGY_INLINE_PROMPT_LIMIT = 50_000;

/** The inline message for a turn whose context is in `contextPath`. */
export function buildAgyFileContextPrompt(params: {
  question: string;
  contextPath: string;
  contextChars: number;
}): string {
  return [
    `<question>\n${params.question}\n</question>`,
    [
      "The instructions, paper text and earlier conversation for this question are too long to send inline, so they are in this file:",
      params.contextPath,
      `Read the whole file (${params.contextChars} characters, in parts if needed) with your file-reading tool before you answer. It is part of this message: follow its instructions and use its text, but do not edit it.`,
    ].join("\n"),
  ].join("\n\n");
}

/** A stable fingerprint of the system context, to resend it only on change. */
export function fingerprintSystemContext(messages: ChatMessage[]): string {
  const joined = messages
    .filter((message) => message.role === "system")
    .map((message) => contentText(message.content))
    .join("\u0000");
  let hash = 0x811c9dc5;
  for (let index = 0; index < joined.length; index += 1) {
    hash ^= joined.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${joined.length}:${hash.toString(16)}`;
}

/** The stdin line for one turn. */
export function encodeAgyUserEvent(prompt: string): string {
  return `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`;
}

/**
 * agy prints `AGY_ERROR: {...}` on stderr when a turn ends on a model or
 * agent failure. Returns its message, or the last meaningful stderr line.
 */
export function describeAgyFailure(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^AGY_ERROR:\s*(\{.*\})\s*$/.exec(lines[index]);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]) as JsonRecord;
      const message = text(parsed.message) || text(parsed.status);
      if (message) return message;
    } catch {
      /* fall through to the raw line */
    }
    return lines[index].replace(/^AGY_ERROR:\s*/, "");
  }
  return lines[lines.length - 1] || "";
}

/** True when agy refused to run because it has no saved Google sign-in. */
export function isAgyAuthenticationFailure(message: string): boolean {
  return /authenticat|sign[\s-]?in|log[\s-]?in|credential/i.test(message);
}
