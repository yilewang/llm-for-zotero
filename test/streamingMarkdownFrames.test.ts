import { assert } from "chai";
import {
  disposeStreamingMarkdown,
  markStreamingEntrances,
  renderStreamingMarkdownInto,
  STREAMING_FADE_IN_MS,
} from "../src/modules/contextPanel/streamingMarkdown";
import { FakeElement } from "./helpers/fakeDom";

class StreamingElement extends FakeElement {
  get isConnected() {
    return true;
  }

  replaceWith(...elements: StreamingElement[]) {
    const parent = this.parentElement;
    if (!parent) return;
    for (const element of elements) parent.insertBefore(element, this);
    parent.removeChild(this);
  }
}

function htmlOf(element: FakeElement): string {
  return element.innerHTML + element.children.map(htmlOf).join("");
}

describe("streaming Markdown frame consistency", function () {
  const targets: HTMLElement[] = [];
  afterEach(function () {
    for (const target of targets.splice(0)) disposeStreamingMarkdown(target);
  });

  function fixture() {
    let handle = 0;
    let clock = [0];
    const frames = new Map<number, FrameRequestCallback>();
    const timers = new Map<number, () => void>();
    const doc = {
      createElement: (tag: string) => new StreamingElement(tag),
      querySelectorAll: () => [],
      defaultView: {
        performance: {
          now: () => (clock.length > 1 ? clock.shift()! : clock[0]),
        },
        requestAnimationFrame: (callback: FrameRequestCallback) => {
          frames.set(++handle, callback);
          return handle;
        },
        cancelAnimationFrame: (id: number) => frames.delete(id),
        setTimeout: (callback: () => void) => {
          timers.set(++handle, callback);
          return handle;
        },
        clearTimeout: (id: number) => timers.delete(id),
      },
    } as unknown as Document;
    const target = new StreamingElement("div") as unknown as HTMLElement;
    targets.push(target);
    let resized = 0;
    return {
      target,
      frames,
      timers,
      get resized() {
        return resized;
      },
      get html() {
        return htmlOf(target as unknown as FakeElement);
      },
      render(source: string) {
        renderStreamingMarkdownInto(target, source, doc, () => resized++);
      },
      flush(times = [0]) {
        clock = [...times];
        const callbacks = [...frames.values()];
        frames.clear();
        for (const callback of callbacks) callback(0);
      },
    };
  }

  it("never duplicates the preceding tail when the stable-block budget expires", function () {
    const view = fixture();
    view.render("Alpha");
    view.flush();
    assert.equal((view.html.match(/Alpha/g) || []).length, 1);

    view.render("Alpha\n\nBeta\n\nGamma");
    // The first stable block fits; the clock then forces the next iteration
    // to yield. This frame must replace the old Alpha tail after committing it.
    view.flush([0, 0, 9]);
    assert.equal((view.html.match(/Alpha/g) || []).length, 1);
    assert.equal((view.html.match(/Beta/g) || []).length, 1);
    assert.equal((view.html.match(/Gamma/g) || []).length, 1);
    assert.equal(view.resized, 2);
    assert.equal(view.frames.size, 1, "remaining stable work is deferred");

    view.flush();
    for (const text of ["Alpha", "Beta", "Gamma"]) {
      assert.equal((view.html.match(new RegExp(text, "g")) || []).length, 1);
    }
    assert.equal(view.frames.size, 0);
  });

  it("keeps the old rendered content until a non-prefix restart can replace it", function () {
    const view = fixture();
    view.render("Original passage");
    view.flush();
    const original = view.html;
    view.render("Original passage\n\nQueued obsolete continuation");
    view.render("Replacement passage\n\nNew continuation");
    assert.equal(view.html, original, "scheduling must not clear the viewport");
    view.flush();
    assert.include(view.html, "Replacement passage");
    assert.include(view.html, "New continuation");
    assert.notInclude(view.html, "Original passage");
    assert.notInclude(view.html, "Queued obsolete continuation");
    assert.equal(view.frames.size, 0);
  });

  it("keeps committed nodes and a complete tail across repeated slow frames and newer chunks", function () {
    const view = fixture();
    const words = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];
    view.render(words.slice(0, 4).join("\n\n"));
    // Even a lexer that consumes the budget must allow one stable token to
    // progress; otherwise every scheduled frame would defer the same work.
    view.flush([0, 9]);
    const stableFirst = view.target.firstChild;
    assert.isOk(stableFirst);
    view.render(words.join("\n\n"));
    let remainingFrames = 12;
    while (view.frames.size && remainingFrames-- > 0) {
      view.flush([0, 9]);
      assert.strictEqual(view.target.firstChild, stableFirst);
      for (const text of words) {
        assert.equal((view.html.match(new RegExp(text, "g")) || []).length, 1);
      }
    }
    assert.equal(view.frames.size, 0, "stable promotion eventually finishes");
    assert.equal(view.timers.size, 0);
  });

  it("can cancel a queued restart without removing the last complete render", function () {
    const view = fixture();
    view.render("Visible passage");
    view.flush();
    const visible = view.html;
    view.render("Cancelled replacement");
    disposeStreamingMarkdown(view.target);
    view.flush();
    assert.equal(view.html, visible);
    assert.equal(view.frames.size, 0);
    assert.equal(view.timers.size, 0);
  });

  it("keeps a streamed display equation whole when a line inside it looks like a list", function () {
    const view = fixture();
    const reply = "Expand:\n\n$$\na = b\n+ c\n- d\n$$\n\nSo $a$ grows.\n\nEnd.";
    for (let end = 1; end <= reply.length; end += 1) {
      view.render(reply.slice(0, end));
      view.flush();
    }
    assert.notInclude(
      view.html,
      "<li>",
      "no line of the equation became a list",
    );
    assert.include(view.html, "katex-display");
    assert.equal((view.html.match(/class="katex"/g) || []).length, 2);
  });

  it("renders an explicit empty restart in its scheduled frame", function () {
    const view = fixture();
    view.render("Visible passage");
    view.flush();
    view.render("");
    assert.include(view.html, "Visible passage");
    view.flush();
    assert.notInclude(view.html, "Visible passage");
    assert.equal(view.frames.size, 0);
  });
});

