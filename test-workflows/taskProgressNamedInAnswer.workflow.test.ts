/**
 * "Named in the answer, no passage" in Task progress lights the answer's
 * sentence that names the paper, in the answer of the question it is listed
 * under (the paper chat's own paper lists it in its "Cited" card, a paper
 * added beside it in its row): the chat
 * shows "Bexley & Corwin (2025)" as a citation chip, so the sentence's
 * words are not the same as the answer's text, and a paper read again in a
 * later question still names the earlier answer's sentence. A passage the
 * answer quotes, with its citation on the line below, shows as a quote card:
 * the card lights.
 */
import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const BEXLEY = "Code change without weight updates";
const ASABUKI = "Code change from balanced learning rules in a sample network";
const FIRST = "What else is in my library on drift?";
const SECOND =
  "Can you also help me explain the concept of representational drift in the context of dynamical system?";
const FIRST_ANSWER =
  "Your collection has more. Bexley & Corwin (2025) show that drift can come from excitability alone, with fixed synapses.";
const SECOND_ANSWER = [
  "## The control-theoretic reading",
  "",
  "Once you have slow drift plus fast behaviour, the system is a closed loop. Homeostatic and predictive-plasticity mechanisms supply the feedback term: Hollis & Ingram (2026) derive drift as an intrinsic consequence of predictive excitatory–inhibitory plasticity, and Bexley & Corwin (2025) show drift arising from changes in neuronal excitability in a spike-coding autoencoder, without invoking synaptic weight change at all. So the slow variable can live in the weights, in the excitability, or in the E/I balance.",
].join("\n");
const THIRD = "What do Hollis and Ingram say, in their own words?";
const THIRD_ANSWER = [
  "They put it plainly:",
  "",
  "> Representational drift emerges as an intrinsic consequence of predictive excitatory-inhibitory plasticity, even when the inputs stay the same.",
  "",
  "(Hollis & Ingram, 2026)",
  "",
  "So drift does not need noisy inputs.",
].join("\n");

