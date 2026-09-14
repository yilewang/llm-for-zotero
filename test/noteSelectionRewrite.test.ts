import { assert } from "chai";
import { createEditCurrentNoteTool } from "../src/agent/tools/write/editCurrentNote";
import { buildAgentInitialMessages } from "../src/agent/model/messageBuilder";
import { parseSemanticDecisions } from "../src/agent/model/semanticDecisions";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import { actionFixture, semanticFixture } from "./helpers/semanticIntent";

const before =
  "<h2>Methodology</h2><ul><li>First method.</li><li>Second method.</li><li>Third method.</li></ul><p>Keep this.</p>";
function fixture(
  html = before,
  selected = "First method.\nSecond method.\nThird method.",
) {
  const tool = createEditCurrentNoteTool({
    getActiveNoteSnapshot: () => ({
      noteId: 55,
      libraryID: 1,
      title: "Note",
      html,
      text: html,
      noteKind: "standalone",
    }),
  } as never);
  const request = resolvedAgentRequest({
    conversationKey: 55,
    libraryID: 1,
    mode: "agent",
    userText: "rewrite this part",
    activeItemId: 55,
    activeNoteContext: {
      noteId: 55,
      title: "Note",
      noteKind: "standalone",
      noteText: html,
      noteHtml: html,
    },
    selectedTexts: [selected],
    selectedTextSources: ["note-edit"],
    selectedTextNoteContexts: [
      {
        noteItemId: 55,
        noteItemKey: "NOTE55",
        libraryID: 1,
        noteKind: "standalone",
        title: "Note",
      },
    ],
  });
  const context = {
    request,
    runId: "selection-unit",
    item: null,
    modelName: "test",
    currentAnswerText: "",
  } as never;
  return { tool, context, request };
}

