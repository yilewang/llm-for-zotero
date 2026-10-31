import { assert } from "chai";
import { OPERATION_CATALOG } from "../src/agent/contracts/operationCatalog";
import type {
  AgentActionOperation,
  AgentActionProofDomain,
  AgentActionReceipt,
  AgentToolContext,
  AgentToolDefinition,
} from "../src/agent/types";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { createLibraryBatchTool } from "../src/agent/tools/write/libraryBatch";
import {
  initAgentChangeJournal,
  prepareJournalAction,
  prepareJournalStep,
} from "../src/agent/store/changeJournal";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

/**
 * The executable audit of the effect path.
 *
 * Phase 3 asks six properties of every effect the Agent performs: a typed
 * proposal, a frozen operation and target digest, central authorization,
 * journalled execution, native post-state verification, and a scoped receipt
 * whose `verification` reflects that post-state. All six now run through one
 * shared pipeline for every row below, except where a proof domain makes the
 * fifth impossible and the sixth says so; this file is what stops a new tool
 * from quietly joining the registry outside it.
 *
 * The table below is the audit, written as data: a tool that is registered as
 * an external effect but absent here fails, and a row here that no longer
 * matches the registry fails. Adding a tool therefore means deciding its
 * operations, its proof domain and its receipt verification on purpose.
 *
 * Three kinds of assertion live here, and they are not worth the same.
 *
 * **Declared by production.** These build the real registry and ask the real
 * tools what they declare, so they fail when production drifts:
 * - "audits exactly the external effects the registry holds"
 * - "exempts control tools by class, not by name"
 * - "gives every external effect a typed action adapter"
 * - "declares exactly the audited operations, each with a proof domain"
 * - "describes only audited operations from a representative input"
 * - "pins what each tool proposes on the inputs it plans as read-only"
 * - "never plans a mutating call as a trusted read"
 *
 * **Observed from production.** These run one real call per proof domain
 * through the whole path — `prepareExecution`, the central policy, the tool's
 * execute, the journal and `finalize` — and read the receipt it mints, so the
 * table's verification column is an observation of the shipped behaviour and
 * not a claim about it:
 * - "observes a zotero_state write verified from live Zotero state"
 * - "observes a file_state write verified from a readback of the file"
 * - "observes an execution effect that runs with no state to read back"
 *
 * Each of those three records the proof domain of the receipt it read, and an
 * `after` hook requires that recorded set to be exactly the declared witness
 * set — so a witness entry added without its call fails the run.
 *
 * **Table-internal.** These read the table against `OPERATION_CATALOG` or
 * against the witness record and touch no tool and no receipt. They record a
 * decision so that changing it is a visible edit; they are not evidence that
 * production behaves that way:
 * - "pins the audit table's proof domain per tool against the catalog"
 * - "pins the audit table's expected verification per proof domain"
 * - "declares a witness for every proof domain the audit table uses" (which
 *   forces a new proof domain to declare one; the `after` hook is what forces
 *   the declared witness to have been observed)
 *
 * One tool per domain is observed here. Every other row's verification is
 * evidenced by its own per-tool test, which mints receipts from real tool
 * results: `test/runCommandTool.test.ts`, `test/fileIOTool.test.ts`,
 * `test/undoLastAction.test.ts` (a real journal, a real inverse replay and its
 * per-step native re-read), `test/revertChanges.test.ts` (undo's multi-revert
 * form) and
 * `test/zoteroScriptConfirmation.test.ts`, the whole-receipt characterizations
 * in `test/agentActionContract.test.ts`, and — for the effects a connected
 * client runs in its own runtime — `test/externalRuntimeEffectReceipts.test.ts`.
 */

type Verification = AgentActionReceipt["verification"];

type AuditRow = {
  /** Every operation the tool's own adapter can describe. */
  operations: AgentActionOperation[];
  /**
   * The receipt verification a successful application of this tool produces
   * today. `verified` means a native re-read matched; `execution_only` means
   * the effect ran and no state can be re-read.
   */
  verification: Verification;
  /**
   * Why this row's verification is what it is, whenever that needs saying:
   * what the re-read actually compares, or the ruling behind a row that can
   * never be `verified` because its proof domain leaves nothing to re-read.
   */
  verificationNote?: string;
  /** A representative input that actually performs the effect. */
  fixture: Record<string, unknown>;
  /**
   * The invocation-plan impact the fixture above produces. It must never be
   * `read_only`: the central policy treats a read-only plan with a known
   * assurance as a trusted read and executes it with no user authorization at
   * all, so a mutating call that planned read_only would be a tool granting
   * itself permission.
   */
  impact: "state_change" | "ambiguous" | "prohibited";
  /**
   * The read-mode input, for the tools that have one. A read-only plan is
   * executed by the central policy as a trusted read, with no user
   * authorization and without the assessor's typed-effect check. `proposes`
   * records what the tool still describes on that input, so a tool that starts
   * proposing an effect behind a read-only plan has to change this row.
   */
  readMode?: {
    fixture: Record<string, unknown>;
    reason: string;
    proposes: AgentActionOperation[];
  };
};

