import { assert } from "chai";
import {
  getModelEntryById,
  setModelProviderGroups,
} from "../src/utils/modelProviders";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";
import {
  installHeldChatProvider,
  type HeldChatProvider,
} from "./helpers/heldChatProvider";
import { typeAndSend } from "./helpers/sharedConversationStream";

/**
 * Sending a message from a chat panel follows the new turn: the new user
 * question and the streaming answer appear in view even when the reader had
 * scrolled up before sending. A reader who scrolls up while the answer streams
 * stays where they are.
 *
 * Runs in the real Zotero host against the real native sidebar panel and the
 * real send flow. Only the network is scripted (a held fake provider).
 */

declare const Zotero: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero.";
const API_BASE = "https://workflow-chat-send-follow.invalid/v1";
const GROUP_ID = "workflow-send-follow-group";
const ENTRY_ID = "workflow-send-follow-model";
const MODEL = "send-follow-model";
const SAVED_PREF_KEYS = [
  "modelProviderGroups",
  "modelProviderGroupsMigrationVersion",
  "lastUsedModelEntryId",
  "lastUsedRuntimeMode",
  "conversationSystem",
  "enableCodexAppServerMode",
  "enableClaudeCodeMode",
  "outputTokenAutoMigrationNoticePending",
  "sidebarLayout",
];

