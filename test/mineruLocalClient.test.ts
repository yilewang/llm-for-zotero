import { assert } from "chai";
import {
  detectMineruLocalService,
  parseMineruV1,
  resolveMineruV1Tier,
  setMineruV1TimingForTests,
} from "../src/utils/mineruLocalClient";
import {
  parsePdfWithMineruLocal,
  parsePdfWithMineruCloud,
  testMineruConnection,
  MineruCancelledError,
} from "../src/utils/mineruClient";
import { normalizeMineruV1Zip } from "../src/utils/mineruV1Result";
import { buildManifest } from "../src/services/mineru/mineruCache";
import { mergeMineruChunkResults } from "../src/utils/mineruChunking";
import {
  createMineruV1Zip,
  mineruV1StructuredFixture,
} from "./helpers/mineruV1Fixture";
import type { MineruLocalOptions } from "../src/utils/mineruConfig";
import { shortenLongWaits } from "./helpers/shortWaits";

const base = "http://127.0.0.1:8000";
const options: MineruLocalOptions = {
  tier: "standard",
  effort: "high",
  imageAnalysis: true,
  serverUrl: "http://127.0.0.1:30000",
  apiKey: "local-secret",
};
const health = {
  status: "ok",
  version: "4.0.6",
  features: { sources: ["file_id"], output_formats: ["zip"] },
};
const complete = {
  job_id: "job-1",
  status: "completed",
  files: [
    {
      file_id: "input-1",
      status: "completed",
      output_files: { zip: { file_id: "zip-1" } },
    },
  ],
};
const json = (body: unknown, status = 200) => Response.json(body, { status });

async function rejects(action: Promise<unknown>, text: string) {
  try {
    await action;
    assert.fail("Expected rejection");
  } catch (error) {
    assert.include(String(error), text);
  }
}

