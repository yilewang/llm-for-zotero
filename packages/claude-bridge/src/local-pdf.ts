import { open } from "node:fs/promises";
import { dirname, isAbsolute, win32 } from "node:path";

export type LocalPdfResource = Readonly<{
  kind: "local_pdf";
  sourceKey: string;
  itemId: number;
  contextItemId: number;
  title: string;
  name: string;
  mimeType: "application/pdf";
  absolutePath: string;
}>;

const LOCAL_PDF_POLICY = [
  "Raw PDF transport policy for this turn:",
  "Read each raw PDF from the exact current-turn path with Claude's native Read capability.",
  "Do not substitute sibling attachments, earlier paths, Zotero indexed text, MinerU output, or another paper-reading route.",
  "If an exact path cannot be read, report the failure instead of falling back.",
].join("\n");

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function cleanLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function isHostAbsolutePath(value: string): boolean {
  if (!value || value.includes("\0")) return false;
  if (process.platform !== "win32") return isAbsolute(value);
  const windowsPath = value.replace(/\//g, "\\");
  return (
    /^[A-Za-z]:\\/.test(windowsPath) ||
    /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(windowsPath)
  );
}

const WINDOWS_DRIVE_PATH = /^([A-Za-z]):[\\/](.*)$/;

/**
 * Zotero on Windows sends drive-letter paths such as
 * C:\Users\...\paper.pdf. When this bridge runs inside WSL,
 * isHostAbsolutePath sees a string that is not POSIX-absolute, so
 * collectLocalPdfs throws "Invalid local PDF resource batch." for a
 * file that is readable under the automount root. Translate only on
 * POSIX, where a drive-letter path can never be a valid absolute path,
 * so a bridge running on Windows is unaffected.
 */
function translateWindowsPathForPosix(value: string): string {
  if (process.platform === "win32") return value;
  const match = value.match(WINDOWS_DRIVE_PATH);
  if (!match) return value;
  const mountRoot = (
    process.env.ADAPTER_WINDOWS_DRIVE_MOUNT_ROOT || "/mnt"
  ).replace(/\/+$/, "");
  return `${mountRoot}/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

type LocalPdfOutputReplacement = Readonly<{
  pattern: string;
  replacement: string;
}>;

function buildLocalPdfOutputReplacements(
  resources: readonly LocalPdfResource[],
): LocalPdfOutputReplacement[] {
  return resources
    .flatMap((resource) => {
      const escaped = stringifyJson(resource.absolutePath).slice(1, -1);
      const replacement = `[local-pdf-path:${resource.sourceKey}]`;
      return Array.from(new Set([resource.absolutePath, escaped]))
        .filter(Boolean)
        .map((pattern) => ({ pattern, replacement }));
    })
    .sort((left, right) => right.pattern.length - left.pattern.length);
}

function replaceLocalPdfOutputPatterns(
  value: string,
  replacements: readonly LocalPdfOutputReplacement[],
): string {
  return replacements.reduce(
    (text, replacement) =>
      text.split(replacement.pattern).join(replacement.replacement),
    value,
  );
}

export function collectLocalPdfs(
  runtimeRequest: unknown,
): readonly LocalPdfResource[] {
  const request = asRecord(runtimeRequest);
  if (!request || request.localDocuments === undefined) return [];
  if (!Array.isArray(request.localDocuments)) {
    throw new Error("Invalid local PDF resource batch.");
  }

  const resources: LocalPdfResource[] = [];
  const sourceKeys = new Set<string>();
  for (const candidate of request.localDocuments) {
    const record = asRecord(candidate);
    const itemId = asPositiveInteger(record?.itemId);
    const contextItemId = asPositiveInteger(record?.contextItemId);
    const sourceKey =
      typeof record?.sourceKey === "string" ? record.sourceKey : "";
    const absolutePath = translateWindowsPathForPosix(
      typeof record?.absolutePath === "string" ? record.absolutePath : "",
    );
    const title = cleanLabel(record?.title, "");
    const name = cleanLabel(record?.name, "");
    if (
      !record ||
      record.kind !== "local_pdf" ||
      record.mimeType !== "application/pdf" ||
      !itemId ||
      !contextItemId ||
      sourceKey !== `zotero-pdf:${itemId}:${contextItemId}` ||
      !title ||
      !name ||
      !isHostAbsolutePath(absolutePath) ||
      sourceKeys.has(sourceKey)
    ) {
      throw new Error("Invalid local PDF resource batch.");
    }

    sourceKeys.add(sourceKey);
    resources.push(
      Object.freeze({
        kind: "local_pdf",
        sourceKey,
        itemId,
        contextItemId,
        title,
        name,
        mimeType: "application/pdf",
        absolutePath,
      }),
    );
  }
  return Object.freeze(resources);
}

export async function validateLocalPdfs(
  resources: readonly LocalPdfResource[],
): Promise<void> {
  for (const resource of resources) {
    let file;
    try {
      file = await open(resource.absolutePath, "r");
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 5)
        throw new Error("not a non-empty regular file");
      const signature = Buffer.alloc(5);
      const { bytesRead } = await file.read(signature, 0, signature.length, 0);
      if (
        bytesRead !== signature.length ||
        signature.toString("ascii") !== "%PDF-"
      ) {
        throw new Error("invalid PDF signature");
      }
    } catch {
      throw new Error(
        `Selected raw PDF is missing, unreadable, or invalid (${resource.sourceKey}).`,
      );
    } finally {
      await file?.close().catch(() => undefined);
    }
  }
}

export function localPdfDirectories(
  resources: readonly LocalPdfResource[],
): string[] {
  const directories = resources.map((resource) =>
    process.platform === "win32"
      ? win32.dirname(resource.absolutePath)
      : dirname(resource.absolutePath),
  );
  return Array.from(new Set(directories));
}

export function renderLocalPdfPrompt(
  resources: readonly LocalPdfResource[],
): string {
  if (!resources.length) return "";
  return [
    "Raw PDFs explicitly selected for this turn:",
    ...resources.map(
      (resource, index) =>
        `${index + 1}. ${stringifyJson({
          sourceKey: resource.sourceKey,
          itemId: resource.itemId,
          contextItemId: resource.contextItemId,
          title: resource.title,
          name: resource.name,
          absolutePath: resource.absolutePath,
        })}`,
    ),
    "The ordered list above is authoritative.",
    LOCAL_PDF_POLICY,
  ].join("\n");
}

/**
 * Holds only a suffix that can still become a selected local PDF path. SDK text
 * deltas are separated by raw provider events, so complete paths cannot be
 * safely redacted by treating each event as an independent string.
 */
export class LocalPdfOutputStreamSanitizer {
  private readonly replacements: readonly LocalPdfOutputReplacement[];
  private readonly pendingByChannel = new Map<
    string,
    { text: string; replacement: string }
  >();

  constructor(resources: readonly LocalPdfResource[]) {
    this.replacements = buildLocalPdfOutputReplacements(resources);
  }

  pushText(channel: string, chunk: string): string {
    if (!this.replacements.length || !chunk) return chunk;
    const previous = this.pendingByChannel.get(channel);
    const redacted = replaceLocalPdfOutputPatterns(
      `${previous?.text || ""}${chunk}`,
      this.replacements,
    );
    let pending: { length: number; replacement: string } | undefined;
    for (const replacement of this.replacements) {
      const maximumLength = Math.min(
        redacted.length,
        replacement.pattern.length - 1,
      );
      for (let length = maximumLength; length > 0; length -= 1) {
        if (
          length > (pending?.length || 0) &&
          redacted.endsWith(replacement.pattern.slice(0, length))
        ) {
          pending = { length, replacement: replacement.replacement };
          break;
        }
      }
    }
    if (!pending) {
      this.pendingByChannel.delete(channel);
      return redacted;
    }
    this.pendingByChannel.set(channel, {
      text: redacted.slice(-pending.length),
      replacement: pending.replacement,
    });
    return redacted.slice(0, -pending.length);
  }

  sanitizeChunk<T>(channel: string, value: T): T {
    if (!this.replacements.length) return value;
    const visit = (
      entry: unknown,
      path: readonly (string | number)[],
    ): unknown => {
      if (typeof entry === "string") {
        return this.pushText(`${channel}:${stringifyJson(path)}`, entry);
      }
      if (Array.isArray(entry)) {
        return entry.map((child, index) => visit(child, [...path, index]));
      }
      const record = asRecord(entry);
      if (!record) return entry;
      return Object.fromEntries(
        Object.entries(record)
          .filter(([key]) => key !== "sessionId" && key !== "session_id")
          .map(([key, child]) => [key, visit(child, [...path, key])]),
      );
    };
    return visit(value, []) as T;
  }

  flushText(channel: string): string {
    const pending = this.pendingByChannel.get(channel);
    this.pendingByChannel.delete(channel);
    return pending?.replacement || "";
  }

  discardAll(): void {
    this.pendingByChannel.clear();
  }
}

export function sanitizeLocalPdfOutput<T>(
  value: T,
  resources: readonly LocalPdfResource[],
): T {
  if (!resources.length) return value;
  const replacements = buildLocalPdfOutputReplacements(resources);

  const visit = (entry: unknown): unknown => {
    if (typeof entry === "string") {
      return replaceLocalPdfOutputPatterns(entry, replacements);
    }
    if (Array.isArray(entry)) return entry.map(visit);
    const record = asRecord(entry);
    if (!record) return entry;
    return Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => key !== "sessionId" && key !== "session_id")
        .map(([key, child]) => [key, visit(child)]),
    );
  };

  return visit(value) as T;
}
