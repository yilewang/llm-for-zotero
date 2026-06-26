/**
 * Tool for reading and writing files on the local filesystem.
 * Enables the agent to read data files, write scripts, export results, etc.
 */
import type { AgentToolContext, AgentToolDefinition } from "../../types";
import type { PaperContextRef } from "../../../shared/types";
import {
  formatPaperCitationLabel,
  formatPaperSourceLabel,
} from "../../../modules/contextPanel/paperAttribution";
import { ok, fail, validateObject } from "../shared";
import { getLocalParentPath, joinLocalPath } from "../../../utils/localPath";
import {
  getLocalPathBasename,
  parseNotesDirectoryWritePolicy,
} from "../../../utils/notesDirectoryConfig";
import { pushUndoEntry } from "../../store/undoStore";
import { FILE_IO_CONTENT_FIELDS } from "../../toolArgumentFields";
import { isMalformedToolArgumentsDiagnostic } from "../../toolArgumentDiagnostics";
import {
  findMineruImageBlockInCacheDirs,
  validateMineruFigureBlockEmbedsForCacheDirs,
} from "../../../modules/contextPanel/mineruFigureBlockCache";
import { MAX_MINERU_CONTEXT_IMAGES } from "../../../modules/contextPanel/mineruImages";
import { collectRequestPaperContexts } from "../requestPaperContexts";

type FileIOInput = {
  action: "read" | "write";
  filePath: string;
  content?: string;
  encoding?: string;
  offset?: number;
  length?: number;
  allowOverwrite?: boolean;
};

type ResolvedWriteInput = {
  input: FileIOInput;
  requestedFilePath?: string;
};

type FileIOAction = FileIOInput["action"];

const FILE_IO_ACTION_FIELDS = ["action", "mode", "operation", "op"] as const;
const FILE_IO_PATH_FIELDS = [
  "filePath",
  "path",
  "file_path",
  "filepath",
] as const;
const FILE_IO_READ_ACTIONS = new Set([
  "read",
  "open",
  "load",
  "view",
  "open_file",
  "view_file",
  "read_file",
  "load_file",
  "读取",
  "读",
  "打开",
  "查看",
]);

const FILE_IO_WRITE_ACTIONS = new Set([
  "write",
  "create",
  "save",
  "overwrite",
  "write_file",
  "create_file",
  "save_file",
  "save_to_file",
  "save_as",
  "write_to_file",
  "create_new_file",
  "create_or_overwrite",
  "保存",
  "写",
  "写入",
  "寫入",
  "创建",
  "建立",
  "新建",
]);

const FILE_IO_CONTENTLESS_READ_ACTIONS = new Set(["access", "inspect"]);

const FILE_IO_CANONICAL_EXAMPLES =
  "Use file_io({ action:'read', filePath:'/absolute/path.md' }) or " +
  "file_io({ action:'write', filePath:'/absolute/path.py', content:'...' }).";

