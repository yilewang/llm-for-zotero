/**
 * Moving Task progress from the chat's row to the standalone window's side
 * panel tab, and back, keeps the list as it was left: the same row at the
 * top, and the same questions and rows open.
 */
import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

const QUESTIONS = [
  "What mechanisms could cause representational drift?",
  "Which papers measure drift in hippocampus?",
  "How do readouts stay stable under drift?",
];

/** A question's run: a scholarly search that finds `count` papers. */
function turnEvents(turn: number, count: number) {
  const results = Array.from({ length: count }, (_, index) => {
    const doi = `10.1000/seamless.${turn}.${index}`;
    return {
      title: `Drift study ${turn + 1}.${index + 1} on representational stability`,
      authors: [`Author${turn}${index}`, "Coauthor"],
      year: 2020 + (index % 6),
      doi,
      openAccessUrl: `https://doi.org/${doi}`,
      sourceUrl: `https://openalex.org/W${4400000000 + turn * 100 + index}`,
      candidateIndex: index + 1,
    };
  });
  return [
    {
      type: "tool_call",
      callId: `s${turn}`,
      name: "literature_search",
      args: { query: `drift question ${turn + 1}` },
    },
    {
      type: "tool_result",
      callId: `s${turn}`,
      name: "literature_search",
      ok: true,
      content: { workflow: "answer", mode: "search", results },
    },
    { type: "final", text: answerOf(turn) },
  ];
}

/** An answer that cites the first eight papers, a sentence each. */
function answerOf(turn: number) {
  return Array.from(
    { length: 8 },
    (_, index) =>
      `Drift study ${turn + 1}.${index + 1} reports that representations change over days while behaviour stays stable (Author${turn}${index} et al., ${2020 + (index % 6)}; [link](https://doi.org/10.1000/seamless.${turn}.${index})).`,
  ).join("\n\n");
}

