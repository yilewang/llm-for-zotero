import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

/**
 * A long conversation draws the messages at the reading position first and
 * the rest on later frames. The reader must not see the view move while the
 * rest arrives, and a saved position inside older messages must land.
 */
describe("workflow: long chat draws the reading position first", function () {
  this.timeout(180000);
  const turns = 60;
  let api: WorkflowTestApi;
  let fixture: Awaited<
    ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>
  > | null = null;
  let win: Window;
  let keyA = 0;
  let keyB = 0;

  const doc = () => win.document;
  const content = () =>
    doc().querySelector(".llm-standalone-content") as HTMLElement;
  const panelRoot = () =>
    content().querySelector("#llm-main") as HTMLElement | null;
  const chatBox = () =>
    content().querySelector("#llm-chat-box") as HTMLDivElement;
  const mountedKey = () => Number(panelRoot()?.dataset.itemId || 0);
  const wrappers = () =>
    Array.from(
      chatBox().querySelectorAll(".llm-message-wrapper[data-message-index]"),
    ) as HTMLElement[];
  const wrapperAt = (index: number) =>
    wrappers().find((node) => node.dataset.messageIndex === `${index}`) || null;
  const offsetInView = (element: Element) =>
    element.getBoundingClientRect().top - chatBox().getBoundingClientRect().top;
  const distanceFromBottom = () => {
    const box = chatBox();
    return box.scrollHeight - box.clientHeight - box.scrollTop;
  };
  const nextFrame = () =>
    new Promise<void>((resolve) => win.requestAnimationFrame(() => resolve()));
  const waitUntil = async (check: () => boolean, label: string) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (check()) return;
      await Zotero.Promise.delay(10);
    }
    assert.fail(`Timed out waiting for ${label}`);
  };
  const rowFor = (key: number) =>
    doc().querySelector<HTMLElement>(
      `.llm-standalone-conv-item[data-conversation-key="${key}"]`,
    );
  const answer = (marker: string, index: number) =>
    [
      `## ${marker} answer ${index}`,
      `The model is $E = mc^2$.`,
      "",
      "- point one with **bold** and `code`",
      "",
      "Body text. ".repeat(40),
    ].join("\n");
  const seed = (marker: string) =>
    Array.from({ length: turns }, (_, index) => [
      { role: "user" as const, text: `${marker} question ${index}` },
      { role: "assistant" as const, text: answer(marker, index) },
    ]).flat();
  const allDrawnInOrder = () => {
    const indices = wrappers().map((node) => Number(node.dataset.messageIndex));
    return (
      indices.length === turns * 2 &&
      indices.every((value, position) => value === position)
    );
  };
  const startNewChat = async () => {
    // An empty chat is already new; the button would keep it.
    if (mountedKey() > 0 && wrappers().length === 0) return;
    const before = mountedKey();
    doc()
      .querySelector<HTMLButtonElement>('[data-sidebar-action="new-chat"]')!
      .click();
    await waitUntil(
      () => mountedKey() > 0 && mountedKey() !== before,
      "a new chat mounts",
    );
  };
  /** Clicks a row; resolves on the first frame that shows the target. */
  const switchTo = async (key: number, marker: string, index: number) => {
    rowFor(key)!.click();
    while (
      !(
        mountedKey() === key &&
        (chatBox().textContent || "").includes(`${marker} answer ${index}`)
      )
    ) {
      await nextFrame();
    }
  };

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    fixture = await api.createPaperWithPdfFixture({
      title: "Progressive render",
      pdfTitle: "Progressive render PDF",
    });
    await api.openStandaloneForItem(fixture.parentItemId);
    win = (Zotero as any).LLMForZotero.data.standaloneWindow as Window;
    await api.clickStandaloneTab("open");
    // Both chats start new, so neither has a saved reading position from
    // an earlier test (the window opens on the last library chat).
    await startNewChat();
    await api.seedStandaloneConversation(seed("A"));
    keyA = mountedKey();
    await startNewChat();
    await api.seedStandaloneConversation(seed("B"));
    keyB = mountedKey();
    await waitUntil(() => Boolean(rowFor(keyA) && rowFor(keyB)), "rows");
    await waitUntil(allDrawnInOrder, "B fully drawn");
  });

  after(async function () {
    // Leave no long chat or saved older position for the next test: the
    // window reopens on the last library chat.
    if (win && !win.closed && chatBox()) {
      chatBox().scrollTop = chatBox().scrollHeight;
      await nextFrame();
      await Zotero.Promise.delay(150);
      await startNewChat();
    }
    await api.closeStandalone();
    await api.reset();
    if (fixture) await api.cleanupFixture(fixture);
  });

  it("keeps the newest message still while older messages fill in", async function () {
    await switchTo(keyA, "A", turns - 1);
    assert.isBelow(
      wrappers().length,
      turns * 2,
      "the first frame draws only part of a long chat",
    );
    const newest = wrapperAt(turns * 2 - 1)!;
    assert.isOk(newest, "the newest message is drawn first");
    const newestOffset = offsetInView(newest);
    let frames = 0;
    while (!allDrawnInOrder()) {
      assert.isAtMost(
        Math.abs(distanceFromBottom()),
        1,
        `frame ${frames}: the view stays at the bottom`,
      );
      assert.isAtMost(
        Math.abs(offsetInView(wrapperAt(turns * 2 - 1)!) - newestOffset),
        1,
        `frame ${frames}: the newest message does not move`,
      );
      assert.isBelow(frames, 600, "older messages finish drawing");
      frames += 1;
      await nextFrame();
    }
    assert.isAtMost(Math.abs(distanceFromBottom()), 1);
    assert.isAtMost(
      Math.abs(offsetInView(wrapperAt(turns * 2 - 1)!) - newestOffset),
      1,
    );
  });

  it("lands a saved position inside older messages", async function () {
    await waitUntil(allDrawnInOrder, "A fully drawn");
    // Read an old answer: put its top a little below the top edge.
    const targetIndex = 21;
    const box = chatBox();
    box.scrollTop += offsetInView(wrapperAt(targetIndex)!) - 40;
    // The scroll listener records the reader's position.
    await nextFrame();
    await nextFrame();
    await Zotero.Promise.delay(150);
    const savedOffset = offsetInView(wrapperAt(targetIndex)!);

    await switchTo(keyB, "B", turns - 1);
    await waitUntil(allDrawnInOrder, "B fully drawn");
    await switchTo(keyA, "A", targetIndex >> 1);
    const firstFrameTarget = wrapperAt(targetIndex);
    assert.isOk(firstFrameTarget, "the saved message is drawn first");
    assert.isAtMost(
      Math.abs(offsetInView(firstFrameTarget!) - savedOffset),
      2,
      "the saved position lands on the first frame",
    );
    assert.isBelow(wrappers().length, turns * 2, "the rest comes later");
    let frames = 0;
    while (!allDrawnInOrder()) {
      assert.isAtMost(
        Math.abs(offsetInView(wrapperAt(targetIndex)!) - savedOffset),
        2,
        `frame ${frames}: the read message does not move`,
      );
      assert.isBelow(frames, 600, "the rest finishes drawing");
      frames += 1;
      await nextFrame();
    }
    assert.isAtMost(
      Math.abs(offsetInView(wrapperAt(targetIndex)!) - savedOffset),
      2,
    );
  });
  it("draws an older turn before the turn rail jumps to it", async function () {
    await waitUntil(allDrawnInOrder, "A fully drawn");
    chatBox().scrollTop = chatBox().scrollHeight;
    await nextFrame();
    await Zotero.Promise.delay(150);
    await switchTo(keyB, "B", turns - 1);
    const firstMarker = () =>
      content().querySelector<HTMLButtonElement>(
        '.llm-turn-navigator-marker[data-turn-index="0"]',
      );
    await waitUntil(() => Boolean(firstMarker()), "turn markers");
    assert.isNull(
      wrapperAt(0),
      "the first turn is still waiting when the rail is used",
    );
    firstMarker()!.click();
    assert.isOk(wrapperAt(0), "the jump draws the first turn at once");
    assert.isTrue(allDrawnInOrder(), "every message is drawn in order");
    await waitUntil(
      () => Math.abs(offsetInView(wrapperAt(0)!)) <= 16,
      "the jump reaches the first turn",
    );
  });
});
