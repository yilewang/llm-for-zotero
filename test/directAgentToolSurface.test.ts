import { assert } from "chai";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import { renderAgentPromptEnvelope } from "../src/agent/model/messageBuilder";

describe("direct Agent model tool surface", function () {
  it("keeps the fixed ordinary tool and prompt payload within the migration targets", async function () {
    const registry = createBuiltInToolRegistry({
      zoteroGateway: {} as never,
      pdfService: {} as never,
      pdfPageService: {} as never,
      retrievalService: {} as never,
    });
    // An ordinary turn runs as the Original Agent, so task_update counts.
    const request = resolveAgentRuntimeRequest({
      conversationKey: 1,
      mode: "agent",
      userText: "Answer a question about my library",
      libraryID: 1,
      executionContext: {
        version: 1,
        executionId: "execution-1",
        conversationKey: 1,
        conversationGeneration: 0,
        chatLibraryID: 1,
        permissionOwner: "original_agent",
        workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
        configuredAccess: { libraryIDs: [1], outputDirectories: [] },
      },
    });

    const tools = registry.listToolsForRequest(request);
    const serializedToolCharacters = tools
      .map((tool) =>
        [tool.name, tool.description, JSON.stringify(tool.inputSchema)].join(
          "\n",
        ),
      )
      .join("\n\n").length;
    const rendered = await renderAgentPromptEnvelope(
      request,
      registry.listToolDefinitionsForRequest(request),
      [],
    );

    // Includes concrete figure selectors, the native image-embedding contract
    // and task_update. Each cap is the next whole thousand above the measured
    // payload: 23,477 tool characters and 32,106 with the fixed prompt
    // (2026-10-03, after task_update named excluded and replaces, the
    // workflow asked for a digest part per per-paper result, submit_document
    // named excluded, and literature_search said it searches outside the
    // library and its metadata mode proposes changes). The tool cap was
    // raised to 24,100 by past_chat_read, the always-listed tool
    // that opens past chats the user attached (24,035 tool characters and
    // 32,854 with the fixed prompt, 2026-10-18), and to 24,200 by its query
    // search (24,171 tool characters, 2026-10-18), and to 25,000 by
    // past_chat_search and past_chat_attach, the always-listed tools that
    // find an earlier chat and add it (24,904 tool characters, 2026-10-19);
    // the same two tools raised the cap with the fixed prompt to 34,000
    // (33,723 characters). The search-routing branch (the search routing
    // contract with its nothing-attached rule, the plugin Agent's search-tool
    // map with the selection-card rule, the reason every outside search
    // states, and literature_search's find and answer workflow wording)
    // raised both caps to the measured payload on 2026-10-20: 25,367 tool
    // characters (405 more than 24,962 at a10986c0) and 35,390 with the
    // fixed prompt (1,609 more than 33,781). literature_read, the always-listed
    // tool that reads an outside paper's abstract and open-access text
    // instead of shell curl calls, raised both caps by its measured size, to
    // 26,127 and 36,219 (+760 tool and +829 total) (2026-10-20).
    // The agent-files section (put a page in the answer, save files only when
    // the user wants the file, into the chat's own folder) raised the cap
    // with the fixed prompt to 36,624 (+405) (2026-10-22).
    // The preview color sentence (SVG and HTML drawn with currentColor and
    // the named theme colors), in the response format and the html page
    // rule, raised it to 37,070 (+446) (2026-10-25).
    // Per-sentence citing in the citation contract raised it to 37,269
    // (+199) (2026-10-26).
    // task_update's rule that a literature review of more than four papers
    // declares a digest part, and one of four or fewer a read part (+450), and
    // submit_document's rule that a literature review is always a document
    // (+130) raised both caps by 580, to 26,707 and 37,849 (2026-10-29).
    // The outside-paper choice (literature_search's forLiteratureReview field
    // and sentence, submit_document's citation-source, web-page and
    // answer-in-chat sentences) raised both caps by 475, to 27,182 and 38,324
    // (2026-10-29).
    // library_import's kind:'document_citations' (its sentence, enum value
    // and documentId field, +210) and the card rule widened to a literature
    // review that needs outside papers, a mixed one included (+60), raised
    // them to 27,392 and 38,594 (2026-10-29).
    // record_paper_decisions, the always-listed tool that records the
    // agent's paper decisions, raised the tool cap by 706 and the cap with
    // the fixed prompt by 706, to 28,098 and 39,300 (2026-10-30).
    // review_coverage reaches Codex and Claude Code over MCP only; the
    // plugin Agent does not list it, so it adds nothing here.
    // library_delete's groups field and its clause, so one approval merges
    // several duplicate groups, raised both caps by 80, to 28,178 and 39,380
    // (2026-10-30).
    // zotero_script's pointer to the zotero-script skill raised both caps by
    // 90, to 28,268 and 39,470 (2026-10-31).
    // run_command's and file_io's one-sentence use and approval rules raised
    // both caps by 352, to 28,620 and 39,822 (2026-10-31).
    // literature_search's source and author rules, moved from never-selected
    // guidance into its description, raised both caps by 188, to 28,808 and
    // 40,010 (2026-10-31).
    // "Zotero asks no approval for ..." in run_command's and file_io's rules
    // raised both caps by 13, to 28,821 and 40,023 (2026-10-31).
    // Merged with W2's read scope: task_update's read and overrides fields
    // (+343) and the named override and page-range properties for Gemini
    // (+482) raise both caps by 825, to 29,646 and 40,848 (2026-10-31).
    // User instructions come first: task_update's sentence that a digest
    // reads the whole text unless its read names the source the user limited
    // it to (+186) and submit_document's "unless the user asks for a chat
    // answer" (+32) raise the tool cap by 218, to 29,864; the fixed prompt's
    // chat-answer and library-only clauses (+99) raise the total by 317, to
    // 41,165 (2026-10-31).
    // Merged with W4's loop gates: the direct workflow's tool-call limit
    // sentence (+96) and its job-page clause (+31) raise the total by 127, to
    // 41,292 (2026-10-31).
    // Changed on 2026-10-31 by +96 characters: review wording fixes (skipped vs blocked, declare after library_retrieve, digest for three or more papers, limitations section).
    // Raised on 2026-10-31 by 423 characters: W5-A reads (reader_open +283; library_search's statistics entity, sections field and year, creator and dateModified sort keys +124; library_read's relatedLinks section +16), to 30,287 and 41,811.
    // Changed on 2026-10-31 by +201 characters: W5-A review fixes (statistics sections enum +153; reader_open's "when the user asks" and "0-based" +62; library_read's description without relatedLinks -14), to 30,488 and 42,012.
    // Raised on 2026-10-31 by 99 characters: W5-B (library_update's itemType,
    // note_write_batch's mode and targetNoteId), merged onto W5-A: 30,587 and 42,111.
    assert.isAtMost(serializedToolCharacters, 30_587);
    assert.isAtMost(
      rendered.inventory.fixedPrompt.length + serializedToolCharacters,
      42_111,
    );
    assert.includeMembers(
      tools.map((tool) => tool.name),
      [
        "task_update",
        "library_search",
        "paper_read",
        "library_update",
        "note_write",
        "submit_document",
        "request_user_input",
        "load_skill",
      ],
    );
  });
});
