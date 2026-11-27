import { assert } from "chai";
import type {
  RuntimePromptParityInput,
  RuntimePromptParityResult,
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

/**
 * What the model sees, compared across runtimes (docs: the runtime parity
 * plan). The original agent is the reference; Claude Code, Antigravity and
 * Codex each declare, block by block, what they send
 * (agent/context/turnPromptBlocks.ts). For the same turns this checks that
 * every block a runtime declares `send` is in what its own prompt assembly
 * sends, that the blocks it shares with the original agent carry the same
 * text, and that no declared block silently renders nothing.
 *
 * The turns are the ones earlier fixes were about: a quote from a model
 * reply with a question attached (#586, #587), quotes from two papers, an
 * open note with a note-edit quote, custom instructions, a selected
 * collection, a clarification, a side chat, a raw-PDF turn and a single-paper
 * chat.
 */
describe("workflow: runtime prompt parity", function () {
  this.timeout(120000);

  let api: WorkflowTestApi;
  let paperA: WorkflowTestFixture;
  let paperB: WorkflowTestFixture;
  const results = new Map<string, RuntimePromptParityResult>();

  const RUNTIMES = ["claude_code", "antigravity", "codex"] as const;

  async function render(
    name: string,
    input: RuntimePromptParityInput,
  ): Promise<RuntimePromptParityResult> {
    const result = await api.renderRuntimePromptParity(input);
    results.set(name, result);
    return result;
  }

  function paperRef(fixture: WorkflowTestFixture, title: string) {
    return {
      itemId: fixture.parentItemId,
      contextItemId: fixture.pdfAttachmentId,
      title,
      libraryID: Zotero.Libraries.userLibraryID,
    };
  }

  /** Every block a runtime sends is in what its transport sends. */
  function assertDeclaredBlocksSent(result: RuntimePromptParityResult) {
    for (const system of RUNTIMES) {
      const runtime = result.runtimes[system];
      for (const [id, text] of Object.entries(runtime.blocks)) {
        if (!text) continue;
        const delivery = runtime.deliveries[id];
        const target =
          delivery.placement === "standing" ? runtime.standing : runtime.turn;
        assert.include(
          target,
          text,
          `${system} declares ${id} as ${delivery.placement} but does not send it`,
        );
      }
    }
  }

  /** A block shared with the original agent carries the same text. */
  function assertSharedWithNative(
    result: RuntimePromptParityResult,
    ids: readonly string[],
  ) {
    for (const system of RUNTIMES) {
      for (const id of ids) {
        const text = result.runtimes[system].blocks[id];
        if (!text) continue;
        const native =
          id === "customInstructions" || id === "skillInventory"
            ? result.native.system
            : result.native.turn;
        assert.include(
          native,
          text,
          `${system}'s ${id} differs from the original agent's`,
        );
      }
    }
  }

  before(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest as WorkflowTestApi;
    await api.reset();
    paperA = await api.createPaperWithPdfFixture({
      title: "Parity Paper Alpha",
      pages: ["Alpha studies attention in transformers."],
      creators: ["Alpha"],
      date: "2021",
    });
    paperB = await api.createPaperWithPdfFixture({
      title: "Parity Paper Beta",
      pages: ["Beta studies recurrence in language models."],
      creators: ["Beta"],
      date: "2022",
    });
  });

  after(async function () {
    if (paperA) await api.cleanupFixture(paperA);
    if (paperB) await api.cleanupFixture(paperB);
    await api.reset();
  });

  it("every block a runtime sends has a renderer, and every block has a decision", async function () {
    const result = await render("plain", {
      userText: "Hello.",
      conversationKind: "global",
    });
    for (const system of RUNTIMES) {
      const deliveries = result.runtimes[system].deliveries;
      assert.sameMembers(
        Object.keys(deliveries),
        [...result.textBlockIds, ...result.transportBlockIds],
        system,
      );
      for (const id of result.textBlockIds) {
        const delivery = deliveries[id];
        if (delivery.kind === "send") {
          assert.isTrue(
            delivery.rendered,
            `${system} sends ${id}, which has no renderer for external runtimes`,
          );
        }
      }
    }
    assertDeclaredBlocksSent(result);
  });

  it("a quote from a model reply reaches every runtime with its question (#586, #587)", async function () {
    const quote = "Attention lets every token weigh every other token.";
    const question = "Why every other token?";
    const result = await render("modelQuote", {
      userText: question,
      conversationKind: "global",
      selectedTextContexts: [
        { text: quote, source: "model", userQuery: question },
      ],
    });
    for (const system of RUNTIMES) {
      const turn = result.runtimes[system].turn;
      assert.include(turn, quote, system);
      assert.include(turn, `Question about this text:\n${question}`, system);
      assert.include(
        turn,
        "Answer the question attached to each selected text above.",
        system,
      );
    }
    assertDeclaredBlocksSent(result);
    assertSharedWithNative(result, ["visibleTurnContext", "turnMaterial"]);
  });

  it("quotes from two papers keep their paper and source labels in every runtime", async function () {
    const result = await render("twoPapers", {
      userText: "Compare these two claims.",
      conversationKind: "global",
      selectedTextContexts: [
        {
          text: "Alpha studies attention in transformers.",
          source: "pdf",
          paperContext: paperRef(paperA, "Parity Paper Alpha"),
          contextItemId: paperA.pdfAttachmentId,
        },
        {
          text: "Beta studies recurrence in language models.",
          source: "pdf",
          paperContext: paperRef(paperB, "Parity Paper Beta"),
          contextItemId: paperB.pdfAttachmentId,
        },
      ],
    });
    for (const system of RUNTIMES) {
      const turn = result.runtimes[system].turn;
      assert.include(turn, "paper=Parity Paper Alpha", system);
      assert.include(turn, "paper=Parity Paper Beta", system);
      assert.match(turn, /source_label=/, system);
      assert.include(turn, "Compare these two claims.", system);
    }
    assertDeclaredBlocksSent(result);
    assertSharedWithNative(result, ["visibleTurnContext", "turnMaterial"]);
  });

  it("an open note's text and a note-edit quote's identity reach every runtime", async function () {
    const noteText = "Draft: transformers replace recurrence with attention.";
    const result = await render("noteEdit", {
      userText: "Tighten this sentence.",
      conversationKind: "global",
      activeNoteContext: {
        noteId: 424242,
        title: "Parity note",
        noteKind: "standalone",
        noteText,
      },
      selectedTextContexts: [
        {
          text: "transformers replace recurrence with attention",
          source: "note-edit",
          noteContext: {
            libraryID: Zotero.Libraries.userLibraryID,
            noteItemKey: "PARITYNOTE",
            noteItemId: 424242,
            noteKind: "standalone",
            title: "Parity note",
          },
        },
      ],
    });
    for (const system of RUNTIMES) {
      const turn = result.runtimes[system].turn;
      assert.include(turn, `Current note content for this turn:`, system);
      assert.include(turn, noteText, system);
      assert.include(turn, "note_id=424242", system);
      assert.include(turn, "note_kind=standalone", system);
    }
    assertDeclaredBlocksSent(result);
    assertSharedWithNative(result, ["visibleTurnContext", "turnMaterial"]);
  });

  it("custom instructions reach Claude Code and Antigravity, and the skill inventory with them", async function () {
    const custom = "Always answer in exactly three sentences.";
    const result = await render("customInstructions", {
      userText: "Summarize attention.",
      conversationKind: "global",
      systemPrompt: custom,
    });
    assert.include(result.native.system, custom);
    assert.include(result.runtimes.claude_code.standing, custom);
    // agy keeps standing text from session start only: custom instructions
    // can change between turns, so they go with each turn.
    assert.include(result.runtimes.antigravity.turn, custom);
    assert.notInclude(result.runtimes.antigravity.standing, custom);
    for (const system of ["claude_code", "antigravity"] as const) {
      assert.include(
        result.runtimes[system].standing,
        "Installed skill inventory",
        system,
      );
    }
    assertDeclaredBlocksSent(result);
    assertSharedWithNative(result, ["customInstructions", "skillInventory"]);
  });

  it("a selected collection's rules reach every runtime", async function () {
    const result = await render("collection", {
      userText: "Summarize this folder.",
      conversationKind: "global",
      selectedCollectionContexts: [
        {
          collectionId: 987654,
          name: "Parity folder",
          libraryID: Zotero.Libraries.userLibraryID,
        },
      ],
    });
    for (const system of RUNTIMES) {
      const turn = result.runtimes[system].turn;
      assert.include(turn, "this folder", system);
      assert.include(
        turn,
        "Catalog rows and manifest rows are navigation context, not evidence.",
        system,
      );
      // MCP lists no task_update, so no rule declares parts with it.
      assert.notInclude(turn, "task_update", system);
    }
    assert.include(
      result.native.system,
      "Catalog rows and manifest rows are navigation context, not evidence.",
    );
    assertDeclaredBlocksSent(result);
  });

  it("a clarification reaches every runtime", async function () {
    const result = await render("clarification", {
      userText: "Write the note.",
      conversationKind: "global",
      clarificationHistory: [
        { question: "Which paper?", answer: "Parity Paper Alpha" },
      ],
    });
    for (const system of RUNTIMES) {
      assert.include(
        result.runtimes[system].turn,
        "- Which paper?: Parity Paper Alpha",
        system,
      );
    }
    assertDeclaredBlocksSent(result);
    assertSharedWithNative(result, ["clarifications"]);
  });

  it("a configured notes folder and a side chat reach the runtimes that send them", async function () {
    const notes = await render("notesFolder", {
      userText: "Save a note about attention.",
      conversationKind: "global",
      notesDirectoryPath: "/tmp/llm-for-zotero-parity-notes",
    });
    for (const system of ["claude_code", "antigravity"] as const) {
      const runtime = notes.runtimes[system];
      assert.include(
        `${runtime.standing}\n${runtime.turn}`,
        "/tmp/llm-for-zotero-parity-notes",
        system,
      );
    }
    assertDeclaredBlocksSent(notes);
    const side = await render("sideChat", {
      userText: "What does this mean?",
      conversationKind: "paper",
      sideChat: true,
    });
    for (const system of ["claude_code", "antigravity"] as const) {
      assert.isNotEmpty(side.runtimes[system].blocks.sideChatReadOnly, system);
    }
    assertDeclaredBlocksSent(side);
  });

  it("a raw-PDF turn carries the raw-PDF policy and no paper_read hints", async function () {
    const result = await render("rawPdf", {
      userText: "Read this PDF.",
      conversationKind: "global",
      localPdf: {
        itemId: paperA.parentItemId,
        contextItemId: paperA.pdfAttachmentId,
        title: "Parity Paper Alpha",
        path: paperA.tempPdfPath,
      },
    });
    for (const system of ["claude_code", "antigravity"] as const) {
      assert.isNotEmpty(result.runtimes[system].blocks.rawPdfPolicy, system);
      assert.isEmpty(result.runtimes[system].blocks.agentFiles || "", system);
    }
    assertDeclaredBlocksSent(result);
  });

  it("a single-paper chat tells every runtime that paper questions need no skill", async function () {
    const result = await render("singlePaper", {
      userText: "What is the main claim?",
      conversationKind: "paper",
      activeItemId: paperA.parentItemId,
      selectedPaperContexts: [paperRef(paperA, "Parity Paper Alpha")],
    });
    for (const system of RUNTIMES) {
      assert.include(
        result.runtimes[system].turn,
        "do not load evidence-based-qa",
        system,
      );
    }
    assertDeclaredBlocksSent(result);
  });

  it("no block a runtime sends renders empty in every turn above", function () {
    // Blocks whose text depends on the user's own setup or on Zotero's tool
    // registry, which a turn here cannot force.
    const setupDependent = new Set(["agentFiles", "toolGuidance"]);
    assert.isAtLeast(results.size, 10, "the turns above ran");
    for (const system of RUNTIMES) {
      const sent = new Set<string>();
      const declared = new Set<string>();
      for (const result of results.values()) {
        for (const [id, text] of Object.entries(
          result.runtimes[system].blocks,
        )) {
          declared.add(id);
          if (text) sent.add(id);
        }
      }
      for (const id of declared) {
        if (setupDependent.has(id)) continue;
        assert.isTrue(
          sent.has(id),
          `${system} declares ${id} as sent, but it rendered empty in every turn`,
        );
      }
    }
  });
});
