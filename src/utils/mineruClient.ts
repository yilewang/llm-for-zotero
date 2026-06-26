import { version as addonVersion } from "../../package.json";
import {
  describeMineruZipInspectionFailure,
  inspectMineruZipBytes,
  type MinerUZipFile,
  type MinerUZipInspectionResult,
} from "./mineruZip";
import {
  DEFAULT_MINERU_CLOUD_MODEL,
  DEFAULT_MINERU_FORCE_OCR,
  getMineruApiKey,
  getMineruCloudModel,
  isMineruForceOcrEnabled,
  getMineruLocalApiBase,
  getMineruLocalBackend,
  getMineruMode,
  normalizeMineruLocalApiBase,
  toMineruApiBackend,
  type MineruCloudModel,
  type MineruLocalBackend,
} from "./mineruConfig";
import { t } from "./i18n";
import { buildMultipartRequest } from "./multipart";

const MINERU_DIRECT_API_BASE = "https://mineru.net/api/v4";

function getMineruApiBase(): string {
  return MINERU_DIRECT_API_BASE;
}

function getMineruAuthHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}
const CLOUD_INITIAL_POLL_INTERVAL_MS = 3000;
const CLOUD_MEDIUM_POLL_INTERVAL_MS = 15 * 1000;
const CLOUD_LONG_ACTIVE_POLL_INTERVAL_MS = 60 * 1000;
const CLOUD_MEDIUM_POLL_AFTER_MS = 5 * 60 * 1000;
const CLOUD_LONG_ACTIVE_POLL_AFTER_MS = 30 * 60 * 1000;
const CLOUD_NO_STATUS_TIMEOUT_MS = 10 * 60 * 1000;
const CLOUD_PRE_PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60000;
// Local /file_parse is synchronous and exposes no separate job status; rely on
// explicit abort/pause rather than guessing whether an open request is stuck.
const LOCAL_PARSE_TIMEOUT_MS = 0;
const LOCAL_PROGRESS_INTERVAL_MS = 3000;
const LOCAL_BUSY_RETRY_DELAYS_MS = [5000, 15000, 30000, 60000, 120000] as const;

export type MinerUExtractedFile = MinerUZipFile;

export type MinerUResult = {
  mdContent: string;
  files: MinerUExtractedFile[];
} | null;

export type MinerUProgressCallback = (stage: string) => void;

type MineruCloudPollPhase = "pre_processing" | "active_processing";

type MineruCloudPollTimeoutReason = "no_status" | "pre_processing";

type MineruCloudPollDecision =
  | {
      action: "continue";
      phase: MineruCloudPollPhase;
      pollIntervalMs: number;
    }
  | {
      action: "terminal";
      terminalState: "done" | "failed";
      pollIntervalMs: number;
    }
  | {
      action: "timeout";
      reason: MineruCloudPollTimeoutReason;
      phase: MineruCloudPollPhase;
      pollIntervalMs: number;
    };

type MineruCloudPollDecisionInput = {
  state?: string | null;
  nowMs: number;
  pollStartMs: number;
  lastStatusAtMs: number | null;
  activeStartedAtMs: number | null;
};

type LocalFileParseGateRelease = () => void;

let localFileParseGateHeld = false;
let localFileParseGateQueue: Array<() => void> = [];
let localBusyRetryDelaysOverrideForTests: readonly number[] | null = null;

export class MineruRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MineruRateLimitError";
  }
}

export class MineruCancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "MineruCancelledError";
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MineruCancelledError();
}

function getFetch(): typeof fetch {
  return ztoolkit.getGlobal("fetch") as typeof fetch;
}

function getAbortControllerCtor(): typeof AbortController | undefined {
  return (
    (globalThis as { AbortController?: typeof AbortController })
      .AbortController ??
    (ztoolkit.getGlobal("AbortController") as
      | typeof AbortController
      | undefined)
  );
}

/** Race a promise against an AbortSignal — rejects immediately when aborted. */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new MineruCancelledError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new MineruCancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

type IOUtilsLike = {
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  write?: (path: string, data: Uint8Array) => Promise<unknown>;
};

type OSFileLike = {
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
};

type DownloadTransport = "fetch" | "zotero-http" | "curl";

type BinaryDownloadAttempt = {
  transport: DownloadTransport;
  status: number | null;
  contentType: string | null;
  byteLength: number | null;
  error: string | null;
};

type BinaryDownloadResult = {
  bytes: Uint8Array | null;
  attempts: BinaryDownloadAttempt[];
};

type CurlDownloadResult = {
  bytes: Uint8Array | null;
  attempt: BinaryDownloadAttempt;
};

type MineruZipExtractionResult =
  | {
      ok: true;
      mdContent: string;
      files: MinerUExtractedFile[];
    }
  | {
      ok: false;
      message: string;
      download: BinaryDownloadResult;
      zipInspection?: MinerUZipInspectionResult;
    };

type MineruZipBytesExtractionResult =
  | {
      ok: true;
      mdContent: string;
      files: MinerUExtractedFile[];
    }
  | {
      ok: false;
      message: string;
      zipInspection: MinerUZipInspectionResult;
    };

function getIOUtils(): IOUtilsLike | undefined {
  return (globalThis as unknown as { IOUtils?: IOUtilsLike }).IOUtils;
}

function getOSFile(): OSFileLike | undefined {
  return (globalThis as { OS?: { File?: OSFileLike } }).OS?.File;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new MineruCancelledError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new MineruCancelledError());
      },
      { once: true },
    );
  });
}

function getLocalBusyRetryDelaysMs(): readonly number[] {
  return localBusyRetryDelaysOverrideForTests ?? LOCAL_BUSY_RETRY_DELAYS_MS;
}

function createLocalFileParseGateRelease(): LocalFileParseGateRelease {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = localFileParseGateQueue.shift();
    if (next) {
      next();
    } else {
      localFileParseGateHeld = false;
    }
  };
}