describe("workflow: task progress named in answer", function () {
  this.timeout(120000);
  const prefs: Array<[string, unknown]> = [
    ["extensions.zotero.llmforzotero.enableAgentMode", true],
    ["extensions.zotero.llmforzotero.lastUsedRuntimeMode", "agent"],
  ];
  const saved = new Map<string, unknown>();
  let api: WorkflowTestApi;
  let win: any;
  let libraryID: number;
  let bexley: WorkflowTestFixture;
  let hollis: WorkflowTestFixture;
  let collection: Zotero.Collection;
  const shots: string[] = [];
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

  function rootOf(panelId: string): HTMLElement {
    return win.document.querySelector(
      `[data-workflow-panel-id="${panelId}"]`,
    ) as HTMLElement;
  }

  /** Bring the synthetic panel on screen, as wide as the item pane. */
  function showOnScreen(panelId: string): () => void {
    const host = rootOf(panelId).closest(
      "[data-llm-workflow-test]",
    ) as HTMLElement;
    const previous = host.getAttribute("style");
    host.style.left = "0";
    host.style.width = "420px";
    host.style.height = "900px";
    host.style.zIndex = "99999";
    host.style.background = "var(--material-background, #fff)";
    return () => {
      if (previous === null) host.removeAttribute("style");
      else host.setAttribute("style", previous);
    };
  }

  async function capture(panelId: string, filename: string) {
    const rect = rootOf(panelId).getBoundingClientRect();
    const canvas = win.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas",
    );
    const scale = win.devicePixelRatio || 1;
    const width = Math.ceil(rect.width);
    const height = Math.ceil(rect.height);
    canvas.width = width * scale;
    canvas.height = height * scale;
    const context = canvas.getContext("2d");
    context.scale(scale, scale);
    context.drawWindow(win, rect.left, rect.top, width, height, "#ffffff");
    const binary = win.atob(canvas.toDataURL("image/png").split(",")[1]);
    const path = `${Zotero.DataDirectory.dir}/${filename}`;
    await win.IOUtils.write(
      path,
      Uint8Array.from(binary, (char: any) => char.charCodeAt(0)),
    );
    shots.push(path);
  }

  function delta(callId: string, runId: string) {
    const paper = (
      fixture: WorkflowTestFixture,
      title: string,
      creator: string,
      year: string,
    ) => ({
      key: `${libraryID}:${fixture.parentItemId}`,
      libraryID,
      itemId: fixture.parentItemId,
      contextItemId: fixture.pdfAttachmentId,
      title,
      creator,
      year,
      text: "pdf_text" as const,
      state: "read" as const,
    });
    return {
      version: 1 as const,
      callId,
      runId,
      toolName: "library_retrieve",
      papers: [
        paper(bexley, BEXLEY, "Bexley and Corwin", "2025"),
        paper(hollis, ASABUKI, "Hollis and Ingram", "2026"),
      ],
      reads: [bexley, hollis].map((fixture) => ({
        key: `${libraryID}:${fixture.parentItemId}`,
        callId,
        toolName: "library_retrieve",
        granularity: "passage" as const,
        method: "bm25",
        label: "Abstract",
        snippet: "Sample networks support steady behavior.",
      })),
    };
  }

  async function author(
    fixture: WorkflowTestFixture,
    names: string[],
    year: string,
  ) {
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
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    win = Zotero.getMainWindow();
    for (const [name, value] of prefs) {
      saved.set(name, Zotero.Prefs.get(name, true));
      Zotero.Prefs.set(name, value as never, true);
    }
    libraryID = Zotero.Libraries.userLibraryID;
    collection = new Zotero.Collection();
    (collection as { libraryID: number }).libraryID = libraryID;
    collection.name = `Named in answer ${Date.now()}`;
    await collection.saveTx();
    bexley = await api.createPaperWithPdfFixture({
      title: BEXLEY,
      pdfTitle: BEXLEY,
      pages: [`${BEXLEY}. Abstract. Sample networks support steady behavior.`],
    });
    hollis = await api.createPaperWithPdfFixture({
      title: ASABUKI,
      pdfTitle: ASABUKI,
      pages: [`${ASABUKI}. Abstract. Drift from predictive plasticity.`],
    });
    await author(bexley, ["Bexley", "Corwin"], "2025");
    await author(hollis, ["Hollis", "Ingram"], "2026");
  });

  after(async function () {
    await api.reset();
    await api.cleanupFixture(bexley);
    await api.cleanupFixture(hollis);
    await collection?.eraseTx().catch(() => undefined);
    for (const [name, value] of saved) {
      if (value === undefined) Zotero.Prefs.clear(name, true);
      else Zotero.Prefs.set(name, value as never, true);
    }
    report.shots = shots;
    // Zotero.debug does not reach the test runner's output: the report goes
    // to a file beside the screenshots.
    await win.IOUtils.writeUTF8(
      `${Zotero.DataDirectory.dir}/tp-named-report.json`,
      JSON.stringify(report, null, 2),
    );
  });

  it("lights the naming sentence in its own question's answer", async function () {
    const panel = await api.renderPanelForItem(bexley.parentItemId);
    const restore = showOnScreen(panel.panelId);
    const root = rootOf(panel.panelId);
    try {
      const scope = {
        selectedCollectionContexts: [
          { collectionId: collection.id, name: collection.name, libraryID },
        ],
      };
      const first = `tp-named-1-${Date.now()}`;
      const second = `tp-named-2-${Date.now()}`;
      const third = `tp-named-3-${Date.now()}`;
      await api.seedTaskProgressConversation({
        panelId: panel.panelId,
        turns: [
          {
            runId: first,
            user: { text: FIRST, ...scope },
            answer: FIRST_ANSWER,
            events: [
              {
                type: "paper_ledger_update",
                callId: "c1",
                delta: delta("c1", first),
              },
              // The run's answer, where Task progress finds the papers it names.
              { type: "final", text: FIRST_ANSWER },
            ],
          },
          {
            runId: second,
            user: { text: SECOND, ...scope },
            answer: SECOND_ANSWER,
            events: [
              {
                type: "paper_ledger_update",
                callId: "c2",
                delta: delta("c2", second),
              },
              // The run's answer, where Task progress finds the papers it names.
              { type: "final", text: SECOND_ANSWER },
            ],
          },
          {
            runId: third,
            user: { text: THIRD, ...scope },
            answer: THIRD_ANSWER,
            events: [
              {
                type: "paper_ledger_update",
                callId: "c3",
                delta: delta("c3", third),
              },
              { type: "final", text: THIRD_ANSWER },
            ],
          },
        ],
      });
      await api.reopenTaskProgressConversation({ panelId: panel.panelId });
      const row = () =>
        root.querySelector("#llm-task-progress") as HTMLButtonElement;
      await until(() => {
        api.flushTaskProgress();
        return Boolean(row()) && !row().hidden;
      }, "the Task progress row shows");
      const drawer = () =>
        root.querySelector("#llm-task-progress-drawer") as HTMLElement;
      if (drawer().hidden) row().click();
      const heads = () =>
        Array.from(
          root.querySelectorAll(".llm-task-progress-dock-question"),
        ) as HTMLButtonElement[];
      await until(
        () => {
          api.flushTaskProgress();
          return heads().length === 3;
        },
        () => `the three questions list (${heads().length})`,
      );
      for (const head of heads())
        if (head.getAttribute("aria-expanded") !== "true") head.click();
      await until(() => {
        api.flushTaskProgress();
        return heads().every(
          (head) => head.getAttribute("aria-expanded") === "true",
        );
      }, "the questions unroll");

      const answers = () =>
        Array.from(
          root.querySelectorAll(".llm-assistant-answer"),
        ) as HTMLElement[];
      const answerOf = (runId: string) =>
        answers().find((node) => node.dataset.agentRunId === runId);
      await until(
        () => Boolean(answerOf(first) && answerOf(second) && answerOf(third)),
        () =>
          `the answers show (${answers()
            .map((node) => node.dataset.agentRunId || "?")
            .join(", ")})`,
      );
      // The chat shows the author-year citations as chips.
      report.chips = [first, second].map(
        (runId) =>
          answerOf(runId)!.querySelectorAll(".llm-citation-inline-wrap").length,
      );

      const lit = () =>
        Array.from(
          root.querySelectorAll(
            ".llm-answer-quote-highlight, .llm-answer-quote-card",
          ),
        ) as HTMLElement[];
      const named = async (
        question: string,
        runId: string,
        starts: string,
        title = "Code change without",
      ) => {
        const section = heads()
          .find((head) => (head.textContent || "").includes(question))!
          .closest(".llm-task-progress-question-section") as HTMLElement;
        // The chat's own paper is its "Cited" card; another paper, its row.
        const own = title === "Code change without";
        const paper = (
          own
            ? section.querySelector('.llm-task-card[data-card="cited"]')
            : Array.from(section.querySelectorAll(".llm-task-paper")).find(
                (node) => (node?.textContent || "").includes(title),
              )
        ) as HTMLElement | null;
        assert.isOk(
          paper,
          `"${question}": "${title}" lists as used (section: ${(section.textContent || "").replace(/\s+/g, " ").slice(0, 300)})`,
        );
        assert.isFalse(
          own &&
            (
              Array.from(
                section.querySelectorAll(".llm-task-paper"),
              ) as HTMLElement[]
            ).some((node) => (node.textContent || "").includes(title)),
          `"${question}": the chat's own paper is not a row of In your library`,
        );
        const summary = paper!.querySelector(
          ".llm-task-paper-summary",
        ) as HTMLButtonElement | null;
        if (summary && summary.getAttribute("aria-expanded") !== "true")
          summary.click();
        const link = () =>
          paper!.querySelector(
            ".llm-task-cited-named .llm-task-cited-foot .llm-task-source-link",
          ) as HTMLElement | null;
        await until(() => {
          api.flushTaskProgress();
          return Boolean(link());
        }, `"${question}": the paper lists the naming sentence as named in the answer`);
        const block = link()!.closest(".llm-task-cited-named") as HTMLElement;
        assert.include(block.textContent || "", starts);
        assert.equal(
          block.querySelector(".llm-task-paper-how")?.textContent,
          "Named in the answer, no passage",
        );
        // As a person clicks: once the paper has unrolled.
        await Zotero.Promise.delay(500);
        link()!.click();
        await until(
          () => lit().length > 0,
          `"${question}": the naming sentence lights in the answer`,
          5000,
        );
        const text = lit()
          .map((node) => node.textContent || "")
          .join("");
        const owner = lit()[0].closest(".llm-assistant-answer") as HTMLElement;
        // Once the chat has scrolled to it, the sentence is in sight: not
        // under the open Task progress, the chips or the composer.
        await Zotero.Promise.delay(800);
        // Its first two lines, at both ends and the middle of each: nothing
        // floats on them (the chips, the jump-to-latest arrow).
        const lines = lit()
          .filter((node) =>
            node.matches(".llm-answer-quote-highlight, .llm-answer-quote-card"),
          )
          // A card's passage, as its words are read: not the card's box.
          .map(
            (node) =>
              (node.matches(".llm-quote-card")
                ? node.querySelector(
                    ".llm-quote-card-preview, .llm-quote-card-body",
                  )
                : null) || node,
          )
          .flatMap((node) => Array.from(node.getClientRects()))
          .filter((rect) => rect.width > 4)
          .sort((left, right) => left.top - right.top);
        const tops = [...new Set(lines.map((rect) => Math.round(rect.top)))];
        const misses: string[] = [];
        for (const top of tops.slice(0, 2)) {
          const row = lines.filter((rect) => Math.round(rect.top) === top);
          const left = Math.min(...row.map((rect) => rect.left));
          const right = Math.max(...row.map((rect) => rect.right));
          const y = row[0].top + row[0].height / 2;
          for (const x of [left + 4, (left + right) / 2, right - 4]) {
            const hit = win.document.elementFromPoint(x, y) as Element | null;
            // A lit chip inside the sentence is part of it.
            if (
              !hit ||
              !(
                lit().some((node) => node.contains(hit)) ||
                hit.closest(".llm-answer-quote-chip")
              )
            )
              misses.push(
                `(${Math.round(x)},${Math.round(y)}) ${hit ? `${hit.tagName}.${hit.className}` : "nothing"}`,
              );
          }
        }
        return {
          text,
          runId: owner?.dataset.agentRunId || "",
          card: lit()[0].matches(".llm-quote-card"),
          box: (() => {
            const own = lit()[0].getBoundingClientRect();
            const chat = (
              lit()[0].closest(".llm-messages") as HTMLElement | null
            )?.getBoundingClientRect();
            const arrow = root.querySelector(
              "#llm-chat-latest",
            ) as HTMLElement | null;
            const at = arrow?.getBoundingClientRect();
            const where = (rect?: DOMRect) =>
              rect
                ? `${Math.round(rect.left)},${Math.round(rect.top)}-${Math.round(rect.right)},${Math.round(rect.bottom)}`
                : "?";
            return `lit ${where(own)}; chat ${where(chat)}; arrow ${arrow?.hidden ? "hidden" : where(at)}`;
          })(),
          expected: runId,
          visible: misses.length === 0,
          hit: misses.join("; "),
          // Nothing seen floats on any of the lit text: the jump-to-latest
          // arrow, wherever it stands, is not on it.
          arrowOnLit: (() => {
            const arrow = root.querySelector(
              "#llm-chat-latest",
            ) as HTMLElement | null;
            if (
              !arrow ||
              arrow.hidden ||
              win.getComputedStyle(arrow).visibility === "hidden"
            )
              return false;
            const at = arrow.getBoundingClientRect();
            return lit().some((node) =>
              Array.from(node.getClientRects()).some(
                (rect) =>
                  rect.width > 0 &&
                  rect.left < at.right &&
                  rect.right > at.left &&
                  rect.top < at.bottom &&
                  rect.bottom > at.top,
              ),
            );
          })(),
          // Lit chips carry their own class, not the words' one.
          chips: owner.querySelectorAll(".llm-answer-quote-chip").length,
        };
      };

      const latest = await named(SECOND, second, "Homeostatic and predictive");
      report.latest = latest;
      assert.equal(latest.runId, second, "lit in the latest answer");
      assert.include(latest.text, "Homeostatic and predictive-plasticity");
      // Cut at "…arising fr…" in Task progress, lit to the sentence's end.
      assert.match(
        latest.text,
        /without invoking synaptic weight change at all\.$/,
      );
      await capture(panel.panelId, "tp-named-latest.png");
      assert.isFalse(
        latest.arrowOnLit,
        `the jump-to-latest arrow is not on the lit text (${latest.box})`,
      );
      assert.isTrue(
        latest.visible,
        `the lit sentence's first lines are in sight (covered at ${latest.hit})`,
      );

      const earlier = await named(FIRST, first, "Bexley & Corwin (2025)");
      report.earlier = earlier;
      assert.equal(earlier.runId, first, "lit in the first answer");
      assert.include(
        earlier.text,
        "show that drift can come from excitability",
      );
      // The chip that opens the sentence is lit with it.
      assert.isAtLeast(earlier.chips, 1, "the opening chip is lit");
      assert.isFalse(
        earlier.arrowOnLit,
        `the jump-to-latest arrow is not on the lit text (${earlier.box})`,
      );
      assert.isTrue(
        earlier.visible,
        `the earlier lit sentence's first lines are in sight (covered at ${earlier.hit})`,
      );

      // A quoted passage drawn as a quote card: the card lights.
      const quoted = await named(
        THIRD,
        third,
        "Representational drift emerges",
        "Code change from balanced learning",
      );
      report.quoted = quoted;
      assert.equal(quoted.runId, third, "lit in the third answer");
      assert.isTrue(quoted.card, "the quote card is what lights");
      assert.include(quoted.text, "intrinsic consequence of predictive");
      await capture(panel.panelId, "tp-named-card.png");
      assert.isFalse(
        quoted.arrowOnLit,
        `the jump-to-latest arrow is not on the lit text (${quoted.box})`,
      );
      assert.isTrue(
        quoted.visible,
        `the lit card is in sight (covered at ${quoted.hit})`,
      );

      // A sentence that is not in the answer: the answer shows, and a line
      // says so; the click never does nothing.
      const status = () =>
        root.querySelector("#llm-status")?.textContent?.trim() || "";
      const View = win.CustomEvent;
      heads()[0].dispatchEvent(
        new View("llm-task-progress-show-in-answer", {
          bubbles: true,
          detail: {
            runId: second,
            key: "missing",
            text: "A sentence that this answer never wrote, about nothing at all.",
          },
        }),
      );
      await until(
        () => /Couldn't find that sentence/.test(status()),
        () => `a missing sentence says so: status "${status()}"`,
        5000,
      );
      report.missing = status();
    } finally {
      restore();
      win.Zotero_Tabs?.select?.("zotero-pane");
    }
  });
});
