import { unzipSync } from "fflate";
import { config } from "../../../package.json";
import { getLocalParentPath, joinLocalPath } from "../../utils/localPath";
import { getRuntimePlatformInfo } from "../../utils/runtimePlatform";

export const PDF_FIGURE_RUNTIME_VERSION = "1";

const PDF_FIGURE_RUNTIME_KIND = "llm-for-zotero/pdf-figure-runtime";
const PDF_FIGURE_RUNTIME_DIR_NAME = "llm-for-zotero-runtimes";
const PDF_FIGURE_RUNTIME_PACKAGE_URL_KEY = `${config.prefsPrefix}.figureExtractionRuntimePackageUrl`;
const PDF_FIGURE_RUNTIME_ALLOW_SYSTEM_FALLBACK_KEY = `${config.prefsPrefix}.figureExtractionRuntimeAllowSystemFallback`;
const PDFTOPPM_CANDIDATE_PATHS = [
  "/Users/yat-lok/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/pdftoppm",
  "/opt/homebrew/bin/pdftoppm",
  "/usr/local/bin/pdftoppm",
  "/usr/bin/pdftoppm",
];
const PYTHON3_CANDIDATE_PATHS = [
  "/Users/yat-lok/miniconda3/bin/python3",
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
  "/usr/bin/python3",
];

type IOUtilsLike = {
  exists?: (path: string) => Promise<boolean>;
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  makeDirectory?: (
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean },
  ) => Promise<void>;
  write?: (path: string, data: Uint8Array) => Promise<unknown>;
  remove?: (
    path: string,
    options?: { recursive?: boolean; ignoreAbsent?: boolean },
  ) => Promise<void>;
  setPermissions?: (path: string, permissions: number) => Promise<void>;
};

type OSFileLike = {
  exists?: (path: string) => Promise<boolean>;
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  makeDir?: (
    path: string,
    options?: { from?: string; ignoreExisting?: boolean },
  ) => Promise<void>;
  writeAtomic?: (path: string, data: Uint8Array) => Promise<void>;
  remove?: (
    path: string,
    options?: { ignoreAbsent?: boolean },
  ) => Promise<void>;
  removeDir?: (
    path: string,
    options?: { ignoreAbsent?: boolean; ignorePermissions?: boolean },
  ) => Promise<void>;
  setPermissions?: (
    path: string,
    options: { unixMode?: number },
  ) => Promise<void>;
};

type RuntimeManifest = {
  kind?: unknown;
  version?: unknown;
  platform?: unknown;
  pythonPath?: unknown;
  popplerBinDir?: unknown;
  executablePaths?: unknown;
};

export type PdfFigureRuntimePlatformKey =
  | "macos-arm64"
  | "macos-x64"
  | "linux-arm64"
  | "linux-x64"
  | "windows-arm64"
  | "windows-x64";

export type PdfFigureExtractionRuntime = {
  source: "managed" | "system";
  pythonPath: string;
  popplerBinDir: string;
  pathListSeparator: ":" | ";";
  rootDir?: string;
  platformKey?: PdfFigureRuntimePlatformKey;
  packageUrl?: string;
};

let managedInstallTask: Promise<PdfFigureExtractionRuntime> | null = null;

function sanitizeText(value: unknown): string {
  return `${value ?? ""}`.replace(/\s+/g, " ").trim();
}

function getIOUtils(): IOUtilsLike | undefined {
  return (globalThis as unknown as { IOUtils?: IOUtilsLike }).IOUtils;
}

function getOSFile(): OSFileLike | undefined {
  return (globalThis as { OS?: { File?: OSFileLike } }).OS?.File;
}

async function pathExists(path: string): Promise<boolean> {
  const io = getIOUtils();
  if (io?.exists) {
    try {
      return Boolean(await io.exists(path));
    } catch {
      return false;
    }
  }
  const osFile = getOSFile();
  if (osFile?.exists) {
    try {
      return Boolean(await osFile.exists(path));
    } catch {
      return false;
    }
  }
  return false;
}

async function ensureDir(path: string): Promise<void> {
  const io = getIOUtils();
  if (io?.makeDirectory) {
    await io.makeDirectory(path, {
      createAncestors: true,
      ignoreExisting: true,
    });
    return;
  }
  const osFile = getOSFile();
  if (osFile?.makeDir) {
    await osFile.makeDir(path, {
      from: getLocalParentPath(path),
      ignoreExisting: true,
    });
    return;
  }
  throw new Error("No directory creation API available");
}