/**
 * The multi-revert form of `undo`. The table holds one mutating fixture per
 * tool, so this second mutating input is audited by its own test.
 */
const UNDO_MULTI_REVERT_FIXTURE = { count: 1 };

/** One reversible pending action the undo and revert fixtures target. */
const SEEDED_JOURNAL_ACTION = "audit-journal-action";
const AUDIT_CONVERSATION_KEY = 1;

const NOTE_BATCH_FIXTURE = {
  notes: [{ targetItemId: 1, content: "Audit body" }],
};

const AUDIT: Readonly<Record<string, AuditRow>> = {
  // ── Model-visible tools ───────────────────────────────────────────────────
  library_update: {
    operations: [
      "apply_tags",
      "remove_tags",
      "move_to_collection",
      "remove_from_collection",
      "update_metadata",
      "reparent_items",
      "relate_items",
      "update_library_tag",
      "set_item_tags",
      "create_collection",
      "delete_collection",
      "update_collection",
      "delete_attachment",
      "rename_attachment",
      "relink_attachment",
      "save_saved_search",
      "delete_saved_search",
    ],
    verification: "verified",
    fixture: { kind: "tags", action: "add", itemIds: [1], tags: ["audit"] },
    // A validated operation carrying no changes plans read_only, but it also
    // describes no proposal, so nothing is authorized either way.
    impact: "state_change",
  },
  note_write: {
    operations: ["note_create", "note_edit", "note_append"],
    verification: "verified",
    fixture: { mode: "create", targetItemId: 1, content: "Audit body" },
    impact: "state_change",
  },
  note_write_batch: {
    operations: ["save_notes_batch"],
    verification: "verified",
    fixture: NOTE_BATCH_FIXTURE,
    impact: "state_change",
  },
  library_settings: {
    operations: ["settings_update"],
    verification: "verified",
    fixture: { action: "set", key: "recursiveCollections", value: true },
    // Setting a preference to the value it already holds plans read_only.
    impact: "state_change",
  },
  library_import: {
    operations: ["import_identifiers", "import_local_files", "create_items"],
    verification: "verified",
    fixture: { kind: "identifiers", identifiers: ["10.1000/audit"] },
    impact: "state_change",
  },
  library_delete: {
    operations: ["trash_items", "merge_items", "restore_from_trash"],
    verification: "verified",
    fixture: { mode: "trash", itemIds: [1] },
    impact: "state_change",
  },
  undo: {
    operations: ["undo", "revert"],
    verification: "verified",
    verificationNote:
      "Every replayed step re-reads its own target; the receipt is verified only when all of them read back as restored (test/undoLastAction.test.ts), and for the multi-revert form only when nothing was skipped or left partial (test/revertChanges.test.ts).",
    fixture: { actionId: SEEDED_JOURNAL_ACTION },
    // With an empty journal there is nothing to undo: the plan is read_only
    // and the execution is a no-op. The multi-revert form's mutating input is
    // pinned in UNDO_MULTI_REVERT_FIXTURE below.
    impact: "state_change",
    readMode: {
      fixture: { dryRun: true, count: 1 },
      reason: "A dry run reads journal state without applying inverses.",
      proposes: [],
    },
  },
  annotate_pdf: {
    operations: ["annotation_write"],
    verification: "verified",
    fixture: {
      attachmentId: 1,
      pageIndex: 0,
      text: "Audit",
    },
    impact: "state_change",
  },
  file_io: {
    operations: ["file_write"],
    verification: "verified",
    fixture: { action: "write", path: "/tmp/audit.txt", content: "audit" },
    impact: "state_change",
    readMode: {
      fixture: { action: "read", path: "/tmp/audit.txt" },
      reason: "Reading a file proposes no write.",
      proposes: [],
    },
  },
  run_command: {
    operations: ["command_execute"],
    verification: "execution_only",
    verificationNote:
      "Ruling: a shell command has no re-readable state, so it stays execution_only everywhere. The final gate lets it pass and the trace chip says 'Ran (no state proof)'.",
    fixture: { command: "rm -rf /tmp/audit-target" },
    impact: "state_change",
    readMode: {
      fixture: { command: "ls /tmp" },
      // Known gap, not a design: `authorizeOriginalAction` returns
      // `{kind: "execute", authority: "safe_read"}` for any read_only plan
      // with a known assurance (src/agent/authorization/policy.ts:115-119),
      // so a shell command this tool's own static classifier calls a read
      // executes as a trusted read with no user authorization at all — the
      // one place where property (3) is decided by a per-tool string matcher
      // rather than by the central policy reading a proposal. The command is
      // still described and still receipted, which is what this row pins;
      // whether such a command may run unauthorized is a Phase 3 residual
      // that needs a product decision.
      reason:
        "A command this tool's static classifier recognizes as read-only; it still runs, and still mints an execution_only receipt.",
      proposes: ["command_execute"],
    },
  },
  zotero_script: {
    operations: ["zotero_script_execute"],
    verification: "verified",
    verificationNote:
      "A run that journals an expected post-image re-reads it before the receipt is minted; one that declares no expected effect — a privileged read — stays execution_only. `verified` here claims state, not intent: a library-mode script whose post-image re-reads intact is verified even when the script changed nothing, so the fact names how many targets were compared (test/zoteroScriptConfirmation.test.ts).",
    fixture: {
      access: "library",
      effect: "write",
      script:
        "for (const item of items) { env.snapshot(item); item.setField('extra', 'audited'); }",
      description: "Stamp an audit marker on the selected items.",
    },
    impact: "state_change",
    readMode: {
      fixture: {
        access: "library",
        effect: "read",
        script: "return items.length;",
        description: "Count the selected items.",
      },
      reason: "A library-scope script declared as a read.",
      proposes: [],
    },
  },
};

