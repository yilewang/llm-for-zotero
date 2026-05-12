import { assert } from "chai";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

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
