const MINERU_API_BASE = "https://mineru.net/api/v4";
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

type IOUtilsLike = {
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function httpGetBinary(url: string): Promise<Uint8Array | null> {
  // Try fetch first (works for cloud storage/CDN URLs with CORS),
  // fall back to Zotero.HTTP.request.
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

async function uploadViaCurl(
  url: string,
  pdfPath: string,
): Promise<{ status: number }> {
  // Use the system's curl binary to upload the PDF. This bypasses Zotero's
  // Firefox ESR network stack which cannot connect to Alibaba Cloud OSS.
  return new Promise((resolve) => {
    try {
      const Cc = (globalThis as { Components?: { classes?: Record<string, { createInstance: (iface: unknown) => unknown }> } }).Components?.classes;
      const Ci = (globalThis as { Components?: { interfaces?: Record<string, unknown> } }).Components?.interfaces;
      if (!Cc || !Ci) {
        ztoolkit.log("MinerU upload [curl]: Components unavailable");
        resolve({ status: 0 });
        return;
      }

      const localFile = Cc["@mozilla.org/file/local;1"]?.createInstance(Ci.nsIFile as unknown) as {
        initWithPath?: (path: string) => void;
      } | undefined;
      if (!localFile?.initWithPath) {
        ztoolkit.log("MinerU upload [curl]: nsIFile unavailable");
        resolve({ status: 0 });
        return;
      }
      localFile.initWithPath("/usr/bin/curl");

      const process = Cc["@mozilla.org/process/util;1"]?.createInstance(Ci.nsIProcess as unknown) as {
        init?: (executable: unknown) => void;
        run?: (blocking: boolean, args: string[], count: number) => void;
        exitValue?: number;
      } | undefined;
      if (!process?.init || !process.run) {
        ztoolkit.log("MinerU upload [curl]: nsIProcess unavailable");
        resolve({ status: 0 });
        return;
      }

      process.init(localFile);
      // -T: proper PUT file transfer (sets Content-Length, streams file)
      // -f: fail with exit code 22 on HTTP 4xx/5xx
      // -s: silent (no progress bar)
      // No Content-Type header — presigned URL signature may not expect one
      const args = [
        "-s", "-f",
        "-T", pdfPath,
        "--max-time", "180",
        url,
      ];
      // Use runAsync to avoid blocking the main thread
      const observer = {
        observe(_subject: unknown, topic: string) {
          const exitCode = (process as { exitValue?: number }).exitValue ?? -1;
          if (topic === "process-finished" && exitCode === 0) {
            ztoolkit.log("MinerU upload [curl]: success (exit=0)");
            resolve({ status: 200 });
          } else {
            ztoolkit.log(`MinerU upload [curl]: failed topic=${topic} exit=${exitCode}`);
            resolve({ status: 0 });
          }
        },
        QueryInterface: () => observer,
      };
      (process as { runAsync?: (args: string[], count: number, observer: unknown) => void })
        .runAsync?.(args, args.length, observer);
    } catch (e) {
      ztoolkit.log(`MinerU upload [curl] threw: ${(e as Error).message}`);
      resolve({ status: 0 });
    }
  });
}

async function httpPutBinary(
  url: string,
  headers: Record<string, string>,
  pdfPath: string,
  bytes: Uint8Array,
): Promise<{ status: number }> {
  const urlHost = (() => {
    try { return new URL(url).host; } catch { return "unknown"; }
  })();

  // Attempt 1: curl (uses system TLS stack, works for Alibaba Cloud OSS)
  const curlResult = await uploadViaCurl(url, pdfPath);
  if (curlResult.status >= 200 && curlResult.status < 300) {
    return curlResult;
  }

  // Attempt 2: fetch
  try {
    const fetchFn = ztoolkit.getGlobal("fetch") as typeof fetch;
    const resp = await fetchFn(url, {
      method: "PUT",
      headers,
      body: new Uint8Array(bytes),
    });
    ztoolkit.log(`MinerU upload [fetch]: status=${resp.status} host=${urlHost}`);
    return { status: resp.status };
  } catch (e) {
    ztoolkit.log(`MinerU upload [fetch] threw: ${(e as Error).message} host=${urlHost}`);
  }

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
    ztoolkit.log(`MinerU upload [Zotero.HTTP] threw: ${(e as Error).message} host=${urlHost}`);
  }

  return { status: 0 };
}

async function parsePdfViaUpload(
  pdfPath: string,
  apiKey: string,
  report: (s: string) => void,
): Promise<MinerUResult> {
  report("Reading PDF file…");
  const pdfBytes = await readPdfBytes(pdfPath);
  if (!pdfBytes || !pdfBytes.length) {
    report("PDF file is empty or unreadable");
    return null;
  }

  const fileName = pdfPath.split(/[\\/]/).pop() || "paper.pdf";
  const sizeMB = (pdfBytes.length / (1024 * 1024)).toFixed(1);
  report(`Requesting upload URL… (${sizeMB} MB)`);

  const batchResult = await httpJson(
    "POST",
    `${MINERU_API_BASE}/file-urls/batch`,
    {
      Authorization: `Bearer ${apiKey}`,
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

  report("Uploading PDF…");
  const uploadResult = await httpPutBinary(
    fileUrls[0],
    { "Content-Type": "application/octet-stream" },
    pdfPath,
    pdfBytes,
  );

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
    await sleep(POLL_INTERVAL_MS);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    report(`Processing on server… (${elapsed}s)`);

    const pollResult = await httpJson(
      "GET",
      `${MINERU_API_BASE}/extract-results/batch/${batchId}`,
      { Authorization: `Bearer ${apiKey}` },
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
): Promise<MinerUResult> {
  const report = (stage: string) => {
    ztoolkit.log(`MinerU: ${stage}`);
    onProgress?.(stage);
  };
  try {
    return await parsePdfViaUpload(pdfPath, apiKey, report);
  } catch (e) {
    if (e instanceof MineruRateLimitError) throw e;
    report(`Error: ${(e as Error).message}`);
    return null;
  }
}

export async function testMineruConnection(apiKey: string): Promise<void> {
  const result = await httpJson(
    "GET",
    `${MINERU_API_BASE}/extract-results/batch/_test`,
    { Authorization: `Bearer ${apiKey}` },
  );
  if (result.status === 401 || result.status === 403) {
    throw new Error("Invalid API key — authentication failed");
  }
}