describe("workflow: task progress moves between the chat and the side panel tab as it was left", function () {
  this.timeout(180000);
  let api: WorkflowTestApi;
  let libraryID: number;
  let collection: Zotero.Collection;
  let fixture: Awaited<
    ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>
  >;
  const prefs: Array<[string, unknown]> = [
    ["extensions.zotero.llmforzotero.enableAgentMode", true],
    ["extensions.zotero.llmforzotero.lastUsedRuntimeMode", "agent"],
  ];
  const saved = new Map<string, unknown>();

  async function until(
    check: () => boolean,
    message: string | (() => string),
    ms = 20000,
  ) {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await Zotero.Promise.delay(40);
    assert.isTrue(check(), typeof message === "function" ? message() : message);
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    for (const [name, value] of prefs) {
      saved.set(name, Zotero.Prefs.get(name, true));
      Zotero.Prefs.set(name, value as never, true);
    }
    libraryID = Zotero.Libraries.userLibraryID;
    collection = new Zotero.Collection();
    (collection as { libraryID: number }).libraryID = libraryID;
    collection.name = `Seamless move ${Date.now()}`;
    await collection.saveTx();
    fixture = await api.createPaperWithPdfFixture({
      title: "Seamless move paper",
      pdfTitle: "Seamless move paper",
      pages: ["Drift."],
    });
  });

  after(async function () {
    await api.reset();
    if (fixture) await api.cleanupFixture(fixture);
    await collection?.eraseTx().catch(() => undefined);
    for (const [name, value] of saved) {
      if (value === undefined) Zotero.Prefs.clear(name, true);
      else Zotero.Prefs.set(name, value as never, true);
    }
  });

  it("keeps the row at the top and what is open, both ways", async function () {
    await api.openStandaloneForItem(fixture.parentItemId);
    await api.clickStandaloneTab("open");
    const win = (Zotero as any).LLMForZotero.data.standaloneWindow as any;
    const doc = win.document as Document;
    const root = () =>
      doc.querySelector(".llm-standalone-content #llm-main") as HTMLElement;
    await until(() => Boolean(root()), "the standalone window shows a chat");
    await api.seedTaskProgressConversation({
      surface: "standalone",
      turns: QUESTIONS.map((question, turn) => ({
        runId: `tp-seamless-${Date.now()}-${turn}`,
        user: {
          text: question,
          selectedCollectionContexts: [
            { collectionId: collection.id, name: collection.name, libraryID },
          ],
        },
        answer: answerOf(turn),
        events: turnEvents(turn, 14) as never,
      })),
    });
    await api.reopenTaskProgressConversation({ surface: "standalone" });

    const row = () =>
      root().querySelector("#llm-task-progress") as HTMLButtonElement | null;
    await until(() => {
      api.flushTaskProgress();
      return Boolean(row()) && !row()!.hidden;
    }, "the Task progress row shows");
    const chatDrawer = () =>
      root().querySelector("#llm-task-progress-drawer") as HTMLElement;
    if (chatDrawer().hidden) row()!.click();
    const docked = () =>
      doc.querySelector(".llm-task-progress-docked") as HTMLElement | null;

    // What the list shows, read from the page: which questions and rows are
    // open, and which header or row is at the top of the list and where.
    const listBody = (host: HTMLElement) =>
      host.querySelector(".llm-task-progress-drawer-body") as HTMLElement;
    const heads = (host: HTMLElement) =>
      Array.from(
        host.querySelectorAll(".llm-task-progress-dock-question"),
      ) as HTMLElement[];
    const rows = (host: HTMLElement) =>
      (
        Array.from(
          host.querySelectorAll(
            ".llm-task-progress-question-section li[data-key]",
          ),
        ) as HTMLElement[]
      ).filter((node) => node.getBoundingClientRect().height > 0);
    const folds = (host: HTMLElement) =>
      Array.from(
        host.querySelectorAll(".llm-task-fold-slot .llm-task-fold"),
      ) as HTMLElement[];
    const sectionOf = (node: HTMLElement) =>
      (node.closest("[data-section-id]") as HTMLElement | null)?.dataset
        .sectionId || "";
    const nameOf = (node: HTMLElement) =>
      node.matches("li")
        ? `${sectionOf(node)} row ${node.dataset.key}`
        : `${sectionOf(node)} head`;
    const state = (host: HTMLElement) => {
      const body = listBody(host);
      const top = body.getBoundingClientRect().top;
      const first = [...heads(host), ...rows(host)]
        .filter((node) => node.getBoundingClientRect().bottom > top + 1)
        .sort(
          (a, b) =>
            a.getBoundingClientRect().top - b.getBoundingClientRect().top,
        )[0];
      return {
        top: first ? nameOf(first) : "",
        offset: first ? Math.round(first.getBoundingClientRect().top - top) : 0,
        scrollTop: Math.round(body.scrollTop),
        questions: heads(host)
          .filter((head) => head.getAttribute("aria-expanded") === "true")
          .map((head) => sectionOf(head))
          .sort(),
        openFolds: folds(host)
          .filter((fold) => fold.getAttribute("aria-expanded") === "true")
          .map((fold) => sectionOf(fold))
          .sort(),
        openRows: rows(host)
          .filter(
            (node) =>
              node
                .querySelector(".llm-task-paper-summary")
                ?.getAttribute("aria-expanded") === "true",
          )
          .map(nameOf)
          .sort(),
      };
    };
    const scrollToMiddleRow = async (host: HTMLElement, pick: number) => {
      const body = listBody(host);
      const target = rows(host)[pick];
      assert.exists(
        target,
        `row ${pick} of ${rows(host).length} in ${host.className} (hidden ${host.hidden}, body ${listBody(host).clientHeight}px, docked ${Boolean(docked())}, li ${host.querySelectorAll("li").length}): ${JSON.stringify(state(host))}`,
      );
      body.scrollTop +=
        target.getBoundingClientRect().top -
        body.getBoundingClientRect().top -
        5;
      body.dispatchEvent(new win.Event("scroll"));
      await Zotero.Promise.delay(300);
    };
    const same = (
      label: string,
      before: ReturnType<typeof state>,
      after: ReturnType<typeof state>,
    ) => {
      const detail = `${label}: ${JSON.stringify({ before, after })}`;
      assert.equal(after.top, before.top, `the same row at the top, ${detail}`);
      assert.isAtMost(
        Math.abs(after.offset - before.offset),
        4,
        `at the same place, ${detail}`,
      );
      assert.deepEqual(
        after.questions,
        before.questions,
        `questions, ${detail}`,
      );
      assert.deepEqual(after.openFolds, before.openFolds, `folds, ${detail}`);
      assert.deepEqual(after.openRows, before.openRows, `open rows, ${detail}`);
    };

    // In the chat: every question unrolled, two rows of the middle one
    // opened, and the list scrolled to a row partway down.
    await until(() => {
      api.flushTaskProgress();
      // The Library chat may hold earlier tests' questions too.
      return QUESTIONS.every((question) =>
        heads(chatDrawer()).some((head) =>
          (head.textContent || "").includes(question),
        ),
      );
    }, "the chat's list shows each question");
    for (const head of heads(chatDrawer()))
      if (head.getAttribute("aria-expanded") !== "true") head.click();
    await Zotero.Promise.delay(300);
    api.flushTaskProgress();
    // Each question's papers sit in a fold ("14 found, none used").
    for (const fold of folds(chatDrawer()))
      if (fold.getAttribute("aria-expanded") !== "true") fold.click();
    await Zotero.Promise.delay(300);
    api.flushTaskProgress();
    const middle = rows(chatDrawer()).filter(
      (node) =>
        sectionOf(node) ===
        sectionOf(
          heads(chatDrawer()).find((head) =>
            (head.textContent || "").includes(QUESTIONS[1]),
          )!,
        ),
    );
    assert.isAtLeast(
      middle.length,
      6,
      `the middle question lists its papers: ${heads(chatDrawer())
        .map(
          (head) =>
            `${sectionOf(head)}=${rows(chatDrawer()).filter((node) => sectionOf(node) === sectionOf(head)).length}`,
        )
        .join(
          ", ",
        )}; ${(chatDrawer().querySelectorAll(".llm-task-progress-question-section")[1] as HTMLElement)?.outerHTML.replace(/<svg[^]*?<\/svg>/g, "").slice(0, 8000)}`,
    );
    for (const node of [middle[2], middle[5]])
      (node.querySelector(".llm-task-paper-summary") as HTMLElement).click();
    await Zotero.Promise.delay(300);
    api.flushTaskProgress();
    await scrollToMiddleRow(
      chatDrawer(),
      Math.floor(rows(chatDrawer()).length / 2),
    );
    const inChat = state(chatDrawer());
    assert.isAbove(inChat.scrollTop, 0, "the chat's list is scrolled");

    // →| : the side panel tab shows the list as the chat left it.
    (root().querySelector(".llm-task-progress-move") as HTMLElement).click();
    await until(() => {
      api.flushTaskProgress();
      return Boolean(docked()) && docked()!.getBoundingClientRect().width > 0;
    }, "Task progress shows in the side panel tab");
    await Zotero.Promise.delay(500);
    same("to the tab", inChat, state(docked()!));

    // In the tab: another row at the top, and one more row opened.
    const tabRows = rows(docked()!);
    (
      tabRows[1].querySelector(".llm-task-paper-summary") as HTMLElement
    ).click();
    await Zotero.Promise.delay(300);
    api.flushTaskProgress();
    await scrollToMiddleRow(docked()!, Math.floor(rows(docked()!).length / 3));
    const inTab = state(docked()!);

    // Move back to chat: the chat's card opens as the tab's list was left.
    (doc.querySelector(".llm-task-progress-back") as HTMLElement).click();
    await until(() => {
      api.flushTaskProgress();
      return (
        Boolean(row()) &&
        !row()!.hidden &&
        !chatDrawer().hidden &&
        listBody(chatDrawer()).clientHeight > 0
      );
    }, "the chat's card is back, open");
    await Zotero.Promise.delay(500);
    same("back to the chat", inTab, state(chatDrawer()));
  });
});
