import { assert } from "chai";
import { buildQuoteCitation } from "../src/services/quotes/quoteCitations";
import { highlightAnswerQuoteCard } from "../src/modules/contextPanel/answerQuoteHighlight";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";
import type { AgentEvent, AgentRunEventRecord } from "../src/agent/types";

/**
 * An answer written around a tool call draws its first stretch of text in
 * the trace and the rest as the answer, and each is planned from its own
 * text. Its quote cards must be the segment's own: the passage it
 * quotes, an occurrence id no other card in the answer has, and the card
 * "Show in answer" lights for that passage.
 */
describe("workflow: quote cards in trace segments", function () {
  this.timeout(60000);
  const prefix = "extensions.zotero.llmforzotero.";
  const preferences = {
    enableCodexAppServerMode: true,
    enableClaudeCodeMode: false,
    conversationSystem: "upstream",
    codexAppServerModel: "gpt-5.4",
    codexAppServerReasoning: "auto",
  };
  const FIRST =
    "Population activity drifts across days while the behavioral readout stays stable.";
  const SECOND =
    "A fixed linear decoder trained on the first session still predicts choices weeks later.";
  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | undefined;
  let previous = new Map<string, unknown>();

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    previous = new Map(
      Object.keys(preferences).map((name) => [
        name,
        Zotero.Prefs.get(prefix + name, true),
      ]),
    );
    for (const [name, value] of Object.entries(preferences)) {
      Zotero.Prefs.set(prefix + name, value, true);
    }
    api.configurePermissionCatalogs();
  });

  afterEach(async function () {
    try {
      await api.reset();
      if (fixture) await api.cleanupFixture(fixture);
    } finally {
      fixture = undefined;
      for (const [name, value] of previous) {
        if (value === undefined) Zotero.Prefs.clear(prefix + name, true);
        else
          Zotero.Prefs.set(
            prefix + name,
            value as string | number | boolean,
            true,
          );
      }
      previous.clear();
    }
  });

  it("gives each segment's card its own passage, a unique occurrence id and its own light", async function () {
    fixture = await api.createPaperWithPdfFixture({
      title: "Trace segment quote cards",
      pdfTitle: "Trace segment quote cards PDF",
      pages: [FIRST, SECOND],
    });
    const item = Zotero.Items.get(fixture.parentItemId);
    item.setCreators([
      { creatorType: "author", firstName: "Test", lastName: "Rivera" },
    ]);
    item.setField("date", "2025");
    await item.saveTx();
    const citationOf = (quote: string) =>
      buildQuoteCitation({
        quoteText: quote,
        citationLabel: "(Rivera, 2025)",
        sourceMatchText: quote,
        sourceMatchKind: "exact",
        sourceMatchSource: "context-text",
        itemId: item.id,
        contextItemId: fixture!.pdfAttachmentId,
      })!;
    const first = citationOf(FIRST);
    const second = citationOf(SECOND);
    assert.notEqual(first.id, second.id);

    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const diagnostics = await api.clickPanelSystemToggle(
      panel.panelId,
      "codex",
    );
    assert.equal(diagnostics.conversationSystem, "codex");
    const body = Zotero.getMainWindow().document.querySelector<HTMLElement>(
      `[data-workflow-panel-id="${panel.panelId}"]`,
    )!;
    assert.isOk(body, "the workflow panel is in the main document");

    const runId = `trace-segment-quotes-${fixture.parentItemId}`;
    const leadText = `The paper first shows the drift:\n\n[[quote:${first.id}]]\n\nI will check how the readout survives it.`;
    const finalText = `The readout survives because of a fixed decoder:\n\n[[quote:${second.id}]]\n\nSo the behavior is stable while the code drifts.`;
    const event = (seq: number, payload: AgentEvent): AgentRunEventRecord => ({
      runId,
      seq,
      eventType: payload.type,
      payload,
      createdAt: Date.now() + seq,
    });
    await api.seedPanelStoredTurn(
      panel.panelId,
      "How does behavior stay stable while neural activity drifts?",
      finalText,
      {
        runMode: "agent",
        modelProviderLabel: "Codex",
        streaming: false,
        quoteCitations: [first, second],
        pendingAgentTraceEvents: [
          event(1, { type: "message_delta", text: leadText }),
          event(2, {
            type: "codex_tool_activity",
            itemId: "read-paper",
            phase: "completed",
            toolName: "zotero_search",
            toolLabel: "Read paper evidence",
            args: { query: "decoder stability" },
            ok: true,
            text: "Read the paper's evidence.",
            workCategory: "retrieval",
            mutability: "read",
          }),
          event(3, { type: "message_delta", text: finalText }),
          event(4, { type: "final", text: finalText }),
        ],
      },
    );
    await Zotero.Promise.delay(300);

    const inlineSegments = Array.from(
      body.querySelectorAll<HTMLElement>(
        ".llm-agent-inline-text, .llm-assistant-answer",
      ),
    ) as HTMLElement[];
    const layout = () =>
      JSON.stringify({
        segments: inlineSegments.map((segment) =>
          (segment.textContent || "").slice(0, 160),
        ),
        cards: (
          Array.from(
            body.querySelectorAll<HTMLElement>(".llm-quote-card"),
          ) as HTMLElement[]
        ).map((card) => ({
          citation: card.dataset.quoteCitationId,
          occurrence: card.dataset.quoteOccurrenceId,
          host: card.parentElement?.closest("[class]")?.className,
        })),
      });
    const segments = inlineSegments.filter((segment) =>
      segment.querySelector(".llm-quote-card"),
    );
    assert.lengthOf(
      segments,
      2,
      `each stretch of text keeps its own card: ${layout()}`,
    );
    const cardOf = (segment: HTMLElement) =>
      segment.querySelector<HTMLElement>(".llm-quote-card")!;
    const [firstCard, secondCard] = segments.map(cardOf);

    // Each card shows the passage its own segment quotes.
    assert.equal(firstCard.dataset.quoteCitationId, first.id);
    assert.include(firstCard.textContent || "", FIRST);
    assert.notInclude(firstCard.textContent || "", SECOND);
    assert.equal(secondCard.dataset.quoteCitationId, second.id);
    assert.include(secondCard.textContent || "", SECOND);
    assert.notInclude(secondCard.textContent || "", FIRST);

    // No two cards in the answer share an occurrence id.
    const allCards = Array.from(
      body.querySelectorAll<HTMLElement>(".llm-quote-card"),
    ) as HTMLElement[];
    const occurrenceIds = allCards.map(
      (card) => card.dataset.quoteOccurrenceId || "",
    );
    assert.lengthOf(allCards, 2, "the answer has one card per quote");
    assert.notInclude(occurrenceIds, "", "every card has an occurrence id");
    assert.equal(
      new Set(occurrenceIds).size,
      occurrenceIds.length,
      `occurrence ids are unique: ${occurrenceIds.join(", ")}`,
    );

    // "Show in answer" lights the card that quotes the passage.
    const roots = [body.querySelector<HTMLElement>("#llm-chat-box")!];
    assert.deepEqual(highlightAnswerQuoteCard(roots, first.id), [firstCard]);
    assert.deepEqual(highlightAnswerQuoteCard(roots, second.id), [secondCard]);
  });
});
