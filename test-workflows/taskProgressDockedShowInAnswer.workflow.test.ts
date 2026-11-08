/**
 * "Show in answer" in Task progress moved to the standalone window's side
 * panel tab lights the answer's sentence in the chat beside it, for a real
 * mouse click on a scholarly paper's, a web page's and a library paper's row,
 * and on the paper chat's own paper in its "Cited" card. Scholarly papers and
 * web pages list the answer's sentences under "In the answer", as before;
 * library papers list them under "Cited".
 */
import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const SOURCES_QUESTION = "What mechanisms could cause representational drift?";
const FARROW_DOI = "10.1038/s00000-025-00001-x";
const JESSOP_DOI = "10.7554/sample.00001";
const ARDEN_DOI = "10.1101/2025.01.01.000001";
const LOWTHER_DOI = "10.1016/j.sample.2025.100001";
const SOURCES_ANSWER = [
  "## Mechanisms: two families",
  "",
  `On the learning side, Farrow et al. (2025) show that ongoing memory storage in synapses with limited capacity necessarily decorrelates sensory-driven activity patterns over time, giving drift as a consequence of overwriting rather than a separate process ([link](https://doi.org/${FARROW_DOI})); Jessop et al. (2024) derive drift from implicit regularization in a trained network ([link](https://doi.org/${JESSOP_DOI})). The strongest recent test is Arden et al. (2025), who used a multisensory virtual reality system to hold the sensory environment and behavior as reproducible as possible and found that differences in environment or behavior did not detectably change the drift rate of hippocampal place cells ([link](https://doi.org/${ARDEN_DOI})).`,
  "",
  `## What is preserved`,
  "",
  `In visual cortex, firing-rate codes drift while temporal spike sequences remain stable (Lowther-Gómez et al., 2025, *Cell Reports*; [link](https://doi.org/${LOWTHER_DOI})), which is a candidate answer to how a downstream reader could keep a fixed key. Continuous statistical learning may supply the **Hebbian** component that keeps representations moving.`,
].join("\n");
const paper = (
  title: string,
  authors: string[],
  year: number,
  doi: string,
  index: number,
) => ({
  title,
  authors,
  year,
  doi,
  openAccessUrl: `https://doi.org/${doi}`,
  sourceUrl: `https://openalex.org/W${4300000000 + index}`,
  candidateIndex: index,
});
const SOURCES_EVENTS = [
  {
    type: "tool_call",
    callId: "s1",
    name: "literature_search",
    args: { query: "representational drift mechanisms" },
  },
  {
    type: "tool_result",
    callId: "s1",
    name: "literature_search",
    ok: true,
    content: {
      workflow: "answer",
      mode: "search",
      results: [
        paper(
          "Code change caused by continuous memory writes",
          ["Federico Farrow", "Licheng Zou", "Gloria Cecchini", "Alex Roxin"],
          2025,
          FARROW_DOI,
          1,
        ),
        paper(
          "Code change as a side effect of hidden regularization",
          ["Aviv Jessop", "Dori Derdikman", "Omri Barak"],
          2024,
          JESSOP_DOI,
          2,
        ),
        paper(
          "Code change persists in steady sample environments",
          [
            "Jason R. Arden",
            "Heydar Davoudi",
            "Jun Young Oh",
            "Daniel A. Dombeck",
          ],
          2025,
          ARDEN_DOI,
          3,
        ),
        paper(
          "Rates change while spike order stays steady in a sample cortex model",
          ["Boris Lowther-Gómez", "Francesco P. Battaglia", "Martin Vinck"],
          2025,
          LOWTHER_DOI,
          4,
        ),
      ],
    },
  },
  {
    type: "tool_call",
    callId: "s2",
    name: "web_search",
    args: { query: "statistical learning representational drift" },
  },
];
/** Room under the cited sentences: the chat opens far below them. */
const LONG_ANSWER = [
  SOURCES_ANSWER,
  ...Array.from(
    { length: 30 },
    (_, index) =>
      `Further discussion ${index + 1} follows, so the answer runs well past one screen of the chat.`,
  ),
].join("\n\n");
/** The answer's marker after its last sentence: a web page. */
const SOURCES_ANCHOR_URL =
  "https://www.crm.cat/why-your-brain-is-never-still-representational-drift-and-statistical-learning/";
