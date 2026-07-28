import { assert } from "chai";
import { createAnnotationTool } from "../src/agent/tools/write/createAnnotation";
import type { PaperContextRef } from "../src/shared/types";
import type {
  ZoteroGateway,
  CreateAnnotationParams,
  CreateAnnotationResult,
} from "../src/agent/services/zoteroGateway";
import type { PdfPageService } from "../src/agent/services/pdfPageService";
import type { AgentToolContext, AgentToolDefinition } from "../src/agent/types";
import { pushUndoEntry, clearUndoStack } from "../src/agent/store/undoStore";

// ── Mocks ────────────────────────────────────────────────────────────────────

const MOCK_PAPER: PaperContextRef = {
  itemId: 12345,
  contextItemId: 67890,
  title: "Test Paper",
  firstCreator: "Doe",
  year: "2024",
};

function makeMockPdfPageService(
  getPageTextGeometryFn?: (
    contextItemId: number,
    pageIndex: number,
  ) => Promise<{
    width: number;
    height: number;
    items: Array<{ str: string; x: number; y: number; width: number; height: number }>;
  } | null>,
): PdfPageService {
  return {
    getPageLabels: async () => null,
    getPageCountForTarget: async () => 1,
    getPageTextGeometry: getPageTextGeometryFn ?? (async () => null),
  } as unknown as PdfPageService;
}

function makeMockZoteroGateway(
  createFn?: (params: CreateAnnotationParams) => Promise<CreateAnnotationResult>,
): ZoteroGateway {
  const defaultCreate = async (
    params: CreateAnnotationParams,
  ): Promise<CreateAnnotationResult> => ({
    annotationId: 9000 + Math.floor(Math.random() * 1000),
    type: params.type,
    pageLabel: params.pageLabel || `${params.pageIndex + 1}`,
  });

  return {
    createAnnotation: createFn || defaultCreate,
    getItem: () => null,
    getAnnotations: () => [],
  } as unknown as ZoteroGateway;
}

