import { assert } from "chai";
import { createAnnotatePdfTool } from "../src/agent/tools/write/annotatePdf";
import { revertActions } from "../src/agent/services/changeReverter";
import {
  initAgentChangeJournal,
  listJournalActions,
} from "../src/agent/store/changeJournal";
import type { AgentToolContext } from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";
import {
  annotationMatchesPayload,
  stickyNotePosition,
} from "../src/services/pdf/pdfAnnotationState";

/**
 * Zotero's annotation contract has several edges that throw rather than
 * degrade — the type must be set before any other field, the colour regex is
 * case-sensitive lowercase, and the sort index is format-checked. Discovering
 * those at save time means the highlight is simply lost, so they are enforced
 * before anything is written.
 */
describe("annotate_pdf", function () {
  it("accepts a quoted passage without asking the model for PDF coordinates", function () {
    const tool = createAnnotatePdfTool({} as never);
    const result = tool.validate({
      attachmentId: 55,
      text: "Representational drift reflects the stability-plasticity trade-off.",
      comment: "Core conclusion",
    });
    assert.isTrue(result.ok, JSON.stringify(result));
    assert.deepEqual(tool.spec.inputSchema.required, ["attachmentId", "text"]);
  });
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

  const resolved = {
    text: "A Title",
    pageLabel: "3",
    sortIndex: "00002|000000|00050",
    position: { pageIndex: 2, rects: [[100, 730, 300, 742]] },
    source: { documentFingerprint: "fixture", startChar: 0, endChar: 7 },
  };
  const resolve = async () => resolved;
  const gateway = {
    getItem: (id: number) => ({
      id,
      isAttachment: () => id === 55,
      isPDFAttachment: () => id === 55,
      getAnnotations: () => [],
    }),
    trashItems: async () => ({ trashedCount: 1, items: [] }),
  } as never;

  const validArgs = {
    attachmentId: 55,
    pageIndex: 2,
    color: "red",
    text: "A Title",
    comment: "Summary of the paper.",
  };

  it("writes a well-formed annotation with the type set first", async function () {
    const saved = install();
    const tool = createAnnotatePdfTool(gateway, resolve);
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
      isPDFAttachment: () => true,
      getAnnotations: () => [],
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
    const tool = createAnnotatePdfTool(gateway, resolve);
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
    const tool = createAnnotatePdfTool(gateway, resolve);
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
    assert.include(message, "not a PDF attachment");
    assert.include(
      message,
      "attachments",
      "the message must say how to find it",
    );
  });

  it("rejects a colour Zotero would throw on rather than losing the highlight", function () {
    const tool = createAnnotatePdfTool(gateway, resolve);
    const result = tool.validate({ ...validArgs, color: "crimson" });
    assert.isFalse(result.ok);
  });

  it("rejects raw coordinates and invalid page/occurrence selectors", function () {
    const tool = createAnnotatePdfTool(gateway, resolve);
    for (const args of [
      { ...validArgs, rects: [[1, 2, 3, 4]] },
      { ...validArgs, pageIndex: 1.2 },
      { ...validArgs, occurrence: 0 },
      { attachmentId: 55, text: "A Title", occurrence: 2 },
    ])
      assert.isFalse(tool.validate(args).ok);
  });

  it("does not save when native resolution fails", async function () {
    const saved = install();
    const tool = createAnnotatePdfTool(gateway, async () => {
      throw new Error("No matching passage");
    });
    const input = tool.validate(validArgs);
    if (!input.ok) assert.fail(input.error);
    try {
      await tool.execute(input.value, context);
      assert.fail("expected refusal");
    } catch (error) {
      assert.include(String(error), "No matching passage");
    }
    assert.isEmpty(saved);
  });

  it("reuses an identical native annotation on retry", async function () {
    const saved = install();
    const existing = {
      id: 900,
      parentID: 55,
      isAnnotation: () => true,
      annotationType: "highlight",
      annotationText: resolved.text,
      annotationComment: validArgs.comment,
      annotationColor: "#ff6666",
      annotationPageLabel: resolved.pageLabel,
      annotationSortIndex: resolved.sortIndex,
      annotationPosition: JSON.stringify(resolved.position),
    };
    const tool = createAnnotatePdfTool(
      {
        getItem: () => ({
          id: 55,
          isAttachment: () => true,
          isPDFAttachment: () => true,
          getAnnotations: () => [existing],
        }),
      } as never,
      resolve,
    );
    const input = tool.validate(validArgs);
    if (!input.ok) assert.fail(input.error);
    const result = (await tool.execute(input.value, context)) as any;
    assert.equal(result.content.status, "already_exists");
    assert.equal(result.effect, "none");
    assert.isEmpty(saved);
  });

  it("writes an underline over the same lines a highlight would cover", async function () {
    const saved = install();
    const tool = createAnnotatePdfTool(gateway, resolve);
    const validated = tool.validate({
      ...validArgs,
      annotationType: "underline",
    });
    if (!validated.ok) assert.fail(validated.error);
    const result = (await tool.execute(validated.value, context)) as any;
    assert.equal(saved[0].type, "underline");
    assert.equal(saved[0].text, "A Title");
    assert.deepEqual(saved[0].position, resolved.position);
    assert.equal(result.content.expectedAnnotation.type, "underline");
  });

  it("puts a sticky note as one 22-point square at the passage's first line, with no text", async function () {
    const saved = install();
    const tool = createAnnotatePdfTool(gateway, async () => ({
      ...resolved,
      position: {
        pageIndex: 2,
        rects: [
          [100, 730, 300, 742],
          [100, 716, 250, 728],
        ],
      },
    }));
    const validated = tool.validate({
      attachmentId: 55,
      text: "A Title",
      annotationType: "note",
      comment: "Check this claim.",
    });
    if (!validated.ok) assert.fail(validated.error);
    await tool.execute(validated.value, context);
    const json = saved[0];
    assert.equal(json.type, "note");
    assert.notProperty(json, "text", "Zotero refuses text on a note");
    assert.deepEqual(json.position, {
      pageIndex: 2,
      rects: [[100, 730, 122, 752]],
    });
    assert.equal(json.comment, "Check this claim.");
  });

  it("asks for the comment a sticky note would show", function () {
    const tool = createAnnotatePdfTool(gateway, resolve);
    assert.isFalse(
      tool.validate({
        attachmentId: 55,
        text: "A Title",
        annotationType: "note",
      }).ok,
    );
    assert.isFalse(
      tool.validate({ ...validArgs, annotationType: "ink" }).ok,
      "image and ink annotations are not offered",
    );
  });

  it("does not reuse a highlight at the passage when an underline was asked for", async function () {
    const saved = install();
    const highlight = {
      id: 900,
      parentID: 55,
      isAnnotation: () => true,
      annotationType: "highlight",
      annotationText: resolved.text,
      annotationComment: validArgs.comment,
      annotationColor: "#ff6666",
      annotationPageLabel: resolved.pageLabel,
      annotationSortIndex: resolved.sortIndex,
      annotationPosition: JSON.stringify(resolved.position),
    };
    const tool = createAnnotatePdfTool(
      {
        getItem: () => ({
          id: 55,
          isAttachment: () => true,
          isPDFAttachment: () => true,
          getAnnotations: () => [highlight],
        }),
      } as never,
      resolve,
    );
    const input = tool.validate({ ...validArgs, annotationType: "underline" });
    if (!input.ok) assert.fail(input.error);
    const result = (await tool.execute(input.value, context)) as any;
    assert.notEqual(result.content?.status, "already_exists");
    assert.lengthOf(saved, 1);
  });

  it("honours an edited comment from the confirmation card", function () {
    const tool = createAnnotatePdfTool(gateway, resolve);
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

  describe("a host-supplied reader selection (Inline Ask)", function () {
    // Zotero's own selection draft: rects with the reader's full precision.
    const selection = {
      pageIndex: 2,
      rects: [
        [100.123456, 730.5, 300.987654, 742.25],
        [100.123456, 716.5, 250.5, 728.25],
      ],
      sortIndex: "00002|000123|00049",
      pageLabel: "iii",
      text: "A Title spans two lines",
    };
    const hostArgs = {
      attachmentId: 55,
      text: selection.text,
      color: "#5fb236",
      comment: "Edited comment",
      selection,
    };
    // The card's Save: an action built the call from the action UI.
    const hostContext: AgentToolContext = {
      ...context,
      request: { ...context.request, actionEntryPoint: "action_ui" },
      hostAction: true,
    };
    // An action run inside a model turn: the executor marks it hostAction
    // too, but its entry point is the conversation.
    const modelTurnActionContext: AgentToolContext = {
      ...context,
      request: { ...context.request, actionEntryPoint: "conversation" },
      hostAction: true,
    };

    function validated(args: Record<string, unknown>) {
      const tool = createAnnotatePdfTool(gateway, resolve, () => "fp-1");
      const result = tool.validate(args);
      if (!result.ok) assert.fail(result.error);
      return { tool, input: result.value };
    }

    it("is admitted by validate and pins the page, but stays out of the model's schema", function () {
      const { tool, input } = validated(hostArgs);
      assert.equal(input.pageIndex, 2);
      assert.deepEqual(input.selection, selection);
      assert.notProperty(
        tool.spec.inputSchema.properties as Record<string, unknown>,
        "selection",
      );
    });

    it("rejects a malformed selection", function () {
      const tool = createAnnotatePdfTool(gateway, resolve);
      const bad: Array<[string, unknown]> = [
        ["fractional page", { ...selection, pageIndex: 1.5 }],
        ["negative page", { ...selection, pageIndex: -1 }],
        ["no rects", { ...selection, rects: [] }],
        ["short rect", { ...selection, rects: [[1, 2, 3]] }],
        ["non-finite rect", { ...selection, rects: [[1, 2, 3, Infinity]] }],
        ["string rect", { ...selection, rects: [["1", 2, 3, 4]] }],
        ["numeric sortIndex", { ...selection, sortIndex: 12 }],
        ["other text", { ...selection, text: "Something else" }],
        ["cross-page", { ...selection, nextPageRects: [[1, 2, 3, 4]] }],
        ["not an object", "page 2"],
      ];
      for (const [label, value] of bad)
        assert.isFalse(
          tool.validate({ ...hostArgs, selection: value }).ok,
          label,
        );
      assert.isFalse(
        tool.validate({ ...hostArgs, pageIndex: 1 }).ok,
        "a pageIndex that disagrees with the selection",
      );
      assert.isFalse(
        tool.validate({ ...hostArgs, pageIndex: 2, occurrence: 1 }).ok,
        "occurrence means nothing for a selection",
      );
      assert.isFalse(
        tool.validate({ ...hostArgs, annotationType: "note" }).ok,
        "a sticky note does not cover the selection's rects",
      );
    });

    it("is refused in planInvocation unless the host built the call", async function () {
      const { tool, input } = validated(hostArgs);
      let message = "";
      try {
        await tool.planInvocation!(input, context);
      } catch (error) {
        message = String(error);
      }
      assert.include(message, "selection");
      const plan = await tool.planInvocation!(input, hostContext);
      assert.equal(plan.impact, "state_change");
      // A model call without a selection plans as before.
      const plain = tool.validate(validArgs);
      if (!plain.ok) assert.fail(plain.error);
      assert.equal(
        (await tool.planInvocation!(plain.value, context)).impact,
        "state_change",
      );
    });

    it("is refused again in execute unless the host built the call", async function () {
      const saved = install();
      const { tool, input } = validated(hostArgs);
      let message = "";
      try {
        await tool.execute(input, context);
      } catch (error) {
        message = String(error);
      }
      assert.include(message, "selection");
      assert.isEmpty(saved);
    });

    it("writes the selection's rects, sort index and page label verbatim", async function () {
      const saved = install();
      let resolverCalls = 0;
      const tool = createAnnotatePdfTool(
        gateway,
        async () => {
          resolverCalls += 1;
          return resolved;
        },
        (attachmentId) => (attachmentId === 55 ? "fp-1" : ""),
      );
      const input = tool.validate(hostArgs);
      if (!input.ok) assert.fail(input.error);
      const result = (await tool.execute(input.value, hostContext)) as any;
      assert.equal(resolverCalls, 0, "the selection is not re-resolved");
      assert.lengthOf(saved, 1);
      assert.deepEqual(saved[0].position, {
        pageIndex: 2,
        rects: selection.rects,
      });
      assert.equal(saved[0].sortIndex, selection.sortIndex);
      assert.equal(saved[0].pageLabel, "iii");
      assert.equal(saved[0].text, selection.text);
      assert.equal(saved[0].color, "#5fb236");
      assert.equal(saved[0].comment, "Edited comment");
      const expected = result.content.expectedAnnotation;
      assert.equal(expected.source.documentFingerprint, "fp-1");
      assert.deepEqual(expected.position.rects, selection.rects);
    });

    it("refuses before writing when no open reader has the PDF", async function () {
      const saved = install();
      const tool = createAnnotatePdfTool(gateway, resolve, () => "");
      const input = tool.validate(hostArgs);
      if (!input.ok) assert.fail(input.error);
      let message = "";
      try {
        await tool.execute(input.value, hostContext);
      } catch (error) {
        message = String(error);
      }
      assert.include(message, "must be open in Zotero's reader");
      assert.isEmpty(saved, "nothing is written without a fingerprint");
    });

    it("is refused for an action that runs inside a model turn", async function () {
      const saved = install();
      const { tool, input } = validated(hostArgs);
      for (const run of [
        () => tool.planInvocation!(input, modelTurnActionContext),
        () => tool.execute(input, modelTurnActionContext),
      ]) {
        let message = "";
        try {
          await run();
        } catch (error) {
          message = String(error);
        }
        assert.include(message, "selection coordinates");
      }
      assert.isEmpty(saved);
    });

    it("describes the frozen rects for the receipt", async function () {
      const { tool, input } = validated(hostArgs);
      const [descriptor] = await tool.describeAction!(input, hostContext);
      assert.equal(descriptor.parameters?.pageIndex, 2);
      assert.deepEqual(descriptor.parameters?.expectedRects, selection.rects);
      const plain = tool.validate(validArgs);
      if (!plain.ok) assert.fail(plain.error);
      const [modelDescriptor] = await tool.describeAction!(plain.value);
      assert.notProperty(modelDescriptor.parameters || {}, "expectedRects");
    });
  });

  describe("annotation payloads by type", function () {
    const passage = {
      text: "A passage",
      pageLabel: "2",
      sortIndex: "00001|000010|00050",
      position: { pageIndex: 1, rects: [[50, 700, 300, 712]] },
      source: { documentFingerprint: "f", startChar: 10, endChar: 19 },
      color: "#ffd400",
      comment: "Why?",
    };
    const native = (fields: Record<string, unknown>) => ({
      parentID: 20,
      deleted: false,
      isAnnotation: () => true,
      annotationComment: "Why?",
      annotationColor: "#ffd400",
      annotationPageLabel: "2",
      annotationSortIndex: passage.sortIndex,
      ...fields,
    });

    it("matches a highlight by default and an underline only as an underline", function () {
      const lines = JSON.stringify(passage.position);
      const highlight = native({
        annotationType: "highlight",
        annotationText: "A passage",
        annotationPosition: lines,
      });
      assert.isTrue(annotationMatchesPayload(highlight, 20, passage));
      assert.isFalse(
        annotationMatchesPayload(highlight, 20, {
          ...passage,
          type: "underline",
        }),
      );
      assert.isTrue(
        annotationMatchesPayload(
          native({
            annotationType: "underline",
            annotationText: "A passage",
            annotationPosition: lines,
          }),
          20,
          { ...passage, type: "underline" },
        ),
      );
    });

    it("matches a sticky note by its square and no text", function () {
      const position = stickyNotePosition(passage.position);
      assert.deepEqual(position, {
        pageIndex: 1,
        rects: [[50, 700, 72, 722]],
      });
      const payload = { ...passage, position, type: "note" as const };
      assert.isTrue(
        annotationMatchesPayload(
          native({
            annotationType: "note",
            annotationText: null,
            annotationPosition: JSON.stringify(position),
          }),
          20,
          payload,
        ),
      );
      assert.isFalse(
        annotationMatchesPayload(
          native({
            annotationType: "note",
            annotationText: null,
            annotationPosition: JSON.stringify(passage.position),
          }),
          20,
          payload,
        ),
        "a note over the passage's lines is not the note square",
      );
    });
  });
});
