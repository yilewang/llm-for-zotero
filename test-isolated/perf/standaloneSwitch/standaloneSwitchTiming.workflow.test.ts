import { assert } from "chai";
import type { WorkflowTestApi } from "../../../src/modules/contextPanel/workflowTestTypes";

declare const Zotero: any;
declare const Services: any;

const enabled =
  Services.env.get("LLM_FOR_ZOTERO_STANDALONE_SWITCH_BENCH") === "1";

/**
 * Times a conversation switch in the pop-out window with long, rich chats.
 * Measurements go to <data dir>/standalone-switch-timing.json.
 * Opt-in: skipped unless LLM_FOR_ZOTERO_STANDALONE_SWITCH_BENCH=1.
 */
describe("workflow: pop-out window chat switch timing", function () {
  this.timeout(300000);
  let api: WorkflowTestApi;
  const fixtures: Awaited<
    ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>
  >[] = [];
  const results: unknown[] = [];

  before(async function () {
    if (!enabled) this.skip();
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
  });

  after(async function () {
    if (!enabled) return;
    await api.closeStandalone();
    await api.reset();
    for (const fixture of fixtures) await api.cleanupFixture(fixture);
    await Zotero.File.putContentsAsync(
      `${Zotero.DataDirectory.dir}/standalone-switch-timing.json`,
      JSON.stringify(results, null, 2),
    );
  });

  const richAnswer = (marker: string, index: number) =>
    [
      `## ${marker} answer ${index}`,
      `The model is $E = mc^2$ and $\\int_0^1 x^2\\,dx = \\tfrac13$.`,
      "",
      "$$\\mathcal{L}(\\theta) = \\sum_{i=1}^{n} \\log p(x_i \\mid \\theta)$$",
      "",
      "- point one with **bold** and `code`",
      "- point two with a [link](https://example.org)",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "```python",
      "def f(x):\n    return x * 2",
      "```",
      "Body text. ".repeat(60),
    ].join("\n");

  for (const turns of [40, 120]) {
    it(`switches between two ${turns}-turn chats`, async function () {
      const fixture = await api.createPaperWithPdfFixture({
        title: `Switch timing ${turns}`,
        pdfTitle: `Switch timing ${turns} PDF`,
      });
      fixtures.push(fixture);
      await api.openStandaloneForItem(fixture.parentItemId);
      const win = (Zotero as any).LLMForZotero.data.standaloneWindow as Window;
      const doc = win.document;
      const content = () =>
        doc.querySelector(".llm-standalone-content") as HTMLElement;
      const panelRoot = () =>
        content().querySelector("#llm-main") as HTMLElement | null;
      const chatText = () =>
        content().querySelector("#llm-chat-box")?.textContent || "";
      const mountedKey = () => Number(panelRoot()?.dataset.itemId || 0);
      const now = () => win.performance!.now();
      const nextFrame = () =>
        new Promise<void>((resolve) =>
          win.requestAnimationFrame(() => resolve()),
        );
      const waitUntil = async (check: () => boolean, label: string) => {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          if (check()) return;
          await Zotero.Promise.delay(10);
        }
        assert.fail(`Timed out waiting for ${label}`);
      };
      const seed = (marker: string) =>
        Array.from({ length: turns }, (_, index) => [
          { role: "user" as const, text: `${marker} question ${index}` },
          { role: "assistant" as const, text: richAnswer(marker, index) },
        ]).flat();

      for (const tab of ["open", "paper"] as const) {
        await api.clickStandaloneTab(tab);
        const markerA = `${tab}-${turns} A`;
        const markerB = `${tab}-${turns} B`;
        await api.seedStandaloneConversation(seed(markerA));
        const keyA = mountedKey();
        doc
          .querySelector<HTMLButtonElement>('[data-sidebar-action="new-chat"]')!
          .click();
        await waitUntil(
          () => mountedKey() > 0 && mountedKey() !== keyA,
          "new chat mounts",
        );
        await api.seedStandaloneConversation(seed(markerB));
        const keyB = mountedKey();
        const rowFor = (key: number) =>
          doc.querySelector<HTMLElement>(
            `.llm-standalone-conv-item[data-conversation-key="${key}"]`,
          );
        await waitUntil(() => Boolean(rowFor(keyA) && rowFor(keyB)), "rows");

        const samples: Array<Record<string, number | string>> = [];
        for (let round = 0; round < 6; round += 1) {
          const toA = round % 2 === 0;
          const key = toA ? keyA : keyB;
          const marker = toA ? markerA : markerB;
          let lastMutation = now();
          const observer = new win.MutationObserver(() => {
            lastMutation = now();
          });
          observer.observe(doc.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
          });
          // Longest single main-thread block while the switch runs.
          let longestFrame = 0;
          let lastFrame = now();
          let measuring = true;
          const frameLoop = () => {
            const t = now();
            longestFrame = Math.max(longestFrame, t - lastFrame);
            lastFrame = t;
            if (measuring) win.requestAnimationFrame(frameLoop);
          };
          win.requestAnimationFrame(frameLoop);
          const started = now();
          rowFor(key)!.click();
          const clicked = now();
          while (
            !(
              mountedKey() === key &&
              chatText().includes(`${marker} answer ${turns - 1}`)
            )
          ) {
            if (now() - started > 30000) assert.fail(`timed out on ${marker}`);
            await nextFrame();
          }
          const shown = now();
          while (now() - lastMutation < 300 && now() - started < 5000) {
            await Zotero.Promise.delay(20);
          }
          measuring = false;
          observer.disconnect();
          samples.push({
            tab,
            to: toA ? "A" : "B",
            clickMs: Math.round(clicked - started),
            shownMs: Math.round(shown - started),
            settledMs: Math.round(Math.max(lastMutation, shown) - started),
            longestFrameMs: Math.round(longestFrame),
          });
        }
        results.push({ turns, tab, samples });
      }
    });
  }
});
