/**
 * "Show in answer" on the scholarly papers and web pages Task progress lists
 * lights the answer's sentence that uses each: around the "(link)" the answer
 * writes after a citation, the citation chips the chat draws in place of
 * "Farrow et al. (2025)", and the web marker at the sentence's end.
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
/** The answer's marker after its last sentence: a web page. */
const SOURCES_ANCHOR_URL =
  "https://www.crm.cat/why-your-brain-is-never-still-representational-drift-and-statistical-learning/";
function sourcesFinal() {
  return {
    type: "final",
    text: SOURCES_ANSWER,
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

describe("workflow: task progress show in answer for outside sources", function () {
  this.timeout(120000);
  const prefs: Array<[string, unknown]> = [
    ["extensions.zotero.llmforzotero.enableAgentMode", true],
    ["extensions.zotero.llmforzotero.lastUsedRuntimeMode", "agent"],
  ];
  const saved = new Map<string, unknown>();
  let api: WorkflowTestApi;
  let win: any;
  let libraryID: number;
  let collection: Zotero.Collection;
  const fixtures: WorkflowTestFixture[] = [];
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

  /** A library copy of a paper the answer cites: the chat draws it as a chip. */
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
    collection.name = `Show in answer ${Date.now()}`;
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
    report.shots = shots;
    await win.IOUtils.writeUTF8(
      `${Zotero.DataDirectory.dir}/tp-sources-report.json`,
      JSON.stringify(report, null, 2),
    );
  });

  it("lights each cited paper's and page's sentence", async function () {
    const panel = await api.renderPanelForItem(fixtures[0].parentItemId);
    const restore = showOnScreen(panel.panelId);
    const root = rootOf(panel.panelId);
    try {
      const runId = `tp-sources-${Date.now()}`;
      await api.seedTaskProgressConversation({
        panelId: panel.panelId,
        turns: [
          {
            runId,
            user: {
              text: SOURCES_QUESTION,
              selectedCollectionContexts: [
                {
                  collectionId: collection.id,
                  name: collection.name,
                  libraryID,
                },
              ],
            },
            answer: SOURCES_ANSWER,
            events: [...SOURCES_EVENTS, sourcesFinal()] as never,
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
      const head = () =>
        root.querySelector(
          ".llm-task-progress-dock-question",
        ) as HTMLButtonElement | null;
      await until(() => {
        api.flushTaskProgress();
        return Boolean(head());
      }, "the question lists");
      if (head()!.getAttribute("aria-expanded") !== "true") head()!.click();
      const answer = () =>
        Array.from(root.querySelectorAll(".llm-assistant-answer")).find(
          (node) => (node as HTMLElement).dataset.agentRunId === runId,
        ) as HTMLElement | undefined;
      await until(() => Boolean(answer()), "the answer shows");
      report.answerChips = answer()!.querySelectorAll(
        ".llm-citation-inline-wrap",
      ).length;
      report.answerMarks = answer()!.querySelectorAll(
        ".llm-web-source-indicator",
      ).length;

      const outside = () =>
        Array.from(
          root.querySelectorAll(
            'li.llm-task-source[data-kind="paper"], li.llm-task-source[data-kind="web"]',
          ),
        ) as HTMLElement[];
      await until(
        () => {
          api.flushTaskProgress();
          return outside().length >= 5;
        },
        () =>
          `the cited papers and page list (${outside()
            .map((node) => node.dataset.kind)
            .join(", ")})`,
      );
      const keys = outside().map((node) => node.dataset.key!);
      const byKey = (key: string) =>
        outside().find((node) => node.dataset.key === key)!;
      const lit = () =>
        Array.from(
          root.querySelectorAll(".llm-answer-quote-highlight"),
        ) as HTMLElement[];
      const results: Array<Record<string, unknown>> = [];
      for (const key of keys) {
        const summary = () =>
          byKey(key).querySelector(".llm-task-paper-summary") as HTMLElement;
        if (summary().getAttribute("aria-expanded") !== "true")
          summary().click();
        const links = () =>
          Array.from(
            byKey(key).querySelectorAll(
              ".llm-task-source-quote .llm-task-source-link",
            ),
          ) as HTMLElement[];
        await until(
          () => {
            api.flushTaskProgress();
            return links().length > 0;
          },
          `"${byKey(key).querySelector(".llm-task-paper-title")?.textContent}" shows Show in answer`,
        );
        const count = links().length;
        for (let index = 0; index < count; index += 1) {
          // Wait out the last light: a click in the chat clears it.
          answer()!.dispatchEvent(
            new win.MouseEvent("mousedown", { bubbles: true }),
          );
          await Zotero.Promise.delay(100);
          links()[index].click();
          await until(
            () => lit().length > 0,
            () =>
              `"${byKey(key).querySelector(".llm-task-paper-title")?.textContent}" lights its sentence`,
            5000,
          );
          const words = lit()
            .map((node) => node.textContent || "")
            .join("");
          results.push({
            title: byKey(key).querySelector(".llm-task-paper-title")
              ?.textContent,
            kind: byKey(key).dataset.kind,
            words,
            inAnswer: lit().every((node) => answer()!.contains(node)),
            chips: answer()!.querySelectorAll(".llm-answer-quote-chip").length,
          });
        }
      }
      report.results = results;
      await capture(panel.panelId, "tp-sources.png");
      const said = (part: string) =>
        results.find((entry) => String(entry.words).includes(part));
      assert.isOk(
        said("derive drift from implicit regularization in a trained network."),
        "Farrow and Jessop's sentence lights to its end, past the (link)",
      );
      assert.isOk(
        said(
          "did not detectably change the drift rate of hippocampal place cells.",
        ),
        "Arden's sentence lights to its end",
      );
      assert.isOk(
        said("how a downstream reader could keep a fixed key."),
        "Lowther-Gómez's sentence lights",
      );
      assert.isOk(
        said("keeps representations moving."),
        "the web page's sentence lights",
      );
      for (const entry of results)
        assert.isTrue(entry.inAnswer, `${entry.title}: lit in its answer`);
      // The panel's own paper (Farrow) shows as a chip: its sentence was
      // found around it.
      assert.isAtLeast(
        Number(report.answerChips),
        1,
        "the panel's paper shows as a chip in the answer",
      );
      assert.notInclude(
        String(said("derive drift from implicit")?.words),
        "Farrow et al. (2025)",
        "Farrow's name is the chip, not words",
      );
    } finally {
      restore();
      win.Zotero_Tabs?.select?.("zotero-pane");
    }
  });
});
