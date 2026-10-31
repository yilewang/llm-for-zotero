import { assert } from "chai";
import {
  DIGEST_FAILURE_REASONS,
  DIGEST_TEXT_MAX_CHARS,
  renderHostPaperDigests,
  runPaperDigestJob,
  splitDigestPieces,
  type HostPaperDigest,
  type PaperDigestCache,
  type PaperDigestFailure,
  type PaperDigestReader,
} from "../src/agent/digests/paperDigestWorker";
import { runDigestParts } from "../src/agent/digests/digestJobHost";
import { readPaperTextForDigest } from "../src/agent/tools/read/paperRead";
import {
  ReaderCompletionError,
  createReaderCallLimiter,
  type ReaderCompletion,
} from "../src/shared/readerCompletion";

/** The single-call cap is 8,000 characters; a batch holds about 28,000. */
const SMALL_WINDOW = 14_000;
const SHARED = "This shared sentence appears in every part of the paper.";

const finding = (k: number) =>
  `Finding ${k}: the recorded population ${k} kept stable decoding across sessions.`;
const extra = (k: number, n: number) =>
  `Observation ${k}.${n}: the cells of population ${k} drifted at a measured pace.`;

/** One ~1,000-character section per index, each with its own sentences. */
function paperText(sections: number): string {
  return Array.from({ length: sections }, (_, k) => {
    const body = [
      finding(k),
      extra(k, 1),
      extra(k, 2),
      extra(k, 3),
      SHARED,
    ].join(" ");
    const filler =
      " Filler words describe the methods in neutral detail.".repeat(
        Math.max(0, Math.ceil((1_000 - body.length) / 54)),
      );
    return `## Section ${k}\n${body}${filler}`;
  }).join("\n\n");
}

/** The section indexes whose finding sentence a prompt holds. */
function sectionsIn(prompt: string): number[] {
  return [...prompt.matchAll(/Finding (\d+):/g)].map((match) =>
    Number(match[1]),
  );
}

const isMerge = (prompt: string) =>
  prompt.includes("Merge them into one result");

const MERGED = JSON.stringify({
  answer: "The paper shows stable decoding across sessions despite drift.",
  facets: [{ label: "Contributions", content: "Stable decoding." }],
  relevance: { level: "direct", reason: "It tests decoding under drift." },
});

function memoryCache(): PaperDigestCache & {
  entries: Map<string, HostPaperDigest>;
} {
  const entries = new Map<string, HostPaperDigest>();
  return {
    entries,
    get: async (key) => entries.get(key) || null,
    set: async (digest) => void entries.set(digest.cacheKey, digest),
  };
}

type Reply = (prompt: string) => string | Promise<string>;

function fakeReader(reply: Reply): PaperDigestReader & {
  prompts: string[];
} {
  const prompts: string[] = [];
  const complete: ReaderCompletion = async (prompt) => {
    prompts.push(prompt);
    return { text: await reply(prompt) };
  };
  return { complete, model: "reader-model", route: "claude_bridge", prompts };
}

/** A batch reply: its digest and quotes drawn from what it read and beyond. */
function batchReply(prompt: string, quotes: (sections: number[]) => string[]) {
  const sections = sectionsIn(prompt);
  return JSON.stringify({
    digest: `Digest of sections ${sections.join(",")}.`,
    relevantChunkIds: [],
    evidence: quotes(sections).map((quote) => ({ section: "x", quote })),
  });
}