async function removeDir(path: string): Promise<void> {
  const io = getIOUtils();
  if (io?.remove) {
    await io.remove(path, { recursive: true, ignoreAbsent: true });
    return;
  }
  const osFile = getOSFile();
  if (osFile?.removeDir) {
    await osFile.removeDir(path, {
      ignoreAbsent: true,
      ignorePermissions: true,
    });
  }
}

function coerceToUint8Array(data: Uint8Array | ArrayBuffer): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return new Uint8Array(data as ArrayBuffer);
}

async function readFileBytes(path: string): Promise<Uint8Array | null> {
  const io = getIOUtils();
  if (io?.read) {
    try {
      return coerceToUint8Array(await io.read(path));
    } catch {
      return null;
    }
  }
  const osFile = getOSFile();
  if (osFile?.read) {
    try {
      return coerceToUint8Array(await osFile.read(path));
    } catch {
      return null;
    }
  }
  return null;
}

async function writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
  await ensureDir(getLocalParentPath(path));
  const io = getIOUtils();
  if (io?.write) {
    await io.write(path, bytes);
    return;
  }
  const osFile = getOSFile();
  if (osFile?.writeAtomic) {
    await osFile.writeAtomic(path, bytes);
    return;
  }
  throw new Error("No file writing API available");
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  const bytes = await readFileBytes(path);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8").decode(bytes)) as T;
  } catch {
    return null;
  }
}

function readPreference(key: string): unknown {
  try {
    return (globalThis as any).Zotero?.Prefs?.get?.(key, true);
  } catch {
    return undefined;
  }
}

function isTruthyPreference(value: unknown): boolean {
  if (value === true) return true;
  const normalized = sanitizeText(value).toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function getBuildEnv(): string {
  try {
    if (typeof __env__ !== "undefined") return __env__;
  } catch {
    // The test runner does not define esbuild globals.
  }
  return sanitizeText((globalThis as { __env__?: unknown }).__env__);
}

function isSystemFallbackEnabled(): boolean {
  if (
    isTruthyPreference(
      readPreference(PDF_FIGURE_RUNTIME_ALLOW_SYSTEM_FALLBACK_KEY),
    )
  ) {
    return true;
  }
  const env = getBuildEnv();
  return env === "development" || env === "test";
}

function getBaseRuntimeDir(): string {
  const zotero = (globalThis as any).Zotero as
    | {
        DataDirectory?: { dir?: string };
        Profile?: { dir?: string };
      }
    | undefined;
  const dataDir = sanitizeText(zotero?.DataDirectory?.dir);
  if (dataDir) return dataDir;
  const profileDir = sanitizeText(zotero?.Profile?.dir);
  if (profileDir) return profileDir;
  throw new Error("Cannot resolve Zotero data directory for managed runtime");
}

function getArchitecture(): "arm64" | "x64" {
  const abi = sanitizeText(
    (globalThis as any).Services?.appinfo?.XPCOMABI,
  ).toLowerCase();
  if (abi.includes("aarch64") || abi.includes("arm64")) return "arm64";
  if (abi.includes("x86_64") || abi.includes("x64") || abi.includes("amd64")) {
    return "x64";
  }
  const processArch = sanitizeText(
    (globalThis as { process?: { arch?: string } }).process?.arch,
  ).toLowerCase();
  if (processArch === "arm64" || processArch === "aarch64") return "arm64";
  return "x64";
}

export function getPdfFigureRuntimePlatformKey(): PdfFigureRuntimePlatformKey {
  const platform = getRuntimePlatformInfo().platform;
  const arch = getArchitecture();
  if (platform === "windows") return `windows-${arch}`;
  if (platform === "linux") return `linux-${arch}`;
  return `macos-${arch}`;
}

function getPathListSeparator(): ":" | ";" {
  return getRuntimePlatformInfo().platform === "windows" ? ";" : ":";
}

export function getManagedPdfFigureRuntimeRoot(
  platformKey: PdfFigureRuntimePlatformKey = getPdfFigureRuntimePlatformKey(),
): string {
  return joinLocalPath(
    getBaseRuntimeDir(),
    PDF_FIGURE_RUNTIME_DIR_NAME,
    "pdf-figure-extractor",
    PDF_FIGURE_RUNTIME_VERSION,
    platformKey,
  );
}

function isAbsoluteLocalPath(path: string): boolean {
  return (
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith("\\\\") ||
    path.startsWith("//")
  );
}

function resolveRuntimePath(rootDir: string, value: unknown): string {
  const path = sanitizeText(value);
  if (!path) return "";
  return isAbsoluteLocalPath(path) ? path : joinLocalPath(rootDir, path);
}

function normalizeComparablePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "");
}

