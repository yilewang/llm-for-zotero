import { assert } from "chai";
import { WHOLE_LIBRARY_SCOPE_RULE } from "../src/agent/context/turnContextEnvelope";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import {
  buildAgentInitialMessages,
  buildAgentPromptInstructionInventory,
  composeAgentModelInput,
  renderAgentPromptEnvelope,
} from "../src/agent/model/messageBuilder";
import { buildZoteroEnvironmentManifest } from "../src/codexAppServer/nativeClient";
import { AGENT_ACTION_CONTRACT } from "../src/shared/instructionContracts";
import type { AgentModelMessage } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import {
  clearAgentMemory,
  recordAgentTurn,
} from "../src/agent/store/conversationMemory";

function messageText(message: AgentModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

describe("agent prompt envelope", function () {
  describe("conversation continuity", function () {
    const conversationKey = 810001;
    const question = "Summarize this paper";
    const answer = `The main finding is retained. ${"Detailed evidence. ".repeat(30)}Exact final sentence.`;
    const transcript: AgentModelMessage[] = [
      { role: "user", content: `User request:\n${question}` },
      {
        role: "tool",
        tool_call_id: "read-1",
        name: "paper_read",
        content: '{"text":"Source passage","quoteId":"Q1"}',
      },
      { role: "assistant", content: answer },
    ];

    beforeEach(async function () {
      await clearAgentMemory(conversationKey);
      await recordAgentTurn(conversationKey, question, ["paper_read"], answer);
    });

    afterEach(async function () {
      await clearAgentMemory(conversationKey);
    });

    function request(userText = "Explain that finding") {
      return resolvedAgentRequest({
        conversationKey,
        mode: "agent",
        model: "test-model",
        userText,
        history: transcript,
      });
    }

    it("omits duplicated notes on follow-up and preserves exact answers and evidence for saving", async function () {
      const followup = await buildAgentInitialMessages(request(), [], []);
      assert.notInclude(
        messageText(followup.at(-1)!),
        "Conversation continuity notes",
      );
      assert.equal(
        followup.find((message) => message.role === "assistant")?.content,
        answer,
      );

      const savingTranscript: AgentModelMessage[] = [
        ...transcript,
        { role: "user", content: "Explain that finding" },
        { role: "assistant", content: "The effect persists across sessions." },
      ];
      await recordAgentTurn(
        conversationKey,
        "Explain that finding",
        [],
        "The effect persists across sessions.",
      );
      const saving = await buildAgentInitialMessages(
        request("Save that answer as a note"),
        [],
        [],
        undefined,
        {
          transcriptMessages: savingTranscript,
        },
      );
      assert.notInclude(
        messageText(saving.at(-1)!),
        "Conversation continuity notes",
      );
      assert.deepEqual(
        JSON.parse(
          JSON.stringify(saving.slice(-savingTranscript.length - 1, -1)),
        ),
        savingTranscript,
      );
      assert.include(messageText(saving.at(-1)!), "Save that answer as a note");
    });

    it("restores notes when recomposition removes history without changing the rendered snapshot", async function () {
      const rendered = await renderAgentPromptEnvelope(request(), [], []);
      const full = composeAgentModelInput(rendered.envelope, {
        transcriptMessages: transcript,
      });
      assert.notInclude(
        messageText(full.at(-1)!),
        "Conversation continuity notes",
      );
      await clearAgentMemory(conversationKey);
      const compacted = composeAgentModelInput(rendered.envelope, {
        transcriptMessages: [],
        postTurnMessages: [
          {
            role: "user",
            content: "Agent semantic continuation checkpoint: continue safely.",
          },
        ],
      });
      assert.include(
        messageText(compacted.at(-2)!),
        "Conversation continuity notes",
      );
      assert.include(messageText(compacted.at(-2)!), answer.slice(0, 350));
      assert.deepEqual(
        composeAgentModelInput(rendered.envelope, {
          transcriptMessages: transcript,
        }),
        full,
      );
      await recordAgentTurn(conversationKey, question, ["paper_read"], answer);
      const explicitEmpty = await buildAgentInitialMessages(
        request(),
        [],
        [],
        undefined,
        { transcriptMessages: [] },
      );
      assert.include(
        messageText(explicitEmpty.at(-1)!),
        "Conversation continuity notes",
      );
    });

    it("matches clipped long questions and counts only the notes actually sent", async function () {
      await clearAgentMemory(conversationKey);
      const longQuestion = `${"Explain these results. ".repeat(20)}Include limitations.`;
      await recordAgentTurn(conversationKey, longQuestion, [], answer);
      const history: AgentModelMessage[] = [
        { role: "user", content: `User request:\n${longQuestion}` },
        { role: "assistant", content: answer },
      ];
      const rendered = await renderAgentPromptEnvelope(request(), [], []);
      const full = composeAgentModelInput(rendered.envelope, {
        transcriptMessages: history,
      });
      assert.notInclude(
        messageText(full.at(-1)!),
        "Conversation continuity notes",
      );
      const fullInventory = buildAgentPromptInstructionInventory(
        rendered,
        full,
        history,
      );
      const compacted = composeAgentModelInput(rendered.envelope);
      const compactedInventory = buildAgentPromptInstructionInventory(
        rendered,
        compacted,
        [],
      );
      await clearAgentMemory(conversationKey);
      const empty = await renderAgentPromptEnvelope(request(), [], []);
      const emptyInventory = buildAgentPromptInstructionInventory(
        empty,
        composeAgentModelInput(empty.envelope, { transcriptMessages: history }),
        history,
      );
      assert.equal(
        fullInventory.turnResourceTokens,
        emptyInventory.turnResourceTokens,
      );
      assert.isAbove(
        compactedInventory.turnResourceTokens,
        fullInventory.turnResourceTokens,
      );
    });

    it("retains only notes for turns no longer represented in the prompt", async function () {
      await recordAgentTurn(
        conversationKey,
        "An older omitted question",
        [],
        "An older finding",
      );
      const messages = await buildAgentInitialMessages(request(), [], []);
      const turn = messageText(messages.at(-1)!);
      assert.include(turn, 'User asked: "An older omitted question"');
      assert.notInclude(turn, `User asked: "${question}"`);
    });

    it("requires the matching user and answer in the same retained turn", async function () {
      const histories: AgentModelMessage[][] = [
        [transcript[0]],
        [transcript[2]],
        [
          transcript[0],
          { role: "user", content: "Different question" },
          transcript[2],
        ],
        [{ role: "user", content: question, transient: true }, transcript[2]],
        [
          {
            role: "user",
            content: question,
            retainedTool: { name: "paper_read", callId: "read-1" },
          },
          transcript[2],
        ],
        [transcript[0], { ...transcript[1], content: answer }],
        [
          {
            role: "user",
            content: `Agent semantic continuation checkpoint:\n${question}`,
          },
          transcript[2],
        ],
      ];
      for (const history of histories) {
        const messages = await buildAgentInitialMessages(
          request(),
          [],
          [],
          undefined,
          { transcriptMessages: history },
        );
        assert.include(
          messageText(messages.at(-1)!),
          "Conversation continuity notes",
          JSON.stringify(history),
        );
      }
    });

    it("handles multimodal history and keeps current images intact when restoring notes", async function () {
      const multimodal = transcript.map((message) => ({
        ...message,
        content: [{ type: "text" as const, text: messageText(message) }],
      })) as AgentModelMessage[];
      const rendered = await renderAgentPromptEnvelope(
        { ...request(), screenshots: ["data:image/png;base64,AA"] },
        [],
        [],
        undefined,
        {
          contentInputs: {
            images: true,
            pdfDocuments: false,
            nativeFiles: false,
          },
        },
      );
      const full = composeAgentModelInput(rendered.envelope, {
        transcriptMessages: multimodal,
      });
      assert.notInclude(
        messageText(full.at(-1)!),
        "Conversation continuity notes",
      );
      const compacted = composeAgentModelInput(rendered.envelope);
      assert.include(
        messageText(compacted.at(-1)!),
        "Conversation continuity notes",
      );
      assert.deepEqual(
        (compacted.at(-1)!.content as unknown[]).slice(1),
        (full.at(-1)!.content as unknown[]).slice(1),
      );
    });
  });
  it("distinguishes omitted transcript history from an explicit empty override", async function () {
    const request = resolvedAgentRequest({
      conversationKey: 701,
      mode: "agent",
      userText: "Current request",
      model: "test-model",
      history: [
        { role: "user", content: "Prior user message" },
        { role: "assistant", content: "Prior assistant message" },
      ],
    });

    const derivedHistory = await buildAgentInitialMessages(request, [], []);
    const noHistory = await buildAgentInitialMessages(
      request,
      [],
      [],
      undefined,
      { transcriptMessages: [] },
    );

    assert.include(JSON.stringify(derivedHistory), "Prior user message");
    assert.notInclude(JSON.stringify(noHistory), "Prior user message");
    assert.notInclude(JSON.stringify(noHistory), "Prior assistant message");
    assert.include(JSON.stringify(noHistory), "Current request");
  });

  it("freezes the rendered turn and composes fresh ordered message values", async function () {
    const request = resolvedAgentRequest({
      conversationKey: 702,
      mode: "agent",
      userText: "Inspect the supplied image",
      model: "test-model",
      systemPrompt: "SYSTEM_SENTINEL",
      customInstructions: "CUSTOM_SENTINEL",
      screenshots: ["data:image/png;base64,ZmFrZQ=="],
    });
    const rendered = await renderAgentPromptEnvelope(
      request,
      [],
      [],
      undefined,
      {
        contentInputs: {
          images: true,
          pdfDocuments: false,
          nativeFiles: false,
        },
      },
    );
    const transcript: AgentModelMessage[] = [
      { role: "assistant", content: "Prior answer" },
    ];
    const checkpoint: AgentModelMessage = {
      role: "user",
      content: "Agent semantic continuation checkpoint: continue safely.",
    };

    const first = composeAgentModelInput(rendered.envelope, {
      transcriptMessages: transcript,
      postTurnMessages: [checkpoint],
    });
    request.systemPrompt = "CHANGED_SYSTEM";
    request.customInstructions = "CHANGED_CUSTOM";
    request.userText = "Changed request";
    request.screenshots![0] = "data:image/png;base64,Y2hhbmdlZA==";
    const second = composeAgentModelInput(rendered.envelope, {
      transcriptMessages: transcript,
      postTurnMessages: [checkpoint],
    });

    assert.deepEqual(second, first);
    assert.notStrictEqual(second, first);
    for (let index = 0; index < first.length; index += 1) {
      assert.notStrictEqual(second[index], first[index]);
    }
    const turnIndex = first.length - 2;
    assert.equal(first[turnIndex - 1].role, "assistant");
    assert.equal(first[turnIndex].role, "user");
    assert.equal(first.at(-1)?.role, "user");
    assert.include(messageText(first[0]), "SYSTEM_SENTINEL");
    assert.include(messageText(first[0]), "CUSTOM_SENTINEL");
    assert.include(messageText(first[turnIndex]), "Inspect the supplied image");
    assert.equal(
      typeof first[turnIndex].content === "string"
        ? ""
        : first[turnIndex].content.find((part) => part.type === "image_url")
            ?.type,
      "image_url",
    );
    assert.include(
      messageText(first.at(-1)!),
      "Agent semantic continuation checkpoint",
    );

    if (typeof first[turnIndex].content !== "string") {
      const textPart = first[turnIndex].content.find(
        (part) => part.type === "text",
      );
      if (textPart?.type === "text") textPart.text = "Mutated composed copy";
    }
    const third = composeAgentModelInput(rendered.envelope);
    assert.include(messageText(third.at(-1)!), "Inspect the supplied image");
    assert.notInclude(messageText(third.at(-1)!), "Mutated composed copy");
  });

  describe("permission mode guidance", function () {
    const originalZotero = globalThis.Zotero;
    afterEach(function () {
      globalThis.Zotero = originalZotero;
    });

    function contentText(
      content: string | Array<{ type: string; text?: string }>,
    ) {
      return typeof content === "string"
        ? content
        : content
            .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
            .join("\n");
    }

    async function promptText(
      mode: "safe" | "auto" | "yolo",
      assumptions?: string[],
    ) {
      // Only the permission pref is stubbed; every other pref read stays undefined.
      globalThis.Zotero = {
        Prefs: {
          get: (key: string) =>
            key.endsWith("originalAgentPermissionMode") ? mode : undefined,
        },
      } as never;
      const request = resolvedAgentRequest({
        conversationKey: 9,
        mode: "agent",
        userText: "tidy this folder",
      });
      const rendered = await renderAgentPromptEnvelope(request, [], []);
      return [
        ...rendered.envelope.systemMessages.map((message) =>
          contentText(message.content),
        ),
        contentText(rendered.envelope.turnMessage.content),
      ].join("\n");
    }

    it("tells the agent the current mode and how much to ask", async function () {
      const yolo = await promptText("yolo", ["Assumed append."]);
      assert.include(yolo, "Permission mode: yolo");
      assert.include(
        yolo,
        "The host does not run an approval model or ask for permission",
      );
      // The guidance must not read as unlimited authority: the rails that
      // still block in yolo belong in the same sentence, and only those.
      assert.include(
        yolo,
        "Requested review workflows, database integrity and the paper selection card for papers the user asked you to find remain binding",
      );
      for (const unenforced of [
        "Explicit user restrictions",
        "protected targets",
        "Plan integrity",
        "chat-only memory",
      ])
        assert.notInclude(yolo, unenforced);
      assert.notInclude(yolo, "Interpretation assumptions");
      const auto = await promptText("auto");
      assert.include(auto, "Permission mode: auto");
      assert.include(
        auto,
        "The host makes a bounded model review for other actions",
      );
      const safe = await promptText("safe");
      assert.include(safe, "Permission mode: safe");
      assert.include(safe, "Call the concrete tool");
      assert.include(safe, "host owns the review UI");
      assert.notInclude(safe, "Interpretation assumptions");
    });
  });
});

describe("agent prompt envelope evidence sufficiency", function () {
  const paperContext = {
    itemId: 3928,
    contextItemId: 3931,
    title: "Variability and stability in visual processing",
  };
  function request(withAnchor: boolean) {
    return resolvedAgentRequest({
      conversationKey: 4102,
      mode: "agent",
      conversationKind: "paper",
      libraryID: 1,
      activeItemId: paperContext.itemId,
      selectedPaperContexts: [paperContext],
      userText: "can you explain this part of result to me?",
      model: "test-model",
      ...(withAnchor
        ? {
            selectedTextContexts: [
              {
                text: "Consistency in categorization of object category over longer time scales",
                source: "pdf" as const,
                paperContext,
                contextItemId: 3931,
                pageIndex: 5,
                pageLabel: "6",
              },
            ],
            resolvedSelectedTextAnchors: [
              {
                contextIndex: 0,
                contextItemId: 3931,
                pageIndex: 5,
                pageLabel: "6",
                paperContext,
                resolution: "chunks" as const,
                primaryChunkIndex: 41,
                preferredChunkIndexes: [40, 41, 42],
                contextText:
                  "Consistency in categorization of object category over longer time scales. We asked whether...",
                injectedChars: 100,
              },
            ],
          }
        : {}),
    });
  }

  it("renders no per-turn reading rule for a targeted paper turn", async function () {
    for (const withAnchor of [true, false]) {
      const messages = await buildAgentInitialMessages(
        request(withAnchor),
        [],
        [],
      );
      const prompt = messages.map(messageText).join("\n");
      assert.notInclude(prompt, "TURN RULE");
      assert.notInclude(prompt, "The shared reading intent requires");
      assert.notInclude(prompt, "Already held");
    }
  });

  it("delivers paper_read guidance in a library chat with nothing selected", async function () {
    const paperRead = createPaperReadTool(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const messages = await buildAgentInitialMessages(
      resolvedAgentRequest({
        conversationKey: 4103,
        mode: "agent",
        conversationKind: "global",
        libraryID: 1,
        userText: "What does the Smith 2020 paper report?",
        model: "test-model",
      }),
      [paperRead],
      [],
    );
    const prompt = messages.map(messageText).join("\n");
    assert.include(prompt, paperRead.guidance!.instruction);
    assert.include(prompt, "recommendations are advisory");
  });

  it("keeps retrieval recommendations advisory in paper-scoped paper_read guidance", async function () {
    const paperRead = createPaperReadTool(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const withoutTool = await buildAgentInitialMessages(request(false), [], []);
    assert.notInclude(
      withoutTool.map(messageText).join("\n"),
      "recommendations are advisory",
    );
    const messages = await buildAgentInitialMessages(
      request(false),
      [paperRead],
      [],
    );
    const prompt = messages.map(messageText).join("\n");
    assert.include(prompt, "recommendations are advisory");
    assert.include(prompt, "freely retrieve missing methods, results");
    assert.notInclude(
      prompt,
      "when unchanged, do not repeat the read and retrieve again only for a specifically named missing dimension",
    );
  });
});

describe("agent prompt envelope direct workflow", function () {
  const RECEIPT_CONFIRMS =
    "A write result with a verified receipt already confirms the change; do not re-read the target to confirm it.";

  /** The Original Agent's "## Direct agent workflow" system block. */
  async function directWorkflowBlock(
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    const rendered = await renderAgentPromptEnvelope(
      resolvedAgentRequest({
        conversationKey: 912_101,
        mode: "agent",
        model: "test-model",
        userText: "Summarize this paper and save it as a note",
        ...(metadata ? { metadata } : {}),
      }),
      [],
      [],
    );
    const block = rendered.inventory.fixedPrompt
      .split("\n\n")
      .find((section) => section.startsWith("## Direct agent workflow"));
    assert.exists(block, "the Original Agent prompt has a direct workflow");
    return block!;
  }

  it("tells the model a verified write receipt already confirms the change", async function () {
    assert.include(await directWorkflowBlock(), RECEIPT_CONFIRMS);
  });

  it("asks a turn to declare the parts of a compound request", async function () {
    const DECLARE_PARTS =
      "When a request asks for more than one outcome, such as summarizing a paper and saving it as a note, declare each part with task_update before reading, together with that step's first tool calls; with nothing attached, declare them after library_retrieve has chosen the papers. The host marks each part done from the tools' results; never mark one done yourself.";
    assert.include(await directWorkflowBlock(), DECLARE_PARTS);
  });

  it("asks for a digest part whose description states the per-paper result", async function () {
    const DIGEST_PART =
      "When the work needs one result for each of several papers (a summary, extracted fields, relevance to a question, support or challenge for an idea), declare a digest part whose description states that per-paper result; the host runs it on each paper and returns the results.";
    const block = await directWorkflowBlock();
    assert.include(block, DIGEST_PART);
    // It follows the sentence that introduces task_update.
    assert.isAbove(
      block.indexOf(DIGEST_PART),
      block.indexOf("declare each part with task_update"),
    );
  });

  it("states the step's tool-call limit: 8, or 10 in a batch job", async function () {
    const limit = (n: number) =>
      `One step runs at most ${n} tool calls, unless a job page states more; calls past that are not run, so make them in the next step.`;
    assert.include(await directWorkflowBlock(), limit(8));
    assert.include(
      await directWorkflowBlock({ hostRecordedBatchJob: true }),
      limit(10),
    );
  });

  it("keeps the receipt sentence out of the Codex client's instructions", function () {
    const codexManifest = buildZoteroEnvironmentManifest({
      scope: { kind: "global", libraryID: 1, conversationKey: 1 } as never,
      mcpEnabled: true,
      mcpReady: true,
    });
    assert.include(codexManifest, AGENT_ACTION_CONTRACT);
    assert.notInclude(codexManifest, RECEIPT_CONFIRMS);
  });
});

describe("agent prompt envelope paper scope", function () {
  const papers = (count: number) =>
    Array.from({ length: count }, (_, index) => index + 1);

  async function rendered(
    input: Record<string, unknown>,
    turnScopePapers?: {
      wholeLibrary: boolean;
      itemIds: number[];
      withText: number;
    },
  ) {
    const request = resolvedAgentRequest({
      conversationKey: 913_101,
      mode: "agent",
      model: "test-model",
      userText: "Read every paper in the folder",
      libraryID: 1,
      ...input,
    });
    if (turnScopePapers) request.turnScopePapers = turnScopePapers;
    const envelope = (await renderAgentPromptEnvelope(request, [], []))
      .envelope;
    return {
      turn: messageText(envelope.turnMessage as AgentModelMessage),
      system: envelope.systemMessages
        .map((message) => messageText(message as AgentModelMessage))
        .join("\n"),
    };
  }

  function scopeLines(text: string): string[] {
    return text.split("\n").filter((line) => line.startsWith("Paper scope:"));
  }

  it("states a folder's papers and how many have full text, in one line of the turn context", async function () {
    const { turn, system } = await rendered(
      {
        selectedCollectionContexts: [
          { collectionId: 5, name: "Drift", libraryID: 1 },
        ],
      },
      { wholeLibrary: false, itemIds: papers(212), withText: 180 },
    );
    assert.deepEqual(scopeLines(turn), [
      "Paper scope: Drift — 212 papers, 180 with full text",
    ]);
    const context = turn.slice(turn.indexOf("Zotero context for this turn:"));
    assert.include(
      context,
      "\nCollection 1: ",
      "the line sits in the turn's resource context",
    );
    assert.isEmpty(
      scopeLines(system),
      "counts change as the library does, so they stay out of the cached prefix",
    );
  });

  it("says the whole library, with its count, when nothing is attached", async function () {
    const { turn } = await rendered(
      {},
      { wholeLibrary: true, itemIds: papers(2431), withText: 1900 },
    );
    assert.deepEqual(scopeLines(turn), [
      "Paper scope: whole library — 2431 papers, 1900 with full text",
    ]);
    // The agent sets the scope itself: shortlist, then declare the papers
    // it reads in depth, which is what shows the user its choice.
    assert.include(turn, WHOLE_LIBRARY_SCOPE_RULE);
    // It searches before it declares the per-paper part, and only a write
    // part covers the library with scope:true (task_update refuses others).
    assert.include(WHOLE_LIBRARY_SCOPE_RULE, "library_retrieve first");
    assert.include(WHOLE_LIBRARY_SCOPE_RULE, "targetIds");
    assert.include(WHOLE_LIBRARY_SCOPE_RULE, "not in your first step");
    assert.include(
      WHOLE_LIBRARY_SCOPE_RULE,
      "Only a write part may use scope:true",
    );
    assert.include(WHOLE_LIBRARY_SCOPE_RULE, "library_search");
    // It chooses from the search results; the host reads the chosen papers.
    assert.include(
      WHOLE_LIBRARY_SCOPE_RULE,
      "without opening candidates with paper_read",
    );
    assert.include(
      WHOLE_LIBRARY_SCOPE_RULE,
      "only when the user explicitly asks for every paper in the library",
    );
    // The line says what the scope is; a digest part is how chosen papers
    // are read in depth, not a step every turn takes.
    assert.include(
      WHOLE_LIBRARY_SCOPE_RULE,
      "Nothing is attached, so the turn's scope is the whole library and you choose its papers",
    );
    assert.include(
      WHOLE_LIBRARY_SCOPE_RULE,
      "to read the chosen papers in depth, declare a digest part",
    );
    // Routing (library first, then outside) has one owner, the search
    // routing contract in the fixed prompt; the turn line does not repeat it.
    for (const routing of [
      "outside",
      "literature_search",
      "scholarly",
      "offer",
      "web",
    ])
      assert.notInclude(WHOLE_LIBRARY_SCOPE_RULE, routing, routing);
  });

  it("gives the whole-library rule only when nothing is attached", async function () {
    const { turn } = await rendered(
      {},
      { wholeLibrary: false, itemIds: papers(12), withText: 12 },
    );
    assert.notInclude(turn, WHOLE_LIBRARY_SCOPE_RULE);
  });

  it("names folders, tags and listed papers, and stays one line whatever a name holds", async function () {
    const { turn } = await rendered(
      {
        selectedPaperContexts: [
          {
            itemId: 7,
            contextItemId: 70,
            title: "Paper seven",
            libraryID: 1,
          },
        ],
        selectedCollectionContexts: [
          { collectionId: 5, name: "Drift\n  Rodents", libraryID: 1 },
        ],
        selectedTagContexts: [
          { name: "place cells", libraryID: 1 },
          { name: "Untagged", libraryID: 1, scope: "untagged" },
        ],
      },
      { wholeLibrary: false, itemIds: [7], withText: 0 },
    );
    assert.deepEqual(scopeLines(turn), [
      "Paper scope: Drift Rodents + #place cells + Untagged + listed papers — 1 paper, 0 with full text",
    ]);
  });

  it("states no scope the host could not resolve", async function () {
    const { turn } = await rendered({
      selectedCollectionContexts: [
        { collectionId: 5, name: "Drift", libraryID: 1 },
      ],
    });
    assert.isEmpty(scopeLines(turn));
  });
});
