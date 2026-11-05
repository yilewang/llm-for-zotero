import { appLogger } from "../core/logging";
import { MineruCancelledError } from "./mineruErrors";
import {
  normalizeMineruLocalApiBase,
  type MineruLocalOptions,
  type MineruLocalTier,
} from "./mineruConfig";
import { normalizeMineruV1Zip } from "./mineruV1Result";

/**
 * `jobs` is the MinerU 4.0 upload + parse-jobs protocol; `tasks` is the
 * MinerU 4.1 Tasks protocol. Both share tiers and the V1 settings.
 */
export type MineruLocalService =
  | { api: "legacy"; version: string }
  | {
      api: "v1";
      protocol: "jobs" | "tasks";
      version: string;
      tiers: string[];
    };

type Json = Record<string, any>;
const REQUEST_TIMEOUT = 60_000;
const JOB_TIMEOUT = 2 * 60 * 60_000;
const TERMINAL_JOB_STATES = ["completed", "partial", "failed", "canceled"];

// MinerU 4 stops answering HTTP while it loads OCR models on first use, so
// status polling tolerates silence up to `noResponseTimeout`.
type V1Timing = {
  now: () => number;
  pollDelay: (poll: number) => number;
  requestTimeout: number;
  noResponseTimeout: number;
  downloadRetryDelays: readonly number[];
};
const DEFAULT_V1_TIMING: V1Timing = {
  now: () => Date.now(),
  pollDelay: (poll) => Math.min(2000 * 1.3 ** poll, 15_000),
  requestTimeout: REQUEST_TIMEOUT,
  noResponseTimeout: 10 * 60_000,
  downloadRetryDelays: [2000, 5000],
};
let timing = DEFAULT_V1_TIMING;

export function setMineruV1TimingForTests(
  overrides: Partial<V1Timing> | null,
): void {
  timing = overrides
    ? { ...DEFAULT_V1_TIMING, ...overrides }
    : DEFAULT_V1_TIMING;
}

/** An HTTP error response; the status decides whether a retry can help. */
class MineruHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MineruHttpError";
  }
}

/** Timeouts, network errors, 5xx, 429 and unreadable bodies can clear up. */
function isTransientError(error: unknown): boolean {
  if (error instanceof MineruCancelledError) return false;
  if (!(error instanceof MineruHttpError)) return true;
  return error.status >= 500 || error.status === 429 || error.status === 408;
}

export function mineruErrorDetail(value: unknown): string {
  const data = value as Json | null;
  const message =
    data?.error?.message ?? data?.detail ?? data?.msg ?? data?.err_msg;
  if (typeof message !== "string") return "";
  // MinerU 4.1 error codes are stable; 4.0 codes can be null.
  const code = data?.error?.code;
  const text =
    typeof code === "string" && code.trim()
      ? `${code.trim()}: ${message}`
      : message;
  // Server errors can include signed URLs or authorization strings.
  return text
    .replace(/https?:\/\/[^\s"<>]+/gi, "[URL]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

/** Bound the complete response, including its body, and release abort listeners. */
async function request<T>(
  url: string,
  init: RequestInit,
  read: (response: Response) => Promise<T>,
  signal?: AbortSignal,
  timeout = REQUEST_TIMEOUT,
): Promise<T> {
  if (signal?.aborted) throw new MineruCancelledError();
  const Controller = ztoolkit.getGlobal(
    "AbortController",
  ) as typeof AbortController;
  const controller = new Controller();
  let timer: ReturnType<typeof setTimeout>;
  let onAbort: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      controller.abort();
      reject(new MineruCancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Local MinerU request timed out"));
    }, timeout);
  });
  try {
    const fetch = ztoolkit.getGlobal("fetch") as typeof globalThis.fetch;
    return await Promise.race([
      fetch(url, { ...init, signal: controller.signal }).then(read),
      interrupted,
    ]);
  } catch (error) {
    if (signal?.aborted) throw new MineruCancelledError();
    if (
      error instanceof TypeError ||
      (error as Error)?.name === "NetworkError"
    ) {
      throw new Error(
        "Cannot reach the local MinerU service. Check its address and start the MinerU API server.",
      );
    }
    throw error;
  } finally {
    clearTimeout(timer!);
    signal?.removeEventListener("abort", onAbort);
  }
}

