import { assert } from "chai";
import { describe, it } from "mocha";
import {
  buildExternalBridgeContextSignatureForTests,
  buildExternalBridgeContextEnvelopeForTests,
  buildBridgeRuntimeRequestForTests,
  buildClaudeBridgeCustomInstructionForTests,
  resolveClaudeBridgeModelForMetadata,
  supportsClaudeBridgeLocalPdfPathsForTests,
  fetchExternalBridgeSessionInfo,
} from "../src/agent/externalBackendBridge";
import {
  MAX_FULL_TEXT_PAPER_CONTEXTS,
  MAX_SELECTED_PAPER_CONTEXTS,
} from "../src/shared/contextLimits";

function paper(index: number) {
  return {
    itemId: 1_000 + index,
    contextItemId: 2_000 + index,
    title: `Bridge Paper ${index}`,
  };
}

describe("external bridge session-info fallback", function () {
  it("forwards every non-empty Claude model value exactly, including default", function () {
    assert.equal(resolveClaudeBridgeModelForMetadata("default"), "default");
    assert.equal(
      resolveClaudeBridgeModelForMetadata("  FutureModel-V7[2m]  "),
      "FutureModel-V7[2m]",
    );
    assert.isUndefined(resolveClaudeBridgeModelForMetadata("   "));
  });

  it("makes the raw PDF policy authoritative after Claude skill guidance", function () {
    const previousZotero = (globalThis as { Zotero?: unknown }).Zotero;
    (globalThis as { Zotero?: unknown }).Zotero = {
      Prefs: { get: () => "" },
    };
    let instruction = "";
    try {
      instruction = buildClaudeBridgeCustomInstructionForTests(true);
    } finally {
      (globalThis as { Zotero?: unknown }).Zotero = previousZotero;
    }

    assert.notInclude(
      instruction,
      "paper-content questions before relying on filesystem exploration",
    );
    assert.match(
      instruction.trim(),
      /Raw PDF transport policy[\s\S]*Never fall back to extracted or retrieved paper text\.$/,
    );
  });

  it("preserves exact local PDF resources in the bridge request", async function () {
    const localDocuments = [
      {
        kind: "local_pdf" as const,
        sourceKey: "zotero-pdf:10:20" as const,
        itemId: 10,
        contextItemId: 20,
        title: "Paper",
        name: "paper.pdf",
        mimeType: "application/pdf" as const,
        absolutePath: "/papers/paper.pdf",
      },
    ];

    const request = await buildBridgeRuntimeRequestForTests({
      conversationKey: 42,
      mode: "agent",
      userText: "read it",
      libraryID: 1,
      pdfPaperContexts: [{ itemId: 10, contextItemId: 20, title: "Paper" }],
      localDocuments,
    });

    assert.deepEqual(request.localDocuments, localDocuments);
  });

  it("fails closed for bridge health responses without local PDF capability", function () {
    assert.isTrue(
      supportsClaudeBridgeLocalPdfPathsForTests({
        ok: true,
        protocolVersion: 2,
        capabilities: ["local_pdf_paths"],
      }),
    );
    assert.isFalse(supportsClaudeBridgeLocalPdfPathsForTests({ ok: true }));
    assert.isFalse(
      supportsClaudeBridgeLocalPdfPathsForTests({
        ok: true,
        protocolVersion: 1,
        capabilities: ["local_pdf_paths"],
      }),
    );
  });

  it("continues probing after a 404 from an earlier candidate", async function () {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    let requestCount = 0;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      requestCount += 1;
      if (requestCount === 1) {
        return new Response("not found", { status: 404 }) as Response;
      }
      return new Response(
        JSON.stringify({
          session: {
            originalConversationKey: "42",
            scopedConversationKey: "42::paper:7:9",
            providerSessionId: "sess-ok",
            scopeType: "paper",
            scopeId: "7:9",
            scopeLabel: "Paper",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ) as Response;
    }) as typeof fetch;

    try {
      const session = await fetchExternalBridgeSessionInfo({
        baseUrl: "http://127.0.0.1:19787",
        conversationKey: 42,
        scopeType: "paper",
        scopeId: "7:9",
        scopeLabel: "Paper",
      });
      assert.equal(session?.providerSessionId, "sess-ok");
      assert.isAtLeast(calls.length, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves raised paper context caps in the bridge envelope", function () {
    const papers = Array.from(
      { length: MAX_SELECTED_PAPER_CONTEXTS + 5 },
      (_, index) => paper(index + 1),
    );
    const envelope = buildExternalBridgeContextEnvelopeForTests({
      conversationKey: 1,
      mode: "agent",
      userText: "Use the selected papers.",
      libraryID: 1,
      selectedPaperContexts: papers,
      fullTextPaperContexts: papers,
      pinnedPaperContexts: papers,
    });

    assert.equal(envelope.selectedPaperCount, papers.length);
    assert.equal(envelope.fullTextPaperCount, papers.length);
    assert.equal(envelope.pinnedPaperCount, papers.length);
    assert.lengthOf(envelope.selectedPapers, MAX_SELECTED_PAPER_CONTEXTS);
    assert.lengthOf(envelope.fullTextPapers, MAX_FULL_TEXT_PAPER_CONTEXTS);
    assert.lengthOf(envelope.pinnedPapers, MAX_FULL_TEXT_PAPER_CONTEXTS);
    assert.equal(
      envelope.selectedPapers[MAX_SELECTED_PAPER_CONTEXTS - 1].contextItemId,
      paper(MAX_SELECTED_PAPER_CONTEXTS).contextItemId,
    );
    assert.equal(
      envelope.fullTextPapers[MAX_FULL_TEXT_PAPER_CONTEXTS - 1].contextItemId,
      paper(MAX_FULL_TEXT_PAPER_CONTEXTS).contextItemId,
    );
  });

  it("includes selected tag contexts in the bridge envelope without expanding papers", function () {
    const envelope = buildExternalBridgeContextEnvelopeForTests({
      conversationKey: 1,
      mode: "agent",
      userText: "Use this tag.",
      selectedTagContexts: [
        {
          name: "Stable",
          normalizedName: "stable",
          libraryID: 1,
        },
        {
          name: "All Tagged",
          libraryID: 1,
          scope: "allTagged",
          includeAutomatic: true,
        },
      ],
    });

    assert.equal(envelope.selectedTagCount, 2);
    assert.deepEqual(envelope.selectedTags, [
      {
        name: "Stable",
        libraryID: 1,
        normalizedName: "stable",
        scope: undefined,
        includeAutomatic: undefined,
      },
      {
        name: "All Tagged",
        libraryID: 1,
        normalizedName: "all tagged",
        scope: "allTagged",
        includeAutomatic: true,
      },
    ]);
    assert.equal(envelope.selectedPaperCount, 0);
    assert.lengthOf(envelope.selectedPapers, 0);
  });

  it("preserves selected note-edit context in the bridge envelope", function () {
    const envelope = buildExternalBridgeContextEnvelopeForTests({
      conversationKey: 3_700_003_703,
      mode: "agent",
      userText: "help me rewrite this sentence",
      conversationKind: "paper",
      activeItemId: 3612,
      selectedTexts: ["Panel A illustrates the stability problem."],
      selectedTextSources: ["note-edit"],
      selectedTextNoteContexts: [
        {
          libraryID: 1,
          noteItemKey: "NOTEKEY",
          noteItemId: 3703,
          parentItemId: 3612,
          noteKind: "item",
          title: "Ajemian et al., 2013 - MD",
        },
      ],
      activeNoteContext: {
        noteId: 3703,
        title: "Ajemian et al., 2013 - MD",
        noteKind: "item",
        parentItemId: 3612,
        noteText: "Panel A illustrates the stability problem.",
      },
    });

    assert.equal(envelope.selectedTextCount, 1);
    assert.deepEqual(envelope.selectedTexts[0].noteContext, {
      noteItemId: 3703,
      title: "Ajemian et al., 2013 - MD",
      noteKind: "item",
      parentItemId: 3612,
    });
    assert.equal(envelope.activeNote?.noteId, 3703);
    assert.include(envelope.visibleContext || "", "Selected text notes:");
  });

  it("keeps bridge context signatures stable for selected tag order", function () {
    const first = buildExternalBridgeContextSignatureForTests({
      conversationKey: 1,
      mode: "agent",
      userText: "Use these tags.",
      selectedTagContexts: [
        { name: "Stable", normalizedName: "stable", libraryID: 1 },
        { name: "Data", normalizedName: "data", libraryID: 1 },
      ],
    });
    const second = buildExternalBridgeContextSignatureForTests({
      conversationKey: 1,
      mode: "agent",
      userText: "Use these tags.",
      selectedTagContexts: [
        { name: "Data", normalizedName: "data", libraryID: 1 },
        { name: "Stable", normalizedName: "stable", libraryID: 1 },
      ],
    });
    const changed = buildExternalBridgeContextSignatureForTests({
      conversationKey: 1,
      mode: "agent",
      userText: "Use these tags.",
      selectedTagContexts: [
        { name: "Stable", normalizedName: "stable", libraryID: 1 },
        { name: "new", normalizedName: "new", libraryID: 1 },
      ],
    });

    assert.equal(first, second);
    assert.notEqual(first, changed);
  });
});