describe("MinerU local API compatibility", function () {
  const original: Record<string, unknown> = {};
  let calls: Array<{ url: string; init: RequestInit }>;
  let route: (url: string, init: RequestInit) => Promise<Response> | Response;
  beforeEach(function () {
    for (const key of ["ztoolkit", "Zotero", "IOUtils"])
      original[key] = (globalThis as any)[key];
    calls = [];
    (globalThis as any).ztoolkit = {
      log: () => {},
      getGlobal: (key: string) =>
        key === "fetch"
          ? async (url: string, init: RequestInit = {}) => {
              calls.push({ url, init });
              return route(url, init);
            }
          : (globalThis as any)[key],
    };
    (globalThis as any).Zotero = { Prefs: { get: () => undefined } };
    (globalThis as any).IOUtils = {
      read: async () => new TextEncoder().encode("PDF bytes"),
    };
    setMineruV1TimingForTests({
      pollDelay: () => 1,
      downloadRetryDelays: [1, 1],
    });
    route = (url) => {
      if (url.endsWith("/v1/health")) return json(health);
      if (url.endsWith("/v1/tiers"))
        return json({ data: [{ id: "standard" }] });
      if (url.endsWith("/v1/uploads"))
        return json({
          id: "upload-1",
          status: "pending",
          upload_url: "/v1/uploads/upload-1/content",
          upload_method: "PUT",
          upload_headers: { "Content-Type": "application/pdf" },
        });
      if (url.endsWith("/uploads/upload-1/content"))
        return new Response(null, { status: 204 });
      if (url.endsWith("/complete"))
        return json({ status: "completed", file: { id: "input-1" } });
      if (url.includes("/parse/jobs")) return json(complete);
      if (url.endsWith("/files/zip-1/content"))
        return new Response(createMineruV1Zip());
      throw new Error(`Unexpected request ${url}`);
    };
  });
  afterEach(function () {
    setMineruV1TimingForTests(null);
    for (const key of Object.keys(original))
      (globalThis as any)[key] = original[key];
  });
  const parse = (
    signal?: AbortSignal,
    report: (m: string) => void = () => {},
  ) =>
    parseMineruV1({
      baseUrl: base,
      fileName: "test.pdf",
      pdfBytes: new TextEncoder().encode("PDF bytes"),
      service: { api: "v1", version: "4.0.6", tiers: ["standard"] },
      options,
      forceOcr: true,
      report,
      signal,
    });
  const deletes = () =>
    calls.filter(
      (c) => c.url.endsWith("/jobs/job-1") && c.init.method === "DELETE",
    ).length;
  /** Route job creation to "queued" and each status GET through `poll`. */
  const routeStatus = (
    poll: (count: number) => Promise<Response> | Response,
    onDelete: () => Response = () => json({ ...complete, status: "canceled" }),
  ) => {
    const normal = route;
    let count = 0;
    route = (url, init) => {
      if (url.endsWith("/parse/jobs"))
        return json({ ...complete, status: "queued" });
      if (url.endsWith("/jobs/job-1"))
        return init.method === "DELETE" ? onDelete() : poll(++count);
      return normal(url, init);
    };
  };

  it("detects V1 and supported tiers", async function () {
    assert.deepEqual(await detectMineruLocalService(base, options.apiKey), {
      api: "v1",
      version: "4.0.6",
      tiers: ["standard"],
    });
  });
  it("uses the legacy API only when V1 is absent", async function () {
    route = (url) =>
      url.endsWith("/v1/health")
        ? json({}, 404)
        : json({ status: "healthy", version: "3.4.5" });
    assert.equal((await detectMineruLocalService(base)).api, "legacy");
    assert.lengthOf(calls, 2);
  });
  it("recognizes MinerU 2.x without a health endpoint through its API schema", async function () {
    route = (url) =>
      url.endsWith("/openapi.json")
        ? json({ paths: { "/file_parse": { post: {} } } })
        : json({}, 404);
    assert.equal((await detectMineruLocalService(base)).api, "legacy");
    assert.lengthOf(calls, 3);
  });
  it("rejects a non-MinerU legacy API schema", async function () {
    route = (url) =>
      url.endsWith("/openapi.json")
        ? json({ paths: { "/chat/completions": { post: {} } } })
        : json({}, 404);
    await rejects(detectMineruLocalService(base), "neither MinerU");
  });
  for (const status of [401, 403, 500, 503])
    it(`does not hide health HTTP ${status} with a legacy fallback`, async function () {
      route = () => json({ error: { message: "Service failure" } }, status);
      await rejects(detectMineruLocalService(base), `HTTP ${status}`);
      assert.lengthOf(calls, 1);
    });
  it("rejects an unrelated HTTP service", async function () {
    route = () => new Response("<html>Login</html>");
    await rejects(detectMineruLocalService(base), "valid MinerU");
  });
  it("explains an unreachable local server", async function () {
    route = () => {
      throw new TypeError("fetch failed");
    };
    await rejects(
      detectMineruLocalService(base),
      "start the MinerU API server",
    );
  });
  it("runs the public local entry point through upload, job and ZIP normalization", async function () {
    const progress: string[] = [];
    const result = await parsePdfWithMineruLocal(
      "paper.pdf",
      base,
      "pipeline",
      (stage) => progress.push(stage),
      undefined,
      true,
      options,
    );
    assert.include(result!.mdContent, "Second page.");
    const job = JSON.parse(
      calls.find((c) => c.url.endsWith("/parse/jobs"))!.init.body as string,
    );
    assert.equal(job.tier, "standard");
    assert.equal(job.ocr_mode, "ocr");
    assert.equal(job.files[0].page_range, "all");
    assert.deepEqual(job.output_formats, ["zip"]);
    assert.equal(
      (calls.find((c) => c.init.method === "PUT")!.init.headers as any)
        .Authorization,
      "Bearer local-secret",
    );
    assert.include(progress.at(-1), "Done");
  });
  describe("tier selection", function () {
    const parseWith = (
      tier: MineruLocalOptions["tier"],
      tiers: string[],
      report: (m: string) => void = () => {},
    ) =>
      parseMineruV1({
        baseUrl: base,
        fileName: "test.pdf",
        pdfBytes: new TextEncoder().encode("PDF bytes"),
        service: { api: "v1", version: "4.0.10", tiers },
        options: { ...options, tier },
        forceOcr: false,
        report,
      });
    const jobBody = () =>
      JSON.parse(
        calls.find((c) => c.url.endsWith("/parse/jobs"))!.init.body as string,
      );

    it("parses a flash-only server with Auto by sending tier flash", async function () {
      const progress: string[] = [];
      const result = await parseWith("auto", ["flash"], (m) =>
        progress.push(m),
      );
      assert.include(result.mdContent, "Second page.");
      assert.equal(jobBody().tier, "flash");
      assert.notInclude(progress.join("\n"), "isn't offered");
    });
    it("falls back to an offered tier and says so before uploading", async function () {
      const progress: string[] = [];
      await parseWith("standard", ["flash"], (m) => progress.push(m));
      assert.equal(jobBody().tier, "flash");
      const notice = progress.indexOf(
        "standard isn't offered by this MinerU server; using flash",
      );
      assert.isAtLeast(notice, 0, progress.join("\n"));
      assert.isBelow(
        notice,
        progress.findIndex((m) =>
          m.startsWith("Uploading PDF to local MinerU V1"),
        ),
      );
    });
    it("keeps the fallback visible on the upload, processing and final lines", async function () {
      routeStatus((count) =>
        json({ ...complete, status: count === 1 ? "running" : "completed" }),
      );
      const progress: string[] = [];
      await parseWith("standard", ["flash"], (m) => progress.push(m));
      const lines = progress.join("\n");
      assert.include(
        progress.find((m) => m.startsWith("Uploading PDF")),
        "standard not offered",
      );
      assert.include(
        progress.find((m) => m.startsWith("Waiting for local MinerU")),
        "standard not offered",
        lines,
      );
      assert.include(
        progress.find((m) => m.startsWith("Processing on local MinerU")),
        "standard not offered",
        lines,
      );
      assert.include(progress.at(-1), "files extracted");
      assert.include(progress.at(-1), "standard not offered");
    });
    it("names the plain tier without a fallback note when nothing fell back", async function () {
      routeStatus((count) =>
        json({ ...complete, status: count === 1 ? "running" : "completed" }),
      );
      const progress: string[] = [];
      await parseWith("auto", ["flash"], (m) => progress.push(m));
      const tierLines = progress.filter((m) =>
        /^(Uploading PDF|Processing on|Waiting for local|Done)/.test(m),
      );
      assert.isAtLeast(tierLines.length, 4, progress.join("\n"));
      for (const line of tierLines) {
        assert.include(line, "flash", line);
        assert.notInclude(line, "not offered", line);
      }
      assert.include(progress.at(-1), "files extracted; flash)");
    });
    for (const [tier, tiers] of [
      ["auto", ["flash"]],
      ["auto", ["flash", "basic", "standard", "advanced"]],
      ["advanced", ["flash", "basic", "standard"]],
      ["basic", ["basic"]],
    ] as const)
      it(`never sends a null tier (${tier} with ${tiers.join("/")})`, async function () {
        await parseWith(tier, [...tiers]);
        assert.isString(jobBody().tier);
      });
  });
  it("does not send local authentication to a different upload origin", async function () {
    const normal = route;
    route = (url, init) =>
      url.endsWith("/v1/uploads")
        ? json({
            id: "up",
            status: "pending",
            upload_url: "https://storage.example/upload",
            upload_method: "PUT",
            upload_headers: { "X-Upload": "signed" },
          })
        : url.includes("storage.example")
          ? new Response(null, { status: 204 })
          : normal(url, init);
    await parse();
    assert.deepEqual(
      calls.find((c) => c.url.includes("storage.example"))!.init.headers,
      { "X-Upload": "signed" },
    );
  });
  it("accepts an already completed upload without uploading bytes", async function () {
    const normal = route;
    route = (url, init) =>
      url.endsWith("/v1/uploads")
        ? json({ id: "up", status: "completed", file: { id: "input-1" } })
        : normal(url, init);
    await parse();
    assert.isFalse(calls.some((c) => c.init.method === "PUT"));
  });
  for (const state of ["failed", "partial", "canceled", "unknown"])
    it(`rejects terminal or unknown job state ${state} without publishing`, async function () {
      const normal = route;
      route = (url, init) =>
        url.includes("/parse/jobs")
          ? json({
              ...complete,
              status: state,
              files: [{ error: { message: "Cannot parse this PDF" } }],
            })
          : normal(url, init);
      await rejects(parse(), state);
      assert.isFalse(calls.some((c) => c.url.includes("/files/")));
      // A terminal job needs no cleanup; an unrecognised one is still running.
      assert.equal(deletes(), state === "unknown" ? 1 : 0);
    });
  it("polls queued and running jobs to completion", async function () {
    this.timeout(10000);
    const normal = route;
    let polls = 0;
    route = (url, init) =>
      url.includes("/parse/jobs")
        ? json({
            ...complete,
            status:
              polls++ === 0 ? "queued" : polls === 2 ? "running" : "completed",
          })
        : normal(url, init);
    assert.include((await parse()).mdContent, "Second page");
    assert.equal(polls, 3);
  });
  it("cancels the server job when the user pauses while queued", async function () {
    const normal = route;
    const controller = new AbortController();
    route = (url, init) => {
      if (url.includes("/parse/jobs")) {
        if (init.method !== "DELETE") setTimeout(() => controller.abort(), 10);
        return json({
          ...complete,
          status: init.method === "DELETE" ? "canceled" : "queued",
        });
      }
      return normal(url, init);
    };
    await rejects(parse(controller.signal), "Cancelled");
    assert.isTrue(
      calls.some(
        (c) => c.url.endsWith("/jobs/job-1") && c.init.method === "DELETE",
      ),
    );
  });
  it("cancels while reading a response body", async function () {
    const controller = new AbortController();
    route = () =>
      ({ ok: true, status: 200, json: () => new Promise(() => {}) }) as any;
    const pending = detectMineruLocalService(base, "", controller.signal);
    controller.abort();
    await rejects(pending, "Cancelled");
  });
  for (const broken of [
    { ...complete, files: [] },
    { ...complete, files: [{ ...complete.files[0], file_id: "other" }] },
    { ...complete, files: [{ ...complete.files[0], output_files: {} }] },
  ])
    it("rejects a completed job with missing or mismatched output", async function () {
      const normal = route;
      route = (url, init) =>
        url.includes("/parse/jobs") ? json(broken) : normal(url, init);
      await rejects(parse(), "MinerU");
    });
  it("rejects output download failure after bounded retries", async function () {
    const normal = route;
    route = (url, init) =>
      url.includes("/files/") ? json({}, 503) : normal(url, init);
    await rejects(parse(), "download failed: HTTP 503");
    assert.lengthOf(
      calls.filter((c) => c.url.includes("/files/")),
      3,
    );
    // The job completed; its result stays on the server for inspection.
    assert.equal(deletes(), 0);
  });
  it("retries a transient result download failure and then succeeds", async function () {
    const normal = route;
    let downloads = 0;
    route = (url, init) =>
      url.includes("/files/") && ++downloads === 1
        ? json({}, 502)
        : normal(url, init);
    assert.include((await parse()).mdContent, "Second page");
    assert.equal(downloads, 2);
  });
  it("does not retry a result download rejected with HTTP 404", async function () {
    const normal = route;
    route = (url, init) =>
      url.includes("/files/") ? json({}, 404) : normal(url, init);
    await rejects(parse(), "download failed: HTTP 404");
    assert.lengthOf(
      calls.filter((c) => c.url.includes("/files/")),
      1,
    );
  });
  it("keeps polling when a status request times out while the server loads models", async function () {
    setMineruV1TimingForTests({ pollDelay: () => 1, requestTimeout: 20 });
    const progress: string[] = [];
    routeStatus((count) =>
      count === 1 ? new Promise<Response>(() => {}) : json(complete),
    );
    assert.include(
      (await parse(undefined, (m) => progress.push(m))).mdContent,
      "Second page",
    );
    assert.isTrue(
      progress.some((m) =>
        m.startsWith("Local MinerU is busy and not responding"),
      ),
    );
    assert.equal(deletes(), 0);
  });
  for (const transient of [
    () => {
      throw new TypeError("fetch failed");
    },
    () => json({ error: { message: "Loading models" } }, 503),
    () => json({}, 429),
    () => new Response("<html>starting</html>"),
  ])
    it("keeps polling through a transient status failure", async function () {
      routeStatus((count) => (count === 1 ? transient() : json(complete)));
      assert.include((await parse()).mdContent, "Second page");
    });
  it("fails and cancels the job after ten minutes without a status response", async function () {
    let clock = 0;
    setMineruV1TimingForTests({ pollDelay: () => 1, now: () => clock });
    routeStatus(() => {
      clock += 4 * 60_000;
      throw new TypeError("fetch failed");
    });
    await rejects(parse(), "stopped responding");
    assert.equal(clock, 12 * 60_000);
    assert.equal(deletes(), 1);
  });
  for (const status of [503, 429])
    it(`says the server kept returning HTTP ${status} after ten minutes of errors`, async function () {
      let clock = 0;
      setMineruV1TimingForTests({ pollDelay: () => 1, now: () => clock });
      routeStatus(() => {
        clock += 4 * 60_000;
        return json({ error: { message: "Loading models" } }, status);
      });
      await rejects(
        parse(),
        `kept returning errors (HTTP ${status}) for 10 minutes`,
      );
      assert.equal(deletes(), 1);
    });
  it("resets the no-response window after a successful status response", async function () {
    let clock = 0;
    setMineruV1TimingForTests({ pollDelay: () => 1, now: () => clock });
    routeStatus((count) => {
      clock += 4 * 60_000;
      if (count === 5) return json(complete);
      if (count === 3) return json({ ...complete, status: "running" });
      throw new TypeError("fetch failed");
    });
    assert.include((await parse()).mdContent, "Second page");
  });
  it("fails and cancels the job when it exceeds the overall job timeout", async function () {
    let clock = 0;
    setMineruV1TimingForTests({ pollDelay: () => 1, now: () => clock });
    routeStatus(() => {
      clock += 30 * 60_000;
      return json({ ...complete, status: "running" });
    });
    await rejects(parse(), "timed out");
    assert.equal(deletes(), 1);
  });
  for (const [status, text, deleted] of [
    [401, "rejected the API key", 0],
    [403, "rejected the API key", 0],
    [404, "no longer has this job", 0],
  ] as const)
    it(`treats status HTTP ${status} as fatal`, async function () {
      routeStatus(() => json({ detail: "nope" }, status));
      await rejects(parse(), text);
      assert.equal(
        calls.filter(
          (c) => c.url.endsWith("/jobs/job-1") && c.init.method !== "DELETE",
        ).length,
        1,
      );
      assert.equal(deletes(), deleted);
    });
  it("cancels promptly while waiting to retry an unresponsive server", async function () {
    setMineruV1TimingForTests({ pollDelay: () => 60_000 });
    const controller = new AbortController();
    routeStatus(() => {
      throw new TypeError("fetch failed");
    });
    // The first status GET happens after one poll delay; abort mid-wait.
    const started = Date.now();
    setTimeout(() => controller.abort(), 20);
    try {
      await parse(controller.signal);
      assert.fail("Expected cancellation");
    } catch (error) {
      assert.instanceOf(error, MineruCancelledError);
    }
    assert.isBelow(Date.now() - started, 2000);
    assert.equal(deletes(), 1);
  });
  it("cancels promptly while a status request is hanging", async function () {
    const controller = new AbortController();
    routeStatus(() => {
      setTimeout(() => controller.abort(), 10);
      return new Promise<Response>(() => {});
    });
    try {
      await parse(controller.signal);
      assert.fail("Expected cancellation");
    } catch (error) {
      assert.instanceOf(error, MineruCancelledError);
    }
    assert.equal(deletes(), 1);
  });
  it("reports the original failure when the cleanup DELETE fails", async function () {
    let clock = 0;
    setMineruV1TimingForTests({ pollDelay: () => 1, now: () => clock });
    routeStatus(
      () => {
        clock += 11 * 60_000;
        throw new TypeError("fetch failed");
      },
      () => {
        throw new TypeError("fetch failed");
      },
    );
    await rejects(parse(), "stopped responding");
    assert.equal(deletes(), 1);
  });
  it("preserves high effort, image analysis and the external VLM URL on legacy servers", async function () {
    let body: FormData;
    route = (url, init) => {
      if (url.endsWith("/v1/health")) return json({}, 404);
      if (url.endsWith("/health"))
        return json({ status: "healthy", version: "3.4.5" });
      body = init.body as FormData;
      return new Response(createMineruV1Zip());
    };
    await parsePdfWithMineruLocal(
      "paper.pdf",
      base,
      "hybrid-http-client",
      undefined,
      undefined,
      false,
      options,
    );
    assert.equal(body!.get("backend"), "hybrid-http-client");
    assert.equal(body!.get("effort"), "high");
    assert.equal(body!.get("image_analysis"), "true");
    assert.equal(body!.get("server_url"), options.serverUrl);
  });
  for (const status of [0, 429, 500, 503])
    it(`rejects cloud connection HTTP ${status} instead of reporting success`, async function () {
      (globalThis as any).Zotero.HTTP = {
        request: async () => ({
          status,
          responseText: JSON.stringify({ code: -1, msg: "error" }),
        }),
      };
      await rejects(testMineruConnection("cloud-key"), `HTTP ${status}`);
      assert.isEmpty(calls);
    });
  // Unknown states and status HTTP 429 are transient; see mineruCloudClient.test.ts.
  for (const scenario of ["failed", "denied", "pending-done"] as const) {
    it(`reports cloud ${scenario} through the public parsing workflow`, async function () {
      // The client waits 3 s between status polls; skip the real wait.
      const restoreWaits = shortenLongWaits();
      try {
        let polls = 0;
        (globalThis as any).Zotero.HTTP = {
          request: async (method: string) => ({
            status: method === "GET" && scenario === "denied" ? 403 : 200,
            responseText: JSON.stringify(
              method === "POST"
                ? {
                    code: 0,
                    data: {
                      batch_id: "batch",
                      file_urls: ["fixture://storage/upload"],
                    },
                  }
                : {
                    code: 0,
                    data: {
                      extract_result: [
                        {
                          state:
                            scenario === "pending-done"
                              ? ++polls === 1
                                ? "pending"
                                : "done"
                              : scenario,
                          err_msg:
                            "Bad PDF at https://signed.example/result?secret=xyz",
                          full_zip_url: "fixture://storage/result",
                        },
                      ],
                    },
                  },
            ),
          }),
        };
        route = (_url, init) =>
          init.method === "PUT"
            ? new Response(null, { status: 200 })
            : new Response(createMineruV1Zip());
        const messages: string[] = [];
        const result = await parsePdfWithMineruCloud(
          "paper.pdf",
          "cloud-key",
          "pipeline",
          (stage) => messages.push(stage),
        );
        if (scenario === "pending-done") {
          assert.isNotNull(result);
          assert.isTrue(
            messages.some((message) =>
              message.includes("Waiting for MinerU to start"),
            ),
          );
        } else {
          assert.isNull(result);
          const last = messages.at(-1)!;
          assert.include(
            last,
            scenario === "failed" ? "Bad PDF at [URL]" : "HTTP 403",
          );
          assert.notInclude(last, "secret=xyz");
        }
      } finally {
        restoreWaits();
      }
    });
  }
  it("rejects cloud business errors even when HTTP succeeds", async function () {
    (globalThis as any).Zotero.HTTP = {
      request: async () => ({
        status: 200,
        responseText: JSON.stringify({ code: -1, msg: "Server unavailable" }),
      }),
    };
    await rejects(testMineruConnection("key"), "Server unavailable");
  });
  it("rejects a malformed cloud connection response", async function () {
    (globalThis as any).Zotero.HTTP = {
      request: async () => ({
        status: 200,
        responseText: "<html>login</html>",
      }),
    };
    await rejects(
      testMineruConnection("key"),
      "invalid connection-test response",
    );
  });
});