function headers(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

async function jsonRequest(
  base: string,
  path: string,
  apiKey: string,
  signal?: AbortSignal,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  timeout = REQUEST_TIMEOUT,
): Promise<Json> {
  return request(
    `${base}${path}`,
    {
      method,
      headers: {
        ...headers(apiKey),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    async (response) => {
      const data = await response.json().catch(() => null);
      if (!response.ok)
        throw new MineruHttpError(
          `Local MinerU ${path.split("/").slice(0, 3).join("/")}: HTTP ${response.status}${mineruErrorDetail(data) ? `: ${mineruErrorDetail(data)}` : ""}`,
          response.status,
        );
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error("Local MinerU returned invalid JSON");
      return data;
    },
    signal,
    timeout,
  );
}

export async function detectMineruLocalService(
  baseUrl: string,
  apiKey = "",
  signal?: AbortSignal,
): Promise<MineruLocalService> {
  const base = normalizeMineruLocalApiBase(baseUrl);
  const probe = async (path: string) =>
    request(
      `${base}${path}`,
      { headers: headers(apiKey) },
      async (response) => ({
        status: response.status,
        data: (await response.json().catch(() => null)) as Json | null,
      }),
      signal,
      10_000,
    );
  const v1 = await probe("/v1/health");
  if (v1.status >= 200 && v1.status < 300) {
    if (v1.data?.status !== "ok" || typeof v1.data?.version !== "string")
      throw new Error(
        "The local address did not return a valid MinerU V1 health response",
      );
    const offers = (feature: string, value: string) =>
      Array.isArray(v1.data?.features?.[feature]) &&
      v1.data.features[feature].includes(value);
    // A 4.1 server never advertises file_id, so check Tasks first.
    const protocol =
      offers("sources", "upload") && offers("task_output_formats", "default")
        ? "tasks"
        : offers("sources", "file_id") && offers("output_formats", "zip")
          ? "jobs"
          : null;
    if (!protocol)
      throw new Error(
        `MinerU ${v1.data.version} uses a V1 API that this plugin does not support. Supported: MinerU 4.0 (file uploads with ZIP output) or MinerU 4.1 (Tasks with default output).`,
      );
    const result = await jsonRequest(base, "/v1/tiers", apiKey, signal);
    if (
      !Array.isArray(result.data) ||
      !result.data.length ||
      result.data.some((tier: Json) => typeof tier?.id !== "string")
    )
      throw new Error("MinerU returned no valid parsing tiers");
    return {
      api: "v1",
      protocol,
      version: v1.data.version,
      tiers: result.data.map((tier: Json) => tier.id),
    };
  }
  // A reachable legacy server lacks this route. Never hide auth or service errors.
  if (v1.status !== 404 && v1.status !== 405)
    throw new Error(
      `Local MinerU health check: HTTP ${v1.status}${mineruErrorDetail(v1.data) ? `: ${mineruErrorDetail(v1.data)}` : ""}`,
    );
  const legacy = await probe("/health");
  if (legacy.status === 404 || legacy.status === 405) {
    // MinerU 2.x has /file_parse but no /health. Verify the API schema before
    // treating an arbitrary web server as a legacy parser.
    const schema = await jsonRequest(base, "/openapi.json", apiKey, signal);
    if (!schema.paths?.["/file_parse"]?.post)
      throw new Error(
        "This server exposes neither MinerU V1 nor the legacy parsing API",
      );
    return { api: "legacy", version: "unknown" };
  }

  if (legacy.status < 200 || legacy.status >= 300)
    throw new Error(
      `Local MinerU health check: HTTP ${legacy.status}${mineruErrorDetail(legacy.data) ? `: ${mineruErrorDetail(legacy.data)}` : ""}`,
    );
  if (
    !["healthy", "ok"].includes(legacy.data?.status) ||
    typeof legacy.data?.version !== "string"
  )
    throw new Error("The local address is not a recognized MinerU API server");
  return { api: "legacy", version: legacy.data.version };
}

/** MinerU 4 tiers from lowest to highest quality. */
const V1_TIER_ORDER = ["flash", "basic", "standard", "advanced"];

/**
 * Pick the tier to send. Auto prefers standard, then basic, then flash; a
 * requested tier the server lacks falls back to the best offered tier not
 * above it, else the lowest one above it. The server rejects a PDF without an
 * explicit tier when it only offers flash, so the result is never null.
 */
export function resolveMineruV1Tier(
  requested: MineruLocalTier,
  offered: readonly string[],
): { tier: string; fallbackFrom?: string } {
  if (!offered.length)
    throw new Error("MinerU returned no valid parsing tiers");
  if (requested === "auto") {
    const tier = ["standard", "basic", "flash", "advanced"].find((id) =>
      offered.includes(id),
    );
    return { tier: tier ?? offered[0] };
  }
  if (offered.includes(requested)) return { tier: requested };
  const rank = V1_TIER_ORDER.indexOf(requested);
  const known = V1_TIER_ORDER.filter((id) => offered.includes(id));
  const tier =
    known.filter((id) => V1_TIER_ORDER.indexOf(id) <= rank).at(-1) ??
    known[0] ??
    offered[0];
  return { tier, fallbackFrom: requested };
}

function requiredId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`MinerU response is missing ${field}`);
  return value;
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new MineruCancelledError();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new MineruCancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

type V1Params = {
  baseUrl: string;
  fileName: string;
  pdfBytes: Uint8Array;
  service: Extract<MineruLocalService, { api: "v1" }>;
  options: MineruLocalOptions;
  forceOcr: boolean;
  report: (message: string) => void;
  signal?: AbortSignal;
};
type V1Context = { base: string; tier: string; params: V1Params };

/** What one status snapshot means for the shared poll loop. */
type V1Verdict = { wait: string } | { download: string; sendKey: boolean };

/**
 * The protocol-specific part of a V1 parse. The shared loop owns polling,
 * timeouts, HTTP status handling, the result download and cleanup.
 */
type V1Run = {
  /** "job" (MinerU 4.0) or "task" (MinerU 4.1) in user-facing messages. */
  noun: "job" | "task";
  statusPath: string;
  /** The creation receipt, judged before the first poll. */
  receipt?: Json;
  /** Progress label before the first poll when there is no receipt to judge. */
  firstWait?: string;
  /** Work after creation that needs cleanup when it fails, such as the byte upload. */
  prepare?: () => Promise<void>;
  /** Throws for failed, unknown or mismatched snapshots. */
  interpret: (snapshot: Json) => V1Verdict;
  isTerminal: (snapshot: Json) => boolean;
  cancel: { path: string; method: "DELETE" | "POST" };
};

/** Resolve a server-provided URL against the API base; allow only plain HTTP(S). */
function checkedUrl(raw: string, base: string, message: string): URL {
  let url: URL;
  try {
    url = new URL(raw, `${base}/`);
  } catch {
    throw new Error(message);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(message);
  return url;
}

function checkedUploadHeaders(value: unknown): Record<string, string> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some((item) => typeof item !== "string")
  )
    throw new Error("MinerU returned invalid upload headers");
  return value as Record<string, string>;
}

/** PUT the PDF once; the API key goes only to the API's own origin. */
async function uploadBytes(
  context: V1Context,
  url: URL,
  uploadHeaders: Record<string, string>,
): Promise<void> {
  const { base, params } = context;
  await request(
    url.href,
    {
      method: "PUT",
      headers: {
        ...(url.origin === new URL(base).origin
          ? headers(params.options.apiKey)
          : {}),
        ...uploadHeaders,
      },
      body: params.pdfBytes.slice().buffer as ArrayBuffer,
    },
    async (response) => {
      if (!response.ok)
        throw new Error(`MinerU byte upload failed: HTTP ${response.status}`);
      await response.arrayBuffer();
    },
    params.signal,
  );
}

/** MinerU 4.0: upload, complete the upload, then create a parse job. */
async function startMineruV1Job(context: V1Context): Promise<V1Run> {
  const { base, tier, params } = context;
  const { apiKey } = params.options;
  const { signal } = params;
  let upload = await jsonRequest(base, "/v1/uploads", apiKey, signal, {
    filename: params.fileName,
    bytes: params.pdfBytes.length,
    mime_type: "application/pdf",
    purpose: "parse",
  });
  const uploadId = requiredId(upload.id, "upload id");
  if (upload.status === "pending") {
    const url = checkedUrl(
      requiredId(upload.upload_url, "upload URL"),
      base,
      "MinerU returned an invalid upload URL",
    );
    if (upload.upload_method !== "PUT")
      throw new Error("MinerU returned an unsupported upload method");
    await uploadBytes(
      context,
      url,
      checkedUploadHeaders(upload.upload_headers),
    );
    upload = await jsonRequest(
      base,
      `/v1/uploads/${encodeURIComponent(uploadId)}/complete`,
      apiKey,
      signal,
      {},
    );
  }
  if (upload.status !== "completed")
    throw new Error(
      `MinerU upload did not complete (${String(upload.status)})`,
    );
  const fileId = requiredId(upload.file?.id, "input file id");
  const job = await jsonRequest(base, "/v1/parse/jobs", apiKey, signal, {
    files: [
      { source: { type: "file_id", file_id: fileId }, page_range: "all" },
    ],
    tier,
    ocr_mode: params.forceOcr ? "ocr" : "auto",
    output_formats: ["zip"],
  });
  const jobId = requiredId(job.job_id, "job id");
  const jobPath = `/v1/parse/jobs/${encodeURIComponent(jobId)}`;
  return {
    noun: "job",
    statusPath: jobPath,
    receipt: job,
    interpret: (snapshot) => {
      if (snapshot.job_id !== jobId)
        throw new Error("MinerU returned a different job id");
      if (snapshot.status === "completed") {
        if (
          !Array.isArray(snapshot.files) ||
          snapshot.files.length !== 1 ||
          snapshot.files[0].status !== "completed" ||
          snapshot.files[0].file_id !== fileId
        )
          throw new Error("MinerU completed without the requested file result");
        const outputId = requiredId(
          snapshot.files[0].output_files?.zip?.file_id,
          "ZIP output file id",
        );
        return {
          download: `${base}/v1/files/${encodeURIComponent(outputId)}/content`,
          sendKey: true,
        };
      }
      if (["partial", "failed", "canceled"].includes(snapshot.status)) {
        const detail = Array.isArray(snapshot.files)
          ? snapshot.files.map(mineruErrorDetail).filter(Boolean).join("; ")
          : "";
        throw new Error(
          `Local MinerU job ${snapshot.status}${detail ? `: ${detail}` : ""}`,
        );
      }
      if (!["queued", "running"].includes(snapshot.status))
        throw new Error(
          `MinerU returned an unknown job status: ${String(snapshot.status)}`,
        );
      return {
        wait:
          snapshot.status === "queued"
            ? "Waiting for local MinerU to start"
            : "Processing on local MinerU",
      };
    },
    isTerminal: (snapshot) => TERMINAL_JOB_STATES.includes(snapshot.status),
    cancel: { path: jobPath, method: "DELETE" },
  };
}

const TASK_WAIT_LABELS = new Map([
  ["waiting-file", "Waiting for local MinerU to receive the PDF"],
  ["pending", "Waiting for local MinerU to start"],
  ["running", "Processing on local MinerU"],
]);
const FAILED_TASK_STATES = ["failed", "canceled", "partial"];

/** Best-effort cancel on an independent bounded request; the caller's signal may be aborted. */
async function bestEffortCancel(
  base: string,
  apiKey: string,
  cancel: V1Run["cancel"],
  noun: string,
): Promise<void> {
  try {
    await jsonRequest(
      base,
      cancel.path,
      apiKey,
      undefined,
      undefined,
      cancel.method,
      5000,
    );
  } catch {
    appLogger.warn(
      `MinerU V1 ${noun} cancellation was not confirmed; check the local server`,
    );
  }
}

/** MinerU 4.1: create a task, PUT the bytes once if asked, then poll the task. */
async function startMineruV1Task(context: V1Context): Promise<V1Run> {
  const { base, tier, params } = context;
  const receipt = await jsonRequest(
    base,
    "/v1/tasks",
    params.options.apiKey,
    params.signal,
    {
      files: [{ file_name: params.fileName, bytes: params.pdfBytes.length }],
      tier,
      ocr_mode: params.forceOcr ? "ocr" : "auto",
      output_formats: ["default"],
    },
  );
  const taskId = requiredId(receipt.task_id, "task id");
  const taskPath = `/v1/tasks/${encodeURIComponent(taskId)}`;
  const cancel: V1Run["cancel"] = {
    path: `${taskPath}/cancel`,
    method: "POST",
  };
  let created: Json;
  let fileId: string;
  try {
    if (!Array.isArray(receipt.files) || receipt.files.length !== 1)
      throw new Error("MinerU task must contain exactly one file");
    created = receipt.files[0] as Json;
    fileId = requiredId(created?.file_id, "input file id");
  } catch (error) {
    // The task exists and waits for a file; do not leave it until expiry.
    await bestEffortCancel(base, params.options.apiKey, cancel, "task");
    throw error;
  }
  const taskFile = (snapshot: Json): Json => {
    if (snapshot.task_id !== taskId)
      throw new Error("MinerU returned a different task id");
    if (
      !Array.isArray(snapshot.files) ||
      snapshot.files.length !== 1 ||
      snapshot.files[0]?.file_id !== fileId
    )
      throw new Error("MinerU returned a different task file");
    return snapshot.files[0];
  };
  // A cache hit or a server-side confirmation has no upload action; poll only.
  // Later snapshots never trigger a second PUT.
  const link = created.status === "waiting-file" ? created.upload : undefined;
  return {
    noun: "task",
    statusPath: taskPath,
    // The receipt omits result URLs, so the first verdict comes from a poll.
    firstWait:
      TASK_WAIT_LABELS.get(created.status) ?? "Processing on local MinerU",
    prepare: link
      ? async () => {
          const url = checkedUrl(
            requiredId(link.url, "upload URL"),
            base,
            "MinerU returned an invalid upload URL",
          );
          await uploadBytes(context, url, checkedUploadHeaders(link.headers));
        }
      : undefined,
    interpret: (snapshot) => {
      const file = taskFile(snapshot);
      if (file.status === "completed") {
        if (typeof file.result_url !== "string" || !file.result_url.trim())
          throw new Error("MinerU completed without a result URL");
        const url = checkedUrl(
          file.result_url,
          base,
          "MinerU returned an invalid result URL",
        );
        return {
          download: url.href,
          sendKey: url.origin === new URL(base).origin,
        };
      }
      if (
        FAILED_TASK_STATES.includes(snapshot.status) ||
        FAILED_TASK_STATES.includes(file.status)
      ) {
        const state = FAILED_TASK_STATES.includes(snapshot.status)
          ? snapshot.status
          : file.status;
        const detail = [
          ...new Set([file, snapshot].map(mineruErrorDetail).filter(Boolean)),
        ].join("; ");
        throw new Error(
          `Local MinerU task ${state}${detail ? `: ${detail}` : ""}`,
        );
      }
      const wait = TASK_WAIT_LABELS.get(file.status);
      if (!wait)
        throw new Error(
          `MinerU returned an unknown task status: ${String(file.status)}`,
        );
      return { wait };
    },
    isTerminal: (snapshot) =>
      TERMINAL_JOB_STATES.includes(snapshot.status) ||
      ["completed", "failed", "canceled"].includes(snapshot.files?.[0]?.status),
    cancel,
  };
}

export async function parseMineruV1(params: V1Params) {
  const { options, service, report, signal } = params;
  const base = normalizeMineruLocalApiBase(params.baseUrl);
  // The service is re-detected for every parse, so a server restarted with
  // other tiers needs no settings change.
  const resolved = resolveMineruV1Tier(options.tier, service.tiers);
  if (resolved.fallbackFrom) {
    const notice = `${resolved.fallbackFrom} isn't offered by this MinerU server; using ${resolved.tier}`;
    appLogger.warn(
      `MinerU V1: ${notice} (offered: ${service.tiers.join(", ")})`,
    );
    report(notice);
  }
  const tierNote = resolved.fallbackFrom
    ? `${resolved.tier}; ${resolved.fallbackFrom} not offered`
    : resolved.tier;
  report(`Uploading PDF to local MinerU V1 (${tierNote})…`);
  const context: V1Context = { base, tier: resolved.tier, params };
  const run = await (service.protocol === "tasks"
    ? startMineruV1Task(context)
    : startMineruV1Job(context));
  const { noun } = run;
  let snapshot = run.receipt;
  let gone = false;
  let keyRejected = false;
  try {
    await run.prepare?.();
    const started = timing.now();
    let lastResponseAt = started;
    let unresponsive = false;
    let lastHttpStatus: number | null = null;
    let polls = 0;
    let target: Extract<V1Verdict, { download: string }>;
    while (true) {
      if (signal?.aborted) throw new MineruCancelledError();
      const verdict: V1Verdict = snapshot
        ? run.interpret(snapshot)
        : { wait: run.firstWait ?? "Processing on local MinerU" };
      if ("download" in verdict) {
        target = verdict;
        break;
      }
      const now = timing.now();
      if (now - started >= JOB_TIMEOUT)
        throw new Error(
          `Local MinerU ${noun} timed out; check the server before retrying`,
        );
      report(
        unresponsive
          ? `Local MinerU is busy and not responding… (${Math.round((now - lastResponseAt) / 1000)}s)`
          : `${verdict.wait} (${tierNote})… (${Math.round((now - started) / 1000)}s)`,
      );
      await wait(timing.pollDelay(polls++), signal);
      try {
        snapshot = await jsonRequest(
          base,
          run.statusPath,
          options.apiKey,
          signal,
          undefined,
          "GET",
          timing.requestTimeout,
        );
        lastResponseAt = timing.now();
        unresponsive = false;
        lastHttpStatus = null;
      } catch (error) {
        if (error instanceof MineruHttpError) {
          if (error.status === 401 || error.status === 403) {
            keyRejected = true;
            throw new Error(
              `Local MinerU rejected the API key while checking the ${noun} (HTTP ${error.status}). Check the local MinerU API key.`,
            );
          }
          if (error.status === 404) {
            gone = true;
            throw new Error(
              `Local MinerU no longer has this ${noun} (HTTP 404); the server may have restarted. Retry the parse.`,
            );
          }
        }
        if (!isTransientError(error)) throw error;
        lastHttpStatus = error instanceof MineruHttpError ? error.status : null;
        appLogger.warn(
          `MinerU V1 status request failed; retrying: ${(error as Error)?.message}`,
        );
        if (timing.now() - lastResponseAt >= timing.noResponseTimeout)
          throw new Error(
            lastHttpStatus !== null
              ? `The local MinerU server kept returning errors (HTTP ${lastHttpStatus}) for ${Math.round(timing.noResponseTimeout / 60_000)} minutes. Check or restart the local MinerU server, then retry.`
              : `The local MinerU server stopped responding for ${Math.round(timing.noResponseTimeout / 60_000)} minutes. Check or restart the local MinerU server, then retry.`,
          );
        unresponsive = true;
      }
    }
    report("Downloading local MinerU result…");
    let bytes: Uint8Array;
    for (let attempt = 0; ; attempt++) {
      try {
        bytes = await request(
          target.download,
          { headers: target.sendKey ? headers(options.apiKey) : {} },
          async (response) => {
            if (!response.ok)
              throw new MineruHttpError(
                `MinerU result download failed: HTTP ${response.status}`,
                response.status,
              );
            return new Uint8Array(await response.arrayBuffer());
          },
          signal,
          timing.requestTimeout,
        );
        break;
      } catch (error) {
        const delay = timing.downloadRetryDelays[attempt];
        if (delay === undefined || !isTransientError(error)) throw error;
        report("Retrying local MinerU result download…");
        await wait(delay, signal);
      }
    }
    const result = normalizeMineruV1Zip(bytes);
    report(`Done (${result.files.length} files extracted; ${tierNote})`);
    return result;
  } catch (error) {
    // Stop work the server would otherwise keep running after we give up.
    if (!gone && !keyRejected && !(snapshot && run.isTerminal(snapshot))) {
      await bestEffortCancel(base, options.apiKey, run.cancel, noun);
    }
    throw error;
  }
}