function job(
  text: string,
  reader: PaperDigestReader,
  overrides: Partial<Parameters<typeof runPaperDigestJob>[0]> = {},
) {
  const digests: HostPaperDigest[] = [];
  const failures: PaperDigestFailure[] = [];
  const cache = memoryCache();
  const params = {
    targets: ["item:1"],
    instruction: "Summarize each paper",
    question: "Does drift impair decoding?",
    readText: async (itemId: number) => ({
      itemId,
      contextItemId: itemId + 100,
      backend: "mineru" as const,
      title: "Drift paper",
      text,
      totalCharacters: text.length,
    }),
    reader,
    inputCapTokens: SMALL_WINDOW,
    wait: async () => undefined,
    cache,
    now: () => 1,
    onDigest: async (digest: HostPaperDigest) => void digests.push(digest),
    onFailure: async (failure: PaperDigestFailure) =>
      void failures.push(failure),
    ...overrides,
  };
  return { params, digests, failures, cache };
}

describe("whole-text digests of a paper longer than one call", function () {
  it("reads every batch, merges them, and keeps each batch's verified quotes", async function () {
    const text = paperText(40);
    const reader = fakeReader((prompt) =>
      isMerge(prompt)
        ? MERGED
        : batchReply(prompt, (sections) => [
            finding(sections[0]),
            extra(sections[1], 1),
            // In the paper, but not in this batch: never this batch's quote.
            sections.includes(0) ? finding(39) : finding(0),
            "An invented sentence that the paper never contains.",
          ]),
    );
    const { params, digests, cache } = job(text, reader);
    await runPaperDigestJob(params);

    assert.lengthOf(digests, 1);
    const digest = digests[0];
    assert.equal(digest.source.batches, 2);
    assert.isTrue(digest.source.complete);
    assert.equal(digest.source.readCharacters, text.length);
    assert.equal(digest.source.totalCharacters, text.length);
    assert.equal(digest.model, "reader-model");
    assert.equal(digest.readerRoute, "claude_bridge");
    assert.equal(digest.relevance?.level, "direct");

    const batchPrompts = reader.prompts.filter((prompt) => !isMerge(prompt));
    const mergePrompts = reader.prompts.filter(isMerge);
    assert.lengthOf(batchPrompts, 2);
    assert.lengthOf(mergePrompts, 1);
    assert.isFalse(
      reader.prompts.some((prompt) => prompt.includes("<paper>")),
      "a long paper is never sent whole in one call",
    );
    assert.include(mergePrompts[0], "<part 1>");
    assert.include(mergePrompts[0], "<part 2>");
    assert.include(mergePrompts[0], "Does drift impair decoding?");

    // Two verified quotes per batch; the cross-batch and invented ones are
    // dropped. Each names its batch, and its batch's text holds it.
    assert.lengthOf(digest.evidence, 4);
    for (const entry of digest.evidence) {
      assert.isNumber(entry.batch);
      assert.include(batchPrompts[entry.batch!], entry.quote);
      assert.include(text, entry.quote);
    }
    assert.deepEqual(
      [...new Set(digest.evidence.map((entry) => entry.batch))].sort(),
      [0, 1],
    );
    assert.equal(cache.entries.size, 1);
  });

  it("is partial when a batch never came back, and the merge names the missing part", async function () {
    const text = paperText(70);
    const reader = fakeReader((prompt) => {
      if (isMerge(prompt)) return MERGED;
      if (sectionsIn(prompt).includes(60)) throw new Error("socket hang up");
      return batchReply(prompt, (sections) => [finding(sections[0])]);
    });
    const { params, digests } = job(text, reader);
    await runPaperDigestJob(params);

    assert.lengthOf(digests, 1);
    const digest = digests[0];
    assert.equal(digest.source.batches, 3);
    assert.isFalse(digest.source.complete);
    assert.isBelow(digest.source.readCharacters, digest.source.totalCharacters);
    const merge = reader.prompts.find(isMerge)!;
    assert.include(merge, "Parts 3 could not be read");
    assert.notInclude(merge, "<part 3>");
    assert.isTrue(digest.evidence.every((entry) => entry.batch !== 2));
  });

  it("is partial when the host had only part of the text, even if every batch came back", async function () {
    const text = paperText(40);
    const reader = fakeReader((prompt) =>
      isMerge(prompt) ? MERGED : batchReply(prompt, () => []),
    );
    const { params, digests } = job(text, reader, {
      readText: async (itemId) => ({
        itemId,
        contextItemId: 101,
        backend: "pdf",
        text,
        totalCharacters: text.length * 2,
      }),
    });
    await runPaperDigestJob(params);
    assert.isFalse(digests[0].source.complete);
    assert.equal(digests[0].source.readCharacters, text.length);
  });

  it("fails the paper, and caches nothing, when the merge never parses", async function () {
    const text = paperText(40);
    const reader = fakeReader((prompt) =>
      isMerge(prompt) ? "not json" : batchReply(prompt, () => []),
    );
    const { params, digests, failures, cache } = job(text, reader);
    await runPaperDigestJob(params);
    assert.lengthOf(digests, 0);
    assert.deepEqual(
      failures.map((failure) => failure.reason),
      [DIGEST_FAILURE_REASONS.parse],
    );
    assert.equal(cache.entries.size, 0);
    // First merge call and one repair call.
    assert.lengthOf(reader.prompts.filter(isMerge), 2);
  });

  it("fails every paper as unconfigured when no batch can be read for that reason", async function () {
    const text = paperText(40);
    let reads = 0;
    const reader = fakeReader(() => {
      throw new ReaderCompletionError({
        reason: "not_configured",
        detail: "no login",
      });
    });
    const { params, failures } = job(text, reader, {
      targets: ["item:1", "item:2"],
      concurrency: 1,
      readText: async (itemId) => {
        reads += 1;
        return {
          itemId,
          contextItemId: itemId + 100,
          backend: "mineru",
          text,
          totalCharacters: text.length,
        };
      },
    });
    await runPaperDigestJob(params);
    assert.deepEqual(
      failures.map((failure) => failure.reason),
      [
        DIGEST_FAILURE_REASONS.notConfigured,
        DIGEST_FAILURE_REASONS.notConfigured,
      ],
    );
    assert.equal(reads, 1, "the second paper is not read");
  });

  it("dedupes quotes across batches and keeps at most six, spread over the batches", async function () {
    const text = paperText(70);
    const reader = fakeReader((prompt) =>
      isMerge(prompt)
        ? MERGED
        : batchReply(prompt, (sections) => [
            SHARED,
            finding(sections[0]),
            finding(sections[1]),
            finding(sections[2]),
          ]),
    );
    const { params, digests } = job(text, reader);
    await runPaperDigestJob(params);
    const evidence = digests[0].evidence;
    assert.lengthOf(evidence, 6);
    const quotes = evidence.map((entry) => entry.quote);
    assert.lengthOf(new Set(quotes), 6);
    assert.lengthOf(
      quotes.filter((quote) => quote === SHARED),
      1,
    );
    assert.deepEqual(
      [...new Set(evidence.map((entry) => entry.batch))].sort(),
      [0, 1, 2],
    );
  });

  it("reads a paper within one call's cap in one call, as before", async function () {
    const text = paperText(5);
    const reader = fakeReader(() =>
      JSON.stringify({ answer: "Short paper answer.", evidence: [] }),
    );
    const { params, digests } = job(text, reader);
    await runPaperDigestJob(params);
    assert.lengthOf(reader.prompts, 1);
    assert.include(reader.prompts[0], "<paper>");
    assert.isTrue(digests[0].source.complete);
    assert.notProperty(digests[0].source, "batches");
  });

  it("serves a batched paper again from the cache without a call", async function () {
    const text = paperText(40);
    const reader = fakeReader((prompt) =>
      isMerge(prompt) ? MERGED : batchReply(prompt, () => []),
    );
    const first = job(text, reader);
    await runPaperDigestJob(first.params);
    const calls = reader.prompts.length;
    const second = job(text, reader, { cache: first.cache });
    await runPaperDigestJob(second.params);
    assert.lengthOf(second.digests, 1);
    assert.equal(reader.prompts.length, calls);
  });

  it("splits text into pieces that join back exactly", function () {
    const text = paperText(12);
    const pieces = splitDigestPieces(text, 4_000);
    assert.equal(pieces.join(""), text);
    assert.isTrue(pieces.every((piece) => piece.length <= 4_000));
    assert.isAbove(pieces.length, 2);
  });
});

