const MINERU_DIRECT_API_BASE = "https://mineru.net/api/v4";
const MINERU_PROXY_API_BASE = "https://llm-for-zotero.ylwwayne.workers.dev/api/v4";

/**
 * When the user provides their own API key, call mineru.net directly.
 * Otherwise, use the community proxy (which injects the shared key server-side).
 */
function getMineruApiBase(apiKey: string): string {
  return apiKey ? MINERU_DIRECT_API_BASE : MINERU_PROXY_API_BASE;
}

function getMineruAuthHeaders(apiKey: string): Record<string, string> {
  // When using the proxy, no Authorization header needed — the proxy injects it
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60000;

export type MinerUExtractedFile = {
  relativePath: string;
  data: Uint8Array;
};

export type MinerUResult = {
  mdContent: string;
  files: MinerUExtractedFile[];
} | null;

export type MinerUProgressCallback = (stage: string) => void;

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

/** Race a promise against an AbortSignal — rejects immediately when aborted. */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new MineruCancelledError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new MineruCancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
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

function getIOUtils(): IOUtilsLike | undefined {
  return (globalThis as unknown as { IOUtils?: IOUtilsLike }).IOUtils;
}

function getOSFile(): OSFileLike | undefined {
  return (globalThis as { OS?: { File?: OSFileLike } }).OS?.File;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new MineruCancelledError()); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new MineruCancelledError()); }, { once: true });
  });
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
    const Cc = (globalThis as { Components?: { classes?: Record<string, { createInstance: (iface: unknown) => unknown }> } }).Components?.classes;
    const Ci = (globalThis as { Components?: { interfaces?: Record<string, unknown> } }).Components?.interfaces;
    if (!Cc || !Ci) return null;

    const dirService = (Cc["@mozilla.org/file/directory_service;1"] as unknown as {
      getService?: (iface: unknown) => { get?: (prop: string, iface: unknown) => { path?: string } };
    })?.getService?.(Ci.nsIProperties as unknown);
    const tempDir = dirService?.get?.("TmpD", Ci.nsIFile as unknown);
    if (!tempDir?.path) {
      ztoolkit.log("MinerU download [curl]: cannot resolve temp directory");
      return null;
    }

    const outPath = `${tempDir.path}${tempDir.path.includes("\\") ? "\\" : "/"}mineru_dl_${Date.now()}.bin`;
    const exitCode = await runCurl(["-s", "-f", "-o", outPath, "--max-time", "300", "-L", "--url", url]);

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
          const ioFull = (globalThis as unknown as {
            IOUtils?: { remove?: (path: string) => Promise<void> };
          }).IOUtils;
          await ioFull?.remove?.(outPath);
        } catch { /* ignore */ }
        return data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      }
      const osFile = getOSFile();
      if (osFile?.read) {
        const data = await osFile.read(outPath);
        return data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      }
    } catch { /* ignore */ }
    return null;
  } catch (e) {
    ztoolkit.log(`MinerU download [curl] threw: ${(e as Error).message}`);
    return null;
  }
}

async function httpGetBinary(url: string): Promise<Uint8Array | null> {
  // Try fetch first (works for cloud storage/CDN URLs with CORS),
  // fall back to Zotero.HTTP.request, then curl.
  try {
    const fetchFn = ztoolkit.getGlobal("fetch") as typeof fetch;
    const resp = await fetchFn(url);
    if (resp.ok) {
      return new Uint8Array(await resp.arrayBuffer());
    }
  } catch {
    /* fall through */
  }
  try {
    const xhr = await Zotero.HTTP.request("GET", url, {
      responseType: "arraybuffer",
      successCodes: false,
      timeout: REQUEST_TIMEOUT_MS * 2,
      errorDelayMax: 0,
    });
    if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
      return new Uint8Array(xhr.response as ArrayBuffer);
    }
  } catch {
    /* fall through */
  }
  // Attempt 3: curl (bypasses Firefox ESR TLS issues with Alibaba Cloud OSS)
  const curlBytes = await downloadViaCurl(url);
  if (curlBytes) return curlBytes;
  return null;
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

// ── ZIP extraction ────────────────────────────────────────────────────────────

