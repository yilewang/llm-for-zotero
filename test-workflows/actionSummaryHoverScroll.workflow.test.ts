import { assert } from "chai";
import { renderTargetChip } from "../src/modules/contextPanel/agentTrace/actionCardChips";
import { bindChatScrollLifecycle } from "../src/modules/contextPanel/chatScrollLifecycle";
import {
  clearChatScrollSnapshotsForTests,
  getChatScrollSnapshot,
  reconcileChatScroll,
  setFollowBottomChatScrollSnapshot,
} from "../src/modules/contextPanel/chatScrollSnapshots";

describe("workflow: action summary object hover scroll", function () {
  this.timeout(30000);
  const key = 928403;
  let root: HTMLDivElement;
  let box: HTMLDivElement;
  let targets: HTMLDivElement;
  let first: HTMLElement;
  let second: HTMLElement;
  let readingLine: HTMLElement;
  let release: (() => void) | undefined;
  let inspector: typeof InspectorUtils;
  let win: Window;
  const settle = () => Zotero.Promise.delay(200);
  const offset = (element: Element) =>
    element.getBoundingClientRect().top - box.getBoundingClientRect().top;

  beforeEach(async function () {
    clearChatScrollSnapshotsForTests();
    const doc = Zotero.getMainWindow().document;
    win = doc.defaultView!;
    inspector = (win as Window & { InspectorUtils: typeof InspectorUtils })
      .InspectorUtils;
    assert.isFunction(inspector?.addPseudoClassLock);
    root = doc.createElement("div") as HTMLDivElement;
    root.id = "llm-main";
    root.className = "llm-panel";
    root.dataset.itemId = String(key);
    root.style.cssText =
      "position:fixed;left:-10000px;top:0;width:600px;height:340px";
    box = doc.createElement("div") as HTMLDivElement;
    box.id = "llm-chat-box";
    box.className = "llm-messages";
    box.style.cssText = "height:320px;min-height:320px;max-height:320px";
    const wrapper = doc.createElement("div");
    wrapper.className = "llm-message-wrapper";
    wrapper.style.flexShrink = "0";
    Object.assign(wrapper.dataset, {
      messageRole: "assistant",
      messageTimestamp: "1",
      messageAnchorKey: "action-summary-hover",
    });
    const answer = doc.createElement("div");
    answer.className = "llm-assistant-answer";
    const spacer = doc.createElement("div");
    spacer.style.height = "1200px";
    readingLine = doc.createElement("p");
    readingLine.textContent = "The reading position stays fixed on hover.";
    answer.append(spacer, readingLine);
    const card = doc.createElement("section");
    card.className = "llm-plan-container llm-agent-action-summary-card";
    card.dataset.mode = "action";
    const row = doc.createElement("div");
    row.className = "llm-agent-action-summary-item";
    targets = doc.createElement("div") as HTMLDivElement;
    targets.className = "llm-agent-action-targets";
    first = renderTargetChip(doc, {
      kind: "collection",
      collectionId: 1,
      label: "Review notes",
    });
    second = renderTargetChip(doc, {
      kind: "collection",
      collectionId: 2,
      label: "Paper sources",
    });
    targets.append(first, second);
    row.appendChild(targets);
    card.appendChild(row);
    wrapper.append(answer, card);
    box.appendChild(wrapper);
    root.appendChild(box);
    doc.documentElement.appendChild(root);

    // Leave less room than the old 14 px hover glyph added. Production flex
    // wrapping then moves the second chip to a new line with the old CSS.
    const gap = Number.parseFloat(win.getComputedStyle(targets).columnGap);
    targets.style.width = `${Math.ceil(first.getBoundingClientRect().width + second.getBoundingClientRect().width + gap + 5)}px`;
    await settle();
    assert.closeTo(
      first.getBoundingClientRect().top,
      second.getBoundingClientRect().top,
      1,
      "both object chips initially fit on one line",
    );
    release = bindChatScrollLifecycle(
      box,
      () => key,
      () => {},
    );
    setFollowBottomChatScrollSnapshot(key, box);
    reconcileChatScroll(key, box);
    await settle();
  });

  afterEach(function () {
    if (first && inspector) inspector.removePseudoClassLock(first, ":hover");
    release?.();
    release = undefined;
    root?.remove();
  });

  it("keeps a wrapped-row boundary and the conversation still when a chip is hovered", async function () {
    const icon = first.querySelector<HTMLElement>(".llm-citation-icon")!;
    // Background test windows can throttle CSS animation frames. Check the
    // actual hover layout without depending on the opacity transition clock.
    icon.style.transition = "none";
    const before = {
      rowHeight: targets.getBoundingClientRect().height,
      chipWidth: first.getBoundingClientRect().width,
      scrollHeight: box.scrollHeight,
      top: box.scrollTop,
      readingOffset: offset(readingLine),
    };
    for (let visit = 0; visit < 3; visit++) {
      // Dispatching pointerenter alone never activates CSS :hover. Use the
      // Gecko inspector API so this exercises the actual production rule.
      inspector.addPseudoClassLock(first, ":hover");
      await settle();
      assert.equal(win.getComputedStyle(icon).opacity, "1");
      assert.closeTo(
        targets.getBoundingClientRect().height,
        before.rowHeight,
        1,
      );
      assert.closeTo(first.getBoundingClientRect().width, before.chipWidth, 1);
      assert.closeTo(box.scrollHeight, before.scrollHeight, 1);
      assert.closeTo(box.scrollTop, before.top, 1);
      assert.closeTo(offset(readingLine), before.readingOffset, 1);
      assert.equal(getChatScrollSnapshot(key, box)?.mode, "followBottom");
      inspector.removePseudoClassLock(first, ":hover");
      await settle();
      assert.equal(win.getComputedStyle(icon).opacity, "0");
      assert.closeTo(box.scrollTop, before.top, 1);
      assert.closeTo(offset(readingLine), before.readingOffset, 1);
    }
  });
});