describe("a digest of an item longer than the digest text limit", function () {
  it("reads at most the limit of 250,000 characters and says the item was read in part", async function () {
    assert.equal(DIGEST_TEXT_MAX_CHARS, 250_000);
    // A book: about 300,000 characters, above the limit.
    const whole = paperText(300);
    assert.isAbove(whole.length, DIGEST_TEXT_MAX_CHARS);
    const asked: number[] = [];
    const reader = fakeReader((prompt) =>
      isMerge(prompt)
        ? MERGED
        : batchReply(prompt, (sections) => [finding(sections[0])]),
    );
    const { params, digests } = job(whole, reader, {
      readText: async (itemId, maxChars) => {
        asked.push(maxChars);
        return {
          itemId,
          contextItemId: itemId + 100,
          backend: "mineru",
          title: "A long book",
          text: whole.slice(0, maxChars),
          totalCharacters: whole.length,
        };
      },
    });
    await runPaperDigestJob(params);
    assert.deepEqual(asked, [250_000]);
    assert.lengthOf(digests, 1);
    const { source } = digests[0];
    assert.isFalse(source.complete);
    assert.equal(source.readCharacters, 250_000);
    assert.equal(source.totalCharacters, whole.length);
    // No reader call saw text past the limit.
    const tail = finding(290);
    assert.isTrue(reader.prompts.every((prompt) => !prompt.includes(tail)));
    const rendered = renderHostPaperDigests(digests, []);
    assert.include(
      rendered,
      `text: Part (an excerpt), 250,000 of ${whole.length.toLocaleString("en-US")} characters`,
    );
    assert.notInclude(rendered, "text: Full (every character)");
  });
});

