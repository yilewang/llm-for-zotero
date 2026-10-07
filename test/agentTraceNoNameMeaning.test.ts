import { assert } from "chai";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createBuiltInToolRegistry } from "../src/agent/tools";

/**
 * The trace must not decide what a row means by what a tool is called.
 *
 * A tool name is identity: it keys deduplication and it finds a spec in the
 * registry. The moment a name decides a row's words, its visibility or its
 * verdict, the reader's view of a run depends on a list of names written at
 * some other time than the run -- a renamed tool loses its row, and a trace
 * from last year is read against today's list. Every fact a row shows is
 * therefore supposed to come from the event that produced it or from the hook
 * the tool itself declared.
 *
 * This scan is the standing check on that. It reads the four files that used
 * to hold the name-derived shadow taxonomy and fails on any comparison of a
 * name against a string literal, unless the site is listed below with the
 * reason it is allowed to stay.
 */
const SCANNED_FILES = [
  "src/modules/contextPanel/agentTrace/render.ts",
  "src/modules/contextPanel/agentTrace/toolResultTraceInfo.ts",
  "src/modules/contextPanel/agentTrace/toolActivityDedupe.ts",
  "src/modules/contextPanel/chat.ts",
  // The panel's reading of a connected runtime's items moved here; the same
  // rule follows it.
  "src/codexAppServer/nativeActivityStages.ts",
  "src/modules/contextPanel/codexNative/turnCallbacks.ts",
] as const;

type NameMeaningPattern = { id: string; regex: RegExp };

/** A name-ish identifier, with or without the object it hangs off. */
const NAME_REFERENCE = String.raw`(?:[\w$]+\??\.)*(?:name|toolName)`;

const NAME_MEANING_PATTERNS: NameMeaningPattern[] = [
  {
    id: 'name === "…"',
    regex: new RegExp(String.raw`\bname\s*[=!]==\s*"`, "g"),
  },
  {
    id: 'toolName === "…"',
    regex: new RegExp(String.raw`\btoolName\s*[=!]==\s*"`, "g"),
  },
  {
    id: 'switch (name) { case "…"',
    regex: new RegExp(
      String.raw`\bswitch\s*\(\s*${NAME_REFERENCE}\s*\)\s*\{\s*case\s*"`,
      "g",
    ),
  },
  {
    id: ".has(name)",
    regex: new RegExp(String.raw`\.has\(\s*${NAME_REFERENCE}\s*[,)]`, "g"),
  },
  {
    id: '["…"].includes(name)',
    regex: new RegExp(String.raw`\.includes\(\s*${NAME_REFERENCE}\s*[,)]`, "g"),
  },
  {
    id: "normalizeMcpToolName(…) === …",
    regex: new RegExp(
      String.raw`normalizeMcpToolName\([^)]*\)[^;{}]*[=!]==`,
      "g",
    ),
  },
];

/**
 * The file as one line, with a record of where each character came from.
 *
 * A comparison split over several lines by the formatter is the same
 * comparison, so the scan reads the file with its line breaks collapsed and
 * maps each match back to the line it started on.
 */
function flattenSource(source: string): { text: string; lineOf: number[] } {
  const lineOf: number[] = [];
  let text = "";
  let line = 1;
  let gap = false;
  for (const character of source) {
    if (character === "\n") {
      line += 1;
      gap = true;
      continue;
    }
    if (/\s/.test(character)) {
      gap = true;
      continue;
    }
    if (gap && text) {
      text += " ";
      lineOf.push(line);
    }
    gap = false;
    text += character;
    lineOf.push(line);
  }
  return { text, lineOf };
}

/**
 * A `typeof x === "string"` guard reads a value's type, never its identity,
 * so it is blanked before the scan rather than allowlisted once per
 * occurrence. The replacement keeps the text's length so positions still map
 * back to their lines.
 */
function blankTypeGuards(text: string): string {
  return text.replace(/typeof\s+[^=!;]+[=!]==\s*"[^"]*"/g, (match) =>
    " ".repeat(match.length),
  );
}

type AllowedSite = {
  file: (typeof SCANNED_FILES)[number];
  /** Text the offending line must contain, so the entry cannot drift. */
  snippet: string;
  reason: string;
};

/**
 * Sites allowed to compare a name against a literal, and why.
 *
 * The first group is identity: the value compared is not a tool name at all.
 * The second is meaning that still reads a name and has a named owner; each
 * entry says which change removes it. An entry that stops matching fails this
 * test, so the list cannot outlive the code it excuses.
 */
const ALLOWED_SITES: AllowedSite[] = [
  {
    file: "src/modules/contextPanel/chat.ts",
    snippet: '.name === "AbortError"',
    reason:
      "A DOM exception's own name, not a tool's: the platform reports a " +
      "cancelled request this way and there is no other field to read.",
  },
];

type Offence = { file: string; line: number; text: string; pattern: string };

function scanText(
  file: string,
  source: string,
): { offences: Offence[]; lineCount: number } {
  const { text, lineOf } = flattenSource(source);
  const scannable = blankTypeGuards(text);
  const offences: Offence[] = [];
  for (const pattern of NAME_MEANING_PATTERNS) {
    const regex = new RegExp(pattern.regex.source, "g");
    let match = regex.exec(scannable);
    while (match) {
      offences.push({
        file,
        line: lineOf[match.index] || 0,
        // Enough of what precedes the match for an allowlist entry to name
        // the object whose `name` is being read.
        text: text.slice(Math.max(0, match.index - 40), match.index + 90),
        pattern: pattern.id,
      });
      match = regex.exec(scannable);
    }
  }
  return { offences, lineCount: source.split("\n").length };
}

function scanFile(file: string): { offences: Offence[]; lineCount: number } {
  return scanText(file, readFileSync(resolve(process.cwd(), file), "utf8"));
}

