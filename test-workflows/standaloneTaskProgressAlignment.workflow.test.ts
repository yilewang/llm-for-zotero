import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: standalone Task progress alignment", function () {
  this.timeout(120000);
  const prefs: Array<[string, unknown]> = [
    ["extensions.zotero.llmforzotero.enableAgentMode", true],
    ["extensions.zotero.llmforzotero.lastUsedRuntimeMode", "agent"],
  ];
  const saved = new Map<string, unknown>();
  let api: WorkflowTestApi;
  let paper: Awaited<ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>>;

  async function until(check: () => boolean, message: string) {
    const deadline = Date.now() + 15000;
    while (!check() && Date.now() < deadline) await Zotero.Promise.delay(25);
    assert.isTrue(check(), message);
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    for (const [name, value] of prefs) {
      saved.set(name, Zotero.Prefs.get(name, true));
      Zotero.Prefs.set(name, value as never, true);
    }
    paper = await api.createPaperWithPdfFixture({
      title: "Place cells in a familiar arena",
      pdfTitle: "Place cells in a familiar arena",
      pages: ["Place cell evidence."],
    });
  });

  after(async function () {
    await api.closeStandalone().catch(() => undefined);
    await api.reset();
    if (paper) await api.cleanupFixture(paper);
    for (const [name, value] of saved) {
      if (value === undefined) Zotero.Prefs.clear(name, true);
      else Zotero.Prefs.set(name, value as never, true);
    }
  });

  // In the standalone window the chat's header rows line up with the History
  // pane's rows: the title row with New chat, and the Task progress row with
  // Search history. These read the laid-out boxes of both columns.
  // The start page hides the chat's header; once a chat has turns the header
  // shows and the chat sits 5px higher, so each state is read on its own.
  describe("workflow: standalone Task progress lines up with the History pane", function () {
    const states: Array<[tab: "open" | "paper", withTurns: boolean]> = [
      ["open", false],
      ["paper", false],
      ["open", true],
      ["paper", true],
    ];
    for (const [tab, withTurns] of states) {
      it(`centres the rows on the History pane's rows (${tab === "open" ? "Library" : "Paper"} chat, ${withTurns ? "with turns" : "start page"})`, async function () {
        await api.openStandaloneForItem(paper.parentItemId);
        await api.resizeStandaloneWindow(900, 760);
        await api.clickStandaloneTab(tab);
        const win = (Zotero as any).LLMForZotero.data.standaloneWindow;
        const doc = win.document as Document;
        const root = () =>
          doc.querySelector(".llm-standalone-content #llm-main") as HTMLElement;
        await until(
          () =>
            root()?.dataset.conversationKind ===
            (tab === "open" ? "global" : "paper"),
          `the window shows the ${tab} chat`,
        );
        if (withTurns) {
          await api.seedTaskProgressConversation({
            surface: "standalone",
            turns: [
              {
                user: { text: "Explain representational drift in CA1" },
                answer: "Drift is a gradual change in which cells fire.",
                events: [
                  { type: "status", text: "Reading" },
                  { type: "final", text: "Drift is a gradual change." },
                ] as never,
              },
            ],
          });
          await api.reopenTaskProgressConversation({ surface: "standalone" });
        } else {
          await api.startNewStandaloneConversation();
        }
        await until(
          () => (root()?.dataset.startPageActive === "true") === !withTurns,
          withTurns
            ? "the chat shows its turns, not the start page"
            : "the chat shows the start page",
        );
        const curtain = () =>
          root().querySelector(".llm-task-progress-curtain") as HTMLElement;
        if (curtain().dataset.curtain !== "open") {
          (
            doc.querySelector(
              ".llm-standalone-content-title-actions .llm-standalone-icon-task-progress",
            ) as HTMLButtonElement
          ).click();
        }
        await until(() => {
          api.flushTaskProgress();
          return curtain().dataset.curtain === "open";
        }, "the Task progress row is down");
        await Zotero.Promise.delay(100);

        const navRows = (
          Array.from(
            doc.querySelectorAll(".llm-standalone-primary-nav button"),
          ) as HTMLElement[]
        ).filter((button) => button.getBoundingClientRect().height > 0);
        const [newChat, search] = navRows.map((button) =>
          button.getBoundingClientRect(),
        );
        const title = doc
          .querySelector(
            ".llm-standalone-content-wrapper > .llm-standalone-content-title",
          )!
          .getBoundingClientRect();
        const row = (
          root().querySelector("#llm-task-progress") as HTMLElement
        ).getBoundingClientRect();
        const mid = (rect: DOMRect) => (rect.top + rect.bottom) / 2;

        assert.closeTo(
          mid(title),
          mid(newChat),
          0.5,
          "the title row is centred on New chat",
        );
        assert.closeTo(
          mid(row),
          mid(search),
          0.5,
          "the Task progress row is centred on Search history",
        );
        assert.closeTo(
          row.height,
          search.height,
          0.5,
          "the Task progress row is as tall as Search history",
        );
      });
    }
  });

  // Task progress moved to the standalone window's side panel: its title row
  // ("Task progress" and |←) sits on the chat's title row, centred on the
  // chat's title buttons, and its questions start where that row ends. These
  // read the laid-out boxes of both columns.
  describe("workflow: the side panel's Task progress lines up with the chat's title row", function () {
    it("lines the in-chat row up with the title buttons, then the side panel title with them", async function () {
      await api.openStandaloneForItem(paper.parentItemId);
      await api.resizeStandaloneWindow(1100, 760);
      await api.clickStandaloneTab("open");
      const win = (Zotero as any).LLMForZotero.data.standaloneWindow;
      const doc = win.document as Document;
      const root = () =>
        doc.querySelector(".llm-standalone-content #llm-main") as HTMLElement;
      await until(
        () => root()?.dataset.conversationKind === "global",
        "the window shows Library chat",
      );
      await api.seedTaskProgressConversation({
        surface: "standalone",
        turns: [
          {
            user: { text: "Explain representational drift in CA1" },
            answer: "Drift is a gradual change in which cells fire.",
            events: [
              { type: "status", text: "Reading" },
              { type: "final", text: "Drift is a gradual change." },
            ] as never,
          },
        ],
      });
      await api.reopenTaskProgressConversation({ surface: "standalone" });
      const curtain = () =>
        root().querySelector(".llm-task-progress-curtain") as HTMLElement;
      if (curtain().dataset.curtain !== "open") {
        (
          doc.querySelector(
            ".llm-standalone-content-title-actions .llm-standalone-icon-task-progress",
          ) as HTMLButtonElement
        ).click();
      }
      await until(() => {
        api.flushTaskProgress();
        return curtain().dataset.curtain === "open";
      }, "the Task progress row is down in the chat");

      // In the chat, the card spans the chat's width, and its chevron and →|
      // sit under Export and Clear, at a wide window's chrome gap and at a
      // narrow one's.
      const centre = (rect: DOMRect) => (rect.left + rect.right) / 2;
      const rectOf = (selector: string, within: ParentNode = doc) =>
        within.querySelector(selector)!.getBoundingClientRect();
      for (const width of [1100, 500]) {
        await api.resizeStandaloneWindow(width, 760);
        await Zotero.Promise.delay(300);
        const label = `${width}px window`;
        const card = rectOf(".llm-task-progress-card", root());
        const chat = rectOf("#llm-chat-box", root());
        const actions = ".llm-standalone-content-title-actions";
        assert.closeTo(card.left, chat.left, 0.5, `${label}: card's left edge`);
        assert.closeTo(
          card.right,
          chat.right,
          0.5,
          `${label}: card's right edge`,
        );
        assert.closeTo(
          centre(rectOf(".llm-task-progress-chevron", root())),
          centre(rectOf(`${actions} .llm-standalone-icon-export`)),
          0.5,
          `${label}: the chevron sits under Export`,
        );
        assert.closeTo(
          centre(rectOf(".llm-task-progress-move", root())),
          centre(rectOf(`${actions} .llm-standalone-icon-clear`)),
          0.5,
          `${label}: →| sits under Clear`,
        );
        assert.isAtMost(
          rectOf(".llm-task-progress-move", root()).right,
          card.right - 1,
          `${label}: →| stays inside the card's border`,
        );
      }
      await api.resizeStandaloneWindow(1100, 760);
      await Zotero.Promise.delay(300);

      (root().querySelector(".llm-task-progress-move") as HTMLElement).click();
      const tab = () =>
        doc.querySelector(
          ".llm-standalone-side-panel-task-progress:not([hidden])",
        ) as HTMLElement | null;
      await until(() => {
        api.flushTaskProgress();
        return Boolean(
          tab()?.querySelector(".llm-task-progress-dock-question"),
        );
      }, "Task progress shows in the side panel with its question");
      await Zotero.Promise.delay(100);

      const mid = (rect: DOMRect) => (rect.top + rect.bottom) / 2;
      const title = doc
        .querySelector(
          ".llm-standalone-content-wrapper > .llm-standalone-content-title",
        )!
        .getBoundingClientRect();
      const buttons = (
        Array.from(
          doc.querySelectorAll(
            ".llm-standalone-content-title-actions > button",
          ),
        ) as HTMLElement[]
      )
        .filter((button) => !button.hidden)
        .map((button) => button.getBoundingClientRect());
      assert.isNotEmpty(buttons, "the chat's title row shows its buttons");
      const panel = tab()!;
      const label = panel
        .querySelector(".llm-task-progress-label")!
        .getBoundingClientRect();
      const back = panel
        .querySelector(".llm-task-progress-back")!
        .getBoundingClientRect();
      const question = panel
        .querySelector(".llm-task-progress-dock-question")!
        .getBoundingClientRect();

      for (const button of buttons) {
        assert.closeTo(
          mid(button),
          mid(title),
          0.5,
          "the chat's title buttons are centred in its title row",
        );
      }
      assert.closeTo(
        mid(label),
        mid(buttons[0]),
        0.5,
        "the Task progress title is centred on the chat's title buttons",
      );
      assert.closeTo(
        mid(back),
        mid(buttons[0]),
        0.5,
        "|← is centred on the chat's title buttons",
      );
      assert.closeTo(
        question.top,
        title.bottom,
        0.5,
        "the first question starts where the chat's title row ends",
      );
    });
  });
});
