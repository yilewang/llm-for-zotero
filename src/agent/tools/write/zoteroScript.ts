/**
 * Tool that gives the agent the ability to execute JavaScript inside Zotero's
 * privileged Gecko runtime. This is the "ultimate generalization" — the agent
 * can perform any operation the Zotero API supports.
 *
 * Both modes execute privileged code and therefore require source review.
 * "read" means that no undo instrumentation is expected; it is not an
 * authorization boundary and must never bypass confirmation.
 */
import type { AgentWriteToolDefinition, AgentToolContext } from "../../types";
import { ok, fail, validateObject } from "../shared";
import {
  currentMutationActionId,
  executeExternalMutation,
} from "../../services/mutationCoordinator";
import { listJournalObservationObjectIds } from "../../store/changeJournal";
import {
  sha256Bytes,
  sha256Text,
  storeRecoveryText,
} from "../../store/journalRecoveryBlobStore";
import { zoteroChangeDispatcher } from "../../../services/zoteroChangeDispatcher";
import { LibraryMutationService } from "../../services/libraryMutationService";
import { ZoteroGateway } from "../../services/zoteroGateway";
import { parseInverseValue } from "../../services/changeReverter";
import { fingerprintText } from "../../contracts/actionOperationEvidence";

// ── Types ───────────────────────────────────────────────────────────────────

type ZoteroScriptInput = {
  mode: "read" | "write";
  script: string;
  description: string;
  timeoutMs: number;
};

type ZoteroScriptRuntimeOptions = {
  /** Explicit unit-test seam. Production execution must fail closed. */
  allowUnsandboxedTestExecution?: boolean;
};

export type ItemSnapshot = {
  itemId: number;
  fields: Record<string, string>;
  tags: Array<{ tag: string; type?: number }>;
  collectionIds: number[];
  creators: unknown[];
  /**
   * State outside the editable-metadata field list.
   *
   * `SNAPSHOT_FIELDS` is a copy of the 18 fields the metadata tool can edit,
   * which meant a script that reparented a note, changed an item type, or
   * trashed something satisfied the undo-instrumentation check and then could
   * not be reverted at all. Changing an item's type is the worst case: Zotero
   * drops fields that are invalid for the new type, so the data is gone and
   * the snapshot never knew it existed.
   */
  parentID?: number;
  deleted?: boolean;
  itemTypeID?: number;
  noteHtml?: string;
  /** Full pre-image, used to restore fields the flat list above misses. */
  json?: unknown;
};

type ScriptResult = {
  output: string;
  /**
   * Whatever the script returned.
   *
   * This used to be thrown away — `raceResult` was only ever compared to
   * `"timeout"` — so the only channel back to the model was `env.log`, capped
   * at 8000 characters. A script that enumerated 400 ids reported about 180
   * of them and nothing said the rest were missing, which is what made
   * multi-step work over a real library impossible.
   */
  returnValue?: unknown;
  /** True when `output` was cut short, so the caller can say so out loud. */
  outputTruncated?: boolean;
  snapshots: Map<number, ItemSnapshot>;
  declarativeInverses: unknown[];
  createdItemIds: Set<number>;
  error?: string;
};

