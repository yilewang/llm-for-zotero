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
import { isCommandAutoApproved, setCommandAutoApproved } from "./runCommand";
import { getLocalParentPath } from "../../../utils/localPath";

type FileIOInput = {
  action: "read" | "write";
  filePath: string;
  content?: string;
  encoding?: string;
  offset?: number;
  length?: number;
};

function normalizePathForPrefix(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/g, "");
}

function collectRequestPaperContexts(
  request: AgentToolContext["request"],
): PaperContextRef[] {
  const out: PaperContextRef[] = [];
  const seen = new Set<string>();
  const push = (entry: PaperContextRef | undefined) => {
    if (!entry || !Number.isFinite(entry.itemId) || !Number.isFinite(entry.contextItemId)) return;
    const key = `${entry.itemId}:${entry.contextItemId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };
  for (const entry of request.selectedTextPaperContexts || []) push(entry);
  for (const entry of request.selectedPaperContexts || []) push(entry);
  for (const entry of request.fullTextPaperContexts || []) push(entry);
  for (const entry of request.pinnedPaperContexts || []) push(entry);
  return out;
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
          `When using this content in the answer, include a short verbatim blockquote and put ${sourceLabel} on the next line. A bare parenthetical citation alone is not enough.`,
      };
    }
  }
  return null;
}

/**
 * Read a file using Gecko-compatible I/O APIs.
 */
async function readFile(
  filePath: string,
  encoding: string,
): Promise<string> {
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
    const bytes = result instanceof Uint8Array ? result : new Uint8Array(result);
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
    const IOUtils = (globalThis as any).IOUtils;
    if (IOUtils?.makeDirectory) {
      try {
        await IOUtils.makeDirectory(parent, { createAncestors: true, ignoreExisting: true });
      } catch { /* ignore */ }
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
        "Read or write files on the local filesystem. Reads text files (Markdown, JSON, CSV, etc.) and image files (PNG, JPG, SVG — returned as visual artifacts the model can see). Supports offset/length for partial reads of large files.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["action", "filePath"],
        properties: {
          action: {
            type: "string",
            enum: ["read", "write"],
            description: "'read' to read a file, 'write' to create or overwrite a file.",
          },
          filePath: {
            type: "string",
            description: "Absolute path to the file.",
          },
          content: {
            type: "string",
            description: "For action 'write': the content to write to the file.",
          },
          encoding: {
            type: "string",
            description: "Text encoding (default: 'utf-8').",
          },
          offset: {
            type: "number",
            description: "For action 'read': character offset to start reading from (default: 0). Use with manifest.json charStart/charEnd to read specific paper sections.",
          },
          length: {
            type: "number",
            description: "For action 'read': maximum characters to read. If omitted, reads the entire file from offset to end. Use with offset to read a specific character range.",
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
        "Common uses: write a Python/R script before running it with run_command, read a CSV/JSON data file, " +
        "save analysis results to the user's Desktop, export formatted bibliographies. " +
        "Always use absolute paths.",
    },

    presentation: {
      label: "File I/O",
      summaries: {
        onCall: ({ args }) => {
          const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
          const action = String(a.action || "access");
          const filePath = typeof a.filePath === "string" ? a.filePath : "";
          const fileName = filePath.split(/[\\/]/).pop() || "file";

          if (action === "read") {
            if (fileName === "manifest.json" && filePath.includes("llm-for-zotero-mineru")) {
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
          return `Writing ${fileName}`;
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
          if (fileName === "manifest.json" && filePath.includes("llm-for-zotero-mineru")) {
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
        return fail("Expected an object with action and filePath");
      }
      const action = args.action;
      if (action !== "read" && action !== "write") {
        return fail("action must be 'read' or 'write'");
      }
      if (typeof args.filePath !== "string" || !args.filePath.trim()) {
        return fail("filePath is required: an absolute path to the file");
      }
      if (action === "write" && (typeof args.content !== "string")) {
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
        filePath: args.filePath.trim(),
        content: action === "write" ? String(args.content) : undefined,
        encoding,
        offset,
        length,
      });
    },

    createPendingAction(input) {
      const fileName = input.filePath.split(/[\\/]/).pop() || input.filePath;
      const approvalField = {
        type: "select" as const,
        id: "approvalMode",
        label: "Approval mode",
        value: "ask",
        options: [
          { id: "ask", label: "Ask every time" },
          { id: "auto", label: "Auto accept for this chat" },
        ],
      };
      if (input.action === "read") {
        return {
          toolName: "file_io",
          title: `Read file: ${fileName}`,
          description: `Read the contents of "${input.filePath}".`,
          confirmLabel: "Read",
          cancelLabel: "Cancel",
          fields: [
            { type: "text" as const, id: "path", label: "File", value: input.filePath },
            approvalField,
          ],
        };
      }
      // write
      const preview =
        (input.content || "").length > 500
          ? (input.content || "").slice(0, 500) + `\n... [${(input.content || "").length} chars total]`
          : input.content || "";
      return {
        toolName: "file_io",
        title: `Write file: ${fileName}`,
        description: `Create or overwrite "${input.filePath}".`,
        confirmLabel: "Write",
        cancelLabel: "Cancel",
        fields: [
          { type: "text" as const, id: "path", label: "File", value: input.filePath },
          { type: "textarea" as const, id: "preview", label: "Content preview", value: preview },
          approvalField,
        ],
      };
    },

    shouldRequireConfirmation(input, context) {
      // Read operations are safe — auto-approve
      if (input.action === "read") return false;
      // Write operations require confirmation unless user opted into auto-approve
      return !isCommandAutoApproved(context.request.conversationKey);
    },

    applyConfirmation(input, resolutionData, context) {
      if (validateObject<Record<string, unknown>>(resolutionData)) {
        if (resolutionData.approvalMode === "auto") {
          setCommandAutoApproved(context.request.conversationKey, true);
        }
      }
      return ok(input);
    },

    async execute(input, context) {
      const paperSourceMetadata = buildCodexMineruPaperSourceMetadata(
        input.filePath,
        context.request,
      );
      if (input.action === "read") {
        // Image files: return via artifacts so the LLM can see them visually
        const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
        const IMAGE_MIME: Record<string, string> = {
          png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
          gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
        };
        const fileExt = (input.filePath.match(/\.(\w+)$/)?.[1] || "").toLowerCase();
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
          return {
            content: {
              action: "read",
              filePath: input.filePath,
              imageFile: true,
              mimeType,
              ...(paperSourceMetadata || {}),
            },
            artifacts: [{
              kind: "image" as const,
              mimeType,
              storedPath: input.filePath,
              paperContext: paperSourceMetadata?.paperContext,
            }],
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
        await writeFile(
          input.filePath,
          input.content || "",
          input.encoding || "utf-8",
        );
        return {
          action: "write",
          filePath: input.filePath,
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
