import { assert } from "chai";
import { bindActionSummaryDisclosureScroll } from "../src/modules/contextPanel/agentTrace/actionSummaryDisclosureScroll";
import { bindChatScrollLifecycle } from "../src/modules/contextPanel/chatScrollLifecycle";
import {
  clearChatScrollSnapshotsForTests,
  getChatScrollSnapshot,
  reconcileChatScroll,
  setFollowBottomChatScrollSnapshot,
} from "../src/modules/contextPanel/chatScrollSnapshots";

describe("workflow: action summary disclosure scroll", function () {
  this.timeout(30000);
  const key = 928402;
  let root: HTMLDivElement;
  let box: HTMLDivElement;
  let wrapper: HTMLDivElement;
  let release: (() => void) | undefined;
  let doc: Document;
  let win: Window;
  const settle = () => Zotero.Promise.delay(200);
  const offset = (element: Element) =>
    element.getBoundingClientRect().top - box.getBoundingClientRect().top;

  function addCard(count = 2): HTMLElement {
    // Exercise the production activation binding and scroll owner with real
    // Gecko disclosures. Importing the full card renderer pulls Zotero's skill
    // Markdown into scaffold test bundles, which cannot load those assets.
    const node = doc.createElement("section");
    const heading = doc.createElement("div");
    heading.textContent = "What this turn did";
    node.appendChild(heading);
    const list = doc.createElement("ul");
    list.className = "llm-agent-action-summary-list";
    if (count > 4) {
      const toggle = doc.createElement("button");
      toggle.className = "llm-agent-action-summary-toggle";
      toggle.textContent = "Show actions";
      list.hidden = true;
      bindActionSummaryDisclosureScroll(toggle);
      toggle.addEventListener("click", () => {
        list.hidden = !list.hidden;
        toggle.textContent = list.hidden ? "Show actions" : "Hide actions";
      });
      heading.appendChild(toggle);
    }
    for (let index = 0; index < count; index++) {
      const item = doc.createElement("li");
      const details = doc.createElement("details");
      details.className = "llm-agent-action-row";
      const summary = doc.createElement("summary");
      summary.textContent = `Ran command ${index + 1}`;
      summary.style.height = "32px";
      bindActionSummaryDisclosureScroll(summary);
      details.appendChild(summary);
      let built = false;
      details.addEventListener("toggle", () => {
        if (built || !details.open) return;
        built = true;
        const command = doc.createElement("pre");
        command.style.cssText = "line-height:20px;white-space:pre;margin:0";
        command.textContent = Array.from(
          { length: 30 },
          (_, line) => `echo "Action ${index + 1}, line ${line + 1}"`,
        ).join("\n");
        details.appendChild(command);
      });
      item.appendChild(details);
      list.appendChild(item);
    }
    node.appendChild(list);
    wrapper.appendChild(node);
    return node;
  }

  async function followBottom() {
    setFollowBottomChatScrollSnapshot(key, box);
    reconcileChatScroll(key, box);
    await settle();
    assert.equal(getChatScrollSnapshot(key, box)?.mode, "followBottom");
    assert.closeTo(box.scrollHeight - box.clientHeight - box.scrollTop, 0, 1);
  }

  beforeEach(async function () {
    clearChatScrollSnapshotsForTests();
    doc = Zotero.getMainWindow().document;
    win = doc.defaultView!;
    root = doc.createElement("div") as HTMLDivElement;
    root.id = "llm-main";
    root.dataset.itemId = String(key);
    root.style.cssText =
      "position:fixed;left:20px;top:20px;width:380px;height:340px;z-index:99999;background:white";
    box = doc.createElement("div") as HTMLDivElement;
    box.id = "llm-chat-box";
    box.style.cssText =
      "height:320px;width:360px;overflow:auto;overflow-anchor:none;font:14px/1.5 sans-serif";
    wrapper = doc.createElement("div") as HTMLDivElement;
    wrapper.className = "llm-message-wrapper";
    Object.assign(wrapper.dataset, {
      messageRole: "assistant",
      messageTimestamp: "1",
      messageAnchorKey: "action-summary-scroll",
    });
    const answer = doc.createElement("div");
    answer.className = "llm-assistant-answer";
    answer.style.height = "1200px";
    answer.textContent = "The answer precedes its action summary.";
    wrapper.appendChild(answer);
    box.appendChild(wrapper);
    root.appendChild(box);
    doc.documentElement.appendChild(root);
    release = bindChatScrollLifecycle(
      box,
      () => key,
      () => {},
    );
    await settle();
    assert.isAbove(box.scrollHeight, box.clientHeight + 500);
  });

  afterEach(function () {
    release?.();
    release = undefined;
    root?.remove();
  });

  it("keeps the clicked row in place when opening and closing command details at the bottom", async function () {
    const card = addCard();
    await followBottom();
    const details = card.querySelector<HTMLDetailsElement>("details")!;
    const summary = details.querySelector<HTMLElement>("summary")!;
    const before = offset(summary);
    const initialHeight = box.scrollHeight;

    summary.dispatchEvent(
      new win.PointerEvent("pointerdown", { bubbles: true }),
    );
    summary.click();
    await settle();

    assert.isTrue(details.open);
    assert.isAbove(box.scrollHeight, initialHeight + 100);
    assert.equal(getChatScrollSnapshot(key, box)?.mode, "manual");
    assert.closeTo(offset(summary), before, 1);
    summary.click();
    await settle();
    assert.isFalse(details.open);
    assert.closeTo(offset(summary), before, 1);
  });

  it("preserves manual reading for a disclosure activation without pointerdown", async function () {
    const card = addCard();
    const tail = doc.createElement("div");
    tail.style.height = "700px";
    wrapper.appendChild(tail);
    const details = card.querySelector<HTMLDetailsElement>("details")!;
    const summary = details.querySelector<HTMLElement>("summary")!;
    box.dispatchEvent(new win.WheelEvent("wheel", { deltaY: -10 }));
    box.scrollTop += offset(summary) - 100;
    box.dispatchEvent(new win.Event("scroll"));
    await settle();
    const before = offset(summary);

    // Keyboard and assistive activation deliver a click without pointerdown.
    summary.click();
    await settle();
    assert.isTrue(details.open);
    assert.equal(getChatScrollSnapshot(key, box)?.mode, "manual");
    assert.closeTo(offset(summary), before, 1);
    summary.click();
    await settle();
    assert.isFalse(details.open);
    assert.closeTo(offset(summary), before, 1);
  });

  it("keeps the show/hide actions button fixed when a long action list changes height", async function () {
    const card = addCard(8);
    await followBottom();
    const toggle = card.querySelector<HTMLButtonElement>(
      ".llm-agent-action-summary-toggle",
    )!;
    const list = card.querySelector<HTMLElement>(
      ".llm-agent-action-summary-list",
    )!;
    const before = offset(toggle);
    const initialHeight = box.scrollHeight;

    toggle.click();
    await settle();
    assert.isFalse(list.hidden);
    assert.isAbove(box.scrollHeight, initialHeight + 100);
    assert.equal(getChatScrollSnapshot(key, box)?.mode, "manual");
    assert.closeTo(offset(toggle), before, 1);
    toggle.click();
    await settle();
    assert.isTrue(list.hidden);
    assert.closeTo(offset(toggle), before, 1);
  });

  it("continues following programmatic detail growth without a user activation", async function () {
    const card = addCard();
    await followBottom();
    const details = card.querySelector<HTMLDetailsElement>("details")!;
    const initialHeight = box.scrollHeight;

    details.open = true;
    await settle();

    assert.isAbove(box.scrollHeight, initialHeight + 100);
    assert.equal(getChatScrollSnapshot(key, box)?.mode, "followBottom");
    assert.closeTo(box.scrollHeight - box.clientHeight - box.scrollTop, 0, 1);
  });
});
