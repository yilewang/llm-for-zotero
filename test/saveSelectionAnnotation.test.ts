import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import {
  isVerifiedAnnotationSave,
  saveSelectionAnnotation,
} from "../src/agent/actions/saveSelectionAnnotation";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createAnnotatePdfTool } from "../src/agent/tools/write/annotatePdf";
import type { AgentToolContext } from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

/**
 * Inline Ask's Save: the card's Save click is the user's confirmation of the
 * payload it shows. The call still goes through the tool registry, central
 * authorization and the change journal, and success is a verified receipt,
 * never the tool's own word.
 */
describe("saveSelectionAnnotation", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: unknown;
  };
  const originalZotero = globalScope.Zotero;
  const PERMISSION_PREF =
    "extensions.zotero.llmforzotero.originalAgentPermissionMode";

  const selection = {
    pageIndex: 1,
    rects: [
      [72.123456, 600.5, 300.25, 612.75],
      [72.123456, 586.5, 200.5, 598.75],
    ],
    sortIndex: "00001|000042|00179",
    pageLabel: "2",
    text: "Representational drift reflects plasticity",
  };

  type Harness = {
    saved: Array<Record<string, unknown>>;
    annotations: Array<Record<string, any>>;
    prefs: Map<string, unknown>;
    registry: AgentToolRegistry;
    gateway: any;
  };

  function nativeAnnotation(id: number, json: Record<string, unknown>) {
    return {
      id,
      libraryID: 1,
      parentID: 55,
      deleted: false,
      isAnnotation: () => true,
      isNote: () => false,
      isAttachment: () => false,
      annotationType: json.type,
      annotationText: json.text || "",
      annotationComment: json.comment || "",
      annotationColor: json.color || "",
      annotationPageLabel: json.pageLabel || "",
      annotationSortIndex: json.sortIndex || "",
      annotationPosition: JSON.stringify(json.position),
      getTags: () => [],
    };
  }

  async function setup(
    options: { fingerprint?: string; mode?: string } = {},
  ): Promise<Harness> {
    const saved: Array<Record<string, unknown>> = [];
    const annotations: Array<Record<string, any>> = [];
    const prefs = new Map<string, unknown>([
      [PERMISSION_PREF, options.mode ?? "auto"],
    ]);
    globalScope.Zotero = {
      DB: new ChangeJournalTestDb(),
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => prefs.set(key, value),
      },
      Annotations: {
        saveFromJSON: async (
          _attachment: unknown,
          json: Record<string, unknown>,
        ) => {
          saved.push(json);
          const annotation = nativeAnnotation(900 + saved.length, json);
          annotations.push(annotation);
          return annotation;
        },
      },
      DataObjectUtilities: { generateKey: () => "ABCD2345" },
      debug: () => undefined,
    };
    await initAgentChangeJournal();
    const attachment = {
      id: 55,
      libraryID: 1,
      deleted: false,
      isAttachment: () => true,
      isPDFAttachment: () => true,
      isNote: () => false,
      isAnnotation: () => false,
      getAnnotations: () => annotations.filter((a) => !a.deleted),
    };
    const gateway = {
      getItem: (id: number) =>
        id === 55 ? attachment : annotations.find((a) => a.id === id) || null,
      trashItems: async () => ({ trashedCount: 1, items: [] }),
    } as any;
    const registry = new AgentToolRegistry(new ActionContractService(gateway));
    registry.register(
      createAnnotatePdfTool(
        gateway,
        async () => {
          throw new Error("a host selection is never re-resolved");
        },
        () => options.fingerprint ?? "fp-open-reader",
      ),
    );
    return { saved, annotations, prefs, registry, gateway };
  }

  const request = {
    attachmentId: 55,
    libraryID: 1,
    conversationKey: 7001,
    selection,
    color: "#a28ae5",
    comment: "  Edited in the card.  ",
  };

  beforeEach(function () {
    globalScope.Zotero = originalZotero;
  });
  afterEach(function () {
    globalScope.Zotero = originalZotero;
  });

  for (const mode of ["safe", "auto", "yolo"]) {
    it(`runs from the card's confirmation in ${mode} mode and writes the frozen payload`, async function () {
      const harness = await setup({ mode });
      const confirmations: string[] = [];
      const outcome = await saveSelectionAnnotation(
        harness.registry,
        harness.gateway,
        request,
        { onConfirmation: (toolName) => confirmations.push(toolName) },
      );
      assert.deepEqual(
        confirmations,
        ["annotate_pdf"],
        "the forced review is resolved by the card's Save, once",
      );
      assert.isTrue(outcome.ok, JSON.stringify(outcome));
      if (!outcome.ok) return;
      assert.equal(outcome.status, "applied");
      assert.lengthOf(harness.saved, 1);
      const json = harness.saved[0];
      assert.equal(json.type, "highlight");
      assert.equal(json.color, "#a28ae5");
      assert.equal(json.comment, "Edited in the card.");
      assert.equal(json.text, selection.text);
      assert.equal(json.sortIndex, selection.sortIndex);
      assert.equal(json.pageLabel, "2");
      assert.deepEqual(json.position, {
        pageIndex: 1,
        rects: selection.rects,
      });
      const receipt = outcome.result.actionReceipts?.[0];
      assert.equal(receipt?.verification, "verified");
    });
  }

  it("credits a retry of the same payload without writing again", async function () {
    const harness = await setup();
    const first = await saveSelectionAnnotation(
      harness.registry,
      harness.gateway,
      request,
    );
    assert.isTrue(first.ok, JSON.stringify(first));
    const again = await saveSelectionAnnotation(
      harness.registry,
      harness.gateway,
      request,
    );
    assert.isTrue(again.ok, JSON.stringify(again));
    if (!again.ok) return;
    assert.equal(again.status, "already_satisfied");
    assert.lengthOf(harness.saved, 1);
  });

  it("reports an unverified receipt as a failure when no open reader has the PDF", async function () {
    const harness = await setup({ fingerprint: "" });
    const outcome = await saveSelectionAnnotation(
      harness.registry,
      harness.gateway,
      request,
    );
    assert.isFalse(outcome.ok);
    if (outcome.ok) return;
    assert.equal(
      outcome.result?.actionReceipts?.[0]?.verification,
      "unverified",
    );
    assert.isNotEmpty(outcome.error);
  });

  it("never files the change under conversation 0", async function () {
    const harness = await setup();
    let message = "";
    try {
      await saveSelectionAnnotation(harness.registry, harness.gateway, {
        ...request,
        conversationKey: 0,
      });
    } catch (error) {
      message = String(error);
    }
    assert.include(message, "conversation");
    assert.isEmpty(harness.saved);
  });

  it("is refused for a model call that carries a selection", async function () {
    const harness = await setup();
    const context: AgentToolContext = {
      request: resolvedAgentRequest({
        conversationKey: 7001,
        mode: "agent",
        userText: "highlight this",
        libraryID: 1,
        executionContext: {
          version: 1,
          executionId: "model-turn",
          conversationKey: 7001,
          conversationGeneration: 0,
          chatLibraryID: 1,
          permissionOwner: "original_agent",
          workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
          configuredAccess: { libraryIDs: [1], outputDirectories: [] },
        },
      }),
      item: null,
      currentAnswerText: "",
      modelName: "model",
      runId: "run-1",
    };
    const prepared = await harness.registry.prepareExecution(
      {
        id: "model-call",
        name: "annotate_pdf",
        arguments: {
          attachmentId: 55,
          text: selection.text,
          selection,
        },
      },
      context,
    );
    assert.equal(prepared.kind, "result");
    if (prepared.kind !== "result") return;
    assert.isFalse(prepared.execution.result.ok);
    assert.include(
      JSON.stringify(prepared.execution.result.content),
      "only the plugin's own reader actions may pass selection coordinates",
    );
    assert.isEmpty(harness.saved);
  });

  it("success needs ok, a verified receipt and an applied or already-satisfied status", function () {
    const receipt = (verification: string, status: string) =>
      ({ verification, status }) as any;
    const result = (ok: boolean, receipts: unknown[]) =>
      ({
        callId: "c",
        name: "annotate_pdf",
        ok,
        content: {},
        actionReceipts: receipts,
      }) as any;
    assert.isTrue(
      isVerifiedAnnotationSave(result(true, [receipt("verified", "applied")])),
    );
    assert.isTrue(
      isVerifiedAnnotationSave(
        result(true, [receipt("verified", "already_satisfied")]),
      ),
    );
    assert.isFalse(
      isVerifiedAnnotationSave(result(false, [receipt("verified", "applied")])),
    );
    assert.isFalse(
      isVerifiedAnnotationSave(
        result(true, [receipt("unverified", "unverified")]),
      ),
    );
    assert.isFalse(isVerifiedAnnotationSave(result(true, [])));
  });
});