function findEOCD(zipBytes: Uint8Array): number {
  const minOffset = Math.max(0, zipBytes.length - 65557);
  for (let i = zipBytes.length - 22; i >= minOffset; i--) {
    if (
      zipBytes[i] === 0x50 &&
      zipBytes[i + 1] === 0x4b &&
      zipBytes[i + 2] === 0x05 &&
      zipBytes[i + 3] === 0x06
    ) {
      return i;
    }
  }
  return -1;
}

async function decompressDeflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const DecompStream =
    (globalThis as { DecompressionStream?: typeof DecompressionStream })
      .DecompressionStream ??
    (ztoolkit.getGlobal("DecompressionStream") as
      | typeof DecompressionStream
      | undefined);
  if (!DecompStream) {
    throw new Error("DecompressionStream unavailable");
  }
  const ds = new DecompStream("deflate-raw");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader() as {
    read: () => Promise<{ done: boolean; value?: ArrayBuffer }>;
  };
  writer.write(data);
  writer.close();

  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(new Uint8Array(value as ArrayBuffer));
  }
  let totalLen = 0;
  for (const c of chunks) totalLen += c.length;
  const result = new Uint8Array(totalLen);
  let off = 0;
  for (const c of chunks) {
    result.set(c, off);
    off += c.length;
  }
  return result;
}

async function extractAllFromZip(
  zipBytes: Uint8Array,
): Promise<{ mdContent: string | null; files: MinerUExtractedFile[] }> {
  const eocdOffset = findEOCD(zipBytes);
  if (eocdOffset < 0) return { mdContent: null, files: [] };

  const view = new DataView(
    zipBytes.buffer,
    zipBytes.byteOffset,
    zipBytes.byteLength,
  );
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const cdEntries = view.getUint16(eocdOffset + 10, true);

  const files: MinerUExtractedFile[] = [];
  let mdContent: string | null = null;
  let offset = cdOffset;

  for (let i = 0; i < cdEntries; i++) {
    if (offset + 46 > zipBytes.length) break;
    const sig = view.getUint32(offset, true);
    if (sig !== 0x02014b50) break;

    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraFieldLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);

    const fileNameBytes = zipBytes.subarray(
      offset + 46,
      offset + 46 + fileNameLength,
    );
    const fileName = new TextDecoder().decode(fileNameBytes);

    // Skip directories and macOS metadata
    if (!fileName.endsWith("/") && !fileName.startsWith("__MACOSX/")) {
      const localNameLen = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const compressedData = zipBytes.subarray(
        dataStart,
        dataStart + compressedSize,
      );

      let fileData: Uint8Array | null = null;
      if (compressionMethod === 0) {
        fileData = new Uint8Array(compressedData);
      } else if (compressionMethod === 8) {
        try {
          fileData = await decompressDeflateRaw(compressedData);
        } catch (e) {
          ztoolkit.log(
            `MinerU: failed to decompress ${fileName}: ${(e as Error).message}`,
          );
        }
      } else {
        ztoolkit.log(
          `MinerU: unsupported ZIP compression method ${compressionMethod} for ${fileName}`,
        );
      }

      if (fileData) {
        files.push({ relativePath: fileName, data: fileData });
        if (fileName.endsWith(".md") && !mdContent) {
          mdContent = new TextDecoder("utf-8").decode(fileData);
        }
      }
    }

    offset += 46 + fileNameLength + extraFieldLength + commentLength;
  }

  return { mdContent, files };
}

async function downloadAndExtractZip(
  zipUrl: string,
  report: (s: string) => void,
): Promise<{ mdContent: string | null; files: MinerUExtractedFile[] } | null> {
  report("Downloading results…");
  const zipBytes = await httpGetBinary(zipUrl);
  if (!zipBytes) {
    report("Failed to download ZIP result");
    return null;
  }
  report("Extracting files…");
  return extractAllFromZip(zipBytes);
}

// ── Presigned URL upload workflow ──────────────────────────────────────────────