function isPathInsideRoot(rootDir: string, path: string): boolean {
  const root = normalizeComparablePath(rootDir);
  const candidate = normalizeComparablePath(path);
  return candidate === root || candidate.startsWith(`${root}/`);
}

function popplerExecutableNames(platformKey: PdfFigureRuntimePlatformKey) {
  const exe = platformKey.startsWith("windows") ? ".exe" : "";
  return [`pdftoppm${exe}`, `pdftohtml${exe}`, `pdfinfo${exe}`];
}

async function validateManagedRuntime(params: {
  rootDir: string;
  platformKey: PdfFigureRuntimePlatformKey;
  manifest: RuntimeManifest | null;
  packageUrl?: string;
}): Promise<PdfFigureExtractionRuntime | null> {
  const manifest = params.manifest;
  if (!manifest || manifest.kind !== PDF_FIGURE_RUNTIME_KIND) return null;
  if (manifest.version !== PDF_FIGURE_RUNTIME_VERSION) return null;
  if (manifest.platform !== params.platformKey) return null;
  const pythonPath = resolveRuntimePath(params.rootDir, manifest.pythonPath);
  const popplerBinDir = resolveRuntimePath(
    params.rootDir,
    manifest.popplerBinDir,
  );
  if (!pythonPath || !popplerBinDir) return null;
  if (!isPathInsideRoot(params.rootDir, pythonPath)) return null;
  if (!isPathInsideRoot(params.rootDir, popplerBinDir)) return null;
  if (!(await pathExists(pythonPath))) return null;
  for (const executable of popplerExecutableNames(params.platformKey)) {
    if (!(await pathExists(joinLocalPath(popplerBinDir, executable)))) {
      return null;
    }
  }
  return {
    source: "managed",
    pythonPath,
    popplerBinDir,
    pathListSeparator: getPathListSeparator(),
    rootDir: params.rootDir,
    platformKey: params.platformKey,
    packageUrl: params.packageUrl,
  };
}

async function resolveInstalledManagedRuntime(
  platformKey = getPdfFigureRuntimePlatformKey(),
): Promise<PdfFigureExtractionRuntime | null> {
  const rootDir = getManagedPdfFigureRuntimeRoot(platformKey);
  const manifest = await readJsonFile<RuntimeManifest>(
    joinLocalPath(rootDir, "runtime.json"),
  );
  return validateManagedRuntime({ rootDir, platformKey, manifest });
}

function readPopplerPreference(): string {
  const preferenceKeys = [
    "extensions.zotero.llmforzotero.pdftoppmPath",
    "extensions.zotero.llmforzotero.popplerPdftoppmPath",
    "llmforzotero.pdftoppmPath",
  ];
  for (const key of preferenceKeys) {
    const value = sanitizeText(readPreference(key));
    if (value) return value;
  }
  return "";
}

export async function resolveSystemPdfFigurePdftoppmPath(): Promise<
  string | null