/**
 * The write delegates are not registered tools: each is reachable only as a
 * route through the facade that owns it. One row per delegate, keyed by the
 * delegate's internal name (the facade's `delegateName`), with a mutating
 * input expressed in the facade's own kind/mode vocabulary.
 */
const DELEGATE_ROUTES: Readonly<
  Record<
    string,
    {
      facade: string;
      operations: AgentActionOperation[];
      fixture: Record<string, unknown>;
    }
  >
> = {
  apply_tags: {
    facade: "library_update",
    operations: ["apply_tags", "remove_tags"],
    fixture: { kind: "tags", action: "add", itemIds: [1], tags: ["audit"] },
  },
  set_item_tags: {
    facade: "library_update",
    operations: ["set_item_tags"],
    fixture: {
      kind: "tags",
      action: "set",
      assignments: [{ itemId: 1, tags: ["audit"] }],
    },
  },
  tag_update: {
    facade: "library_update",
    operations: ["update_library_tag"],
    fixture: { kind: "tag", action: "rename", tag: "audit", newTag: "audited" },
  },
  move_to_collection: {
    facade: "library_update",
    operations: ["move_to_collection", "remove_from_collection"],
    fixture: { kind: "collections", itemIds: [1], targetCollectionId: 2 },
  },
  update_metadata: {
    facade: "library_update",
    operations: ["update_metadata"],
    fixture: { kind: "metadata", itemId: 1, metadata: { title: "Audit" } },
  },
  reparent_items: {
    facade: "library_update",
    operations: ["reparent_items"],
    fixture: { kind: "parent", assignments: [{ itemId: 1, parentItemId: 2 }] },
  },
  relate_items: {
    facade: "library_update",
    operations: ["relate_items"],
    fixture: { kind: "related", itemId: 1, relatedItemIds: [2] },
  },
  collection_update: {
    facade: "library_update",
    operations: ["create_collection", "delete_collection", "update_collection"],
    fixture: { kind: "collection", action: "create", name: "Audit" },
  },
  attachment_update: {
    facade: "library_update",
    operations: ["delete_attachment", "rename_attachment", "relink_attachment"],
    fixture: {
      kind: "attachment",
      action: "rename",
      attachmentId: 1,
      newName: "Audit.pdf",
    },
  },
  saved_search_update: {
    facade: "library_update",
    operations: ["save_saved_search", "delete_saved_search"],
    fixture: {
      kind: "savedSearch",
      action: "save",
      name: "Audit",
      conditions: [{ condition: "title", operator: "contains", value: "x" }],
    },
  },
  import_identifiers: {
    facade: "library_import",
    operations: ["import_identifiers"],
    fixture: { kind: "identifiers", identifiers: ["10.1000/audit"] },
  },
  import_local_files: {
    facade: "library_import",
    operations: ["import_local_files"],
    fixture: { kind: "files", filePaths: ["/tmp/audit.pdf"] },
  },
  create_items: {
    facade: "library_import",
    operations: ["create_items"],
    fixture: {
      kind: "manual",
      items: [{ itemType: "journalArticle", title: "Audit" }],
    },
  },
  trash_items: {
    facade: "library_delete",
    operations: ["trash_items"],
    fixture: { mode: "trash", itemIds: [1] },
  },
  restore_from_trash: {
    facade: "library_delete",
    operations: ["restore_from_trash"],
    fixture: { mode: "restore", itemIds: [1] },
  },
  merge_items: {
    facade: "library_delete",
    operations: ["merge_items"],
    fixture: { mode: "merge", masterItemId: 1, otherItemIds: [2] },
  },
};

