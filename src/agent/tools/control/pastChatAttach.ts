import type {
  AgentToolContext,
  AgentToolDefinition,
  AgentToolInputValidation,
} from "../../types";
import type {
  AttachedConversationRef,
  ConversationSystem,
} from "../../../shared/types";
import { isEphemeralConversationKey } from "../../../shared/conversationKeySpace";
import { fail, ok } from "../shared";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import { resolveAgentPromptBudgetLimits } from "../../context/promptBudget";
import { normalizeAttachedConversationRefs } from "../../../services/context/normalizers";
import {
  PAST_CHAT_ATTACH_TOOL_NAME,
  PAST_CHAT_READ_TOOL_NAME,
  parsePastConversationId,
  pastConversationId,
} from "../../../services/pastConversations/pastConversationText";
import {
  defaultPastConversationSource,
  renderAgentPastChatMessageText,
  type PastConversationSource,
} from "../../../services/pastConversations/pastConversationLoader";
import { notifyPastChatAttached } from "../../../services/pastConversations/attachSink";

/**
 * past_chat_attach: adds a chat found by past_chat_search to the user's
 * current message, as if the user had picked it with "Add past conversation"
 * (the same chip), and returns its text.
 *
 * The reference carries via: "agent". The tool writes no store: it reports
 * the attach to the panel through the attach sink (attachSink.ts) and awaits
 * it, so the in-memory user message holds the chat before any later
 * whole-row write. Then the chat joins the turn's scope, so past_chat_read
 * can open it later in the same turn: the built-in runtime's calls share
 * context.request, and over MCP the server adds it to the scope token
 * (context.extendAttachedConversationScope).
 *
 * Every fact of the reference comes from the catalog row, never from the
 * input. Refused: no conversation or user message to add to (a standalone
 * MCP client, a fork's provisional scope), a temporary conversation, the
 * current conversation, a chat that is gone, from another library, or a web
 * chat, and a message that already holds three chats. A chat already in the
 * conversation's scope is not added again; its text is returned again.
 *
 * It changes only plugin state, so it is a control tool with a read-only
 * invocation plan (as submit_document). Over MCP no path is redacted, as for
 * past_chat_read.
 */

type PastChatAttachInput = { chat: string };

const NO_CONVERSATION =
  "Past chats can be added only in a conversation in Zotero. Ask the user to add it with / → Add past conversation.";
const TEMPORARY = "Past chats can be added only in a saved conversation.";
const CURRENT = "This is the current conversation.";
const NOT_FOUND =
  "No past chat with this id is in this library. Use an id from past_chat_search.";
const OTHER_LIBRARY = "Only past chats from this library can be added.";
const DELETED = "This past chat was deleted.";
const FULL =
  "This message already has 3 attached past chats. Ask the user to remove a chip, or to ask for this chat in a new message.";
const FAILED =
  "This past chat could not be added right now. Ask the user to add it with / → Add past conversation.";

function validatePastChatAttachInput(
  args: unknown,
): AgentToolInputValidation<PastChatAttachInput> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return fail(`${PAST_CHAT_ATTACH_TOOL_NAME} expects an object input`);
  }
  const record = args as Record<string, unknown>;
  const chat = typeof record.chat === "string" ? record.chat.trim() : "";
  if (!parsePastConversationId(chat)) {
    return fail(
      "chat must be the id of a chat from past_chat_search, such as upstream:123",
    );
  }
  return ok({ chat });
}

function resolveContextWindow(
  request: AgentToolContext["request"],
): number | undefined {
  try {
    return resolveAgentPromptBudgetLimits({
      model: request.model,
      inputTokenCap: request.advanced?.inputTokenCap,
      apiBase: request.apiBase,
      providerProtocol: request.providerProtocol,
      authMode: request.authMode,
      profileOverride: request.advanced?.profileOverride,
      outputTokenLimit: request.advanced?.outputTokenLimit,
    }).contextWindow;
  } catch {
    return undefined;
  }
}

/** Adds the chat to the turn's scope unless it is there already. */
function extendTurnScope(
  context: AgentToolContext,
  ref: AttachedConversationRef,
): void {
  const id = pastConversationId(ref);
  // Synchronous append-if-absent: parallel calls of one step share this
  // array, so none of them may replace it with a stale copy.
  const scope = (context.request.attachedConversationScope ||= []);
  if (!scope.some((entry) => pastConversationId(entry) === id)) {
    scope.push(ref);
  }
  context.extendAttachedConversationScope?.(ref);
}

