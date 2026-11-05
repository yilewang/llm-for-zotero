import { assert } from "chai";
import {
  detectMineruLocalService,
  mineruErrorDetail,
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
import { zipSync } from "fflate";

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
      service: {
        api: "v1",
        protocol: "jobs",
        version: "4.0.6",
        tiers: ["standard"],
      },
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
      protocol: "jobs",
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
        service: { api: "v1", protocol: "jobs", version: "4.0.10", tiers },
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
  describe("MinerU 4.1 Tasks protocol", function () {
    // Recorded shapes from the MinerU 4.1.7 Tasks docs and HealthFeatures.
    const tasksHealth = {
      status: "ok",
      version: "4.1.7",
      features: {
        webhook: false,
        task_output_formats: ["default", "docx", "html", "latex"],
        sources: ["upload", "url"],
      },
    };
    const taskPath = "/v1/tasks/job%2F1";
    const uploadUrl = `${base}${taskPath}/uploads/file-1`;
    const resultUrl = `${base}/v1/files/file-1/content`;
    const upload = (url = uploadUrl, headers: unknown = undefined) => ({
      url,
      headers: headers ?? { "Content-Type": "application/octet-stream" },
      expires_at: 1800003600,
    });
    const receipt = (file: Record<string, unknown> = {}) => ({
      task_id: "job/1",
      status: "waiting-file",
      files: [
        {
          file_id: "file-1",
          file_name: "test.pdf",
          status: "waiting-file",
          upload: upload(),
          ...file,
        },
      ],
    });
    const snapshot = (
      status: string,
      file: Record<string, unknown> = {},
      parent: Record<string, unknown> = {},
    ) => ({
      task_id: "job/1",
      status,
      created_at: "2026-10-28T00:00:00Z",
      output_formats: ["default"],
      progress: {
        completed: status === "completed" ? 1 : 0,
        failed: 0,
        total: 1,
      },
      files: [
        {
          file_id: "file-1",
          file_name: "test.pdf",
          status,
          bytes: 9,
          ...(status === "completed"
            ? {
                parse: { tier: "standard", parser_version: "4.1.7" },
                result_url: resultUrl,
              }
            : {}),
          ...file,
        },
      ],
      ...parent,
    });
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/e8AAAAASUVORK5CYII=",
      ),
      (char) => char.charCodeAt(0),
    );
    /** The 4.1 `default` ZIP: fixed entry order, an empty `images/` entry, 4.1 image names. */
    const createTasksZip = () => {
      const encode = (text: string) => new TextEncoder().encode(text);
      const structured = {
        pages: [
          {
            page_idx: 0,
            blocks: [
              { type: "paragraph_title", level: 2, content: "Results" },
              { type: "text", content: "A reproducible extraction." },
              {
                type: "image",
                content: "",
                image_source: "images/page_0_image_2.png",
                captions: [{ content: "Figure 1. Test image." }],
                footnotes: [],
              },
              {
                type: "table",
                content: "<table><tr><td>42</td></tr></table>",
                image_source: "images/page_0_table_3.png",
                captions: [{ content: "Table 1. Counts." }],
                footnotes: [],
              },
            ],
          },
          { page_idx: 1, blocks: [{ type: "text", content: "Second page." }] },
        ],
        metadata: { producer: { name: "mineru", version: "4.1.7" } },
        is_full_document: true,
      };
      return zipSync({
        "markdown.md": encode(
          "## Results\n\nA reproducible extraction.\n\n![](images/page_0_image_2.png)\n\nFigure 1. Test image.\n\n<table><tr><td>42</td></tr></table>\n\nTable 1. Counts.\n\nSecond page.",
        ),
        "middle_json.json": encode("{}"),
        "structured_content.json": encode(JSON.stringify(structured)),
        "images/": new Uint8Array(0),
        "images/page_0_image_2.png": png,
        "images/page_0_table_3.png": png,
      });
    };
    const service = {
      api: "v1",
      protocol: "tasks",
      version: "4.1.7",
      tiers: ["standard"],
    } as const;
    const parseTasks = (
      signal?: AbortSignal,
      report: (m: string) => void = () => {},
    ) =>
      parseMineruV1({
        baseUrl: base,
        fileName: "test.pdf",
        pdfBytes: new TextEncoder().encode("PDF bytes"),
        service: { ...service, tiers: [...service.tiers] },
        options,
        forceOcr: true,
        report,
        signal,
      });
    const cancels = () =>
      calls.filter((c) => c.url === `${base}${taskPath}/cancel`);
    const puts = () => calls.filter((c) => c.init.method === "PUT");
    const polls = () =>
      calls.filter(
        (c) => c.url === `${base}${taskPath}` && c.init.method === "GET",
      );
    const downloads = () => calls.filter((c) => c.url.includes("/v1/files/"));
    let created: () => Response;
    let poll: (count: number) => Promise<Response> | Response;
    let onCancel: () => Response;
    let onPut: () => Response;
    let onDownload: (count: number) => Promise<Response> | Response;
    beforeEach(function () {
      created = () => json(receipt(), 202);
      poll = () => json(snapshot("completed"));
      onCancel = () =>
        json({
          task_id: "job/1",
          status: "canceled",
          finished_at: "2026-10-28T00:00:05Z",
          files: [
            { file_id: "file-1", file_name: "test.pdf", status: "canceled" },
          ],
        });
      onPut = () =>
        json({ task_id: "job/1", file_id: "file-1", status: "pending" });
      onDownload = () => new Response(createTasksZip());
      let pollCount = 0;
      let downloadCount = 0;
      route = (url, init) => {
        if (url.endsWith("/v1/health")) return json(tasksHealth);
        if (url.endsWith("/v1/tiers"))
          return json({ data: [{ id: "standard" }] });
        if (url === `${base}/v1/tasks` && init.method === "POST")
          return created();
        if (init.method === "PUT") return onPut();
        if (url === `${base}${taskPath}/cancel`) return onCancel();
        if (url === `${base}${taskPath}`) return poll(++pollCount);
        if (url.includes("/v1/files/") || url.includes("storage.example"))
          return onDownload(++downloadCount);
        throw new Error(`Unexpected request ${init.method} ${url}`);
      };
    });

    it("detects MinerU 4.1 as the Tasks protocol", async function () {
      assert.deepEqual(await detectMineruLocalService(base, options.apiKey), {
        api: "v1",
        protocol: "tasks",
        version: "4.1.7",
        tiers: ["standard"],
      });
    });
    it("names the MinerU version when the V1 features match neither protocol", async function () {
      route = (url) =>
        url.endsWith("/v1/health")
          ? json({
              status: "ok",
              version: "4.2.0",
              features: { sources: ["url"], task_output_formats: ["html"] },
            })
          : json({ data: [{ id: "standard" }] });
      await rejects(
        detectMineruLocalService(base),
        "MinerU 4.2.0 uses a V1 API that this plugin does not support",
      );
      assert.lengthOf(calls, 1);
    });
    it("reports the health error code after a failed model preload", async function () {
      route = () =>
        json(
          {
            error: {
              code: "model_preload_failed",
              message: "CUDA out of memory",
            },
          },
          503,
        );
      await rejects(
        detectMineruLocalService(base),
        "HTTP 503: model_preload_failed: CUDA out of memory",
      );
    });
    it("creates a task, uploads once, polls each state and normalizes the 4.1 ZIP", async function () {
      const states = ["waiting-file", "pending", "running", "completed"];
      // A later snapshot that still shows an upload action must not repeat the PUT.
      poll = (count) =>
        json(
          snapshot(states[count - 1], count === 1 ? { upload: upload() } : {}),
        );
      const progress: string[] = [];
      const result = await parseTasks(undefined, (m) => progress.push(m));

      const create = calls.find((c) => c.url === `${base}/v1/tasks`)!;
      assert.equal(create.init.method, "POST");
      assert.deepEqual(JSON.parse(create.init.body as string), {
        files: [{ file_name: "test.pdf", bytes: 9 }],
        tier: "standard",
        ocr_mode: "ocr",
        output_formats: ["default"],
      });
      assert.lengthOf(puts(), 1);
      assert.equal(puts()[0].url, uploadUrl);
      assert.deepEqual(puts()[0].init.headers, {
        Authorization: "Bearer local-secret",
        "Content-Type": "application/octet-stream",
      });
      assert.deepEqual(
        new Uint8Array(puts()[0].init.body as ArrayBuffer),
        new TextEncoder().encode("PDF bytes"),
      );
      assert.lengthOf(polls(), 4);
      assert.isBelow(calls.indexOf(create), calls.indexOf(puts()[0]));
      assert.isBelow(calls.indexOf(puts()[0]), calls.indexOf(polls()[0]));
      assert.deepEqual(
        downloads().map((c) => c.url),
        [resultUrl],
      );
      assert.equal(
        (downloads()[0].init.headers as Record<string, string>).Authorization,
        "Bearer local-secret",
      );
      assert.isEmpty(cancels());
      for (const label of [
        "Waiting for local MinerU to receive the PDF (standard)…",
        "Waiting for local MinerU to start (standard)…",
        "Processing on local MinerU (standard)…",
      ])
        assert.isTrue(
          progress.some((m) => m.startsWith(label)),
          `${label}\n${progress.join("\n")}`,
        );
      assert.include(progress.at(-1), "Done");
      assert.include(result.mdContent, "Second page.");
      assert.isTrue(
        result.files.some(
          (f) => f.relativePath === "images/page_0_image_2.png",
        ),
      );
    });
    it("runs the public local entry point against a 4.1 server", async function () {
      const progress: string[] = [];
      const result = await parsePdfWithMineruLocal(
        "paper.pdf",
        base,
        "pipeline",
        (stage) => progress.push(stage),
        undefined,
        false,
        options,
      );
      assert.include(result!.mdContent, "Second page.");
      const body = JSON.parse(
        calls.find((c) => c.url === `${base}/v1/tasks`)!.init.body as string,
      );
      assert.equal(body.ocr_mode, "auto");
      assert.match(body.files[0].file_name, /\.pdf$/);
      assert.isFalse(calls.some((c) => c.url.includes("/parse/jobs")));
      assert.include(progress.at(-1), "Done");
    });
    for (const [name, file] of [
      ["a cache hit", { status: "pending", upload: undefined }],
      ["server-side confirmation", { upload: undefined }],
    ] as const)
      it(`skips the PUT and keeps polling on ${name}`, async function () {
        created = () => json(receipt(file), 202);
        poll = (count) => json(snapshot(count === 1 ? "running" : "completed"));
        assert.include((await parseTasks()).mdContent, "Second page.");
        assert.isEmpty(puts());
        assert.lengthOf(polls(), 2);
      });
    it("sends the upload's Content-Type and ignores the JSON PUT receipt", async function () {
      onPut = () =>
        json({ task_id: "job/1", file_id: "file-1", status: "running" });
      poll = () => json(snapshot("completed"));
      await parseTasks();
      assert.equal(
        (puts()[0].init.headers as Record<string, string>)["Content-Type"],
        "application/octet-stream",
      );
      assert.lengthOf(polls(), 1);
    });
    it("does not send local authentication to a different upload or result origin", async function () {
      created = () =>
        json(
          receipt({
            upload: upload("https://storage.example/upload?sig=1", {
              "Content-Type": "application/octet-stream",
            }),
          }),
          202,
        );
      onPut = () => new Response(null, { status: 200 });
      poll = () =>
        json(
          snapshot("completed", {
            result_url: "https://storage.example/result.zip?sig=2",
          }),
        );
      await parseTasks();
      assert.deepEqual(puts()[0].init.headers, {
        "Content-Type": "application/octet-stream",
      });
      const download = calls.find((c) => c.url.includes("result.zip"))!;
      assert.deepEqual(download.init.headers, {});
    });
    it("resolves a relative result URL against the API base", async function () {
      poll = () =>
        json(snapshot("completed", { result_url: "/v1/files/file-1/content" }));
      await parseTasks();
      assert.deepEqual(
        downloads().map((c) => c.url),
        [resultUrl],
      );
    });
    for (const [state, file, parent, expected, cancelled] of [
      [
        "failed",
        {
          error: { code: "parse_failed", message: "Cannot parse this PDF" },
        },
        {},
        "Local MinerU task failed: parse_failed: Cannot parse this PDF",
        0,
      ],
      [
        "partial",
        {
          status: "failed",
          error: {
            code: "result_packaging_failed",
            message: "Export failed",
          },
        },
        {},
        "Local MinerU task partial: result_packaging_failed: Export failed",
        0,
      ],
      [
        "canceled",
        {},
        { error: { code: "task_canceled", message: "Canceled by user" } },
        "Local MinerU task canceled: task_canceled: Canceled by user",
        0,
      ],
      ["unknown", {}, {}, "MinerU returned an unknown task status: unknown", 1],
    ] as const)
      it(`rejects task state ${state} with its error code and without publishing`, async function () {
        poll = () => json(snapshot(state, file, parent));
        await rejects(parseTasks(), expected);
        assert.isEmpty(downloads());
        // A terminal task needs no cleanup; an unrecognised one may still run.
        assert.lengthOf(cancels(), cancelled);
      });
    it("rejects a completed file without a result URL", async function () {
      poll = () => json(snapshot("completed", { result_url: undefined }));
      await rejects(parseTasks(), "MinerU completed without a result URL");
      assert.isEmpty(downloads());
      assert.isEmpty(cancels());
    });
    for (const [name, broken, text] of [
      ["task id", { task_id: "other" }, "different task id"],
      [
        "file id",
        { files: [{ file_id: "other", status: "running" }] },
        "different task file",
      ],
      ["file count", { files: [] }, "different task file"],
    ] as const)
      it(`rejects a snapshot with a mismatched ${name}`, async function () {
        poll = () => json({ ...snapshot("running"), ...broken });
        await rejects(parseTasks(), text);
        assert.isEmpty(downloads());
      });
    for (const [name, files, text] of [
      ["no file", [], "MinerU task must contain exactly one file"],
      [
        "two files",
        [receipt().files[0], receipt().files[0]],
        "MinerU task must contain exactly one file",
      ],
      [
        "no file id",
        [{ ...receipt().files[0], file_id: undefined }],
        "input file id",
      ],
    ] as const)
      it(`cancels the created task when the receipt has ${name}`, async function () {
        created = () => json({ ...receipt(), files }, 202);
        await rejects(parseTasks(), text);
        assert.isEmpty(puts());
        assert.lengthOf(cancels(), 1);
        assert.equal(cancels()[0].init.method, "POST");
        assert.isUndefined(cancels()[0].init.body);
      });
    it("sends no cancel when the receipt has no task id", async function () {
      created = () => json({ ...receipt(), task_id: undefined }, 202);
      await rejects(parseTasks(), "task id");
      assert.isEmpty(puts());
      assert.isEmpty(calls.filter((c) => c.url.includes("/cancel")));
    });
    it("downloads a completed file under a waiting-file or canceled parent without cancelling", async function () {
      for (const parent of ["waiting-file", "canceled"]) {
        calls.length = 0;
        poll = () => json(snapshot("completed", {}, { status: parent }));
        const result = await parseTasks();
        assert.include(result.mdContent, "Second page.");
        assert.deepEqual(
          downloads().map((c) => c.url),
          [resultUrl],
        );
        assert.isEmpty(cancels());
      }
    });
    it("cancels the task with POST and no body when the user pauses while pending", async function () {
      const controller = new AbortController();
      poll = () => {
        setTimeout(() => controller.abort(), 10);
        return json(snapshot("pending"));
      };
      await rejects(parseTasks(controller.signal), "Cancelled");
      assert.lengthOf(cancels(), 1);
      assert.equal(cancels()[0].init.method, "POST");
      assert.isUndefined(cancels()[0].init.body);
    });
    it("ignores a 409 task_already_terminal cancel response", async function () {
      const controller = new AbortController();
      poll = () => {
        setTimeout(() => controller.abort(), 10);
        return json(snapshot("running"));
      };
      onCancel = () =>
        json(
          {
            error: {
              code: "task_already_terminal",
              message: "Task is canceled",
            },
          },
          409,
        );
      try {
        await parseTasks(controller.signal);
        assert.fail("Expected cancellation");
      } catch (error) {
        assert.instanceOf(error, MineruCancelledError);
      }
      assert.lengthOf(cancels(), 1);
    });
    for (const [status, text] of [
      [404, "Local MinerU no longer has this task (HTTP 404)"],
      [401, "Local MinerU rejected the API key while checking the task"],
    ] as const)
      it(`treats status HTTP ${status} as fatal without cancelling`, async function () {
        poll = () =>
          json(
            {
              error: {
                code: status === 404 ? "task_not_found" : "invalid_api_key",
                message: "nope",
              },
            },
            status,
          );
        await rejects(parseTasks(), text);
        assert.lengthOf(polls(), 1);
        assert.isEmpty(cancels());
      });
    it("cancels the task when it exceeds the overall timeout", async function () {
      let clock = 0;
      setMineruV1TimingForTests({ pollDelay: () => 1, now: () => clock });
      poll = () => {
        clock += 30 * 60_000;
        return json(snapshot("running"));
      };
      await rejects(parseTasks(), "Local MinerU task timed out");
      assert.lengthOf(cancels(), 1);
    });
    it("retries a transient result download failure and then succeeds", async function () {
      onDownload = (count) =>
        count === 1 ? json({}, 503) : new Response(createTasksZip());
      assert.include((await parseTasks()).mdContent, "Second page");
      assert.lengthOf(downloads(), 2);
    });
    it("does not retry a result download rejected with HTTP 404", async function () {
      onDownload = () => json({}, 404);
      await rejects(parseTasks(), "download failed: HTTP 404");
      assert.lengthOf(downloads(), 1);
      assert.isEmpty(cancels());
    });
    for (const [name, link, text] of [
      [
        "a non-HTTP upload URL",
        upload("ftp://127.0.0.1/upload"),
        "invalid upload URL",
      ],
      [
        "upload URL credentials",
        upload("http://user:pass@127.0.0.1:8000/upload"),
        "invalid upload URL",
      ],
      ["a missing upload URL", { headers: {} }, "missing upload URL"],
      [
        "non-string upload headers",
        upload(uploadUrl, { "Content-Type": 1 }),
        "invalid upload headers",
      ],
      [
        "list upload headers",
        upload(uploadUrl, ["application/octet-stream"]),
        "invalid upload headers",
      ],
    ] as const)
      it(`rejects ${name} without uploading and cancels the task`, async function () {
        created = () => json(receipt({ upload: link }), 202);
        await rejects(parseTasks(), text);
        assert.isEmpty(puts());
        assert.lengthOf(cancels(), 1);
      });
    for (const resultLink of [
      "file:///etc/passwd",
      "http://user:pass@127.0.0.1:8000/v1/files/file-1/content",
    ])
      it(`rejects an invalid result URL (${resultLink.split(":")[0]})`, async function () {
        poll = () => json(snapshot("completed", { result_url: resultLink }));
        await rejects(parseTasks(), "MinerU returned an invalid result URL");
        assert.isEmpty(downloads());
      });
    it("rejects a byte upload failure and cancels the task", async function () {
      onPut = () =>
        json({ error: { code: "upload_expired", message: "x" } }, 410);
      await rejects(parseTasks(), "MinerU byte upload failed: HTTP 410");
      assert.isEmpty(polls());
      assert.lengthOf(cancels(), 1);
    });
    it("reports a create HTTP 400 with its error code and does not upload", async function () {
      created = () =>
        json(
          {
            error: {
              code: "invalid_request",
              message: "Extra inputs are not permitted",
              param: "files.0.file_id",
            },
          },
          400,
        );
      await rejects(
        parseTasks(),
        "Local MinerU /v1/tasks: HTTP 400: invalid_request: Extra inputs are not permitted",
      );
      assert.isEmpty(puts());
      assert.isEmpty(polls());
      assert.isEmpty(cancels());
    });
  });
  describe("error detail", function () {
    it("prefixes a non-empty error code and keeps redaction", function () {
      assert.equal(
        mineruErrorDetail({
          error: {
            code: "invalid_request",
            message:
              "Bad tier at https://signed.example/x?sig=1 with Bearer abc",
            param: "tier",
          },
        }),
        "invalid_request: Bad tier at [URL] with Bearer [redacted]",
      );
    });
    for (const code of [null, "", 7])
      it(`omits a ${JSON.stringify(code)} error code`, function () {
        assert.equal(
          mineruErrorDetail({ error: { code, message: "Bad tier" } }),
          "Bad tier",
        );
      });
    it("prints a trimmed error code", function () {
      assert.equal(
        mineruErrorDetail({ error: { code: "  bad_tier ", message: "Bad" } }),
        "bad_tier: Bad",
      );
    });
    it("ignores a top-level cloud code", function () {
      assert.equal(mineruErrorDetail({ code: -1, msg: "error" }), "error");
    });
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
