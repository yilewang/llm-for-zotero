import { assert } from "chai";
import { bindChatScrollLifecycle } from "../src/modules/contextPanel/chatScrollLifecycle";
import {
  getChatScrollSnapshot,
  clearChatScrollSnapshotsForTests,
  reconcileChatScroll,
  setFollowBottomChatScrollSnapshot,
  writeChatScrollTop,
} from "../src/modules/contextPanel/chatScrollSnapshots";
import { renderRenderedMarkdownInto } from "../src/modules/contextPanel/renderedMarkdown";
import {
  renderStreamingMarkdownInto,
  disposeStreamingMarkdown,
} from "../src/modules/contextPanel/streamingMarkdown";

// Real Gecko layout/events and the production lifecycle/renderers. The mounted
// panel/replay suites separately exercise the plugin's setupHandlers wiring.
describe("workflow: unified chat scroll ownership", function () {
  this.timeout(30000);
  const key = 928401;
  let root: HTMLDivElement;
  let box: HTMLDivElement;
  let answer: HTMLDivElement;
  let release: () => void;
  let doc: Document;
  let win: Window;
  // Gecko can throttle test-window frames. Allow the production scheduler's
  // 100 ms fallback and a follow-up reconciliation, and wait for multi-frame
  // Markdown batches explicitly where their content is part of the assertion.
  const settle = async (ready = () => true) => {
    const deadline = Date.now() + 5000;
    await Zotero.Promise.delay(300);
    while (!ready() && Date.now() < deadline) await Zotero.Promise.delay(50);
    assert.isTrue(ready(), "the deferred render finishes");
    await Zotero.Promise.delay(150);
  };
  const paragraphs = (count: number) =>
    Array.from(
      { length: count },
      (_, index) =>
        `Paragraph ${index + 1}. A neural population represents a stimulus through a pattern of activity across many neurons. This paragraph must remain readable while the response and window change.`,
    ).join("\n\n");
  const addMessage = (id: number, source: string) => {
    const wrapper = doc.createElement("div") as HTMLDivElement;
    wrapper.className = "llm-message-wrapper";
    Object.assign(wrapper.dataset, {
      messageRole: "assistant",
      messageTimestamp: String(id),
      messageAnchorKey: `scroll-${id}`,
    });
    const content = doc.createElement("div") as HTMLDivElement;
    content.className = "llm-assistant-answer";
    wrapper.appendChild(content);
    box.appendChild(wrapper);
    renderRenderedMarkdownInto(content, source, doc);
    return content;
  };
  const read = async (paragraph: Element) => {
    box.dispatchEvent(new win.WheelEvent("wheel", { deltaY: -10 }));
    box.scrollTop +=
      paragraph.getBoundingClientRect().top -
      box.getBoundingClientRect().top -
      10;
    box.dispatchEvent(new win.Event("scroll"));
    await settle();
    return (
      paragraph.getBoundingClientRect().top - box.getBoundingClientRect().top
    );
  };
  const offset = (element: Element) =>
    element.getBoundingClientRect().top - box.getBoundingClientRect().top;

  beforeEach(async function () {
    clearChatScrollSnapshotsForTests();
    doc = Zotero.getMainWindow().document;
    win = doc.defaultView!;
    root = doc.createElement("div") as HTMLDivElement;
    root.id = "llm-main";
    root.dataset.itemId = String(key);
    root.style.cssText =
      "position:fixed;left:20px;top:20px;width:540px;height:340px;z-index:99999;background:white";
    box = doc.createElement("div") as HTMLDivElement;
    box.id = "llm-chat-box";
    box.style.cssText =
      "height:320px;width:520px;overflow:auto;overflow-anchor:none;font:14px/1.5 sans-serif";
    root.appendChild(box);
    doc.documentElement.appendChild(root);
    answer = addMessage(1, paragraphs(35));
    release = bindChatScrollLifecycle(
      box,
      () => Number(root.dataset.itemId),
      () => {},
    );
    await settle();
    assert.isAbove(box.scrollHeight, box.clientHeight + 1000);
  });

  afterEach(function () {
    release?.();
    disposeStreamingMarkdown(answer);
    root?.remove();
  });

  it("retains the same paragraph through width/height resize plus content growth below", async function () {
    const paragraph = answer.querySelectorAll("p")[8];
    const before = await read(paragraph);
    const snapshotBefore = getChatScrollSnapshot(key, box);
    box.style.width = "380px";
    box.style.height = "290px";
    addMessage(2, paragraphs(12));
    await settle();
    assert.closeTo(
      offset(paragraph),
      before,
      1,
      JSON.stringify({
        snapshotBefore,
        snapshotAfter: getChatScrollSnapshot(key, box),
      }),
    );
    assert.equal(getChatScrollSnapshot(key, box)?.mode, "manual");
  });

  it("preserves an answer through deferred Markdown growth above it", async function () {
    const earlier = answer;
    const later = addMessage(2, paragraphs(30));
    const paragraph = later.querySelectorAll("p")[8];
    const before = await read(paragraph);
    renderStreamingMarkdownInto(earlier, paragraphs(50), doc, () => {});
    await settle(() => (earlier.textContent || "").includes("Paragraph 50"));
    assert.include(earlier.textContent || "", "Paragraph 50");
    assert.closeTo(offset(paragraph), before, 1);
    assert.equal(getChatScrollSnapshot(key, box)?.mode, "manual");
  });

  it("keeps the answer paragraph in place when preceding thinking content collapses", async function () {
    const thinking = doc.createElement("div");
    thinking.style.height = "280px";
    answer.parentElement!.insertBefore(thinking, answer);
    const paragraph = answer.querySelectorAll("p")[8];
    const before = await read(paragraph);
    thinking.hidden = true;
    await settle();
    assert.closeTo(offset(paragraph), before, 1);
  });

  for (const traceClass of [
    "llm-agent-inline-text",
    "llm-agent-process-message-markdown",
  ]) {
    it(`keeps reading ${traceClass} while the same turn grows above and below`, async function () {
      // Codex progress and interleaved text live inside the assistant wrapper,
      // but outside .llm-assistant-answer. Anchoring the wrapper alone cannot
      // preserve a paragraph when an earlier tool/text block grows inside it.
      answer.className = traceClass;
      const wrapper = answer.parentElement!;
      const tool = doc.createElement("div");
      tool.className = "llm-agent-process-action";
      tool.style.height = "90px";
      const earlier = doc.createElement("div");
      earlier.className = traceClass;
      const tail = doc.createElement("div");
      tail.className = traceClass;
      wrapper.insertBefore(tool, answer);
      wrapper.insertBefore(earlier, answer);
      wrapper.appendChild(tail);
      let earlierSource =
        "Earlier Codex progress before the passage being read.";
      let tailSource = "The response continues below the passage being read.";
      try {
        renderStreamingMarkdownInto(earlier, earlierSource, doc, () => {});
        renderStreamingMarkdownInto(tail, tailSource, doc, () => {});
        await settle();
        setFollowBottomChatScrollSnapshot(key, box);
        reconcileChatScroll(key, box);
        assert.closeTo(
          box.scrollHeight - box.clientHeight - box.scrollTop,
          0,
          1,
        );
        const paragraph = answer.querySelectorAll("p")[16];
        await read(paragraph);
        assert.equal(getChatScrollSnapshot(key, box)?.mode, "manual");

        for (const [chunk, delta] of [-40, -20, 25].entries()) {
          // The user keeps reading: two upward wheel moves, then a small move
          // down that remains far from the bottom while output is arriving.
          box.dispatchEvent(new win.WheelEvent("wheel", { deltaY: delta }));
          box.scrollTop += delta;
          box.dispatchEvent(new win.Event("scroll"));
          await settle();
          const before = offset(paragraph);
          const snapshotBefore = getChatScrollSnapshot(key, box);
          assert.equal(snapshotBefore?.mode, "manual");
          const previousToolHeight = tool.getBoundingClientRect().height;
          earlierSource += `\n\nEarlier tool explanation ${chunk + 1}. More evidence is available above the selected passage, so its position within this same message changes.`;
          tailSource += `\n\nStream continuation ${chunk + 1}. New response text is still arriving below the passage while the reader scrolls through earlier content.`;
          await new Promise<void>((resolve) => {
            win.setTimeout(() => {
              tool.style.height = `${160 + chunk * 70}px`;
              renderStreamingMarkdownInto(
                earlier,
                earlierSource,
                doc,
                () => {},
              );
              renderStreamingMarkdownInto(tail, tailSource, doc, () => {});
              resolve();
            }, 0);
          });
          await settle();

          assert.isAbove(
            tool.getBoundingClientRect().height,
            previousToolHeight,
          );
          assert.include(
            earlier.textContent || "",
            `Earlier tool explanation ${chunk + 1}`,
          );
          assert.include(
            tail.textContent || "",
            `Stream continuation ${chunk + 1}`,
          );
          assert.closeTo(
            offset(paragraph),
            before,
            1,
            JSON.stringify({
              traceClass,
              chunk,
              snapshotBefore,
              snapshotAfter: getChatScrollSnapshot(key, box),
            }),
          );
          assert.equal(getChatScrollSnapshot(key, box)?.mode, "manual");
          assert.isAbove(
            box.scrollHeight - box.clientHeight - box.scrollTop,
            1000,
          );
        }
      } finally {
        disposeStreamingMarkdown(earlier);
        disposeStreamingMarkdown(tail);
      }
    });
  }

  it("follows action-card growth at the bottom and yields immediately to a tiny scrollbar drag", async function () {
    setFollowBottomChatScrollSnapshot(key, box);
    reconcileChatScroll(key, box);
    const card = doc.createElement("div");
    card.className = "llm-action-inline-card";
    card.style.height = "200px";
    box.appendChild(card);
    await settle();
    assert.closeTo(box.scrollHeight - box.clientHeight - box.scrollTop, 0, 1);
    // Deliver native scroll events after an application write and a new drag.
    writeChatScrollTop(box, box.scrollHeight);
    box.scrollTop -= 2;
    card.style.height = "400px";
    await settle();
    const manualTop = box.scrollTop;
    assert.equal(getChatScrollSnapshot(key, box)?.mode, "manual");
    card.style.height = "600px";
    await settle();
    assert.closeTo(box.scrollTop, manualTop, 1);
    box.scrollTop = box.scrollHeight;
    box.dispatchEvent(new win.Event("scroll"));
    await settle();
    card.style.height = "700px";
    await settle();
    assert.closeTo(box.scrollHeight - box.clientHeight - box.scrollTop, 0, 1);
  });
});