function acquireLocalFileParseGate(
  signal?: AbortSignal,
  onWait?: () => void,
): Promise<LocalFileParseGateRelease> {
  if (signal?.aborted) return Promise.reject(new MineruCancelledError());
  if (!localFileParseGateHeld) {
    localFileParseGateHeld = true;
    return Promise.resolve(createLocalFileParseGateRelease());
  }

  onWait?.();
  return new Promise<LocalFileParseGateRelease>((resolve, reject) => {
    let settled = false;
    const grant = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(createLocalFileParseGateRelease());
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      localFileParseGateQueue = localFileParseGateQueue.filter(
        (queued) => queued !== grant,
      );
      reject(new MineruCancelledError());
    };
    localFileParseGateQueue.push(grant);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function setMineruLocalBusyRetryDelaysForTests(
  delays: readonly number[] | null,
): void {
  localBusyRetryDelaysOverrideForTests = delays;
}

export function resetMineruLocalFileParseGateForTests(): void {
  localFileParseGateHeld = false;
  localFileParseGateQueue = [];
  localBusyRetryDelaysOverrideForTests = null;
}

// ── HTTP helpers using Zotero.HTTP (bypasses CORS) ────────────────────────────

async function httpJson(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; data: unknown }> {
  const xhr = await Zotero.HTTP.request(method, url, {
    headers,
    body: body ?? undefined,
    responseType: "text",
    successCodes: false,
    timeout: REQUEST_TIMEOUT_MS,
  });
  let data: unknown = null;
  try {
    data = JSON.parse(xhr.responseText || "null");
  } catch {
    /* not JSON */
  }
  return { status: xhr.status, data };
}

async function downloadViaCurl(url: string): Promise<Uint8Array | null> {
  // Use system curl to download binary data, bypassing Firefox ESR's TLS stack
  // which cannot connect to Alibaba Cloud OSS.
  try {
    const Cc = (
      globalThis as {
        Components?: {
          classes?: Record<
            string,
            { createInstance: (iface: unknown) => unknown }
          >;
        };
      }
    ).Components?.classes;
    const Ci = (
      globalThis as { Components?: { interfaces?: Record<string, unknown> } }
    ).Components?.interfaces;
    if (!Cc || !Ci) return null;

    const dirService = (
      Cc["@mozilla.org/file/directory_service;1"] as unknown as {
        getService?: (iface: unknown) => {
          get?: (prop: string, iface: unknown) => { path?: string };
        };
      }
    )?.getService?.(Ci.nsIProperties as unknown);
    const tempDir = dirService?.get?.("TmpD", Ci.nsIFile as unknown);
    if (!tempDir?.path) {
      ztoolkit.log("MinerU download [curl]: cannot resolve temp directory");
      return null;
    }

    const outPath = `${tempDir.path}${tempDir.path.includes("\\") ? "\\" : "/"}mineru_dl_${Date.now()}.bin`;
    const exitCode = await runCurl([
      "-s",
      "-f",
      "-o",
      outPath,
      "--max-time",
      "300",
      "-L",
      "--url",
      url,
    ]);

    if (exitCode !== 0) {
      ztoolkit.log(`MinerU download [curl]: failed exit=${exitCode}`);
      return null;
    }

    ztoolkit.log("MinerU download [curl]: success");
    // Read the temp file using IOUtils or OS.File
    try {
      const io = getIOUtils();
      if (io?.read) {
        const data = await io.read(outPath);
        try {
          const ioFull = (
            globalThis as unknown as {
              IOUtils?: { remove?: (path: string) => Promise<void> };
            }
          ).IOUtils;
          await ioFull?.remove?.(outPath);
        } catch {
          /* ignore */
        }
        return data instanceof Uint8Array
          ? data
          : new Uint8Array(data as ArrayBuffer);
      }
      const osFile = getOSFile();
      if (osFile?.read) {
        const data = await osFile.read(outPath);
        return data instanceof Uint8Array
          ? data
          : new Uint8Array(data as ArrayBuffer);
      }
    } catch {
      /* ignore */
    }
    return null;
  } catch (e) {
    ztoolkit.log(`MinerU download [curl] threw: ${(e as Error).message}`);
    return null;
  }
}

function getResponseHeader(xhr: unknown, headerName: string): string | null {
  const getter = (
    xhr as { getResponseHeader?: (name: string) => string | null }
  )?.getResponseHeader;
  if (typeof getter !== "function") return null;
  try {
    return getter.call(xhr, headerName);
  } catch {
    return null;
  }
}

function getCurrentPlatform(): string {
  try {
    const zotero = Zotero as unknown as {
      isWin?: boolean;
      isMac?: boolean;
      isLinux?: boolean;
      platform?: string;
    };
    if (zotero.isWin) return "windows";
    if (zotero.isMac) return "macos";
    if (zotero.isLinux) return "linux";
    if (typeof zotero.platform === "string" && zotero.platform.trim()) {
      return zotero.platform.trim();
    }
  } catch {
    /* ignore */
  }
  return "unknown";
}

function getZoteroVersion(): string {
  try {
    const version = (Zotero as unknown as { version?: string }).version;
    if (typeof version === "string" && version.trim()) return version.trim();
  } catch {
    /* ignore */
  }
  return "unknown";
}

function getFinalDownloadAttempt(
  result: BinaryDownloadResult,
): BinaryDownloadAttempt | null {
  if (!result.attempts.length) return null;
  return result.attempts[result.attempts.length - 1];
}

function buildDownloadFailureMessage(result: BinaryDownloadResult): string {
  const attempt = getFinalDownloadAttempt(result);
  if (!attempt) return "Failed to download ZIP result";
  if (attempt.status !== null) {
    return `Failed to download ZIP result: HTTP ${attempt.status} via ${attempt.transport}`;
  }
  return `Failed to download ZIP result via ${attempt.transport}`;
}

function logMineruZipFailure(
  download: BinaryDownloadResult,
  zipInspection?: MinerUZipInspectionResult,
): void {
  const finalAttempt = getFinalDownloadAttempt(download);
  const payload = {
    platform: getCurrentPlatform(),
    zoteroVersion: getZoteroVersion(),
    addonVersion,
    transport: finalAttempt?.transport ?? null,
    httpStatus: finalAttempt?.status ?? null,
    contentType: finalAttempt?.contentType ?? null,
    byteLength: zipInspection?.byteLength ?? finalAttempt?.byteLength ?? null,
    zipSignature: zipInspection?.zipSignature ?? null,
    firstBytesHex: zipInspection?.firstBytesHex ?? null,
    attempts: download.attempts.map((attempt) => ({
      transport: attempt.transport,
      status: attempt.status,
      contentType: attempt.contentType,
      byteLength: attempt.byteLength,
      error: attempt.error,
    })),
    entryCount: zipInspection?.entryNames.length ?? 0,
    entryPreview: zipInspection?.entryNames.slice(0, 8) ?? [],
    zipError:
      zipInspection && !zipInspection.ok ? (zipInspection.error ?? null) : null,
  };
  ztoolkit.log(`MinerU ZIP debug: ${JSON.stringify(payload)}`);
}

async function downloadViaCurlWithMetadata(
  url: string,
): Promise<CurlDownloadResult> {
  const bytes = await downloadViaCurl(url);
  return {
    bytes,
    attempt: {
      transport: "curl",
      status: null,
      contentType: null,
      byteLength: bytes?.length ?? null,
      error: bytes ? null : "curl download failed",
    },
  };
}

async function httpGetBinary(url: string): Promise<BinaryDownloadResult> {
  const attempts: BinaryDownloadAttempt[] = [];

  // Try fetch first (works for cloud storage/CDN URLs with CORS),
  // fall back to Zotero.HTTP.request, then curl.
  try {
    const fetchFn = ztoolkit.getGlobal("fetch") as typeof fetch;
    const resp = await fetchFn(url);
    if (resp.ok) {
      const bytes = new Uint8Array(await resp.arrayBuffer());
      attempts.push({
        transport: "fetch",
        status: resp.status,
        contentType: resp.headers.get("content-type"),
        byteLength: bytes.length,
        error: null,
      });
      return { bytes, attempts };
    }
    attempts.push({
      transport: "fetch",
      status: resp.status,
      contentType: resp.headers.get("content-type"),
      byteLength: null,
      error: `HTTP ${resp.status}`,
    });
  } catch (e) {
    attempts.push({
      transport: "fetch",
      status: null,
      contentType: null,
      byteLength: null,
      error: (e as Error).message || "fetch failed",
    });
  }

  try {
    const xhr = await Zotero.HTTP.request("GET", url, {
      responseType: "arraybuffer",
      successCodes: false,
      timeout: REQUEST_TIMEOUT_MS * 2,
      errorDelayMax: 0,
    });
    if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
      const bytes = new Uint8Array(xhr.response as ArrayBuffer);
      attempts.push({
        transport: "zotero-http",
        status: xhr.status,
        contentType: getResponseHeader(xhr, "Content-Type"),
        byteLength: bytes.length,
        error: null,
      });
      return { bytes, attempts };
    }
    attempts.push({
      transport: "zotero-http",
      status: xhr.status,
      contentType: getResponseHeader(xhr, "Content-Type"),
      byteLength: null,
      error: `HTTP ${xhr.status}`,
    });
  } catch (e) {
    attempts.push({
      transport: "zotero-http",
      status: null,
      contentType: null,
      byteLength: null,
      error: (e as Error).message || "Zotero.HTTP failed",
    });
  }

  // Attempt 3: curl (bypasses Firefox ESR TLS issues with Alibaba Cloud OSS)
  const curlResult = await downloadViaCurlWithMetadata(url);
  attempts.push(curlResult.attempt);
  return {
    bytes: curlResult.bytes,
    attempts,
  };
}

// ── File reading ──────────────────────────────────────────────────────────────

async function readPdfBytes(pdfPath: string): Promise<Uint8Array | null> {
  const io = getIOUtils();
  if (io?.read) {
    try {
      const data = await io.read(pdfPath);
      if (data instanceof Uint8Array) return data;
      if (data instanceof ArrayBuffer) return new Uint8Array(data);
      if (ArrayBuffer.isView(data)) {
        const view = data as ArrayBufferView;
        return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      }
      return new Uint8Array(data as ArrayBuffer);
    } catch (e) {
      ztoolkit.log("MinerU: IOUtils.read failed:", e);
    }
  }
  const osFile = getOSFile();
  if (osFile?.read) {
    try {
      const data = await osFile.read(pdfPath);
      if (data instanceof Uint8Array) return data;
      return new Uint8Array(data as ArrayBuffer);
    } catch (e) {
      ztoolkit.log("MinerU: OS.File.read failed:", e);
    }
  }
  return null;
}

function extractMineruZipBytes(
  zipBytes: Uint8Array,
  report: (s: string) => void,
): MineruZipBytesExtractionResult {
  report(t("Extracting files…"));
  const zipInspection = inspectMineruZipBytes(zipBytes);
  if (!zipInspection.ok) {
    return {
      ok: false,
      message: describeMineruZipInspectionFailure(zipInspection),
      zipInspection,
    };
  }

  return {
    ok: true,
    mdContent: zipInspection.mdContent,
    files: zipInspection.files,
  };
}

async function downloadAndExtractZip(
  zipUrl: string,
  report: (s: string) => void,
): Promise<MineruZipExtractionResult> {
  report(t("Downloading results…"));
  const downloadResult = await httpGetBinary(zipUrl);
  if (!downloadResult.bytes) {
    return {
      ok: false,
      message: buildDownloadFailureMessage(downloadResult),
      download: downloadResult,
    };
  }

  const extracted = extractMineruZipBytes(downloadResult.bytes, report);
  if (!extracted.ok) {
    return {
      ok: false,
      message: extracted.message,
      download: downloadResult,
      zipInspection: extracted.zipInspection,
    };
  }

  return {
    ok: true,
    mdContent: extracted.mdContent,
    files: extracted.files,
  };
}

function getSafePdfFileName(pdfPath: string): string {
  const rawName = pdfPath.split(/[\\/]/).pop() || "paper.pdf";
  return rawName.replace(/[^\x20-\x7E]/g, "_") || "paper.pdf";
}

function joinApiPath(baseUrl: string, path: string): string {
  return `${normalizeMineruLocalApiBase(baseUrl)}${path}`;
}

function truncateResponseText(text: string, maxLength = 240): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3)}...`
    : normalized;
}

function normalizeMineruCloudState(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isMineruCloudActiveState(state: string): boolean {
  return state === "running" || state === "converting";
}

function getMineruCloudPollInterval(params: {
  nowMs: number;
  pollStartMs: number;
  activeStartedAtMs: number | null;
}): number {
  if (
    params.activeStartedAtMs !== null &&
    params.nowMs - params.activeStartedAtMs >= CLOUD_LONG_ACTIVE_POLL_AFTER_MS
  ) {
    return CLOUD_LONG_ACTIVE_POLL_INTERVAL_MS;
  }
  if (params.nowMs - params.pollStartMs >= CLOUD_MEDIUM_POLL_AFTER_MS) {
    return CLOUD_MEDIUM_POLL_INTERVAL_MS;
  }
  return CLOUD_INITIAL_POLL_INTERVAL_MS;
}

function getMineruCloudPollDecision(
  params: MineruCloudPollDecisionInput,
): MineruCloudPollDecision {
  const state = normalizeMineruCloudState(params.state);
  const activeStartedAtMs =
    params.activeStartedAtMs ??
    (isMineruCloudActiveState(state) ? params.nowMs : null);
  const phase: MineruCloudPollPhase =
    activeStartedAtMs === null ? "pre_processing" : "active_processing";
  const pollIntervalMs = getMineruCloudPollInterval({
    nowMs: params.nowMs,
    pollStartMs: params.pollStartMs,
    activeStartedAtMs,
  });

  if (state === "done" || state === "failed") {
    return { action: "terminal", terminalState: state, pollIntervalMs };
  }

  const lastStatusAtMs = params.lastStatusAtMs;
  if (
    lastStatusAtMs === null
      ? params.nowMs - params.pollStartMs >= CLOUD_NO_STATUS_TIMEOUT_MS
      : params.nowMs - lastStatusAtMs >= CLOUD_NO_STATUS_TIMEOUT_MS
  ) {
    return {
      action: "timeout",
      reason: "no_status",
      phase,
      pollIntervalMs,
    };
  }

  if (
    activeStartedAtMs === null &&
    params.nowMs - params.pollStartMs >= CLOUD_PRE_PROCESSING_TIMEOUT_MS
  ) {
    return {
      action: "timeout",
      reason: "pre_processing",
      phase,
      pollIntervalMs,
    };
  }

  return { action: "continue", phase, pollIntervalMs };
}

function buildMineruCloudProgressMessage(
  state: string,
  elapsedSeconds: number,
): string {
  const elapsed = `${elapsedSeconds}`;
  if (state === "running") {
    return t("Processing on server… (%ss)").replace("%s", elapsed);
  }
  if (state === "converting") {
    return t("Converting on server… (%ss)").replace("%s", elapsed);
  }
  if (state === "waiting-file") {
    return t("Waiting for MinerU upload to be accepted… (%ss)").replace(
      "%s",
      elapsed,
    );
  }
  if (state === "pending") {
    return t("Waiting for MinerU to start… (%ss)").replace("%s", elapsed);
  }
  return t("Waiting for MinerU status… (%ss)").replace("%s", elapsed);
}

export function getMineruCloudPollDecisionForTests(
  params: MineruCloudPollDecisionInput,
): MineruCloudPollDecision {
  return getMineruCloudPollDecision(params);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<Response> {
  if (signal?.aborted) throw new MineruCancelledError();
  const AbortCtrl = getAbortControllerCtor();
  if (!AbortCtrl) {
    return await new Promise<Response>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const finishResolve = (value: Response) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const finishReject = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => finishReject(new MineruCancelledError());
      const timer =
        timeoutMs > 0
          ? setTimeout(() => finishReject(new Error(timeoutMessage)), timeoutMs)
          : null;

      if (signal?.aborted) {
        finishReject(new MineruCancelledError());
        return;
      }

      signal?.addEventListener("abort", onAbort, { once: true });
      getFetch()(url, init).then(finishResolve, finishReject);
    });
  }

  const controller = new AbortCtrl();
  let timedOut = false;
  const onAbort = () => controller.abort();
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    return await getFetch()(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new MineruCancelledError();
    if (timedOut) throw new Error(timeoutMessage);
    throw error;
  } finally {
    if (timer !== null) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function buildLocalFileParseBody(params: {
  fileName: string;
  pdfBytes: Uint8Array;
  backend: MineruLocalBackend;
  forceOcr?: boolean;
}): { body: BodyInit; contentType?: string; mode: "formdata" | "manual" } {
  const request = buildMultipartRequest(
    [
      {
        name: "files",
        filename: params.fileName,
        contentType: "application/pdf",
        data: params.pdfBytes,
      },
      { name: "backend", value: toMineruApiBackend(params.backend) },
      { name: "parse_method", value: params.forceOcr ? "ocr" : "auto" },
      { name: "formula_enable", value: "true" },
      { name: "table_enable", value: "true" },
      { name: "return_md", value: "true" },
      { name: "return_content_list", value: "true" },
      { name: "return_images", value: "true" },
      { name: "response_format_zip", value: "true" },
      { name: "return_original_file", value: "false" },
    ],
    {
      boundaryPrefix: "MinerUBoundary",
      fallbackName: "field",
      preferFormData: true,
    },
  );
  return {
    ...request,
    body:
      request.body instanceof Uint8Array
        ? (request.body.buffer.slice(
            request.body.byteOffset,
            request.body.byteOffset + request.body.byteLength,
          ) as ArrayBuffer)
        : request.body,
  };
}

async function submitLocalFileParseRequest(params: {
  url: string;
  fileName: string;
  sizeMB: string;
  pdfBytes: Uint8Array;
  backend: MineruLocalBackend;
  forceOcr?: boolean;
  report: (s: string) => void;
  signal?: AbortSignal;
}): Promise<Response> {
  throwIfAborted(params.signal);
  const { body, contentType } = buildLocalFileParseBody({
    fileName: params.fileName,
    pdfBytes: params.pdfBytes,
    backend: params.backend,
    forceOcr: params.forceOcr,
  });
  params.report(
    t("Uploading to local server… (%s MB)").replace("%s", params.sizeMB),
  );
  const startTime = Date.now();
  const progressTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    params.report(t("Waiting for parser… (%ss)").replace("%s", `${elapsed}`));
  }, LOCAL_PROGRESS_INTERVAL_MS);

  try {
    const headers: Record<string, string> = {};
    if (contentType) headers["Content-Type"] = contentType;
    return await raceAbort(
      fetchWithTimeout(
        params.url,
        {
          method: "POST",
          headers,
          body,
        },
        params.signal,
        LOCAL_PARSE_TIMEOUT_MS,
        t("Local MinerU parsing timed out"),
      ),
      params.signal,
    );
  } finally {
    clearInterval(progressTimer);
  }
}

async function readResponseText(
  response: Response,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return await raceAbort(response.text(), signal);
  } catch {
    return "";
  }
}

function buildLocalParseHttpFailureMessage(
  status: number,
  responseText: string,
): string {
  const suffix = responseText ? `: ${truncateResponseText(responseText)}` : "";
  return `${t("Local parse failed: HTTP %s").replace("%s", `${status}`)}${suffix}`;
}

async function parsePdfViaLocalFileParse(
  pdfPath: string,
  baseUrl: string,
  backend: MineruLocalBackend,
  forceOcr: boolean,
  report: (s: string) => void,
  signal?: AbortSignal,
): Promise<MinerUResult> {
  throwIfAborted(signal);
  report(t("Reading PDF file…"));
  const pdfBytes = await readPdfBytes(pdfPath);
  if (!pdfBytes || !pdfBytes.length) {
    report(t("PDF file is empty or unreadable"));
    return null;
  }

  const fileName = getSafePdfFileName(pdfPath);
  const sizeMB = (pdfBytes.length / (1024 * 1024)).toFixed(1);

  throwIfAborted(signal);
  const url = joinApiPath(baseUrl, "/file_parse");
  const releaseGate = await acquireLocalFileParseGate(signal, () => {
    report(t("Waiting for another local MinerU parse to finish…"));
  });
  const retryDelays = getLocalBusyRetryDelaysMs();
  throwIfAborted(signal);

  try {
    for (let attempt = 0; ; attempt++) {
      const response = await submitLocalFileParseRequest({
        url,
        fileName,
        sizeMB,
        pdfBytes,
        backend,
        forceOcr,
        report,
        signal,
      });

      const contentTypeHeader = response.headers.get("content-type");
      if (!response.ok) {
        const responseText = await readResponseText(response, signal);
        if (response.status === 409) {
          const retryDelayMs = retryDelays[attempt];
          if (retryDelayMs != null) {
            report(
              t("Local MinerU server is busy; retrying in %ss").replace(
                "%s",
                `${Math.max(1, Math.ceil(retryDelayMs / 1000))}`,
              ),
            );
            await sleep(retryDelayMs, signal);
            continue;
          }

          const suffix = responseText
            ? `: ${truncateResponseText(responseText)}`
            : "";
          report(
            `${t("Local MinerU server is still busy after %s retries").replace(
              "%s",
              `${retryDelays.length}`,
            )}${suffix}`,
          );
          return null;
        }

        report(
          buildLocalParseHttpFailureMessage(response.status, responseText),
        );
        return null;
      }

      throwIfAborted(signal);
      const zipBytes = new Uint8Array(
        await raceAbort(response.arrayBuffer(), signal),
      );
      const extracted = extractMineruZipBytes(zipBytes, report);
      if (extracted.ok) {
        report(
          t("Done (%s files extracted)").replace(
            "%s",
            `${extracted.files.length}`,
          ),
        );
        return { mdContent: extracted.mdContent, files: extracted.files };
      }

      report(extracted.message);
      logMineruZipFailure(
        {
          bytes: zipBytes,
          attempts: [
            {
              transport: "fetch",
              status: response.status,
              contentType: contentTypeHeader,
              byteLength: zipBytes.length,
              error: extracted.message,
            },
          ],
        },
        extracted.zipInspection,
      );
      return null;
    }
  } finally {
    releaseGate();
  }
}

// ── Presigned URL upload workflow ──────────────────────────────────────────────

function getCurlPath(): string | null {
  const xulRuntime = (
    globalThis as {
      Components?: {
        classes?: Record<
          string,
          { getService?: (iface: unknown) => { OS?: string } }
        >;
        interfaces?: Record<string, unknown>;
      };
    }
  ).Components;
  let osName = "";
  try {
    const xr = xulRuntime?.classes?.[
      "@mozilla.org/xre/app-info;1"
    ]?.getService?.(xulRuntime?.interfaces?.nsIXULRuntime as unknown);
    osName = (xr?.OS || "").toLowerCase();
  } catch {
    /* ignore */
  }

  if (osName === "winnt") return "C:\\Windows\\System32\\curl.exe";
  if (osName === "darwin") return "/usr/bin/curl";
  if (osName === "linux") return "/usr/bin/curl";

  // Fallback: try platform string from Zotero
  try {
    const platform =
      (Zotero as unknown as { platform?: string }).platform || "";
    if (/win/i.test(platform)) return "C:\\Windows\\System32\\curl.exe";
  } catch {
    /* ignore */
  }

  return "/usr/bin/curl";
}

function getSubprocess(): any | null {
  try {
    const CU = (globalThis as any).ChromeUtils;
    if (CU?.importESModule) {
      try {
        const mod = CU.importESModule(
          "resource://gre/modules/Subprocess.sys.mjs",
        );
        return mod.Subprocess || mod.default || mod;
      } catch {
        /* fallback */
      }
    }
    if (CU?.import) {
      try {
        const mod = CU.import("resource://gre/modules/Subprocess.jsm");
        return mod.Subprocess || mod;
      } catch {
        /* fallback */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Run curl with the given args. Tries Subprocess.call first (no console window
 * on Windows), falls back to nsIProcess.
 * Returns the process exit code, or -1 on failure/timeout.
 */
async function runCurl(args: string[], timeoutMs = 300000): Promise<number> {
  const curlPath = getCurlPath();
  if (!curlPath) return -1;

  // Try Subprocess.call first — suppresses console window on Windows
  const Subprocess = getSubprocess();
  if (Subprocess?.call) {
    try {
      const proc = await Subprocess.call({
        command: curlPath,
        arguments: args,
      });
      const drain = async (pipe: any) => {
        if (!pipe?.readString) return;
        try {
          while (await pipe.readString()) {
            /* discard */
          }
        } catch {
          /* pipe closed */
        }
      };
      const resultPromise = (async () => {
        await Promise.all([drain(proc.stdout), drain(proc.stderr)]);
        const { exitCode } = await proc.wait();
        return exitCode as number;
      })();
      const race = await Promise.race([
        resultPromise,
        new Promise<"timeout">((r) =>
          setTimeout(() => r("timeout"), timeoutMs),
        ),
      ]);
      if (race === "timeout") {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        return -1;
      }
      return race;
    } catch (e) {
      ztoolkit.log(
        `runCurl Subprocess.call failed: ${(e as Error).message}, falling back to nsIProcess`,
      );
    }
  }

  // Fallback: nsIProcess (shows console on Windows, but works everywhere)
  try {
    const Cc = (
      globalThis as {
        Components?: {
          classes?: Record<
            string,
            { createInstance: (iface: unknown) => unknown }
          >;
        };
      }
    ).Components?.classes;
    const Ci = (
      globalThis as { Components?: { interfaces?: Record<string, unknown> } }
    ).Components?.interfaces;
    if (!Cc || !Ci) return -1;

    const localFile = Cc["@mozilla.org/file/local;1"]?.createInstance(
      Ci.nsIFile as unknown,
    ) as
      | {
          initWithPath?: (path: string) => void;
          exists?: () => boolean;
        }
      | undefined;
    if (!localFile?.initWithPath) return -1;
    localFile.initWithPath(curlPath);
    if (localFile.exists && !localFile.exists()) return -1;

    const process = Cc["@mozilla.org/process/util;1"]?.createInstance(
      Ci.nsIProcess as unknown,
    ) as
      | {
          init?: (executable: unknown) => void;
          run?: (blocking: boolean, args: string[], count: number) => void;
          runAsync?: (args: string[], count: number, observer: unknown) => void;
          exitValue?: number;
        }
      | undefined;
    if (!process?.init) return -1;
    process.init(localFile);

    if (!process.runAsync) {
      process.run?.(true, args, args.length);
      return process.exitValue ?? -1;
    }

    return new Promise<number>((resolve) => {
      const observer = {
        observe(_subject: unknown, topic: string) {
          resolve(
            topic === "process-finished" ? (process.exitValue ?? -1) : -1,
          );
        },
        QueryInterface: () => observer,
      };
      process.runAsync!(args, args.length, observer);
    });
  } catch (e) {
    ztoolkit.log(`runCurl nsIProcess fallback failed: ${(e as Error).message}`);
    return -1;
  }
}

async function uploadViaCurl(
  url: string,
  pdfPath: string,
  pdfBytes: Uint8Array,
): Promise<{ status: number }> {
  // Use the system's curl binary to upload the PDF. This bypasses Zotero's
  // Firefox ESR network stack which cannot connect to Alibaba Cloud OSS.
  //
  // We copy the PDF to a temp file with an ASCII-only name to avoid
  // curl read errors from unicode characters in the original path (exit 26).
  const Cc = (
    globalThis as {
      Components?: {
        classes?: Record<
          string,
          { createInstance: (iface: unknown) => unknown }
        >;
      };
    }
  ).Components?.classes;
  const Ci = (
    globalThis as { Components?: { interfaces?: Record<string, unknown> } }
  ).Components?.interfaces;
  if (!Cc || !Ci) {
    ztoolkit.log("MinerU upload [curl]: Components unavailable");
    return { status: 0 };
  }

  // Write PDF to a temp file with an ASCII-safe name
  let uploadPath = pdfPath;
  let tempUploadPath: string | null = null;
  try {
    const dirService = (
      Cc["@mozilla.org/file/directory_service;1"] as unknown as {
        getService?: (iface: unknown) => {
          get?: (prop: string, iface: unknown) => { path?: string };
        };
      }
    )?.getService?.(Ci.nsIProperties as unknown);
    const tempDir = dirService?.get?.("TmpD", Ci.nsIFile as unknown);
    if (tempDir?.path) {
      const sep = tempDir.path.includes("\\") ? "\\" : "/";
      tempUploadPath = `${tempDir.path}${sep}mineru_upload_${Date.now()}.pdf`;
      const io = getIOUtils();
      if (io?.write) {
        await io.write(tempUploadPath, pdfBytes);
        uploadPath = tempUploadPath;
      } else {
        const osFile = getOSFile();
        if (
          (
            osFile as {
              writeAtomic?: (path: string, data: Uint8Array) => Promise<void>;
            }
          )?.writeAtomic
        ) {
          await (
            osFile as {
              writeAtomic: (path: string, data: Uint8Array) => Promise<void>;
            }
          ).writeAtomic(tempUploadPath, pdfBytes);
          uploadPath = tempUploadPath;
        }
      }
    }
  } catch (e) {
    ztoolkit.log(
      `MinerU upload [curl]: temp file write failed: ${(e as Error).message}, using original path`,
    );
  }

  const cleanupTemp = () => {
    if (tempUploadPath && uploadPath === tempUploadPath) {
      try {
        const ioFull = (
          globalThis as unknown as {
            IOUtils?: { remove?: (path: string) => Promise<void> };
          }
        ).IOUtils;
        ioFull?.remove?.(tempUploadPath);
      } catch {
        /* ignore */
      }
    }
  };

  const exitCode = await runCurl(
    ["-s", "-f", "-T", uploadPath, "--max-time", "180", "--url", url],
    200000,
  );
  cleanupTemp();

  if (exitCode === 0) {
    ztoolkit.log("MinerU upload [curl]: success (exit=0)");
    return { status: 200 };
  }
  ztoolkit.log(`MinerU upload [curl]: failed exit=${exitCode}`);
  return { status: 0 };
}

async function httpPutBinary(
  url: string,
  headers: Record<string, string>,
  pdfPath: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<{ status: number }> {
  throwIfAborted(signal);

  const urlHost = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "unknown";
    }
  })();

  // Attempt 1: curl (uses system TLS stack, works for Alibaba Cloud OSS)
  const curlResult = await uploadViaCurl(url, pdfPath, bytes);
  if (curlResult.status >= 200 && curlResult.status < 300) {
    return curlResult;
  }
  throwIfAborted(signal);

  // Attempt 2: fetch (with timeout)
  try {
    const fetchFn = ztoolkit.getGlobal("fetch") as typeof fetch;
    const AbortCtrl =
      (globalThis as { AbortController?: typeof AbortController })
        .AbortController ??
      (ztoolkit.getGlobal("AbortController") as
        | typeof AbortController
        | undefined);
    let fetchSignal: AbortSignal | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (AbortCtrl) {
      const ctrl = new AbortCtrl();
      fetchSignal = ctrl.signal;
      timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS * 3);
      // Also abort if the parent signal fires
      signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
    const resp = await fetchFn(url, {
      method: "PUT",
      headers,
      body: new Uint8Array(bytes),
      signal: fetchSignal,
    });
    if (timer) clearTimeout(timer);
    ztoolkit.log(
      `MinerU upload [fetch]: status=${resp.status} host=${urlHost}`,
    );
    return { status: resp.status };
  } catch (e) {
    if (signal?.aborted) throw new MineruCancelledError();
    ztoolkit.log(
      `MinerU upload [fetch] threw: ${(e as Error).message} host=${urlHost}`,
    );
  }

  throwIfAborted(signal);

  // Attempt 3: Zotero.HTTP.request
  try {
    const xhr = await Zotero.HTTP.request("PUT", url, {
      headers,
      body: new Uint8Array(bytes),
      successCodes: false,
      timeout: REQUEST_TIMEOUT_MS * 2,
      errorDelayMax: 0,
    });
    ztoolkit.log(
      `MinerU upload [Zotero.HTTP]: status=${xhr.status} host=${urlHost}`,
    );
    if (xhr.status > 0) return { status: xhr.status };
  } catch (e) {
    if (signal?.aborted) throw new MineruCancelledError();
    ztoolkit.log(
      `MinerU upload [Zotero.HTTP] threw: ${(e as Error).message} host=${urlHost}`,
    );
  }

  return { status: 0 };
}

export function buildCloudBatchRequestBody(params: {
  fileName: string;
  modelVersion?: MineruCloudModel;
  forceOcr?: boolean;
}): {
  enable_formula: true;
  enable_table: true;
  language: "ch";
  model_version: MineruCloudModel;
  files: Array<{ name: string; is_ocr: boolean }>;
} {
  return {
    enable_formula: true,
    enable_table: true,
    language: "ch",
    model_version: params.modelVersion ?? DEFAULT_MINERU_CLOUD_MODEL,
    files: [{ name: params.fileName, is_ocr: params.forceOcr === true }],
  };
}

async function parsePdfViaUpload(
  pdfPath: string,
  apiKey: string,
  modelVersion: MineruCloudModel,
  forceOcr: boolean,
  report: (s: string) => void,
  signal?: AbortSignal,
): Promise<MinerUResult> {
  throwIfAborted(signal);
  report(t("Reading PDF file…"));
  const pdfBytes = await readPdfBytes(pdfPath);
  if (!pdfBytes || !pdfBytes.length) {
    report(t("PDF file is empty or unreadable"));
    return null;
  }

  // Sanitize filename to ASCII — MinerU's backend may not handle unicode names
  const rawName = pdfPath.split(/[\\/]/).pop() || "paper.pdf";
  const fileName = rawName.replace(/[^\x20-\x7E]/g, "_") || "paper.pdf";
  const sizeMB = (pdfBytes.length / (1024 * 1024)).toFixed(1);
  throwIfAborted(signal);
  report(t("Requesting upload URL… (%s MB)").replace("%s", sizeMB));

  const batchResult = await httpJson(
    "POST",
    `${getMineruApiBase()}/file-urls/batch`,
    {
      ...getMineruAuthHeaders(apiKey),
      "Content-Type": "application/json",
    },
    JSON.stringify(
      buildCloudBatchRequestBody({ fileName, modelVersion, forceOcr }),
    ),
  );

  if (batchResult.status === 429) {
    throw new MineruRateLimitError("MinerU daily quota exceeded (HTTP 429)");
  }
  if (batchResult.status < 200 || batchResult.status >= 300) {
    const respMsg =
      typeof (batchResult.data as { msg?: string })?.msg === "string"
        ? (batchResult.data as { msg: string }).msg
        : "";
    if (/rate.?limit|quota|exceeded|limit.*reached/i.test(respMsg)) {
      throw new MineruRateLimitError(`MinerU rate limit: ${respMsg}`);
    }
    report(
      t("Batch request failed: HTTP %s").replace("%s", `${batchResult.status}`),
    );
    return null;
  }

  const batchData = batchResult.data as {
    data?: { batch_id?: string; file_urls?: string[] };
  } | null;
  const batchId = batchData?.data?.batch_id;
  const fileUrls = batchData?.data?.file_urls;

  if (!batchId || !fileUrls?.length) {
    report(t("Missing batch_id or file_urls in response"));
    return null;
  }

  throwIfAborted(signal);
  report(t("Uploading PDF…"));
  // Do NOT send Content-Type — the presigned URL's signature may not include it,
  // and adding it would cause Alibaba OSS to return 403.
  // Race the entire upload chain against the abort signal so pause/stop
  // takes effect immediately, even while curl is blocked.
  const uploadResult = await raceAbort(
    httpPutBinary(fileUrls[0], {}, pdfPath, pdfBytes, signal),
    signal,
  );

  if (uploadResult.status < 200 || uploadResult.status >= 300) {
    const uploadHost = (() => {
      try {
        return new URL(fileUrls[0]).host;
      } catch {
        return fileUrls[0].slice(0, 80);
      }
    })();
    report(
      t("Upload failed: HTTP %s to %s")
        .replace("%s", `${uploadResult.status}`)
        .replace("%s", uploadHost),
    );
    return null;
  }

  report(t("Waiting for MinerU to start…"));
  const pollStartMs = Date.now();
  let lastStatusAtMs: number | null = null;
  let activeStartedAtMs: number | null = null;
  while (true) {
    const waitDecision = getMineruCloudPollDecision({
      state: null,
      nowMs: Date.now(),
      pollStartMs,
      lastStatusAtMs,
      activeStartedAtMs,
    });
    if (waitDecision.action === "timeout") {
      report(
        waitDecision.reason === "no_status"
          ? t("Timed out waiting for MinerU status")
          : t("Timed out before MinerU started processing"),
      );
      return null;
    }

    await sleep(waitDecision.pollIntervalMs, signal);
    const pollTimeMs = Date.now();
    const elapsed = Math.round((pollTimeMs - pollStartMs) / 1000);

    const pollResult = await httpJson(
      "GET",
      `${getMineruApiBase()}/extract-results/batch/${batchId}`,
      getMineruAuthHeaders(apiKey),
    );

    if (pollResult.status < 200 || pollResult.status >= 300) {
      ztoolkit.log(`MinerU: poll HTTP ${pollResult.status}`);
      continue;
    }

    const pollData = pollResult.data as {
      data?: {
        extract_result?: Array<{ state?: string; full_zip_url?: string }>;
      };
    } | null;
    const extractResult = pollData?.data?.extract_result?.[0];
    if (!extractResult) {
      ztoolkit.log(
        `MinerU: poll response has no extract_result: ${JSON.stringify(pollResult.data).slice(0, 200)}`,
      );
      report(t("Waiting for MinerU status… (%ss)").replace("%s", `${elapsed}`));
      continue;
    }

    const state = normalizeMineruCloudState(extractResult.state);
    if (!state) {
      ztoolkit.log(
        `MinerU: poll response has empty state: ${JSON.stringify(pollResult.data).slice(0, 200)}`,
      );
      report(t("Waiting for MinerU status… (%ss)").replace("%s", `${elapsed}`));
      continue;
    }

    lastStatusAtMs = pollTimeMs;
    if (isMineruCloudActiveState(state) && activeStartedAtMs === null) {
      activeStartedAtMs = pollTimeMs;
    }

    ztoolkit.log(`MinerU: poll state="${state}"`);

    if (state === "done") {
      if (!extractResult.full_zip_url) {
        report(t("Missing ZIP result from server"));
        return null;
      }
      const extracted = await downloadAndExtractZip(
        extractResult.full_zip_url,
        report,
      );
      if (extracted.ok) {
        report(
          t("Done (%s files extracted)").replace(
            "%s",
            `${extracted.files.length}`,
          ),
        );
        return { mdContent: extracted.mdContent, files: extracted.files };
      }
      report(extracted.message);
      logMineruZipFailure(extracted.download, extracted.zipInspection);
      return null;
    }

    if (state === "failed") {
      report(t("Extraction failed on server"));
      return null;
    }

    const stateDecision = getMineruCloudPollDecision({
      state,
      nowMs: pollTimeMs,
      pollStartMs,
      lastStatusAtMs,
      activeStartedAtMs,
    });
    if (stateDecision.action === "timeout") {
      report(
        stateDecision.reason === "no_status"
          ? t("Timed out waiting for MinerU status")
          : t("Timed out before MinerU started processing"),
      );
      return null;
    }

    report(buildMineruCloudProgressMessage(state, elapsed));
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function parsePdfWithMineruCloud(
  pdfPath: string,
  apiKey: string,
  modelVersion: MineruCloudModel = DEFAULT_MINERU_CLOUD_MODEL,
  onProgress?: MinerUProgressCallback,
  signal?: AbortSignal,
  forceOcr = DEFAULT_MINERU_FORCE_OCR,
): Promise<MinerUResult> {
  const report = (stage: string) => {
    ztoolkit.log(`MinerU: ${stage}`);
    onProgress?.(stage);
  };
  try {
    if (!apiKey.trim()) {
      report(t("MinerU API key required. Add it in Settings."));
      return null;
    }
    return await parsePdfViaUpload(
      pdfPath,
      apiKey.trim(),
      modelVersion,
      forceOcr,
      report,
      signal,
    );
  } catch (e) {
    if (e instanceof MineruRateLimitError) throw e;
    if (e instanceof MineruCancelledError) throw e;
    report(`Error: ${(e as Error).message}`);
    return null;
  }
}

export async function parsePdfWithMineruLocal(
  pdfPath: string,
  baseUrl: string,
  backend: MineruLocalBackend,
  onProgress?: MinerUProgressCallback,
  signal?: AbortSignal,
  forceOcr = DEFAULT_MINERU_FORCE_OCR,
): Promise<MinerUResult> {
  const report = (stage: string) => {
    ztoolkit.log(`MinerU local: ${stage}`);
    onProgress?.(stage);
  };
  try {
    return await parsePdfViaLocalFileParse(
      pdfPath,
      baseUrl,
      backend,
      forceOcr,
      report,
      signal,
    );
  } catch (e) {
    if (e instanceof MineruCancelledError) throw e;
    report(`Error: ${(e as Error).message}`);
    return null;
  }
}

export async function parsePdfWithMineru(
  pdfPath: string,
  onProgress?: MinerUProgressCallback,
  signal?: AbortSignal,
): Promise<MinerUResult> {
  const forceOcr = isMineruForceOcrEnabled();
  if (getMineruMode() === "local") {
    return parsePdfWithMineruLocal(
      pdfPath,
      getMineruLocalApiBase(),
      getMineruLocalBackend(),
      onProgress,
      signal,
      forceOcr,
    );
  }
  return parsePdfWithMineruCloud(
    pdfPath,
    getMineruApiKey(),
    getMineruCloudModel(),
    onProgress,
    signal,
    forceOcr,
  );
}

/**
 * Quick curl-based connectivity test to an OSS URL.
 * Uses curl without -f so even a 403 (expected) counts as success.
 * Returns true if curl can reach the host.
 */
async function testOssViaCurl(ossUrl: string): Promise<boolean> {
  // -s: silent, -o /dev/null: discard body, --max-time 10: timeout
  // No -f: we want exit 0 even on 403 (proves connectivity)
  const devNull = (getCurlPath() || "").includes("\\") ? "NUL" : "/dev/null";
  const exitCode = await runCurl(
    ["-s", "-o", devNull, "--max-time", "10", "--head", "--url", ossUrl],
    15000,
  );
  return exitCode === 0;
}

export async function testMineruConnection(apiKey: string): Promise<void> {
  const result = await httpJson(
    "GET",
    `${getMineruApiBase()}/extract-results/batch/_test`,
    getMineruAuthHeaders(apiKey),
  );
  if (result.status === 401 || result.status === 403) {
    throw new Error("Invalid API key — authentication failed");
  }

  // Also verify connectivity to Alibaba Cloud OSS (used for upload/download).
  // A HEAD request to the OSS endpoint will return 403 (no valid signature),
  // but that proves the TLS connection works. Status 0 = network/TLS failure.
  const ossTestUrl = "https://mineru.oss-cn-shanghai.aliyuncs.com";
  let ossReachable = false;

  // Attempt 1: fetch with timeout
  try {
    const fetchFn = ztoolkit.getGlobal("fetch") as typeof fetch;
    const AbortCtrl =
      (globalThis as { AbortController?: typeof AbortController })
        .AbortController ??
      (ztoolkit.getGlobal("AbortController") as
        | typeof AbortController
        | undefined);
    let signal: AbortSignal | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (AbortCtrl) {
      const ctrl = new AbortCtrl();
      signal = ctrl.signal;
      timer = setTimeout(() => ctrl.abort(), 10000);
    }
    const resp = await fetchFn(ossTestUrl, { method: "HEAD", signal });
    if (timer) clearTimeout(timer);
    // Any HTTP status (even 403) means the connection succeeded
    ossReachable = resp.status > 0;
  } catch {
    /* fall through */
  }

  // Attempt 2: Zotero.HTTP
  if (!ossReachable) {
    try {
      const xhr = await Zotero.HTTP.request("HEAD", ossTestUrl, {
        successCodes: false,
        timeout: 10000,
      });
      ossReachable = xhr.status > 0;
    } catch {
      /* fall through */
    }
  }

  // Attempt 3: curl (the actual upload/download path uses curl, so test that too)
  if (!ossReachable) {
    ossReachable = await testOssViaCurl(ossTestUrl);
  }

  if (!ossReachable) {
    throw new Error(
      "API key is valid, but cannot reach Alibaba Cloud OSS (mineru.oss-cn-shanghai.aliyuncs.com). " +
        "This may be caused by your network environment. MinerU parsing will likely fail.",
    );
  }
}

export async function testMineruLocalConnection(
  baseUrl: string,
): Promise<void> {
  const url = joinApiPath(baseUrl, "/health");
  const response = await fetchWithTimeout(
    url,
    { method: "GET" },
    undefined,
    10000,
    t("Local MinerU health check timed out"),
  );
  if (!response.ok) {
    throw new Error(
      t("Local MinerU health check failed: HTTP %s").replace(
        "%s",
        `${response.status}`,
      ),
    );
  }
}
