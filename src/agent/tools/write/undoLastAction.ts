import type { AgentToolDefinition } from "../../types";
import { ok } from "../shared";
import { peekUndoEntry, popUndoEntry } from "../../store/undoStore";

type UndoLastActionInput = Record<string, never>;

export function createUndoLastActionTool(): AgentToolDefinition<
  UndoLastActionInput,
  unknown
> {
  return {
    spec: {
      name: "undo_last_action",
      description:
        "Undo the most recent write action performed by the agent in this conversation — e.g. applied tags, a metadata edit, moved papers, or a created collection. Each session keeps up to 10 undo entries.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      mutability: "write",
      requiresConfirmation: true,
    },
    presentation: {
      label: "Undo Last Action",
      summaries: {
        onCall: "Preparing to undo the last action",
        onPending: "Waiting for your confirmation to undo",
        onApproved: "Approval received - undoing the action",
        onDenied: "Undo cancelled",
        onSuccess: ({ content }) => {
          const description =
            content && typeof content === "object"
              ? String(
                  (content as { description?: unknown }).description || "",
                )
              : "";
          return description
            ? `Undone: ${description}`
            : "Last action undone successfully";
        },
      },
    },
    validate: (_args) => {
      return ok<UndoLastActionInput>({});
    },
    shouldRequireConfirmation: async (_input, context) => {
      return Boolean(peekUndoEntry(context.request.conversationKey));
    },
    createPendingAction: (_input, context) => {
      const entry = peekUndoEntry(context.request.conversationKey);
      return {
        toolName: "undo_last_action",
        title: entry ? "Confirm undo" : "Nothing to undo",
        description: entry ? entry.description : undefined,
        confirmLabel: "Undo",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "text" as const,
            id: "description",
            label: "Action to undo",
            value: entry ? entry.description : "There is nothing to undo.",
          },
        ],
      };
    },
    execute: async (_input, context) => {
      const entry = popUndoEntry(context.request.conversationKey);
      if (!entry) {
        throw new Error("Nothing to undo in this conversation");
      }
      await entry.revert();
      return {
        status: "undone",
        toolName: entry.toolName,
        description: entry.description,
      };
    },
  };
}