function getCurlPath(): string | null {
  const xulRuntime = (globalThis as {
    Components?: {
      classes?: Record<string, { getService?: (iface: unknown) => { OS?: string } }>;
      interfaces?: Record<string, unknown>;
    };
  }).Components;
  let osName = "";
  try {
    const xr = xulRuntime?.classes?.["@mozilla.org/xre/app-info;1"]
      ?.getService?.(xulRuntime?.interfaces?.nsIXULRuntime as unknown);
    osName = (xr?.OS || "").toLowerCase();
  } catch { /* ignore */ }

  if (osName === "winnt") return "C:\\Windows\\System32\\curl.exe";
  if (osName === "darwin") return "/usr/bin/curl";
  if (osName === "linux") return "/usr/bin/curl";

  // Fallback: try platform string from Zotero
  try {
    const platform = (Zotero as unknown as { platform?: string }).platform || "";
    if (/win/i.test(platform)) return "C:\\Windows\\System32\\curl.exe";
  } catch { /* ignore */ }

  return "/usr/bin/curl";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getSubprocess(): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const CU = (globalThis as any).ChromeUtils;
    if (CU?.importESModule) {
      try {
        const mod = CU.importESModule("resource://gre/modules/Subprocess.sys.mjs");
        return mod.Subprocess || mod.default || mod;
      } catch { /* fallback */ }
    }
    if (CU?.import) {
      try {
        const mod = CU.import("resource://gre/modules/Subprocess.jsm");
        return mod.Subprocess || mod;
      } catch { /* fallback */ }
    }
  } catch { /* ignore */ }
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
        environment: {},
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const drain = async (pipe: any) => {
        if (!pipe?.readString) return;
        try { while (await pipe.readString()) { /* discard */ } } catch { /* pipe closed */ }
      };
      const resultPromise = (async () => {
        await Promise.all([drain(proc.stdout), drain(proc.stderr)]);
        const { exitCode } = await proc.wait();
        return exitCode as number;
      })();
      const race = await Promise.race([
        resultPromise,
        new Promise<"timeout">(r => setTimeout(() => r("timeout"), timeoutMs)),
      ]);
      if (race === "timeout") {
        try { proc.kill(); } catch { /* ignore */ }
        return -1;
      }
      return race;
    } catch (e) {
      ztoolkit.log(`runCurl Subprocess.call failed: ${(e as Error).message}, falling back to nsIProcess`);
    }
  }

  // Fallback: nsIProcess (shows console on Windows, but works everywhere)
  try {
    const Cc = (globalThis as { Components?: { classes?: Record<string, { createInstance: (iface: unknown) => unknown }> } }).Components?.classes;
    const Ci = (globalThis as { Components?: { interfaces?: Record<string, unknown> } }).Components?.interfaces;
    if (!Cc || !Ci) return -1;

    const localFile = Cc["@mozilla.org/file/local;1"]?.createInstance(Ci.nsIFile as unknown) as {
      initWithPath?: (path: string) => void;
      exists?: () => boolean;
    } | undefined;
    if (!localFile?.initWithPath) return -1;
    localFile.initWithPath(curlPath);
    if (localFile.exists && !localFile.exists()) return -1;

    const process = Cc["@mozilla.org/process/util;1"]?.createInstance(Ci.nsIProcess as unknown) as {
      init?: (executable: unknown) => void;
      run?: (blocking: boolean, args: string[], count: number) => void;
      runAsync?: (args: string[], count: number, observer: unknown) => void;
      exitValue?: number;
    } | undefined;
    if (!process?.init) return -1;
    process.init(localFile);

    if (!process.runAsync) {
      process.run?.(true, args, args.length);
      return process.exitValue ?? -1;
    }

    return new Promise<number>((resolve) => {
      const observer = {
        observe(_subject: unknown, topic: string) {
          resolve(topic === "process-finished" ? (process.exitValue ?? -1) : -1);
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
  const Cc = (globalThis as { Components?: { classes?: Record<string, { createInstance: (iface: unknown) => unknown }> } }).Components?.classes;
  const Ci = (globalThis as { Components?: { interfaces?: Record<string, unknown> } }).Components?.interfaces;
  if (!Cc || !Ci) {
    ztoolkit.log("MinerU upload [curl]: Components unavailable");
    return { status: 0 };
  }

  // Write PDF to a temp file with an ASCII-safe name
  let uploadPath = pdfPath;
  let tempUploadPath: string | null = null;
  try {
    const dirService = (Cc["@mozilla.org/file/directory_service;1"] as unknown as {
      getService?: (iface: unknown) => { get?: (prop: string, iface: unknown) => { path?: string } };
    })?.getService?.(Ci.nsIProperties as unknown);
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
        if ((osFile as { writeAtomic?: (path: string, data: Uint8Array) => Promise<void> })?.writeAtomic) {
          await (osFile as { writeAtomic: (path: string, data: Uint8Array) => Promise<void> }).writeAtomic(tempUploadPath, pdfBytes);
          uploadPath = tempUploadPath;
        }
      }
    }
  } catch (e) {
    ztoolkit.log(`MinerU upload [curl]: temp file write failed: ${(e as Error).message}, using original path`);
  }

  const cleanupTemp = () => {
    if (tempUploadPath && uploadPath === tempUploadPath) {
      try {
        const ioFull = (globalThis as unknown as {
          IOUtils?: { remove?: (path: string) => Promise<void> };
        }).IOUtils;
        ioFull?.remove?.(tempUploadPath);
      } catch { /* ignore */ }
    }
  };

  const exitCode = await runCurl(["-s", "-f", "-T", uploadPath, "--max-time", "180", "--url", url], 200000);
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
    try { return new URL(url).host; } catch { return "unknown"; }
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
    const AbortCtrl = (globalThis as { AbortController?: typeof AbortController }).AbortController
      ?? ztoolkit.getGlobal("AbortController") as typeof AbortController | undefined;
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
    ztoolkit.log(`MinerU upload [fetch]: status=${resp.status} host=${urlHost}`);
    return { status: resp.status };
  } catch (e) {
    if (signal?.aborted) throw new MineruCancelledError();
    ztoolkit.log(`MinerU upload [fetch] threw: ${(e as Error).message} host=${urlHost}`);
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
    ztoolkit.log(`MinerU upload [Zotero.HTTP]: status=${xhr.status} host=${urlHost}`);
    if (xhr.status > 0) return { status: xhr.status };
  } catch (e) {
    if (signal?.aborted) throw new MineruCancelledError();
    ztoolkit.log(`MinerU upload [Zotero.HTTP] threw: ${(e as Error).message} host=${urlHost}`);
  }

  return { status: 0 };
}

async function parsePdfViaUpload(
  pdfPath: string,
  apiKey: string,
  report: (s: string) => void,
  signal?: AbortSignal,
): Promise<MinerUResult> {
  throwIfAborted(signal);
  report("Reading PDF file…");
  const pdfBytes = await readPdfBytes(pdfPath);
  if (!pdfBytes || !pdfBytes.length) {
    report("PDF file is empty or unreadable");
    return null;
  }

  // Sanitize filename to ASCII — MinerU's backend may not handle unicode names
  const rawName = pdfPath.split(/[\\/]/).pop() || "paper.pdf";
  const fileName = rawName.replace(/[^\x20-\x7E]/g, "_") || "paper.pdf";
  const sizeMB = (pdfBytes.length / (1024 * 1024)).toFixed(1);
  throwIfAborted(signal);
  report(`Requesting upload URL… (${sizeMB} MB)`);

  const batchResult = await httpJson(
    "POST",
    `${getMineruApiBase(apiKey)}/file-urls/batch`,
    {
      ...getMineruAuthHeaders(apiKey),
      "Content-Type": "application/json",
    },
    JSON.stringify({
      enable_formula: true,
      enable_table: true,
      language: "en",
      layout_model: "doclayout_yolo",
      enable_page_ocr: false,
      files: [{ name: fileName, is_ocr: false }],
    }),
  );

  if (batchResult.status === 429) {
    throw new MineruRateLimitError("MinerU daily quota exceeded (HTTP 429)");
  }
  if (batchResult.status < 200 || batchResult.status >= 300) {
    const respMsg = typeof (batchResult.data as { msg?: string })?.msg === "string"
      ? (batchResult.data as { msg: string }).msg : "";
    if (/rate.?limit|quota|exceeded|limit.*reached/i.test(respMsg)) {
      throw new MineruRateLimitError(`MinerU rate limit: ${respMsg}`);
    }
    report(`Batch request failed: HTTP ${batchResult.status}`);
    return null;
  }

  const batchData = batchResult.data as {
    data?: { batch_id?: string; file_urls?: string[] };
  } | null;
  const batchId = batchData?.data?.batch_id;
  const fileUrls = batchData?.data?.file_urls;

  if (!batchId || !fileUrls?.length) {
    report("Missing batch_id or file_urls in response");
    return null;
  }

  throwIfAborted(signal);
  report("Uploading PDF…");
  // Do NOT send Content-Type — the presigned URL's signature may not include it,
  // and adding it would cause Alibaba OSS to return 403.
  // Race the entire upload chain against the abort signal so pause/stop
  // takes effect immediately, even while curl is blocked.
  const uploadResult = await raceAbort(httpPutBinary(
    fileUrls[0],
    {},
    pdfPath,
    pdfBytes,
    signal,
  ), signal);

  if (uploadResult.status < 200 || uploadResult.status >= 300) {
    const uploadHost = (() => {
      try { return new URL(fileUrls[0]).host; } catch { return fileUrls[0].slice(0, 80); }
    })();
    report(`Upload failed: HTTP ${uploadResult.status} to ${uploadHost}`);
    return null;
  }

  report("Processing on server…");
  const startTime = Date.now();
  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS, signal);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    report(`Processing on server… (${elapsed}s)`);

    const pollResult = await httpJson(
      "GET",
      `${getMineruApiBase(apiKey)}/extract-results/batch/${batchId}`,
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
      ztoolkit.log(`MinerU: poll response has no extract_result: ${JSON.stringify(pollResult.data).slice(0, 200)}`);
      continue;
    }

    ztoolkit.log(`MinerU: poll state="${extractResult.state}"`);

    if (extractResult.state === "done" && extractResult.full_zip_url) {
      const extracted = await downloadAndExtractZip(extractResult.full_zip_url, report);
      if (extracted?.mdContent) {
        report(`Done (${extracted.files.length} files extracted)`);
        return { mdContent: extracted.mdContent, files: extracted.files };
      }
      report("Failed to extract markdown from ZIP");
      return null;
    }

    if (extractResult.state === "failed") {
      report("Extraction failed on server");
      return null;
    }
  }

  report("Timed out after 10 minutes");
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function parsePdfWithMineruCloud(
  pdfPath: string,
  apiKey: string,
  onProgress?: MinerUProgressCallback,
  signal?: AbortSignal,
): Promise<MinerUResult> {
  const report = (stage: string) => {
    ztoolkit.log(`MinerU: ${stage}`);
    onProgress?.(stage);
  };
  try {
    return await parsePdfViaUpload(pdfPath, apiKey, report, signal);
  } catch (e) {
    if (e instanceof MineruRateLimitError) throw e;
    if (e instanceof MineruCancelledError) throw e;
    report(`Error: ${(e as Error).message}`);
    return null;
  }
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
  const exitCode = await runCurl(["-s", "-o", devNull, "--max-time", "10", "--head", "--url", ossUrl], 15000);
  return exitCode === 0;
}

export async function testMineruConnection(apiKey: string): Promise<void> {
  const result = await httpJson(
    "GET",
    `${getMineruApiBase(apiKey)}/extract-results/batch/_test`,
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
    const AbortCtrl = (globalThis as { AbortController?: typeof AbortController }).AbortController
      ?? ztoolkit.getGlobal("AbortController") as typeof AbortController | undefined;
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
  } catch { /* fall through */ }

  // Attempt 2: Zotero.HTTP
  if (!ossReachable) {
    try {
      const xhr = await Zotero.HTTP.request("HEAD", ossTestUrl, {
        successCodes: false,
        timeout: 10000,
      });
      ossReachable = xhr.status > 0;
    } catch { /* fall through */ }
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

/**
 * Test the community proxy connection (no user API key needed).
 */
export async function testProxyConnection(): Promise<void> {
  const result = await httpJson(
    "GET",
    `${MINERU_PROXY_API_BASE}/extract-results/batch/_test`,
    {},
  );
  if (result.status === 401 || result.status === 403) {
    throw new Error("Proxy authentication failed — please provide your own API key");
  }
}
