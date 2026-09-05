import { assert } from "chai";
import { createAnnotatePdfTool } from "../src/agent/tools/write/annotatePdf";
import { revertActions } from "../src/agent/services/changeReverter";
import {
  initAgentChangeJournal,
  listJournalActions,
} from "../src/agent/store/changeJournal";
import type { AgentToolContext } from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

/**
 * Zotero's annotation contract has several edges that throw rather than
 * degrade — the type must be set before any other field, the colour regex is
 * case-sensitive lowercase, and the sort index is format-checked. Discovering
 * those at save time means the highlight is simply lost, so they are enforced
 * before anything is written.
 */
describe("annotate_pdf", function () {
  const originalZotero = (
    globalThis as typeof globalThis & { Zotero?: unknown }
  ).Zotero;

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
  });

  const context: AgentToolContext = {
    request: {
      conversationKey: 2,
      mode: "agent",
      userText: "highlight",
      libraryID: 1,
    },
    item: null,
    currentAnswerText: "",
    modelName: "test",
    journalFallbackApproved: true,
  };

  function install() {
    const saved: Array<Record<string, unknown>> = [];
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Annotations: {
        saveFromJSON: async (
          _attachment: unknown,
          json: Record<string, unknown>,
        ) => {
          saved.push(json);
          return { id: 900 };
        },
      },
      DataObjectUtilities: { generateKey: () => "ABCD2345" },
      debug: () => undefined,
    };
    return saved;
  }

  const gateway = {
    getItem: (id: number) => ({ id, isAttachment: () => id === 55 }),
    trashItems: async () => ({ trashedCount: 1, items: [] }),
  } as never;

  const validArgs = {
    attachmentId: 55,
    pageIndex: 2,
    pageHeightPoints: 792,
    rects: [[100, 730, 300, 742]],
    color: "red",
    text: "A Title",
    comment: "Summary of the paper.",
  };

  it("writes a well-formed annotation with the type set first", async function () {
    const saved = install();
    const tool = createAnnotatePdfTool(gateway);
    const validated = tool.validate(validArgs);
    assert.isTrue(validated.ok, JSON.stringify(validated));
    if (!validated.ok) return;

    await tool.execute(validated.value, context);

    assert.lengthOf(saved, 1);
    const json = saved[0];
    const keys = Object.keys(json);
    assert.isBelow(
      keys.indexOf("type"),
      keys.indexOf("color"),
      "Zotero throws if any other annotation field is set before the type",
    );
    assert.equal(json.type, "highlight");
    assert.equal(json.color, "#ff6666", "the palette name resolved to hex");
    assert.match(String(json.sortIndex), /^\d{5}\|\d{6}\|\d{5}$/);
    assert.deepEqual(json.position, {
      pageIndex: 2,
      rects: [[100, 730, 300, 742]],
    });
    assert.equal(json.comment, "Summary of the paper.");
  });

  it("refuses durable undo after the created annotation was edited", async function () {
    const db = new ChangeJournalTestDb();
    const attachment = {
      id: 55,
      libraryID: 1,
      isAttachment: () => true,
    };
    let annotation: Record<string, any> | null = null;
    let trashCalls = 0;
    globalThis.Zotero = {
      DB: db,
      Annotations: {
        saveFromJSON: async (
          _target: unknown,
          json: Record<string, unknown>,
        ) => {
          annotation = {
            id: 900,
            libraryID: 1,
            parentID: 55,
            deleted: false,
            isAnnotation: () => true,
            annotationType: json.type,
            annotationText: json.text || "",
            annotationComment: json.comment || "",
            annotationColor: json.color || "",
            annotationPageLabel: json.pageLabel || "",
            annotationSortIndex: json.sortIndex || "",
            annotationPosition: json.position,
            getTags: () => [],
          };
          return annotation;
        },
      },
      DataObjectUtilities: { generateKey: () => "ABCD2345" },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const gateway = {
      getItem: (id: number) =>
        id === 55 ? attachment : id === 900 ? annotation : null,
      trashItems: async () => {
        trashCalls += 1;
        return {
          trashedCount: 1,
          items: [{ itemId: 900, status: "trashed" }],
        };
      },
    } as never;
    const journalContext: AgentToolContext = {
      ...context,
      journalFallbackApproved: undefined,
    };
    const tool = createAnnotatePdfTool(gateway);
    const validated = tool.validate(validArgs);
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    await tool.execute(validated.value, journalContext);
    const actions = await listJournalActions({
      conversationKey: 2,
      pendingOnly: true,
      limit: 10,
    });
    assert.lengthOf(actions, 1);
    const expected = JSON.parse(
      actions[0].steps[0].expectedPostconditionJson || "null",
    ) as { items?: Array<{ annotation?: { comment?: string } }> };
    assert.equal(
      expected.items?.[0]?.annotation?.comment,
      "Summary of the paper.",
    );

    if (!annotation) assert.fail("the annotation was not created");
    annotation.annotationComment = "User edited this comment";
    const outcome = await revertActions({
      actions,
      zoteroGateway: gateway,
      context: journalContext,
    });

    assert.equal(outcome.reverted, 0);
    assert.lengthOf(outcome.conflicts, 1);
    assert.equal(trashCalls, 0);
  });

  it("refuses a parent paper, since annotations belong to the attachment", async function () {
    install();
    const tool = createAnnotatePdfTool(gateway);
    const validated = tool.validate({ ...validArgs, attachmentId: 44 });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    let message = "";
    try {
      await tool.execute(validated.value, context);
      assert.fail("expected a refusal");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.include(message, "not an attachment");
    assert.include(
      message,
      "attachments",
      "the message must say how to find it",
    );
  });

  it("rejects a colour Zotero would throw on rather than losing the highlight", function () {
    const tool = createAnnotatePdfTool(gateway);
    const result = tool.validate({ ...validArgs, color: "crimson" });
    assert.isFalse(result.ok);
  });

  it("normalizes a rect whose corners were given the wrong way round", function () {
    const tool = createAnnotatePdfTool(gateway);
    const result = tool.validate({
      ...validArgs,
      rects: [[300, 742, 100, 730]],
    });
    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.deepEqual(
      result.value.rects,
      [[100, 730, 300, 742]],
      "an inverted rect would otherwise be an invisible highlight",
    );
  });

  it("merges runs on one line and keeps a wrapped title as two", function () {
    const tool = createAnnotatePdfTool(gateway);
    const result = tool.validate({
      ...validArgs,
      rects: [
        [100, 730, 200, 742],
        [205, 730, 300, 742],
        [100, 712, 220, 724],
      ],
    });
    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value.rects, [
      [100, 730, 300, 742],
      [100, 712, 220, 724],
    ]);
  });

  it("requires the page height, which places the highlight", function () {
    const tool = createAnnotatePdfTool(gateway);
    const result = tool.validate({ ...validArgs, pageHeightPoints: 0 });
    assert.isFalse(result.ok);
  });

  it("honours an edited comment from the confirmation card", function () {
    const tool = createAnnotatePdfTool(gateway);
    const validated = tool.validate(validArgs);
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    const applied = tool.applyConfirmation?.(validated.value, {
      comment: "A better summary.",
    });
    assert.isTrue(applied?.ok);
    if (!applied?.ok) return;
    assert.equal(
      (applied.value as { comment?: string }).comment,
      "A better summary.",
    );
  });
});
