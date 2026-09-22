import { assert } from "chai";
import { bindChatScrollLifecycle } from "../src/modules/contextPanel/chatScrollLifecycle";
import {
  clearChatScrollSnapshotsForTests,
  getChatScrollSnapshot,
} from "../src/modules/contextPanel/chatScrollSnapshots";
import { renderRenderedMarkdownInto } from "../src/modules/contextPanel/renderedMarkdown";
import {
  disposeStreamingMarkdown,
  renderStreamingMarkdownInto,
} from "../src/modules/contextPanel/streamingMarkdown";

describe("workflow: streaming transitions preserve the reading viewport", function () {
  this.timeout(30000);
  const key = 928409;
  const readingMarker = "Passage 027.";
  let doc: Document;
  let win: Window;
  let root: HTMLDivElement;
  let box: HTMLDivElement;
  let answer: HTMLDivElement;
  let release: (() => void) | undefined;
  const delay = (ms: number) => Zotero.Promise.delay(ms);
  const passage = (number: number) =>
    `Passage ${String(number).padStart(3, "0")}. A reader examines evidence in the middle of this long Codex response. New paragraphs arrive later, but the current paragraph must remain visible in the same place throughout rendering.`;
  const paragraphs = (first: number, last: number) =>
    Array.from({ length: last - first + 1 }, (_, index) =>
      passage(first + index),
    ).join("\n\n");
  const initialSource = paragraphs(1, 60);
  type View = {
    phase: string;
    top: number;
    height: number;
    offset: number | null;
    count: number;
    duplicates: string[];
    mode: string | undefined;
  };
  const view = (phase: string): View => {
    const blocks = Array.from(answer.querySelectorAll("p"));
    const texts = blocks.map((block) => block.textContent || "");
    const reading = blocks.find((block) =>
      block.textContent?.startsWith(readingMarker),
    );
    return {
      phase,
      top: box.scrollTop,
      height: box.scrollHeight,
      offset: reading
        ? reading.getBoundingClientRect().top - box.getBoundingClientRect().top
        : null,
      count: blocks.length,
      duplicates: texts
        .filter((text, index) => texts.indexOf(text) !== index)
        .map((text) => text.slice(0, 24)),
      mode: getChatScrollSnapshot(key, box)?.mode,
    };
  };
  async function readMiddle() {
    const reading = Array.from(answer.querySelectorAll("p")).find((block) =>
      block.textContent?.startsWith(readingMarker),
    )!;
    assert.exists(reading);
    box.dispatchEvent(new win.WheelEvent("wheel", { deltaY: -30 }));
    box.scrollTop +=
      reading.getBoundingClientRect().top -
      box.getBoundingClientRect().top -
      12;
    box.dispatchEvent(new win.Event("scroll"));
    await delay(250);
    const before = view("before");
    assert.equal(before.mode, "manual");
    assert.closeTo(before.offset!, 12, 1);
    return before;
  }

  beforeEach(async function () {
    clearChatScrollSnapshotsForTests();
    doc = Zotero.getMainWindow().document;
    win = doc.defaultView!;
    root = doc.createElement("div") as HTMLDivElement;
    root.id = "llm-main";
    root.dataset.itemId = String(key);
    root.style.cssText =
      "position:fixed;left:30px;top:30px;width:540px;height:340px;z-index:2147483647;background:white";
    box = doc.createElement("div") as HTMLDivElement;
    box.id = "llm-chat-box";
    box.style.cssText =
      "height:320px;width:520px;overflow:auto;overflow-anchor:none;font:14px/1.5 sans-serif";
    const message = doc.createElement("div");
    message.className = "llm-message-wrapper";
    Object.assign(message.dataset, {
      messageRole: "assistant",
      messageTimestamp: "1",
      messageAnchorKey: "stream-transition-response",
    });
    answer = doc.createElement("div") as HTMLDivElement;
    answer.className = "llm-agent-inline-text";
    message.appendChild(answer);
    box.appendChild(message);
    root.appendChild(box);
    doc.documentElement.appendChild(root);
    renderRenderedMarkdownInto(answer, initialSource, doc);
    release = bindChatScrollLifecycle(
      box,
      () => key,
      () => {},
    );
    await delay(250);
    assert.isAbove(box.scrollHeight, box.clientHeight + 2000);
  });

  afterEach(function () {
    release?.();
    release = undefined;
    if (answer) disposeStreamingMarkdown(answer);
    root?.remove();
  });

  async function transition(
    before: View,
    source: string,
    expectedCount: number,
    requireMultipleBatches = false,
  ) {
    const samples: View[] = [];
    const observer = new win.MutationObserver(() => {
      samples.push(view("render batch"));
    });
    observer.observe(answer, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    let batches = 0;
    let lastBatch = Date.now();
    try {
      renderStreamingMarkdownInto(answer, source, doc, () => {
        batches += 1;
        lastBatch = Date.now();
      });
      // A synchronous clear can clamp Gecko's scrollTop before the queued
      // guarded render ever runs. Measure that exact interval explicitly.
      samples.push(view("immediately after requesting stream"));
      const deadline = Date.now() + 10000;
      while (
        Date.now() < deadline &&
        (batches === 0 || Date.now() - lastBatch < 300)
      )
        await delay(25);
      samples.push(view("settled"));
      const diagnostic = JSON.stringify({ before, batches, samples });
      assert.isAbove(batches, 0, diagnostic);
      assert.isBelow(Date.now(), deadline, `render settles: ${diagnostic}`);
      assert.lengthOf(answer.querySelectorAll("p"), expectedCount, diagnostic);
      if (requireMultipleBatches)
        assert.isAtLeast(
          batches,
          2,
          `exercise the frame budget: ${diagnostic}`,
        );
      for (const sample of samples) {
        assert.isNotNull(
          sample.offset,
          `reading text stays present: ${diagnostic}`,
        );
        // The request itself must not empty the viewport and clamp its scroll.
        // Once rendering runs, Markdown wrappers can change paragraph margins;
        // preserve the visible reading offset across that legitimate reflow.
        if (sample.phase === "immediately after requesting stream")
          assert.closeTo(sample.top, before.top, 1, diagnostic);
        assert.closeTo(sample.offset!, before.offset!, 1, diagnostic);
        assert.equal(sample.mode, "manual", diagnostic);
        assert.isEmpty(sample.duplicates, `no duplicate tails: ${diagnostic}`);
        assert.include(
          [before.count, expectedCount],
          sample.count,
          `a rendered frame contains the old or complete new answer: ${diagnostic}`,
        );
      }
    } finally {
      observer.disconnect();
    }
  }

  it("keeps the visible paragraph when an existing rendered answer starts streaming", async function () {
    const before = await readMiddle();
    await transition(before, `${initialSource}\n\n${paragraphs(61, 75)}`, 75);
  });

  it("keeps a revised stream complete and stable while a large append spans render batches", async function () {
    // Establish a streaming target first; the next source deliberately revises
    // a paragraph below the viewport, invalidating the previous source prefix.
    let readyBatches = 0;
    let lastReadyBatch = Date.now();
    renderStreamingMarkdownInto(answer, initialSource, doc, () => {
      readyBatches += 1;
      lastReadyBatch = Date.now();
    });
    const readyDeadline = Date.now() + 5000;
    while (
      Date.now() < readyDeadline &&
      (readyBatches === 0 || Date.now() - lastReadyBatch < 300)
    )
      await delay(25);
    assert.isAbove(readyBatches, 0);
    assert.isBelow(Date.now(), readyDeadline, "initial stream settles");
    assert.lengthOf(answer.querySelectorAll("p"), 60);
    const before = await readMiddle();
    const revised = initialSource.replace(
      passage(55),
      passage(55).replace("examines evidence", "rechecks evidence"),
    );
    await transition(before, `${revised}\n\n${paragraphs(61, 300)}`, 300, true);
    assert.include(answer.textContent || "", "rechecks evidence");
  });
});