function sourcesFinal() {
  return {
    type: "final",
    text: LONG_ANSWER,
    webSourceAnchors: [
      {
        offset: SOURCES_ANSWER.length,
        sources: [
          {
            sourceId: "web_1",
            url: SOURCES_ANCHOR_URL,
            hostname: "crm.cat",
            organization: "Centre de Recerca Matemàtica",
            title:
              "Why Codes Keep Moving: Change and Learning in a Sample Essay",
          },
        ],
      },
    ],
  };
}

const LEAD =
  "I'll look outside the library for recent work on representational drift.";
/** The answer as it streams: the web source's marker still in its text. */
function streamedAnswer() {
  return `${SOURCES_ANSWER}<!--llm-web-source:web_1-->${LONG_ANSWER.slice(SOURCES_ANSWER.length)}`;
}

describe("workflow: task progress show in answer from the side panel tab", function () {
  this.timeout(180000);
  const prefs: Array<[string, unknown]> = [
    ["extensions.zotero.llmforzotero.enableAgentMode", true],
    ["extensions.zotero.llmforzotero.lastUsedRuntimeMode", "agent"],
  ];
  const saved = new Map<string, unknown>();
  let api: WorkflowTestApi;
  let libraryID: number;
  let collection: Zotero.Collection;
  const fixtures: WorkflowTestFixture[] = [];
  const report: Record<string, unknown> = {};

  async function until(
    check: () => boolean,
    message: string | (() => string),
    ms = 20000,
  ) {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await Zotero.Promise.delay(40);
    assert.isTrue(check(), typeof message === "function" ? message() : message);
  }

  async function libraryPaper(title: string, names: string[], year: string) {
    const fixture = await api.createPaperWithPdfFixture({
      title,
      pdfTitle: title,
      pages: [`${title}. Abstract. Drift.`],
    });
    fixtures.push(fixture);
    const item = Zotero.Items.get(fixture.parentItemId);
    item.setCreators(
      names.map((lastName) => ({
        firstName: "A.",
        lastName,
        creatorType: "author",
      })) as never,
    );
    item.setField("date", year);
    item.setCollections([collection.id]);
    await item.saveTx();
    return fixture;
  }

  /** The two library copies, read in the run: they list as library rows. */
  function ledger(runId: string) {
    const titles = [
      ["Code change caused by continuous memory writes", "Farrow et al."],
      ["Code change persists in steady sample environments", "Arden et al."],
    ];
    return {
      type: "paper_ledger_update",
      callId: "l1",
      delta: {
        version: 1,
        callId: "l1",
        runId,
        toolName: "library_retrieve",
        papers: fixtures.map((fixture, index) => ({
          key: `${libraryID}:${fixture.parentItemId}`,
          libraryID,
          itemId: fixture.parentItemId,
          contextItemId: fixture.pdfAttachmentId,
          title: titles[index][0],
          creator: titles[index][1],
          year: "2025",
          text: "pdf_text",
          state: "read",
        })),
        reads: fixtures.map((fixture) => ({
          key: `${libraryID}:${fixture.parentItemId}`,
          callId: "l1",
          toolName: "library_retrieve",
          granularity: "passage",
          method: "bm25",
          label: "Abstract",
          snippet: "Drift.",
        })),
      },
    };
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
    collection.name = `Docked show in answer ${Date.now()}`;
    await collection.saveTx();
    await libraryPaper(
      "Code change caused by continuous memory writes",
      ["Farrow", "Zou", "Cecchini", "Roxin"],
      "2025",
    );
    await libraryPaper(
      "Code change persists in steady sample environments",
      ["Arden", "Davoudi", "Oh", "Dombeck"],
      "2025",
    );
  });

  after(async function () {
    await api.reset();
    for (const fixture of fixtures) await api.cleanupFixture(fixture);
    await collection?.eraseTx().catch(() => undefined);
    for (const [name, value] of saved) {
      if (value === undefined) Zotero.Prefs.clear(name, true);
      else Zotero.Prefs.set(name, value as never, true);
    }
    await IOUtils.writeUTF8(
      `${Zotero.DataDirectory.dir}/tp-docked-report.json`,
      JSON.stringify(report, null, 2),
    );
  });

  /**
   * Click each kind of row's "Show in answer" in `container` with a real
   * mouse click, and log the way.
   */
  async function clickEach(
    win: any,
    container: () => HTMLElement,
    chat: () => HTMLElement,
    answer: () => HTMLElement | undefined,
    label: string,
  ) {
    const doc = win.document as Document;
    const trace: string[] = [];
    const EVENT = "llm-task-progress-show-in-answer";
    const tracer = (where: string) => (event: Event) => {
      const detail = (event as CustomEvent).detail;
      trace.push(
        `${where}:${event.type}${detail?.runId ? `(${detail.runId})` : ""}`,
      );
    };
    const onTab = tracer("list");
    const onChat = tracer("chat");
    container().addEventListener(EVENT, onTab);
    chat().addEventListener(EVENT, onChat);
    for (const type of ["mousedown", "mouseup", "click"])
      container().addEventListener(type, onTab, true);
    // The paper chat's own paper (Farrow et al.) is its "Cited" card.
    const rowsOf = (kind: string) =>
      Array.from(
        container().querySelectorAll(
          kind === "cited"
            ? '.llm-task-card[data-card="cited"]:not([hidden])'
            : kind === "library"
              ? ".llm-task-paper:not(.llm-task-source)"
              : `li.llm-task-source[data-kind="${kind}"]`,
        ),
      ).filter(
        (node) =>
          kind !== "library" ||
          /Code change caused|Code change persists/.test(
            node?.textContent || "",
          ),
      ) as HTMLElement[];
    await until(
      () => {
        api.flushTaskProgress();
        return (
          rowsOf("paper").length > 0 &&
          rowsOf("web").length > 0 &&
          rowsOf("library").length > 0 &&
          rowsOf("cited").length > 0
        );
      },
      () =>
        `${label}: the list shows papers and pages (${Array.from(
          container().querySelectorAll("li[data-kind]"),
        )
          .map((node) => (node as HTMLElement).dataset.kind)
          .join(", ")})`,
    );
    const lit = () =>
      Array.from(
        chat().querySelectorAll(".llm-answer-quote-highlight"),
      ) as HTMLElement[];
    const realClick = async (target: HTMLElement) => {
      // As a person clicks: on the link once it is on screen under the
      // pointer.
      let x = 0;
      let y = 0;
      let hit: HTMLElement | null = null;
      const deadline = Date.now() + 2000;
      do {
        target.scrollIntoView({ block: "center" });
        await Zotero.Promise.delay(100);
        const rect = target.getBoundingClientRect();
        x = rect.left + rect.width / 2;
        y = rect.top + rect.height / 2;
        hit = doc.elementFromPoint(x, y) as HTMLElement | null;
      } while (!(hit && target.contains(hit)) && Date.now() < deadline);
      win.windowUtils.sendMouseEvent("mousedown", x, y, 0, 1, 0);
      await Zotero.Promise.delay(30);
      win.windowUtils.sendMouseEvent("mouseup", x, y, 0, 1, 0);
      return hit && target.contains(hit)
        ? "on link"
        : `covered by ${hit?.tagName}.${String(hit?.className).split(" ")[0]}`;
    };
    const status = () =>
      (chat().querySelector("#llm-status") as HTMLElement | null)
        ?.textContent || "";
    const results: Array<Record<string, unknown>> = [];
    for (const kind of ["paper", "web", "library", "cited"]) {
      // A real mouse click also runs the click handler, so one path is enough.
      const how = "mouse";
      const rows = rowsOf(kind);
      if (!rows.length) {
        results.push({ label, kind, how, missing: true });
        continue;
      }
      const keyOf = (node: HTMLElement) =>
        node.dataset.key || node.dataset.card;
      const key = keyOf(rows[0])!;
      const byKey = () => rowsOf(kind).find((node) => keyOf(node) === key)!;
      const summary = () =>
        byKey().querySelector(
          kind === "cited" ? ".llm-task-card-head" : ".llm-task-paper-summary",
        ) as HTMLElement;
      if (summary().getAttribute("aria-expanded") !== "true") summary().click();
      const link = () =>
        byKey()?.querySelector(
          ".llm-task-source-link:not(.llm-task-source-open)",
        ) as HTMLElement | null;
      await until(() => {
        api.flushTaskProgress();
        return Boolean(link());
      }, `${label}: the ${kind} row shows Show in answer`);
      if (kind === "paper" || kind === "web") {
        assert.isOk(
          link()!.closest(".llm-task-source-quote"),
          `${label}: the ${kind} row lists the sentence under In the answer`,
        );
        assert.isNull(
          byKey().querySelector(".llm-task-cited-item"),
          `${label}: the ${kind} row lists nothing under Cited`,
        );
      } else {
        assert.isOk(
          link()!.closest(".llm-task-cited-named"),
          `${label}: the ${kind} paper lists the sentence that names it under Cited`,
        );
        assert.isNull(
          byKey().querySelector(".llm-task-source-quote"),
          `${label}: the ${kind} paper lists nothing under In the answer`,
        );
      }
      answer()?.dispatchEvent(
        new win.MouseEvent("mousedown", { bubbles: true }),
      );
      await Zotero.Promise.delay(150);
      // As after an answer: the chat at its end, following it.
      const box = chat().querySelector("#llm-chat-box") as HTMLElement;
      box.scrollTop = box.scrollHeight;
      await Zotero.Promise.delay(300);
      trace.length = 0;
      const before = link()!;
      const where = await realClick(before);
      // Something in the chat changes as the scroll starts (a message
      // still drawing, a chip that settles): the chat redoes its layout
      // while the scroll has not moved yet.
      win.requestAnimationFrame(() =>
        answer()?.classList.toggle("llm-workflow-test-nudge"),
      );
      const deadline = Date.now() + 3000;
      while (!lit().length && Date.now() < deadline)
        await Zotero.Promise.delay(40);
      // The scroll settles, and nothing pulls it back down.
      await Zotero.Promise.delay(1500);
      // What a reader sees of the chat starts below what covers its top:
      // the standalone window's title row runs over it.
      const visibleTop = () => {
        const title = box
          .closest(".llm-standalone-content-wrapper")
          ?.querySelector(":scope > .llm-standalone-content-title");
        return Math.max(
          box.getBoundingClientRect().top,
          title?.getBoundingClientRect().bottom ?? -Infinity,
        );
      };
      const firstLine = () => {
        const rect = lit()[0]?.getClientRects()[0];
        return rect ? Math.round(rect.top - visibleTop()) : null;
      };
      const offset = firstLine();
      // Something in the chat changes after the jump (a chip settles):
      // the chat redoes its layout and saves where the reader is.
      answer()?.classList.toggle("llm-workflow-test-nudge");
      await Zotero.Promise.delay(300);
      // Then the block just above the sentence changes height (a card or
      // a figure settling smaller): the sentence stays where it is.
      const start = lit()[0];
      const above = (
        Array.from(
          answer()?.querySelectorAll("h1, h2, h3, h4, p, li, pre, table") || [],
        ) as HTMLElement[]
      )
        .filter(
          (node) =>
            start &&
            !node.contains(start) &&
            Boolean(node.compareDocumentPosition(start) & 4),
        )
        .pop();
      if (above) {
        above.style.fontSize = "4px";
        above.style.lineHeight = "4px";
      }
      await Zotero.Promise.delay(600);
      const offsetAfterShrink = firstLine();
      if (above) {
        above.style.fontSize = "";
        above.style.lineHeight = "";
      }
      answer()?.classList.toggle("llm-workflow-test-nudge");
      await Zotero.Promise.delay(300);
      const shown = (value: number | null) =>
        value !== null && value >= 6 && value < box.clientHeight / 2;
      const answers = Array.from(
        chat().querySelectorAll(".llm-assistant-answer"),
      ).map((node) => (node as HTMLElement).dataset.agentRunId || "-");
      results.push({
        label,
        kind,
        how,
        where,
        // The answer's own words, not the trace's copy of them.
        inAnswer: Boolean(lit()[0]?.closest(".llm-assistant-answer")),
        linkReplaced: !before.isConnected,
        trace: trace.slice(),
        answers,
        lit: lit().length,
        offset,
        offsetAfterShrink,
        shrank: Boolean(above),
        inView: shown(offset) && shown(offsetAfterShrink),
        words: lit()
          .map((node) => node.textContent || "")
          .join("")
          .slice(0, 80),
        status: status(),
      });
    }
    container().removeEventListener(EVENT, onTab);
    chat().removeEventListener(EVENT, onChat);
    for (const type of ["mousedown", "mouseup", "click"])
      container().removeEventListener(type, onTab, true);
    return results;
  }

  async function standaloneChat() {
    await api.openStandaloneForItem(fixtures[0].parentItemId);
    await api.clickStandaloneTab("paper");
    const win = (Zotero as any).LLMForZotero.data.standaloneWindow as any;
    const root = () =>
      win.document.querySelector(
        ".llm-standalone-content #llm-main",
      ) as HTMLElement;
    await until(() => Boolean(root()), "the standalone window shows a chat");
    return { win, root };
  }

  async function openDrawer(root: () => HTMLElement) {
    const row = () =>
      root().querySelector("#llm-task-progress") as HTMLButtonElement;
    await until(() => {
      api.flushTaskProgress();
      return Boolean(row()) && !row().hidden;
    }, "the Task progress row shows");
    const drawer = () =>
      root().querySelector("#llm-task-progress-drawer") as HTMLElement;
    if (drawer().hidden) row().click();
    const head = () =>
      drawer().querySelector(
        ".llm-task-progress-dock-question",
      ) as HTMLButtonElement | null;
    await until(() => {
      api.flushTaskProgress();
      return Boolean(head());
    }, "the question lists");
    if (head()!.getAttribute("aria-expanded") !== "true") head()!.click();
    return drawer;
  }

  async function dock(win: any, root: () => HTMLElement) {
    const move = () =>
      root().querySelector(".llm-task-progress-move") as HTMLElement | null;
    await until(() => Boolean(move()), "the drawer offers to move to the side");
    // As a person clicks it: in the window in front, which gets its frames.
    win.focus();
    move()!.click();
    const docked = () =>
      win.document.querySelector(
        ".llm-task-progress-docked",
      ) as HTMLElement | null;
    await until(() => {
      api.flushTaskProgress();
      return Boolean(docked()) && docked()!.getBoundingClientRect().width > 0;
    }, "Task progress shows in the side panel tab");
    // The window widens for the panel one frame at a time: the tab is
    // clicked once it is inside.
    await until(
      () => docked()!.getBoundingClientRect().right <= win.innerWidth + 1,
      () =>
        `the window grows to hold the side panel tab (${Math.round(docked()!.getBoundingClientRect().right)} > ${win.innerWidth})`,
      15000,
    );
    const head = () =>
      docked()!.querySelector(
        ".llm-task-progress-dock-question",
      ) as HTMLButtonElement | null;
    await until(() => {
      api.flushTaskProgress();
      return Boolean(head());
    }, "the question lists in the tab");
    if (head()!.getAttribute("aria-expanded") !== "true") head()!.click();
    return () => docked()!;
  }

  const answerOf = (root: () => HTMLElement, runId: string) => () =>
    Array.from(root().querySelectorAll(".llm-assistant-answer")).find(
      (node) => (node as HTMLElement).dataset.agentRunId === runId,
    ) as HTMLElement | undefined;

  function assertAllLit(results: Array<Record<string, unknown>>) {
    report[String(results[0]?.label)] = results;
    const failed = results.filter(
      (entry) =>
        entry.missing || !entry.lit || !entry.inAnswer || !entry.inView,
    );
    assert.deepEqual(
      failed,
      [],
      `every Show in answer lights its sentence and brings it into view: ${JSON.stringify(results)}`,
    );
  }

  it("lights the sentence of a reopened chat, in the drawer and the side panel tab", async function () {
    const { win, root } = await standaloneChat();
    const runId = `tp-docked-${Date.now()}`;
    await api.seedTaskProgressConversation({
      surface: "standalone",
      turns: [
        {
          runId,
          user: {
            text: SOURCES_QUESTION,
            selectedCollectionContexts: [
              { collectionId: collection.id, name: collection.name, libraryID },
            ],
          },
          answer: LONG_ANSWER,
          // The answer streams after the last tool call with its web
          // source's marker, which the final text leaves out.
          // A first line taken back before the tools run, as a run's is:
          // the trace keeps it between tool calls.
          events: [
            { type: "message_delta", text: LEAD },
            { type: "message_rollback", length: LEAD.length, text: LEAD },
            ...SOURCES_EVENTS,
            ledger(runId),
            { type: "message_delta", text: streamedAnswer() },
            {
              type: "provider_event",
              providerType: "agent_run_stop",
              payload: { rule: "final_answer", status: "completed" },
            },
            sourcesFinal(),
          ] as never,
        },
      ],
    });
    await api.reopenTaskProgressConversation({ surface: "standalone" });
    const answer = answerOf(root, runId);
    await until(() => Boolean(answer()), "the answer shows");
    const drawer = await openDrawer(root);
    const inDrawer = await clickEach(
      win,
      drawer,
      root,
      answer,
      "reopened, drawer",
    );
    const tab = await dock(win, root);
    const inTab = await clickEach(win, tab, root, answer, "reopened, tab");
    assertAllLit(inDrawer);
    assertAllLit(inTab);
  });

  it("lights the sentence of an answer that just finished, in the drawer and the side panel tab", async function () {
    const { win, root } = await standaloneChat();
    const handle = await api.startTaskProgressReplay({
      surface: "standalone",
      historyTurns: 0,
      question: SOURCES_QUESTION,
      user: {
        selectedCollectionContexts: [
          { collectionId: collection.id, name: collection.name, libraryID },
        ],
      },
    });
    try {
      for (const event of SOURCES_EVENTS) await handle.emit(event as never);
      await handle.emit(ledger(handle.runId) as never);
      await handle.emit({
        type: "message_delta",
        text: SOURCES_ANSWER.slice(0, 40),
      } as never);
      await handle.emit(sourcesFinal() as never);
      await Zotero.Promise.delay(300);
      api.flushTaskProgress();
      const answer = answerOf(root, handle.runId);
      await until(
        () => Boolean(answer()),
        () =>
          `the live answer shows (answers: ${Array.from(
            root().querySelectorAll(".llm-assistant-answer"),
          )
            .map((node) => (node as HTMLElement).dataset.agentRunId || "-")
            .join(", ")}; run ${handle.runId})`,
      );
      const drawer = await openDrawer(root);
      const inDrawer = await clickEach(
        win,
        drawer,
        root,
        answer,
        "live, drawer",
      );
      const tab = await dock(win, root);
      const inTab = await clickEach(win, tab, root, answer, "live, tab");
      assertAllLit(inDrawer);
      assertAllLit(inTab);
    } finally {
      handle.finish();
    }
  });
});