describe("digest text read for a whole-text digest", function () {
  const scope = globalThis as unknown as Record<string, unknown>;
  let hadIOUtils = false;
  let previousIOUtils: unknown;
  beforeEach(function () {
    hadIOUtils = "IOUtils" in scope;
    previousIOUtils = scope.IOUtils;
  });
  afterEach(function () {
    if (hadIOUtils) scope.IOUtils = previousIOUtils;
    else delete scope.IOUtils;
  });
  const paperContext = { itemId: 1, contextItemId: 101, title: "Long paper" };

  it("returns the whole MinerU text of a long paper within the limit, never a sample", async function () {
    const md = paperText(100);
    assert.isBelow(md.length, DIGEST_TEXT_MAX_CHARS);
    scope.IOUtils = { read: async () => new TextEncoder().encode(md) };
    const result = await readPaperTextForDigest({
      paperContext: { ...paperContext, mineruCacheDir: "/tmp/mineru/101" },
      pdfService: {
        getOverviewExcerpt: async () => {
          throw new Error("unused");
        },
      },
      maxChars: DIGEST_TEXT_MAX_CHARS,
    });
    assert.equal(result?.text, md);
    assert.equal(result?.totalCharacters, md.length);
  });

  it("asks the PDF path for an excerpt bounded by the digest text limit, which is the whole text at or under it", async function () {
    let asked = 0;
    const result = await readPaperTextForDigest({
      paperContext,
      pdfService: {
        getOverviewExcerpt: async (params) => {
          asked = params.maxChars ?? 0;
          return {
            text: "[chunk 0]\nAll.\n\n[chunk 1]\nOf it.",
            chunkIndexes: [0, 1],
            totalChunks: 2,
          } as never;
        },
      },
      maxChars: DIGEST_TEXT_MAX_CHARS,
    });
    assert.equal(asked, DIGEST_TEXT_MAX_CHARS);
    assert.equal(result?.totalCharacters, result?.text.length);
  });

  it("reports a sampled PDF excerpt of an item over the limit as partial", async function () {
    const result = await readPaperTextForDigest({
      paperContext,
      pdfService: {
        getOverviewExcerpt: async () =>
          ({
            text: "[chunk 0]\nStart.\n\n[chunk 9]\nEnd.",
            chunkIndexes: [0, 9],
            totalChunks: 10,
          }) as never,
      },
      maxChars: DIGEST_TEXT_MAX_CHARS,
    });
    assert.equal(result?.backend, "pdf");
    assert.isAbove(result!.totalCharacters, result!.text.length);
  });

  it("over the limit, keeps the introduction and the tail from the last conclusion heading, and says the text is partial", async function () {
    const md = `${paperText(300)}\n\n## Conclusion\n${finding(999)}`;
    assert.isAbove(md.length, DIGEST_TEXT_MAX_CHARS);
    scope.IOUtils = { read: async () => new TextEncoder().encode(md) };
    const result = await readPaperTextForDigest({
      paperContext: { ...paperContext, mineruCacheDir: "/tmp/mineru/101" },
      pdfService: { getOverviewExcerpt: async () => ({}) as never },
      maxChars: DIGEST_TEXT_MAX_CHARS,
    });
    assert.isAtMost(result!.text.length, DIGEST_TEXT_MAX_CHARS);
    assert.include(result!.text, finding(0));
    assert.include(result!.text, "## Conclusion");
    assert.include(result!.text, finding(999));
    assert.equal(result!.totalCharacters, md.length);
    assert.isAbove(result!.totalCharacters, result!.text.length);
  });

  it("an over-limit item's digest reads its last part and is partial", async function () {
    const md = `${paperText(300)}\n\n## Conclusion\n${finding(999)}`;
    scope.IOUtils = { read: async () => new TextEncoder().encode(md) };
    const reader = fakeReader((prompt) =>
      isMerge(prompt)
        ? MERGED
        : batchReply(prompt, (sections) => [finding(sections[0])]),
    );
    const { params, digests } = job(md, reader, {
      readText: async (itemId, maxChars) => {
        const read = await readPaperTextForDigest({
          paperContext: {
            itemId,
            contextItemId: itemId + 100,
            title: "A thesis",
            mineruCacheDir: "/tmp/mineru/101",
          },
          pdfService: { getOverviewExcerpt: async () => ({}) as never },
          maxChars,
        });
        return {
          itemId,
          contextItemId: itemId + 100,
          title: "A thesis",
          ...read!,
        };
      },
    });
    await runPaperDigestJob(params);
    assert.lengthOf(digests, 1);
    assert.isFalse(digests[0].source.complete);
    assert.equal(digests[0].source.totalCharacters, md.length);
    // The thesis's last part reached a reader call.
    assert.isTrue(
      reader.prompts.some((prompt) => sectionsIn(prompt).includes(999)),
    );
  });

  it("cuts an extreme document with no heading to its introduction and tail, and says the text is partial", async function () {
    const md = `${"a".repeat(2_500)}${"b".repeat(2_500)}`;
    scope.IOUtils = { read: async () => new TextEncoder().encode(md) };
    const result = await readPaperTextForDigest({
      paperContext: { ...paperContext, mineruCacheDir: "/tmp/mineru/101" },
      pdfService: { getOverviewExcerpt: async () => ({}) as never },
      maxChars: 2_000,
    });
    assert.isAtMost(result!.text.length, 2_000);
    assert.include(result!.text, "b".repeat(100));
    assert.equal(result!.totalCharacters, 5_000);
  });
});