/**
 * Class-level exemptions. A control tool owns no effect of its own: every call
 * it makes re-enters the registry as its own authorized invocation, so its
 * receipts are the children's. Listed by class, never by name.
 */
const CONTROL_TOOLS_WITHOUT_EFFECTS = ["library_batch", "workflow_script"];

/**
 * The inert host seams the audit's plan and adapter calls reach. Nothing here
 * returns live state: the audit asks what a tool *declares* about an effect,
 * never what the effect would do.
 */
function auditGateway(live: Record<string, unknown> = {}) {
  return {
    getItem: () => null,
    getCollectionSummary: () => null,
    listCollectionSummaries: () => [],
    listSettings: () => [],
    getSettingNativeState: () => null,
    resolveMetadataItem: () => null,
    resolveMetadataWriteTarget: () => ({ refusal: "No item" }),
    getEditableArticleMetadata: () => null,
    resolveRegularItem: () => null,
    resolveLibraryID: () => 1,
    listCollectionItemTargets: async () => ({ items: [] }),
    listCollectionPaperTargets: async () => ({ papers: [] }),
    getCollectionNativeState: () => null,
    listLibraryTags: () => ({ tags: [], totalCount: 0 }),
    getSavedSearch: () => null,
    listSavedSearches: () => [],
    ...live,
  } as never;
}

function auditRegistry(gateway = auditGateway()) {
  const registry = createBuiltInToolRegistry({
    zoteroGateway: gateway,
    pdfService: {} as never,
    pdfPageService: {} as never,
    retrievalService: {} as never,
  });
  // library_batch is registered by the composition root rather than the
  // factory, because it needs both registries. The audit must still see it.
  registry.register(
    createLibraryBatchTool({
      actionRegistry: {} as never,
      toolRegistry: registry,
      zoteroGateway: gateway,
    }),
  );
  return registry;
}

/**
 * The Gecko filesystem `file_io` writes through, in memory.
 *
 * The tool reads the file back after writing it and the receipt is verified
 * from that readback, so the fake has to store what it was given and return
 * exactly that — a store that echoed the request would verify a write that
 * never landed.
 */
function installFakeFiles() {
  const stored = new Map<string, Uint8Array>();
  const scope = globalThis as { IOUtils?: unknown };
  const original = scope.IOUtils;
  scope.IOUtils = {
    exists: async (path: string) => stored.has(path),
    read: async (path: string) => {
      const bytes = stored.get(path);
      if (!bytes) throw new Error(`No such file: ${path}`);
      return bytes;
    },
    write: async (path: string, bytes: Uint8Array) => {
      stored.set(path, Uint8Array.from(bytes));
      return bytes.byteLength;
    },
    makeDirectory: async () => undefined,
    remove: async (path: string) => {
      stored.delete(path);
    },
  };
  return {
    stored,
    restore: () => {
      scope.IOUtils = original;
    },
  };
}

/**
 * The Gecko shell seam `run_command` runs through.
 *
 * The platform is pinned to the pipe-reading branch so the observation does
 * not depend on which machine runs the suite: on Windows the tool redirects
 * output to a temp file instead, which is a different code path and not the
 * one this audit witnesses.
 */
function installFakeShell() {
  const commands: string[] = [];
  const scope = globalThis as { ChromeUtils?: unknown; Zotero?: any };
  const originalChromeUtils = scope.ChromeUtils;
  const originalIsMac = scope.Zotero?.isMac;
  if (scope.Zotero) scope.Zotero.isMac = true;
  const closedPipe = { readString: async () => "" };
  scope.ChromeUtils = {
    importESModule: () => ({
      Subprocess: {
        call: async (params: { arguments: string[] }) => {
          commands.push(params.arguments[params.arguments.length - 1]);
          return {
            stdout: closedPipe,
            stderr: closedPipe,
            wait: async () => ({ exitCode: 0 }),
          };
        },
      },
    }),
  };
  return {
    commands,
    restore: () => {
      scope.ChromeUtils = originalChromeUtils;
      if (scope.Zotero) scope.Zotero.isMac = originalIsMac;
    },
  };
}

