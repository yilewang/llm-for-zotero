import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import {
  SECTIONS_NOT_FOUND_RULE,
  digestReadCapabilities,
  parseReadScope,
  type ReadScope,
} from "../src/agent/digests/readScope";
import {
  ABSTRACT_DIGEST_MAX_CHARS,
  DIGEST_FAILURE_REASONS,
  digestCacheKey,
  digestReadWholeText,
  renderHostPaperDigests,
  runPaperDigestJob,
  type HostPaperDigest,
  type PaperDigestCache,
  type PaperDigestFailure,
  type PaperDigestSource,
} from "../src/agent/digests/paperDigestWorker";
import {
  DIGEST_BODY_DEPTH_CHARS,
  PAPER_DIGEST_HANDLE_TOOL,
  createHandleStorePaperDigestCache,
} from "../src/agent/digests/digestJobHost";
import {
  applyTaskPaperLedgerDelta,
  buildDigestLedgerDelta,
  createTaskPaperLedger,
  taskPaperReadDepths,
} from "../src/agent/context/taskPaperLedger";
import { buildTaskPaperCoverage } from "../src/agent/context/taskPaperCoverage";
import { clearAgentToolResultHandleStore } from "../src/agent/store/toolResultHandles";

/**
 * The digest worker reads each paper for its read scope (`readScope.ts`):
 * the scope is on the record, a scoped request never shares a cache entry
 * with a full one, an abstract comes back as written, and the ledger
 * records what a digest covered.
 */

const MD = [
  "# Drift in place cells",
  "",
  "## Abstract",
  "",
  "We ask whether representational drift impairs decoding of position.",
  "",
  "## 1 Introduction",
  "",
  "Place cells drift slowly across days.",
  "",
  "## 2 Results",
  "",
  "Decoding stayed above chance on every day we recorded.",
  "",
  "### 2.1 Model fit",
  "",
  "The drift model fit the population vectors well.",
  "",
  "## 3 Discussion",
  "",
  "Drift and stable decoding can coexist.",
].join("\n");

/** A paper long enough for a full-text digest (the thin gate is 1,500). */
const PAPER = `${MD}\n\n## Appendix\n\n${"The appendix restates the recording protocol in detail. ".repeat(30)}`;

const scope = (value: unknown): ReadScope => {
  const parsed = parseReadScope(value, "read");
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.scope;
};

const LONG_ABSTRACT = Array.from(
  { length: 13 },
  (_, index) =>
    `Sentence ${index + 1} of the abstract reports that representational drift in hippocampal place cells leaves decoding intact.`,
).join(" ");

function memoryCache(): PaperDigestCache & {
  entries: Map<string, HostPaperDigest>;
  sets: number;
  gets: string[];
} {
  const entries = new Map<string, HostPaperDigest>();
  const cache = {
    entries,
    sets: 0,
    gets: [] as string[],
    get: async (key: string) => {
      cache.gets.push(key);
      return entries.get(key) || null;
    },
    set: async (digest: HostPaperDigest) => {
      cache.sets += 1;
      entries.set(digest.cacheKey, digest);
    },
  };
  return cache;
}

const GOOD = JSON.stringify({
  answer: "Decoding survives drift.",
  evidence: [
    {
      section: "Results",
      quote: "Decoding stayed above chance on every day we recorded.",
    },
  ],
});

function job(
  overrides: Partial<Parameters<typeof runPaperDigestJob>[0]> & {
    text?: string;
  },
) {
  const calls: string[] = [];
  const digests: HostPaperDigest[] = [];
  const failures: PaperDigestFailure[] = [];
  const text = overrides.text ?? PAPER;
  const params: Parameters<typeof runPaperDigestJob>[0] = {
    targets: ["item:1"],
    instruction: "Summarize each paper",
    readText: async (itemId, _max, readScope): Promise<PaperDigestSource> => ({
      itemId,
      contextItemId: 101,
      title: "Drift in place cells",
      sourceLabel: "(Ziv, 2021)",
      backend: "mineru",
      text,
      totalCharacters: text.length,
      ...(readScope
        ? {
            covered: ["Results"],
            bounds: "exact" as const,
            textSource: "MinerU sections",
          }
        : {}),
    }),
    reader: {
      model: "reader-model",
      complete: async (prompt) => {
        calls.push(prompt);
        return { text: GOOD };
      },
    },
    inputCapTokens: 128_000,
    cache: memoryCache(),
    now: () => 1_700_000_000_000,
    wait: async () => undefined,
    onDigest: async (digest) => void digests.push(digest),
    onFailure: async (failure) => void failures.push(failure),
    ...overrides,
  };
  return { params, calls, digests, failures };
}