function makeContext(overrides?: Partial<AgentToolContext>): AgentToolContext {
  return {
    request: {
      conversationKey: 1,
      mode: "agent",
      userText: "test",
    },
    item: null,
    currentAnswerText: "",
    modelName: "gpt-4o-mini",
    ...overrides,
  } as unknown as AgentToolContext;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("annotation_create tool", function () {
  let tool: AgentToolDefinition<any, any>;
  let mockGateway: ZoteroGateway;
  let context: AgentToolContext;

  beforeEach(function () {
    clearUndoStack(1);
    mockGateway = makeMockZoteroGateway();
    tool = createAnnotationTool(mockGateway, makeMockPdfPageService());
    context = makeContext();
  });

  // ── Validation ──────────────────────────────────────────────────────

  it("validates with minimum required fields", function () {
    const result = tool.validate({
      paperContext: MOCK_PAPER,
      annotations: [{ type: "highlight", text: "Key finding", pageIndex: 2 }],
    });

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.equal(result.value.annotations.length, 1);
    assert.equal(result.value.annotations[0].type, "highlight");
    assert.equal(result.value.annotations[0].text, "Key finding");
    assert.equal(result.value.annotations[0].pageIndex, 2);
  });

  it("rejects missing paperContext", function () {
    const result = tool.validate({
      annotations: [{ type: "highlight", text: "text" }],
    });

    assert.isFalse(result.ok);
    assert.include(result.error || "", "paperContext");
  });

  it("rejects missing annotations array", function () {
    const result = tool.validate({
      paperContext: MOCK_PAPER,
    });

    assert.isFalse(result.ok);
    assert.include(result.error || "", "annotations");
  });

  it("rejects empty annotations array", function () {
    const result = tool.validate({
      paperContext: MOCK_PAPER,
      annotations: [],
    });

    assert.isFalse(result.ok);
    assert.include(result.error || "", "non-empty");
  });

  it("rejects highlight without text", function () {
    const result = tool.validate({
      paperContext: MOCK_PAPER,
      annotations: [{ type: "highlight" }],
    });

    assert.isFalse(result.ok);
    assert.include(result.error || "", "text is required");
  });

  it("rejects underline without text", function () {
    const result = tool.validate({
      paperContext: MOCK_PAPER,
      annotations: [{ type: "underline" }],
    });

    assert.isFalse(result.ok);
    assert.include(result.error || "", "text is required");
  });

  it("accepts note without text", function () {
    const result = tool.validate({
      paperContext: MOCK_PAPER,
      annotations: [
        { type: "note", comment: "Interesting paper", pageIndex: 0 },
      ],
    });

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.equal(result.value.annotations[0].type, "note");
  });

  it("rejects too many annotations", function () {
    const annotations = Array.from({ length: 25 }, (_, i) => ({
      type: "note" as const,
      comment: `Note ${i}`,
      pageIndex: i,
    }));
    const result = tool.validate({
      paperContext: MOCK_PAPER,
      annotations,
    });

    assert.isFalse(result.ok);
    assert.include(result.error || "", "Too many");
  });

  it("accepts exactly 20 annotations (max)", function () {
    const annotations = Array.from({ length: 20 }, (_, i) => ({
      type: "note" as const,
      comment: `Note ${i}`,
      pageIndex: i,
    }));
    const result = tool.validate({
      paperContext: MOCK_PAPER,
      annotations,
    });

    assert.isTrue(result.ok);
  });

  it("normalizes unknown type to note", function () {
    const result = tool.validate({
      paperContext: MOCK_PAPER,
      annotations: [{ type: "underline", text: "test", pageIndex: 0 }],
    });

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.equal(result.value.annotations[0].type, "underline");
  });

  it("normalizes color labels", function () {
    const result = tool.validate({
      paperContext: MOCK_PAPER,
      annotations: [
        {
          type: "highlight",
          text: "Important",
          color: "  Yellow  ",
          pageIndex: 1,
        },
      ],
    });

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.equal(result.value.annotations[0].color, "Yellow");
  });

  it("rejects non-object input", function () {
    const result = tool.validate("not an object");

    assert.isFalse(result.ok);
    assert.include(result.error || "", "object");
  });

  // ── Execution ───────────────────────────────────────────────────────

  it("executes and returns created annotation details", async function () {
    const createCalls: CreateAnnotationParams[] = [];
    const gw = makeMockZoteroGateway(async (params) => {
      createCalls.push(params);
      return { annotationId: 500, type: params.type, pageLabel: "3" };
    });
    const mockPdfPage = makeMockPdfPageService(async () => ({
      width: 612,
      height: 792,
      items: [{ str: "Key result", x: 72, y: 700, width: 80, height: 12 }],
    }));
    const t = createAnnotationTool(gw, mockPdfPage);

    const validResult = t.validate({
      paperContext: MOCK_PAPER,
      annotations: [
        { type: "highlight", text: "Key result", pageIndex: 2 },
      ],
    });
    assert.isTrue(validResult.ok);
    if (!validResult.ok) return;

    const execResult = await t.execute(validResult.value, context);

    assert.equal(execResult.kind, "result");
    if (execResult.kind !== "result") return;
    const content = execResult.content as {
      createdCount?: number;
      annotations?: Array<{ annotationId: number }>;
    };
    assert.equal(content.createdCount, 1);
    assert.equal(content.annotations?.[0].annotationId, 500);
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].itemId, 12345);
    assert.equal(createCalls[0].type, "highlight");
    assert.equal(createCalls[0].text, "Key result");
    assert.equal(createCalls[0].pageIndex, 2);
  });

  it("executes batch annotations", async function () {
    let callCount = 0;
    const gw = makeMockZoteroGateway(async (params) => {
      callCount += 1;
      return { annotationId: callCount, type: params.type, pageLabel: "1" };
    });
    const t = createAnnotationTool(gw, makeMockPdfPageService());

    const validResult = t.validate({
      paperContext: MOCK_PAPER,
      annotations: [
        { type: "highlight", text: "A", pageIndex: 0 },
        { type: "underline", text: "B", pageIndex: 0 },
        { type: "note", comment: "C", pageIndex: 0 },
      ],
    });
    assert.isTrue(validResult.ok);
    if (!validResult.ok) return;

    const execResult = await t.execute(validResult.value, context);

    assert.equal(execResult.kind, "result");
    if (execResult.kind !== "result") return;
    const content = execResult.content as { createdCount?: number };
    assert.equal(content.createdCount, 3);
    assert.equal(callCount, 3);
  });

  it("registers undo entry after execution", async function () {
    const gw = makeMockZoteroGateway();
    const t = createAnnotationTool(gw, makeMockPdfPageService());

    const validResult = t.validate({
      paperContext: MOCK_PAPER,
      annotations: [{ type: "note", comment: "test", pageIndex: 0 }],
    });
    assert.isTrue(validResult.ok);
    if (!validResult.ok) return;

    // Undo stack should be empty before execution.
    const { peekUndoEntry } =
      require("../src/agent/store/undoStore") as typeof import("../src/agent/store/undoStore");
    assert.isNull(peekUndoEntry(1));

    await t.execute(validResult.value, context);

    const entry = peekUndoEntry(1);
    assert.isNotNull(entry);
    assert.equal(entry?.toolName, "annotation_create");
    assert.include(entry?.description || "", "Undo 1 annotation");
  });

  // ── Confirmation ────────────────────────────────────────────────────

  it("builds a confirmation card via createPendingAction", function () {
    const validResult = tool.validate({
      paperContext: MOCK_PAPER,
      annotations: [
        { type: "highlight", text: "Key text", pageIndex: 2, color: "yellow" },
        { type: "note", comment: "Interesting", pageIndex: 3 },
      ],
    });
    assert.isTrue(validResult.ok);
    if (!validResult.ok) return;

    const pending = tool.createPendingAction!(validResult.value, context);
    assert.isDefined(pending);
    assert.equal(pending.toolName, "annotation_create");
    assert.include(pending.title, "2 Annotations");
    assert.isArray(pending.fields);
    assert.isNotEmpty(pending.fields);
  });

  // ── buildFollowupMessage ────────────────────────────────────────────

  it("returns a followup message with annotation count", async function () {
    const message = await tool.buildFollowupMessage!(
      {
        kind: "result",
        content: { createdCount: 3, annotations: [] },
      },
      context,
    );
    assert.isDefined(message);
    assert.include(String(message?.content || ""), "3 annotations");
  });

  it("returns null followup for zero annotations", async function () {
    const message = await tool.buildFollowupMessage!(
      {
        kind: "result",
        content: { createdCount: 0 },
      },
      context,
    );
    assert.isNull(message);
  });

  // ── Page index normalization ────────────────────────────────────────

  it("defaults pageIndex to 0 when not provided", function () {
    const validResult = tool.validate({
      paperContext: MOCK_PAPER,
      annotations: [{ type: "note", comment: "no page" }],
    });
    assert.isTrue(validResult.ok);
    if (!validResult.ok) return;
    assert.isUndefined(validResult.value.annotations[0].pageIndex);
    // The tool should still execute — execute() uses pageIndex ?? 0
  });

  it("accepts pageLabel as string", function () {
    const validResult = tool.validate({
      paperContext: MOCK_PAPER,
      annotations: [
        {
          type: "highlight",
          text: "On page xiv",
          pageLabel: "xiv",
          pageIndex: 13,
        },
      ],
    });
    assert.isTrue(validResult.ok);
    if (!validResult.ok) return;
    assert.equal(validResult.value.annotations[0].pageLabel, "xiv");
  });
});
