import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import type { AgentPendingAction } from "../src/agent/types";

describe("workflow: editable note review card", function () {
  this.timeout(60000);

  it("previews the real HTML note-edit payload without displaying markup or changing the saved format", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const fixture = await api.createPaperWithPdfFixture({
      title: "HTML review fixture",
      pages: ["Disposable source."],
    });
    const note = new Zotero.Item("note");
    note.libraryID = Zotero.Items.get(fixture.parentItemId).libraryID;
    note.parentID = fixture.parentItemId;
    note.setNote("<p>Before HTML review.</p>");
    await note.saveTx();
    try {
      const html =
        "<h1>HTML review probe</h1><p>A <strong>formatted</strong> result.</p><blockquote><p>Quoted test text.</p></blockquote><ul><li>First point</li><li>Second point</li></ul>";
      const tool = (Zotero as any).LLMForZotero.api.agent.getToolDefinition(
        "note_write",
      );
      const input = tool.validate({
        mode: "edit",
        targetNoteId: note.id,
        content: html,
      });
      assert.isTrue(input.ok);
      const context = {
        request: {
          conversationKey: fixture.parentItemId,
          activeItemId: fixture.parentItemId,
          libraryID: note.libraryID,
          mode: "agent",
          userText: `Replace existing note ${note.id} with exact HTML. Do not create a new note.`,
        },
        item: Zotero.Items.get(fixture.parentItemId),
        modelName: "workflow",
        currentAnswerText: "",
      };
      const action = await tool.createPendingAction(input.value, context);
      const contentField = action.fields.find(
        (field: any) => field.id === "content",
      );
      assert.equal(contentField.contentFormat, "html");
      assert.equal(contentField.value, html);
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const pending = api.renderPendingActionForPanel(panel.panelId, {
        requestId: "html-review-workflow",
        action,
      });
      const doc = Zotero.getMainWindow().document;
      const card = doc.querySelector<HTMLElement>(
        '[data-request-id="html-review-workflow"]',
      )!;
      const preview = card.querySelector<HTMLElement>(
        ".llm-note-review-preview",
      )!;
      assert.equal(
        preview.querySelector("h1")?.textContent,
        "HTML review probe",
      );
      assert.equal(preview.querySelector("strong")?.textContent, "formatted");
      assert.equal(
        preview.querySelector("blockquote")?.textContent,
        "Quoted test text.",
      );
      assert.lengthOf(preview.querySelectorAll("li"), 2);
      assert.notInclude(preview.textContent, "<h1>");
      assert.isTrue(
        card.querySelector<HTMLDetailsElement>(".llm-note-review-changes")!
          .open,
        "the proposed changes are visible before the user interacts with the card",
      );
      const editor = card.querySelector<HTMLTextAreaElement>("textarea")!;
      assert.equal(
        editor.value,
        html,
        "preview does not rewrite the payload as Markdown",
      );
      card.querySelector<HTMLButtonElement>('[data-kind="save"]')!.click();
      const resolution = await pending;
      assert.deepEqual(resolution.data, { content: html });
      const approved = await tool.applyConfirmation(
        input.value,
        resolution.data,
        context,
      );
      assert.isTrue(approved.ok);
      assert.equal(approved.value.content, html);
      assert.include(
        note.getNote(),
        "Before HTML review.",
        "review itself never writes",
      );
      card.remove();

      // An HTML editor must not insert executable attributes into chrome.
      const unsafeAction = {
        ...action,
        fields: action.fields.map((field: any) =>
          field.id === "content"
            ? {
                ...field,
                value:
                  '<p onclick="globalThis.reviewExecuted=true">Safe text</p><a href="javascript:alert(1)">Link</a>',
              }
            : field,
        ),
      };
      const cancelled = api.renderPendingActionForPanel(panel.panelId, {
        requestId: "html-review-inert",
        action: unsafeAction,
      });
      const unsafeCard = doc.querySelector<HTMLElement>(
        '[data-request-id="html-review-inert"]',
      )!;
      assert.isNull(
        unsafeCard.querySelector("[onclick], [href^='javascript:']"),
      );
      assert.include(
        unsafeCard.querySelector(".llm-note-review-preview")!.textContent,
        "Safe text",
      );
      unsafeCard
        .querySelector<HTMLButtonElement>('[data-kind="cancel"]')!
        .click();
      assert.isFalse((await cancelled).approved);
    } finally {
      await api.cleanupFixture(fixture);
      await api.reset();
    }
  });

  it("previews the note in the document card, approves edited content once, and cancels without content", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const fixture = await api.createPaperWithPdfFixture({
      title: "Note review fixture",
      pages: ["A disposable note review fixture."],
    });
    try {
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const doc = Zotero.getMainWindow().document;
      const action: AgentPendingAction = {
        toolName: "note_write",
        mode: "review",
        title: "Review note update",
        description: "Update Note review fixture.",
        confirmLabel: "Apply changes",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "textarea",
            id: "content",
            label: "Final note content",
            value:
              "# Research note\n\nA **formatted** draft.\n\n- First point\n- Second point",
          },
          {
            type: "text",
            id: "invocationImpact",
            label: "Impact and assurance",
            value: "state_change (runtime_enforced)",
          },
          {
            type: "text",
            id: "invocationEffects",
            label: "Effects",
            value: "create",
          },
          {
            type: "text",
            id: "invocationReversibility",
            label: "Reversibility",
            value: "full",
          },
        ],
      };
      const pending = api.renderPendingActionForPanel(panel.panelId, {
        requestId: "note-review-workflow",
        action,
      });
      const card = doc.querySelector<HTMLElement>(
        '[data-request-id="note-review-workflow"]',
      )!;
      assert.isTrue(
        card.classList.contains("llm-plan-container"),
        "note review must use the plan/document card",
      );
      const preview = card.querySelector<HTMLElement>(
        ".llm-note-review-preview",
      )!;
      assert.equal(
        preview.querySelector("h1, h2, h3")?.textContent,
        "Research note",
      );
      assert.equal(preview.querySelector("strong")?.textContent, "formatted");
      for (const label of [
        "Impact and assurance",
        "Reversibility",
        "state_change",
        "Effects",
      ])
        assert.notInclude(card.textContent, label);
      const editor = card.querySelector<HTMLTextAreaElement>("textarea")!;
      assert.isTrue(editor.hidden, "formatted preview is the default");
      card.querySelector<HTMLButtonElement>(".llm-note-review-edit")!.click();
      assert.isFalse(editor.hidden);
      editor.value = "   ";
      editor.dispatchEvent(
        new (doc.defaultView as any).Event("input", { bubbles: true }),
      );
      assert.isTrue(
        card.querySelector<HTMLButtonElement>('[data-kind="save"]')!.disabled,
        "an empty edit cannot be approved",
      );
      editor.value = "# Edited note\n\nHuman-approved text.";
      editor.dispatchEvent(
        new (doc.defaultView as any).Event("input", { bubbles: true }),
      );
      card.querySelector<HTMLButtonElement>(".llm-note-review-edit")!.click();
      assert.equal(
        preview.querySelector("h1, h2, h3")?.textContent,
        "Edited note",
      );
      const footer = card.querySelector<HTMLElement>(
        ".llm-note-review-actions",
      )!;
      assert.equal(
        doc.defaultView!.getComputedStyle(footer).justifyContent,
        "flex-end",
      );
      const approve =
        footer.querySelector<HTMLButtonElement>('[data-kind="save"]')!;
      approve.click();
      const resolution = await pending;
      assert.isTrue(resolution.approved);
      assert.deepEqual(resolution.data, { content: editor.value });
      assert.isTrue(approve.disabled);
      card.remove();
      const updateAction: AgentPendingAction = {
        ...action,
        title: "Review note update",
        fields: [
          {
            type: "textarea",
            id: "content",
            label: "Final note content",
            value: "New claim",
          },
          {
            type: "diff_preview",
            id: "noteDiff",
            before: "Old claim",
            after: "New claim",
            sourceFieldId: "content",
          },
        ],
      };
      const cancelled = api.renderPendingActionForPanel(panel.panelId, {
        requestId: "note-review-cancel",
        action: updateAction,
      });
      const updateCard = doc.querySelector<HTMLElement>(
        '[data-request-id="note-review-cancel"]',
      )!;
      updateCard.style.width = "320px";
      assert.isOk(
        updateCard.querySelector(".llm-agent-hitl-diff-line-add"),
        "updates retain the changes view",
      );
      const updateEditor =
        updateCard.querySelector<HTMLTextAreaElement>("textarea")!;
      updateCard
        .querySelector<HTMLButtonElement>(".llm-note-review-edit")!
        .click();
      updateEditor.value = "A revised claim";
      updateCard
        .querySelector<HTMLButtonElement>(".llm-note-review-edit")!
        .click();
      assert.include(
        updateCard.querySelector(".llm-agent-hitl-diff-line-add")!.textContent,
        "revised",
      );
      for (const button of updateCard.querySelectorAll<HTMLButtonElement>(
        ".llm-note-review-actions button",
      )) {
        assert.isAtMost(
          button.getBoundingClientRect().right,
          updateCard.getBoundingClientRect().right,
          "actions fit a narrow panel",
        );
      }
      doc
        .querySelector<HTMLButtonElement>(
          '[data-request-id="note-review-cancel"] [data-kind="cancel"]',
        )!
        .click();
      assert.deepEqual(await cancelled, {
        approved: false,
        actionId: "cancel",
        data: undefined,
      });
      assert.isEmpty(
        Zotero.Items.get(fixture.parentItemId).getNotes(),
        "UI review itself never writes a note",
      );
    } finally {
      await api.cleanupFixture(fixture);
      await api.reset();
    }
  });
});