async function executePastChatAttach(
  input: PastChatAttachInput,
  context: AgentToolContext,
  source: PastConversationSource,
): Promise<unknown> {
  const request = context.request;
  const target = parsePastConversationId(input.chat);
  if (!target) return { ok: false, chat: input.chat, error: NOT_FOUND };
  const refuse = (error: string, title?: string) => ({
    ok: false,
    chat: input.chat,
    ...(title ? { title } : {}),
    error,
  });
  const libraryID = Math.floor(Number(request.libraryID));
  const conversationKey = Math.floor(Number(request.conversationKey));
  const userMessageTimestamp = Math.floor(
    Number(request.metadata?.sourceMessageTimestamp),
  );
  if (!(libraryID > 0) || !(conversationKey > 0) || !(userMessageTimestamp > 0))
    return refuse(NO_CONVERSATION);
  if (isEphemeralConversationKey(conversationKey)) return refuse(TEMPORARY);
  const conversationSystem: ConversationSystem =
    context.conversationSystem || "upstream";
  if (
    target.system === conversationSystem &&
    target.conversationKey === conversationKey
  ) {
    return refuse(CURRENT);
  }
  if (isEphemeralConversationKey(target.conversationKey))
    return refuse(NOT_FOUND);
  const contextWindowTokens = resolveContextWindow(request);
  const render = (ref: AttachedConversationRef) =>
    renderAgentPastChatMessageText({
      conversationKey,
      userMessageTimestamp,
      refs: [ref],
      libraryID,
      contextWindowTokens,
      source,
    });

  const inScope = (request.attachedConversationScope || []).find(
    (ref) => pastConversationId(ref) === input.chat,
  );
  if (inScope) {
    return {
      ok: true,
      chat: input.chat,
      title: inScope.title,
      alreadyAttached: true,
      pastChat: await render(inScope),
      hint: "This chat was already attached in this conversation; nothing was added.",
    };
  }

  let ref: AttachedConversationRef | undefined;
  try {
    if (await source.isPendingDeletion(target.conversationKey))
      return refuse(DELETED);
    const entry = await source.getCatalogEntry(target);
    if (!entry || entry.webchatSession) return refuse(NOT_FOUND);
    if (entry.libraryID !== libraryID)
      return refuse(OTHER_LIBRARY, entry.title);
    ref = normalizeAttachedConversationRefs([
      {
        system: target.system,
        conversationKey: target.conversationKey,
        conversationID: entry.conversationID,
        title: entry.title?.replace(/\s+/g, " ").trim() || "Untitled chat",
        libraryID: entry.libraryID,
        kind: entry.kind,
        paperItemID: entry.paperItemID,
        via: "agent",
      },
    ])[0];
  } catch {
    return refuse(FAILED);
  }
  if (!ref) return refuse(FAILED);
  const outcome = await notifyPastChatAttached({
    conversationKey,
    conversationSystem,
    userMessageTimestamp,
    ref,
  });
  if (!outcome.ok) {
    return refuse(
      outcome.reason === "full"
        ? FULL
        : outcome.reason === "temporary"
          ? TEMPORARY
          : FAILED,
      ref.title,
    );
  }
  extendTurnScope(context, ref);
  return {
    ok: true,
    chat: input.chat,
    title: ref.title,
    attached: true,
    pastChat: await render(ref),
    hint: `Added: it shows as a chip on the user's message. Answer from it; open more of a long chat with ${PAST_CHAT_READ_TOOL_NAME}.`,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createPastChatAttachTool(
  source: PastConversationSource = defaultPastConversationSource,
): AgentToolDefinition<PastChatAttachInput, unknown> {
  return {
    spec: {
      name: PAST_CHAT_ATTACH_TOOL_NAME,
      description:
        "Add a chat from past_chat_search to this conversation (shown as a chip on the user's message); returns its text.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          chat: {
            type: "string",
            description: "Id from past_chat_search, such as upstream:123.",
          },
        },
        required: ["chat"],
      },
      executionClass: "control",
      workCategory: "retrieval",
    },
    validate: validatePastChatAttachInput,
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: [],
        effects: ["read"],
        reason:
          "Add a past chat the agent found to the user's message (plugin state only).",
      }),
    execute: (input, context) => executePastChatAttach(input, context, source),
    presentation: {
      label: "Add Past Chat",
      summaries: {
        onCall: "Adding past chat",
        onSuccess: ({ content }) => {
          const result = record(content);
          const title = String(result.title || "");
          if (result.ok !== true) return "Could not add past chat";
          return result.alreadyAttached
            ? `Past chat “${title}” is already attached`
            : `Added past chat “${title}”`;
        },
      },
    },
  };
}