function toKey(value: unknown): number {
  const parsed = Math.floor(Number(value || 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

describe("workflow: sending a message follows the new turn", function () {
  this.timeout(120_000);

  let api: WorkflowTestApi;
  let provider: HeldChatProvider;
  const previousPrefs = new Map<string, unknown>();
  const fixtures: WorkflowTestFixture[] = [];
  const mainWin = () => Zotero.getMainWindow();
  const sidebarRoot = (): HTMLElement | null =>
    (mainWin()
      .document.getElementById("zotero-item-details")
      ?.querySelector(".llm-dedicated-chat-pane #llm-main") as HTMLElement) ||
    null;
  const sidebarBody = (): HTMLElement | null =>
    sidebarRoot()?.parentElement || null;

  async function until(
    check: () => boolean | Promise<boolean>,
    describe: () => string,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await Zotero.Promise.delay(50);
    }
    if (await check()) return;
    assert.fail(describe());
  }

  async function openSidebarPaperChat(itemId: number): Promise<void> {
    const win = mainWin();
    win.Zotero_Tabs?.select?.("zotero-pane");
    await win.ZoteroPane.selectItem(itemId);
    const details = win.document.getElementById("zotero-item-details");
    await until(
      () => Boolean(details?.querySelector(".llm-dedicated-chat-pane")),
      () => "native chat section is registered in the item pane",
    );
    const section = details.querySelector(".llm-dedicated-chat-pane");
    if (
      win.document.documentElement.getAttribute("data-llm-pane-view") !==
        "chat" ||
      details.sidenav._collapsed
    ) {
      const button = Array.from(
        details.sidenav.querySelectorAll("[data-pane]"),
      ).find(
        (node: any) => node.getAttribute("data-pane") === section.dataset.pane,
      ) as Element | undefined;
      assert.isOk(button, "the chat rail icon exists");
      button!.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, button: 0 }),
      );
    }
    await until(
      () => {
        const root = sidebarRoot();
        return Boolean(
          root?.dataset.handlersInitialized &&
          root.getBoundingClientRect().width > 0 &&
          toKey(root.dataset.basePaperItemId) === itemId,
        );
      },
      () => `the native sidebar chat for item ${itemId} is visible`,
    );
    if (sidebarRoot()!.dataset.conversationKind !== "paper") {
      (
        sidebarBody()!.querySelector("#llm-paper-chat-tab") as HTMLElement
      ).click();
    }
    await until(
      () =>
        sidebarRoot()?.dataset.conversationKind === "paper" &&
        toKey(sidebarRoot()?.dataset.itemId) > 0,
      () => "the sidebar shows Paper chat",
    );
  }

  async function waitForAnswer(key: number, text: string): Promise<void> {
    let last: unknown = null;
    await until(
      async () => {
        const state = await api.readChatTurnLifecycle(key);
        const assistant = [...state.memory]
          .reverse()
          .find((message) => message.role === "assistant");
        last = { requestPending: state.requestPending, assistant };
        return (
          !state.requestPending &&
          Boolean(assistant) &&
          assistant!.streaming !== true &&
          String(assistant!.text || "").includes(text)
        );
      },
      () => `conversation ${key} finishes an answer with "${text}"`,
      30_000,
    );
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero?.api?.workflowTest;
    assert.isOk(api, "workflow test API should be installed");
    for (const key of SAVED_PREF_KEYS) {
      previousPrefs.set(key, Zotero.Prefs.get(PREF_PREFIX + key, true));
    }
    provider = installHeldChatProvider(API_BASE);
    Zotero.Prefs.set(PREF_PREFIX + "sidebarLayout", "independent", true);
    Zotero.Prefs.set(PREF_PREFIX + "conversationSystem", "upstream", true);
    Zotero.Prefs.set(PREF_PREFIX + "enableCodexAppServerMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "enableClaudeCodeMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "lastUsedRuntimeMode", "chat", true);
    setModelProviderGroups([
      {
        id: GROUP_ID,
        authMode: "api_key",
        apiBase: API_BASE,
        apiKey: "workflow-dummy-key",
        providerProtocol: "openai_chat_compat",
        models: [
          {
            id: ENTRY_ID,
            model: MODEL,
            temperature: 0.3,
            outputTokenLimit: { mode: "auto" },
          },
        ],
      },
    ] as any);
    Zotero.Prefs.set(PREF_PREFIX + "lastUsedModelEntryId", ENTRY_ID, true);
    assert.isOk(getModelEntryById(ENTRY_ID), "fake model is configured");
  });

  after(async function () {
    provider?.restore();
    await api.reset();
    for (const [key, value] of previousPrefs) {
      if (value === undefined) Zotero.Prefs.clear(PREF_PREFIX + key, true);
      else Zotero.Prefs.set(PREF_PREFIX + key, value, true);
    }
  });

  beforeEach(async function () {
    await api.reset();
    api.enableLiveAgentSending();
    Zotero.Prefs.set(PREF_PREFIX + "lastUsedModelEntryId", ENTRY_ID, true);
  });

  afterEach(async function () {
    provider.failOpenStreams("workflow case ended");
    await Zotero.Promise.delay(300);
    for (const fixture of fixtures.splice(0)) {
      await api.cleanupFixture(fixture);
    }
    await api.reset();
  });

  /** A sidebar Paper chat with one long answer, and the reader's helpers. */
  async function openLongConversation(title: string, shortSecondTurn = false) {
    const longAnswer = Array.from(
      { length: 60 },
      (_, index) =>
        `Paragraph ${index + 1} SEND-FOLLOW-LONG: enough text to make the chat scroll.`,
    ).join("\n\n");
    const paper = await api.createPaperWithPdfFixture({
      title,
      pdfTitle: `${title} PDF`,
      pages: [`${title}: a short page about the scroll after a send.`],
    });
    fixtures.push(paper);
    await openSidebarPaperChat(paper.parentItemId);

    const seedQuestion = `${title} seed question`;
    typeAndSend(sidebarBody()!, seedQuestion);
    const seedStream = await provider.waitForStream(seedQuestion);
    seedStream.push(longAnswer);
    seedStream.finish();
    const key = toKey(sidebarRoot()?.dataset.itemId);
    await waitForAnswer(key, "Paragraph 60 SEND-FOLLOW-LONG");

    if (shortSecondTurn) {
      // A short latest answer, so a retry of it keeps the long turn above it.
      const secondQuestion = `${title} second question`;
      typeAndSend(sidebarBody()!, secondQuestion);
      const secondStream = await provider.waitForStream(secondQuestion);
      secondStream.push("SHORT-ORIGINAL answer.");
      secondStream.finish();
      await waitForAnswer(key, "SHORT-ORIGINAL");
    }

    const body = sidebarBody()!;
    const chatBox = body.querySelector("#llm-chat-box") as HTMLElement;
    const latest = body.querySelector("#llm-chat-latest") as HTMLButtonElement;
    const owner = body.ownerDocument.defaultView as any;
    assert.isAbove(
      chatBox.scrollHeight,
      chatBox.clientHeight + 200,
      "the chat is scrollable",
    );
    const gapToBottom = () =>
      chatBox.scrollHeight - chatBox.clientHeight - chatBox.scrollTop;
    const readerScrollsUp = async (top: number) => {
      chatBox.dispatchEvent(new owner.WheelEvent("wheel", { deltaY: -100 }));
      chatBox.scrollTop = top;
      chatBox.dispatchEvent(new owner.Event("scroll"));
      await Zotero.Promise.delay(400);
    };
    return { key, body, chatBox, latest, gapToBottom, readerScrollsUp };
  }

  it("scrolls to the new turn on send, keeps following, and lets the reader scroll away", async function () {
    const { key, body, chatBox, latest, gapToBottom, readerScrollsUp } =
      await openLongConversation("Send follow");

    // The reader scrolls to the middle: the panel leaves follow-bottom mode,
    // which shows as the jump-to-latest arrow.
    await readerScrollsUp(
      Math.floor((chatBox.scrollHeight - chatBox.clientHeight) / 2),
    );
    assert.isFalse(latest.hidden, "reading mid-chat shows the latest arrow");
    assert.isAbove(gapToBottom(), 100, "the reader is away from the bottom");

    // Sending moves the view to the new turn.
    const question = "Send follow second question FOLLOW-Q";
    typeAndSend(body, question);
    const stream = await provider.waitForStream(question);
    const userTurn = () => {
      const bubbles = Array.from(
        chatBox.querySelectorAll(".llm-bubble.user"),
      ) as HTMLElement[];
      return bubbles[bubbles.length - 1];
    };
    const inViewport = (element: Element) => {
      const box = chatBox.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      return rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1;
    };
    await until(
      () =>
        (userTurn()?.textContent || "").includes("FOLLOW-Q") &&
        gapToBottom() <= 1,
      () =>
        `the view follows the new question: ${JSON.stringify({
          gap: gapToBottom(),
          scrollTop: chatBox.scrollTop,
          scrollHeight: chatBox.scrollHeight,
        })}`,
      5_000,
    );
    assert.isTrue(inViewport(userTurn()), "the new user turn is in view");
    assert.isTrue(latest.hidden, "following hides the latest arrow");

    // Streaming keeps following.
    for (let n = 0; n < 6; n++) {
      stream.push(`Streamed paragraph ${n} FOLLOW-PART with more words.\n\n`);
      await Zotero.Promise.delay(150);
    }
    await until(
      () => (chatBox.textContent || "").includes("FOLLOW-PART"),
      () => "the streamed text shows",
    );
    await until(
      () => gapToBottom() <= 1,
      () => `streaming stays at the bottom: gap ${gapToBottom()}`,
    );

    // A reader who scrolls up during streaming stays put.
    await readerScrollsUp(Math.floor(chatBox.scrollTop / 2));
    const held = chatBox.scrollTop;
    assert.isAbove(gapToBottom(), 50, "the reader left the bottom");
    for (let n = 6; n < 12; n++) {
      stream.push(`Streamed paragraph ${n} FOLLOW-LATE with more words.\n\n`);
      await Zotero.Promise.delay(150);
      assert.closeTo(
        chatBox.scrollTop,
        held,
        2,
        `later chunks do not pull the reader down (chunk ${n})`,
      );
    }
    stream.finish();
    await waitForAnswer(key, "FOLLOW-LATE");
    await Zotero.Promise.delay(400);
    assert.closeTo(chatBox.scrollTop, held, 2, "the reader keeps their place");
  });

  it("scrolls to the retried answer, keeps following, and lets the reader scroll away", async function () {
    const { key, body, chatBox, latest, gapToBottom, readerScrollsUp } =
      await openLongConversation("Retry follow", true);

    // The reader scrolls to the middle: the latest arrow shows.
    await readerScrollsUp(
      Math.floor((chatBox.scrollHeight - chatBox.clientHeight) / 2),
    );
    assert.isFalse(latest.hidden, "reading mid-chat shows the latest arrow");
    assert.isAbove(gapToBottom(), 100, "the reader is away from the bottom");

    // The real Retry control on the latest answer, then the retry model menu.
    const retryButton = chatBox.querySelector(
      ".llm-retry-latest",
    ) as HTMLButtonElement | null;
    assert.isOk(retryButton, "the latest answer offers Retry");
    retryButton!.click();
    const menuOptions = () =>
      Array.from(
        body.querySelectorAll("#llm-retry-model-menu .llm-model-option"),
      ) as HTMLElement[];
    await until(
      () => menuOptions().some((node) => node.textContent?.includes(MODEL)),
      () => "the retry menu offers the fake model",
    );
    const requestsBefore = provider.streams.length;
    menuOptions()
      .find((node) => node.textContent?.includes(MODEL))!
      .click();
    const deadline = Date.now() + 20_000;
    while (provider.streams.length === requestsBefore) {
      if (Date.now() > deadline) assert.fail("the retry sent no request");
      await Zotero.Promise.delay(50);
    }
    const stream = provider.streams[provider.streams.length - 1];

    stream.push("RETRY-PART-ONE first words of the retried answer.\n\n");
    await until(
      () => (chatBox.textContent || "").includes("RETRY-PART-ONE"),
      () => "the retried answer starts to show",
    );
    await until(
      () => gapToBottom() <= 1,
      () =>
        `the view follows the retried answer: ${JSON.stringify({
          gap: gapToBottom(),
          scrollTop: chatBox.scrollTop,
          scrollHeight: chatBox.scrollHeight,
        })}`,
      5_000,
    );
    for (let n = 0; n < 6; n++) {
      stream.push(`Retried paragraph ${n} RETRY-PART with more words.\n\n`);
      await Zotero.Promise.delay(150);
    }
    await until(
      () => gapToBottom() <= 1,
      () => `the retry stays at the bottom: gap ${gapToBottom()}`,
    );

    // A reader who scrolls up during the retry stays put.
    await readerScrollsUp(Math.floor(chatBox.scrollTop / 2));
    const held = chatBox.scrollTop;
    assert.isAbove(gapToBottom(), 50, "the reader left the bottom");
    for (let n = 6; n < 12; n++) {
      stream.push(`Retried paragraph ${n} RETRY-LATE with more words.\n\n`);
      await Zotero.Promise.delay(150);
      assert.closeTo(
        chatBox.scrollTop,
        held,
        2,
        `later chunks do not pull the reader down (chunk ${n})`,
      );
    }
    stream.finish();
    await waitForAnswer(key, "RETRY-LATE");
    await Zotero.Promise.delay(400);
    assert.closeTo(chatBox.scrollTop, held, 2, "the reader keeps their place");
  });
});
