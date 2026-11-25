/**
 * Where a chat request carries its document context: the paper text, the
 * retrieved snippets, the note text.
 *
 * It travels in the user channel, never the system channel (issue #497):
 *
 *  - Some gateways do not pass a client's system prompt on to the model, so
 *    a paper sent there never arrives.
 *  - A model that sees its own earlier "I have no paper" answers keeps
 *    repeating them when the paper sits before those answers. It recovers
 *    when the paper comes with the question, or when the question says where
 *    the paper is.
 *
 * A request is assembled in two steps. The message builder adds the context
 * as one separate entry, so the input cap can shorten or drop it by kind
 * rather than by its text. placeDocumentContext() then folds that entry into
 * a user message.
 */
import type {
  ChatMessage,
  ImageContent,
  MessageContent,
  TextContent,
} from "../shared/llm";

/** Opens the document context wherever it is sent. */
export const DOCUMENT_CONTEXT_LABEL = "Document Context:\n";

/**
 * Tells the model where the document context is when it is not in the
 * current message. It names the label, so it is true on every turn.
 */
export const DOCUMENT_CONTEXT_POINTER =
  '[The document context for this chat is attached earlier in this conversation, in the message that starts with "Document Context:".]';

/** A request message before placement; the document context is one of them. */
export type RequestMessage = ChatMessage & { kind?: "document_context" };

/** The text part that holds the document context in a placed request. */
export type DocumentContextPart = TextContent & { documentContext: true };

/**
 * "conversation": the same context is sent on every turn, such as a paper's
 * full text. It opens the first user message and stays there, so a provider
 * that caches a request's prefix reuses it; the current question points back
 * to it.
 *
 * "turn": the context was chosen for this question only, such as retrieved
 * snippets. It goes with the question.
 */
export type DocumentContextPlacement = "conversation" | "turn";

/** Placement for a context plan's assembly mode. */
export function documentContextPlacementFor(
  assemblyMode: "full" | "retrieval",
): DocumentContextPlacement {
  return assemblyMode === "full" ? "conversation" : "turn";
}

export function documentContextEntry(context: string): RequestMessage {
  return {
    role: "user",
    kind: "document_context",
    content: `${DOCUMENT_CONTEXT_LABEL}${context}`,
  };
}

export function isDocumentContextPart(
  part: TextContent | ImageContent,
): part is DocumentContextPart {
  return (
    part.type === "text" &&
    (part as Partial<DocumentContextPart>).documentContext === true
  );
}

function contentParts(content: MessageContent): (TextContent | ImageContent)[] {
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : content;
}

function withPointer(message: ChatMessage): ChatMessage {
  if (typeof message.content === "string") {
    return {
      role: message.role,
      content: `${DOCUMENT_CONTEXT_POINTER}\n\n${message.content}`,
    };
  }
  const textIndex = message.content.findIndex((part) => part.type === "text");
  if (textIndex < 0) {
    return {
      role: message.role,
      content: [
        { type: "text", text: DOCUMENT_CONTEXT_POINTER },
        ...message.content,
      ],
    };
  }
  return {
    role: message.role,
    content: message.content.map((part, index) =>
      index === textIndex && part.type === "text"
        ? { ...part, text: `${DOCUMENT_CONTEXT_POINTER}\n\n${part.text}` }
        : part,
    ),
  };
}

function findLastUserIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") return index;
  }
  return -1;
}

/** Folds the document context entry, if any, into a user message. */
export function placeDocumentContext(
  messages: RequestMessage[],
  placement: DocumentContextPlacement,
): ChatMessage[] {
  const entry = messages.find((message) => message.kind === "document_context");
  if (!entry) return messages;
  const rest: ChatMessage[] = messages.filter((message) => message !== entry);
  const documentPart: DocumentContextPart = {
    type: "text",
    text: typeof entry.content === "string" ? entry.content : "",
    documentContext: true,
  };
  const currentIndex = findLastUserIndex(rest);
  if (currentIndex < 0) {
    return [...rest, { role: "user", content: [documentPart] }];
  }
  const hostIndex =
    placement === "conversation"
      ? rest.findIndex((message) => message.role === "user")
      : currentIndex;
  return rest.map((message, index) => {
    if (index === hostIndex) {
      return {
        role: message.role,
        content: [documentPart, ...contentParts(message.content)],
      };
    }
    return index === currentIndex ? withPointer(message) : message;
  });
}
