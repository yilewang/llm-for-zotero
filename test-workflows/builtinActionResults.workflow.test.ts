import { assert } from "chai";

describe("workflow: verified built-in action summaries", function () {
  this.timeout(60000);
  it("reports the paper actually tagged by the native slash workflow", async function () {
    const api = (Zotero as any).LLMForZotero.api;
    const paper = new Zotero.Item("journalArticle");
    paper.libraryID = Zotero.Libraries.userLibraryID;
    paper.setField("title", "Population coding and neural drift fixture");
    paper.setField(
      "abstractNote",
      "We studied population coding and neural drift.",
    );
    await paper.saveTx();
    const panel = await api.workflowTest.renderPanelForItem(paper.id);
    let confirmations = 0;
    const events: unknown[] = [];
    try {
      const result = await api.agent.runAction(
        "auto_tag",
        { itemIds: [paper.id] },
        {
          libraryID: paper.libraryID,
          conversationKey: paper.id,
          confirmationMode: "native_ui",
          requestContext: { mode: "paper", activeItemId: paper.id },
          onProgress: (event: unknown) => events.push(event),
          requestConfirmation: async (requestId: string, action: any) => {
            confirmations++;
            await paper.reload(undefined, true);
            assert.lengthOf(
              paper.getTags(),
              0,
              "No proposed tag may be applied before review",
            );
            const waiting = api.workflowTest.renderPendingActionForPanel(
              panel.panelId,
              { requestId, action },
            );
            const card = Zotero.getMainWindow().document.querySelector(
              `[data-request-id="${requestId}"]`,
            )!;
            let input = card.querySelector<HTMLInputElement>(
              ".llm-agent-hitl-tag-chip-input",
            );
            if (!input) {
              const add = [...card.querySelectorAll("button")].find(
                (button) => button.textContent?.trim() === "Add tag",
              )!;
              (add as HTMLButtonElement).click();
              input = card.querySelector<HTMLInputElement>(
                ".llm-agent-hitl-tag-chip-input",
              );
            }
            assert.exists(input, card.textContent || "");
            input!.value = "verified-summary-fixture";
            input!.dispatchEvent(
              new (Zotero.getMainWindow() as any).Event("input", {
                bubbles: true,
              }),
            );
            const confirm = [...card.querySelectorAll("button")].find(
              (button) => button.textContent?.trim() === "Confirm",
            ) as HTMLButtonElement;
            assert.exists(confirm);
            confirm.click();
            return waiting;
          },
        },
      );
      await paper.reload(undefined, true);
      assert.equal(confirmations, 1);
      assert.isAbove(
        paper.getTags().length,
        0,
        JSON.stringify({ result, events }),
      );
      assert.isTrue(result.ok);
      assert.equal(
        result.output.tagged,
        1,
        "The summary must count the verified native change",
      );
      assert.equal(result.output.skipped, 0);
    } finally {
      await api.workflowTest.reset();
      await paper.eraseTx();
    }
  });
});
