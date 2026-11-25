import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

/**
 * A thinking block shows the model's thought, not the blank lines a runtime
 * appends to it: Antigravity ends every thought with three newlines, which
 * drew as empty space at the bottom of each block.
 */
describe("workflow: thinking block text", function () {
  this.timeout(60000);
  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | undefined;

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
  });

  afterEach(async function () {
    await api.closeStandalone();
    if (fixture) await api.cleanupFixture(fixture);
    fixture = undefined;
    await api.reset();
  });

  it("shows each thought without the blank lines appended to it", async function () {
    fixture = await api.createPaperWithPdfFixture({
      title: "Thinking block text",
      pdfTitle: "Thinking block text PDF",
    });
    await api.openStandaloneForItem(fixture.parentItemId);

    const runId = "workflow-thinking-block-text";
    let seq = 0;
    const traceEvent = (payload: Record<string, unknown>) => ({
      runId,
      seq: ++seq,
      eventType: payload.type as string,
      payload,
      createdAt: Date.now(),
    });
    const first = "I'm thinking through how to approach this.";
    // Blank lines inside a thought are the model's own paragraphs.
    const second = "The snippets came back short.\n\nAsking for each section.";
    await api.seedStandaloneConversation([
      { role: "user", text: "Summarize this paper." },
      {
        role: "assistant",
        text: "A summary of the paper.",
        runMode: "agent",
        streaming: true,
        modelName: "gemini-4-neon",
        pendingAgentTraceEvents: [
          traceEvent({
            type: "reasoning",
            round: 1,
            details: `${first}\n\n\n`,
          }),
          traceEvent({
            type: "tool_call",
            callId: "call-1",
            name: "read_document",
            args: { lines: "1-200" },
          }),
          traceEvent({
            type: "tool_result",
            callId: "call-1",
            name: "read_document",
            ok: true,
            content: "Read lines 1-200",
          }),
          traceEvent({
            type: "reasoning",
            round: 1,
            details: `${second}\n\n\n`,
          }),
        ] as never,
      },
    ]);

    const win = (Zotero as any).LLMForZotero.data.standaloneWindow as Window;
    const shown = Array.from(
      win.document.querySelectorAll<HTMLElement>(".llm-agent-reasoning-text"),
      (block) => block?.textContent,
    );
    assert.deepEqual(shown, [first, second]);
  });
});