describe("digest worker read scope", function () {
  it("records the scope on the digest, and a scoped digest is complete but never whole", async function () {
    const run = job({
      scope: scope({ source: "sections", sections: ["results"] }),
    });
    const result = await runPaperDigestJob(run.params);
    assert.lengthOf(result.digests, 1);
    const digest = result.digests[0];
    assert.deepEqual(digest.source.scope, {
      source: "sections",
      sections: ["results"],
    });
    assert.deepEqual(digest.source.covered, ["Results"]);
    assert.isTrue(digest.source.complete);
    assert.isFalse(digestReadWholeText(digest));
    assert.include(
      renderHostPaperDigests([digest], []),
      "text: sections results only; read Results (MinerU sections)",
    );
    // Every named section was found: no not-found sentence.
    assert.notInclude(
      renderHostPaperDigests([digest], []),
      SECTIONS_NOT_FOUND_RULE,
    );
  });

  it("names the sections found by position, and the other approximate bounds beside them", async function () {
    const coverage = async (
      covered: string[],
      approximateByPosition: boolean,
    ) => {
      const run = job({
        scope: scope({ source: "sections", sections: ["abstract", "results"] }),
        readText: async (itemId) => ({
          itemId,
          contextItemId: 101,
          title: "Drift in place cells",
          backend: "mineru",
          text: PAPER,
          totalCharacters: PAPER.length,
          covered,
          bounds: "approximate",
          ...(approximateByPosition ? { approximateByPosition } : {}),
          textSource: "PDF abstract; MinerU sections by position",
        }),
      });
      const result = await runPaperDigestJob(run.params);
      return renderHostPaperDigests(result.digests, []);
    };
    // Only the lead and the span are approximate: one note.
    const byPosition = await coverage(
      ["Abstract (unlabelled lead)", "Results (unlabelled sections)"],
      true,
    );
    assert.include(
      byPosition,
      "Abstract (unlabelled lead) and Results (unlabelled sections) were found by position",
    );
    assert.notInclude(byPosition, "section bounds approximate");
    // The abstract came from PDF chunks (approximate) and the results by
    // position: both notes.
    const both = await coverage(
      ["Abstract", "Results (unlabelled sections)"],
      false,
    );
    assert.include(both, "Results (unlabelled sections) was found by position");
    assert.include(both, "section bounds approximate");
  });

  it("names a section a partial match did not find, in a short line without the rule", async function () {
    const run = job({
      scope: scope({ source: "sections", sections: ["abstract", "results"] }),
      readText: async (itemId) => ({
        itemId,
        contextItemId: 101,
        title: "Drift in place cells",
        backend: "mineru",
        text: PAPER,
        totalCharacters: PAPER.length,
        covered: ["Abstract"],
        unmatched: ["results"],
        bounds: "exact",
        textSource: "MinerU sections",
      }),
    });
    const result = await runPaperDigestJob(run.params);
    const digest = result.digests[0];
    assert.deepEqual(digest.source.unmatched, ["results"]);
    const rendered = renderHostPaperDigests([digest], []);
    // The paper keeps its short line; the rule is the result note's, once.
    assert.include(rendered, "not in this paper: results");
    assert.notInclude(rendered, SECTIONS_NOT_FOUND_RULE);
    assert.notInclude(rendered, "abstract, results.");
  });

  it("never answers a scoped request from a full-text cache entry over the same text", async function () {
    const full = job({});
    const fullResult = await runPaperDigestJob(full.params);
    assert.lengthOf(full.calls, 1);
    const cache = full.params.cache as ReturnType<typeof memoryCache>;
    const scoped = job({
      cache,
      scope: scope({ source: "sections", sections: ["results"] }),
    });
    await runPaperDigestJob(scoped.params);
    assert.lengthOf(scoped.calls, 1, "the scoped request read the paper");
    assert.notEqual(scoped.digests[0].cacheKey, fullResult.digests[0].cacheKey);
    // A full request again is served from its own entry, as before scopes.
    const again = job({ cache });
    await runPaperDigestJob(again.params);
    assert.lengthOf(again.calls, 0);
    assert.equal(
      fullResult.digests[0].cacheKey,
      digestCacheKey({
        contextItemId: 101,
        text: PAPER,
        instruction: "Summarize each paper",
        model: "reader-model",
      }),
      "a full read's key is the key records saved before scopes have",
    );
  });

  it("reads a short scoped text that the full-text thin gate refuses", async function () {
    const abstract600 = "A ".repeat(300).trim();
    const full = job({ text: abstract600 });
    const fullResult = await runPaperDigestJob(full.params);
    assert.equal(
      fullResult.failures[0]?.reason,
      DIGEST_FAILURE_REASONS.thinText,
    );
    const scoped = job({
      text: abstract600,
      scope: scope({ source: "sections", sections: ["results"] }),
    });
    const scopedResult = await runPaperDigestJob(scoped.params);
    assert.lengthOf(scopedResult.digests, 1);
    assert.lengthOf(scoped.calls, 1);
  });

  it("names a paper with none of the named sections and reads nothing for it", async function () {
    const run = job({
      scope: scope({ source: "sections", sections: ["results"] }),
      readText: async (itemId) => ({
        itemId,
        contextItemId: 101,
        backend: "pdf",
        text: "",
        totalCharacters: 0,
        covered: [],
        unmatched: ["results"],
      }),
    });
    const result = await runPaperDigestJob(run.params);
    assert.lengthOf(run.calls, 0);
    assert.deepEqual(result.failures, [
      {
        target: "item:1",
        itemId: 1,
        reason: DIGEST_FAILURE_REASONS.noMatchingSections,
        detail: "Not found: results",
      },
    ]);
  });

  it("returns an abstract as written with its citation id, with no model call and no cache write", async function () {
    const cache = memoryCache();
    const run = job({
      cache,
      scope: { source: "abstract" },
      // A reader that would fail: an abstract never reaches it.
      reader: {
        model: "",
        complete: async () => {
          run.calls.push("called");
          throw new Error("no model may be called for an abstract");
        },
      },
      readText: async (itemId) => ({
        itemId,
        contextItemId: 101,
        title: "Drift in place cells",
        sourceLabel: "(Ziv, 2021)",
        backend: "text",
        text: LONG_ABSTRACT,
        totalCharacters: LONG_ABSTRACT.length,
        covered: ["Abstract"],
        bounds: "exact",
        textSource: "Zotero abstract field",
      }),
    });
    assert.isAbove(LONG_ABSTRACT.length, 1_400);
    const result = await runPaperDigestJob(run.params);
    assert.lengthOf(run.calls, 0);
    assert.equal(cache.sets, 0);
    assert.lengthOf(cache.gets, 0);
    const digest = result.digests[0];
    assert.equal(digest.schema, 2);
    assert.equal(digest.answer, LONG_ABSTRACT);
    assert.equal(digest.source.backend, "text");
    assert.deepEqual(digest.source.scope, { source: "abstract" });
    assert.equal(digest.source.textSource, "Zotero abstract field");
    assert.lengthOf(digest.evidence, 1);
    // The whole abstract is the quote: no per-quote cap cuts it.
    assert.equal(digest.evidence[0].quote, LONG_ABSTRACT);
    assert.match(digest.evidence[0].quoteCitationId || "", /^Q_/);
    assert.lengthOf(digest.quoteCitations || [], 1);
    assert.equal(digest.quoteCitations![0].quoteText, LONG_ABSTRACT);
    assert.equal(digest.quoteCitations![0].sourceChunkKind, "abstract");
    // Shown once, whole, with its id.
    const rendered = renderHostPaperDigests([digest], []);
    assert.include(
      rendered,
      `Abstract (quoteCitationId: ${digest.evidence[0].quoteCitationId}): ${LONG_ABSTRACT}`,
    );
    assert.notInclude(rendered, "Answer:");
    // A host-verified read of the abstract, not of the body.
    assert.deepEqual(
      digestReadCapabilities(digest.source, DIGEST_BODY_DEPTH_CHARS),
      ["abstract"],
    );
    // A sections read that found only an unlabelled lead is the abstract too.
    assert.deepEqual(
      digestReadCapabilities(
        {
          scope: { source: "sections", sections: ["abstract"] },
          complete: true,
          readCharacters: 700,
          covered: ["Abstract (unlabelled lead)"],
        },
        DIGEST_BODY_DEPTH_CHARS,
      ),
      ["abstract"],
    );
  });

  it("cuts an abstract longer than the cap as its answer and quote, and says so", async function () {
    const sentence =
      "Sentence of a very long abstract about representational drift in place cells.";
    const longAbstract = Array.from({ length: 60 }, () => sentence).join(" ");
    assert.isAbove(longAbstract.length, 3_000);
    const run = job({
      scope: { source: "abstract" },
      readText: async (itemId) => ({
        itemId,
        contextItemId: 101,
        title: "Drift in place cells",
        sourceLabel: "(Ziv, 2021)",
        backend: "text",
        text: longAbstract,
        totalCharacters: longAbstract.length,
        covered: ["Abstract"],
        bounds: "exact",
        textSource: "Zotero abstract field",
      }),
    });
    const result = await runPaperDigestJob(run.params);
    const digest = result.digests[0];
    const quote = digest.evidence[0].quote;
    assert.isAtMost(quote.length, ABSTRACT_DIGEST_MAX_CHARS);
    assert.isAbove(quote.length, ABSTRACT_DIGEST_MAX_CHARS * 0.7);
    assert.isTrue(
      longAbstract.startsWith(quote),
      "the quote is a verbatim start of the abstract",
    );
    assert.include(digest.answer, "[abstract truncated: the first");
    assert.include(digest.answer, `of ${longAbstract.length} characters]`);
    assert.isAtMost(
      digest.answer.length,
      ABSTRACT_DIGEST_MAX_CHARS + 100,
      "the answer is as short as the quote plus its note",
    );
    assert.isFalse(digest.source.complete);
    assert.equal(digest.quoteCitations![0].quoteText, quote);
    assert.include(renderHostPaperDigests([digest], []), "[abstract truncated");
  });

  it("tags a quote from the abstract part of a sections read as the abstract", async function () {
    const abstractQuote =
      "Representational drift leaves linear decoding of position intact across days.";
    const text = [
      "## Abstract",
      "",
      abstractQuote,
      "",
      "## 2 Results",
      "",
      "Decoding stayed above chance on every day we recorded.",
    ].join("\n");
    const run = job({
      text,
      scope: scope({ source: "sections", sections: ["abstract", "results"] }),
      readText: async (itemId): Promise<PaperDigestSource> => ({
        itemId,
        contextItemId: 101,
        title: "Drift in place cells",
        sourceLabel: "(Ziv, 2021)",
        backend: "mineru",
        text,
        totalCharacters: text.length,
        covered: ["Abstract", "Results"],
        bounds: "exact",
        textSource: "Zotero abstract field; MinerU sections",
      }),
      reader: {
        model: "reader-model",
        complete: async () => ({
          text: JSON.stringify({
            answer: "Decoding survives drift.",
            evidence: [
              { section: "Abstract", quote: abstractQuote },
              {
                section: "Results",
                quote: "Decoding stayed above chance on every day we recorded.",
              },
            ],
          }),
        }),
      },
    });
    const result = await runPaperDigestJob(run.params);
    const digest = result.digests[0];
    assert.lengthOf(digest.evidence, 2);
    const byQuote = new Map(
      (digest.quoteCitations || []).map((entry) => [entry.quoteText, entry]),
    );
    assert.equal(byQuote.get(abstractQuote)?.sourceChunkKind, "abstract");
    assert.isUndefined(
      byQuote.get("Decoding stayed above chance on every day we recorded.")
        ?.sourceChunkKind,
    );
  });

  it("names a paper with no abstract", async function () {
    const run = job({
      scope: { source: "abstract" },
      readText: async (itemId) => ({
        itemId,
        contextItemId: 101,
        backend: "text",
        text: "",
        totalCharacters: 0,
        covered: [],
        unmatched: ["abstract"],
      }),
    });
    const result = await runPaperDigestJob(run.params);
    assert.equal(result.failures[0]?.reason, DIGEST_FAILURE_REASONS.noAbstract);
  });
});

