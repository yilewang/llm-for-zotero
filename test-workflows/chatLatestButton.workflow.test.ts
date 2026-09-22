import { assert } from "chai";
import {
  bindChatLatestButton,
  createChatLatestButton,
} from "../src/modules/contextPanel/chatLatestButton";
import { bindChatScrollLifecycle } from "../src/modules/contextPanel/chatScrollLifecycle";
import {
  clearChatScrollSnapshotsForTests,
  getChatScrollSnapshot,
  reconcileChatScroll,
  scheduleChatScrollReconciliation,
  setFollowBottomChatScrollSnapshot,
} from "../src/modules/contextPanel/chatScrollSnapshots";
import { renderRenderedMarkdownInto } from "../src/modules/contextPanel/renderedMarkdown";
import {
  disposeStreamingMarkdown,
  renderStreamingMarkdownInto,
} from "../src/modules/contextPanel/streamingMarkdown";
import { setPendingRequestId } from "../src/modules/contextPanel/state";
import { t } from "../src/utils/i18n";

describe("workflow: latest message button and streaming scroll", function () {
  this.timeout(30000);
  const key = 928405;
  let doc: Document;
  let win: Window;
  let root: HTMLDivElement;
  let shell: HTMLDivElement;
  let box: HTMLDivElement;
  let button: HTMLButtonElement;
  let answer: HTMLDivElement;
  let tail: HTMLDivElement;
  let releaseScroll: (() => void) | undefined;
  let releaseButton: (() => void) | undefined;
  let jumps: number;
  const settle = () => Zotero.Promise.delay(350);
  const paragraphs = (count: number) =>
    Array.from(
      { length: count },
      (_, index) =>
        `Paragraph ${index + 1}. The reader can examine this earlier passage while more results arrive below. The latest message control must not move this passage or resize the conversation.`,
    ).join("\n\n");
  const offset = (element: Element) =>
    element.getBoundingClientRect().top - box.getBoundingClientRect().top;
  const addAnswer = (id: number, source: string) => {
    const wrapper = doc.createElement("div") as HTMLDivElement;
    wrapper.className = "llm-message-wrapper";
    wrapper.style.flexShrink = "0";
    Object.assign(wrapper.dataset, {
      messageRole: "assistant",
      messageTimestamp: String(id),
      messageAnchorKey: `latest-button-${id}`,
    });
    const content = doc.createElement("div") as HTMLDivElement;
    content.className = "llm-assistant-answer";
    wrapper.appendChild(content);
    box.appendChild(wrapper);
    renderRenderedMarkdownInto(content, source, doc);
    return content;
  };

  beforeEach(async function () {
    clearChatScrollSnapshotsForTests();
    setPendingRequestId(key, 0);
    doc = Zotero.getMainWindow().document;
    win = doc.defaultView!;
    root = doc.createElement("div") as HTMLDivElement;
    root.id = "llm-main";
    root.className = "llm-panel";
    root.dataset.itemId = String(key);
    root.style.cssText =
      "position:fixed;left:20px;top:20px;width:340px;height:360px;z-index:99999";
    shell = doc.createElement("div") as HTMLDivElement;
    shell.className = "llm-chat-shell";
    shell.style.cssText = "height:320px;min-height:320px;max-height:320px";
    box = doc.createElement("div") as HTMLDivElement;
    box.id = "llm-chat-box";
    box.className = "llm-messages";
    button = createChatLatestButton(doc);
    shell.append(box, button);
    root.appendChild(shell);
    doc.documentElement.appendChild(root);
    answer = addAnswer(1, paragraphs(25));
    tail = addAnswer(2, paragraphs(2));
    jumps = 0;
    releaseScroll = bindChatScrollLifecycle(
      box,
      () => key,
      () => {},
    );
    releaseButton = bindChatLatestButton({
      button,
      chatBox: box,
      getConversationKey: () => key,
      onJumpToLatest: () => {
        jumps++;
        setFollowBottomChatScrollSnapshot(key, box);
        scheduleChatScrollReconciliation(key, box);
      },
    });
    setFollowBottomChatScrollSnapshot(key, box);
    reconcileChatScroll(key, box);
    box.dispatchEvent(new win.Event("scroll"));
    await settle();
    assert.isAbove(box.scrollHeight, box.clientHeight + 1000);
  });

  afterEach(function () {
    releaseButton?.();
    releaseScroll?.();
    releaseButton = undefined;
    releaseScroll = undefined;
    disposeStreamingMarkdown(tail);
    setPendingRequestId(key, 0);
    root?.remove();
  });

  it("keeps manual reading stable, shows streaming activity, and resumes following on click", async function () {
    assert.isTrue(button.hidden);
    assert.equal(getChatScrollSnapshot(key, box)?.mode, "followBottom");
    const initialGeometry = {
      clientHeight: box.clientHeight,
      scrollHeight: box.scrollHeight,
    };
    const reading = answer.querySelectorAll("p")[10];
    box.dispatchEvent(new win.WheelEvent("wheel", { deltaY: -10 }));
    box.scrollTop += offset(reading) - 10;
    box.dispatchEvent(new win.Event("scroll"));
    await settle();
    const readingOffset = offset(reading);
    const readingTop = box.scrollTop;
    assert.equal(getChatScrollSnapshot(key, box)?.mode, "manual");
    assert.isFalse(button.hidden);
    assert.equal(box.clientHeight, initialGeometry.clientHeight);
    assert.equal(box.scrollHeight, initialGeometry.scrollHeight);

    setPendingRequestId(key, 7);
    await settle();
    assert.equal(button.dataset.pending, "true");
    assert.equal(
      button.getAttribute("aria-label"),
      t("Response in progress. Jump to latest message"),
    );
    const dots = button.querySelector<HTMLElement>(".llm-chat-latest-dots")!;
    const arrow = button.querySelector<HTMLElement>(".llm-chat-latest-arrow")!;
    assert.equal(win.getComputedStyle(dots).display, "flex");
    assert.equal(win.getComputedStyle(arrow).display, "none");
    assert.equal(win.getComputedStyle(button).position, "absolute");
    const buttonRect = button.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    assert.isAbove(buttonRect.width, 0);
    assert.isAtLeast(buttonRect.left, shellRect.left);
    assert.isAtMost(buttonRect.right, shellRect.right);
    assert.isAtLeast(buttonRect.top, shellRect.top);
    assert.isAtMost(buttonRect.bottom, shellRect.bottom);
    assert.equal(box.clientHeight, initialGeometry.clientHeight);
    assert.equal(box.scrollHeight, initialGeometry.scrollHeight);
    assert.closeTo(box.scrollTop, readingTop, 1);
    assert.closeTo(offset(reading), readingOffset, 1);

    for (const count of [5, 9, 14]) {
      renderStreamingMarkdownInto(tail, paragraphs(count), doc, () => {});
      await settle();
      assert.equal(getChatScrollSnapshot(key, box)?.mode, "manual");
      assert.closeTo(box.scrollTop, readingTop, 1);
      assert.closeTo(offset(reading), readingOffset, 1);
      assert.isFalse(button.hidden);
      assert.equal(button.dataset.pending, "true");
      assert.equal(box.clientHeight, initialGeometry.clientHeight);
    }
    assert.isAbove(box.scrollHeight, initialGeometry.scrollHeight);
    assert.equal(jumps, 0);

    setPendingRequestId(key, 0, 7);
    await settle();
    assert.isFalse(button.hidden);
    assert.equal(button.dataset.pending, "false");
    assert.equal(button.title, t("Jump to latest message"));
    assert.equal(win.getComputedStyle(dots).display, "none");
    assert.notEqual(win.getComputedStyle(arrow).display, "none");
    assert.closeTo(offset(reading), readingOffset, 1);

    button.click();
    await settle();
    assert.equal(jumps, 1);
    assert.equal(getChatScrollSnapshot(key, box)?.mode, "followBottom");
    assert.closeTo(box.scrollHeight - box.clientHeight - box.scrollTop, 0, 1);
    assert.isTrue(button.hidden);

    renderStreamingMarkdownInto(tail, paragraphs(19), doc, () => {});
    await settle();
    assert.equal(getChatScrollSnapshot(key, box)?.mode, "followBottom");
    assert.closeTo(box.scrollHeight - box.clientHeight - box.scrollTop, 0, 1);
    assert.isTrue(button.hidden);
    assert.equal(box.clientHeight, initialGeometry.clientHeight);
  });
});
