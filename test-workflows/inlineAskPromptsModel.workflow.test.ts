import { assert } from "chai";
import {
  getModelEntryById,
  setModelProviderGroups,
} from "../src/utils/modelProviders";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
  WorkflowTestReaderInlineAskCard,
} from "../src/modules/contextPanel/workflowTestTypes";
import {
  installHeldChatProvider,
  type HeldChatProvider,
} from "./helpers/heldChatProvider";

/**
 * Inline Ask's editable quick prompts and its own model choice, in the real
 * reader: right-click a pill for Edit, Delete, Add and Reset (the empty pill
 * row for Add and Reset); the changes live in Inline Ask's own prefs and
 * show in the next card. The model line opens the API models by provider
 * and the effort levels; the pick is Inline Ask's own, answers the next
 * question, and survives a new card.
 *
 * The plugin's real popup handler, card, prefs, request assembly and stream
 * parsing run; only the network is scripted (two held fake providers).
 */

declare const Zotero: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero.";
const API_BASE_A = "https://workflow-inline-ask-a.invalid/v1";
const API_BASE_B = "https://workflow-inline-ask-b.invalid/v1";
const ENTRY_A = "workflow-inline-ask-model-a";
const ENTRY_B = "workflow-inline-ask-model-b";
const MODEL_A = "inline-ask-model";
/** An OpenAI-style name, so the effort menu offers real levels. */
const MODEL_B = "gpt-5.5-inline-ask";

const SAVED_PREF_KEYS = [
  "modelProviderGroups",
  "modelProviderGroupsMigrationVersion",
  "lastUsedModelEntryId",
  "conversationSystem",
  "enableCodexAppServerMode",
  "enableClaudeCodeMode",
  "showPopupAddText",
  "showPopupInlineAsk",
  "outputTokenAutoMigrationNoticePending",
  "inlineAskPrompts",
  "inlineAskDeletedPrompts",
  "inlineAskModelEntryId",
  "inlineAskReasoning",
];
const INLINE_ASK_PREF_KEYS = [
  "inlineAskPrompts",
  "inlineAskDeletedPrompts",
  "inlineAskModelEntryId",
  "inlineAskReasoning",
];

const SELECTED_TEXT = "INLINE_ASK_PROMPTS_SELECTED_PASSAGE";
const EXPLAIN_PROMPT =
  "Explain this passage in plain language, using the context of the paper.";
const CLAUDE_CODE_NOTE =
  "Claude Code runs only in the sidebar. Inline Ask uses an API model from this list.";

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

function readPref(key: string): unknown {
  return Zotero.Prefs.get(PREF_PREFIX + key, true);
}

function readJsonPref(key: string): unknown {
  const raw = readPref(key);
  return typeof raw === "string" && raw ? JSON.parse(raw) : null;
}

