import { assert } from "chai";
import { ensureConversationKeyLedgerEntry } from "../../src/shared/conversationKeyLedger";
import {
  resolveLiveAgentCredentials,
  type LiveAgentCredentials,
} from "../agent/liveAgentCredentials";

declare const Zotero: any;
declare const Services: any;

const PREFIX = "extensions.zotero.llmforzotero";

describe("DeepSeek Harness with the configured live provider", function () {
  this.timeout(600000);
  let credentials: LiveAgentCredentials;
  let item: any;
  let api: any;
  const conversationKeys: number[] = [];
  async function newConversation() {
    const key = 2_500_800_000 + conversationKeys.length;
    await ensureConversationKeyLedgerEntry({
      conversationKey: key,
      instanceID: `harness-test-${key}`,
      conversationID: `harness-test-${key}`,
      system: "upstream",
      kind: "global",
      profileSignature: "harness-live-test",
      libraryID: item.libraryID,
      issuedAt: Date.now(),
    });
    conversationKeys.push(key);
    return key;
  }
  const title = `Harness verification ${Date.now()}`;
  const saved = new Map<string, unknown>();
  const report: Array<Record<string, unknown>> = [];

  before(async function () {
    const resolved = await resolveLiveAgentCredentials();
    assert.isOk(resolved, "Live provider credentials must be configured");
    credentials = resolved!;
    api = Zotero.LLMForZotero.api.agent;
    for (const [key, value] of Object.entries({
      conversationSystem: "upstream",
      enableAgentMode: true,
      agentExecutionEngine: "deepseek_harness",
      originalAgentPermissionMode: "safe",
      deepseekHarnessNodePath: Services.env.get("LLM_FOR_ZOTERO_HARNESS_NODE"),
      deepseekHarnessWorkerPath: Services.env.get(
        "LLM_FOR_ZOTERO_HARNESS_WORKER",
      ),
    })) {
      saved.set(key, Zotero.Prefs.get(`${PREFIX}.${key}`, true));
      Zotero.Prefs.set(`${PREFIX}.${key}`, value, true);
    }
    item = new Zotero.Item("journalArticle");
    item.libraryID = Zotero.Libraries.userLibraryID;
    item.setField("title", title);
    item.setField(
      "abstractNote",
      "A synthetic paper used to verify a Zotero agent integration.",
    );
    await item.saveTx();
  });

  after(async function () {
    if (item) await Zotero.Items.erase([...(item.getNotes() || []), item.id]);
    for (const [key, value] of saved) {
      if (value === undefined) Zotero.Prefs.clear(`${PREFIX}.${key}`, true);
      else Zotero.Prefs.set(`${PREFIX}.${key}`, value, true);
    }
    const reportPath = Services.env.get("LLM_FOR_ZOTERO_HARNESS_REPORT");
    if (reportPath)
      await Zotero.File.putContentsAsync(
        reportPath,
        JSON.stringify(
          {
            model: credentials?.model,
            scenarios: report,
          },
          null,
          2,
        ),
      );
  });

  async function run(
    userText: string,
    approve = false,
    extra: Record<string, unknown> = {},
  ) {
    const events: any[] = [];
    const result = await api.runTurn(
      {
        ...credentials,
        conversationKey: await newConversation(),
        mode: "agent",
        conversationKind: "global",
        libraryID: item.libraryID,
        userText,
        ...extra,
      },
      (event: any) => {
        events.push(event);
        if (event.type === "confirmation_required")
          api.resolveConfirmation(event.requestId, approve);
      },
    );
    assert.equal(result.kind, "completed");
    assert.match(result.runId, /^harness-/);
    return { result, events };
  }

  it("reads a real Zotero test item through a tool", async function () {
    const { result, events } = await run(
      `请调用 library_search 在文献库中搜索标题为「${title}」的测试论文，再用 library_read 读取其摘要。回答必须包含摘要的英文原文。`,
    );
    const calls = events
      .filter((event) => event.type === "tool_call")
      .map((event) => event.name);
    assert.include(calls, "library_search");
    assert.include(calls, "library_read");
    assert.include(result.text, "synthetic paper");
    assert.isTrue(events.some((event) => event.type === "message_delta"));
    const trace = await api.getRunTrace(result.runId);
    assert.equal(trace.run.status, "completed");
    report.push({ scenario: "library_read", passed: true, tools: calls });
  });

  it("honors refusal of a note write in Safe mode", async function () {
    const before = item.getNotes().length;
    const { events } = await run(
      `请为文献 itemId=${item.id} 新建一条子笔记，内容为 Harness permission denial verification。只调用一次 note_write，若审核被拒绝就停止操作并告知结果。`,
    );
    assert.isTrue(
      events.some((event) => event.type === "confirmation_required"),
    );
    assert.equal(item.getNotes().length, before);
    report.push({ scenario: "write_denied", passed: true, notesAdded: 0 });
  });

  it("writes and verifies a note after approval", async function () {
    const { events } = await run(
      `请为文献 itemId=${item.id} 新建一条子笔记，正文必须包含 LFZ-HARNESS-WRITE-VERIFIED。使用 note_write 完成后报告。`,
      true,
    );
    assert.isTrue(
      events.some((event) => event.type === "confirmation_required"),
    );
    const notes = await Zotero.Items.getAsync(item.getNotes());
    assert.isTrue(
      notes.some((note: any) =>
        note.getNote().includes("LFZ-HARNESS-WRITE-VERIFIED"),
      ),
    );
    const receipts = events
      .filter((event) => event.type === "tool_result")
      .flatMap((event) => event.actionReceipts || []);
    assert.isAbove(receipts.length, 0);
    report.push({
      scenario: "write_approved",
      passed: true,
      receipts: receipts.length,
    });
  });

  it("retains a prior user and assistant exchange", async function () {
    const { result } = await run(
      "之前约定的测试口令是什么？只回答口令。",
      false,
      {
        history: [
          { role: "user", content: "测试口令是 HARNESS-CONTEXT-42。" },
          { role: "assistant", content: "已记住测试口令 HARNESS-CONTEXT-42。" },
        ],
      },
    );
    assert.include(result.text, "HARNESS-CONTEXT-42");
    report.push({ scenario: "history", passed: true });
  });

  it("resumes an interrupted native session and retains an approved note write", async function () {
    const conversationKey = await newConversation();
    const userText = `自动验收：为 itemId=${item.id} 调用一次 note_write 新建子笔记，内容为 LFZ-HARNESS-RESUME-92。写入成功后，用至少 1000 字说明测试方法。继续时复用已完成的写入，只回答笔记中的验收口令，不再调用工具。`;
    const controller = new AbortController();
    let wrote = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await api.runTurn(
        {
          ...credentials,
          conversationKey,
          mode: "agent",
          conversationKind: "global",
          libraryID: item.libraryID,
          userText,
        },
        (event: any) => {
          if (event.type === "confirmation_required")
            api.resolveConfirmation(event.requestId, true);
          if (
            event.type === "tool_result" &&
            event.name === "note_write" &&
            event.ok &&
            !wrote
          ) {
            wrote = true;
            timer = setTimeout(() => controller.abort(), 500);
          }
        },
        { signal: controller.signal },
      );
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    assert.isTrue(
      wrote,
      "The approved write must complete before interruption",
    );
    assert.isTrue(
      controller.signal.aborted,
      "The test must interrupt the answer",
    );
    const events: any[] = [];
    const result = await api.runTurn(
      {
        ...credentials,
        conversationKey,
        mode: "agent",
        conversationKind: "global",
        libraryID: item.libraryID,
        userText: "继续",
        history: [{ role: "user", content: userText }],
      },
      (event: any) => events.push(event),
    );
    assert.equal(result.kind, "completed");
    assert.include(result.text, "LFZ-HARNESS-RESUME-92");
    assert.isTrue(
      events.some(
        (event) =>
          event.type === "status" &&
          event.text.includes("Resumed Harness session"),
      ),
    );
    assert.isFalse(
      events.some((event) => event.type === "tool_call"),
      "Native tool history supplies the confirmed result",
    );
    const notes = await Zotero.Items.getAsync(item.getNotes());
    assert.equal(
      notes.filter((note: any) =>
        note.getNote().includes("LFZ-HARNESS-RESUME-92"),
      ).length,
      1,
    );
    report.push({
      scenario: "native_interruption_resume",
      passed: true,
      notesAdded: 1,
      repeatedTools: 0,
    });
  });

  it("compacts a long imported conversation and continues with a real Zotero tool", async function () {
    const history = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content:
        `自动验收历史第 ${index} 段。验收口令为 HARNESS-COMPACT-73。` +
        "This is synthetic background for testing automatic context compaction. Preserve the test passphrase and continue the current task. ".repeat(
          40,
        ),
    }));
    const { result, events } = await run(
      `自动验收：回答历史中的验收口令，并调用 library_read 读取 itemId=${item.id} 的摘要，回答包含摘要英文原文。`,
      false,
      {
        history,
        advanced: {
          inputTokenCap: 65536,
          temperature: 0.2,
          outputTokenLimit: { mode: "custom", tokens: 4096 },
        },
      },
    );
    assert.isTrue(
      events.some(
        (event) => event.type === "context_compacted" && event.automatic,
      ),
    );
    assert.include(result.text, "HARNESS-COMPACT-73");
    assert.include(result.text, "synthetic paper");
    assert.isTrue(
      events.some(
        (event) => event.type === "tool_call" && event.name === "library_read",
      ),
    );
    assert.isAtLeast(
      events.filter((event) => event.type === "usage").length,
      2,
    );
    const trace = await api.getRunTrace(result.runId);
    assert.equal(trace.run.status, "completed");
    report.push({
      scenario: "automatic_compaction",
      passed: true,
      retainedPassphrase: true,
      continuedToolRead: true,
    });
  });

  it("stops an active live turn", async function () {
    const controller = new AbortController();
    let sawStatus = false;
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      let failure: unknown;
      try {
        await api.runTurn(
          {
            ...credentials,
            conversationKey: await newConversation(),
            mode: "agent",
            libraryID: item.libraryID,
            userText: "详细解释多智能体的规划过程。",
          },
          (event: any) => {
            if (event.type === "status" && event.text === "DeepSeek Harness") {
              sawStatus = true;
              setTimeout(() => controller.abort(), 1500);
            }
          },
          { signal: controller.signal },
        );
      } catch (error) {
        failure = error;
      }
      assert.isOk(failure, "Cancelled turn must reject");
      assert.isTrue(controller.signal.aborted);
      assert.isTrue(sawStatus);
      report.push({ scenario: "cancel", passed: true });
    } finally {
      clearTimeout(timer);
    }
  });
});
