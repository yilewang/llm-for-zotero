/**
 * In a paper chat, the chat's own paper leaves "In your library" for its own
 * "Cited" card; a paper added beside it stays a library row under its own
 * "Cited" line. Both list one block per passage the answer cites (numbered
 * as the answer's marks; a passage only quoted as a card has no number), one per sentence
 * that only names the paper, and the reads it did not cite folded under
 * "Read, not cited (n)" (never a read whose words are only its heading).
 * Each block's "Show in answer" lights, for a real mouse click, every
 * sentence that cites its passage (a citation listing several ids counts),
 * the passage's card, or the naming sentence, in the chat's drawer and in
 * the side panel tab.
 */
import { assert } from "chai";
import { buildQuoteCitation } from "../src/services/quotes/quoteCitations";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const QUESTION = "How stable are place fields over weeks?";
const QUOTE_A1 = "Place fields drift slowly over several weeks of recording.";
const QUOTE_A2 = "Population codes stay readable across the whole period.";
const QUOTE_B1 =
  "Tuning curves shift by a few centimetres between weekly sessions.";
const SENTENCE_A1 = "Place fields drift slowly over weeks.";
const SENTENCE_A1_AGAIN = "The drift is gradual across sessions.";
const SENTENCE_BOTH = "Tuning curves shift in both studies.";
const ANSWER = [
  "## Mechanisms",
  "",
  "Place fields drift slowly over weeks [[cite:A1]]. The drift is gradual across sessions [[cite:A1]].",
  "",
  "## Stability",
  "",
  "[[quote:A2]]",
  "",
  "As Quill et al. (2022) argued, downstream readouts adapt.",
  "",
  "## Open questions",
  "",
  "Tuning curves shift in both studies [[cite:A1,B1]]. Varga and Moll, 2021 reported that tuning curves shift. Quill et al. (2022) leave open why the shift happens.",
  ...Array.from(
    { length: 30 },
    (_, index) =>
      `Further discussion ${index + 1} follows, so the answer runs well past one screen of the chat.`,
  ),
].join("\n\n");
const TITLE_A = "Drift study one";
const TITLE_B = "Drift study two";
const NAMED = "Named in the answer, no passage";
/** What each list shows, in order: a passage's words, or a naming sentence. */
const EXPECTED = new Map([
  [
    TITLE_A,
    [
      QUOTE_A1,
      QUOTE_A2,
      "As Quill et al. (2022) argued, downstream readouts adapt.",
      "Quill et al. (2022) leave open why the shift happens.",
    ],
  ],
  [
    TITLE_B,
    [QUOTE_B1, "Varga and Moll, 2021 reported that tuning curves shift."],
  ],
]);
/** What "Show in answer" on each block lights: every sentence citing it. */
const LIGHTS = new Map([
  [QUOTE_A1, [SENTENCE_A1, SENTENCE_A1_AGAIN, SENTENCE_BOTH]],
  [QUOTE_A2, [QUOTE_A2]],
  [QUOTE_B1, [SENTENCE_BOTH]],
]);

