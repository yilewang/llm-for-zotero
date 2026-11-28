import { assert } from "chai";
import type { CodexAppServerModelCatalogEntry } from "../src/codexAppServer/modelCatalog";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";
import {
  createFakeCodexAppServer,
  type FakeCodexAppServer,
  type FakeCodexRequest,
} from "../test/helpers/fakeCodexAppServer";
import {
  choosePdfFileSource,
  resendLatestTurn,
  sendTurn,
} from "../test/helpers/panelTurnActions";

/**
 * Re-sending a Codex turn through the panel's own buttons (a Codex answer
 * is an agent turn, so the panel offers Edit and Send), against a
 * scripted Codex app server (test/helpers/fakeCodexAppServer.ts). Everything
 * on the plugin side is real: the panel, the retry flow, the session reset
 * (runtimeSessionReset.ts), and the native Codex client.
 *
 *   (a) The retry archives the thread that holds the answer it replaces and
 *       runs on a new thread; nothing the plugin sends after the archive
 *       contains the replaced answer, and the earlier turn still reaches
 *       the new thread.
 *   (b) A turn that sends the paper's PDF file sends it again on retry.
 */

const PREFIX = "extensions.zotero.llmforzotero.";
const MODEL: CodexAppServerModelCatalogEntry = {
  id: "gpt-workflow",
  model: "gpt-workflow",
  displayName: "gpt-workflow",
  description: "",
  hidden: false,
  supportedReasoningEfforts: ["low"],
};
const TIMEOUT_MS = 20_000;

describe("workflow: Codex retry", function () {
  this.timeout(90_000);

  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | null = null;
  let previous: Map<string, unknown>;
  const settings: Record<string, string | boolean> = {
    enableCodexAppServerMode: true,
    conversationSystem: "codex",
    codexAppServerModel: MODEL.model,
    codexAppServerReasoning: "low",
    codexAppServerPath: "/workflow/codex",
    lastUsedRuntimeMode: "chat",
  };

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    api.configurePermissionCatalogs();
    api.configureCodexModelCatalogs([{ models: [MODEL] }]);
    previous = new Map(
      Object.keys(settings).map((key) => [
        key,
        Zotero.Prefs.get(PREFIX + key, true),
      ]),
    );
    for (const [key, value] of Object.entries(settings))
      Zotero.Prefs.set(PREFIX + key, value, true);
  });

  afterEach(async function () {
    await api.useCodexAppServerChildForTests();
    await api.reset();
    if (fixture) await api.cleanupFixture(fixture);
    fixture = null;
    for (const [key, value] of previous) {
      if (value === undefined) Zotero.Prefs.clear(PREFIX + key, true);
      else
        Zotero.Prefs.set(
          PREFIX + key,
          value as string | number | boolean,
          true,
        );
    }
  });

  async function openCodexPanel(
    server: FakeCodexAppServer,
    pages: string[],
  ): Promise<string> {
    await api.useCodexAppServerChildForTests(server.launch);
    fixture = await api.createPaperWithPdfFixture({
      title: "Codex retry fixture",
      pages,
    });
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const diag = await api.getDiagnostics(panel.panelId);
    assert.equal(diag.conversationSystem, "codex", "the panel runs Codex");
    return panel.panelId;
  }

  const describeRequests = (requests: FakeCodexRequest[]) =>
    requests
      .map(
        (request) =>
          `${request.method} ${JSON.stringify(request.params).slice(0, 300)}`,
      )
      .join("\n");

  it("runs the retry on a new thread that never saw the replaced answer", async function () {
    const server = createFakeCodexAppServer({
      answers: ["OK", "OLD-ANSWER-4711", "NEW-ANSWER-9042"],
    });
    const panelId = await openCodexPanel(server, ["A page for the panel."]);

    await sendTurn(
      panelId,
      "Remember the code word TEAL-CRANE for later.",
      TIMEOUT_MS,
    );
    const second = await sendTurn(panelId, "Pick a number.", TIMEOUT_MS);
    assert.include(second.text, "OLD-ANSWER-4711");
    const [, secondStart] = server.turnStarts();
    const replacedThread = String(secondStart?.params.threadId || "");
    assert.isNotEmpty(replacedThread, describeRequests(server.requests()));
    const requestsBeforeRetry = server.requests().length;

    const resent = await resendLatestTurn(
      panelId,
      "Pick a number.",
      TIMEOUT_MS,
    );
    assert.include(resent.text, "NEW-ANSWER-9042");

    const afterRetry = server.requests().slice(requestsBeforeRetry);
    const log = describeRequests(afterRetry);
    const archive = afterRetry.findIndex(
      (request) =>
        request.method === "thread/archive" &&
        request.params.threadId === replacedThread,
    );
    const retryStart = afterRetry.findIndex(
      (request) => request.method === "turn/start",
    );
    assert.isAtLeast(archive, 0, `the replaced thread is archived\n${log}`);
    assert.isAbove(retryStart, archive, `the retry starts after it\n${log}`);
    assert.notEqual(
      afterRetry[retryStart].params.threadId,
      replacedThread,
      `the retry runs on a new thread\n${log}`,
    );
    assert.notInclude(
      JSON.stringify(afterRetry),
      "OLD-ANSWER-4711",
      `nothing sent for the retry holds the replaced answer\n${log}`,
    );
    assert.include(
      JSON.stringify(afterRetry),
      "TEAL-CRANE",
      `the earlier turn reaches the new thread\n${log}`,
    );
    assert.include(server.turnText(afterRetry[retryStart]), "Pick a number.");
  });

  it("sends the paper's PDF file again on retry", async function () {
    const server = createFakeCodexAppServer({
      answers: ["FIRST-READ", "SECOND-READ"],
    });
    const panelId = await openCodexPanel(server, [
      "The verification phrase is AMBER-KITE.",
    ]);
    await choosePdfFileSource(panelId);
    const pdfPath = String(
      Zotero.Items.get(fixture!.pdfAttachmentId).getFilePath() || "",
    );
    assert.isNotEmpty(pdfPath, "the fixture has a PDF file");
    const pdfName = pdfPath.split(/[\\/]/).pop()!;

    await sendTurn(panelId, "What does the PDF say?", TIMEOUT_MS);
    const resent = await resendLatestTurn(
      panelId,
      "What does the PDF say?",
      TIMEOUT_MS,
    );
    assert.include(resent.text, "SECOND-READ");

    const starts = server.turnStarts();
    assert.lengthOf(starts, 2, describeRequests(server.requests()));
    for (const [index, start] of starts.entries()) {
      assert.include(
        JSON.stringify(start.params),
        pdfName,
        `turn ${index + 1} sends the PDF file\n${describeRequests(starts)}`,
      );
    }
  });
});