function normalizeFileIOActionToken(value: string): string {
  let normalized = value.trim();
  const first = normalized[0];
  const last = normalized[normalized.length - 1];
  if (
    normalized.length >= 2 &&
    ((first === "'" && last === "'") ||
      (first === '"' && last === '"') ||
      (first === "`" && last === "`"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_")
    .toLowerCase();
}

function normalizeFileIOAction(
  value: unknown,
  options: { hasContent?: boolean } = {},
): FileIOAction | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeFileIOActionToken(value);
  if (FILE_IO_READ_ACTIONS.has(normalized)) return "read";
  if (!options.hasContent && FILE_IO_CONTENTLESS_READ_ACTIONS.has(normalized)) {
    return "read";
  }
  if (FILE_IO_WRITE_ACTIONS.has(normalized)) return "write";
  return null;
}

function readFirstStringField(
  args: Record<string, unknown>,
  fields: readonly string[],
): string | null {
  for (const field of fields) {
    const value = args[field];
    if (typeof value === "string") return value;
  }
  return null;
}

function normalizeFileIOActionFromArgs(
  args: Record<string, unknown>,
  options: { filePath?: string | null; hasContent?: boolean } = {},
): FileIOAction | null {
  for (const field of FILE_IO_ACTION_FIELDS) {
    const value = args[field];
    if (typeof value !== "string" || !value.trim()) continue;
    return normalizeFileIOAction(value, { hasContent: options.hasContent });
  }
  if (
    !options.hasContent &&
    options.filePath &&
    isObviousMineruReadPath(options.filePath)
  ) {
    return "read";
  }
  return null;
}

function normalizePathForPrefix(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/g, "");
}

function getFileNameFromPath(value: string): string {
  return value.split(/[\\/]/).pop() || value;
}

function isObviousMineruReadPath(value: string): boolean {
  const normalized = normalizePathForPrefix(value);
  const fileName = getFileNameFromPath(normalized).toLowerCase();
  return (
    normalized.includes("llm-for-zotero-mineru/") &&
    (fileName === "manifest.json" || fileName === "full.md")
  );
}

export function summarizeFileIOCall(args: unknown): string | null {
  const a =
    args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const filePath = readFirstStringField(a, FILE_IO_PATH_FIELDS) || "";
  const hasContent = readFirstStringField(a, FILE_IO_CONTENT_FIELDS) !== null;
  const action = normalizeFileIOActionFromArgs(a, {
    filePath,
    hasContent,
  });
  const fileName = getFileNameFromPath(filePath || "file");

  if (action === "read") {
    if (
      fileName === "manifest.json" &&
      filePath.includes("llm-for-zotero-mineru")
    ) {
      return "Reading paper structure";
    }
    if (fileName === "full.md" && typeof a.offset === "number") {
      return "Reading paper section";
    }
    if (/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(fileName)) {
      return "Reading figure";
    }
    return `Reading ${fileName}`;
  }
  if (action === "write") {
    return `Writing ${fileName}`;
  }
  return `Accessing ${fileName}`;
}

async function fileExists(filePath: string): Promise<boolean | null> {
  const IOUtils = (globalThis as any).IOUtils;
  if (IOUtils?.exists) {
    try {
      return Boolean(await IOUtils.exists(filePath));
    } catch {
      return null;
    }
  }
  const OSFile = (globalThis as any).OS?.File;
  if (OSFile?.exists) {
    try {
      return Boolean(await OSFile.exists(filePath));
    } catch {
      return null;
    }
  }
  return null;
}

async function removeFileIfExists(filePath: string): Promise<void> {
  const IOUtils = (globalThis as any).IOUtils;
  if (IOUtils?.remove) {
    await IOUtils.remove(filePath, { ignoreAbsent: true });
    return;
  }
  const OSFile = (globalThis as any).OS?.File;
  if (OSFile?.remove) {
    await OSFile.remove(filePath, { ignoreAbsent: true });
    return;
  }
  throw new Error("File removal is not available in this Zotero environment");
}

async function ensureDirectoryExists(directoryPath: string): Promise<void> {
  const IOUtils = (globalThis as any).IOUtils;
  let ioUtilsError: unknown = null;
  if (IOUtils?.makeDirectory) {
    try {
      await IOUtils.makeDirectory(directoryPath, {
        createAncestors: true,
        ignoreExisting: true,
      });
      return;
    } catch (error) {
      ioUtilsError = error;
    }
  }
  const OSFile = (globalThis as any).OS?.File;
  if (OSFile?.makeDir) {
    await OSFile.makeDir(directoryPath, {
      from: getLocalParentPath(directoryPath),
      ignoreExisting: true,
    });
    return;
  }
  if (ioUtilsError) throw ioUtilsError;
}

function isMarkdownWritePath(filePath: string): boolean {
  return /\.(?:md|markdown)$/i.test(filePath.trim());
}

function getRequestMineruCacheDirs(context: AgentToolContext): string[] {
  return collectRequestPaperContexts(context.request)
    .map((paperContext) =>
      typeof paperContext.mineruCacheDir === "string"
        ? paperContext.mineruCacheDir.trim()
        : "",
    )
    .filter(Boolean);
}

async function validateMarkdownFigureBlockEmbeds(
  content: string,
  context: AgentToolContext,
  encoding: string,
) {
  return validateMineruFigureBlockEmbedsForCacheDirs({
    content,
    requestText: context.request.userText || "",
    cacheDirs: getRequestMineruCacheDirs(context),
    encoding,
  });
}

async function findMineruImageBlockForRead(
  filePath: string,
  context: AgentToolContext,
  encoding: string,
) {
  return findMineruImageBlockInCacheDirs({
    imagePath: filePath,
    cacheDirs: getRequestMineruCacheDirs(context),
    encoding,
  });
}

function resolveFileNoteWriteInput(
  input: FileIOInput,
  context: AgentToolContext,
): ResolvedWriteInput {
  if (input.action !== "write" || !isMarkdownWritePath(input.filePath)) {
    return { input };
  }
  const policy = parseNotesDirectoryWritePolicy(
    context.request.metadata?.fileNoteWritePolicy,
  );
  if (!policy) return { input };
  if (!policy.enforceDefaultTarget) return { input };
  const fileName = getLocalPathBasename(input.filePath);
  if (!fileName) return { input };
  const resolvedPath = joinLocalPath(policy.defaultTargetPath, fileName);
  if (resolvedPath === input.filePath) return { input };
  return {
    input: {
      ...input,
      filePath: resolvedPath,
    },
    requestedFilePath: input.filePath,
  };
}

function buildCodexMineruPaperSourceMetadata(
  filePath: string,
  request: AgentToolContext["request"],
): {
  paperContext: PaperContextRef;
  citationLabel: string;
  sourceLabel: string;
  citationInstruction: string;
} | null {
  if (request.authMode !== "codex_app_server") return null;
  const normalizedFilePath = normalizePathForPrefix(filePath);
  for (const paperContext of collectRequestPaperContexts(request)) {
    const cacheDir =
      typeof paperContext.mineruCacheDir === "string"
        ? normalizePathForPrefix(paperContext.mineruCacheDir)
        : "";
    if (!cacheDir) continue;
    if (
      normalizedFilePath === cacheDir ||
      normalizedFilePath.startsWith(`${cacheDir}/`)
    ) {
      const sourceLabel = formatPaperSourceLabel(paperContext);
      return {
        paperContext,
        citationLabel: formatPaperCitationLabel(paperContext),
        sourceLabel,
        citationInstruction:
          `This file is parsed paper text for ${paperContext.title}. ` +
          `When using this content in the answer, include a short verbatim blockquote in the original source language and put ${sourceLabel} on the next non-empty line after the blockquote, before any commentary. Never translate quote text to match the user's language; put any translation outside the blockquote as explanation. Never put interpretation between the quote and ${sourceLabel}. A bare parenthetical citation alone is not enough.`,
      };
    }
  }
  return null;
}

/**
 * Read a file using Gecko-compatible I/O APIs.
 */
async function readFile(filePath: string, encoding: string): Promise<string> {
  const IOUtils = (globalThis as any).IOUtils;
  if (IOUtils?.read) {
    const data = await IOUtils.read(filePath);
    // IOUtils.read may return ArrayBuffer instead of Uint8Array depending
    // on the Gecko version — coerce to Uint8Array for reliable decoding.
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    return new TextDecoder(encoding).decode(bytes);
  }
  const OSFile = (globalThis as any).OS?.File;
  if (OSFile?.read) {
    const result = await OSFile.read(filePath, { encoding });
    if (typeof result === "string") return result;
    const bytes =
      result instanceof Uint8Array ? result : new Uint8Array(result);
    return new TextDecoder(encoding).decode(bytes);
  }
  throw new Error("File I/O is not available in this Zotero environment");
}

/**
 * Write a file using Gecko-compatible I/O APIs.
 */
async function writeFile(
  filePath: string,
  content: string,
  encoding: string,
): Promise<void> {
  const bytes = new TextEncoder().encode(content);

  // Ensure parent directory exists
  const parent = getLocalParentPath(filePath);
  if (parent && parent !== filePath) {
    try {
      await ensureDirectoryExists(parent);
    } catch {
      /* ignore */
    }
  }

  const IOUtils = (globalThis as any).IOUtils;
  if (IOUtils?.write) {
    await IOUtils.write(filePath, bytes, { tmpPath: filePath + ".tmp" });
    return;
  }
  const OSFile = (globalThis as any).OS?.File;
  if (OSFile?.writeAtomic) {
    await OSFile.writeAtomic(filePath, bytes, { tmpPath: filePath + ".tmp" });
    return;
  }
  throw new Error("File I/O is not available in this Zotero environment");
}

export function createFileIOTool(): AgentToolDefinition<FileIOInput, unknown> {
  return {
    spec: {
      name: "file_io",
      description:
        "Read or write files on the local filesystem. Reads text files (Markdown, JSON, CSV, etc.) and image files (PNG, JPG, SVG — returned as visual artifacts the model can see). Supports offset/length for partial reads of large files. For ordinary paper Q&A, use paper_read; use file_io for explicit filesystem work or direct MinerU cache metadata inspection such as manifest offsets and section slices. For paper figure interpretation or figure-note embeds, use paper_read mode:'figures'.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["action", "filePath"],
        properties: {
          action: {
            type: "string",
            enum: ["read", "write"],
            description:
              "'read' to read a file, 'write' to create or overwrite a file.",
          },
          filePath: {
            type: "string",
            description: "Absolute path to the file.",
          },
          content: {
            type: "string",
            description:
              "For action 'write': the content to write to the file.",
          },
          encoding: {
            type: "string",
            description: "Text encoding (default: 'utf-8').",
          },
          offset: {
            type: "number",
            description:
              "For action 'read': character offset to start reading from (default: 0). Use with manifest.json charStart/charEnd to read specific paper sections.",
          },
          length: {
            type: "number",
            description:
              "For action 'read': maximum characters to read. If omitted, reads the entire file from offset to end. Use with offset to read a specific character range.",
          },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    guidance: {
      matches: (request) =>
        /\b(read.*file|write.*file|save.*file|export.*csv|export.*json|write.*script|create.*file|save.*to.*(desktop|disk|folder))\b/i.test(
          request.userText || "",
        ),
      instruction:
        "Use file_io to read or write files on the user's filesystem. " +
        "For ordinary Zotero paper summaries, methods, key points, and targeted Q&A, use paper_read instead of direct MinerU cache reads. " +
        "Use file_io for explicit filesystem tasks or direct MinerU manifest/section cache inspection. For figure interpretation or note figure embeds, use paper_read mode:'figures' and its extracted PDF crop paths rather than MinerU source image paths. " +
        "Common uses: write a Python/R script before running it with run_command, read a CSV/JSON data file, " +
        "save analysis results to the user's Desktop, export formatted bibliographies. " +
        "Always use absolute paths.",
    },

    presentation: {
      label: "File I/O",
      summaries: {
        onCall: ({ args }) => {
          return summarizeFileIOCall(args) || "Accessing file";
        },
        onPending: "Waiting for confirmation on file operation",
        onApproved: "Performing file operation",
        onDenied: "File operation cancelled",
        onSuccess: ({ content }) => {
          const r =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          if (String(r.action || "file") === "write") {
            return `File written: ${r.filePath || ""}`;
          }
          if (r.imageFile) return "Figure loaded";
          const filePath = typeof r.filePath === "string" ? r.filePath : "";
          const fileName = filePath.split(/[\\/]/).pop() || "";
          if (
            fileName === "manifest.json" &&
            filePath.includes("llm-for-zotero-mineru")
          ) {
            return "Paper structure loaded";
          }
          if (fileName === "full.md" && typeof r.offset === "number") {
            return `Section loaded (${r.bytesRead || 0} chars)`;
          }
          return `File read: ${r.bytesRead || 0} chars`;
        },
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          `Expected an object with action and filePath. ${FILE_IO_CANONICAL_EXAMPLES}`,
        );
      }
      if (isMalformedToolArgumentsDiagnostic(args)) {
        return fail(
          `file_io received malformed tool arguments from the model. Retry with valid JSON. ${FILE_IO_CANONICAL_EXAMPLES}`,
        );
      }
      if (Object.keys(args).length === 0) {
        return fail(
          `file_io received empty tool arguments from the model. ${FILE_IO_CANONICAL_EXAMPLES}`,
        );
      }
      const rawFilePath = readFirstStringField(args, FILE_IO_PATH_FIELDS);
      const rawContent = readFirstStringField(args, FILE_IO_CONTENT_FIELDS);
      const action = normalizeFileIOActionFromArgs(args, {
        filePath: rawFilePath,
        hasContent: rawContent !== null,
      });
      const rawAction = readFirstStringField(args, FILE_IO_ACTION_FIELDS);
      if (rawAction?.trim() && action !== "read" && action !== "write") {
        return fail(
          "action must be 'read' or 'write'. Example: file_io({ action:'read', filePath:'/absolute/path.md' })",
        );
      }
      if (!rawFilePath?.trim()) {
        return fail(
          `filePath is required: an absolute path to the file. Deprecated alias path is accepted for older prompts. ${FILE_IO_CANONICAL_EXAMPLES}`,
        );
      }
      if (action !== "read" && action !== "write") {
        return fail(
          "action must be 'read' or 'write'. Example: file_io({ action:'read', filePath:'/absolute/path.md' })",
        );
      }
      if (action === "write" && rawContent === null) {
        return fail("content is required for action 'write'");
      }
      const encoding =
        typeof args.encoding === "string" && args.encoding.trim()
          ? args.encoding.trim()
          : "utf-8";
      const offset =
        action === "read" && typeof args.offset === "number" && args.offset >= 0
          ? Math.floor(args.offset)
          : undefined;
      const length =
        action === "read" && typeof args.length === "number" && args.length > 0
          ? Math.floor(args.length)
          : undefined;
      return ok<FileIOInput>({
        action,
        filePath: rawFilePath.trim(),
        content: action === "write" ? rawContent || "" : undefined,
        encoding,
        offset,
        length,
      });
    },

    createPendingAction(input, context) {
      const { input: effectiveInput } = resolveFileNoteWriteInput(
        input,
        context,
      );
      input = effectiveInput;
      const fileName = input.filePath.split(/[\\/]/).pop() || input.filePath;
      if (input.action === "read") {
        return {
          toolName: "file_io",
          title: `Read file: ${fileName}`,
          description: `Read the contents of "${input.filePath}".`,
          confirmLabel: "Read",
          cancelLabel: "Cancel",
          fields: [
            {
              type: "text" as const,
              id: "path",
              label: "File",
              value: input.filePath,
            },
          ],
        };
      }
      // write
      const preview =
        (input.content || "").length > 500
          ? (input.content || "").slice(0, 500) +
            `\n... [${(input.content || "").length} chars total]`
          : input.content || "";
      return {
        toolName: "file_io",
        title: `Write file: ${fileName}`,
        description: `Create or overwrite "${input.filePath}".`,
        confirmLabel: "Write",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "text" as const,
            id: "path",
            label: "File",
            value: input.filePath,
          },
          {
            type: "textarea" as const,
            id: "preview",
            label: "Content preview",
            value: preview,
          },
        ],
      };
    },

    async shouldRequireConfirmation(input, _context) {
      // Read operations are safe — auto-approve
      if (input.action === "read") return false;
      const { input: effectiveInput } = resolveFileNoteWriteInput(
        input,
        _context,
      );
      const exists = await fileExists(effectiveInput.filePath);
      // New file writes are reversible by deleting the created file, so they
      // can run directly. Unknown existence is treated like an overwrite.
      if (exists === false) return false;
      // Existing files are overwrites and always require review, even if this
      // conversation previously enabled file_io auto-accept.
      return true;
    },

    applyConfirmation(input, _resolutionData, context) {
      const { input: effectiveInput } = resolveFileNoteWriteInput(
        input,
        context,
      );
      return ok({ ...effectiveInput, allowOverwrite: true });
    },

    async execute(input, context) {
      const { input: effectiveInput, requestedFilePath } =
        resolveFileNoteWriteInput(input, context);
      input = effectiveInput;
      const paperSourceMetadata = buildCodexMineruPaperSourceMetadata(
        input.filePath,
        context.request,
      );
      if (input.action === "read") {
        // Image files: return via artifacts so the LLM can see them visually
        const IMAGE_EXTENSIONS = new Set([
          "png",
          "jpg",
          "jpeg",
          "gif",
          "webp",
          "svg",
        ]);
        const IMAGE_MIME: Record<string, string> = {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          webp: "image/webp",
          svg: "image/svg+xml",
        };
        const fileExt = (
          input.filePath.match(/\.(\w+)$/)?.[1] || ""
        ).toLowerCase();
        if (IMAGE_EXTENSIONS.has(fileExt)) {
          const mimeType = IMAGE_MIME[fileExt] || "image/png";
          // Verify the file exists by attempting a binary read
          const IOUtils = (globalThis as any).IOUtils;
          const OSFile = (globalThis as any).OS?.File;
          let fileExists = false;
          try {
            if (IOUtils?.exists) {
              fileExists = Boolean(await IOUtils.exists(input.filePath));
            } else if (OSFile?.exists) {
              fileExists = Boolean(await OSFile.exists(input.filePath));
            }
          } catch {
            fileExists = false;
          }
          if (!fileExists) {
            return {
              content: {
                action: "read",
                filePath: input.filePath,
                error: "Image file not found",
              },
            };
          }
          const blockMatch = await findMineruImageBlockForRead(
            input.filePath,
            context,
            input.encoding || "utf-8",
          );
          if (blockMatch) {
            const block = blockMatch.block;
            const artifactPaths = block.imagePaths.slice(
              0,
              MAX_MINERU_CONTEXT_IMAGES,
            );
            return {
              content: {
                action: "read",
                filePath: input.filePath,
                imageFile: true,
                mimeType,
                figureBlock: {
                  ...block,
                  truncated:
                    block.imagePaths.length > MAX_MINERU_CONTEXT_IMAGES,
                  omittedImageCount: Math.max(
                    0,
                    block.imagePaths.length - MAX_MINERU_CONTEXT_IMAGES,
                  ),
                },
                ...(paperSourceMetadata || {}),
              },
              artifacts: artifactPaths.map((storedPath) => {
                const ext = (
                  storedPath.match(/\.(\w+)$/)?.[1] || fileExt
                ).toLowerCase();
                return {
                  kind: "image" as const,
                  mimeType: IMAGE_MIME[ext] || mimeType,
                  storedPath,
                  paperContext: paperSourceMetadata?.paperContext,
                };
              }),
            };
          }
          return {
            content: {
              action: "read",
              filePath: input.filePath,
              imageFile: true,
              mimeType,
              ...(paperSourceMetadata || {}),
            },
            artifacts: [
              {
                kind: "image" as const,
                mimeType,
                storedPath: input.filePath,
                paperContext: paperSourceMetadata?.paperContext,
              },
            ],
          };
        }

        // Text files: read with offset/length support
        try {
          const raw = await readFile(input.filePath, input.encoding || "utf-8");
          const start = input.offset || 0;
          const end = input.length ? start + input.length : raw.length;
          const text = raw.slice(start, end);
          return {
            content: {
              action: "read",
              filePath: input.filePath,
              text,
              bytesRead: text.length,
              ...(paperSourceMetadata || {}),
              ...(start > 0 ? { offset: start } : {}),
              ...(text.length < raw.length ? { totalLength: raw.length } : {}),
            },
          };
        } catch (error) {
          return {
            content: {
              action: "read",
              filePath: input.filePath,
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }

      // write
      try {
        if (isMarkdownWritePath(input.filePath)) {
          const guard = await validateMarkdownFigureBlockEmbeds(
            input.content || "",
            context,
            input.encoding || "utf-8",
          );
          if (guard) {
            return {
              action: "write",
              filePath: input.filePath,
              ...(requestedFilePath
                ? {
                    requestedFilePath,
                    correctedToNotesDirectory: true,
                  }
                : {}),
              error: guard.message,
              figureBlock: {
                blockId: guard.block.blockId,
                severity: guard.severity,
                embeddedCount: guard.embeddedCount,
                availableCount: guard.availableCount,
                availablePaths: guard.availablePaths,
              },
            };
          }
        }
        const existedBeforeWrite = await fileExists(input.filePath);
        if (existedBeforeWrite === true && !input.allowOverwrite) {
          return {
            action: "write",
            filePath: input.filePath,
            error:
              "Refusing to overwrite an existing file without confirmation",
          };
        }
        const previousContent =
          existedBeforeWrite === true
            ? await readFile(input.filePath, input.encoding || "utf-8")
            : null;
        await writeFile(
          input.filePath,
          input.content || "",
          input.encoding || "utf-8",
        );
        if (existedBeforeWrite === false) {
          pushUndoEntry(context.request.conversationKey, {
            id: `file-create-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            toolName: "file_io",
            description: `Delete created file: ${input.filePath}`,
            revert: async () => {
              await removeFileIfExists(input.filePath);
            },
          });
        } else if (previousContent !== null) {
          pushUndoEntry(context.request.conversationKey, {
            id: `file-overwrite-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            toolName: "file_io",
            description: `Restore overwritten file: ${input.filePath}`,
            revert: async () => {
              await writeFile(
                input.filePath,
                previousContent,
                input.encoding || "utf-8",
              );
            },
          });
        }
        return {
          action: "write",
          filePath: input.filePath,
          ...(requestedFilePath
            ? {
                requestedFilePath,
                correctedToNotesDirectory: true,
              }
            : {}),
          bytesWritten: (input.content || "").length,
        };
      } catch (error) {
        return {
          action: "write",
          filePath: input.filePath,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