describe("workflow: task progress library paper in the answer", function () {
  this.timeout(240000);
  const prefs: Array<[string, unknown]> = [
    ["extensions.zotero.llmforzotero.enableAgentMode", true],
    ["extensions.zotero.llmforzotero.lastUsedRuntimeMode", "agent"],
  ];
  const saved = new Map<string, unknown>();
  let api: WorkflowTestApi;
  let libraryID: number;
  let collection: Zotero.Collection;
  const fixtures: WorkflowTestFixture[] = [];
  let answerText = ANSWER;
  let citations: NonNullable<ReturnType<typeof buildQuoteCitation>>[] = [];

  async function until(
    check: () => boolean,
    message: string | (() => string),
    ms = 20000,
  ) {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await Zotero.Promise.delay(40);
    assert.isTrue(check(), typeof message === "function" ? message() : message);
  }

  async function libraryPaper(
    title: string,
    names: string[],
    year: string,
    pages: string[],
  ) {
    const fixture = await api.createPaperWithPdfFixture({
      title,
      pdfTitle: title,
      pages,
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

  /** Both papers read twice: a passage, and a read that is only a heading. */
  function ledger(runId: string) {
    const info = [
      [TITLE_A, "Quill et al.", "2022"],
      [TITLE_B, "Varga and Moll", "2021"],
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
          title: info[index][0],
          creator: info[index][1],
          year: info[index][2],
          text: "pdf_text",
          state: "read",
        })),
        reads: fixtures.flatMap((fixture) => {
          const key = `${libraryID}:${fixture.parentItemId}`;
          return [
            {
              key,
              callId: "l1",
              toolName: "library_retrieve",
              granularity: "passage",
              method: "bm25",
              label: "Abstract",
              snippet: "Drift grows slowly.",
            },
            {
              key,
              callId: "l1",
              toolName: "library_retrieve",
              granularity: "section",
              method: "bm25",
              label: "2 Results",
              snippet: "# 2 Results",
            },
          ];
        }),
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
    collection.name = `Library in answer ${Date.now()}`;
    await collection.saveTx();
    const a = await libraryPaper(TITLE_A, ["Quill", "Zou"], "2022", [
      `${TITLE_A}. ${QUOTE_A1} ${QUOTE_A2}`,
    ]);
    const b = await libraryPaper(TITLE_B, ["Varga", "Moll"], "2021", [
      `${TITLE_B}. ${QUOTE_B1}`,
    ]);
    citations = (
      [
        [QUOTE_A1, a, "(Quill, 2022)"],
        [QUOTE_A2, a, "(Quill, 2022)"],
        [QUOTE_B1, b, "(Varga and Moll, 2021)"],
      ] as const
    ).map(
      ([quote, fixture, label]) =>
        buildQuoteCitation({
          quoteText: quote,
          citationLabel: label,
          sourceMatchText: quote,
          sourceMatchKind: "exact",
          sourceMatchSource: "context-text",
          itemId: fixture.parentItemId,
          contextItemId: fixture.pdfAttachmentId,
        })!,
    );
    answerText = ANSWER.replaceAll("A1", citations[0].id)
      .replace("A2", citations[1].id)
      .replace("B1", citations[2].id);
  });

  after(async function () {
    await api.reset();
    for (const fixture of fixtures) await api.cleanupFixture(fixture);
    await collection?.eraseTx().catch(() => undefined);
    for (const [name, value] of saved) {
      if (value === undefined) Zotero.Prefs.clear(name, true);
      else Zotero.Prefs.set(name, value as never, true);
    }
  });

  /** The answer's heading above a sentence, found by the sentence's start. */
  function sectionOf(sentence: string): string {
    const start = answerText.indexOf(sentence.slice(0, 24));
    if (start < 0) return "<sentence not in the answer>";
    const headings = answerText.slice(0, start).match(/^## .+$/gm) || [];
    return (headings[headings.length - 1] || "").replace(/^## /, "");
  }

  const fold = (text: string) =>
    text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

  async function inspect(
    win: any,
    container: () => HTMLElement,
    chat: () => HTMLElement,
    answer: () => HTMLElement | undefined,
    label: string,
  ) {
    const doc = win.document as Document;
    const rowOf = (title: string) =>
      (
        Array.from(
          container().querySelectorAll(".llm-task-paper:not(.llm-task-source)"),
        ) as HTMLElement[]
      ).find((node) =>
        (
          node.querySelector(".llm-task-paper-title")?.textContent || ""
        ).includes(title),
      ) as HTMLElement | undefined;
    const citedCard = () =>
      container().querySelector(
        '.llm-task-card[data-card="cited"]',
      ) as HTMLElement | null;
    await until(() => {
      api.flushTaskProgress();
      return Boolean(rowOf(TITLE_B)) && Boolean(citedCard()?.offsetHeight);
    }, `${label}: the chat's paper shows its Cited card, the added paper its row`);
    const summary = () =>
      rowOf(TITLE_B)!.querySelector(".llm-task-paper-summary") as HTMLElement;
    if (summary().getAttribute("aria-expanded") !== "true") summary().click();
    /** Where each paper's list is: the card's body, or the row's details. */
    const listOf = (title: string) =>
      (title === TITLE_A
        ? citedCard()?.querySelector(".llm-task-cited-list")
        : rowOf(title)?.querySelector(".llm-task-paper-details")) as
        | HTMLElement
        | null
        | undefined;
    /** The list's blocks, not the folded reads. */
    const blocksOf = (title: string) =>
      (
        Array.from(
          listOf(title)?.querySelectorAll(".llm-task-cited-item") || [],
        ) as HTMLElement[]
      ).filter((node) => !node.closest(".llm-task-cited-fold-body"));
    await until(() => {
      api.flushTaskProgress();
      return [...EXPECTED.keys()].every(
        (title) => blocksOf(title).length === EXPECTED.get(title)!.length,
      );
    }, `${label}: both papers list their Cited blocks`);
    const lit = () =>
      Array.from(
        chat().querySelectorAll(
          ".llm-answer-quote-highlight, .llm-answer-quote-card",
        ),
      ) as HTMLElement[];
    // The link is looked up on each try: the list is built again when the
    // answer's citations settle (quote validation), as a person would see it.
    const realClick = async (current: () => HTMLElement) => {
      let x = 0;
      let y = 0;
      let hit: HTMLElement | null = null;
      let target = current();
      const deadline = Date.now() + 2000;
      do {
        target = current();
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
        : `covered by ${hit?.tagName}.${String(hit?.className).split(" ")[0]} at ${Math.round(x)},${Math.round(y)} (link ${JSON.stringify(target.getBoundingClientRect())})`;
    };
    // The answer's marks: each passage's number, by its id.
    const markNumbers = new Map<string, string>();
    for (const mark of Array.from(
      answer()?.querySelectorAll(".llm-paper-cite-mark") || [],
    ) as HTMLElement[]) {
      const ids = (mark.dataset.citationIds || "").split(" ");
      const numbers = (mark.dataset.citationNumbers || "").split(" ");
      ids.forEach((id, index) => markNumbers.set(id, numbers[index]));
    }
    const idOf = (words: string) =>
      citations.find((citation) => citation.quoteText === words)?.id || "";
    const results: Array<Record<string, unknown>> = [];
    for (const [title, expected] of EXPECTED) {
      const list = listOf(title)!;
      const blocks = blocksOf(title);
      const row = rowOf(title);
      const foldLine = list.querySelector(
        ".llm-task-cited-fold .llm-task-fold",
      ) as HTMLElement | null;
      const foldBody = list.querySelector(
        ".llm-task-cited-fold-body",
      ) as HTMLElement | null;
      // A row's guide line runs down from the middle of its check.
      const dot = row
        ?.querySelector(".llm-task-paper-dot")
        ?.getBoundingClientRect();
      const guide = list.getBoundingClientRect().left + 0.5;
      const structure = {
        ownRowListed: title === TITLE_A && Boolean(row),
        cardCounts:
          title === TITLE_A
            ? citedCard()!.querySelector(".llm-task-card-counts")?.textContent
            : null,
        guideOffset: dot
          ? Math.round((guide - (dot.left + dot.width / 2)) * 10) / 10
          : 0,
        headings: (
          Array.from(
            list.querySelectorAll(".llm-task-paper-turn"),
          ) as HTMLElement[]
        ).map((node) => node.textContent),
        blocks: blocks.map((block) => {
          const words =
            block.querySelector(".llm-task-paper-snippet")?.textContent || "";
          return {
            words,
            number:
              block.querySelector(".llm-task-cited-number")?.textContent ??
              null,
            // The number its marks in the answer show, for a cited passage.
            markNumber: markNumbers.get(idOf(words)) ?? null,
            named: block.classList.contains("llm-task-cited-named"),
            label:
              block.querySelector(".llm-task-paper-how")?.textContent || "",
            source: Boolean(block.querySelector(".llm-task-paper-open")),
            showInAnswer: Boolean(
              block.querySelector(".llm-task-cited-foot .llm-task-source-link"),
            ),
          };
        }),
        expected,
        fold: foldLine?.textContent || "",
        foldClosed: Boolean(foldBody?.hidden),
        headingOnlyShown: /2 Results/i.test(list.textContent || ""),
        oldWords: /Passages read|In the answer|Cited in answer/.test(
          list.textContent || "",
        ),
      };
      const clicks: Array<Record<string, unknown>> = [];
      for (let index = 0; index < blocks.length; index++) {
        const block = () => blocksOf(title)[index];
        const words =
          block().querySelector(".llm-task-paper-snippet")?.textContent || "";
        const wanted = (LIGHTS.get(words) || [words]).map((sentence) =>
          fold(sentence).slice(-20),
        );
        const link = () =>
          block().querySelector(
            ".llm-task-cited-foot .llm-task-source-link",
          ) as HTMLElement;
        answer()?.dispatchEvent(
          new win.MouseEvent("mousedown", { bubbles: true }),
        );
        await Zotero.Promise.delay(150);
        const box = chat().querySelector("#llm-chat-box") as HTMLElement;
        box.scrollTop = box.scrollHeight;
        await Zotero.Promise.delay(300);
        const where = await realClick(link);
        // An author-year mention draws as its own citation chip, outside
        // the lit words: the sentence's end is what must light.
        const wordsNow = () =>
          fold(
            lit()
              .map((node) => node.textContent || "")
              .join(""),
          );
        const deadline = Date.now() + 4000;
        while (
          !wanted.every((end) => wordsNow().includes(end)) &&
          Date.now() < deadline
        )
          await Zotero.Promise.delay(40);
        await Zotero.Promise.delay(1500);
        const visibleTop = () => {
          const title = box
            .closest(".llm-standalone-content-wrapper")
            ?.querySelector(":scope > .llm-standalone-content-title");
          return Math.max(
            box.getBoundingClientRect().top,
            title?.getBoundingClientRect().bottom ?? -Infinity,
          );
        };
        const rect = lit()[0]?.getClientRects()[0];
        const offset = rect ? Math.round(rect.top - visibleTop()) : null;
        clicks.push({
          words: words.slice(0, 40),
          where,
          lit: lit().length,
          inAnswer: Boolean(lit()[0]?.closest(".llm-assistant-answer")),
          wordsMatch: wanted.every((end) => wordsNow().includes(end)),
          litWords: wordsNow().slice(0, 160),
          wanted,
          offset,
          inView:
            offset !== null && offset >= 6 && offset < box.clientHeight / 2,
        });
      }
      results.push({ label, title, structure, clicks });
    }
    return results;
  }

  function assertRows(results: Array<Record<string, unknown>>) {
    const failures: unknown[] = [];
    for (const entry of results as any[]) {
      const { structure, clicks } = entry;
      const blocks = structure.blocks as any[];
      const ok =
        !structure.ownRowListed &&
        (entry.title !== TITLE_A || structure.cardCounts === "2") &&
        // The Cited card's header already says Cited; a library row says it.
        JSON.stringify(structure.headings) ===
          JSON.stringify(entry.title === TITLE_A ? [] : ["Cited"]) &&
        JSON.stringify(blocks.map((block) => block.words)) ===
          JSON.stringify(structure.expected) &&
        // A cited passage shows its marks' number; a card's, none.
        blocks.every((block) =>
          block.named
            ? block.number === null &&
              block.label === NAMED &&
              !block.source &&
              block.showInAnswer
            : block.number === block.markNumber &&
              block.source &&
              block.showInAnswer,
        ) &&
        blocks.some((block) => block.number !== null) &&
        Math.abs(structure.guideOffset) <= 1 &&
        structure.fold === "Read, not cited (1)" &&
        structure.foldClosed &&
        !structure.headingOnlyShown &&
        !structure.oldWords &&
        clicks.length === blocks.length &&
        clicks.every(
          (click: any) =>
            click.lit && click.inAnswer && click.wordsMatch && click.inView,
        );
      if (!ok) failures.push(entry);
    }
    assert.deepEqual(
      failures,
      [],
      `every paper lists its Cited blocks numbered as the answer's marks, and every Show in answer lights what cites it: ${JSON.stringify(results)}`,
    );
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

  it("lists Cited for the chat's paper and an added one, and lights what cites each, in the drawer and the side panel tab", async function () {
    const { win, root } = await standaloneChat();
    const runId = `tp-library-in-answer-${Date.now()}`;
    await api.seedTaskProgressConversation({
      surface: "standalone",
      turns: [
        {
          runId,
          user: {
            text: QUESTION,
            selectedCollectionContexts: [
              { collectionId: collection.id, name: collection.name, libraryID },
            ],
          },
          answer: answerText,
          quoteCitations: citations,
          events: [
            ledger(runId),
            { type: "message_delta", text: answerText },
            {
              type: "provider_event",
              providerType: "agent_run_stop",
              payload: { rule: "final_answer", status: "completed" },
            },
            { type: "final", text: answerText, quoteCitations: citations },
          ] as never,
        },
      ],
    });
    await api.reopenTaskProgressConversation({ surface: "standalone" });
    const answer = () =>
      Array.from(root().querySelectorAll(".llm-assistant-answer")).find(
        (node) => (node as HTMLElement).dataset.agentRunId === runId,
      ) as HTMLElement | undefined;
    await until(() => Boolean(answer()), "the answer shows");
    const drawer = await openDrawer(root);
    const inDrawer = await inspect(win, drawer, root, answer, "drawer");
    const tab = await dock(win, root);
    const inTab = await inspect(win, tab, root, answer, "side panel tab");
    assertRows([...inDrawer, ...inTab]);

    // A new "Show in answer" goes to its own sentence whatever moved the
    // chat since the last one: the jump-to-latest arrow, or nothing at all.
    const doc = win.document as Document;
    const box = () => root().querySelector("#llm-chat-box") as HTMLElement;
    const press = async (target: HTMLElement) => {
      target.scrollIntoView({ block: "center" });
      await Zotero.Promise.delay(100);
      const rect = target.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      win.windowUtils.sendMouseEvent("mousedown", x, y, 0, 1, 0);
      await Zotero.Promise.delay(30);
      win.windowUtils.sendMouseEvent("mouseup", x, y, 0, 1, 0);
    };
    const blocks = () =>
      (
        Array.from(
          tab().querySelectorAll(
            '.llm-task-card[data-card="cited"] .llm-task-cited-item',
          ),
        ) as HTMLElement[]
      ).filter((node) => !node.closest(".llm-task-cited-fold-body"));
    const litWords = () =>
      fold(
        (
          Array.from(
            root().querySelectorAll(
              ".llm-answer-quote-highlight, .llm-answer-quote-card",
            ),
          ) as HTMLElement[]
        )
          .map((node) => node.textContent || "")
          .join(""),
      );
    const show = async (index: number) => {
      const block = blocks()[index];
      const words =
        block.querySelector(".llm-task-paper-snippet")?.textContent || "";
      await press(block.querySelector(".llm-task-source-link") as HTMLElement);
      const wanted = fold((LIGHTS.get(words) || [words])[0]).slice(-20);
      await until(
        () => litWords().includes(wanted),
        `block ${index} lights its sentence`,
        5000,
      );
      await Zotero.Promise.delay(1500);
      const first = (
        root().querySelector(
          ".llm-answer-quote-highlight, .llm-answer-quote-card",
        ) as HTMLElement
      )?.getClientRects()[0];
      const offset = first
        ? Math.round(first.top - box().getBoundingClientRect().top)
        : null;
      return { index, offset, height: box().clientHeight };
    };
    const inView = (place: { offset: number | null; height: number }) =>
      place.offset !== null && place.offset >= 0 && place.offset < place.height;
    const steps: Array<Record<string, unknown>> = [];
    steps.push({ step: "first", ...(await show(0)) });
    const latest = () =>
      doc.querySelector("#llm-chat-latest") as HTMLElement | null;
    await until(
      () => Boolean(latest()) && latest()!.getBoundingClientRect().height > 0,
      "the jump-to-latest arrow shows away from the end",
    );
    await press(latest()!);
    await until(
      () => box().scrollTop + box().clientHeight >= box().scrollHeight - 2,
      "the arrow takes the chat to its end",
      5000,
    );
    await Zotero.Promise.delay(600);
    steps.push({ step: "after the arrow", ...(await show(3)) });
    steps.push({ step: "straight after", ...(await show(1)) });
    assert.isTrue(
      steps.every((place) => inView(place as never)),
      `each Show in answer brings its own sentence into view: ${JSON.stringify(steps)}`,
    );
  });
});
