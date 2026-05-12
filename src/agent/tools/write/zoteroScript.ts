/**
 * Tool that gives the agent the ability to execute JavaScript inside Zotero's
 * privileged Gecko runtime. This is the "ultimate generalization" — the agent
 * can perform any operation the Zotero API supports.
 *
 * Two modes:
 * - "read": gather data across many items, no confirmation needed
 * - "write": executes directly with undo instrumentation required
 */
import type { AgentToolDefinition, AgentToolContext } from "../../types";
import { ok, fail, validateObject } from "../shared";
import { pushUndoEntry } from "../../store/undoStore";

// ── Types ───────────────────────────────────────────────────────────────────

type ZoteroScriptInput = {
  mode: "read" | "write";
  script: string;
  description: string;
  timeoutMs: number;
};

type ItemSnapshot = {
  itemId: number;
  fields: Record<string, string>;
  tags: Array<{ tag: string }>;
  collectionIds: number[];
  creators: unknown[];
};

type ScriptResult = {
  output: string;
  snapshots: Map<number, ItemSnapshot>;
  undoSteps: Array<() => Promise<void>>;
  error?: string;
};

// ── Snapshot fields ─────────────────────────────────────────────────────────

const SNAPSHOT_FIELDS = [
  "title",
  "shortTitle",
  "abstractNote",
  "publicationTitle",
  "journalAbbreviation",
  "proceedingsTitle",
  "date",
  "volume",
  "issue",
  "pages",
  "DOI",
  "url",
  "language",
  "extra",
  "ISSN",
  "ISBN",
  "publisher",
  "place",
];

function captureItemSnapshot(item: any): ItemSnapshot {
  const fields: Record<string, string> = {};
  for (const field of SNAPSHOT_FIELDS) {
    try {
      fields[field] = String(item.getField?.(field) ?? "");
    } catch {
      /* field may not be valid for this item type */
    }
  }
  let tags: Array<{ tag: string }> = [];
  try {
    tags = (item.getTags?.() || []).map((t: any) => ({
      tag: String(t.tag || t),
    }));
  } catch {
    /* ignore */
  }
  let collectionIds: number[] = [];
  try {
    collectionIds = item.getCollections?.() || [];
  } catch {
    /* ignore */
  }
  let creators: unknown[] = [];
  try {
    creators = item.getCreatorsJSON?.() || [];
  } catch {
    /* ignore */
  }
  return { itemId: item.id, fields, tags, collectionIds, creators };
}

// ── Undo ────────────────────────────────────────────────────────────────────

