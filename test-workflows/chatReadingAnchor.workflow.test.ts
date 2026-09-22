import { assert } from "chai";
import { bindChatScrollLifecycle } from "../src/modules/contextPanel/chatScrollLifecycle";
import {
  clearChatScrollSnapshotsForTests,
  getChatScrollSnapshot,
  withScrollGuard,
} from "../src/modules/contextPanel/chatScrollSnapshots";

describe("workflow: chat reading anchor selection", function () {
  this.timeout(30000);
  const key = 928409;
  let doc: Document;
  let win: Window;
  let root: HTMLDivElement;
  let box: HTMLDivElement;
  let wrapper: HTMLDivElement;
  let release: (() => void) | undefined;
  const settle = () => Zotero.Promise.delay(200);
  const offset = (element: Element) =>
    element.getBoundingClientRect().top - box.getBoundingClientRect().top;
  const spacer = (height: number) => {
    const element = doc.createElement("div");
    element.style.height = `${height}px`;
    return element;
  };
  const paragraph = (text: string) => {
    const element = doc.createElement("p");
    element.textContent = text;
    return element;
  };
  const bindReading = async (element: Element) => {
    box.scrollTop += offset(element) - 10;
    release = bindChatScrollLifecycle(
      box,
      () => key,
      () => {},
    );
    box.dispatchEvent(new win.WheelEvent("wheel", { deltaY: -10 }));
    box.dispatchEvent(new win.Event("scroll"));
    await settle();
    assert.equal(getChatScrollSnapshot(key, box)?.mode, "manual");
    assert.closeTo(offset(element), 10, 1);
  };

  beforeEach(function () {
    clearChatScrollSnapshotsForTests();
    doc = Zotero.getMainWindow().document;
    win = doc.defaultView!;
    root = doc.createElement("div") as HTMLDivElement;
    root.id = "llm-main";
    root.className = "llm-panel";
    root.dataset.itemId = String(key);
    // A nonzero screen Y makes a hidden element's all-zero rect observably
    // different from a real paragraph at the viewport's reading edge.
    root.style.cssText =
      "position:fixed;left:-10000px;top:120px;width:500px;height:360px";
    box = doc.createElement("div") as HTMLDivElement;
    box.id = "llm-chat-box";
    box.className = "llm-messages";
    box.style.cssText = "height:320px;min-height:320px;max-height:320px";
    wrapper = doc.createElement("div") as HTMLDivElement;
    wrapper.className = "llm-message-wrapper";
    wrapper.style.flexShrink = "0";
    Object.assign(wrapper.dataset, {
      messageRole: "assistant",
      messageTimestamp: "1",
      messageAnchorKey: "reading-anchor-selection",
    });
    box.appendChild(wrapper);
    root.appendChild(box);
    doc.documentElement.appendChild(root);
  });

  afterEach(function () {
    release?.();
    release = undefined;
    root?.remove();
  });

  it("keeps the paragraph at the reading edge when output pushes a barely visible citation down", async function () {
    const answer = doc.createElement("div");
    answer.className = "llm-assistant-answer";
    const reading = paragraph(
      "The reader is examining this old paragraph while new output arrives farther down the same response.",
    );
    const growing = spacer(160);
    const quote = doc.createElement("div");
    quote.className = "llm-quote-card";
    quote.dataset.quoteCitationId = "reading-anchor-quote";
    quote.textContent = "A cited passage at the lower edge of the viewport.";
    quote.style.minHeight = "80px";
    answer.append(spacer(900), reading, growing, quote, spacer(1000));
    wrapper.appendChild(answer);

    box.scrollTop += offset(reading) - 10;
    growing.style.height = `${160 + box.clientHeight - 10 - offset(quote)}px`;
    await bindReading(reading);
    assert.closeTo(offset(quote), box.clientHeight - 10, 1);
    assert.isAbove(
      quote.getBoundingClientRect().bottom,
      box.getBoundingClientRect().bottom,
    );
    const before = offset(reading);
    const beforeTop = box.scrollTop;

    withScrollGuard(box, key, () => {
      growing.style.height = `${Number.parseFloat(growing.style.height) + 100}px`;
    });
    await settle();

    assert.closeTo(offset(reading), before, 1);
    assert.closeTo(box.scrollTop, beforeTop, 1);
    assert.equal(getChatScrollSnapshot(key, box)?.mode, "manual");
  });

  it("anchors the visible final passage after its matching activity text is collapsed", async function () {
    const trace = doc.createElement("details") as HTMLDetailsElement;
    trace.className = "llm-agent-activity-details";
    trace.open = true;
    const summary = doc.createElement("summary");
    summary.textContent = "Working";
    const inline = doc.createElement("div");
    inline.className = "llm-agent-inline-text";
    const answer = doc.createElement("div");
    answer.className = "llm-assistant-answer";
    answer.hidden = true;
    for (let index = 0; index < 15; index++) {
      const text = `Passage ${index + 1}. The same answer can appear in activity while it is generated and in the final response when the work completes. Keep the passage being read at its original position.`;
      inline.appendChild(paragraph(text));
      answer.appendChild(paragraph(text));
    }
    trace.append(summary, inline);
    wrapper.append(spacer(900), trace, answer, spacer(1000));
    const traceReading = inline.querySelectorAll("p")[7];
    const finalReading = answer.querySelectorAll("p")[7];
    await bindReading(traceReading);
    const before = offset(traceReading);
    assert.equal(getChatScrollSnapshot(key, box)?.anchor?.kind, "answerBlock");

    withScrollGuard(box, key, () => {
      trace.open = false;
      summary.textContent = "Worked for 12s";
      answer.hidden = false;
    });
    await settle();

    // Gecko may retain a nonzero cached rect under closed native details.
    assert.isFalse(trace.open);
    assert.isAbove(finalReading.getBoundingClientRect().height, 0);
    assert.closeTo(offset(finalReading), before, 1);
    assert.equal(getChatScrollSnapshot(key, box)?.mode, "manual");
  });
});