describe("streaming Markdown fade-in", function () {
  const FADE = "llm-streaming-fade-in";
  const blocks = (count: number) =>
    Array.from({ length: count }, () => new FakeElement("p"));
  const mark = (elements: FakeElement[], appeared: number[], now: number) =>
    markStreamingEntrances(
      elements as unknown as HTMLElement[],
      appeared,
      0,
      now,
    );

  it("fades a new block from the start", function () {
    const appeared: number[] = [];
    const [first] = blocks(1);
    mark([first], appeared, 1000);
    assert.isTrue(first.classList.contains(FADE));
    assert.equal(first.style.animationDelay, "0ms");
  });

  it("resumes a rebuilt block's fade instead of restarting it", function () {
    const appeared: number[] = [];
    mark(blocks(1), appeared, 1000);
    const [rebuilt, added] = blocks(2);
    mark([rebuilt, added], appeared, 1250);
    assert.equal(rebuilt.style.animationDelay, "-250ms");
    assert.equal(added.style.animationDelay, "0ms");
  });

  it("leaves a block alone once the reader has seen it fade in", function () {
    const appeared: number[] = [];
    mark(blocks(1), appeared, 1000);
    const [seen] = blocks(1);
    mark([seen], appeared, 1000 + STREAMING_FADE_IN_MS);
    assert.isFalse(seen.classList.contains(FADE));
  });

  it("drops the fade class when its own animation ends", function () {
    const [block] = blocks(1);
    const child = new FakeElement("span");
    mark([block], [], 1000);
    block.dispatchFakeEvent("animationend", { target: child } as never);
    assert.isTrue(
      block.classList.contains(FADE),
      "a child's animation bubbles",
    );
    block.dispatchFakeEvent("animationend");
    assert.isFalse(block.classList.contains(FADE));
    assert.equal(block.style.animationDelay, "");
  });
});
