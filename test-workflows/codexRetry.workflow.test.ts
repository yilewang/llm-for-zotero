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
  /** Panels this test opened; their chats' cleanup jobs go after it. */
  let openedPanels: string[] = [];
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
    // Failed scripted archives leave jobs; never retry them against codex.
    const keys = await Promise.all(
      openedPanels.map(async (panelId) =>
        Number((await api.getDiagnostics(panelId)).conversationKey),
      ),
    );
    openedPanels = [];
    await api.clearCleanupJobsForTests(keys);
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
    openedPanels.push(panel.panelId);
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
  /** A Codex chat whose re-send could not archive the thread it replaces. */
  async function afterFailedArchive(server: FakeCodexAppServer) {
    const panelId = await openCodexPanel(server, ["A page for the panel."]);
    await sendTurn(panelId, "Pick a number.", TIMEOUT_MS);
    const [firstStart] = server.turnStarts();
    const oldThread = String(firstStart?.params.threadId || "");
    server.setArchiveFails(true);
    let refused = "";
    await resendLatestTurn(panelId, "Pick a number.", TIMEOUT_MS).catch(
      (error) => {
        refused = String(error);
      },
    );
    assert.include(refused, "Could not reset", "the re-send waits");
    return { panelId, oldThread };
  }

  it("archives the old thread before the next message, which runs on a new thread", async function () {
    const server = createFakeCodexAppServer({
      answers: ["OLD-ANSWER-4711", "NEXT-ANSWER"],
    });
    const { panelId, oldThread } = await afterFailedArchive(server);
    server.setArchiveFails(false);
    const requestsBefore = server.requests().length;
    const next = await sendTurn(panelId, "And now?", TIMEOUT_MS);
    assert.include(next.text, "NEXT-ANSWER");
    const after = server.requests().slice(requestsBefore);
    const log = describeRequests(after);
    const archive = after.findIndex(
      (request) =>
        request.method === "thread/archive" &&
        request.params.threadId === oldThread,
    );
    const start = after.findIndex((request) => request.method === "turn/start");
    assert.isAtLeast(archive, 0, `the old thread is archived\n${log}`);
    assert.isAbove(start, archive, `before the turn starts\n${log}`);
    assert.notEqual(after[start].params.threadId, oldThread, log);
  });

  it("does not send the next message while the old thread still cannot be archived", async function () {
    const server = createFakeCodexAppServer({ answers: ["OLD-ANSWER-4711"] });
    const { panelId } = await afterFailedArchive(server);
    const startsBefore = server.turnStarts().length;
    let refused = "";
    await sendTurn(panelId, "And now?", TIMEOUT_MS).catch((error) => {
      refused = String(error);
    });
    assert.include(refused, "Could not reset this chat's earlier session");
    assert.equal(server.turnStarts().length, startsBefore, "no turn started");
    // The refused send keeps what the user wrote.
    assert.equal(
      panelBody(panelId).querySelector<HTMLTextAreaElement>("#llm-input")
        ?.value,
      "And now?",
    );
  });
  function panelBody(panelId: string): HTMLElement {
    return Zotero.getMainWindow().document.querySelector(
      `[data-workflow-panel-id="${panelId}"]`,
    ) as HTMLElement;
  }

  it("leaves an archive of a thread the chat no longer uses to the background worker", async function () {
    const server = createFakeCodexAppServer({ answers: ["FIRST", "SECOND"] });
    const panelId = await openCodexPanel(server, ["A page for the panel."]);
    await sendTurn(panelId, "Hello.", TIMEOUT_MS);
    const key = Number((await api.getDiagnostics(panelId)).conversationKey);
    // An old thread a replacement superseded, whose archive keeps failing.
    await api.enqueueSessionCleanupJobForTests({
      system: "codex",
      conversationKey: key,
      providerSessionId: "fake-thread-superseded",
    });
    server.setArchiveFails(true);
    const next = await sendTurn(panelId, "And now?", TIMEOUT_MS);
    assert.include(next.text, "SECOND", "the chat's own thread is not blocked");
  });

  it("does not send a message the user stopped while its reset was running", async function () {
    const server = createFakeCodexAppServer({
      answers: ["OLD-ANSWER-4711", "MUST-NOT-RUN"],
    });
    const { panelId } = await afterFailedArchive(server);
    server.setArchiveFails(false);
    server.setArchiveDelayMs(1_500);
    const startsBefore = server.turnStarts().length;
    const sending = sendTurn(panelId, "And now?", 4_000).catch(() => null);
    await Zotero.Promise.delay(300);
    panelBody(panelId).querySelector<HTMLButtonElement>("#llm-cancel")?.click();
    await sending;
    await Zotero.Promise.delay(2_000);
    assert.equal(server.turnStarts().length, startsBefore, "no turn started");
  });
  it("leaves the other chat's draft alone when the panel switches during a reset", async function () {
    const server = createFakeCodexAppServer({
      answers: ["OLD-ANSWER-4711", "MUST-NOT-RUN"],
    });
    const { panelId } = await afterFailedArchive(server);
    server.setArchiveFails(false);
    server.setArchiveDelayMs(4_000);
    const startsBefore = server.turnStarts().length;
    const sending = sendTurn(panelId, "And now?", 8_000).catch(() => null);
    await Zotero.Promise.delay(200);
    // The panel moves to its library chat, where the user starts typing.
    await api.togglePanelConversationMode(panelId);
    // Let the switch finish loading the library chat before typing.
    await Zotero.Promise.delay(1_000);
    const input =
      panelBody(panelId).querySelector<HTMLTextAreaElement>("#llm-input")!;
    input.value = "LIBRARY DRAFT";
    await sending;
    await Zotero.Promise.delay(2_000);
    assert.equal(
      input.value,
      "LIBRARY DRAFT",
      "the library chat's draft stays",
    );
    assert.equal(server.turnStarts().length, startsBefore, "no turn started");
  });
  it("forgets the thread the cleanup worker archived, so the next message starts a new one", async function () {
    const server = createFakeCodexAppServer({
      answers: ["OLD-ANSWER-4711", "NEXT-ANSWER"],
    });
    const { panelId, oldThread } = await afterFailedArchive(server);
    server.setArchiveFails(false);
    // The background worker, not the next send, finishes the archive.
    await api.runCleanupJobsNowForTests(
      Number((await api.getDiagnostics(panelId)).conversationKey),
    );
    const archived = server
      .requests()
      .filter(
        (request) =>
          request.method === "thread/archive" &&
          request.params.threadId === oldThread,
      );
    assert.isNotEmpty(archived, "the worker archived the old thread");
    const requestsBefore = server.requests().length;
    const next = await sendTurn(panelId, "And now?", TIMEOUT_MS);
    assert.include(next.text, "NEXT-ANSWER");
    const after = server.requests().slice(requestsBefore);
    const log = describeRequests(after);
    assert.isFalse(
      after.some((request) => request.params.threadId === oldThread),
      `nothing asks for the archived thread again\n${log}`,
    );
  });
  it("does not hold a send for an ordinary archive of the chat's thread", async function () {
    const server = createFakeCodexAppServer({ answers: ["FIRST", "SECOND"] });
    const panelId = await openCodexPanel(server, ["A page for the panel."]);
    await sendTurn(panelId, "Hello.", TIMEOUT_MS);
    const key = Number((await api.getDiagnostics(panelId)).conversationKey);
    const [firstStart] = server.turnStarts();
    // A cleanup that is not a Retry or Edit reset (no purpose), naming the
    // chat's own thread, while archives fail.
    await api.enqueueSessionCleanupJobForTests({
      system: "codex",
      conversationKey: key,
      providerSessionId: String(firstStart?.params.threadId || ""),
    });
    server.setArchiveFails(true);
    const next = await sendTurn(panelId, "And now?", TIMEOUT_MS);
    assert.include(next.text, "SECOND", "the send is not held for it");
  });
  it("keeps the chat's thread when the worker finishes an ordinary archive of it", async function () {
    const server = createFakeCodexAppServer({ answers: ["FIRST", "SECOND"] });
    const panelId = await openCodexPanel(server, ["A page for the panel."]);
    await sendTurn(panelId, "Hello.", TIMEOUT_MS);
    const key = Number((await api.getDiagnostics(panelId)).conversationKey);
    const thread = String(server.turnStarts()[0]?.params.threadId || "");
    // Codex's own resume recovery queues such an archive; its replacement
    // thread is the recovery's to save.
    await api.enqueueSessionCleanupJobForTests({
      system: "codex",
      conversationKey: key,
      providerSessionId: thread,
    });
    await api.runCleanupJobsNowForTests(key);
    const requestsBefore = server.requests().length;
    await sendTurn(panelId, "And now?", TIMEOUT_MS);
    const after = server.requests().slice(requestsBefore);
    assert.isTrue(
      after.some(
        (request) =>
          request.method === "thread/resume" &&
          request.params.threadId === thread,
      ),
      `the chat still names its thread\n${describeRequests(after)}`,
    );
  });

  it("leaves the other chat's draft alone after a stopped send's reset returns", async function () {
    const server = createFakeCodexAppServer({
      answers: ["OLD-ANSWER-4711", "MUST-NOT-RUN"],
    });
    const { panelId } = await afterFailedArchive(server);
    server.setArchiveFails(false);
    server.setArchiveDelayMs(4_000);
    const sending = sendTurn(panelId, "And now?", 8_000).catch(() => null);
    await Zotero.Promise.delay(200);
    panelBody(panelId).querySelector<HTMLButtonElement>("#llm-cancel")?.click();
    await api.togglePanelConversationMode(panelId);
    await Zotero.Promise.delay(1_000);
    const input =
      panelBody(panelId).querySelector<HTMLTextAreaElement>("#llm-input")!;
    input.value = "LIBRARY DRAFT";
    await sending;
    await Zotero.Promise.delay(4_000);
    assert.equal(
      input.value,
      "LIBRARY DRAFT",
      "the library chat's draft stays",
    );
  });
  it("does not reset the chat's thread while a turn on it is still running", async function () {
    const server = createFakeCodexAppServer({ answers: ["FIRST", "SECOND"] });
    const panelId = await openCodexPanel(server, ["A page for the panel."]);
    await sendTurn(panelId, "Hello.", TIMEOUT_MS);
    server.setHoldTurns(true);
    const running = sendTurn(panelId, "Take your time.", TIMEOUT_MS).catch(
      () => null,
    );
    for (let i = 0; i < 100 && server.turnStarts().length < 2; i += 1)
      await Zotero.Promise.delay(50);
    const archivesBefore = server
      .requests()
      .filter((request) => request.method === "thread/archive").length;
    const whileRunning = await api.resetPanelRuntimeSessionForTests(panelId);
    const archivesWhileRunning = server
      .requests()
      .filter((request) => request.method === "thread/archive").length;
    server.releaseTurns();
    server.setHoldTurns(false);
    await running;
    assert.isFalse(whileRunning, "the reset waits for the turn");
    assert.equal(archivesWhileRunning, archivesBefore, "nothing archived");
    assert.isTrue(
      await api.resetPanelRuntimeSessionForTests(panelId),
      "once the turn settled the reset runs",
    );
  });
  it("forgets a thread that could not be resumed when no replacement could start", async function () {
    const server = createFakeCodexAppServer({ answers: ["FIRST", "THIRD"] });
    const panelId = await openCodexPanel(server, ["A page for the panel."]);
    await sendTurn(panelId, "Hello.", TIMEOUT_MS);
    const thread = String(server.turnStarts()[0]?.params.threadId || "");
    // The scripted server cannot resume a thread; now it cannot start one.
    server.failThreadStarts(1);
    await sendTurn(panelId, "Second.", TIMEOUT_MS).catch(() => null);
    const requestsBefore = server.requests().length;
    await sendTurn(panelId, "Third.", TIMEOUT_MS);
    const after = server.requests().slice(requestsBefore);
    assert.isFalse(
      after.some(
        (request) =>
          request.method === "thread/resume" &&
          request.params.threadId === thread,
      ),
      `the abandoned thread is not resumed again\n${describeRequests(after)}`,
    );
  });
});