function buildRevertFunction(
  snapshots: Map<number, ItemSnapshot>,
  undoSteps: Array<() => Promise<void>>,
): () => Promise<void> {
  return async () => {
    // Restore snapshots
    for (const snapshot of snapshots.values()) {
      try {
        const item = (Zotero as any).Items.get(snapshot.itemId);
        if (!item) continue;

        // Restore fields
        for (const [field, value] of Object.entries(snapshot.fields)) {
          try {
            item.setField(field, value);
          } catch {
            /* skip invalid fields */
          }
        }

        // Restore creators
        try {
          if (Array.isArray(snapshot.creators) && item.setCreators) {
            item.setCreators(snapshot.creators);
          }
        } catch {
          /* ignore */
        }

        // Restore tags: remove added, re-add removed
        const currentTagList: string[] = (item.getTags?.() || []).map(
          (t: any) => String(t.tag || t),
        );
        const currentTags = new Set(currentTagList);
        const snapshotTags = new Set(snapshot.tags.map((t) => t.tag));
        for (const tag of currentTagList) {
          if (!snapshotTags.has(tag)) {
            try {
              item.removeTag(tag);
            } catch {
              /* ignore */
            }
          }
        }
        for (const { tag } of snapshot.tags) {
          if (!currentTags.has(tag)) {
            try {
              item.addTag(tag);
            } catch {
              /* ignore */
            }
          }
        }

        // Restore collections: remove added, re-add removed
        const currentColls = new Set<number>(item.getCollections?.() || []);
        const snapshotColls = new Set(snapshot.collectionIds);
        for (const id of currentColls) {
          if (!snapshotColls.has(id)) {
            try {
              item.removeFromCollection(id);
            } catch {
              /* ignore */
            }
          }
        }
        for (const id of snapshotColls) {
          if (!currentColls.has(id)) {
            try {
              item.addToCollection(id);
            } catch {
              /* ignore */
            }
          }
        }

        await item.saveTx();
      } catch (error) {
        Zotero.debug?.(
          `[llm-for-zotero] Undo snapshot restore failed for item ${snapshot.itemId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // Run custom undo steps in reverse
    for (const step of [...undoSteps].reverse()) {
      try {
        await step();
      } catch {
        /* ignore */
      }
    }
  };
}

// ── Script execution ────────────────────────────────────────────────────────

async function executeScript(params: {
  script: string;
  mode: "read" | "write";
  timeoutMs: number;
  libraryID: number;
}): Promise<ScriptResult> {
  const logBuffer: string[] = [];
  const snapshots = new Map<number, ItemSnapshot>();
  const undoSteps: Array<() => Promise<void>> = [];
  const isWrite = params.mode === "write";

  const env = {
    mode: params.mode,
    libraryID: params.libraryID,
    log: (msg: string) => {
      logBuffer.push(String(msg));
    },
    snapshot: (item: any) => {
      if (!isWrite) return; // no-op in read mode
      if (item?.id && !snapshots.has(item.id)) {
        snapshots.set(item.id, captureItemSnapshot(item));
      }
    },
    addUndoStep: (fn: () => Promise<void>) => {
      if (!isWrite) return; // no-op in read mode
      undoSteps.push(fn);
    },
  };

  try {
    // Use AsyncFunction constructor (like `new Function` but for async bodies)
    const AsyncFunction = Object.getPrototypeOf(
      async function () {},
    ).constructor;
    const fn = new AsyncFunction("Zotero", "env", params.script);

    const timeoutPromise = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), params.timeoutMs),
    );

    const resultPromise = fn(Zotero, env);

    const raceResult = await Promise.race([resultPromise, timeoutPromise]);
    if (raceResult === "timeout") {
      return {
        output: logBuffer.join("\n") + "\n[Script timed out]",
        snapshots,
        undoSteps,
        error: `Script timed out after ${params.timeoutMs}ms`,
      };
    }

    const maxLen = 8000;
    const output = logBuffer.join("\n");
    return {
      output:
        output.length > maxLen
          ? output.slice(0, maxLen) +
            `\n... [truncated, ${output.length} chars total]`
          : output,
      snapshots,
      undoSteps,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      output: logBuffer.join("\n") + `\n[Error: ${errMsg}]`,
      snapshots,
      undoSteps,
      error: errMsg,
    };
  }
}

// ── Library ID resolution ───────────────────────────────────────────────────

function resolveLibraryID(context: AgentToolContext): number {
  const requestLibraryID = (context.request as any).libraryID;
  if (typeof requestLibraryID === "number" && requestLibraryID > 0) {
    return requestLibraryID;
  }
  return (Zotero as unknown as { Libraries: { userLibraryID: number } })
    .Libraries.userLibraryID;
}

function hasUndoInstrumentation(script: string): boolean {
  return /\benv\s*\.\s*(?:snapshot|addUndoStep)\s*\(/.test(script);
}

// ── Guidance ────────────────────────────────────────────────────────────────

const ZOTERO_SCRIPT_GUIDANCE = `## zotero_script — Zotero Runtime JavaScript

Your script receives two globals:
- \`Zotero\` — the full Zotero API object
- \`env\` — execution environment

### env object
- \`env.mode\`: "read" or "write"
- \`env.libraryID\`: number (active library ID)
- \`env.log(msg)\`: append output (shown to user / returned to agent)
- \`env.snapshot(item)\`: capture item state for undo (write mode only, call BEFORE mutating)
- \`env.addUndoStep(fn)\`: register custom undo function (write mode only)

### Write mode template
\`\`\`javascript
const items = await Zotero.Items.getAll(env.libraryID, false, false, false);
for (const item of items) {
  if (!item.isRegularItem()) continue;
  env.snapshot(item);
  const title = item.getField('title');
  item.setField('title', title + ' — updated');
  await item.saveTx();
  env.log(\`Updated: \${title}\`);
}
\`\`\`

### Read mode template
\`\`\`javascript
const items = await Zotero.Items.getAll(env.libraryID, false, false, false);
let count = 0;
for (const item of items) {
  if (!item.isRegularItem()) continue;
  env.log(\`\${item.id}: \${item.getField('title')}\`);
  count++;
}
env.log(\`Total: \${count} items\`);
\`\`\`

### Common APIs
- Get all items: \`await Zotero.Items.getAll(env.libraryID, false, false, false)\`
- Get item by ID: \`Zotero.Items.get(id)\`
- Fields: \`item.getField(name)\`, \`item.setField(name, value)\`
- Creators: \`item.getCreatorsJSON()\`, \`item.setCreators(array)\`
- Tags: \`item.getTags()\`, \`item.addTag(name)\`, \`item.removeTag(name)\`
- Attachments: \`item.getAttachments()\` → array of IDs
- Notes: \`item.getNotes()\` → array of IDs
- Collections: \`item.getCollections()\` → array of IDs
- Collection ops: \`item.addToCollection(id)\`, \`item.removeFromCollection(id)\`
- Save: \`await item.saveTx()\`
- Type checks: \`item.isRegularItem()\`, \`item.isAttachment()\`, \`item.isNote()\`
- Attachment file: \`att.attachmentContentType\`, \`att.attachmentFilename\`, \`att.getFilePath()\`
- Rename attachment: \`await Zotero.Attachments.renameAttachmentFile(att, newName)\`
- Read file: \`await IOUtils.read(filePath)\` → Uint8Array, then \`new TextDecoder().decode(bytes)\`
- Search: \`const s = new Zotero.Search({libraryID: env.libraryID}); s.addCondition(field, op, value); const ids = await s.search();\`
- Collections: \`Zotero.Collections.getByLibrary(env.libraryID)\`
- Create collection: \`const c = new Zotero.Collection(); c.libraryID = env.libraryID; c.name = "Name"; await c.saveTx();\`

### Rules
1. Write mode: ALWAYS call \`env.snapshot(item)\` before mutating any item (enables undo)
2. Write mode: ALWAYS call \`await item.saveTx()\` after mutations
3. Use \`env.log(msg)\` to report progress — this output is shown to the user
4. The script body is an async function — top-level await is supported
5. Do NOT use \`eraseTx()\` — use Zotero trash instead (item.deleted = true; await item.saveTx())
6. Write straightforward code — no dry-run branching needed. The script runs directly, and undo_last_action uses snapshots/custom undo steps to revert it.`;

// ── Tool definition ─────────────────────────────────────────────────────────

export function createZoteroScriptTool(): AgentToolDefinition<
  ZoteroScriptInput,
  unknown
> {
  return {
    spec: {
      name: "zotero_script",
      description:
        "Execute a JavaScript script inside Zotero's runtime with full API access. " +
        "Two modes: mode:'read' for gathering data across many items (no confirmation); " +
        "mode:'write' for mutations (runs directly with undo support; env.snapshot(item) or env.addUndoStep(fn) is required). " +
        "The script receives the global Zotero object and an env helper (env.log, env.snapshot, env.addUndoStep, env.libraryID). " +
        "Not for ordinary Zotero paper/library reading when semantic Zotero tools can answer.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["mode", "script", "description"],
        properties: {
          mode: {
            type: "string",
            enum: ["read", "write"],
            description:
              "'read' for gathering/computing data, 'write' for mutations (direct execution + undo).",
          },
          script: {
            type: "string",
            description:
              "JavaScript code to execute in Zotero's runtime. " +
              "Receives globals: Zotero (full API) and env (helpers). Top-level await is supported.",
          },
          description: {
            type: "string",
            description: "Human-readable summary of what the script does.",
          },
          timeoutMs: {
            type: "number",
            description:
              "Timeout in milliseconds (default: 30000, max: 120000).",
          },
        },
      },
      mutability: "write",
      requiresConfirmation: false,
    },

    guidance: {
      matches: (request) =>
        /\b(rename.*all|batch|bulk|all.*attachments|all.*items|every.*paper|for\s+each|iterate|loop|procedural|custom.*script|scan.*all|check.*every|find.*all.*that)\b/i.test(
          request.userText || "",
        ),
      instruction: ZOTERO_SCRIPT_GUIDANCE,
    },

    presentation: {
      label: "Zotero Script",
      summaries: {
        onCall: ({ args }) => {
          const a =
            args && typeof args === "object"
              ? (args as Record<string, unknown>)
              : {};
          const mode = String(a.mode || "script");
          const desc =
            typeof a.description === "string"
              ? a.description
              : "Zotero operation";
          return `${mode === "read" ? "Reading" : "Running"}: ${desc}`;
        },
        onPending: "Preparing Zotero script",
        onApproved: "Executing Zotero script",
        onDenied: "Script cancelled",
        onSuccess: ({ content }) => {
          const r =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          if (r.error) return `Script error: ${String(r.error)}`;
          const count =
            typeof r.itemsAffected === "number" ? r.itemsAffected : undefined;
          return count !== undefined
            ? `Script completed — ${count} item${count === 1 ? "" : "s"} affected`
            : "Script completed successfully";
        },
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object with mode, script, and description");
      }
      const mode = args.mode;
      if (mode !== "read" && mode !== "write") {
        return fail("mode must be 'read' or 'write'");
      }
      if (typeof args.script !== "string" || !args.script.trim()) {
        return fail("script is required: the JavaScript code to execute");
      }
      if (typeof args.description !== "string" || !args.description.trim()) {
        return fail(
          "description is required: a human-readable summary of what the script does",
        );
      }
      const script = args.script.trim();
      if (mode === "write" && !hasUndoInstrumentation(script)) {
        return fail(
          "mode 'write' scripts must call env.snapshot(item) before mutating Zotero items, or env.addUndoStep(fn) for custom changes, so undo_last_action can revert the operation",
        );
      }
      const timeoutRaw =
        typeof args.timeoutMs === "number" && args.timeoutMs > 0
          ? args.timeoutMs
          : 30000;
      const timeoutMs = Math.min(Math.max(timeoutRaw, 1000), 120000);

      return ok<ZoteroScriptInput>({
        mode,
        script,
        description: args.description.trim(),
        timeoutMs,
      });
    },

    shouldRequireConfirmation() {
      return false;
    },

    async execute(input, context) {
      const libraryID = resolveLibraryID(context);

      const result = await executeScript({
        script: input.script,
        mode: input.mode,
        timeoutMs: input.timeoutMs,
        libraryID,
      });

      // Register undo for write mode
      if (
        input.mode === "write" &&
        (result.snapshots.size > 0 || result.undoSteps.length > 0)
      ) {
        pushUndoEntry(context.request.conversationKey, {
          id: `undo-zotero_script-${Date.now()}`,
          toolName: "zotero_script",
          description: `Undo: ${input.description} (${result.snapshots.size} item${result.snapshots.size === 1 ? "" : "s"} snapshotted)`,
          revert: buildRevertFunction(result.snapshots, result.undoSteps),
        });
      }

      return {
        mode: input.mode,
        description: input.description,
        output: result.output,
        itemsAffected: result.snapshots.size,
        error: result.error || undefined,
      };
    },
  };
}
