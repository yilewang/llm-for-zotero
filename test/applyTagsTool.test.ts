import { assert } from "chai";
import { createApplyTagsTool } from "../src/agent/tools/write/applyTags";
import type { AgentToolContext } from "../src/agent/types";

describe("apply_tags tool", function () {
  const baseContext: AgentToolContext = {
    request: {
      conversationKey: 42,
      mode: "agent",
      userText: "tag these papers",
      activeItemId: 9,
      libraryID: 1,
    },
    item: null,
    currentAnswerText: "",
    modelName: "gpt-5.4",
  };

  const fakeGateway = {
    getPaperTargetsByItemIds: () => [
      {
        itemId: 7,
        title: "Paper Seven",
        firstCreator: "Dana Example",
        year: "2020",
        attachments: [{ contextItemId: 701, title: "Main PDF" }],
        tags: ["existing"],
        collectionIds: [12],
      },
    ],
  } as never;

  it("accepts empty starter assignments and renders an editable tag table", async function () {
    const tool = createApplyTagsTool(fakeGateway);

    const validated = tool.validate({
      action: "add",
      assignments: [{ itemId: 7, tags: [] }],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const pending = tool.createPendingAction?.(validated.value, baseContext);
    assert.exists(pending);
    const field = pending?.fields[0] as Extract<
      NonNullable<typeof pending>["fields"][number],
      { type: "tag_assignment_table" }
    >;
    assert.equal(field.type, "tag_assignment_table");
    assert.equal(field.label, "Suggested tags to add");
    assert.deepEqual(field.rows[0].value, []);
  });

  it("keeps pagination for a batch even when its last page contains one paper", function () {
    const tool = createApplyTagsTool(fakeGateway);
    for (const id of [
      "auto_tag:page:2:2:size:20:tags:5",
      "auto_tag:page:1:1:size:20:tags:5",
    ]) {
      const input = tool.validate({
        action: "add",
        id,
        assignments: id.includes("page:2")
          ? [{ itemId: 7, tags: ["memory"] }]
          : [
              { itemId: 7, tags: ["memory"] },
              { itemId: 8, tags: ["fmri"] },
            ],
      });
      assert.isTrue(input.ok);
      if (!input.ok) continue;
      const action = tool.createPendingAction!(input.value, baseContext);
      assert.isTrue(action.fields.some((field) => field.id === "pageSize"));
      assert.match(action.title, /^Page /);
    }
  });

  it("still rejects an all-empty tag submission", async function () {
    const tool = createApplyTagsTool(fakeGateway);

    const validated = tool.validate({
      action: "add",
      assignments: [{ itemId: 7, tags: [] }],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const rejected = tool.applyConfirmation?.(
      validated.value,
      {
        "tagAssignments:apply_tags": [{ id: "7", value: [] }],
      },
      baseContext,
    );
    assert.isFalse(rejected?.ok ?? true);
    if (rejected?.ok) return;
    assert.include(
      rejected?.error || "",
      "No tags were entered for any paper.",
    );
  });
});
