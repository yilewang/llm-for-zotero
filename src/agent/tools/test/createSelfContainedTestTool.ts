import type { AgentToolDefinition } from "../../types";
import { fail, ok, validateObject } from "../shared";
import { classifyRequest } from "../../model/requestClassifier";

type SelfContainedTestToolInput = {
  content: string;
  target?: string;
};

export function createSelfContainedTestTool(): AgentToolDefinition<
  SelfContainedTestToolInput,
  unknown
> {
  return {
    spec: {
      name: "self_contained_test_tool",
      description:
        "Test-only tool that exercises guidance, presentation, generic confirmation fields, and custom follow-up behavior.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          content: { type: "string" },
          target: { type: "string" },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },
    guidance: {
      matches: (request) => classifyRequest(request).isDemoToolQuery,
      instruction:
        "When the user asks for the self-contained demo tool, call self_contained_test_tool instead of answering directly.",
    },
    presentation: {
      label: "Self-Contained Demo",
      summaries: {
        onCall: "Running the self-contained demo tool",
        onPending: "Waiting for approval on the self-contained demo",
        onApproved: "Approval received - continuing the self-contained demo",
        onDenied: "Self-contained demo cancelled",
        onSuccess: "Completed the self-contained demo",
      },
      buildChips: () => [
        {
          icon: "◇",
          label: "Self-contained",
          title: "Custom chip from the tool definition",
        },
      ],
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      const content =
        typeof args.content === "string" && args.content.trim()
          ? args.content.trim()
          : "demo";
      const target =
        typeof args.target === "string" && args.target.trim()
          ? args.target.trim()
          : undefined;
      return ok({
        content,
        target,
      });
    },
    createPendingAction: (input) => ({
      toolName: "self_contained_test_tool",
      title: "Review self-contained demo",
      description: "This test-only action exercises every supported field type.",
      confirmLabel: "Apply",
      cancelLabel: "Cancel",
      fields: [
        {
          type: "textarea",
          id: "content",
          label: "Demo content",
          value: input.content,
        },
        {
          type: "text",
          id: "note",
          label: "Demo note",
          value: "demo note",
        },
        {
          type: "select",
          id: "target",
          label: "Demo target",
          value: input.target || "primary",
          options: [
            { id: "primary", label: "Primary" },
            { id: "secondary", label: "Secondary" },
          ],
        },
        {
          type: "checklist",
          id: "selectedItemIds",
          label: "Demo checklist",
          items: [
            {
              id: "demo-1",
              label: "Demo item 1",
              description: "Checklist example item",
              checked: true,
            },
            {
              id: "demo-2",
              label: "Demo item 2",
              checked: false,
            },
          ],
        },
        {
          type: "assignment_table",
          id: "assignments",
          label: "Demo assignment table",
          options: [
            { id: "__skip__", label: "Skip for now" },
            { id: "primary", label: "Primary" },
            { id: "secondary", label: "Secondary" },
          ],
          rows: [
            {
              id: "demo-1",
              label: "Demo paper 1",
              description: "Suggested destination is Primary",
              value: "primary",
              checked: true,
            },
            {
              id: "demo-2",
              label: "Demo paper 2",
              value: "__skip__",
              checked: false,
            },
          ],
        },
        {
          type: "tag_assignment_table",
          id: "tagAssignments",
          label: "Demo tag assignment table",
          rows: [
            {
              id: "demo-1",
              label: "Demo tag row 1",
              description: "Suggested tags can be edited here",
              value: "demo, sample",
            },
            {
              id: "demo-2",
              label: "Demo tag row 2",
              placeholder: "tag-one, tag-two",
            },
          ],
        },
        {
          type: "review_table",
          id: "review",
          rows: [
            {
              key: "content",
              label: "Content",
              before: "demo",
              after: input.content,
            },
          ],
        },
        {
          type: "image_gallery",
          id: "images",
          items: [
            {
              label: "Preview",
              storedPath: "/tmp/self-contained-demo.png",
              mimeType: "image/png",
              title: "Self-contained demo preview",
            },
          ],
        },
      ],
    }),
    applyConfirmation: (input, resolutionData) => {
      if (!validateObject<Record<string, unknown>>(resolutionData)) {
        return ok(input);
      }
      const content =
        typeof resolutionData.content === "string" &&
        resolutionData.content.trim()
          ? resolutionData.content.trim()
          : input.content;
      const target =
        typeof resolutionData.target === "string" &&
        resolutionData.target.trim()
          ? resolutionData.target.trim()
          : input.target;
      return ok({
        content,
        target,
      });
    },
    execute: async (input) => ({
      status: "ok",
      saved: input.content,
      target: input.target || "primary",
    }),
    buildFollowupMessage: async (result) => ({
      role: "user",
      content: [
        {
          type: "text",
          text: `Self-contained follow-up: ${JSON.stringify(result.content)}`,
        },
      ],
    }),
  };
}