describe("digest ledger depth from what a digest covered", function () {
  const paper = { libraryID: 1, itemId: 1, title: "Drift" };
  const base = (source: HostPaperDigest["source"]): HostPaperDigest => ({
    schema: 2,
    itemId: 1,
    contextItemId: 101,
    answer: "An answer.",
    evidence: [
      { section: "Abstract", quote: "We ask whether drift impairs decoding." },
      { section: "Results", quote: "Decoding stayed above chance." },
    ],
    facets: [],
    gaps: [],
    source,
    model: "m",
    producedAt: 0,
    cacheKey: "k",
  });

  it("records an abstract digest as the abstract, never read or full", function () {
    const delta = buildDigestLedgerDelta({
      callId: "c",
      toolName: "task_update",
      digest: {
        ...base({
          backend: "text",
          readCharacters: 10,
          totalCharacters: 10,
          complete: true,
          scope: { source: "abstract" },
          covered: ["Abstract"],
        }),
        answer: "We ask whether drift impairs decoding.",
        evidence: [
          {
            section: "Abstract",
            quote: "We ask whether drift impairs decoding.",
          },
        ],
      },
      paper,
    });
    assert.equal(delta.papers[0].state, "skimmed");
    assert.isUndefined(
      delta.papers[0].text,
      "an abstract says nothing of the text",
    );
    const granularities = delta.reads.map((read) => read.granularity);
    assert.deepEqual(granularities, ["digest", "abstract"]);
    assert.isFalse(delta.reads[0].complete);
    assert.equal(
      delta.reads[1].snippet,
      "We ask whether drift impairs decoding.",
    );
    assert.notInclude(granularities, "full");
    assert.notInclude(granularities, "passage");
    const depths = taskPaperReadDepths(delta);
    assert.deepEqual(depths.text, []);
    assert.deepEqual(depths.shallow, [1]);
  });

  it("records a sections digest as its sections, skimmed, even when complete", function () {
    const delta = buildDigestLedgerDelta({
      callId: "c",
      toolName: "task_update",
      digest: base({
        backend: "mineru",
        readCharacters: 10,
        totalCharacters: 10,
        complete: true,
        scope: { source: "sections", sections: ["abstract", "results"] },
        covered: ["Abstract", "Results"],
      }),
      paper,
    });
    assert.equal(delta.papers[0].state, "skimmed");
    const reads = delta.reads.map((read) => [read.granularity, read.label]);
    assert.deepEqual(reads, [
      ["digest", undefined],
      ["abstract", "Abstract"],
      ["section", "Results"],
      ["abstract", "Abstract"],
      ["passage", "Results"],
    ]);
    assert.isFalse(delta.reads[0].complete);
  });

  it("counts a scoped digest at the depth it covered, not at the form of its answer", function () {
    const strongest = (source: HostPaperDigest["source"]) => {
      const delta = buildDigestLedgerDelta({
        callId: "c",
        toolName: "task_update",
        digest: { ...base(source), evidence: [] },
        paper,
      });
      const ledger = applyTaskPaperLedgerDelta(
        createTaskPaperLedger(),
        delta,
        1,
      );
      return buildTaskPaperCoverage(ledger).papers[0].strongestGranularity;
    };
    const part = { backend: "mineru" as const, readCharacters: 10 };
    assert.equal(
      strongest({
        ...part,
        totalCharacters: 10,
        complete: true,
        scope: { source: "abstract" },
        covered: ["Abstract"],
      }),
      "abstract",
    );
    assert.equal(
      strongest({
        ...part,
        totalCharacters: 10,
        complete: true,
        scope: { source: "notes" },
        covered: ["notes"],
      }),
      "notes",
    );
    assert.equal(
      strongest({
        ...part,
        totalCharacters: 10,
        complete: true,
        scope: { source: "sections", sections: ["abstract", "results"] },
        covered: ["Abstract", "Results"],
      }),
      "section",
    );
    // A digest of every character of the text counts at full depth.
    assert.equal(
      strongest({ ...part, totalCharacters: 10, complete: true }),
      "full",
    );
  });

  it("records a digest saved before scopes as a full read, as before", function () {
    const delta = buildDigestLedgerDelta({
      callId: "c",
      toolName: "task_update",
      digest: base({
        backend: "mineru",
        readCharacters: 10,
        totalCharacters: 10,
        complete: true,
      }),
      paper,
    });
    assert.equal(delta.papers[0].state, "read");
    assert.isTrue(delta.reads[0].complete);
  });
});

