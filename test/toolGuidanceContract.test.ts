import { assert } from "chai";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { RETIRED_TOOL_HINTS } from "../src/agent/context/toolNames";
import { computeUserTextSignals } from "../src/agent/runtime";
import { AGENT_PERSONA_INSTRUCTIONS } from "../src/agent/model/agentPersona";
import { DEFAULT_SYSTEM_PROMPT } from "../src/utils/llmDefaults";

const root = process.cwd();

function stubRegistry() {
  return createBuiltInToolRegistry({
    zoteroGateway: {} as never,
    pdfService: {} as never,
    pdfPageService: {} as never,
    retrievalService: {} as never,
  });
}

function collectFiles(
  dir: string,
  predicate: (path: string) => boolean,
): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectFiles(fullPath, predicate));
    } else if (predicate(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}

function readSourceFiles(): Array<{ path: string; content: string }> {
  const files = [
    join(root, "src/agent/model/agentPersona.ts"),
    join(root, "src/agent/model/messageBuilder.ts"),
    join(root, "src/agent/mcp/server.ts"),
    join(root, "src/agent/tools/index.ts"),
    join(root, "src/codexAppServer/nativeClient.ts"),
    join(root, "src/agent/runtime.ts"),
    ...collectFiles(join(root, "src/agent/skills"), (path) =>
      path.endsWith(".md"),
    ),
    ...collectFiles(join(root, "src/agent/tools/read"), (path) =>
      path.endsWith(".ts"),
    ),
    ...collectFiles(join(root, "src/agent/tools/write"), (path) =>
      path.endsWith(".ts"),
    ),
  ];
  return files.map((path) => ({
    path: relative(root, path).split(sep).join("/"),
    content: readFileSync(path, "utf8"),
  }));
}

describe("tool guidance contracts", function () {
  it("resolves collection identities without treating search results as authority", function () {
    const registry = stubRegistry();
    const guidance = registry
      .listToolDefinitions()
      .find((tool) => tool.spec.name === "library_search")!.guidance!
      .instruction;
    assert.include(guidance, "never grant permission");
    assert.include(guidance, "ask the user instead of guessing");
    assert.notInclude(guidance, "When the user asks to MOVE");
    assert.notInclude(guidance, "let the confirmation card collect");
    const update = registry
      .listToolDefinitions()
      .find((tool) => tool.spec.name === "library_update")!;
    const schema = JSON.stringify(update.spec.inputSchema);
    assert.notInclude(schema, "whenever the user says");
    assert.notInclude(schema, "constraints.collectionMode");
    assert.include(schema, '"mode"');
    assert.include(schema, '"from"');
  });

  it("keeps library retrieve reference lists aligned with coverage wording", function () {
    const prompt =
      stubRegistry().getTool("library_retrieve")!.guidance!.instruction;

    assert.include(
      prompt,
      "If a references or bibliography section follows library_retrieve",
    );
    assert.include(
      prompt,
      "either include all planned papers, or label the list as body-evidence references",
    );
    assert.include(prompt, "metadata or abstract-only papers");
  });

  const stalePatterns: Array<{ label: string; pattern: RegExp }> = [
    { label: "query_library(query:...)", pattern: /query_library\(query:/ },
    {
      label: "query_library(mode:'duplicates')",
      pattern: /query_library\(mode:'duplicates'/,
    },
    {
      label: "query_library(entity:'collections', view:'tree')",
      pattern: /query_library\(entity:'collections',\s*view:/,
    },
    { label: "file_io(read,...)", pattern: /file_io\(read,/ },
    { label: "file_io(write,...)", pattern: /file_io\(write,/ },
    {
      label: "zotero_script(mode:'read')",
      pattern: /zotero_script\(mode:'read'/,
    },
    {
      label: "search_literature_online(mode:...)",
      pattern: /search_literature_online\(mode:/,
    },
    {
      label: "import_identifiers(identifiers:...)",
      pattern: /import_identifiers\(identifiers:/,
    },
    {
      label: "edit_current_note(mode:...)",
      pattern: /edit_current_note\(mode:/,
    },
    {
      label: "read_paper(chunkIndexes:...)",
      pattern: /read_paper\(chunkIndexes:/,
    },
    {
      label: "search_paper(question:...)",
      pattern: /search_paper\(question:/,
    },
    {
      label: "read_library(sections:...)",
      pattern: /read_library\(sections:/,
    },
    {
      label: "library_retrieve(intent:'discover')",
      pattern: /library_retrieve\([^)]*intent:'discover'/,
    },
    {
      label: "MinerU source image embeds for notes",
      pattern: /(?:file:\/\/\/\{mineruCacheDir\}|mineruCacheDir\}\/images)/,
    },
    {
      label: "MinerU usable images folder guidance",
      pattern: /cache directory also contains an images\/ folder/,
    },
  ];

  it("shows the model that it declares ordinary parts and the host marks them done", function () {
    const taskUpdate = stubRegistry()
      .listTools()
      .find((tool) => tool.name === "task_update");
    assert.equal(
      taskUpdate?.description,
      "Declare a compound request's parts for the host to track: expectedCapability such as zotero.notes for a write; targetIds, or scope:true for the whole Paper scope; expectedEffect 'digest' asks the host to answer the part's description for each named paper and return the results. The host marks parts done; list one that cannot be done under skipped or blocked, with the reason. List papers a review or answer leaves out under excluded, with the reason. To change a part that has progress, declare a new part with replaces and a reason.",
    );
  });

  it("describes current behavior, not retired contracts, in tool text", function () {
    // Turns carry no action contract, obligations or prepared source
    // boundary; tool text that names them describes a removed mechanism.
    const retired = /\bobligations?\b|\bcontract'?s?\b|frozen workflow/i;
    const failures: string[] = [];
    const visit = (owner: string, value: unknown) => {
      if (typeof value === "string") {
        if (retired.test(value)) failures.push(`${owner}: ${value}`);
      } else if (value && typeof value === "object") {
        for (const entry of Object.values(value)) visit(owner, entry);
      }
    };
    for (const tool of stubRegistry().listToolDefinitions()) {
      visit(tool.spec.name, tool.spec.description);
      visit(tool.spec.name, tool.spec.inputSchema);
      visit(tool.spec.name, tool.guidance?.instruction);
    }
    assert.deepEqual(failures, []);
  });

  it("does not contain stale pseudo-call examples in shipped guidance", function () {
    const failures: string[] = [];
    for (const source of readSourceFiles()) {
      for (const { label, pattern } of stalePatterns) {
        if (pattern.test(source.content)) {
          failures.push(`${source.path}: ${label}`);
        }
      }
    }
    assert.deepEqual(failures, []);
  });

  it("keeps direct chat and agent guidance selective about Mermaid overviews and local SVG", function () {
    for (const prompt of [
      DEFAULT_SYSTEM_PROMPT,
      AGENT_PERSONA_INSTRUCTIONS.join("\n"),
    ]) {
      assert.include(prompt, "Add a diagram only when helpful");
      assert.include(prompt, "fenced Mermaid for a whole-paper overview");
      assert.include(prompt, "focused fenced SVG for one mechanism");
      assert.include(prompt, "never make a poster-style or unsupported map");
      assert.notInclude(prompt, "Use fenced SVG diagrams as the default");
      assert.notInclude(
        prompt,
        "Use fenced Mermaid only when the user explicitly asks for Mermaid",
      );
    }
  });

  it("keeps the Diagram shortcut ID and makes its prompt Mermaid and compact", function () {
    const shortcut = readFileSync(
      join(root, "addon/content/shortcuts/mermaid-diagram.txt"),
      "utf8",
    );

    assert.include(shortcut, "Generate a Mermaid flowchart");
    assert.include(shortcut, "Keep it compact and high-level");
    assert.include(shortcut, "Avoid poster-style detail dumps");
    assert.include(
      shortcut,
      "Do not invent structure unsupported by the paper",
    );
  });

  it("keeps ordinary paper QA guidance on paper_read instead of direct MinerU file_io", function () {
    const staleMineruFirstPatterns: Array<{ label: string; pattern: RegExp }> =
      [
        {
          label: "first use file_io on MinerU",
          pattern: /first use file_io on MinerU/i,
        },
        {
          label: "use file_io on MinerU markdown first",
          pattern: /use file_io on MinerU markdown first/i,
        },
        {
          label: "prefer reading MinerU markdown with file_io first",
          pattern: /prefer reading (?:that )?MinerU markdown with file_io/i,
        },
        {
          label: "prefer file_io manifest/full before paper tools",
          pattern: /prefer file_io on MinerU manifest\.json\/full\.md/i,
        },
        {
          label: "file_io first for MinerU caches",
          pattern: /Use this first for MinerU paper caches/i,
        },
      ];
    const failures: string[] = [];
    const sources = readSourceFiles();
    for (const source of sources) {
      for (const { label, pattern } of staleMineruFirstPatterns) {
        if (pattern.test(source.content)) {
          failures.push(`${source.path}: ${label}`);
        }
      }
    }
    assert.deepEqual(failures, []);

    const agentPersona = sources.find(
      (source) => source.path === "src/agent/model/agentPersona.ts",
    )?.content;
    const fileIoTool = sources.find(
      (source) => source.path === "src/agent/tools/write/fileIO.ts",
    )?.content;

    assert.isString(agentPersona);
    assert.isString(fileIoTool);
    if (typeof agentPersona !== "string" || typeof fileIoTool !== "string") {
      return;
    }
    const paperReadGuidance =
      stubRegistry().getTool("paper_read")!.guidance!.instruction;
    assert.include(
      paperReadGuidance,
      "Use supplied paper text directly when it supports the answer",
    );
    assert.include(
      fileIoTool,
      "For ordinary Zotero paper summaries, methods, key points, and targeted Q&A, use paper_read",
    );
    assert.notInclude(agentPersona, "mineruCacheDir}/manifest.json");
    assert.notInclude(agentPersona, "mineruCacheDir}/full.md");
    assert.include(
      paperReadGuidance,
      "mode:'figures' for extracted figure crops",
    );
  });

  it("requires extracted PDF crop inspection and note embedding", function () {
    const sources = readSourceFiles();
    const byPath = new Map(
      sources.map((source) => [source.path, source.content] as const),
    );

    const analyzeFigures = byPath.get("src/agent/skills/analyze-figures.md");
    const writeNote = byPath.get("src/agent/skills/write-note.md");
    const agentPersona = byPath.get("src/agent/model/agentPersona.ts");
    const messageBuilder = byPath.get("src/agent/model/messageBuilder.ts");
    const paperRead = byPath.get("src/agent/tools/read/paperRead.ts");
    const noteTools = byPath.get("src/agent/tools/index.ts");
    const currentNoteTool = byPath.get("src/agent/tools/write/noteWrite.ts");

    for (const content of [
      analyzeFigures,
      writeNote,
      agentPersona,
      messageBuilder,
      paperRead,
      noteTools,
      currentNoteTool,
    ]) {
      assert.isString(content);
    }

    assert.include(analyzeFigures!, "call `paper_read` in `figures` mode");
    assert.include(analyzeFigures!, "`figure_crops` metadata");
    assert.include(analyzeFigures!, "switch to text-only mode");
    assert.include(
      analyzeFigures!,
      "do not read or embed MinerU source image paths",
    );
    assert.include(paperRead!, "mode:'figures'");
    assert.include(writeNote!, "host-issued figure assets");
    assert.include(
      writeNote!,
      "Follow the analyze-figures skill for obtaining crops",
    );
    assert.notInclude(writeNote!, "figure_crops");
    assert.notInclude(noteTools!, "returns no_figures");
    assert.notInclude(agentPersona!, "figure_crops");
    // The figure turn rule and its text-only branch were removed; the rules
    // live only in the analyze-figures skill.
    assert.notInclude(messageBuilder!, "figure_crops");
    assert.notInclude(messageBuilder!, "Available MinerU cache directories");
    assert.include(analyzeFigures!, "preserve the textual evidence");
    assert.include(
      analyzeFigures!,
      "User-provided images remain separate evidence inputs",
    );
  });

  it("does not expose hidden legacy call targets in model-visible guidance", function () {
    const registry = stubRegistry();
    const hiddenCallTarget = new RegExp(
      `\\b(${Object.keys(RETIRED_TOOL_HINTS).join("|")})\\b`,
    );
    const failures = registry
      .listToolDefinitions()
      .filter((tool) => tool.spec.exposure !== "internal")
      .flatMap((tool) => {
        const instruction = tool.guidance?.instruction || "";
        return hiddenCallTarget.test(instruction)
          ? [`${tool.spec.name}: ${instruction}`]
          : [];
      });
    assert.deepEqual(failures, []);
  });

  it("injects note-write tool guidance only for the matched note skill", function () {
    const registry = stubRegistry();
    const noteWrite = registry
      .listToolDefinitions()
      .find((tool) => tool.spec.name === "note_write");
    assert.isDefined(noteWrite?.guidance);

    const baseRequest = {
      conversationKey: 1,
      mode: "agent" as const,
      userText: "Explain the main result.",
    };
    assert.isFalse(noteWrite!.guidance!.matches(baseRequest));
    assert.isTrue(
      noteWrite!.guidance!.matches(baseRequest, {
        matchedSkillIds: ["write-note"],
      }),
    );
  });

  it("library_search guidance is delivered when the turn has a library or collection scope", function () {
    const registry = stubRegistry();
    const tool = registry.getTool("library_search")!;
    const scope = (overrides: Record<string, unknown>) =>
      ({
        conversationKey: 1,
        mode: "agent",
        turnPaperScope: {
          libraryID: 1,
          conversationKind: "paper",
          papers: [{ itemId: 1 }],
          collections: [],
          tags: [],
          selectedPassagePaperRefs: [],
          ...overrides,
        },
      }) as any;
    assert.isTrue(
      tool.guidance!.matches(
        scope({ collections: [{ collectionId: 7, name: "Memory" }] }),
        { matchedSkillIds: [] },
      ),
    );
    assert.isTrue(
      tool.guidance!.matches(scope({ tags: [{ name: "to-read" }] }), {
        matchedSkillIds: [],
      }),
    );
    assert.isTrue(
      tool.guidance!.matches(scope({ papers: [] }), { matchedSkillIds: [] }),
    );
    assert.isTrue(
      tool.guidance!.matches(scope({ conversationKind: "global" }), {
        matchedSkillIds: [],
      }),
    );
    assert.isFalse(tool.guidance!.matches(scope({}), { matchedSkillIds: [] }));
  });

  it("delivers library write guidance in chat from user-text signals", function () {
    const registry = stubRegistry();
    const guidanceFor = (name: string) => registry.getTool(name)!.guidance!;
    const noSignals = {
      mentionsDuplicates: false,
      mentionsTrash: false,
      mentionsAttachment: false,
      mentionsImport: false,
    };
    const chat = (signals: Partial<typeof noSignals>) =>
      ({
        conversationKey: 1,
        mode: "agent",
        userTextSignals: { ...noSignals, ...signals },
      }) as any;
    const ctx = { matchedSkillIds: [] };

    assert.isTrue(
      guidanceFor("library_delete").matches(
        chat({ mentionsDuplicates: true }),
        ctx,
      ),
    );
    assert.isTrue(
      guidanceFor("library_delete").matches(chat({ mentionsTrash: true }), ctx),
    );
    assert.isFalse(guidanceFor("library_delete").matches(chat({}), ctx));
    assert.isTrue(
      guidanceFor("library_import").matches(
        chat({ mentionsImport: true }),
        ctx,
      ),
    );
    assert.isFalse(guidanceFor("library_import").matches(chat({}), ctx));
    // Discovery-versus-import rules ride the literature_search description;
    // its long-form guidance has no chat signal.
    assert.isFalse(
      guidanceFor("literature_search").matches(
        chat({ mentionsImport: true }),
        ctx,
      ),
    );
    // library_update carries the attachment guidance; the attachment signal
    // is the only chat signal that reaches it.
    assert.isTrue(
      guidanceFor("library_update").matches(
        chat({ mentionsAttachment: true }),
        ctx,
      ),
    );
    assert.isFalse(guidanceFor("library_update").matches(chat({}), ctx));
    assert.isFalse(
      guidanceFor("library_update").matches(
        chat({
          mentionsDuplicates: true,
          mentionsTrash: true,
          mentionsImport: true,
        }),
        ctx,
      ),
    );
  });

  it("computes chat user-text signals for library write guidance", function () {
    assert.deepEqual(
      computeUserTextSignals("Merge the duplicates in this folder"),
      {
        mentionsDuplicates: true,
        mentionsTrash: false,
        mentionsAttachment: false,
        mentionsImport: false,
      },
    );
    assert.isTrue(computeUserTextSignals("把回收站里的论文恢复").mentionsTrash);
    assert.isTrue(
      computeUserTextSignals("Rename the PDF attachment").mentionsAttachment,
    );
    assert.isTrue(
      computeUserTextSignals("add this paper to my library").mentionsImport,
    );
    assert.isTrue(
      computeUserTextSignals("merge these duplicates").mentionsDuplicates,
    );
    assert.isTrue(
      computeUserTextSignals("restore it from the trash").mentionsTrash,
    );
    assert.isTrue(computeUserTextSignals("import ref 5").mentionsImport);
    assert.isTrue(
      computeUserTextSignals("rename the attachment").mentionsAttachment,
    );
    const none = {
      mentionsDuplicates: false,
      mentionsTrash: false,
      mentionsAttachment: false,
      mentionsImport: false,
    };
    for (const prose of [
      "Explain the main result.",
      "What is the importance of this finding?",
      "This is an important paper",
      "Emergent properties of the network",
    ]) {
      assert.deepEqual(computeUserTextSignals(prose), none, prose);
    }
    // 恢复 is kept as a zh-CN restore term, so recovery prose still sets
    // mentionsTrash; every other signal stays off.
    assert.deepEqual(computeUserTextSignals("恢复正常后的神经元活动"), {
      ...none,
      mentionsTrash: true,
    });
  });
  it("keeps library_search examples explicit about entity and mode", function () {
    const failures: string[] = [];
    const callPattern = /library_search\(([^)]*)\)/g;
    for (const source of readSourceFiles()) {
      for (const match of source.content.matchAll(callPattern)) {
        const callBody = match[1] || "";
        if (!/\bentity\s*:/.test(callBody) || !/\bmode\s*:/.test(callBody)) {
          failures.push(`${source.path}: library_search(${callBody})`);
        }
      }
    }
    assert.deepEqual(failures, []);
  });
});

describe("persona reading strategy contract", function () {
  it("keeps the collection-scope evidence floor in library_retrieve guidance and drops the global answer-immediately rule", function () {
    const persona = AGENT_PERSONA_INSTRUCTIONS.join("\n");
    const retrieve =
      stubRegistry().getTool("library_retrieve")!.guidance!.instruction;

    assert.include(retrieve, "For bounded collection or tag synthesis");
    assert.include(retrieve, "papersBodyRead > 0");
    assert.include(retrieve, "naming what is missing");
    assert.notInclude(persona, "papersBodyRead");
    assert.notInclude(persona, "If yes, answer immediately.");
    assert.include(
      persona,
      "Tool descriptions and guidance are the source of truth for how to read papers and search the library.",
    );
  });

  it("delivers paper-reading guidance in library chats and whenever a paper, passage, collection, or tag is in scope", function () {
    const registry = stubRegistry();
    const paperRead = registry.getTool("paper_read")!.guidance!;
    const retrieve = registry.getTool("library_retrieve")!.guidance!;
    const scope = (overrides: Record<string, unknown>) =>
      ({
        conversationKey: 1,
        mode: "agent",
        turnPaperScope: {
          libraryID: 1,
          conversationKind: "global",
          papers: [],
          collections: [],
          tags: [],
          selectedPassagePaperRefs: [],
          ...overrides,
        },
      }) as any;
    const ctx = { matchedSkillIds: [] };
    const paper = { paper: { itemId: 1, contextItemId: 2 } };
    // A library (global) chat can reach paper_read with explicit targets, so
    // the reading rules ride along even when nothing is selected.
    assert.isTrue(paperRead.matches(scope({}), ctx));
    // Without a turn scope, or in a paper conversation with nothing in scope,
    // paper_read has no reachable paper.
    assert.isFalse(paperRead.matches({ conversationKey: 1 } as any, ctx));
    const inPaperChat = (overrides: Record<string, unknown>) =>
      scope({ conversationKind: "paper", ...overrides });
    assert.isFalse(paperRead.matches(inPaperChat({}), ctx));
    assert.isTrue(paperRead.matches(inPaperChat({ papers: [paper] }), ctx));
    assert.isTrue(
      paperRead.matches(
        inPaperChat({ selectedPassagePaperRefs: [paper] }),
        ctx,
      ),
    );
    assert.isTrue(
      paperRead.matches(
        inPaperChat({ collections: [{ collectionId: 3 }] }),
        ctx,
      ),
    );
    assert.isTrue(
      paperRead.matches(inPaperChat({ tags: [{ name: "x" }] }), ctx),
    );
    // Library evidence rules follow library-level turns, including a
    // zero-context library chat, and stay out of a single-paper chat.
    assert.isTrue(retrieve.matches(scope({}), ctx));
    assert.isTrue(
      retrieve.matches(scope({ collections: [{ collectionId: 3 }] }), ctx),
    );
    assert.isFalse(
      retrieve.matches(
        scope({ conversationKind: "paper", papers: [paper] }),
        ctx,
      ),
    );
  });

  it("organizes the persona into titled sections", function () {
    const persona = AGENT_PERSONA_INSTRUCTIONS.join("\n");

    assert.include(persona, "## Research behavior");
    assert.include(persona, "## Zotero evidence routing");
    assert.include(persona, "## Evidence and citations");
  });
});
