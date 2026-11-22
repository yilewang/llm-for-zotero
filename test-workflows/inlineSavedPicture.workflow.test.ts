import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import {
  agentFilesTargetForScope,
  buildAgentFilesInstruction,
  resolveAgentFilesFolder,
  setAgentFilesRootPref,
} from "../src/utils/agentFilesDirectory";
import { renderMarkdown } from "../src/utils/markdown";
import { toFileUrl } from "../src/utils/localPath";

declare const Zotero: any;
declare const IOUtils: any;
declare const PathUtils: any;

// #579: a picture an agent saved and names in its answer as
// ![caption](path) shows in the text, in Paper Chat and in Codex chats, and is
// not repeated as a card under the answer.

function api(): WorkflowTestApi {
  return Zotero.LLMForZotero.api.workflowTest as WorkflowTestApi;
}

async function until(
  check: () => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Zotero.Promise.delay(50);
  }
  assert.isTrue(check(), message);
}

async function writePlot(path: string): Promise<void> {
  const win = Zotero.getMainWindow();
  const canvas = win.document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "canvas",
  );
  canvas.width = 240;
  canvas.height = 150;
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, 240, 150);
  g.strokeStyle = "#c33";
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(10, 140);
  g.quadraticCurveTo(60, 10, 230, 20);
  g.stroke();
  const binary = win.atob(canvas.toDataURL("image/png").split(",")[1]);
  await IOUtils.write(
    path,
    Uint8Array.from(binary, (char: string) => char.charCodeAt(0)),
  );
}

function answerWrappers(root: Element): HTMLElement[] {
  return Array.from(
    root.querySelectorAll(".llm-message-wrapper.assistant"),
  ) as HTMLElement[];
}

function inlinePictures(wrapper: HTMLElement): HTMLImageElement[] {
  return (
    Array.from(wrapper.querySelectorAll("img")) as HTMLImageElement[]
  ).filter((img) => !img.closest(".llm-saved-files"));
}

function cardPaths(wrapper: HTMLElement): string[] {
  return (
    Array.from(
      wrapper.querySelectorAll(".llm-saved-files [data-saved-file-path]"),
    ) as HTMLElement[]
  ).map((card) => card.dataset.savedFilePath || "");
}

const loaded = (img: HTMLImageElement) => img.complete && img.naturalWidth > 0;