describe("MinerU V1 tier resolution", function () {
  const all = ["flash", "basic", "standard", "advanced"];
  for (const [requested, offered, tier, fallbackFrom] of [
    ["auto", ["flash"], "flash", undefined],
    ["auto", ["flash", "basic"], "basic", undefined],
    ["auto", all, "standard", undefined],
    ["auto", ["advanced"], "advanced", undefined],
    ["standard", ["flash"], "flash", "standard"],
    ["advanced", ["flash", "basic", "standard"], "standard", "advanced"],
    ["basic", ["standard", "advanced"], "standard", "basic"],
    ["flash", ["basic", "advanced"], "basic", "flash"],
    ["flash", ["flash"], "flash", undefined],
    ["advanced", all, "advanced", undefined],
    ["basic", ["flash", "basic"], "basic", undefined],
  ] as const)
    it(`resolves ${requested} with [${offered.join(", ")}] to ${tier}`, function () {
      const resolved = resolveMineruV1Tier(requested, [...offered]);
      assert.deepEqual(
        resolved,
        fallbackFrom ? { tier, fallbackFrom } : { tier },
      );
    });
});

describe("MinerU V1 result conversion", function () {
  it("preserves figures, captions, tables and page references in the existing manifest", function () {
    const result = normalizeMineruV1Zip(createMineruV1Zip());
    const content = JSON.parse(
      new TextDecoder().decode(
        result.files.find((f) => f.relativePath === "content_list.json")!.data,
      ),
    );
    const manifest = buildManifest(result.mdContent, content, 2);
    assert.equal(content[1].page_idx, 0);
    assert.equal(content.at(-1).page_idx, 1);
    assert.equal(
      content.find((c: any) => c.type === "table").table_body,
      "<table><tr><td>42</td></tr></table>",
    );
    assert.equal(manifest.sections[0].figures[0].path, "images/figure.png");
    assert.equal(manifest.sections[0].figures[0].page, 0);
    assert.lengthOf(manifest.sections[0].tables, 1);
  });
  it("feeds the existing long-PDF merger with page offsets and unique image paths", function () {
    const result = normalizeMineruV1Zip(createMineruV1Zip());
    const merged = mergeMineruChunkResults(
      [0, 1].map((index) => ({
        range: {
          index,
          startPage: index * 200 + 1,
          endPage: index === 0 ? 200 : 202,
          total: 202,
        },
        result,
      })),
    );
    const content = JSON.parse(
      new TextDecoder().decode(
        merged.files.find((f) => f.relativePath === "content_list.json")!.data,
      ),
    );
    assert.equal(content.at(-1).page_idx, 201);
    assert.include(merged.mdContent, "images/chunk-002/images/figure.png");
  });
  it("maps MinerU 4.0.10 equation and page-furniture blocks to their own types", function () {
    const structured = structuredClone(mineruV1StructuredFixture) as any;
    structured.pages[0].blocks.push(
      {
        type: "equation",
        content: "E=mc^2",
        image_source: "images/figure.png",
      },
      { type: "equation", content: "a+b" },
      { type: "header", content: "Journal of Tests" },
      { type: "footer", content: "Copyright" },
      { type: "page_number", content: "1" },
      { type: "page_footnote", content: "1 Corresponding author." },
      { type: "aside_text", content: "arXiv:2601.00001" },
    );
    const result = normalizeMineruV1Zip(createMineruV1Zip(structured));
    const content = JSON.parse(
      new TextDecoder().decode(
        result.files.find((f) => f.relativePath === "content_list.json")!.data,
      ),
    );
    const byText = (text: string) =>
      content.find((entry: any) => entry.text === text);
    assert.deepInclude(byText("E=mc^2"), {
      type: "equation",
      img_path: "images/figure.png",
    });
    assert.equal(byText("a+b").type, "equation");
    assert.notProperty(byText("a+b"), "img_path");
    assert.equal(byText("x=1").type, "equation");
    for (const [text, type] of [
      ["Journal of Tests", "header"],
      ["Copyright", "footer"],
      ["1", "page_number"],
      ["1 Corresponding author.", "page_footnote"],
      ["arXiv:2601.00001", "aside_text"],
    ])
      assert.equal(byText(text).type, type);
    assert.equal(byText("A reproducible extraction.").type, "text");
    // Page furniture never opens a section or counts as a figure.
    const manifest = buildManifest(result.mdContent, content, 2);
    assert.lengthOf(manifest.sections[0].figures, 1);
  });
  it("rejects missing referenced images", function () {
    const broken = structuredClone(mineruV1StructuredFixture);
    broken.pages[0].blocks[2].image_source = "images/missing.png";
    assert.throws(
      () => normalizeMineruV1Zip(createMineruV1Zip(broken)),
      "missing an image",
    );
  });
  it("rejects unsafe archive paths", function () {
    assert.throws(
      () =>
        normalizeMineruV1Zip(
          createMineruV1Zip(undefined, {
            "../escape.png": new Uint8Array([1]),
          }),
        ),
      "Unsafe path",
    );
  });
  it("rejects incompatible structured content instead of fabricating metadata", function () {
    assert.throws(
      () =>
        normalizeMineruV1Zip(
          createMineruV1Zip({ pages: [{ page_idx: 0, items: [] }] }),
        ),
      "page metadata",
    );
  });
});
