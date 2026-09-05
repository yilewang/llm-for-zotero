import { assert } from "chai";
import {
  buildTurnPaperKey,
  buildTurnPaperScope,
  getSelectedPassagePaper,
} from "../src/agent/context/turnPaperScope";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import { buildVisibleTurnContextBlock } from "../src/agent/context/turnContextEnvelope";
import { resolveDefaultTargets } from "../src/agent/tools/read/pdfToolUtils";
import type { AgentRuntimeRequestInput } from "../src/agent/types";
import type { PaperContextRef } from "../src/shared/types";

describe("TurnPaperScope", function () {
  const activePaper: PaperContextRef = {
    itemId: 10,
    contextItemId: 11,
    title: "Active paper",
    firstCreator: "Active",
    year: "2025",
  };
  const addedPaper: PaperContextRef = {
    itemId: 20,
    contextItemId: 21,
    title: "Added paper",
    firstCreator: "Added",
    year: "2024",
  };

  function input(
    overrides: Partial<AgentRuntimeRequestInput> = {},
  ): AgentRuntimeRequestInput {
    return {
      conversationKey: 1,
      mode: "agent",
      userText: "",
      libraryID: 1,
      conversationKind: "paper",
      activeItemId: activePaper.itemId,
      selectedPaperContexts: [activePaper, addedPaper],
      ...overrides,
    };
  }

  it("builds one active-first scope and merges visible roles by canonical key", function () {
    const resolved = resolveAgentRuntimeRequest(
      input({
        fullTextPaperContexts: [addedPaper],
        pinnedPaperContexts: [addedPaper],
        citationPaperContexts: [
          { itemId: 30, contextItemId: 31, title: "Citation only" },
        ],
      }),
    );

    assert.deepEqual(
      resolved.turnPaperScope.papers.map((entry) => ({
        key: buildTurnPaperKey(entry.paper),
        roles: entry.roles,
      })),
      [
        { key: "1:10:11", roles: ["active"] },
        {
          key: "1:20:21",
          roles: ["selected", "full_text", "pinned"],
        },
      ],
    );
    assert.notProperty(resolved, "selectedPaperContexts");
    assert.notProperty(resolved, "citationPaperContexts");
  });

  it("treats the complete supplied active identity as authoritative over a portal or note item ID", function () {
    const exactActive: PaperContextRef = {
      libraryID: 1,
      itemId: 42,
      contextItemId: 101,
      title: "Exact active attachment",
    };
    const defaultAttachment: PaperContextRef = {
      libraryID: 1,
      itemId: 42,
      contextItemId: 100,
      title: "Default attachment",
    };
    const resolved = resolveAgentRuntimeRequest(
      input({
        activeItemId: 700,
        activePaperContext: exactActive,
        selectedPaperContexts: [defaultAttachment, exactActive],
        pdfPaperContexts: [exactActive],
      }),
    );

    assert.deepEqual(
      resolved.turnPaperScope.papers.map((entry) => ({
        key: buildTurnPaperKey(entry.paper),
        roles: entry.roles,
      })),
      [
        { key: "1:42:101", roles: ["active", "raw_pdf"] },
        { key: "1:42:100", roles: ["selected"] },
      ],
    );
    assert.notProperty(resolved, "activePaperContext");
  });

  it("strips nested passage identities while preserving indexed associations and gaps", function () {
    const passageOnlyPaper: PaperContextRef = {
      itemId: 40,
      contextItemId: 41,
      title: "Passage parent",
    };
    const resolved = resolveAgentRuntimeRequest(
      input({
        selectedTextContexts: [
          {
            text: "PDF passage",
            source: "pdf",
            paperContext: passageOnlyPaper,
          },
          {
            text: "Note passage",
            source: "note",
          },
        ],
        resolvedSelectedTextAnchors: [
          {
            contextIndex: 0,
            contextItemId: 41,
            resolution: "exact",
            paperContext: passageOnlyPaper,
          },
        ],
      }),
    );

    assert.notProperty(
      resolved.selectedTextContexts?.[0] || {},
      "paperContext",
    );
    assert.notProperty(
      resolved.resolvedSelectedTextAnchors?.[0] || {},
      "paperContext",
    );
    assert.deepEqual(
      resolved.turnPaperScope.selectedPassagePaperRefs.map(
        (entry) => entry.contextIndex,
      ),
      [0],
    );
    assert.equal(
      getSelectedPassagePaper(resolved.turnPaperScope, 0)?.itemId,
      40,
    );
    assert.isUndefined(getSelectedPassagePaper(resolved.turnPaperScope, 1));
    assert.notInclude(
      resolved.turnPaperScope.papers.map((entry) => entry.paper.itemId),
      40,
    );
  });

  it("normalizes legacy parallel passage arrays without promoting their papers", function () {
    const passageOnlyPaper: PaperContextRef = {
      itemId: 50,
      contextItemId: 51,
      title: "Legacy passage parent",
    };
    const resolved = resolveAgentRuntimeRequest(
      input({
        selectedTextContexts: undefined,
        selectedTexts: ["Legacy passage", "Standalone note"],
        selectedTextSources: ["pdf", "note"],
        selectedTextPaperContexts: [passageOnlyPaper, undefined],
      }),
    );

    assert.equal(resolved.selectedTextContexts?.[0]?.text, "Legacy passage");
    assert.equal(
      getSelectedPassagePaper(resolved.turnPaperScope, 0)?.contextItemId,
      51,
    );
    assert.notInclude(
      resolved.turnPaperScope.papers.map((entry) => entry.paper.itemId),
      50,
    );
  });

  it("keeps an unresolved optional passage parent as a visible warning", function () {
    const resolved = resolveAgentRuntimeRequest(
      input({
        selectedTextContexts: [
          {
            text: "Passage survives",
            source: "pdf",
            paperContext: {
              itemId: 0,
              contextItemId: 0,
              title: "Broken",
            },
          },
        ],
      }),
    );

    assert.equal(resolved.selectedTextContexts?.[0]?.text, "Passage survives");
    assert.equal(resolved.turnPaperScopeWarnings?.[0]?.contextIndex, 0);
    assert.include(
      buildVisibleTurnContextBlock(resolved),
      "Paper scope warning:",
    );
  });

  it("resolves partial legacy paper identities only through the supplied compatibility resolver", function () {
    let calls = 0;
    const resolved = resolveAgentRuntimeRequest(
      input({
        activeItemId: undefined,
        conversationKind: "global",
        selectedPaperContexts: [
          { itemId: 60, title: "Partial" } as PaperContextRef,
        ],
      }),
      {
        resolvePaperContext: ({ itemId }) => {
          calls += 1;
          return itemId === 60
            ? { itemId: 60, contextItemId: 61, title: "Recovered" }
            : null;
        },
      },
    );

    assert.equal(calls, 1);
    assert.equal(resolved.turnPaperScope.papers[0]?.paper.contextItemId, 61);
  });

  it("does not query the compatibility resolver for complete UI references", function () {
    let calls = 0;
    resolveAgentRuntimeRequest(input(), {
      resolvePaperContext: () => {
        calls += 1;
        return null;
      },
    });
    assert.equal(calls, 0);
  });

  it("fails closed for invalid visible papers, collections, and tags", function () {
    assert.throws(
      () =>
        resolveAgentRuntimeRequest(
          input({
            selectedPaperContexts: [
              { itemId: 0, contextItemId: 0, title: "Broken" },
            ],
          }),
        ),
      /invalid identity/,
    );
    assert.throws(
      () =>
        resolveAgentRuntimeRequest(
          input({
            selectedCollectionContexts: [
              { collectionId: 2, libraryID: 9, name: "Wrong library" },
            ],
          }),
        ),
      /different Zotero library/,
    );
    assert.throws(
      () =>
        resolveAgentRuntimeRequest(
          input({
            selectedTagContexts: [{ name: "", libraryID: 1 }],
          }),
        ),
      /invalid identity/,
    );
  });

  it("links local PDF transport to one existing raw-PDF paper", function () {
    const rawPaper = {
      ...addedPaper,
      contentSourceMode: "pdf" as const,
    };
    const resolved = resolveAgentRuntimeRequest(
      input({
        pdfPaperContexts: [rawPaper],
        localDocuments: [
          {
            kind: "local_pdf",
            sourceKey: "zotero-pdf:20:21",
            itemId: 20,
            contextItemId: 21,
            title: "Added paper",
            name: "added.pdf",
            mimeType: "application/pdf",
            absolutePath: "/tmp/added.pdf",
          },
        ],
      }),
    );

    assert.equal(resolved.localDocuments?.[0]?.paperKey, "1:20:21");
    assert.equal(
      resolved.localDocuments?.[0]?.resource.absolutePath,
      "/tmp/added.pdf",
    );
    assert.notProperty(resolved.localDocuments?.[0] || {}, "itemId");
  });

  it("rejects transport that adds, duplicates, or misidentifies scope papers", function () {
    const document = {
      kind: "local_pdf" as const,
      sourceKey: "zotero-pdf:20:21" as const,
      itemId: 20,
      contextItemId: 21,
      title: "Added paper",
      name: "added.pdf",
      mimeType: "application/pdf" as const,
      absolutePath: "/tmp/added.pdf",
    };
    const notRaw = buildTurnPaperScope({
      libraryID: 1,
      selectedPaperContexts: [addedPaper],
      localDocuments: [document],
    });
    assert.equal(notRaw.ok, false);
    if (!notRaw.ok) assert.equal(notRaw.code, "invalid_turn_pdf_transport");

    const duplicated = buildTurnPaperScope({
      libraryID: 1,
      pdfPaperContexts: [{ ...addedPaper, contentSourceMode: "pdf" }],
      localDocuments: [document, document],
    });
    assert.equal(duplicated.ok, false);

    const relativePath = buildTurnPaperScope({
      libraryID: 1,
      pdfPaperContexts: [{ ...addedPaper, contentSourceMode: "pdf" }],
      localDocuments: [{ ...document, absolutePath: "added.pdf" }],
    });
    assert.equal(relativePath.ok, false);

    const incompleteBatch = buildTurnPaperScope({
      libraryID: 1,
      pdfPaperContexts: [
        { ...addedPaper, contentSourceMode: "pdf" },
        {
          itemId: 30,
          contextItemId: 31,
          title: "Second raw paper",
          contentSourceMode: "pdf",
        },
      ],
      localDocuments: [document],
    });
    assert.equal(incompleteBatch.ok, false);
    if (!incompleteBatch.ok) {
      assert.include(incompleteBatch.message, "missing a local document");
    }
  });

  it("applies this-paper, added-paper, and these-paper defaults from the same scope", function () {
    const gateway = {
      listPaperContexts: () => {
        throw new Error("resolved requests must not reconstruct tool scope");
      },
      resolvePaperContextTarget: (selector: {
        itemId?: number;
        contextItemId?: number;
      }) =>
        [activePaper, addedPaper].find(
          (paper) =>
            paper.itemId === selector.itemId &&
            paper.contextItemId === selector.contextItemId,
        ) || null,
    } as never;
    const targets = (userText: string) => {
      const request = resolveAgentRuntimeRequest(input({ userText }));
      return resolveDefaultTargets(
        undefined,
        undefined,
        { request },
        gateway,
        8,
      ).map((paper) => paper.itemId);
    };

    assert.deepEqual(targets("Explain this paper"), [10]);
    assert.deepEqual(targets("Compare the added papers"), [20]);
    assert.deepEqual(targets("Compare these papers"), [10, 20]);
    assert.deepEqual(targets("Compare both papers"), [10, 20]);
  });

  it("uses classified paper-set intent before English heuristics with a legacy summarize fallback", function () {
    const gateway = {
      listPaperContexts: () => {
        throw new Error("resolved requests must not reconstruct tool scope");
      },
      resolvePaperContextTarget: (selector: {
        itemId?: number;
        contextItemId?: number;
      }) =>
        [activePaper, addedPaper].find(
          (paper) =>
            paper.itemId === selector.itemId &&
            paper.contextItemId === selector.contextItemId,
        ) || null,
    } as never;
    const targets = (
      paperTargetIntent:
        | "active"
        | "added"
        | "all_visible"
        | "unspecified"
        | undefined,
      retrievalIntent: "enumerate" | "verify" | "summarize" | "none" = "none",
      userText = "比较这些论文",
      overrides: Partial<AgentRuntimeRequestInput> = {},
    ) => {
      const request = resolveAgentRuntimeRequest(
        input({
          userText,
          classifiedIntent: {
            retrievalIntent,
            ...(paperTargetIntent ? { paperTargetIntent } : {}),
            wantedSections: [],
            actionIntents: [],
          },
          ...overrides,
        }),
      );
      return resolveDefaultTargets(
        undefined,
        undefined,
        { request },
        gateway,
        8,
      ).map((paper) => paper.itemId);
    };

    assert.deepEqual(targets("all_visible"), [10, 20]);
    assert.deepEqual(targets("active"), [10]);
    assert.deepEqual(targets("added"), [20]);
    assert.deepEqual(targets("unspecified"), [10]);
    assert.deepEqual(targets(undefined, "summarize"), [10, 20]);
    assert.deepEqual(
      targets("all_visible", "none", "比较这些论文", {
        selectedPaperContexts: [activePaper, activePaper, addedPaper],
      }),
      [10, 20],
    );
    assert.deepEqual(
      targets("active", "none", "this paper", {
        conversationKind: "global",
        activeItemId: undefined,
        activePaperContext: undefined,
        selectedPaperContexts: [addedPaper],
      }),
      [],
    );
    assert.deepEqual(
      targets("added", "none", "已添加的论文", {
        conversationKind: "global",
        activeItemId: undefined,
        activePaperContext: undefined,
        selectedPaperContexts: [activePaper, addedPaper],
      }),
      [10, 20],
    );

    const explicitRequest = resolveAgentRuntimeRequest(
      input({
        classifiedIntent: {
          retrievalIntent: "summarize",
          paperTargetIntent: "all_visible",
          wantedSections: [],
          actionIntents: [],
        },
      }),
    );
    assert.deepEqual(
      resolveDefaultTargets(
        undefined,
        [{ paperContext: addedPaper }],
        { request: explicitRequest },
        gateway,
        8,
      ).map((paper) => paper.itemId),
      [20],
    );
    assert.deepEqual(
      resolveDefaultTargets(
        undefined,
        undefined,
        { request: explicitRequest },
        gateway,
        1,
      ).map((paper) => paper.itemId),
      [10],
    );
  });

  it("creates independent immutable-by-type snapshots for successive turns", function () {
    const first = resolveAgentRuntimeRequest(input()).turnPaperScope;
    const second = resolveAgentRuntimeRequest(
      input({ selectedPaperContexts: [activePaper] }),
    ).turnPaperScope;

    assert.deepEqual(
      first.papers.map((entry) => entry.paper.itemId),
      [10, 20],
    );
    assert.deepEqual(
      second.papers.map((entry) => entry.paper.itemId),
      [10],
    );
  });
});