describe("workflow: Inline Ask prompts and model choice", function () {
  this.timeout(120_000);

  let api: WorkflowTestApi;
  let providerA: HeldChatProvider;
  let providerB: HeldChatProvider;
  const previousPrefs = new Map<string, unknown>();
  const fixtures: WorkflowTestFixture[] = [];
  let fixture: WorkflowTestFixture;

  async function createFixture(title: string): Promise<WorkflowTestFixture> {
    const created = await api.createPaperWithPdfFixture({
      title,
      pdfTitle: `${title} PDF`,
      pages: [`Drift study. The ${SELECTED_TEXT} reports slow change.`],
    });
    fixtures.push(created);
    return created;
  }

  async function openCard() {
    const opened = await api.openReaderInlineAsk({
      attachmentItemId: fixture.pdfAttachmentId,
      pageIndex: 0,
      selectedText: SELECTED_TEXT,
    });
    assert.isTrue(opened.mounted, JSON.stringify(opened));
    return opened;
  }

  async function waitForCard(
    check: (card: WorkflowTestReaderInlineAskCard) => boolean,
    label: string,
  ): Promise<WorkflowTestReaderInlineAskCard> {
    const deadline = Date.now() + 20_000;
    let card = api.readReaderInlineAsk();
    while (Date.now() < deadline) {
      card = api.readReaderInlineAsk();
      if (check(card)) return card;
      await Zotero.Promise.delay(50);
    }
    assert.fail(`${label}: ${JSON.stringify(card)}`);
  }

  async function answer(provider: HeldChatProvider, marker: string) {
    const stream = await provider.waitForStream(marker);
    stream.push(`answer for ${marker}`);
    stream.finish();
    await waitForCard(
      (card) =>
        card.phase === "answered" &&
        card.answers.some((entry) => entry.text === `answer for ${marker}`),
      `the answer for ${marker} completes`,
    );
    return stream;
  }

  function clearInlineAskPrefs() {
    for (const key of INLINE_ASK_PREF_KEYS) {
      Zotero.Prefs.clear(PREF_PREFIX + key, true);
    }
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = getWorkflowTestApi();
    for (const key of SAVED_PREF_KEYS) {
      previousPrefs.set(key, readPref(key));
    }
    providerA = installHeldChatProvider(API_BASE_A);
    providerB = installHeldChatProvider(API_BASE_B);
    Zotero.Prefs.set(PREF_PREFIX + "enableCodexAppServerMode", false, true);
    setModelProviderGroups([
      {
        id: "workflow-inline-ask-group-a",
        authMode: "api_key",
        apiBase: API_BASE_A,
        apiKey: "workflow-dummy-key-a",
        providerProtocol: "openai_chat_compat",
        models: [
          {
            id: ENTRY_A,
            model: MODEL_A,
            temperature: 0.3,
            outputTokenLimit: { mode: "auto" },
          },
        ],
      },
      {
        id: "workflow-inline-ask-group-b",
        authMode: "api_key",
        apiBase: API_BASE_B,
        apiKey: "workflow-dummy-key-b",
        providerProtocol: "openai_chat_compat",
        models: [
          {
            id: ENTRY_B,
            model: MODEL_B,
            temperature: 0.3,
            outputTokenLimit: { mode: "auto" },
          },
        ],
      },
    ] as any);
    assert.isOk(getModelEntryById(ENTRY_A), "model A is configured");
    assert.isOk(getModelEntryById(ENTRY_B), "model B is configured");
  });

  after(async function () {
    // Installed B over A: restore in reverse order.
    providerB?.restore();
    providerA?.restore();
    await api.reset();
    for (const [key, value] of previousPrefs) {
      if (value === undefined) Zotero.Prefs.clear(PREF_PREFIX + key, true);
      else Zotero.Prefs.set(PREF_PREFIX + key, value, true);
    }
  });

  beforeEach(async function () {
    await api.reset();
    clearInlineAskPrefs();
    Zotero.Prefs.set(PREF_PREFIX + "conversationSystem", "upstream", true);
    Zotero.Prefs.set(PREF_PREFIX + "enableClaudeCodeMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "lastUsedModelEntryId", ENTRY_A, true);
    Zotero.Prefs.set(PREF_PREFIX + "showPopupAddText", true, true);
    Zotero.Prefs.set(PREF_PREFIX + "showPopupInlineAsk", true, true);
    fixture = await createFixture(this.currentTest?.title || "Inline Ask");
  });

  afterEach(async function () {
    providerA.failOpenStreams("workflow case ended");
    providerB.failOpenStreams("workflow case ended");
    await api.endReaderInlineAsk({ via: "discard" });
    for (const created of fixtures.splice(0)) {
      await api.cleanupFixture(created);
    }
    clearInlineAskPrefs();
    await api.reset();
  });

  it("edits a pill by right-click; the change is saved and shows in a new card", async function () {
    await openCard();
    const menu = await api.openReaderInlineAskPromptMenu({
      pillId: "explain",
    });
    assert.isTrue(menu.defaultPrevented, JSON.stringify(menu));
    assert.deepEqual(
      menu.items.map((item) => [item.action, item.text, item.disabled]),
      [
        ["edit", "Edit", false],
        ["delete", "Delete", false],
        ["add", "Add", false],
        ["reset", "Reset", false],
      ],
    );
    const editing = await api.clickReaderInlineAskPromptMenuItem("edit");
    assert.isTrue(editing.promptEditorShown, JSON.stringify(editing));
    assert.isFalse(editing.hintShown, JSON.stringify(editing));

    const LABEL = "Explain simply";
    const PROMPT = "WF_EDITED_PROMPT Explain it simply.";
    const edited = await api.editReaderInlineAskPrompt({
      label: LABEL,
      prompt: PROMPT,
      via: "enter-in-label",
    });
    const message = JSON.stringify(edited);
    assert.equal(edited.labelBefore, "Explain", message);
    assert.equal(edited.promptBefore, EXPLAIN_PROMPT, message);
    assert.equal(edited.labelType, "text", message);
    assert.equal(edited.promptContentEditable, "true", message);
    assert.deepEqual(
      edited.keys.filter((key) => key.defaultPrevented),
      [],
      "typing keys reach the fields",
    );
    assert.notInclude(
      edited.readerKeyStateBefore,
      '"selectedAnnotationCount":-1',
      message,
    );
    assert.equal(
      edited.readerKeyStateAfter,
      edited.readerKeyStateBefore,
      "reader shortcuts did not fire while typing",
    );
    assert.isFalse(edited.card.promptEditorShown, message);
    assert.deepEqual(edited.card.pills[0], {
      id: "explain",
      label: LABEL,
      title: PROMPT,
    });
    assert.deepEqual(readJsonPref("inlineAskPrompts"), [
      { id: "explain", label: LABEL, prompt: PROMPT },
    ]);

    // A new card shows the edited pill, and the pill sends its new prompt.
    await api.endReaderInlineAsk({ via: "escape" });
    const reopened = await openCard();
    assert.deepEqual(reopened.pillLabels, [LABEL, "Define terms", "Translate"]);
    await api.sendReaderInlineAsk({ pillId: "explain" });
    await answer(providerA, "WF_EDITED_PROMPT");
    assert.deepEqual(api.readReaderInlineAsk().questions, [LABEL]);
  });

  it("adds a prompt from the empty pill row, deletes a built-in, and Reset restores the three", async function () {
    await openCard();
    const rowMenu = await api.openReaderInlineAskPromptMenu({});
    assert.isTrue(rowMenu.defaultPrevented);
    assert.deepEqual(
      rowMenu.items.map((item) => item.action),
      ["add", "reset"],
    );
    const adding = await api.clickReaderInlineAskPromptMenuItem("add");
    assert.isTrue(adding.promptEditorShown);
    const added = await api.editReaderInlineAskPrompt({
      label: "WF Critique",
      prompt: "WF_ADDED_PROMPT Critique this passage.",
      via: "mod-enter-in-prompt",
    });
    assert.equal(added.labelBefore, "");
    assert.equal(added.promptBefore, "");
    assert.deepEqual(
      added.keys.filter((key) => key.defaultPrevented),
      [],
    );
    assert.equal(added.readerKeyStateAfter, added.readerKeyStateBefore);
    assert.deepEqual(
      added.card.pills.map((pill) => pill.label),
      ["Explain", "Define terms", "Translate", "WF Critique"],
    );
    const customId = added.card.pills[3].id;
    assert.match(customId, /^inline-ask-custom-/);
    assert.deepEqual(readJsonPref("inlineAskPrompts"), [
      {
        id: customId,
        label: "WF Critique",
        prompt: "WF_ADDED_PROMPT Critique this passage.",
      },
    ]);

    await api.openReaderInlineAskPromptMenu({ pillId: "translate" });
    const deleted = await api.clickReaderInlineAskPromptMenuItem("delete");
    assert.deepEqual(
      deleted.pills.map((pill) => pill.id),
      ["explain", "define", customId],
    );
    assert.deepEqual(readJsonPref("inlineAskDeletedPrompts"), ["translate"]);

    // The added prompt sends its full text from a new card.
    await api.endReaderInlineAsk({ via: "escape" });
    const reopened = await openCard();
    assert.deepEqual(reopened.pillLabels, [
      "Explain",
      "Define terms",
      "WF Critique",
    ]);
    await api.openReaderInlineAskPromptMenu({ pillId: customId });
    const reset = await api.clickReaderInlineAskPromptMenuItem("reset");
    assert.deepEqual(
      reset.pills.map((pill) => pill.label),
      ["Explain", "Define terms", "Translate"],
    );
    assert.notOk(readPref("inlineAskPrompts"), "Reset clears the list");
    assert.notOk(readPref("inlineAskDeletedPrompts"), "and the deletions");
  });

  it("a prompt added with the Save button sends its prompt", async function () {
    await openCard();
    await api.openReaderInlineAskPromptMenu({ pillId: "define" });
    await api.clickReaderInlineAskPromptMenuItem("add");
    const added = await api.editReaderInlineAskPrompt({
      label: "WF Summary",
      prompt: "WF_SAVE_BUTTON_PROMPT Summarize the passage.",
      via: "save-button",
    });
    const pill = added.card.pills.find((entry) => entry.label === "WF Summary");
    assert.isOk(pill, JSON.stringify(added.card.pills));
    assert.equal(pill!.title, "WF_SAVE_BUTTON_PROMPT Summarize the passage.");
    await api.sendReaderInlineAsk({ pillId: pill!.id });
    const stream = await answer(providerA, "WF_SAVE_BUTTON_PROMPT");
    assert.equal(stream.model, MODEL_A);
    assert.deepEqual(api.readReaderInlineAsk().questions, ["WF Summary"]);
  });

  it("a model picked in the card answers the follow-up and the next card", async function () {
    const opened = await openCard();
    assert.equal(
      opened.modelLabel,
      MODEL_A,
      "the card starts with the sidebar's model",
    );

    const Q1 = "inline-ask-model-first-question";
    await api.sendReaderInlineAsk({ text: Q1 });
    const first = await answer(providerA, Q1);
    assert.equal(first.model, MODEL_A);

    const menu = await api.openReaderInlineAskModelMenu("model");
    assert.equal(menu.kind, "model", JSON.stringify(menu));
    assert.equal(menu.note, "", "an API sidebar needs no note");
    assert.lengthOf(menu.sections, 2, "one section per provider");
    assert.deepEqual(
      menu.options.map((option) => [option.value, option.selected]),
      [
        [ENTRY_A, true],
        [ENTRY_B, false],
      ],
    );
    const picked = await api.pickReaderInlineAskMenuOption(ENTRY_B);
    assert.equal(picked.modelLabel, MODEL_B, JSON.stringify(picked));
    assert.equal(readPref("inlineAskModelEntryId"), ENTRY_B);
    assert.equal(
      readPref("lastUsedModelEntryId"),
      ENTRY_A,
      "the sidebar's model is untouched",
    );

    // The follow-up goes to the newly chosen model.
    const Q2 = "inline-ask-model-follow-up";
    await api.sendReaderInlineAsk({ text: Q2 });
    const second = await answer(providerB, Q2);
    assert.equal(second.model, MODEL_B);
    assert.include(second.requestBody, Q1, "the follow-up keeps the history");

    // A new card starts with the choice; the effort menu lists its levels.
    await api.endReaderInlineAsk({ via: "discard" });
    const reopened = await openCard();
    assert.equal(reopened.modelLabel, MODEL_B);
    const effortMenu = await api.openReaderInlineAskModelMenu("effort");
    assert.equal(effortMenu.kind, "effort");
    assert.deepEqual(effortMenu.sections, ["Reasoning"]);
    assert.includeMembers(
      effortMenu.options.map((option) => option.value),
      ["auto", "low", "high"],
    );
    const withEffort = await api.pickReaderInlineAskMenuOption("high");
    assert.equal(withEffort.effortLabel, "high");
    assert.equal(readPref("inlineAskReasoning"), "high");

    const Q3 = "inline-ask-model-new-card";
    await api.sendReaderInlineAsk({ text: Q3 });
    const third = await answer(providerB, Q3);
    assert.equal(third.model, MODEL_B);
    assert.equal(
      JSON.parse(third.requestBody).reasoning_effort,
      "high",
      third.requestBody,
    );
  });

  it("falls back to the sidebar's model when the chosen entry is gone", async function () {
    Zotero.Prefs.set(
      PREF_PREFIX + "inlineAskModelEntryId",
      "workflow-inline-ask-missing-entry",
      true,
    );
    const opened = await openCard();
    assert.equal(opened.modelLabel, MODEL_A);
    const Q = "inline-ask-model-fallback";
    await api.sendReaderInlineAsk({ text: Q });
    const stream = await answer(providerA, Q);
    assert.equal(stream.model, MODEL_A);
  });

  it("explains the list when the sidebar runs Claude Code", async function () {
    Zotero.Prefs.set(PREF_PREFIX + "enableClaudeCodeMode", true, true);
    Zotero.Prefs.set(PREF_PREFIX + "conversationSystem", "claude_code", true);
    const opened = await openCard();
    assert.equal(opened.modelLabel, MODEL_A, "the first API model");
    const menu = await api.openReaderInlineAskModelMenu("model");
    assert.equal(menu.note, CLAUDE_CODE_NOTE, JSON.stringify(menu));
    assert.lengthOf(menu.options, 2);
  });
});