type CapturedDeclaredInverses = {
  guards: unknown[];
  itemIds: number[];
  inverses: unknown[];
  warnings: string[];
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

/**
 * Reads a note's HTML, or undefined for anything that is not a note.
 *
 * `getNote` is a prototype method on EVERY Zotero.Item, so a `typeof` guard
 * always passes — and the real implementation throws for anything that is not
 * a note or attachment, and throws UnloadedDataException for a note whose
 * text is not loaded. An unguarded call here aborted `env.snapshot`, which is
 * the tool's own mandatory first step, so every write-mode script failed
 * before its first mutation.
 */
/**
 * Compiles the script with a controlled global scope.
 *
 * `new AsyncFunction("Zotero", "env", src)` compiles in the plugin's own
 * realm, where `globalThis.Zotero`, `IOUtils` and `ChromeUtils` are ambient.
 * Binding `Zotero` as a parameter therefore fenced nothing at all: any script
 * could reach the unwrapped globals in one line, and `mode:'read'` was a
 * declaration rather than a boundary — a read script could write freely.
 *
 * A `Cu.Sandbox` with an explicit global set is the fix, and Zotero's own
 * plugin loader uses exactly this recipe. Production execution fails closed
 * when that boundary is unavailable; unit tests use an explicit seam instead
 * of silently weakening shipped behavior.
 */
function compileScript(
  source: string,
  isWrite: boolean,
  options: ZoteroScriptRuntimeOptions,
): (zotero: unknown, env: unknown) => Promise<unknown> {
  const cu = getComponentsUtils();
  const sandbox = createScriptSandbox(isWrite);
  if (sandbox && typeof cu?.evalInSandbox === "function") {
    try {
      // Evaluated inside the sandbox, so the compiled function closes over
      // the sandbox's globals rather than the plugin realm's.
      const factory = cu.evalInSandbox(
        `(function () { return async function (Zotero, env) {\n${source}\n}; })()`,
        sandbox,
      ) as (zotero: unknown, env: unknown) => Promise<unknown>;
      if (typeof factory === "function") return factory;
    } catch (error) {
      // Loud, not silent: a sandbox that fails to compile means privileged
      // source is no longer isolated from the plugin realm.
      Zotero.debug?.(
        `[llm-for-zotero] zotero_script sandbox compile failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  } else {
    Zotero.debug?.(
      "[llm-for-zotero] zotero_script sandbox unavailable; refusing privileged execution.",
    );
  }
  if (!options.allowUnsandboxedTestExecution) {
    throw new Error(
      "Zotero script sandbox is unavailable. The script was not executed.",
    );
  }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction("Zotero", "env", source) as (
    zotero: unknown,
    env: unknown,
  ) => Promise<unknown>;
}

/**
 * `Components.utils` — the object that carries BOTH `Sandbox` and
 * `evalInSandbox`.
 *
 * An earlier version looked the constructor up on `globalThis.Cu` (which the
 * plugin scope does not define) falling back to `ChromeUtils.Sandbox` (which
 * does not exist — the typings put both members on `nsIXPCComponents_utils`,
 * not on the `ChromeUtils` namespace), and then read the evaluator off
 * `ChromeUtils` separately. Constructor and evaluator resolved from two
 * different objects that can never both be `Components.utils`, so the branch
 * was unreachable in every runtime and every script silently took the
 * in-realm fallback.
 */
function getComponentsUtils(): any {
  const globals = globalThis as any;
  return globals.Components?.utils || globals.Cu || null;
}

/**
 * A sandbox whose globals are only what a Zotero script legitimately needs.
 *
 * Notably absent: `Components`, `Services`, and `ChromeUtils`, each of which
 * is a route back to the unwrapped platform. `Zotero.DB` is withheld in write
 * mode as well — raw SQL emits no notifier events and cannot be inverted by
 * any mechanism, so a script that reaches it is unjournalable by
 * construction.
 */
function createScriptSandbox(isWrite: boolean): unknown | null {
  const cu = getComponentsUtils();
  const sandboxCtor = cu?.Sandbox;
  const principal = (
    globalThis as any
  ).Services?.scriptSecurityManager?.getSystemPrincipal?.();
  if (typeof sandboxCtor !== "function" || !principal) return null;
  try {
    const sandbox = new sandboxCtor(principal, {
      sandboxName: "llm-for-zotero:zotero_script",
      // TextDecoder/TextEncoder are here because the tool's own guidance
      // tells the model to use them; omitting them would throw a
      // ReferenceError the first time the sandbox actually engaged.
      wantGlobalProperties: [
        "atob",
        "btoa",
        "fetch",
        "TextDecoder",
        "TextEncoder",
      ],
      wantComponents: false,
    });
    Object.assign(sandbox, {
      Zotero: buildScriptZotero(isWrite),
      setTimeout: (globalThis as any).setTimeout,
      clearTimeout: (globalThis as any).clearTimeout,
      console: (globalThis as any).console,
    });
    return sandbox;
  } catch {
    return null;
  }
}

/**
 * The Zotero handed to a script. Write mode loses `DB`: raw SQL bypasses the
 * notifier entirely and cannot be reverted, so it must not be reachable from
 * a script whose whole contract is that its changes are undoable.
 */
function buildScriptZotero(isWrite: boolean): unknown {
  const real = Zotero as unknown as Record<string, unknown>;
  if (!isWrite) return real;
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "DB") {
        throw new Error(
          "Zotero.DB is not available to write-mode scripts: raw SQL emits no change notifications and cannot be undone. Use the Zotero item and collection APIs instead.",
        );
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function captureNoteHtml(item: any): string | undefined {
  try {
    if (!item?.isNote?.()) return undefined;
    return String(item.getNote?.() ?? "");
  } catch {
    return undefined;
  }
}

function captureItemSnapshot(item: any): ItemSnapshot {
  const fields: Record<string, string> = {};
  for (const field of SNAPSHOT_FIELDS) {
    try {
      fields[field] = String(item.getField?.(field) ?? "");
    } catch {
      /* field may not be valid for this item type */
    }
  }
  let tags: Array<{ tag: string; type?: number }> = [];
  try {
    tags = (item.getTags?.() || []).map((entry: any) => {
      const tag = String(entry?.tag || entry || "");
      const type = Number(entry?.type);
      return {
        tag,
        ...(Number.isFinite(type) ? { type } : {}),
      };
    });
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
  // A full pre-image covers everything the flat field list does not. It is
  // cheap next to the Zotero API calls already made above, and it is the only
  // thing that can restore an item after a type change.
  let json: unknown;
  try {
    json = item.toJSON?.();
  } catch {
    /* some item types refuse toJSON; the flat fields still apply */
  }
  const readNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  return {
    itemId: item.id,
    fields,
    tags,
    collectionIds,
    creators,
    parentID: readNumber(item.parentID),
    deleted: item.deleted === true,
    itemTypeID: readNumber(item.itemTypeID),
    noteHtml: captureNoteHtml(item),
    json,
  };
}

function captureScriptItemPostconditions(itemIds: Iterable<number>): unknown[] {
  return [...new Set(itemIds)]
    .sort((left, right) => left - right)
    .map((itemId) => {
      const item = (
        Zotero as unknown as { Items?: { get?: (id: number) => any } }
      ).Items?.get?.(itemId);
      if (!item) return { itemId, exists: false };
      let json: unknown;
      try {
        json = item.toJSON?.();
      } catch {
        json = undefined;
      }
      return {
        itemId,
        exists: true,
        json,
        parentID: Number(item.parentID) || null,
        deleted: item.deleted === true,
        tags: item.getTags?.() || [],
        collectionIds: item.getCollections?.() || [],
        noteHtml: captureNoteHtml(item),
      };
    });
}

async function captureScriptFilePostcondition(path: string): Promise<{
  kind: "file";
  path: string;
  exists: boolean;
  checksum: string | null;
}> {
  const io = (globalThis as { IOUtils?: any }).IOUtils;
  const exists = Boolean(await io?.exists?.(path));
  if (!exists) return { kind: "file", path, exists: false, checksum: null };
  if (typeof io?.read !== "function") {
    throw new Error(`Cannot guard declarative file inverse for ${path}`);
  }
  const bytes = new Uint8Array(await io.read(path));
  return {
    kind: "file",
    path,
    exists: true,
    checksum: await sha256Bytes(bytes),
  };
}

async function captureDeclaredInverseGuards(
  values: unknown[],
  context: AgentToolContext,
): Promise<CapturedDeclaredInverses> {
  const gateway = new ZoteroGateway();
  const service = new LibraryMutationService(gateway);
  const guards: unknown[] = [];
  const itemIds = new Set<number>();
  const inverses: unknown[] = [];
  const warnings: string[] = [];
  for (const [index, value] of values.entries()) {
    const inverse = parseInverseValue(value);
    if (!inverse || inverse.kind === "script_snapshots") {
      warnings.push(
        `Declarative inverse ${index + 1} was unsupported and was not journalled.`,
      );
      continue;
    }
    const inverseGuards: unknown[] = [];
    const inverseItemIds = new Set<number>();
    try {
      if (inverse.kind === "library_operations") {
        for (const operation of inverse.operations) {
          const state = await service.captureOperationState(operation, context);
          for (const item of state.items || []) {
            inverseItemIds.add(item.itemId);
          }
          inverseGuards.push({ kind: "library_operation", operation, state });
        }
      } else if (inverse.kind === "note_html") {
        const item = gateway.getItem(inverse.noteId);
        inverseItemIds.add(inverse.noteId);
        inverseGuards.push({
          kind: "note_html",
          noteId: inverse.noteId,
          checksum: await sha256Text(item?.getNote?.() || ""),
        });
      } else if (inverse.kind === "file") {
        inverseGuards.push(await captureScriptFilePostcondition(inverse.path));
      } else {
        const setting = gateway
          .listSettings()
          .find((entry) => entry.key === inverse.key);
        inverseGuards.push({
          kind: "preference",
          key: inverse.key,
          existed: setting?.value !== undefined,
          value: setting?.value,
        });
      }
    } catch (error) {
      warnings.push(
        `Declarative inverse ${index + 1} could not be guarded and was not journalled: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    guards.push(...inverseGuards);
    inverseItemIds.forEach((itemId) => itemIds.add(itemId));
    inverses.push(inverse);
  }
  return { guards, itemIds: [...itemIds], inverses, warnings };
}

async function captureScriptPostcondition(
  itemIds: Iterable<number>,
  declarativeInverses: unknown[],
  context: AgentToolContext,
): Promise<{
  postcondition: unknown;
  guardedItemIds: number[];
  declaredInverses: unknown[];
  warnings: string[];
}> {
  const declared = await captureDeclaredInverseGuards(
    declarativeInverses,
    context,
  );
  const guardedItemIds = [...new Set([...itemIds, ...declared.itemIds])].sort(
    (left, right) => left - right,
  );
  return {
    postcondition: {
      kind: "script_effects",
      items: captureScriptItemPostconditions(guardedItemIds),
      declared: declared.guards,
    },
    guardedItemIds,
    declaredInverses: declared.inverses,
    warnings: declared.warnings,
  };
}

function scriptResultContent(
  input: ZoteroScriptInput,
  result: ScriptResult,
  uncoveredObservedIds: number[] = [],
  recoveryWarnings: string[] = [],
): Record<string, unknown> {
  return {
    mode: input.mode,
    description: input.description,
    output: result.output,
    returnValue: result.returnValue,
    outputTruncated: result.outputTruncated || undefined,
    itemsAffected: new Set([
      ...result.snapshots.keys(),
      ...result.createdItemIds,
    ]).size,
    declaredInverseCount: result.declarativeInverses.length || undefined,
    uncoveredObservedIds: uncoveredObservedIds.length
      ? uncoveredObservedIds
      : undefined,
    recoveryWarnings: recoveryWarnings.length ? recoveryWarnings : undefined,
    error: result.error || undefined,
  };
}

// ── Script execution ────────────────────────────────────────────────────────

async function executeScript(params: {
  script: string;
  mode: "read" | "write";
  timeoutMs: number;
  libraryID: number;
  runtimeOptions: ZoteroScriptRuntimeOptions;
}): Promise<ScriptResult> {
  const logBuffer: string[] = [];
  const snapshots = new Map<number, ItemSnapshot>();
  const declarativeInverses: unknown[] = [];
  const createdItemIds = new Set<number>();
  const isWrite = params.mode === "write";
  const deadline = Date.now() + params.timeoutMs;

  const env = {
    mode: params.mode,
    libraryID: params.libraryID,
    log: (msg: string) => {
      logBuffer.push(String(msg));
    },
    /**
     * True once the script has run past its time budget.
     *
     * JavaScript cannot interrupt a running function that owns live Zotero
     * objects. When the budget expires the tool keeps waiting for the script
     * to settle before returning. A loop that checks this can stop at a clean
     * boundary promptly instead of holding the request open indefinitely.
     */
    shouldStop: () => Date.now() >= deadline,
    /** Milliseconds left before `shouldStop()` starts returning true. */
    remainingMs: () => Math.max(0, deadline - Date.now()),
    snapshot: (item: any) => {
      if (!isWrite) return; // no-op in read mode
      if (item?.id && !snapshots.has(item.id)) {
        try {
          snapshots.set(item.id, captureItemSnapshot(item));
        } catch (error) {
          // Snapshotting must never abort the user's script. A field that
          // cannot be read costs undo fidelity for that item; throwing here
          // costs the whole operation, which is strictly worse.
          logBuffer.push(
            `[snapshot warning] could not fully snapshot item ${item.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    },
    addInverse: (inverse: unknown) => {
      if (!isWrite) return;
      try {
        // Cross-realm functions and cyclic objects must never enter the
        // durable journal. A JSON round-trip also gives us detached data.
        const serialized = JSON.stringify(inverse);
        if (!serialized || serialized === "null") {
          throw new Error("inverse must be a serializable object");
        }
        const detached = JSON.parse(serialized) as unknown;
        const parsed = parseInverseValue(detached);
        if (!parsed || parsed.kind === "script_snapshots") {
          throw new Error("inverse kind or payload is unsupported");
        }
        declarativeInverses.push(parsed);
      } catch (error) {
        throw new Error(
          `env.addInverse requires declarative JSON data: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
    recordCreatedItem: (itemOrId: unknown) => {
      if (!isWrite) return;
      const id = Math.floor(
        Number(
          itemOrId && typeof itemOrId === "object"
            ? (itemOrId as { id?: unknown }).id
            : itemOrId,
        ),
      );
      if (!Number.isFinite(id) || id <= 0) {
        throw new Error(
          "env.recordCreatedItem requires a saved item or item ID",
        );
      }
      createdItemIds.add(id);
    },
  };

  try {
    const fn = compileScript(params.script, isWrite, params.runtimeOptions);

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), params.timeoutMs);
    });

    // The proxied Zotero is passed on BOTH paths. The sandbox additionally
    // closes the ambient-globals bypass where it is available; this guard
    // holds even when it is not.
    const resultPromise = fn(buildScriptZotero(isWrite), env);

    let raceResult: unknown | "timeout";
    try {
      raceResult = await Promise.race([resultPromise, timeoutPromise]);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
    if (raceResult === "timeout") {
      // JavaScript cannot be force-interrupted safely while it owns live
      // Zotero objects. Keep ownership of this frame until it settles so the
      // tool never returns while writes continue behind the user's back and
      // so every recorded undo step is included.
      let settledValue: unknown;
      try {
        settledValue = await resultPromise;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          output:
            logBuffer.join("\n") +
            `\n[Script exceeded its ${params.timeoutMs}ms deadline and then failed: ${message}]`,
          snapshots,
          declarativeInverses,
          createdItemIds,
          error: message,
        };
      }
      return {
        output:
          logBuffer.join("\n") +
          `\n[Script exceeded its ${params.timeoutMs}ms deadline but was allowed to settle before this result was returned. Check env.shouldStop() inside long loops and return early.]`,
        returnValue: settledValue,
        snapshots,
        declarativeInverses,
        createdItemIds,
        error: `Script timed out after ${params.timeoutMs}ms`,
      };
    }

    const maxLen = 8000;
    const output = logBuffer.join("\n");
    const truncated = output.length > maxLen;
    return {
      output: truncated
        ? output.slice(0, maxLen) +
          `\n... [log truncated, ${output.length} chars total. Return data from the script instead of logging it — the return value is delivered in full.]`
        : output,
      outputTruncated: truncated,
      returnValue: raceResult,
      snapshots,
      declarativeInverses,
      createdItemIds,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      output: logBuffer.join("\n") + `\n[Error: ${errMsg}]`,
      snapshots,
      declarativeInverses,
      createdItemIds,
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
  return /\benv\s*\.\s*(?:snapshot|addInverse|recordCreatedItem)\s*\(/.test(
    script,
  );
}

function attemptsDirectNoteWrite(script: string): boolean {
  return (
    /\bnew\s+Zotero\s*\.\s*Item\s*\(\s*["']note["']\s*\)/i.test(script) ||
    /\.\s*setNote\s*\(/.test(script) ||
    /\bZotero\s*\.\s*Notes\b/.test(script)
  );
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
- \`env.addInverse(data)\`: register a supported declarative inverse as JSON data
- \`env.recordCreatedItem(itemOrId)\`: record a newly saved item so undo can trash it

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
Beyond items and collections, the full local Zotero API is available here, and
several areas have no typed tool at all — reach for them directly:
\`Zotero.Tags\` (rename/delete/colour a tag library-wide),
\`Zotero.Attachments.importFromFile / linkFromFile\`,
\`Zotero.Searches\` (saved searches),
\`Zotero.Annotations\` (highlights and their comments),
\`Zotero.FullText\` (reindexing),
\`Zotero.Duplicates\`,
\`Zotero.Translate.Export\` (BibTeX/RIS/bibliographies).

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
1. Write mode: ALWAYS call \`env.snapshot(item)\` before mutating an existing item. For newly saved items call \`env.recordCreatedItem(item)\`. For non-item changes use \`env.addInverse(data)\`; callback undo functions are rejected because they do not survive restart.
2. Write mode: ALWAYS call \`await item.saveTx()\` after mutations
3. Use \`env.log(msg)\` for PROGRESS ONLY — the log is capped at 8000 characters and is truncated silently past that. **Return your data instead**: whatever the script returns is delivered to you in full. \`return itemIds\` beats logging four hundred lines of them.
3a. For results too large to hold in one turn, write them to a file with \`IOUtils.writeUTF8(path, JSON.stringify(data))\` and read them back in pages with \`file_io\`. The filesystem is your scratch space between steps.
4. The script body is an async function — top-level await is supported
5. Do NOT use \`eraseTx()\` — use Zotero trash instead (item.deleted = true; await item.saveTx())
6. Do NOT create or edit Zotero notes here. Use note_write for all Zotero note creation, edits, and appends so note validation still runs.
7. Write mode runs with \`Zotero.DB\` withheld: raw SQL emits no change notifications and cannot be undone, so use the item and collection APIs. Read mode keeps it.
8. Write straightforward code — no dry-run branching needed. The script runs directly, and undo_last_action uses durable snapshots and declarative inverses to revert covered effects.
9. In any loop over more than a few dozen items, check \`env.shouldStop()\` and return early when it is true. The timeout cannot interrupt a running script — it only stops *waiting* for it — so a script that ignores this keeps mutating the library after the tool has already reported failure, and those later changes cannot be undone. Return partial results; a partial answer you can undo beats a complete one you cannot.
   \`\`\`
   const done = [];
   for (const id of ids) {
     if (env.shouldStop()) { env.log(\`stopped early after \${done.length}\`); break; }
     ...
     done.push(id);
   }
   return done;
   \`\`\``;

// ── Tool definition ─────────────────────────────────────────────────────────

export function createZoteroScriptTool(
  runtimeOptions: ZoteroScriptRuntimeOptions = {},
): AgentWriteToolDefinition<ZoteroScriptInput, unknown> {
  return {
    describeAction: (input) => [
      {
        id: `zotero_script_execute:${fingerprintText(input.script)}`,
        proofDomain: "execution",
        capability: "zotero.script",
        operation: "zotero_script_execute",
        source: "zotero_script",
        parameters: {
          commandFingerprint: fingerprintText(input.script),
        },
        requestedTargets: [],
        destinationCollectionIds: [],
      },
    ],
    spec: {
      name: "zotero_script",
      description:
        "Execute a JavaScript script inside Zotero's runtime with full API access. " +
        "All scripts require source review because the Zotero API is privileged. " +
        "Two modes: mode:'read' for gathering data without undo instrumentation; " +
        "mode:'write' for mutations (runs directly with durable recovery; env.snapshot(item), env.recordCreatedItem(item), or env.addInverse(data) is required). " +
        "The script receives the global Zotero object and an env helper (env.log, env.snapshot, env.recordCreatedItem, env.addInverse, env.libraryID, env.shouldStop, env.remainingMs). " +
        "Long loops must check env.shouldStop() and return early; an over-deadline script is allowed to settle before the tool returns. " +
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
      requiresConfirmation: true,
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
          "mode 'write' scripts must call env.snapshot(item) before mutating existing items, env.recordCreatedItem(item) after creating items, or env.addInverse(data) for supported custom changes, so the durable journal can describe recovery",
        );
      }
      // Not gated on mode: `mode` is a declaration, not a sandbox — the
      // evaluator passes the real Zotero global either way — so a read-mode
      // script could otherwise create notes and bypass note validation
      // entirely. The undo guard above stays write-only on purpose:
      // env.snapshot no-ops in read mode, so requiring it there would reject
      // every legitimate read script without preventing a single write.
      if (attemptsDirectNoteWrite(script)) {
        return fail(
          "zotero_script cannot create or edit Zotero notes directly, in either mode. Use note_write so note validation and figure-crop/text-only fallback rules run before saving.",
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

    /**
     * Write-mode scripts mutate the live library through privileged JS, so the
     * source is the only meaningful thing to approve — a model-authored
     * one-line description is not consent. Read mode only relaxes undo
     * instrumentation; it does not make the full Zotero API structurally
     * immutable, so its source must be reviewed too.
     */
    shouldRequireConfirmation() {
      return true;
    },

    planMutation(input) {
      if (input.mode === "read") {
        return {
          effect: "write",
          reversibility: "none",
          requiresConfirmation: true,
          reason:
            "Read mode relaxes undo instrumentation but still exposes mutable privileged APIs, so effects cannot be proven absent or recovered.",
        };
      }
      return {
        effect: "write",
        reversibility: "partial",
        requiresConfirmation: true,
        reason:
          "Only snapshotted, explicitly created, and declaratively inverted effects can be recovered.",
      };
    },

    createPendingAction(input) {
      return {
        toolName: "zotero_script",
        title: "Run Zotero script",
        description:
          "Execute JavaScript against your Zotero library. Review the code before approving.",
        confirmLabel: "Run",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "text" as const,
            id: "description",
            label: "What this does",
            value: input.description,
          },
          {
            type: "code_preview" as const,
            id: "script",
            label: "Script",
            value: input.script,
            language: "javascript",
          },
        ],
      };
    },

    applyConfirmation(input) {
      // The card is read-only; approving means "run exactly this".
      return ok(input);
    },

    async execute(input, context) {
      const libraryID = resolveLibraryID(context);
      const isWrite = input.mode === "write";

      return executeExternalMutation({
        context,
        toolName: "zotero_script",
        plan: {
          operation: "zotero_script",
          description: input.description,
          forward: {
            script: input.script,
            mode: input.mode,
            libraryID,
            timeoutMs: input.timeoutMs,
          },
          reversibility: isWrite ? "partial" : "none",
          deferredInverse: isWrite,
          reason: isWrite
            ? "Only snapshotted, explicitly created, and declaratively inverted effects are covered."
            : "Read mode exposes mutable privileged APIs without undo instrumentation, so any effects are irreversible.",
        },
        execute: async () => {
          const result = await executeScript({
            script: input.script,
            mode: input.mode,
            timeoutMs: input.timeoutMs,
            libraryID,
            runtimeOptions,
          });
          await zoteroChangeDispatcher.flush();
          const actionId = currentMutationActionId();
          const observedIds = actionId
            ? await listJournalObservationObjectIds(actionId)
            : [];
          if (!isWrite) {
            return {
              result: scriptResultContent(input, result, observedIds),
              reversibility: "none" as const,
              reason:
                "Read mode exposes mutable privileged APIs without undo instrumentation, so the journal conservatively records the invocation as irreversible.",
              affectedCount: observedIds.length || 1,
              // The API is not structurally read-only, and raw DB effects do
              // not emit notifier events. Treating the invocation as no-effect
              // would recreate the exact unjournalled-write escape hatch this
              // coordinator is meant to close.
              effect: "applied",
            };
          }
          const instrumentedIds = new Set([
            ...result.snapshots.keys(),
            ...result.createdItemIds,
          ]);
          const capturedPostcondition = await captureScriptPostcondition(
            instrumentedIds,
            result.declarativeInverses,
            context,
          );
          const coveredIds = new Set(capturedPostcondition.guardedItemIds);
          const uncoveredObservedIds = observedIds.filter(
            (itemId) => !coveredIds.has(itemId),
          );
          const snapshots = [...result.snapshots.values()];
          const createdItemIds = [...result.createdItemIds];
          const declaredInverses = capturedPostcondition.declaredInverses;
          const inverse =
            snapshots.length || createdItemIds.length || declaredInverses.length
              ? {
                  version: 1,
                  kind: "script_snapshots",
                  payload: await storeRecoveryText(
                    JSON.stringify({
                      snapshots,
                      createdItemIds,
                      declaredInverses,
                    }),
                  ),
                }
              : undefined;
          const reversibility = inverse ? "partial" : "none";
          const recoveryLimits = [
            ...(uncoveredObservedIds.length
              ? [
                  `Notifier observations included uncovered item IDs: ${uncoveredObservedIds.join(", ")}.`,
                ]
              : []),
            ...capturedPostcondition.warnings,
            ...(result.error
              ? [
                  `The script reported an error after execution began: ${result.error}`,
                ]
              : []),
          ];
          const reason = recoveryLimits.length
            ? recoveryLimits.join(" ")
            : "Arbitrary script effects outside declared snapshots and inverses cannot be proven recoverable.";
          return {
            result: scriptResultContent(
              input,
              result,
              uncoveredObservedIds,
              capturedPostcondition.warnings,
            ),
            inverse,
            expectedPostcondition: inverse
              ? capturedPostcondition.postcondition
              : undefined,
            reversibility,
            reason,
            affectedCount: coveredIds.size,
            // A write-mode script is conservatively treated as an effect even
            // when it forgot to declare coverage. That truthfully records an
            // irreversible action instead of silently calling it a no-op.
            effect: "applied",
          };
        },
      });
    },
  };
}
