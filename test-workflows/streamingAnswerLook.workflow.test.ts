/**
 * The answer looks the same while it streams and once the run ends.
 *
 * In every mode the first answer paragraph keeps its font size, line height
 * and left edge when streaming ends. A streaming answer is never drawn in the
 * step look (smaller and indented); Codex agent messages stay among the steps
 * but are drawn in the answer's look from their first word.
 */
import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

type Look = {
  fontSize: number;
  lineHeight: number;
  left: number;
  /** Where the paragraph sits: the bubble, the trace's answer, or a step. */
  place: string;
  /** Drawn in the answer's look inside the trace. */
  answerLook: boolean;
};

describe("workflow: streaming answer look", function () {
  this.timeout(120000);
  const prefix = "extensions.zotero.llmforzotero.";
  const preferences: Record<string, string | boolean> = {
    enableAgentMode: true,
    lastUsedRuntimeMode: "agent",
    enableCodexAppServerMode: true,
    enableClaudeCodeMode: false,
    conversationSystem: "upstream",
    codexAppServerModel: "gpt-5.4",
    codexAppServerReasoning: "auto",
  };
  const saved = new Map<string, unknown>();
  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | undefined;
  let win: Window;

  const delay = (ms: number) => Zotero.Promise.delay(ms);
  async function until<T>(read: () => T | null | undefined, label: string) {
    const deadline = Date.now() + 15000;
    let value = read();
    while (!value && Date.now() < deadline) {
      await delay(40);
      value = read();
    }
    assert.isOk(value, label);
    return value as T;
  }
  const px = (el: Element, prop: string) =>
    Number.parseFloat((win.getComputedStyle(el) as any).getPropertyValue(prop));
  const near = (actual: number, expected: number, label: string) =>
    assert.closeTo(actual, expected, 0.6, label);

  function rootOf(panelId: string): HTMLElement {
    return win.document.querySelector(
      `[data-workflow-panel-id="${panelId}"]`,
    ) as HTMLElement;
  }

  /** Bring the synthetic panel on screen, as a sidebar-sized column. */
  function showOnScreen(panelId: string): () => void {
    const host = rootOf(panelId).closest(
      "[data-llm-workflow-test]",
    ) as HTMLElement;
    const previous = host.getAttribute("style");
    host.style.left = "0";
    host.style.width = "420px";
    host.style.height = "760px";
    host.style.zIndex = "99999";
    return () => {
      if (previous === null) host.removeAttribute("style");
      else host.setAttribute("style", previous);
    };
  }

  /** The visible paragraphs that start with the marker. */
  function paragraphs(root: HTMLElement, marker: string): HTMLElement[] {
    return (
      Array.from(
        root.querySelectorAll<HTMLElement>("#llm-chat-box p"),
      ) as HTMLElement[]
    ).filter(
      (node) =>
        node.textContent?.trim().startsWith(marker) &&
        node.getClientRects().length > 0 &&
        // A closed disclosure can keep its contents' last rects.
        !node.closest("details:not([open])"),
    );
  }

  /** The first visible paragraph that starts with the marker. */
  function paragraph(root: HTMLElement, marker: string): HTMLElement | null {
    return paragraphs(root, marker)[0] || null;
  }

  function look(node: HTMLElement): Look {
    return {
      fontSize: px(node, "font-size"),
      lineHeight: px(node, "line-height"),
      left: node.getBoundingClientRect().left,
      place: node.closest(".llm-agent-activity-list")
        ? "step list"
        : node.closest(".llm-agent-activity-answer")
          ? "trace answer"
          : node.closest(".llm-assistant-answer")
            ? "bubble"
            : "other",
      answerLook: Boolean(node.closest(".llm-agent-inline-answer")),
    };
  }

  /** Numbers go to a file in the test data folder: the runner hides console output. */
  async function record(line: string) {
    console.log(line);
    const path = `${Zotero.DataDirectory.dir}/streaming-answer-look.log`;
    const io = (win as any).IOUtils;
    const before = (await io.exists(path)) ? await io.readUTF8(path) : "";
    await io.writeUTF8(path, `${before}${line}\n`);
  }

  /** A PNG of the panel, in the test data folder. */
  async function capture(panelId: string, filename: string) {
    const rect = rootOf(panelId).getBoundingClientRect();
    const canvas = win.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas",
    ) as HTMLCanvasElement;
    const scale = win.devicePixelRatio || 1;
    const width = Math.ceil(rect.width);
    const height = Math.ceil(rect.height);
    canvas.width = width * scale;
    canvas.height = height * scale;
    const context = canvas.getContext("2d") as any;
    context.scale(scale, scale);
    context.drawWindow(win, rect.left, rect.top, width, height, "#ffffff");
    const binary = win.atob(canvas.toDataURL("image/png").split(",")[1]);
    const path = `${Zotero.DataDirectory.dir}/${filename}`;
    await (win as any).IOUtils.write(
      path,
      Uint8Array.from(binary, (char: string) => char.charCodeAt(0)),
    );
    await record(`screenshot: ${path}`);
  }

  async function compare(mode: string, streaming: Look, final: Look) {
    await record(
      `streaming answer look [${mode}]: ${JSON.stringify({ streaming, final })}`,
    );
    assert.isTrue(
      streaming.place !== "step list" || streaming.answerLook,
      `${mode}: the streaming answer is not drawn as a step`,
    );
    near(streaming.fontSize, final.fontSize, `${mode}: font size`);
    near(streaming.lineHeight, final.lineHeight, `${mode}: line height`);
    near(streaming.left, final.left, `${mode}: left edge`);
  }

  beforeEach(async function () {
    assert.isTrue(Zotero.DataDirectory.dir.endsWith("/.scaffold/test/data"));
    api = (Zotero as any).LLMForZotero.api.workflowTest as WorkflowTestApi;
    await api.reset();
    for (const [name, value] of Object.entries(preferences)) {
      saved.set(name, Zotero.Prefs.get(prefix + name, true));
      Zotero.Prefs.set(prefix + name, value, true);
    }
    fixture = await api.createPaperWithPdfFixture({
      title: "Streaming answer look",
      pages: ["Fixture page text."],
    });
    win = Zotero.getMainWindow();
  });

  afterEach(async function () {
    try {
      await api.reset();
      if (fixture) await api.cleanupFixture(fixture);
    } finally {
      fixture = undefined;
      for (const [name, value] of saved) {
        if (value === undefined) Zotero.Prefs.clear(prefix + name, true);
        else
          Zotero.Prefs.set(
            prefix + name,
            value as string | number | boolean,
            true,
          );
      }
      saved.clear();
    }
  });

  it("keeps the agent's interleaved answer still when the run ends", async function () {
    const panel = await api.renderPanelForItem(fixture!.parentItemId);
    const restore = showOnScreen(panel.panelId);
    const handle = await api.startTaskProgressReplay({
      panelId: panel.panelId,
      historyTurns: 0,
      user: {},
    });
    try {
      const root = rootOf(panel.panelId);
      const lead = "Let me read the methods section before I answer.";
      const first = "Answer opening paragraph about population coding.";
      const second = "A second paragraph that keeps the answer streaming.";
      const third = "A third paragraph that closes the answer.";
      await handle.emit({ type: "message_delta", text: lead });
      // As the runtime does: a lead-in before a tool call is rolled back.
      await handle.emit({
        type: "message_rollback",
        length: lead.length,
        text: lead,
      });
      await handle.emit({
        type: "tool_call",
        callId: "call-1",
        name: "paper_read",
        args: { operation: "overview" },
      });
      await handle.emit({
        type: "tool_result",
        callId: "call-1",
        name: "paper_read",
        ok: true,
        content: { text: "Methods text." },
        actionReceipts: [],
      });
      await handle.emit({ type: "message_delta", text: `${first}\n\n` });
      await handle.emit({ type: "message_delta", text: `${second}\n\n` });
      await handle.emit({ type: "message_delta", text: third });
      const streamingNode = await until(
        () => paragraph(root, "Answer opening"),
        "the streaming answer draws",
      );
      await delay(300);
      const streaming = look(streamingNode);

      await handle.emit({
        type: "final",
        text: `${first}\n\n${second}\n\n${third}`,
      });
      handle.refreshChat();
      await delay(300);
      const finalNode = await until(
        () => paragraph(root, "Answer opening"),
        "the final answer draws",
      );
      await compare("agent", streaming, look(finalNode));
    } finally {
      handle.finish();
      restore();
    }
  });

  it("keeps a plain streaming bubble still when the run ends", async function () {
    const panel = await api.renderPanelForItem(fixture!.parentItemId);
    const restore = showOnScreen(panel.panelId);
    const codex = await api.startCodexTaskProgressReplay({
      panelId: panel.panelId,
      user: { text: "Summarize the paper" },
    });
    try {
      const root = rootOf(panel.panelId);
      codex.answer("Bubble opening paragraph about drift.\n\n");
      codex.answer("A second paragraph that keeps the bubble streaming.");
      const streamingNode = await until(
        () => paragraph(root, "Bubble opening"),
        "the streaming bubble draws",
      );
      await delay(300);
      const streaming = look(streamingNode);
      await codex.finish();
      const finalNode = await until(
        () => paragraph(root, "Bubble opening"),
        "the final bubble draws",
      );
      await compare("bubble", streaming, look(finalNode));
    } finally {
      await codex.finish();
      restore();
    }
  });

  it("keeps a Codex agent message still when the bubble takes it over", async function () {
    const panel = await api.renderPanelForItem(fixture!.parentItemId);
    api.configurePermissionCatalogs();
    assert.equal(
      (await api.clickPanelSystemToggle(panel.panelId, "codex"))
        .conversationSystem,
      "codex",
    );
    const restore = showOnScreen(panel.panelId);
    // The replay streams the current turn's agent message ("当前…") into the
    // trace; the previous turn ("历史…") is the same kind of answer, already
    // completed and drawn in its bubble. The replay has no way to complete
    // the current turn, so the completed turn stands in for the final look.
    const replay = await api.createCodexStreamingScrollReplay(panel.panelId);
    try {
      const root = rootOf(panel.panelId);
      const streaming = look(
        await until(
          () => paragraph(root, "当前译文 01"),
          "the streaming Codex message draws",
        ),
      );
      const final = look(
        await until(
          () => paragraph(root, "历史译文 01"),
          "the completed Codex answer draws",
        ),
      );
      assert.equal(streaming.place, "step list");
      assert.isTrue(streaming.answerLook);
      assert.equal(final.place, "bubble");
      await compare("codex", streaming, final);
    } finally {
      replay.dispose();
      restore();
    }
  });

  it("keeps a Codex message still when a tool row and a second message follow it", async function () {
    const panel = await api.renderPanelForItem(fixture!.parentItemId);
    api.configurePermissionCatalogs();
    assert.equal(
      (await api.clickPanelSystemToggle(panel.panelId, "codex"))
        .conversationSystem,
      "codex",
    );
    const restore = showOnScreen(panel.panelId);
    const codex = await api.startCodexTaskProgressReplay({
      panelId: panel.panelId,
      user: { text: "Compare the methods" },
    });
    try {
      const root = rootOf(panel.panelId);
      const first = "First message opening paragraph about the methods.";
      const second = "Second message opening paragraph with the answer.";
      const secondText = `${second}\n\nIt keeps streaming after the tool row.`;
      codex.agentMessage("msg-1", `${first}\n\nI will check the paper.\n\n`);
      const firstNode = await until(
        () => paragraph(root, "First message opening"),
        "the first Codex message draws",
      );
      await delay(300);
      const before = look(firstNode);
      const messageOf = (node: HTMLElement) =>
        node.closest(".llm-agent-process-message") as HTMLElement;
      const classes = messageOf(firstNode).className;

      codex.read("tool-1", {
        version: 1,
        callId: "tool-1",
        toolName: "library_retrieve",
        papers: [],
        reads: [],
      });
      await until(
        () =>
          messageOf(paragraph(root, "First message opening")!)
            ?.nextElementSibling,
        "a tool row follows the first message",
      );
      await delay(300);
      const afterTool = look(paragraph(root, "First message opening")!);

      codex.agentMessage("msg-2", secondText);
      const secondNode = await until(
        () => paragraph(root, "Second message opening"),
        "the second Codex message draws",
      );
      await delay(300);
      const firstAfter = paragraph(root, "First message opening")!;
      const afterSecond = look(firstAfter);
      const streaming = look(secondNode);
      await record(
        `codex message across a tool row: ${JSON.stringify({ before, afterTool, afterSecond, streaming })}`,
      );
      await capture(panel.panelId, "codex-midstream.png");

      const list = messageOf(firstAfter).parentElement!;
      assert.isTrue(list.classList.contains("llm-agent-activity-list"));
      assert.isOk(
        Array.from(list.children).find(
          (row) =>
            row !== messageOf(firstAfter) && row !== messageOf(secondNode),
        ),
        "a step row sits between the messages",
      );
      assert.equal(messageOf(firstAfter).className, classes);
      for (const [label, now] of [
        ["after the tool row", afterTool],
        ["after the second message", afterSecond],
      ] as const) {
        assert.equal(now.place, "step list", `first message ${label}`);
        assert.isTrue(now.answerLook, `first message ${label}`);
        near(now.fontSize, before.fontSize, `font size ${label}`);
        near(now.lineHeight, before.lineHeight, `line height ${label}`);
        near(now.left, before.left, `left edge ${label}`);
      }
      assert.isTrue(before.answerLook);
      assert.equal(streaming.place, "step list");
      assert.isTrue(streaming.answerLook);

      // The run ends with the second message as its answer.
      codex.answer(secondText);
      await codex.finish();
      const finalNode = await until(() => {
        const node = paragraph(root, "Second message opening");
        return node && look(node).place === "bubble" ? node : null;
      }, "the final bubble draws");
      // The collapsed trace hides its copy: the answer shows once.
      assert.lengthOf(paragraphs(root, "Second message opening"), 1);
      const final = look(finalNode);
      await compare("codex messages", streaming, final);
      near(before.left, final.left, "first message left edge");
      near(before.fontSize, final.fontSize, "first message font size");
    } finally {
      await codex.finish();
      restore();
    }
  });
});
