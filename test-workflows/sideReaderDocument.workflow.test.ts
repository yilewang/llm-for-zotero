import { assert } from "chai";
import {
  finalizeDocument,
  persistFinalizedDocument,
} from "../src/agent/documents/finalizer";
import {
  clearPlanDocumentConversationRowsInTransaction,
  loadPlanDocument,
} from "../src/agent/documents/store";
import { deliverPendingPlanDocumentMessage } from "../src/agent/documents/publication";
import type { PlanCitationCluster } from "../src/agent/documents/types";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

/**
 * A literature review the agent wrote as a document, in the standalone
 * window's real chat:
 * - Task progress's "Show in answer" lights the document's own sentence (a
 *   plain one, and one that ends in a citation), never "Couldn't find that
 *   sentence in the chat".
 * - Moved to the side panel, it reads at a bigger size than the chat's
 *   answer text; its title row has only text size - and + and "Open in its
 *   own window", and - / + change the size (remembered as a preference).
 * - The Task progress tab's title has the main title row's size and weight.
 */

declare const IOUtils: any;

const RUN_ID = "side-reader-document-run";
const PLAIN = "Readouts stay stable even as single cells change their tuning.";
const CITED_START = "Drift is common across weeks of recording";
const SIZE_PREF = "extensions.zotero.llmforzotero.sideReaderTextSize";
const SHOT_DIR = PathUtils.join(
  PathUtils.tempDir,
  "llm-for-zotero-side-reader-shots",
);

async function until(
  check: () => boolean,
  describe: () => string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Zotero.Promise.delay(50);
  }
  if (check()) return;
  assert.fail(describe());
}

/** Saves a PNG of `win`; never fails the test when drawWindow is missing. */
async function shoot(win: Window, name: string): Promise<void> {
  try {
    const doc = win.document;
    const width = Math.ceil(win.innerWidth);
    const height = Math.ceil(win.innerHeight);
    const scale = Number(win.devicePixelRatio) || 1;
    const canvas = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas",
    ) as HTMLCanvasElement;
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext("2d") as any;
    ctx.scale(scale, scale);
    ctx.drawWindow(win, 0, 0, width, height, "#1e1e1e");
    const base64 = canvas.toDataURL("image/png").split(",")[1] || "";
    const binary = win.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    await IOUtils.makeDirectory(SHOT_DIR, { ignoreExisting: true });
    await IOUtils.write(`${SHOT_DIR}/${name}`, bytes);
  } catch (error) {
    Zotero.debug(`[sideReaderDocument] screenshot ${name} skipped: ${error}`);
  }
}

const fold = (text: string) =>
  text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