describe("workflow: a saved picture named in the answer shows in the text (#579)", function () {
  this.timeout(120000);

  let tmpRoot = "";
  let folder = "";
  let paperId = 0;

  before(async function () {
    await api().reset();
    tmpRoot = PathUtils.join(
      Zotero.getTempDirectory().path,
      `inline-picture-${Date.now()}`,
    );
    setAgentFilesRootPref(PathUtils.join(tmpRoot, "agent-files"));
    const fixture = await api().createPaperWithPdfFixture({
      title: "Stress strain paper",
      pdfTitle: "stress.pdf",
    });
    paperId = fixture.parentItemId;
    const paper = Zotero.Items.get(paperId);
    folder = (await resolveAgentFilesFolder(
      agentFilesTargetForScope({
        conversationKind: "paper",
        libraryID: paper.libraryID,
        paperItemId: paper.id,
      }),
    ))!;
    assert.isOk(folder, "the paper's files folder");
    // Folders are named "KEY - Title": the path has spaces.
    assert.match(folder, /\s/);
    await IOUtils.makeDirectory(folder, {
      createAncestors: true,
      ignoreExisting: true,
    });
  });

  after(async function () {
    setAgentFilesRootPref("");
    if (tmpRoot) await IOUtils.remove(tmpRoot, { recursive: true });
    await api().reset();
  });

  it("renders local-path pictures in the text and keeps cards for the rest", async function () {
    const plainFolder = PathUtils.join(tmpRoot, "plots");
    await IOUtils.makeDirectory(plainFolder, { ignoreExisting: true });
    const cases = [
      {
        name: "path with spaces",
        path: PathUtils.join(folder, "plot-spaces.png"),
        text: (p: string) =>
          `Here is the plot:\n\n![Stress-strain curves](${p})\n\nHigher k rises faster.`,
      },
      {
        name: "path without spaces",
        path: PathUtils.join(plainFolder, "plot-plain.png"),
        text: (p: string) =>
          `Here is the plot:\n\n![Stress-strain curves](${p})\n\nHigher k rises faster.`,
      },
      {
        name: "path in angle brackets",
        path: PathUtils.join(folder, "plot-angle.png"),
        text: (p: string) =>
          `Here is the plot:\n\n![Stress-strain curves](<${p}>)\n\nHigher k rises faster.`,
      },
      {
        name: "file URL",
        path: PathUtils.join(folder, "plot-url.png"),
        text: (p: string) =>
          `Here is the plot:\n\n![Stress-strain curves](${toFileUrl(p)})\n\nHigher k rises faster.`,
      },
      {
        name: "path only named",
        path: PathUtils.join(folder, "plot-named.png"),
        text: (p: string) =>
          `I saved the figure to ${p}.\n\nHigher k rises faster.`,
      },
    ];

    const first = await api().renderPanelForItem(paperId);
    const conversationKey = api().getPanelConversationKey({
      panelId: first.panelId,
    });
    for (const entry of cases) {
      const userTimestamp = Date.now();
      await Zotero.Promise.delay(200);
      await writePlot(entry.path);
      await Zotero.Promise.delay(200);
      await api().seedStoredConversationTurns(conversationKey, [
        {
          role: "user",
          text: `Plot the curves (${entry.name})`,
          timestamp: userTimestamp,
        },
        {
          role: "assistant",
          text: entry.text(entry.path),
          timestamp: Date.now(),
        },
      ]);
      // The next turn starts after this turn's window (5 s of slack).
      await Zotero.Promise.delay(5200);
    }

    const panel = await api().remountPanel(first.panelId);
    const root = Zotero.getMainWindow().document.querySelector(
      `[data-workflow-panel-id="${panel.panelId}"]`,
    ) as HTMLElement;
    assert.isOk(root, "panel root");
    await until(
      () => answerWrappers(root).length === cases.length,
      10000,
      "every answer renders",
    );
    const wrappers = answerWrappers(root);
    // The named-only answer gets its card; wait for it so the cards of the
    // others (which must not appear) have had the same time to mount.
    await until(
      () => cardPaths(wrappers[4]).length > 0,
      10000,
      "the named-only answer gets a card",
    );
    await until(
      () => wrappers.slice(0, 4).every((w) => inlinePictures(w).every(loaded)),
      10000,
      "inline pictures load",
    );

    for (const [index, entry] of cases.slice(0, 4).entries()) {
      const wrapper = wrappers[index];
      const pictures = inlinePictures(wrapper);
      assert.lengthOf(pictures, 1, `${entry.name}: one picture in the text`);
      assert.isTrue(loaded(pictures[0]), `${entry.name}: the picture loads`);
      assert.equal(pictures[0].getAttribute("alt"), "Stress-strain curves");
      assert.notInclude(
        wrapper.textContent || "",
        "![",
        `${entry.name}: no raw Markdown`,
      );
      assert.include(wrapper.textContent || "", "Higher k rises faster.");
      assert.notInclude(
        cardPaths(wrapper),
        entry.path,
        `${entry.name}: no second copy as a card`,
      );
    }
    assert.lengthOf(inlinePictures(wrappers[4]), 0);
    assert.deepEqual(cardPaths(wrappers[4]), [cases[4].path]);
  });

  it("renders the picture in a Codex chat", async function () {
    const path = PathUtils.join(folder, "codex-plot.png");
    await writePlot(path);
    // Codex chats are listed only while Codex mode is on.
    const codexPref = "extensions.zotero.llmforzotero.enableCodexAppServerMode";
    const previous = Zotero.Prefs.get(codexPref, true);
    Zotero.Prefs.set(codexPref, true, true);
    const seeded = await api().seedHistoryConversation({
      system: "codex",
      kind: "paper",
      paperItemId: paperId,
      userText: "Plot the stress-strain curves",
      assistantText: `Here is the plot:\n\n![Codex plot](${path})\n\nHigher k rises faster.`,
    });
    const panel = await api().renderPanelForItem(paperId);
    try {
      await api().clickPanelHistoryRow(panel.panelId, seeded.conversationKey);
      const root = Zotero.getMainWindow().document.querySelector(
        `[data-workflow-panel-id="${panel.panelId}"]`,
      ) as HTMLElement;
      await until(
        () =>
          answerWrappers(root).some((w) =>
            inlinePictures(w).some(
              (img) => img.getAttribute("alt") === "Codex plot" && loaded(img),
            ),
          ),
        10000,
        "the Codex answer shows the picture",
      );
      const wrapper = answerWrappers(root).find((w) =>
        (w.textContent || "").includes("Higher k rises faster."),
      )!;
      assert.notInclude(wrapper.textContent || "", "![");
      assert.notInclude(cardPaths(wrapper), path);
    } finally {
      await api().deleteSeededHistoryConversation(seeded);
      if (previous === undefined) Zotero.Prefs.clear(codexPref, true);
      else Zotero.Prefs.set(codexPref, previous, true);
    }
  });

  it("parses local picture Markdown without touching other syntax", function () {
    const spaced = "/Users/me/agent files/ABCD - Paper/plot one.png";
    const titled = renderMarkdown(`![Curves](${spaced} "Figure 1")`);
    assert.include(titled, `src="${toFileUrl(spaced)}"`);
    assert.include(titled, 'title="Figure 1"');
    assert.include(titled, 'alt="Curves"');

    // A titled picture without spaces is Marked's own, title kept.
    const plain = renderMarkdown('![Curves](/tmp/plot.png "Figure 2")');
    assert.include(plain, 'src="file:///tmp/plot.png"');
    assert.include(plain, 'title="Figure 2"');

    // Code stays code; web and relative pictures are left as written.
    const code = renderMarkdown(`Write \`![Curves](${spaced})\` to show it.`);
    assert.notInclude(code, "<img");
    assert.include(code, "<code>");
    assert.include(
      renderMarkdown("![Web](https://example.com/a.png)"),
      'src="https://example.com/a.png"',
    );
    assert.include(
      renderMarkdown("![Rel](figures/a.png)"),
      'src="figures/a.png"',
    );
  });

  it("tells the agent how to show a saved picture in the answer", function () {
    assert.include(
      buildAgentFilesInstruction("/tmp/agent"),
      "![short caption](its full path)",
    );
  });
});