describe("agent trace derives no meaning from tool names", function () {
  const scans = SCANNED_FILES.map((file) => ({ file, ...scanFile(file) }));

  it("inspects every file that held the name-derived taxonomy", function () {
    assert.deepEqual(
      scans.map((scan) => scan.file),
      [...SCANNED_FILES],
    );
    for (const scan of scans) {
      assert.isAbove(
        scan.lineCount,
        100,
        `${scan.file} was read but looks empty; the scan would pass vacuously`,
      );
    }
  });

  it("finds no unexplained comparison of a tool name to a literal", function () {
    const unexplained = scans
      .flatMap((scan) => scan.offences)
      .filter(
        (offence) =>
          !ALLOWED_SITES.some(
            (allowed) =>
              allowed.file === offence.file &&
              offence.text.includes(allowed.snippet),
          ),
      );

    assert.deepEqual(
      unexplained.map(
        (offence) =>
          `${offence.file}:${offence.line} (${offence.pattern}) ${offence.text}`,
      ),
      [],
    );
  });

  it("keeps every allowlisted site real and reasoned", function () {
    for (const allowed of ALLOWED_SITES) {
      const matched = scans
        .filter((scan) => scan.file === allowed.file)
        .flatMap((scan) => scan.offences)
        .filter((offence) => offence.text.includes(allowed.snippet));
      assert.isAtLeast(
        matched.length,
        1,
        `${allowed.file} no longer contains ${allowed.snippet}; drop the allowlist entry`,
      );
      assert.isAtLeast(
        allowed.reason.length,
        40,
        `${allowed.snippet} needs a reason that says why it may stay`,
      );
    }
  });

  it("would catch a name-derived branch if one came back", function () {
    const samples = [
      'if (name === "file_io") return null;',
      'if (toolName === "Read") rowSuffix = range;',
      "if (INTERNAL_PLAN_TOOL_NAMES.has(entry.payload.name)) return true;",
      "if (HIDDEN.has(toolName)) return true;",
      'normalizeMcpToolName(toolName) === "paper_read"',
      '["research_update", "update_plan"].includes(event.name)',
      "if (HIDDEN_NAMES.includes(entry.payload.toolName)) return true;",
      'codeBlock && name !== "file_io" ? label : displayText',
      'switch (entry.payload.name) {\n  case "file_io":\n    return null;\n}',
      // The formatter splits long comparisons; the scan reads past the break.
      'if (\n  entry.payload.name ===\n  "submit_document"\n) return true;',
    ];
    for (const sample of samples) {
      assert.isNotEmpty(
        scanText("sample.ts", sample).offences,
        `the scan would miss: ${sample}`,
      );
    }
    assert.isEmpty(
      scanText(
        "sample.ts",
        'typeof entry.name === "string" && entry.name.trim()',
      ).offences,
      "a type guard is not a name comparison",
    );
  });
});

/**
 * The nine names the renderer used to hold as `INTERNAL_PLAN_TOOL_NAMES`.
 *
 * The list is gone from production; this is the record of what it covered, so
 * the registry can be asked whether every one of them still declares the fact
 * that replaced it.
 */
const PREVIOUSLY_HIDDEN_PLAN_TOOL_NAMES = [
  "amend_plan",
  "approve_research_expansion",
  "approve_research_mutation",
  "request_user_input",
  "research_update",
  "submit_document",
  "submit_plan_document",
  "task_update",
  "update_plan",
] as const;

/**
 * The plan and research tools retired with plan mode: no longer registered
 * at all.
 */
const RETIRED_PLAN_TOOL_NAMES: readonly string[] = [
  "amend_plan",
  "approve_research_expansion",
  "approve_research_mutation",
  "research_update",
  "submit_plan_document",
  "update_plan",
];

/** Every tool the built registry keeps out of the trace. */
const EXPECTED_HIDDEN_TOOL_NAMES = PREVIOUSLY_HIDDEN_PLAN_TOOL_NAMES.filter(
  (name) => !RETIRED_PLAN_TOOL_NAMES.includes(name),
).sort();

describe("the trace's hidden tools are declared by the registry", function () {
  const registry = createBuiltInToolRegistry({
    zoteroGateway: {} as never,
    pdfService: {} as never,
    pdfPageService: {} as never,
    retrievalService: {} as never,
  });
  const definitions = registry.listToolDefinitions();
  const hidden = definitions
    .filter((tool) => tool.presentation?.hiddenInTrace === true)
    .map((tool) => tool.spec.name)
    .sort();

  it("builds the registry the running plugin builds", function () {
    // 27 once plan mode's own tools and its research tools were retired.
    assert.isAbove(
      definitions.length,
      25,
      "the production factory registered almost nothing; the assertions below would pass vacuously",
    );
  });

  it("hides every tool the deleted name list hid", function () {
    for (const name of PREVIOUSLY_HIDDEN_PLAN_TOOL_NAMES) {
      const tool = definitions.find((entry) => entry.spec.name === name);
      if (RETIRED_PLAN_TOOL_NAMES.includes(name)) {
        assert.isUndefined(tool, `${name} was retired with plan mode`);
        continue;
      }
      assert.isDefined(tool, `${name} is not registered any more`);
      assert.isTrue(
        tool?.presentation?.hiddenInTrace,
        `${name} would now show rows the trace used to suppress`,
      );
    }
    assert.lengthOf(
      PREVIOUSLY_HIDDEN_PLAN_TOOL_NAMES,
      9,
      "the recorded list is the whole of what INTERNAL_PLAN_TOOL_NAMES covered",
    );
  });

  it("hides nothing else", function () {
    assert.deepEqual(hidden, EXPECTED_HIDDEN_TOOL_NAMES);
  });
});