describe("workflow: a document read in the side panel", function () {
  this.timeout(240_000);
  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | null = null;
  let conversationKey = 0;
  let savedSize: unknown;

  before(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    savedSize = Zotero.Prefs.get(SIZE_PREF, true);
    Zotero.Prefs.clear(SIZE_PREF, true);
  });

  after(async function () {
    await api.closeStandalone();
    if (conversationKey)
      await Zotero.DB.executeTransaction(() =>
        clearPlanDocumentConversationRowsInTransaction(conversationKey),
      );
    if (fixture) await api.cleanupFixture(fixture);
    await api.reset();
    if (savedSize === undefined) Zotero.Prefs.clear(SIZE_PREF, true);
    else Zotero.Prefs.set(SIZE_PREF, savedSize as never, true);
  });

  it("finds the document's sentences and reads it bigger in the side panel", async function () {
    fixture = await api.createPaperWithPdfFixture({
      title: "Drift over weeks",
      pdfTitle: "Drift over weeks PDF",
    });
    const paper = Zotero.Items.get(fixture.parentItemId);
    paper.setCreators([
      { creatorType: "author", firstName: "Mary", lastName: "Mid" },
    ]);
    paper.setField("date", "2020");
    await paper.saveTx();

    await api.openStandaloneForItem(paper.id);
    await api.resizeStandaloneWindow(1400, 900);
    const win = (Zotero as any).LLMForZotero.data.standaloneWindow as Window;
    const q = <T extends Element = HTMLElement>(sel: string) =>
      win.document.querySelector(sel) as T | null;
    const qa = <T extends Element = HTMLElement>(sel: string) =>
      Array.from(win.document.querySelectorAll(sel)) as T[];
    const mainBody = () => q(".llm-standalone-content")!;
    await api.startNewStandaloneConversation();
    const first = await api.seedStandaloneConversation([
      { role: "user", text: "please do a literature review" },
    ]);
    conversationKey = Number(first.conversationKey);
    assert.isAbove(conversationKey, 0);

    // The document, finalized and delivered as a real run does.
    const citations: PlanCitationCluster[] = [
      {
        citationId: "C1",
        sources: [
          { libraryID: paper.libraryID, itemKey: paper.key, evidenceRefs: [] },
        ],
      },
    ];
    const filler = Array.from(
      { length: 14 },
      (_, index) =>
        `Further discussion ${index + 1} follows, so the review runs well past one screen of the chat and the side panel.`,
    ).join(" ");
    const markdown = [
      "# Drift review",
      "",
      "## Introduction and review question",
      "",
      `${CITED_START} [[cite:C1]]. ${filler}`,
      "",
      "## Scope and method",
      "",
      `${filler} ${PLAIN}`,
    ].join("\n");
    const now = Date.now();
    const documentId = `side-reader:${paper.key}:${now}`;
    const finalized = await finalizeDocument({
      gateway: new ZoteroGateway(),
      now,
      input: {
        title: "Drift review",
        markdown,
        citations,
        quotes: [],
        assets: [],
        groundingReviewed: "passed",
        groundingIssues: [],
      },
      context: {
        documentId,
        documentVersion: 1,
        conversationKey,
        integrityPolicy: "authored",
        origin: { kind: "direct", runId: RUN_ID, sourceMessageTimestamp: now },
        coverageItems: [],
        spec: {
          kind: "literature_review",
          title: "Drift review",
          requiredSections: [],
          requiresReferences: true,
          requiresCoverageSection: false,
          allowFigures: false,
          citationStyle: {
            styleId: "http://www.zotero.org/styles/apa",
            styleTitle: "APA",
            locale: "en-US",
          },
        },
        corpus: citations.flatMap((cluster) => cluster.sources),
        evidence: [],
        quoteCorpusKeys: new Set(),
        outsidePapers: [],
        validateAssetProvenance: () => undefined,
      },
    } as any);
    await persistFinalizedDocument(finalized);
    const document = (await loadPlanDocument(documentId))!;
    assert.isOk(document, "the document is stored");
    await deliverPendingPlanDocumentMessage({
      conversationKey,
      documentId,
      visibleMarkdown: document.visibleMarkdown,
      messageTimestamp: now,
    });
    await api.seedStandaloneConversation([
      {
        role: "user",
        text: "please do a literature review",
        timestamp: now - 1,
      },
      {
        role: "assistant",
        text: document.visibleMarkdown,
        timestamp: now,
        runMode: "agent",
        agentRunId: RUN_ID,
        documentId,
        pendingAgentTraceEvents: [
          {
            runId: RUN_ID,
            seq: 1,
            createdAt: now,
            eventType: "tool_result",
            payload: {
              type: "tool_result",
              callId: "submit-1",
              name: "submit_document",
              ok: true,
              content: { documentId },
              actionReceipts: [],
            },
          },
        ] as any,
      },
    ]);
    const content = () =>
      mainBody().querySelector(
        ".llm-plan-document-card .llm-plan-document-content",
      ) as HTMLElement | null;
    await until(
      () => Boolean(content()?.textContent?.includes(PLAIN)),
      () =>
        `the document card never painted: ${mainBody().querySelector(".llm-plan-document-card")?.textContent?.slice(0, 200) || "no card"}`,
      30_000,
    );
    assert.isNull(
      mainBody().querySelector(".llm-assistant-answer"),
      "the document card stands in for the answer (the case that broke)",
    );
    await shoot(win, "chat-document.png");

    // "Show in answer": the document's own sentences light.
    const status = () =>
      (mainBody().querySelector("#llm-status")?.textContent || "").trim();
    const showInAnswer = async (text: string) => {
      const box = mainBody().querySelector("#llm-chat-box") as HTMLElement;
      box.scrollTop = box.scrollHeight;
      await Zotero.Promise.delay(200);
      const CustomEventCtor = (win as any).CustomEvent as typeof CustomEvent;
      content()!.dispatchEvent(
        new CustomEventCtor("llm-task-progress-show-in-answer", {
          bubbles: true,
          detail: { runId: RUN_ID, key: `sentence:${text}`, text },
        }),
      );
      await Zotero.Promise.delay(900);
      const lit = Array.from(
        mainBody().querySelectorAll(".llm-answer-quote-highlight"),
      ) as HTMLElement[];
      const litText = fold(lit.map((node) => node.textContent || "").join(""));
      const top = lit[0]?.getBoundingClientRect().top ?? -1;
      const boxRect = box.getBoundingClientRect();
      return {
        count: lit.length,
        insideDocument: lit.every((node) =>
          Boolean(node.closest(".llm-plan-document-content")),
        ),
        litText,
        onScreen: top >= boxRect.top && top < boxRect.bottom,
        status: status(),
      };
    };
    const plain = await showInAnswer(PLAIN);
    await shoot(win, "show-in-answer-plain.png");
    assert.isAbove(
      plain.count,
      0,
      `a plain sentence lights: ${JSON.stringify(plain)}`,
    );
    assert.isTrue(plain.insideDocument, JSON.stringify(plain));
    assert.include(plain.litText, fold(PLAIN).slice(-30));
    assert.isTrue(plain.onScreen, `scrolled to it: ${JSON.stringify(plain)}`);
    assert.notInclude(plain.status, "Couldn't find");

    // The sentence as Task progress quotes it, its citation included.
    const citedSentence = (document.visibleMarkdown.match(
      new RegExp(`${CITED_START}[^\\n]*?\\)\\.`),
    ) || [""])[0].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    assert.include(citedSentence, CITED_START, document.visibleMarkdown);
    const cited = await showInAnswer(citedSentence);
    await shoot(win, "show-in-answer-cited.png");
    assert.isAbove(
      cited.count,
      0,
      `a sentence ending in a citation lights: ${citedSentence} ${JSON.stringify(cited)}`,
    );
    assert.isTrue(cited.insideDocument, JSON.stringify(cited));
    assert.include(cited.litText, fold(CITED_START));
    assert.isTrue(cited.onScreen, `scrolled to it: ${JSON.stringify(cited)}`);
    assert.notInclude(cited.status, "Couldn't find");
    // A click in the chat clears the light, as before.
    (mainBody().querySelector("#llm-chat-box") as HTMLElement).dispatchEvent(
      new (win as any).MouseEvent("mousedown", { bubbles: true }),
    );

    // The document in the side panel.
    const move = mainBody().querySelector(
      ".llm-plan-document-card .llm-plan-document-action-move-side",
    ) as HTMLElement | null;
    assert.isOk(move, "the card can move to the side panel");
    move!.click();
    const readerRoot = () =>
      qa('.llm-standalone-side-panel-item[data-side-item-kind="plan"]').find(
        (node) => node.getBoundingClientRect().width > 0,
      ) || null;
    await until(
      () => Boolean(readerRoot()?.textContent?.includes(PLAIN)),
      () => "the document tab never showed the document",
    );
    const root = readerRoot()!;
    const actions = Array.from(
      root.querySelectorAll(".llm-standalone-side-panel-item-action"),
    ) as HTMLButtonElement[];
    assert.deepEqual(
      actions.map((button) => button.dataset.itemAction),
      ["text-smaller", "text-larger", "own-window"],
      "only text size - and + and its own window",
    );
    for (const button of actions) {
      const mask =
        win
          .getComputedStyle(button, "::before")
          ?.getPropertyValue("mask-image") || "";
      assert.isTrue(
        Boolean(mask) && mask !== "none",
        `${button.dataset.itemAction} has an icon`,
      );
    }
    const rendered = root.querySelector(
      ".llm-standalone-side-panel-item-rendered",
    ) as HTMLElement;
    const sizeOf = (node: Element) =>
      Number.parseFloat(win.getComputedStyle(node)?.fontSize || "0");
    const paragraph = () => rendered.querySelector("p") as HTMLElement | null;
    const chatAnswerSize = sizeOf(
      mainBody().querySelector(".llm-bubble.assistant")!,
    );
    const start = sizeOf(paragraph()!);
    await shoot(win, "side-reader-default.png");
    assert.isAbove(
      start,
      chatAnswerSize,
      `the side panel reads bigger than the chat's answers (${start} vs ${chatAnswerSize})`,
    );
    const byAction = (name: string) =>
      actions.find((button) => button.dataset.itemAction === name)!;
    byAction("text-larger").click();
    await Zotero.Promise.delay(100);
    const larger = sizeOf(paragraph()!);
    assert.closeTo(larger, start * 1.1, 0.6, "+ makes the text 10% bigger");
    assert.equal(Zotero.Prefs.get(SIZE_PREF, true), 110);
    await shoot(win, "side-reader-larger.png");
    byAction("text-smaller").click();
    byAction("text-smaller").click();
    await Zotero.Promise.delay(100);
    assert.closeTo(
      sizeOf(paragraph()!),
      start * 0.9,
      0.6,
      "- makes it smaller",
    );
    assert.equal(Zotero.Prefs.get(SIZE_PREF, true), 90);
    const heading = rendered.querySelector("h2") as HTMLElement | null;
    if (heading)
      assert.isAbove(sizeOf(heading), sizeOf(paragraph()!), "headings follow");
    byAction("text-larger").click();
    await Zotero.Promise.delay(100);

    // Task progress's title, on the main title row's line: the same size
    // and weight as "Library chat".
    await api.clickStandaloneSidePanelControl("new-tab");
    const progressRow = q('[data-side-launch="progress"]');
    assert.isOk(progressRow, "the New tab page offers Task progress");
    progressRow!.click();
    await until(
      () =>
        Boolean(
          q(
            ".llm-task-progress-docked > .llm-task-progress .llm-task-progress-label",
          ),
        ),
      () => "the Task progress tab never opened",
    );
    await Zotero.Promise.delay(400);
    await shoot(win, "task-progress-title.png");
    const label = q(
      ".llm-task-progress-docked > .llm-task-progress .llm-task-progress-label",
    );
    // The title row is the chat body's sibling, not inside it.
    const mainTitle = q(
      ".llm-standalone-content-wrapper > .llm-standalone-content-title .llm-standalone-content-title-text",
    );
    assert.isOk(label && mainTitle, "both titles are there");
    if (label && mainTitle) {
      const style = win.getComputedStyle(label)!;
      const main = win.getComputedStyle(mainTitle)!;
      assert.equal(style.fontSize, main.fontSize, "Task progress title size");
      assert.equal(
        style.fontWeight,
        main.fontWeight,
        "Task progress title weight",
      );
    }
  });
});
