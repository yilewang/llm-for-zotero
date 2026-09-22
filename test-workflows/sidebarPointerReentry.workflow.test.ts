import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";
import type { AgentEvent, AgentRunEventRecord } from "../src/agent/types";

describe("workflow: sidebar pointer reentry", function () {
  this.timeout(60000);
  const prefix = "extensions.zotero.llmforzotero.";
  const preferences = {
    enableCodexAppServerMode: true,
    enableClaudeCodeMode: false,
    conversationSystem: "upstream",
    codexAppServerModel: "gpt-5.4",
    codexAppServerReasoning: "auto",
  };
  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | undefined;
  let previous = new Map<string, unknown>();
  let body: HTMLElement;
  let box: HTMLDivElement;
  let input: HTMLTextAreaElement;
  let win: Window;
  let panelId: string;

  // Reentry schedules both responsive layout and a later panel-state refresh.
  // Waiting only for the event handler to return misses that second refresh.
  // Background test windows can suspend animation frames, so allow the
  // production scheduler's 100 ms fallback to run (including a follow-up pass).
  async function settle() {
    await Zotero.Promise.delay(300);
  }

  async function reenter() {
    body.dispatchEvent(new win.PointerEvent("pointerleave"));
    body.dispatchEvent(new win.PointerEvent("pointerenter"));
    await settle();
  }

  async function assertIdleReentryDoesNotMutatePanel(
    before: Awaited<ReturnType<typeof readAt>>,
  ) {
    const mutations: string[] = [];
    const recordMutations = (records: MutationRecord[]) => {
      for (const record of records) {
        const target = record.target as Element;
        mutations.push(
          `${record.type}:${target.id || target.className || target.nodeName}:${record.attributeName || "children"}`,
        );
      }
    };
    const observer = new win.MutationObserver(recordMutations);
    observer.observe(body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style"],
    });
    try {
      for (let visit = 0; visit < 3; visit++) {
        await reenter();
        assertReadingPosition(before);
      }
      recordMutations(observer.takeRecords());
    } finally {
      observer.disconnect();
    }
    assert.lengthOf(
      mutations,
      0,
      `unchanged preferences and context must not rebuild or resize the panel: ${mutations.slice(0, 20).join(", ")}`,
    );
  }

  async function seedNativeCodexTrace() {
    const runId = `sidebar-reentry-${fixture!.parentItemId}`;
    const finalText =
      "The paper's argument is supported by the reported evidence.";
    const traceText = Array.from(
      { length: 18 },
      (_, index) =>
        `Trace paragraph ${index + 1}. I am comparing the paper's assumptions, results, and limitations before answering. This native Codex text must stay still when the pointer returns to the sidebar.`,
    ).join("\n\n");
    const event = (seq: number, payload: AgentEvent): AgentRunEventRecord => ({
      runId,
      seq,
      eventType: payload.type,
      payload,
      createdAt: Date.now() + seq,
    });
    await api.seedPanelStoredTurn(
      panelId,
      "Compare the paper's evidence and limitations.",
      finalText,
      {
        runMode: "agent",
        modelProviderLabel: "Codex",
        streaming: false,
        // Pending native events exercise the production trace renderer without
        // looking up a missing persisted run or calling a real local agent.
        pendingAgentTraceEvents: [
          event(1, { type: "message_delta", text: traceText }),
          event(2, {
            type: "codex_tool_activity",
            itemId: "read-paper",
            phase: "completed",
            toolName: "zotero_search",
            toolLabel: "Read paper evidence",
            args: { query: "paper evidence" },
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
    const trace = body.querySelector<HTMLDetailsElement>(
      ".llm-agent-activity-details",
    )!;
    assert.isOk(trace, "the native Codex activity is rendered");
    trace.open = true;
    await settle();
    const paragraphs = trace.querySelectorAll(".llm-agent-inline-text p");
    assert.lengthOf(
      paragraphs,
      18,
      "Codex intermediate text remains in the trace",
    );
    return paragraphs[8];
  }

  function readingGeometry(paragraph: Element) {
    return {
      top: box.scrollTop,
      scrollHeight: box.scrollHeight,
      clientHeight: box.clientHeight,
      inputHeight: input.getBoundingClientRect().height,
      paragraphOffset:
        paragraph.getBoundingClientRect().top - box.getBoundingClientRect().top,
      conversationKey:
        body.querySelector<HTMLElement>("#llm-main")!.dataset.itemId,
    };
  }

  async function readAt(top: number) {
    // A wheel gesture establishes manual reading intent, including immediately
    // above the bottom; assigning scrollTop alone can retain follow-bottom mode.
    box.dispatchEvent(new win.WheelEvent("wheel", { deltaY: -30 }));
    box.scrollTop = top;
    box.dispatchEvent(new win.Event("scroll"));
    await settle();
    const boxTop = box.getBoundingClientRect().top;
    const paragraph = Array.from(box.querySelectorAll("p")).find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.bottom > boxTop && rect.top < boxTop + box.clientHeight;
    });
    assert.isOk(
      paragraph,
      "a rendered paragraph is visible at the reading position",
    );
    return {
      paragraph: paragraph!,
      ...readingGeometry(paragraph!),
    };
  }

  function assertReadingPosition(
    before: Awaited<ReturnType<typeof readAt>>,
    after = readingGeometry(before.paragraph),
    details = "",
  ) {
    const diagnostic =
      details ||
      JSON.stringify({ before: { ...before, paragraph: undefined }, after });
    assert.equal(
      after.conversationKey,
      before.conversationKey,
      "pointer reentry keeps the same conversation",
    );
    assert.closeTo(
      after.top,
      before.top,
      1,
      `the reading position stays fixed: ${diagnostic}`,
    );
    assert.closeTo(
      after.paragraphOffset,
      before.paragraphOffset,
      1,
      `the visible paragraph stays in the same place after queued refreshes: ${diagnostic}`,
    );
  }

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
    fixture = await api.createPaperWithPdfFixture({
      title: "Sidebar pointer reentry",
      pdfTitle: "Sidebar pointer reentry PDF",
      pages: ["Disposable paper for a local Codex conversation."],
    });
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    panelId = panel.panelId;
    const diagnostics = await api.clickPanelSystemToggle(
      panel.panelId,
      "codex",
    );
    assert.equal(diagnostics.conversationSystem, "codex");
    const doc = Zotero.getMainWindow().document;
    win = doc.defaultView!;
    body = doc.querySelector<HTMLElement>(
      `[data-workflow-panel-id="${panel.panelId}"]`,
    )!;
    assert.isOk(body, "the workflow panel is in the main document");
    // Use the production panel and real Gecko flex layout at sidebar dimensions.
    body.style.width = "340px";
    body.style.height = "640px";
    // Match the dedicated sidebar's shell rules. The generic workflow host
    // otherwise retains the stacked panel's 320 px minimum, masking changes
    // to the viewport height when a multiline composer is remeasured.
    const shell = body.querySelector<HTMLElement>(".llm-chat-shell")!;
    shell.style.flex = "1 1 0";
    shell.style.height = "auto";
    shell.style.minHeight = "80px";
    shell.style.maxHeight = "none";
    box = body.querySelector<HTMLDivElement>("#llm-chat-box")!;
    input = body.querySelector<HTMLTextAreaElement>("#llm-input")!;
    await api.seedPanelStoredTurn(
      panel.panelId,
      "Explain the paper in detail.",
      Array.from(
        { length: 35 },
        (_, index) =>
          `Paragraph ${index + 1}. The reader moves the pointer between the paper and this discussion. This paragraph should stay at the same position while reading, even when the panel refreshes its controls.`,
      ).join("\n\n"),
    );
    await settle();
    assert.isAbove(box.scrollHeight - box.clientHeight, 1000);
  });

  afterEach(async function () {
    try {
      await api.reset();
      if (fixture) await api.cleanupFixture(fixture);
    } finally {
      fixture = undefined;
      for (const [name, value] of previous) {
        if (value === undefined) Zotero.Prefs.clear(prefix + name, true);
        else Zotero.Prefs.set(prefix + name, value, true);
      }
      previous.clear();
    }
  });

  for (const readingPosition of ["middle", "near bottom"] as const) {
    it(`keeps a ${readingPosition} reading position when the pointer returns to Codex`, async function () {
      const draft =
        readingPosition === "near bottom"
          ? Array.from(
              { length: 12 },
              (_, index) => `Draft line ${index + 1}: a follow-up question.`,
            ).join("\n")
          : "";
      const emptyComposerViewportHeight = box.clientHeight;
      input.value = draft;
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
      await settle();
      if (draft) {
        assert.isAbove(input.getBoundingClientRect().height, 150);
        assert.isBelow(
          box.clientHeight,
          emptyComposerViewportHeight - 50,
          "the sidebar viewport shrinks to make room for the multiline draft",
        );
      }
      const maxTop = box.scrollHeight - box.clientHeight;
      const before = await readAt(
        readingPosition === "near bottom" ? maxTop - 30 : maxTop / 2,
      );
      const visits: ReturnType<typeof readingGeometry>[] = [];
      for (let visit = 0; visit < 3; visit++) {
        await reenter();
        visits.push(readingGeometry(before.paragraph));
        assert.equal(input.value, draft, "the unsent draft is preserved");
      }
      const diagnostic = JSON.stringify({
        before: { ...before, paragraph: undefined },
        visits,
      });
      for (const visit of visits)
        assertReadingPosition(before, visit, diagnostic);
    });
  }

  it("does no work on pointer reentry with an empty focused composer near the bottom", async function () {
    assert.equal(input.value, "");
    input.focus({ preventScroll: true });
    const before = await readAt(box.scrollHeight - box.clientHeight - 30);
    await settle();

    await assertIdleReentryDoesNotMutatePanel(before);

    assert.strictEqual(body.ownerDocument.activeElement, input);
    assert.equal(input.value, "");
  });

  it("keeps native Codex trace text still without rebuilding the idle panel", async function () {
    const target = await seedNativeCodexTrace();
    assert.equal(input.value, "");
    input.focus({ preventScroll: true });
    const before = await readAt(
      box.scrollTop +
        target.getBoundingClientRect().top -
        box.getBoundingClientRect().top -
        10,
    );
    assert.isOk(before.paragraph.closest(".llm-agent-inline-text"));
    await settle();

    await assertIdleReentryDoesNotMutatePanel(before);

    assert.strictEqual(body.ownerDocument.activeElement, input);
  });

  it("syncs a changed shared draft from another Codex panel without moving the reading position", async function () {
    const mirror = await api.renderPanelForItem(fixture!.parentItemId);
    const mirrorBody = body.ownerDocument.querySelector<HTMLElement>(
      `[data-workflow-panel-id="${mirror.panelId}"]`,
    )!;
    assert.equal(
      mirrorBody.querySelector<HTMLElement>("#llm-main")!.dataset.itemId,
      body.querySelector<HTMLElement>("#llm-main")!.dataset.itemId,
      "both panels display the same Codex conversation",
    );
    const mirrorInput =
      mirrorBody.querySelector<HTMLTextAreaElement>("#llm-input")!;
    const before = await readAt((box.scrollHeight - box.clientHeight) / 2);
    const sharedDraft = Array.from(
      { length: 12 },
      (_, index) => `Shared draft line ${index + 1}: another follow-up.`,
    ).join("\n");
    mirrorInput.value = sharedDraft;
    mirrorInput.dispatchEvent(new win.Event("input", { bubbles: true }));
    await settle();
    assert.equal(input.value, "", "the original composer has not synced yet");

    await reenter();

    assert.equal(input.value, sharedDraft);
    assertReadingPosition(before);
    await assertIdleReentryDoesNotMutatePanel(before);
  });

  it("updates screenshot support when an API model's input mode changes without renaming it", async function () {
    const groups = (inputMode: "vision_allowed" | "text_only") =>
      JSON.stringify([
        {
          id: "sidebar-input-mode-provider",
          authMode: "api_key",
          apiBase: "https://relay.example/v1",
          apiKey: "workflow-test-key",
          providerProtocol: "openai_chat_compat",
          models: [
            {
              id: "sidebar-input-mode-model",
              model: "gpt-5.4",
              temperature: 0.3,
              outputTokenLimit: { mode: "auto" },
              inputMode,
            },
          ],
        },
      ]);
    const settings = {
      modelProviderGroups: groups("vision_allowed"),
      modelProviderGroupsMigrationVersion: 3,
      lastUsedModelEntryId: "sidebar-input-mode-model",
    };
    for (const [name, value] of Object.entries(settings)) {
      previous.set(name, Zotero.Prefs.get(prefix + name, true));
      Zotero.Prefs.set(prefix + name, value, true);
    }
    const upstream = await api.clickPanelSystemToggle(panelId, "codex");
    assert.equal(upstream.conversationSystem, "upstream");
    await api.seedPanelStoredTurn(
      panelId,
      "Explain the paper using the API model.",
      Array.from(
        { length: 25 },
        (_, index) =>
          `Paragraph ${index + 1}. The model keeps its name while its input capabilities change in the settings window. Existing conversation content should remain in place.`,
      ).join("\n\n"),
    );
    await settle();
    const screenshot =
      body.querySelector<HTMLButtonElement>("#llm-screenshot")!;
    const model = body.querySelector<HTMLElement>("#llm-model-toggle")!;
    const modelLabel = model.dataset.modelLabel;
    assert.include(modelLabel, "gpt-5.4");
    assert.isFalse(screenshot.disabled, "vision input allows screenshots");
    const before = await readAt((box.scrollHeight - box.clientHeight) / 2);

    for (const inputMode of ["text_only", "vision_allowed"] as const) {
      Zotero.Prefs.set(prefix + "modelProviderGroups", groups(inputMode), true);
      await reenter();

      assert.equal(model.dataset.modelLabel, modelLabel);
      assert.equal(screenshot.disabled, inputMode === "text_only");
      assertReadingPosition(before);
    }
    await assertIdleReentryDoesNotMutatePanel(before);
  });

  it("still applies external model and reasoning changes when the pointer returns", async function () {
    const before = await readAt((box.scrollHeight - box.clientHeight) / 2);
    const model = body.querySelector<HTMLElement>("#llm-model-toggle")!;
    const reasoning = body.querySelector<HTMLElement>("#llm-reasoning-toggle")!;
    assert.include(model.dataset.modelLabel, "gpt-5.4");
    assert.equal(reasoning.dataset.reasoningLabel, "Auto");
    Zotero.Prefs.set(prefix + "codexAppServerModel", "gpt-5.4-mini", true);
    Zotero.Prefs.set(prefix + "codexAppServerReasoning", "high", true);

    await reenter();

    assert.include(model.dataset.modelLabel, "gpt-5.4-mini");
    assert.equal(reasoning.dataset.reasoningLabel, "High");
    assertReadingPosition(before);
  });
});