> {
  const preferencePath = readPopplerPreference();
  const candidates = [
    ...(preferencePath ? [preferencePath] : []),
    ...PDFTOPPM_CANDIDATE_PATHS,
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

export async function resolveSystemPdfFigurePdftohtmlPath(): Promise<
  string | null
> {
  const preferencePath = readPopplerPreference();
  const preferenceSibling = preferencePath
    ? preferencePath.replace(/pdftoppm(?:\.exe)?$/i, (match) =>
        match.toLowerCase().endsWith(".exe") ? "pdftohtml.exe" : "pdftohtml",
      )
    : "";
  const candidates = [
    ...(preferenceSibling ? [preferenceSibling] : []),
    ...PDFTOPPM_CANDIDATE_PATHS.map((path) =>
      path.replace(/pdftoppm$/, "pdftohtml"),
    ),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

function readPythonPreference(): string {
  const preferenceKeys = [
    "extensions.zotero.llmforzotero.pythonPath",
    "extensions.zotero.llmforzotero.figureExtractionPythonPath",
    "llmforzotero.pythonPath",
  ];
  for (const key of preferenceKeys) {
    const value = sanitizeText(readPreference(key));
    if (value) return value;
  }
  return "";
}

async function resolveSystemPython3Path(): Promise<string | null> {
  const preferencePath = readPythonPreference();
  const candidates = [
    ...(preferencePath ? [preferencePath] : []),
    ...PYTHON3_CANDIDATE_PATHS,
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

async function resolveSystemRuntime(): Promise<PdfFigureExtractionRuntime | null> {
  const pythonPath = await resolveSystemPython3Path();
  if (!pythonPath) return null;
  const pdftoppmPath = await resolveSystemPdfFigurePdftoppmPath();
  if (!pdftoppmPath) return null;
  const popplerBinDir = getLocalParentPath(pdftoppmPath);
  const platformKey = getPdfFigureRuntimePlatformKey();
  for (const executable of popplerExecutableNames(platformKey)) {
    if (!(await pathExists(joinLocalPath(popplerBinDir, executable)))) {
      return null;
    }
  }
  return {
    source: "system",
    pythonPath,
    popplerBinDir,
    pathListSeparator: getPathListSeparator(),
  };
}

export function buildDefaultPdfFigureRuntimePackageUrl(
  platformKey: PdfFigureRuntimePlatformKey,
): string {
  return `https://github.com/yilewang/llm-for-zotero/releases/download/pdf-figure-runtime-v${PDF_FIGURE_RUNTIME_VERSION}/llm-for-zotero-pdf-figure-runtime-v${PDF_FIGURE_RUNTIME_VERSION}-${platformKey}.zip`;
}

function getRuntimePackageUrl(
  platformKey: PdfFigureRuntimePlatformKey,
): string {
  const override = sanitizeText(
    readPreference(PDF_FIGURE_RUNTIME_PACKAGE_URL_KEY),
  );
  const template =
    override || buildDefaultPdfFigureRuntimePackageUrl(platformKey);
  if (/^(?:off|false|disabled|none)$/i.test(template)) return "";
  return template
    .replace(/\{platform\}/g, platformKey)
    .replace(/\{version\}/g, PDF_FIGURE_RUNTIME_VERSION);
}

async function downloadRuntimePackageBytes(url: string): Promise<Uint8Array> {
  let fetchError = "";
  const fetcher = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof fetcher === "function") {
    try {
      const response = await fetcher(url);
      if (response?.ok) {
        return new Uint8Array(await response.arrayBuffer());
      }
      fetchError = `fetch HTTP ${response?.status || "unknown"}`;
    } catch (error) {
      fetchError = `fetch failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
  const zoteroHttp = (globalThis as any).Zotero?.HTTP;
  if (zoteroHttp?.request) {
    try {
      const xhr = await zoteroHttp.request("GET", url, {
        responseType: "arraybuffer",
        successCodes: false,
        timeout: 300000,
        errorDelayMax: 0,
      });
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
        return new Uint8Array(xhr.response as ArrayBuffer);
      }
      throw new Error(`Zotero.HTTP ${xhr.status || "unknown"}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(fetchError ? `${fetchError}; ${message}` : message);
    }
  }
  throw new Error(fetchError || "No downloader is available");
}

function normalizeZipEntryPath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    return null;
  }
  return normalized;
}

function extractRuntimeZipEntries(zipBytes: Uint8Array): {
  entries: Array<{ relativePath: string; data: Uint8Array }>;
  manifest: RuntimeManifest;
  manifestBytes: Uint8Array;
} {
  const unzipped = unzipSync(zipBytes);
  const manifestEntryName = Object.keys(unzipped).find((entryName) => {
    const normalized = normalizeZipEntryPath(entryName);
    return (
      normalized === "runtime.json" || normalized?.endsWith("/runtime.json")
    );
  });
  if (!manifestEntryName) {
    throw new Error("runtime package is missing runtime.json");
  }
  const normalizedManifestName = normalizeZipEntryPath(manifestEntryName);
  if (!normalizedManifestName) {
    throw new Error("runtime package has an invalid manifest path");
  }
  const prefix = normalizedManifestName.endsWith("/runtime.json")
    ? normalizedManifestName.slice(0, -"runtime.json".length)
    : "";
  const entries: Array<{ relativePath: string; data: Uint8Array }> = [];
  for (const [entryName, data] of Object.entries(unzipped)) {
    const normalized = normalizeZipEntryPath(entryName);
    if (!normalized || !normalized.startsWith(prefix)) continue;
    const relativePath = normalized.slice(prefix.length);
    if (!relativePath || relativePath.endsWith("/")) continue;
    entries.push({ relativePath, data });
  }
  const manifestBytes = unzipped[manifestEntryName];
  const manifest = JSON.parse(
    new TextDecoder("utf-8").decode(manifestBytes),
  ) as RuntimeManifest;
  return { entries, manifest, manifestBytes };
}

async function markExecutable(path: string): Promise<void> {
  const io = getIOUtils();
  if (io?.setPermissions) {
    try {
      await io.setPermissions(path, 0o755);
      return;
    } catch {
      // Try OS.File below.
    }
  }
  const osFile = getOSFile();
  if (osFile?.setPermissions) {
    try {
      await osFile.setPermissions(path, { unixMode: 0o755 });
    } catch {
      // Best-effort only; the runtime archive may already preserve permissions.
    }
  }
}

async function markRuntimeExecutables(params: {
  rootDir: string;
  manifest: RuntimeManifest;
  platformKey: PdfFigureRuntimePlatformKey;
}): Promise<void> {
  const executablePaths = Array.isArray(params.manifest.executablePaths)
    ? params.manifest.executablePaths.map((entry) => sanitizeText(entry))
    : [];
  const popplerBinDir = resolveRuntimePath(
    params.rootDir,
    params.manifest.popplerBinDir,
  );
  const defaults = [
    sanitizeText(params.manifest.pythonPath),
    ...popplerExecutableNames(params.platformKey).map((entry) =>
      joinLocalPath(sanitizeText(params.manifest.popplerBinDir), entry),
    ),
  ];
  for (const executablePath of [...defaults, ...executablePaths]) {
    const resolved = resolveRuntimePath(params.rootDir, executablePath);
    if (
      resolved &&
      isPathInsideRoot(params.rootDir, resolved) &&
      (await pathExists(resolved))
    ) {
      await markExecutable(resolved);
    }
  }
  if (popplerBinDir && isPathInsideRoot(params.rootDir, popplerBinDir)) {
    await markExecutable(popplerBinDir);
  }
}

async function installManagedRuntime(
  platformKey = getPdfFigureRuntimePlatformKey(),
): Promise<PdfFigureExtractionRuntime> {
  const packageUrl = getRuntimePackageUrl(platformKey);
  if (!packageUrl) {
    throw new Error("Managed runtime package URL is disabled");
  }
  const rootDir = getManagedPdfFigureRuntimeRoot(platformKey);
  const zipBytes = await downloadRuntimePackageBytes(packageUrl);
  const extracted = extractRuntimeZipEntries(zipBytes);
  await removeDir(rootDir);
  await ensureDir(rootDir);
  for (const entry of extracted.entries) {
    if (entry.relativePath === "runtime.json") continue;
    await writeFileBytes(
      joinLocalPath(rootDir, entry.relativePath),
      entry.data,
    );
  }
  await markRuntimeExecutables({
    rootDir,
    manifest: extracted.manifest,
    platformKey,
  });
  await writeFileBytes(
    joinLocalPath(rootDir, "runtime.json"),
    extracted.manifestBytes,
  );
  const runtime = await validateManagedRuntime({
    rootDir,
    platformKey,
    manifest: extracted.manifest,
    packageUrl,
  });
  if (!runtime) {
    throw new Error("Installed managed runtime did not pass validation");
  }
  return runtime;
}

export async function resolvePdfFigureExtractionRuntime(): Promise<PdfFigureExtractionRuntime> {
  const platformKey = getPdfFigureRuntimePlatformKey();
  const installed = await resolveInstalledManagedRuntime(platformKey);
  if (installed) return installed;

  if (isSystemFallbackEnabled()) {
    const systemRuntime = await resolveSystemRuntime();
    if (systemRuntime) return systemRuntime;
  }

  if (!managedInstallTask) {
    managedInstallTask = installManagedRuntime(platformKey).finally(() => {
      managedInstallTask = null;
    });
  }
  return managedInstallTask;
}
