/**
 * Tool for reading and writing files on the local filesystem.
 * Enables the agent to read data files, write scripts, export results, etc.
 */
import type { AgentToolDefinition } from "../../types";
import { ok, fail, validateObject } from "../shared";
import { isCommandAutoApproved, setCommandAutoApproved } from "./runCommand";

type FileIOInput = {
  action: "read" | "write";
  filePath: string;
  content?: string;
  encoding?: string;
};

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
  const parent = filePath.replace(/[/\\][^/\\]+$/, "");
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
        "Read or write files on the local filesystem. Use this to read data files, write scripts, export analysis results, save CSV/JSON outputs, etc.",
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
          const path = typeof a.filePath === "string" ? a.filePath.split("/").pop() : "file";
          return `${action === "write" ? "Writing" : "Reading"} ${path}`;
        },
        onPending: "Waiting for confirmation on file operation",
        onApproved: "Performing file operation",
        onDenied: "File operation cancelled",
        onSuccess: ({ content }) => {
          const r =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          return String(r.action || "file") === "write"
            ? `File written: ${r.filePath || ""}`
            : `File read: ${r.bytesRead || 0} chars`;
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
      return ok<FileIOInput>({
        action,
        filePath: args.filePath.trim(),
        content: action === "write" ? String(args.content) : undefined,
        encoding,
      });
    },

    createPendingAction(input) {
      const fileName = input.filePath.split("/").pop() || input.filePath;
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

    async execute(input) {
      const maxReadLen = 16000;
      if (input.action === "read") {
        try {
          const raw = await readFile(input.filePath, input.encoding || "utf-8");
          const content =
            raw.length > maxReadLen
              ? raw.slice(0, maxReadLen) +
                `\n... [truncated, ${raw.length} chars total]`
              : raw;
          return {
            action: "read",
            filePath: input.filePath,
            content,
            bytesRead: raw.length,
          };
        } catch (error) {
          return {
            action: "read",
            filePath: input.filePath,
            error: error instanceof Error ? error.message : String(error),
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