describe("digest parts read with the runtime's own model", function () {
  const run = async (
    request: Record<string, unknown>,
    factories: Record<string, () => ReaderCompletion>,
  ) => {
    const cache = memoryCache();
    const result = await runDigestParts({
      parts: [{ taskId: "run:task:papers", targets: ["item:1"] }],
      context: {
        request: {
          conversationKey: 1,
          mode: "agent",
          userText: "",
          ...request,
        },
        runId: "run",
        toolCallId: "call-1",
      } as never,
      deps: {
        resolvePaper: async (_request, itemId) => ({
          itemId,
          contextItemId: itemId + 100,
          title: "Drift paper",
        }),
        readText: async () => ({
          backend: "mineru",
          text: paperText(3),
          totalCharacters: paperText(3).length,
        }),
        readerFactories: factories,
        createCache: () => ({ ...cache, handleOf: async () => undefined }),
      },
      localTaskId: () => "papers",
    });
    return { result, cache };
  };
  const answering =
    (seen: string[]) => (): ReaderCompletion => async (_prompt, options) => {
      seen.push(options.model);
      return { text: JSON.stringify({ answer: "Answer from the reader." }) };
    };

  it("digests in Codex mode through Codex Responses with the chat's model", async function () {
    const seen: string[] = [];
    const { result, cache } = await run(
      {
        model: "gpt-5.4",
        authMode: "codex_app_server",
        providerProtocol: "codex_responses",
        exhaustiveReadBackend: "codex_responses",
      },
      { codexResponses: answering(seen) },
    );
    assert.deepEqual(seen, ["gpt-5.4"]);
    assert.notProperty(result, "digestFailures");
    const [digest] = [...cache.entries.values()];
    assert.equal(digest.model, "gpt-5.4");
    assert.equal(digest.readerRoute, "codex_responses");
  });

  it("digests in Claude mode through the bridge with the chat's model", async function () {
    const seen: string[] = [];
    const { result, cache } = await run(
      { model: "claude-sonnet-4-5", exhaustiveReadBackend: "claude_bridge" },
      { claudeBridge: answering(seen) },
    );
    assert.deepEqual(seen, ["claude-sonnet-4-5"]);
    assert.notProperty(result, "digestFailures");
    assert.equal([...cache.entries.values()][0].readerRoute, "claude_bridge");
  });

  it("digests the plugin Agent's papers under the host's shared reader limit", async function () {
    let running = 0;
    let peak = 0;
    const cache = memoryCache();
    const result = await runDigestParts({
      parts: [
        {
          taskId: "run:task:papers",
          targets: Array.from({ length: 6 }, (_, i) => `item:${i + 1}`),
        },
      ],
      context: {
        request: {
          conversationKey: 1,
          mode: "agent",
          userText: "",
          model: "deepseek-v4-flash",
          apiBase: "https://api.invalid",
          apiKey: "k",
        },
        runId: "run",
        toolCallId: "call-1",
      } as never,
      deps: {
        resolvePaper: async (_request, itemId) => ({
          itemId,
          contextItemId: itemId + 100,
          title: `Paper ${itemId}`,
        }),
        readText: async () => ({
          backend: "mineru",
          text: paperText(3),
          totalCharacters: paperText(3).length,
        }),
        readerFactories: {
          turnModel: () => async () => {
            running += 1;
            peak = Math.max(peak, running);
            await new Promise((resolve) => setTimeout(resolve, 10));
            running -= 1;
            return { text: JSON.stringify({ answer: "An answer." }) };
          },
        },
        createCache: () => ({ ...cache, handleOf: async () => undefined }),
      },
      limiter: createReaderCallLimiter(2),
      localTaskId: () => "papers",
    });
    assert.notProperty(result, "digestFailures");
    assert.equal(cache.entries.size, 6);
    assert.equal(peak, 2);
  });

  it("fails every paper as unconfigured when the scope has no reader", async function () {
    const { result } = await run(
      { model: "x", exhaustiveReadBackend: "unavailable" },
      {},
    );
    assert.deepEqual(
      result.digestFailures?.map((failure) => failure.reason),
      [DIGEST_FAILURE_REASONS.notConfigured],
    );
  });
});
