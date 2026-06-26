import { assert } from "chai";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { AGENT_PERSONA_INSTRUCTIONS } from "../src/agent/model/agentPersona";
import { DEFAULT_SYSTEM_PROMPT } from "../src/utils/llmDefaults";

const root = process.cwd();

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
    path: relative(root, path),
    content: readFileSync(path, "utf8"),
  }));
}

describe("tool guidance contracts", function () {
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
    { label: "web_search", pattern: /\bweb_search\b/ },
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
      assert.include(prompt, "Use diagrams selectively");
      assert.include(prompt, "when visual structure materially improves");
      assert.include(
        prompt,
        "For whole-paper overview diagrams, use fenced Mermaid flowcharts by default",
      );
      assert.include(prompt, "Use fenced SVG for local mechanism");
      assert.include(
        prompt,
        "keep SVG focused on one mechanism, step, or module",
      );
      assert.include(prompt, "not a poster-style whole-paper map");
      assert.include(prompt, "Do not add diagrams to every answer");
      assert.include(prompt, "Do not invent visual structure unsupported");
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
    assert.notInclude(shortcut, "Generate a fenced SVG diagram");
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
    assert.include(
      agentPersona,
      "prefer paper_read for ordinary summaries, methods, key points, and targeted paper Q&A",
    );
    assert.include(
      fileIoTool,
      "For ordinary Zotero paper summaries, methods, key points, and targeted Q&A, use paper_read",
    );
    assert.include(
      agentPersona,
      "When direct MinerU cache inspection is explicitly needed",
    );
    assert.include(
      agentPersona,
      "file_io({ action:'read', filePath:'{mineruCacheDir}/manifest.json' })",
    );
    assert.include(
      agentPersona,
      "file_io({ action:'read', filePath:'{mineruCacheDir}/full.md'",
    );
    assert.include(agentPersona, "use paper_read mode:'figures'");
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
    const currentNoteTool = byPath.get(
      "src/agent/tools/write/editCurrentNote.ts",
    );

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

    assert.include(analyzeFigures!, "paper_read({ mode:'figures'");
    assert.include(messageBuilder!, "precise PDF crops");
    assert.include(paperRead!, "mode:'figures'");
    assert.include(agentPersona!, "embed extracted PDF crop paths");
    assert.include(writeNote!, "Embed extracted PDF crop paths");
    assert.include(noteTools!, "embed the extracted PDF crop path");
    assert.include(noteTools!, "returns no_figures");
    assert.include(noteTools!, "do not call note_write for that figure note");
    assert.include(writeNote!, "do not call `note_write` or `file_io`");
    assert.include(analyzeFigures!, "do not call `note_write`");
    assert.include(currentNoteTool!, "Do not embed MinerU source image paths");
  });

  it("does not expose hidden legacy call targets in model-visible guidance", function () {
    const registry = createBuiltInToolRegistry({
      zoteroGateway: {} as never,
      pdfService: {} as never,
      pdfPageService: {} as never,
      retrievalService: {} as never,
    });
    const hiddenCallTarget =
      /\b(edit_current_note|search_literature_online|manage_attachments|import_local_files|update_metadata)\b/;
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
