import { assert } from "chai";
import {
  createSearchLiteratureReviewAction,
  resolveSearchLiteratureReview,
} from "../src/agent/reviewCards";
import type {
  AgentConfirmationResolution,
  AgentToolContext,
  AgentToolResult,
} from "../src/agent/types";

const baseContext: AgentToolContext = {
  request: {
    conversationKey: 9,
    mode: "agent",
    userText: "find related papers",
    activeItemId: 55,
  },
  item: {
    getDisplayTitle: () => "Climer et al. (2025)",
  } as never,
  currentAnswerText: "",
  modelName: "gpt-5.4",
};

describe("reviewCards note drafts", function () {
  it("adds a diff preview for metadata note drafts", function () {
    const result: AgentToolResult = {
      callId: "call-1",
      name: "search_literature_online",
      ok: true,
      content: {
        mode: "metadata",
        results: [
          {
            source: "Crossref",
            title: "Climer metadata",
            authors: ["Alice Example"],
            year: 2025,
            doi: "10.1000/example",
          },
        ],
      },
    };

    const action = createSearchLiteratureReviewAction(result, baseContext, {});
    assert.exists(action);
    assert.deepEqual(
      action?.fields.map((field) => field.type),
      ["review_table", "select", "diff_preview", "textarea"],
    );
    const diffField = action?.fields[2] as Extract<
      NonNullable<typeof action>["fields"][number],
      { type: "diff_preview" }
    >;
    assert.equal(diffField.sourceFieldId, "noteContent");
    assert.deepEqual(diffField.visibleForActionIds, ["save_note"]);
  });

  it("adds a diff preview for paper-result note drafts", function () {
    const result: AgentToolResult = {
      callId: "call-1",
      name: "search_literature_online",
      ok: true,
      content: {
        mode: "recommendations",
        source: "OpenAlex",
        results: [
          {
            title: "Paper For Note",
            authors: ["Dana Example"],
            year: 2025,
            doi: "10.1000/note",
          },
        ],
      },
    };

    const action = createSearchLiteratureReviewAction(result, baseContext, {});
    assert.exists(action);
    assert.deepEqual(
      action?.fields.map((field) => field.type),
      [
        "paper_result_list",
        "diff_preview",
        "textarea",
        "text",
        "select",
        "text",
      ],
    );
    const diffField = action?.fields[1] as Extract<
      NonNullable<typeof action>["fields"][number],
      { type: "diff_preview" }
    >;
    assert.equal(diffField.sourceFieldId, "noteContent");
    assert.deepEqual(diffField.visibleForActionIds, ["save_note"]);
  });

  it("normalizes reviewed note content before invoking save_note", function () {
    const result: AgentToolResult = {
      callId: "call-1",
      name: "search_literature_online",
      ok: true,
      content: {
        mode: "metadata",
        results: [
          {
            source: "Crossref",
            title: "Climer metadata",
            authors: ["Alice Example"],
            year: 2025,
            doi: "10.1000/example",
          },
        ],
      },
    };
    const resolution: AgentConfirmationResolution = {
      approved: true,
      actionId: "save_note",
      data: {
        noteContent: "<h1>Summary</h1><p><strong>Key point</strong></p>",
      },
    };

    const next = resolveSearchLiteratureReview(
      {},
      result,
      resolution,
      baseContext,
    );

    assert.equal(next.kind, "invoke_tool");
    if (next.kind !== "invoke_tool") return;
    assert.equal(next.call.name, "edit_current_note");
    const args = next.call.arguments as {
      mode?: string;
      content?: string;
      target?: string;
    };
    assert.equal(args.mode, "create");
    assert.equal(args.content, "# Summary\n\n**Key point**");
    assert.equal(args.target, "item");
  });

  it("builds a metadata update mutation directly from the selected metadata source", function () {
    const result: AgentToolResult = {
      callId: "call-1",
      name: "search_literature_online",
      ok: true,
      content: {
        mode: "metadata",
        results: [
          {
            source: "Crossref",
            displayTitle: "Wrong Paper",
            patch: {
              title: "Wrong Paper",
              DOI: "10.1000/wrong",
              date: "2024",
              creators: [
                { creatorType: "author", name: "Other Author", fieldMode: 1 },
              ],
            },
          },
          {
            source: "Semantic Scholar",
            displayTitle: "Climer metadata",
            patch: {
              title: "Climer metadata",
              DOI: "10.1000/example",
              date: "2025",
              abstractNote: "Useful abstract",
              publicationTitle: "Journal of Tests",
              url: "https://doi.org/10.1000/example",
              creators: [
                { creatorType: "author", name: "Alice Example", fieldMode: 1 },
                { creatorType: "author", name: "Bob Example", fieldMode: 1 },
              ],
            },
          },
        ],
      },
    };

    const next = resolveSearchLiteratureReview(
      { itemId: 55, doi: "10.1000/example" },
      result,
      {
        approved: true,
        actionId: "review_changes",
        data: {
          selectedMetadataResult: "metadata-2",
        },
      },
      baseContext,
    );

    assert.equal(next.kind, "invoke_tool");
    if (next.kind !== "invoke_tool") return;
    assert.equal(next.call.name, "update_metadata");
    const args = next.call.arguments as {
      itemId?: number;
      metadata?: Record<string, unknown>;
    };
    assert.equal(args.itemId, 55);
    assert.equal(args.metadata?.title, "Climer metadata");
    assert.equal(args.metadata?.DOI, "10.1000/example");
    assert.equal(args.metadata?.publicationTitle, "Journal of Tests");
    assert.equal(args.metadata?.abstractNote, "Useful abstract");
  });
});