describe("a digest record saved before read scopes", function () {
  const globalScope = globalThis as unknown as Record<string, unknown>;
  let originalZotero: unknown;
  let db: DatabaseSync;
  const conversationKey = 976_100;

  beforeEach(function () {
    originalZotero = globalScope.Zotero;
    db = new DatabaseSync(":memory:");
    const bindable = (params: unknown[] | undefined) =>
      (params || []).map((value) => (value === undefined ? null : value));
    globalScope.Zotero = {
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          const statement = db.prepare(sql);
          if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql))
            return statement.all(...(bindable(params) as never[]));
          statement.run(...(bindable(params) as never[]));
          return [];
        },
        executeTransaction: async (task: () => Promise<unknown>) => task(),
      },
    };
    db.exec(`CREATE TABLE IF NOT EXISTS llm_for_zotero_agent_tool_result_handles (
      conversation_key INTEGER NOT NULL,
      handle TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      input_digest TEXT,
      resource_signature TEXT,
      content_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(conversation_key, handle)
    )`);
    clearAgentToolResultHandleStore();
  });

  afterEach(function () {
    clearAgentToolResultHandleStore();
    globalScope.Zotero = originalZotero;
    db.close();
  });

  it("loads from the stored row and reads as a full read of the whole text", async function () {
    const cacheKey = digestCacheKey({
      contextItemId: 101,
      text: PAPER,
      instruction: "Summarize each paper",
      model: "reader-model",
    });
    // The schema 2 shape as stored before scopes: no source.scope.
    const old: HostPaperDigest = {
      schema: 2,
      itemId: 1,
      contextItemId: 101,
      title: "Drift in place cells",
      answer: "A stored answer.",
      evidence: [],
      quoteCitations: [],
      facets: [],
      gaps: [],
      source: {
        backend: "mineru",
        readCharacters: PAPER.length,
        totalCharacters: PAPER.length,
        complete: true,
      },
      model: "reader-model",
      producedAt: 1,
      cacheKey,
    };
    db.prepare(
      `INSERT INTO llm_for_zotero_agent_tool_result_handles
        (conversation_key, handle, tool_name, tool_call_id, input_digest, resource_signature, content_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      conversationKey,
      "trh_old_digest",
      PAPER_DIGEST_HANDLE_TOOL,
      cacheKey,
      null,
      null,
      JSON.stringify({ cacheKey, digest: old, rendered: "old" }),
      1,
    );

    const cache = createHandleStorePaperDigestCache({ conversationKey });
    const loaded = await cache.get(cacheKey);
    assert.exists(loaded, "the old row loads through the store");
    assert.isUndefined(loaded!.source.scope);
    assert.isTrue(digestReadWholeText(loaded!));

    // A full request is served by it, as before scopes.
    const full = job({ cache });
    await runPaperDigestJob(full.params);
    assert.lengthOf(full.calls, 0);
    assert.equal(full.digests[0].answer, "A stored answer.");

    // A scoped request over the same text never is.
    const scoped = job({
      cache,
      scope: scope({ source: "sections", sections: ["results"] }),
    });
    await runPaperDigestJob(scoped.params);
    assert.lengthOf(scoped.calls, 1);
    assert.equal(scoped.digests[0].answer, "Decoding survives drift.");

    // Its host-verified read is of the body, and its ledger row is read.
    const ledger = buildDigestLedgerDelta({
      callId: "c",
      toolName: "task_update",
      digest: loaded!,
      paper: { libraryID: 1, itemId: 1 },
    });
    assert.equal(ledger.papers[0].state, "read");
    assert.deepEqual(
      digestReadCapabilities(loaded!.source, DIGEST_BODY_DEPTH_CHARS),
      ["body"],
    );
  });
});