describe("selected note replacement contract", function () {
  it("binds selected text once and prepares structural replacement without copying find or the whole note", async function () {
    const { tool, context } = fixture();
    const input = tool.validate({
      mode: "edit",
      selection: { index: 1, replacement: "Revised method." },
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    await tool.planInvocation(input.value, context);
    assert.equal(input.value.noteId, 55);
    assert.equal(input.value.expectedOriginalHtml, before);
    assert.include(input.value._patchedHtml, "<p>Revised method.</p>");
    assert.notInclude(input.value._patchedHtml, "<li>");
    assert.include(input.value._patchedHtml, "<h2>Methodology</h2>");
    assert.include(input.value._patchedHtml, "<p>Keep this.</p>");
  });
  it("represents supplied prose as the reading source instead of requiring paper evidence", async function () {
    const { request } = fixture();
    const semantic = semanticFixture({
      reading: { source: "provided_context", coverage: "targeted" } as never,
    });
    assert.isNotNull(parseSemanticDecisions({ decisions: semantic }));
    const messages = await buildAgentInitialMessages(
      {
        ...request,
        classifiedIntent: {
          ...actionFixture("note_edit", { targetNoteId: 55 }),
          semantic,
        },
      },
      [],
      [],
    );
    const text = JSON.stringify(messages);
    assert.notInclude(text, "Use paper_read mode");
    assert.include(text, "provided context");
  });
});

import {
  replaceNoteSelectionHtml,
  replaceTextContentInHtml,
} from "../src/utils/noteEdit";
import { noteHtmlMatches } from "../src/utils/noteHtml";
import { AgentToolRegistry } from "../src/agent/tools/registry";

describe("native selection structure and boundaries", function () {
  for (const [label, html, selected, replacement, expected] of [
    [
      "heading and bullets",
      before,
      "Methodology\nFirst method.\nSecond method.\nThird method.",
      "<h2>Methodology</h2><p>Revised.</p>",
      "<h2>Methodology</h2><p>Revised.</p><p>Keep this.</p>",
    ],
    [
      "middle ordered list items",
      '<ol start="3"><li>Keep A.</li><li>First.</li><li>Second.</li><li>Keep B.</li></ol>',
      "First.\nSecond.",
      "<p>Revised.</p>",
      '<ol start="3"><li>Keep A.</li></ol><p>Revised.</p><ol start="6"><li>Keep B.</li></ol>',
    ],
    [
      "inline style and Unicode",
      "<p><strong>Keep A &amp; 🧠. Revise this.</strong> Keep B.</p>",
      "Revise this.",
      "<p>Better.</p>",
      "<p><strong>Keep A &amp; 🧠. Better.</strong> Keep B.</p>",
    ],
    [
      "Markdown within a sentence",
      "<p>Before old text after.</p>",
      "old text",
      "<p><em>new text</em></p>",
      "<p>Before <em>new text</em> after.</p>",
    ],
    [
      "partial blocks",
      "<p>Keep A. First.</p><p>Second. Keep B.</p>",
      "First.\nSecond.",
      "<p>Revised.</p>",
      "<p>Keep A. </p><p>Revised.</p><p> Keep B.</p>",
    ],
    [
      "image outside selection",
      '<p><img data-attachment-key="ABC12345"></p><ul><li>First.</li><li>Second.</li></ul><p>Keep.</p>',
      "First.\nSecond.",
      "<p>Revised.</p>",
      '<p><img data-attachment-key="ABC12345"></p><p>Revised.</p><p>Keep.</p>',
    ],
    [
      "image inside text selection",
      '<p>First.<img data-attachment-key="ABC12345"></p><p>Second.</p><p>Keep.</p>',
      "First.\nSecond.",
      "<p>Revised.</p>",
      '<p><img data-attachment-key="ABC12345"></p><p>Revised.</p><p>Keep.</p>',
    ],
  ]) {
    it(`preserves ${label}`, function () {
      const result = replaceNoteSelectionHtml(html, selected, replacement);
      assert.isNotNull(result);
      assert.isTrue(noteHtmlMatches(result!, expected), result!);
    });
  }
  for (const html of [
    "<p>Repeated.</p><p>Repeated.</p>",
    "<p>Unrelated.</p>",
  ]) {
    it("rejects ambiguous or missing selections before preparing a write", function () {
      assert.isNull(replaceNoteSelectionHtml(html, "Repeated.", "<p>New.</p>"));
    });
  }
  it("rejects a target different from the selected note", async function () {
    const { tool, context } = fixture();
    const input = tool.validate({
      mode: "edit",
      targetNoteId: 66,
      selection: { index: 1, replacement: "New." },
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    try {
      await tool.planInvocation(input.value, context);
      assert.fail("must reject");
    } catch (error) {
      assert.include(String(error), "must belong to the target note");
    }
  });
  it("rejects selection context from a PDF as an editing target", async function () {
    const { tool, context, request } = fixture();
    request.selectedTextContexts = request.selectedTextContexts!.map((c) => ({
      ...c,
      source: "pdf",
    }));
    const input = tool.validate({
      mode: "edit",
      selection: { index: 1, replacement: "New." },
    });
    if (!input.ok) return assert.fail(input.error);
    try {
      await tool.planInvocation(input.value, context);
      assert.fail("must reject");
    } catch (error) {
      assert.include(String(error), "must belong to the target note");
    }
  });
  it("offers only the note tools needed by a self-contained edit and keeps research tools for requested source work", function () {
    const registry = new AgentToolRegistry();
    for (const name of [
      "note_write",
      "library_read",
      "request_user_input",
      "paper_read",
      "library_search",
      "submit_document",
    ])
      registry.register({
        spec: {
          name,
          description: name,
          inputSchema: { type: "object" },
          executionClass: "read",
        },
        validate: () => ({ ok: true, value: {} }),
        execute: async () => ({}),
      } as never);
    const { request } = fixture();
    request.classifiedIntent = {
      ...actionFixture("note_edit", { targetNoteId: 55 }),
      semantic: semanticFixture({
        reading: { source: "provided_context", coverage: "targeted" } as never,
      }),
    };
    assert.deepEqual(
      registry.listToolsForRequest(request).map((t) => t.name),
      ["note_write", "library_read", "request_user_input"],
    );
    request.documentOutcomePolicy = { required: true } as never;
    assert.include(
      registry.listToolsForRequest(request).map((t) => t.name),
      "submit_document",
    );
    request.documentOutcomePolicy = undefined;
    request.classifiedIntent.semantic!.reading.source = "document_text";
    assert.include(
      registry.listToolsForRequest(request).map((t) => t.name),
      "paper_read",
    );
  });
});

describe("verified selection edit completion", function () {
  it("finishes from the native receipt without a second model round, but keeps requested explanation, compound work and unverified results open", async function () {
    const { tool, context, request } = fixture();
    request.classifiedIntent = {
      ...actionFixture("note_edit", { targetNoteId: 55 }),
      semantic: semanticFixture({
        reading: { source: "provided_context", coverage: "targeted" },
        responseIntent: "receipt",
      } as never),
    };
    request.actionContract = {
      id: "contract",
      version: 4,
      writeDisposition: "required",
      interpretationSource: "semantic",
      obligations: [
        {
          id: "edit",
          operation: "note_edit",
          coverage: "one",
          targetKind: "items",
          parameters: { targetNoteId: 55 },
          targetBoundary: {
            kind: "selection",
            libraryID: 1,
            frozenTargetIds: [55],
            scopeDigest: "bound",
          },
        },
      ],
    };
    const result = {
      ok: true,
      content: {
        actionId: "change",
        status: "updated",
        noteVerification: { noteId: 55, matches: true },
        noteChange: {
          title: "Note",
          note: { itemId: 55, key: "NOTE55", libraryID: 1 },
          state: "applied",
          before: { checksum: "before" },
          after: { checksum: "after" },
          description: "The note was updated and verified in Zotero.",
        },
      },
      actionReceipts: [
        {
          obligationId: "edit",
          operation: "note_edit",
          verification: "verified",
          status: "applied",
          appliedTargets: ["item:55"],
          alreadySatisfiedTargets: [],
          rejectedTargets: [],
        },
      ],
    } as never;
    const input = tool.validate({
      mode: "edit",
      selection: { index: 1, replacement: "New." },
    });
    if (!input.ok) return assert.fail(input.error);
    assert.isFunction(tool.resolveTerminalResult);
    const terminal = await tool.resolveTerminalResult!(
      input.value,
      result,
      context,
    );
    assert.include(terminal?.finalText, "verified");
    assert.equal(terminal?.providerTranscript, "tool_only");
    const semantic = request.classifiedIntent.semantic as any;
    semantic.responseIntent = "answer";
    assert.isNull(
      await tool.resolveTerminalResult!(input.value, result, context),
    );
    semantic.responseIntent = "receipt";
    (result as any).actionReceipts[0].verification = "execution_only";
    assert.isNull(
      await tool.resolveTerminalResult!(input.value, result, context),
    );
    (result as any).actionReceipts[0].verification = "verified";
    request.actionContract.obligations.push({
      ...request.actionContract.obligations[0],
      id: "second",
    });
    assert.isNull(
      await tool.resolveTerminalResult!(input.value, result, context),
    );
  });
});

describe("selection recovery and embedded content", function () {
  it("does not leave empty bullets in a text patch that crosses an embedded image", function () {
    const html =
      '<ul><li><strong>First.</strong><img data-attachment-key="IMAGE123"></li><li>Second.</li></ul><p>Keep.</p>';
    const result = replaceTextContentInHtml(
      html,
      "First.\nSecond.",
      "Revised.",
    );
    assert.isTrue(
      noteHtmlMatches(
        result!,
        '<ul><li><strong>Revised.</strong><img data-attachment-key="IMAGE123"></li></ul><p>Keep.</p>',
      ),
      result!,
    );
  });
  it("rejects a note changed since selection instead of rebasing the edit", async function () {
    const { tool, context, request } = fixture();
    request.activeNoteContext!.noteHtml = before.replace(
      "Keep this.",
      "Older surrounding text.",
    );
    const input = tool.validate({
      mode: "edit",
      selection: { index: 1, replacement: "New." },
    });
    if (!input.ok) return assert.fail(input.error);
    try {
      await tool.planInvocation(input.value, context);
      assert.fail("must reject");
    } catch (error) {
      assert.include(String(error), "changed after the text was selected");
    }
  });
});

describe("table structure boundaries", function () {
  it("keeps a selected cell in its row and preserves the other columns", function () {
    const before =
      "<table><tbody><tr><td>First.</td><td>Keep.</td></tr></tbody></table>";
    const after = replaceNoteSelectionHtml(before, "First.", "<p>Revised.</p>");
    assert.isTrue(
      noteHtmlMatches(
        after!,
        "<table><tbody><tr><td><p>Revised.</p></td><td>Keep.</td></tr></tbody></table>",
      ),
      after!,
    );
  });
  it("rejects a structural replacement spanning cells rather than splitting the table", function () {
    const before =
      "<table><tbody><tr><td><p>First.</p></td><td><p>Second.</p></td><td><p>Keep.</p></td></tr></tbody></table>";
    assert.throws(
      () =>
        replaceNoteSelectionHtml(before, "First.\nSecond.", "<p>Combined.</p>"),
      /table cells/,
    );
  });
  it("keeps table cells when a precise text patch consumes their text", function () {
    const before =
      "<table><tbody><tr><td><p>First.</p></td><td><p>Second.</p></td><td><p>Third.</p></td><td><p>Keep.</p></td></tr></tbody></table>";
    const after = replaceTextContentInHtml(
      before,
      "First.\nSecond.\nThird.",
      "Combined.",
    );
    assert.isTrue(
      noteHtmlMatches(
        after!,
        "<table><tbody><tr><td><p>Combined.</p></td><td></td><td></td><td><p>Keep.</p></td></tr></tbody></table>",
      ),
      after!,
    );
  });
});

import { resolveNoteEditModelRequest } from "../src/agent/model/noteEditingPolicy";
import { buildReasoningPayload } from "../src/utils/llmClient";

describe("faithful rewrite generation policy", function () {
  it("uses the provider's supported non-thinking mode for a faithful transformation without changing saved settings", function () {
    const { request } = fixture();
    request.model = "deepseek-v4-flash";
    request.apiBase = "https://api.deepseek.com";
    request.providerProtocol = "openai_chat_compat";
    request.reasoning = { provider: "deepseek", level: "high" };
    request.classifiedIntent = {
      ...actionFixture("note_edit", { targetNoteId: 55 }),
      semantic: semanticFixture({
        reading: { source: "provided_context", coverage: "targeted" },
        generationMode: "transform",
        responseIntent: "receipt",
      } as never),
    };
    const generation = resolveNoteEditModelRequest(request);
    assert.deepEqual(
      buildReasoningPayload(
        generation.reasoning,
        false,
        request.model,
        request.apiBase,
        request.providerProtocol,
      ).extra,
      { thinking: { type: "disabled" } },
    );
    assert.deepEqual(request.reasoning, {
      provider: "deepseek",
      level: "high",
    });
    assert.strictEqual(generation.actionContract, request.actionContract);
    (request.classifiedIntent.semantic as any).generationMode = "reason";
    assert.strictEqual(
      resolveNoteEditModelRequest(request),
      request,
      "substantive reasoning keeps the configured mode",
    );
    (request.classifiedIntent.semantic as any).generationMode = "transform";
    request.classifiedIntent.semantic!.reading.source = "document_text";
    assert.strictEqual(
      resolveNoteEditModelRequest(request),
      request,
      "source-based work keeps the configured mode",
    );
  });
});