function auditContext(): AgentToolContext {
  return {
    request: {
      conversationKey: 1,
      mode: "agent",
      userText: "audit",
    },
    item: null,
    currentAnswerText: "",
    modelName: "audit-model",
    runId: "audit-run",
  } as never;
}

function validatedFixture(
  tool: AgentToolDefinition<any, any>,
  row: AuditRow,
): unknown {
  const validated = tool.validate(row.fixture);
  assert.isTrue(
    validated.ok,
    `${tool.spec.name} fixture is not a valid input: ${
      validated.ok ? "" : validated.error
    }`,
  );
  if (!validated.ok) throw new Error(validated.error);
  return validated.value;
}

describe("effect path audit", function () {
  const originalZotero = globalThis.Zotero;
  const registry = auditRegistry();

  before(async function () {
    // Both forms of undo plan from the durable journal, so
    // the audit seeds one reversible action: without it they correctly report
    // a read-only no-op and the mutating path would never be exercised.
    globalThis.Zotero = {
      DB: new ChangeJournalTestDb(),
      Prefs: { get: () => "auto" },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    await prepareJournalAction({
      actionId: SEEDED_JOURNAL_ACTION,
      runId: "audit-run",
      conversationKey: AUDIT_CONVERSATION_KEY,
      toolName: "library_settings",
      description: "Audit fixture mutation",
      effect: "write",
      reversibility: "full",
    });
    await prepareJournalStep({
      actionId: SEEDED_JOURNAL_ACTION,
      sequence: 1,
      operation: "update_preference",
      forward: { key: "audit.setting", value: "after" },
      inverse: {
        version: 1,
        kind: "preference",
        key: "audit.setting",
        existed: true,
        value: "before",
      },
    });
  });

  after(function () {
    globalThis.Zotero = originalZotero;
    // Every declared witness has to be a call that ran, not a table entry:
    // each observing test below records the proof domain of the receipt
    // production minted for it.
    assert.deepEqual(
      [...observedDomains].sort(),
      Object.keys(PROOF_DOMAIN_WITNESS).sort(),
      "a declared proof-domain witness with no observing call proves nothing",
    );
  });

  const effects = registry
    .listToolDefinitions()
    .filter((tool) => tool.spec.executionClass === "external_effect");

  it("audits exactly the external effects the registry holds", function () {
    assert.deepEqual(
      effects.map((tool) => tool.spec.name).sort(),
      Object.keys(AUDIT).sort(),
      "every external-effect tool needs an audited row, and every row a tool",
    );
  });

  it("exempts control tools by class, not by name", function () {
    const controls = registry
      .listToolDefinitions()
      .filter((tool) => tool.spec.executionClass === "control")
      .map((tool) => tool.spec.name);
    for (const name of CONTROL_TOOLS_WITHOUT_EFFECTS) {
      assert.include(controls, name, `${name} must stay control class`);
      const tool = registry.getTool(name)!;
      assert.isUndefined(
        tool.effectOperations,
        `${name} performs no effect of its own`,
      );
    }
  });

  it("gives every external effect a typed action adapter", function () {
    const missing = effects
      .filter((tool) => !tool.describeAction)
      .map((tool) => tool.spec.name);
    assert.deepEqual(missing, []);
  });

  it("declares exactly the audited operations, each with a proof domain", function () {
    const declared: Record<string, AgentActionOperation[]> = {};
    const expected: Record<string, AgentActionOperation[]> = {};
    for (const tool of effects) {
      declared[tool.spec.name] = [...(tool.effectOperations || [])].sort();
      expected[tool.spec.name] = [...AUDIT[tool.spec.name].operations].sort();
      for (const operation of tool.effectOperations || []) {
        assert.property(
          OPERATION_CATALOG,
          operation,
          `${tool.spec.name} declares an uncatalogued operation`,
        );
      }
    }
    assert.deepEqual(declared, expected);
  });

  // Table-internal from here: this reads AUDIT against OPERATION_CATALOG and
  // never touches a tool or a receipt. It pins the decision, not the runtime.
  it("pins the audit table's proof domain per tool against the catalog", function () {
    const domains: Record<string, AgentActionProofDomain[]> = {};
    for (const [name, row] of Object.entries(AUDIT)) {
      domains[name] = [
        ...new Set(
          row.operations.map(
            (operation) => OPERATION_CATALOG[operation].proofDomain,
          ),
        ),
      ].sort();
    }
    assert.deepEqual(domains, {
      ...Object.fromEntries(
        Object.keys(AUDIT).map((name) => [name, ["zotero_state"]]),
      ),
      file_io: ["file_state"],
      run_command: ["execution"],
      zotero_script: ["execution"],
    });
  });

  // Table-internal: the expected verification per proof domain is a decision
  // recorded here. One tool per domain is then observed producing exactly
  // this value at the end of this file; the remaining rows are evidenced by
  // their own per-tool receipt tests.
  it("pins the audit table's expected verification per proof domain", function () {
    const byDomain: Record<string, Set<Verification>> = {};
    for (const row of Object.values(AUDIT)) {
      for (const operation of row.operations) {
        const domain = OPERATION_CATALOG[operation].proofDomain;
        (byDomain[domain] ||= new Set()).add(row.verification);
      }
    }
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(byDomain).map(([domain, values]) => [
          domain,
          [...values].sort(),
        ]),
      ),
      {
        zotero_state: ["verified"],
        file_state: ["verified"],
        // Two values, on purpose. `execution` is the domain of effects with
        // no state to re-read, but zotero_script is not one of them: a run
        // that journals an expected post-image reads it back, and only a run
        // that declares no expected effect keeps `execution_only`.
        execution: ["execution_only", "verified"],
      },
      "a domain that starts producing a second verification value is a decision, not an accident",
    );
  });

  it("describes only audited operations from a representative input", async function () {
    for (const tool of effects) {
      const row = AUDIT[tool.spec.name];
      const described =
        (await tool.describeAction!(
          validatedFixture(tool, row) as never,
          auditContext(),
        )) || [];
      assert.isNotEmpty(
        described,
        `${tool.spec.name} described no proposal for a mutating input`,
      );
      for (const proposal of described) {
        assert.include(
          row.operations,
          proposal.operation,
          `${tool.spec.name} described an operation it never declared`,
        );
        const entry = OPERATION_CATALOG[proposal.operation];
        assert.equal(
          proposal.capability,
          entry.capability,
          `${tool.spec.name} disagrees with the catalog's capability`,
        );
        assert.equal(
          proposal.proofDomain,
          entry.proofDomain,
          `${tool.spec.name} disagrees with the catalog's proof domain`,
        );
      }
    }
  });

  it("pins what each tool proposes on the inputs it plans as read-only", async function () {
    const covered: string[] = [];
    for (const tool of effects) {
      const row = AUDIT[tool.spec.name];
      if (!row.readMode) continue;
      covered.push(tool.spec.name);
      const validated = tool.validate(row.readMode.fixture);
      assert.isTrue(
        validated.ok,
        `${tool.spec.name} read-mode fixture is invalid: ${
          validated.ok ? "" : validated.error
        }`,
      );
      if (!validated.ok) continue;
      const plan = await tool.planInvocation!(
        validated.value as never,
        auditContext(),
      );
      assert.equal(
        plan.impact,
        "read_only",
        `${tool.spec.name}: ${row.readMode.reason}`,
      );
      const described =
        (await tool.describeAction!(
          validated.value as never,
          auditContext(),
        )) || [];
      assert.deepEqual(
        described.map((proposal) => proposal.operation),
        row.readMode.proposes,
        `${tool.spec.name} changed what it proposes behind a read-only plan`,
      );
    }
    assert.deepEqual(covered.sort(), [
      "file_io",
      "run_command",
      "undo",
      "zotero_script",
    ]);
  });

  it("never plans a mutating call as a trusted read", async function () {
    const impacts: Record<string, string> = {};
    for (const tool of effects) {
      const row = AUDIT[tool.spec.name];
      const plan = await tool.planInvocation!(
        validatedFixture(tool, row) as never,
        auditContext(),
      );
      assert.notEqual(
        plan.impact,
        "read_only",
        `${tool.spec.name} planned a mutating input as read_only, which the central policy executes as a trusted read`,
      );
      impacts[tool.spec.name] = plan.impact;
    }
    assert.deepEqual(
      impacts,
      Object.fromEntries(
        Object.entries(AUDIT).map(([name, row]) => [name, row.impact]),
      ),
    );
  });

  it("routes every write delegate through its facade, and only there", function () {
    const operationsByFacade: Record<string, Set<string>> = {};
    for (const [delegateName, route] of Object.entries(DELEGATE_ROUTES)) {
      assert.notExists(
        registry.getTool(delegateName),
        `${delegateName} is a delegate, not a registered tool`,
      );
      const facade = registry.getTool(route.facade)!;
      const validated = facade.validate(route.fixture);
      assert.isTrue(
        validated.ok,
        `${delegateName} route fixture is invalid: ${
          validated.ok ? "" : validated.error
        }`,
      );
      if (!validated.ok) continue;
      assert.equal(validated.value.delegateName, delegateName);
      assert.sameMembers(
        [...(validated.value.delegateTool.effectOperations || [])],
        route.operations,
        `${delegateName} declares other operations than its route`,
      );
      for (const operation of route.operations) {
        (operationsByFacade[route.facade] ||= new Set()).add(operation);
      }
    }
    // The routes together reach exactly what each delegating facade declares.
    for (const facade of [
      "library_update",
      "library_import",
      "library_delete",
    ]) {
      assert.sameMembers(
        [...(operationsByFacade[facade] || [])],
        AUDIT[facade].operations,
        `${facade} declares an operation no audited route reaches`,
      );
    }
  });

  it("never plans a mutating delegate route as a trusted read", async function () {
    for (const [delegateName, route] of Object.entries(DELEGATE_ROUTES)) {
      const facade = registry.getTool(route.facade)!;
      const validated = facade.validate(route.fixture);
      if (!validated.ok) throw new Error(validated.error);
      const plan = await facade.planInvocation!(
        validated.value as never,
        auditContext(),
      );
      assert.equal(
        plan.impact,
        "state_change",
        `${route.facade} → ${delegateName} planned ${plan.impact}`,
      );
      const described =
        (await facade.describeAction!(
          validated.value as never,
          auditContext(),
        )) || [];
      assert.isNotEmpty(described, `${delegateName} described no proposal`);
      for (const proposal of described) {
        assert.include(
          route.operations,
          proposal.operation,
          `${delegateName} described an operation it never declared`,
        );
      }
    }
  });

  it("never plans undo's multi-revert form as a trusted read", async function () {
    const undo = registry.getTool("undo")!;
    const validated = undo.validate(UNDO_MULTI_REVERT_FIXTURE);
    if (!validated.ok) throw new Error(validated.error);
    const plan = await undo.planInvocation!(
      validated.value as never,
      auditContext(),
    );
    assert.equal(plan.impact, "state_change");
    const described =
      (await undo.describeAction!(validated.value as never, auditContext())) ||
      [];
    assert.deepEqual(
      described.map((proposal) => proposal.operation),
      ["revert"],
    );
  });

  /**
   * ── Observed receipts, one representative call per proof domain ──────────
   *
   * Everything above asks a tool what it *declares*. The tests below run one
   * real call per proof domain all the way through production —
   * `prepareExecution`, the invocation assessor, the central policy, the
   * durable authorization grant, the tool's own execute, the change journal
   * and `ActionContractService.finalize` — and read the receipt that comes
   * out. Only the seams a Gecko host owns are faked: the preference store,
   * the filesystem and the shell.
   *
   * One witness per domain, each the domain's most representative tool:
   *   `zotero_state` → `library_settings`, the write Task 4 moved onto the
   *     shared external-evidence path, so what it proves is what every Zotero
   *     write without a bespoke verifier proves.
   *   `file_state`  → `file_io`, the only tool in the domain.
   *   `execution`   → `run_command`, the domain's ruling case: an effect with
   *     no re-readable state, whose receipt is `execution_only` by design.
   *
   * The other rows' verification stays a table decision checked by their own
   * per-tool tests; these three are what make the table's per-domain values
   * an observation of production rather than a claim about it.
   *
   * Two things keep that true as the table grows. A table-internal assertion
   * requires a witness entry for every proof domain the table uses, and an
   * `after` hook requires that every witness was actually *observed* — each
   * observing test records the domain of the receipt production minted, so
   * adding a witness entry without writing its call fails the run.
   */
  const PROOF_DOMAIN_WITNESS: Record<
    AgentActionProofDomain,
    { tool: string; verification: Verification }
  > = {
    zotero_state: { tool: "library_settings", verification: "verified" },
    file_state: { tool: "file_io", verification: "verified" },
    execution: { tool: "run_command", verification: "execution_only" },
  };

  /** Proof domains an observing test below actually drove and read back. */
  const observedDomains = new Set<AgentActionProofDomain>();

  // Table-internal: this reads AUDIT against the witness record and runs no
  // call of its own. It is what forces a new proof domain to declare a
  // witness; the `after` hook above is what forces that witness to exist.
  it("declares a witness for every proof domain the audit table uses", function () {
    const domains = new Set(
      Object.values(AUDIT).flatMap((row) =>
        row.operations.map(
          (operation) => OPERATION_CATALOG[operation].proofDomain,
        ),
      ),
    );
    assert.deepEqual(
      [...domains].sort(),
      Object.keys(PROOF_DOMAIN_WITNESS).sort(),
      "a proof domain no observed call covers is a table nobody checks",
    );
    for (const [domain, witness] of Object.entries(PROOF_DOMAIN_WITNESS)) {
      assert.equal(
        AUDIT[witness.tool].verification,
        witness.verification,
        `${witness.tool} witnesses ${domain}: its row must claim what the observed call asserts`,
      );
    }
  });

  /**
   * The production path for one audited fixture, start to finish.
   *
   * The call is the row's own representative input, so the observation and
   * the table cannot drift apart, and it runs as an ordinary agent turn. A
   * confirmation is approved rather than bypassed: the receipt has to be the
   * one a user's approval produces.
   */
  async function driveAuditedCall(toolName: string, gateway: unknown) {
    const registry = auditRegistry(gateway as never);
    const row = AUDIT[toolName];
    const context = auditContext();
    const request = {
      ...context.request,
      libraryID: 1,
      executionContext: {
        version: 1,
        executionId: `audit:${toolName}`,
        conversationKey: context.request.conversationKey,
        conversationGeneration: 0,
        chatLibraryID: 1,
        permissionOwner: "original_agent",
        workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
        configuredAccess: { libraryIDs: [1], outputDirectories: [] },
      },
    };
    let prepared = await registry.prepareExecution(
      { id: `audit:${toolName}`, name: toolName, arguments: row.fixture },
      { ...context, request } as never,
    );
    if (prepared.kind === "confirmation")
      prepared = await prepared.execute({ approved: true });
    assert.equal(
      prepared.kind,
      "result",
      `${toolName} never reached execution`,
    );
    if (prepared.kind !== "result") throw new Error("unreachable");
    const result = prepared.execution.result;
    assert.isTrue(
      result.ok,
      `${toolName} failed: ${JSON.stringify(result.content)}`,
    );
    const receipts = result.actionReceipts || [];
    assert.lengthOf(receipts, 1, `${toolName} minted no single receipt`);
    return receipts[0];
  }

  it("observes a zotero_state write verified from live Zotero state", async function () {
    const witness = PROOF_DOMAIN_WITNESS.zotero_state;
    // The preference store this write changes and the receipt re-reads.
    const preference = { value: false as unknown };
    const receipt = await driveAuditedCall(
      witness.tool,
      auditGateway({
        listSettings: () => [
          {
            key: "recursiveCollections",
            value: preference.value,
            description: "Show items from subcollections",
          },
        ],
        updateSetting: async ({
          key,
          value,
        }: {
          key: string;
          value: unknown;
        }) => {
          preference.value = Boolean(value);
          return { status: "updated", key, value: preference.value };
        },
        getSettingNativeState: (key: string) => ({
          key,
          value: preference.value,
        }),
      }),
    );
    assert.equal(receipt.proofDomain, "zotero_state");
    observedDomains.add(receipt.proofDomain);
    assert.equal(receipt.operation, "settings_update");
    assert.equal(receipt.verification, witness.verification);
    assert.equal(receipt.status, "applied");
    assert.deepEqual(receipt.appliedTargets, ["setting:recursiveCollections"]);
    assert.isTrue(preference.value, "the audited call really wrote");
  });

  it("observes a file_state write verified from a readback of the file", async function () {
    const witness = PROOF_DOMAIN_WITNESS.file_state;
    const files = installFakeFiles();
    try {
      const receipt = await driveAuditedCall(witness.tool, auditGateway());
      assert.equal(receipt.proofDomain, "file_state");
      observedDomains.add(receipt.proofDomain);
      assert.equal(receipt.operation, "file_write");
      assert.equal(receipt.verification, witness.verification);
      assert.equal(receipt.status, "applied");
      assert.deepEqual(receipt.appliedTargets, ["file:/tmp/audit.txt"]);
      assert.equal(
        new TextDecoder().decode(files.stored.get("/tmp/audit.txt")),
        "audit",
        "the audited call really wrote",
      );
    } finally {
      files.restore();
    }
  });

  it("observes an execution effect that runs with no state to read back", async function () {
    const witness = PROOF_DOMAIN_WITNESS.execution;
    const shell = installFakeShell();
    try {
      const receipt = await driveAuditedCall(witness.tool, auditGateway());
      assert.equal(receipt.proofDomain, "execution");
      observedDomains.add(receipt.proofDomain);
      assert.equal(receipt.operation, "command_execute");
      assert.equal(receipt.verification, witness.verification);
      // `observed`, not `applied`: the host saw the command run and can say
      // nothing about what it changed.
      assert.equal(receipt.status, "observed");
      assert.deepEqual(receipt.appliedTargets, []);
      assert.deepEqual(shell.commands, ["rm -rf /tmp/audit-target"]);
    } finally {
      shell.restore();
    }
  });
});
