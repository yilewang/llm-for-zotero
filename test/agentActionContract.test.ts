import { assert } from "chai";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import type {
  AgentActionEvidence,
  AgentToolDefinition,
  AgentToolActionDescriptor,
  AgentToolEffect,
} from "../src/agent/types";
import type {
  LibraryMutationOperation,
  LibraryMutationState,
} from "../src/agent/services/libraryMutation/contracts";
import { sha256Text } from "../src/agent/store/journalRecoveryBlobStore";

type FakeItemState = {
  tags: string[];
  collections: number[];
  fields: Record<string, string>;
  libraryID?: number;
  kind?: "regular" | "attachment" | "note" | "annotation";
  deleted?: boolean;
  noteHtml?: string;
  parentItemId?: number | null;
  annotation?: boolean;
  annotationFields?: Record<string, unknown>;
};

function createHarness() {
  const directMembers = new Map<number, number[]>([
    [10, [90]],
    [11, [1, 2, 3]],
    [12, [50, 51]],
  ]);
  const items = new Map<number, FakeItemState>();
  const collections = new Map([
    [
      10,
      {
        collectionId: 10,
        libraryID: 1,
        name: "Parent",
        path: "Parent",
        parentCollectionId: null,
        deleted: false,
      },
    ],
    [
      11,
      {
        collectionId: 11,
        libraryID: 1,
        name: "Leaf",
        path: "Parent/Leaf",
        parentCollectionId: 10,
        deleted: false,
      },
    ],
    [
      12,
      {
        collectionId: 12,
        libraryID: 1,
        name: "Sibling",
        path: "Parent/Sibling",
        parentCollectionId: 10,
        deleted: false,
      },
    ],
  ]);
  const settings = new Map<string, unknown>();
  const gateway = {
    getCollectionSummary(collectionId: number) {
      const collection = collections.get(collectionId);
      return collection
        ? {
            collectionId: collection.collectionId,
            libraryID: collection.libraryID,
            name: collection.name,
            path: collection.path,
          }
        : null;
    },
    getCollectionNativeState(collectionId: number) {
      const collection = collections.get(collectionId);
      return collection
        ? {
            exists: true,
            name: collection.name,
            parentCollectionId: collection.parentCollectionId,
            deleted: collection.deleted,
          }
        : {
            exists: false,
            name: "",
            parentCollectionId: null,
            deleted: false,
          };
    },
    listCollectionSummaries(libraryID: number) {
      return [...collections.values()]
        .filter((entry) => entry.libraryID === libraryID && !entry.deleted)
        .map(({ collectionId, name, path }) => ({
          collectionId,
          libraryID,
          name,
          path,
        }));
    },
    listCurrentCollectionSummaries(libraryID: number) {
      return this.listCollectionSummaries(libraryID);
    },
    listCurrentCollectionTargetIds(params: { collectionId: number }) {
      return [...(directMembers.get(params.collectionId) || [])];
    },
    async listCurrentLibraryTargetIds() {
      return [...items.keys()];
    },
    async listCollectionPaperTargets(params: { collectionId: number }) {
      return {
        papers: (directMembers.get(params.collectionId) || []).map(
          (itemId) => ({ itemId }),
        ),
      };
    },
    async listCollectionItemTargets(params: { collectionId: number }) {
      return {
        items: (directMembers.get(params.collectionId) || []).map((itemId) => ({
          itemId,
        })),
      };
    },
    getItem(itemId: number) {
      const state = items.get(itemId);
      if (!state) return null;
      return {
        ...state.annotationFields,
        id: itemId,
        libraryID: state.libraryID ?? 1,
        parentID: state.parentItemId ?? false,
        deleted: state.deleted,
        isRegularItem: () => !state.kind || state.kind === "regular",
        isAttachment: () => state.kind === "attachment",
        isNote: () => state.kind === "note" || state.noteHtml !== undefined,
        isAnnotation: () =>
          state.kind === "annotation" || state.annotation === true,
        getNote: () => state.noteHtml || "",
        getTags: () => state.tags.map((tag) => ({ tag })),
        getCollections: () => state.collections,
        getField: (field: string) => state.fields[field] || "",
      } as unknown as Zotero.Item;
    },
    getEditableArticleMetadata(item: Zotero.Item | null | undefined) {
      if (!item) return null;
      const state = items.get(Number(item.id));
      return state ? { fields: state.fields, creators: [] } : null;
    },
    getSettingNativeState(key: string) {
      return settings.has(key)
        ? { exists: true, value: settings.get(key) }
        : { exists: false, value: undefined };
    },
  };
  return {
    collections,
    directMembers,
    gateway,
    items,
    settings,
    service: new ActionContractService(gateway),
  };
}

/**
 * A stand-in for whichever library mutation tool a case needs. It declares no
 * effectOperations on purpose: it is never registered, and it fronts every
 * operation in this file, so a declaration here would be a fiction the
 * adapter check would rightly refuse.
 */
function mutationTool(): AgentToolDefinition<any, unknown> {
  return {
    spec: {
      name: "library_update",
      description: "test",
      inputSchema: { type: "object" },
      executionClass: "external_effect",
      requiresConfirmation: true,
    },
    validate: (input) => ({ ok: true, value: input }),
    execute: async () => ({ content: {}, effect: "applied" }),
  };
}

function mutationEvidence(
  operationValue: LibraryMutationOperation,
  preState: LibraryMutationState,
  postState: LibraryMutationState,
  journalStepId: string,
  effect: AgentActionEvidence["effect"] = "applied",
): AgentActionEvidence[] {
  return [
    {
      version: 1,
      source: "library_mutation",
      proofDomain: "zotero_state",
      operationValue,
      preState,
      postState,
      journalStepId,
      effect,
    },
  ];
}

describe("Action Contract V2", function () {
  async function noteWriteReceipt(params: {
    parameters: Record<string, unknown>;
    content: unknown;
    noteHtml: string;
  }) {
    const { service, items } = createHarness();
    items.set(41, { tags: [], collections: [], fields: { title: "Paper" } });
    items.set(700, {
      tags: [],
      collections: [],
      fields: {},
      kind: "note",
      parentItemId: 41,
      noteHtml: params.noteHtml,
    });
    const prepared = await service.prepare(
      {
        ...mutationTool(),
        describeAction: () => [
          {
            id: "note-for-paper",
            proofDomain: "zotero_state",
            capability: "zotero.notes",
            operation: "note_create",
            source: "zotero_native",
            parameters: params.parameters,
            requestedTargets: ["item:41"],
            destinationCollectionIds: [],
          },
        ],
      },
      {},
    );
    const receipts = await service.finalize(prepared, {
      ok: true,
      effect: "applied",
      content: params.content,
    });
    return receipts[0];
  }

  it("names the material and the native HTML digest on a material-backed note write", async function () {
    const html = "<p>Grounded summary.</p>";
    const receipt = await noteWriteReceipt({
      noteHtml: html,
      parameters: {
        noteMode: "create",
        targetItemId: 41,
        documentId: "doc-material-1",
        documentVersion: 2,
        contentHash: "sha256:frozen-content-hash",
      },
      content: {
        noteId: 700,
        noteVerification: {
          schemaVersion: 1,
          noteId: 700,
          matches: true,
          html,
          expectedHtml: html,
        },
      },
    });
    assert.deepEqual(receipt.materialRef, {
      documentId: "doc-material-1",
      documentVersion: 2,
      contentHash: "sha256:frozen-content-hash",
    });
    assert.equal(receipt.verification, "verified");
    assert.include(receipt.verifiedFacts, "created_note:item:700");
    assert.include(
      receipt.verifiedFacts,
      `native_note:700:html_sha256:${await sha256Text(html)}`,
    );
    assert.notInclude(receipt.verifiedFacts, "native_note:700:text_match");
  });

  it("leaves materialRef unset when the note write froze no material", async function () {
    const receipt = await noteWriteReceipt({
      noteHtml: "<p>Grounded summary.</p>",
      parameters: {
        noteMode: "create",
        targetItemId: 41,
        expectedText: "Grounded summary.",
      },
      content: { noteId: 700 },
    });
    assert.isUndefined(receipt.materialRef);
    assert.include(receipt.verifiedFacts, "created_note:item:700");
    assert.include(receipt.verifiedFacts, "native_note:700:text_match");
    assert.notInclude(receipt.verifiedFacts.join(" "), "html_sha256");
  });

  it("marks the weaker text-match evidence when no native note verification was produced", async function () {
    // The already-satisfied save of a document with embedded assets returns no
    // noteVerification, so the receipt must not claim native HTML evidence.
    const receipt = await noteWriteReceipt({
      noteHtml: "<p>Grounded summary.</p>",
      parameters: {
        noteMode: "create",
        targetItemId: 41,
        expectedText: "Grounded summary.",
        documentId: "doc-material-2",
        documentVersion: 3,
        contentHash: "sha256:asset-backed-hash",
      },
      content: { noteId: 700 },
    });
    assert.deepEqual(receipt.materialRef, {
      documentId: "doc-material-2",
      documentVersion: 3,
      contentHash: "sha256:asset-backed-hash",
    });
    assert.include(receipt.verifiedFacts, "native_note:700:text_match");
    assert.notInclude(receipt.verifiedFacts.join(" "), "html_sha256");
  });
  it("says which note of a batch could not be re-read at receipt time", async function () {
    // The whole-set postcondition is a claim about the set, so it can still
    // hold while one note the call physically wrote is gone by the time the
    // receipt re-reads it. Without a reason the only symptom is a missing
    // fact, which reads as "this note was never written". The write stays
    // applied -- the mutation window proved it -- but the receipt stops
    // vouching for the set, the way a single note write does.
    const html = "<p>Grounded summary.</p>";
    const { service, items } = createHarness();
    items.set(41, { tags: [], collections: [], fields: { title: "First" } });
    items.set(42, { tags: [], collections: [], fields: { title: "Second" } });
    items.set(700, {
      tags: [],
      collections: [],
      fields: {},
      kind: "note",
      parentItemId: 41,
      noteHtml: html,
    });
    items.set(701, {
      tags: [],
      collections: [],
      fields: {},
      kind: "note",
      parentItemId: 42,
      noteHtml: html,
      // Trashed between the write and the receipt.
      deleted: true,
    });
    const operation: LibraryMutationOperation = {
      type: "save_notes_batch",
      notes: [
        { targetItemId: 41, content: "Grounded summary." },
        { targetItemId: 42, content: "Grounded summary." },
      ],
    };
    const prepared = await service.prepare(mutationTool(), { operation });
    const postState: LibraryMutationState = {
      version: 1,
      operation: "save_notes_batch",
      items: [
        { itemId: 700, exists: true, parentItemId: 41, noteHtml: html },
        { itemId: 701, exists: true, parentItemId: 42, noteHtml: html },
      ],
    };
    const verificationFor = (noteId: number) => ({
      schemaVersion: 1,
      noteId,
      matches: true,
      html,
      expectedHtml: html,
    });
    const receipts = await service.finalize(prepared, {
      ok: true,
      effect: "applied",
      actionEvidence: [
        {
          ...mutationEvidence(
            operation,
            { version: 1, operation: "save_notes_batch", items: [] },
            postState,
            "journal-batch",
          )[0],
          noteWrites: [
            {
              noteId: 700,
              parentItemId: 41,
              verification: verificationFor(700),
            },
            {
              noteId: 701,
              parentItemId: 42,
              verification: verificationFor(701),
            },
          ],
        },
      ],
    });
    const receipt = receipts[0];
    assert.equal(
      receipt.verification,
      "unverified",
      "a receipt cannot vouch for a note its own re-read could not confirm",
    );
    assert.equal(
      receipt.status,
      "applied",
      "the captured post-state still proves the set landed",
    );
    assert.deepEqual(
      receipt.appliedTargets,
      receipt.requestedTargets,
      "the write is not retracted by the failed re-read",
    );
    assert.include(receipt.verifiedFacts, "created_note:item:700");
    assert.lengthOf(
      receipt.verifiedFacts.filter((fact) => fact.startsWith("native_note:")),
      1,
      "only the note that survived its re-read carries a content fact",
    );
    assert.notInclude(receipt.verifiedFacts.join(" "), "native_note:701:");
    assert.deepEqual(
      receipt.reasons.filter((reason) => reason.includes("701")),
      ["Zotero item 701 is not a live note after mutation."],
      "the receipt names the written note it could not re-read",
    );
  });
});

/**
 * Every receipt the finalize path mints for a write whose proof is not a
 * library mutation operation, pinned whole.
 *
 * These branches are being consolidated onto one evidence record, and the only
 * way to show that a consolidation changed nothing is to have written down
 * beforehand every field the branch produced — not just its verification.
 * Each case therefore asserts the entire receipt with `deepEqual`.
 */
describe("Bespoke finalize-branch receipts", function () {
  async function receiptFor(params: {
    harness: ReturnType<typeof createHarness>;
    proposal: AgentToolActionDescriptor;
    content?: unknown;
    effect?: AgentToolEffect;
    ok?: boolean;
    actionEvidence?: AgentActionEvidence[];
  }) {
    const prepared = await params.harness.service.prepare(
      { ...mutationTool(), describeAction: () => [params.proposal] },
      {},
    );
    const receipts = await params.harness.service.finalize(prepared, {
      ok: params.ok ?? true,
      effect: params.effect ?? "applied",
      content: params.content,
      actionEvidence: params.actionEvidence,
    });
    assert.lengthOf(receipts, 1);
    return receipts[0];
  }

  describe("note_write", function () {
    const html = "<p>Grounded summary.</p>";

    function noteHarness(parentItemId = 41) {
      const harness = createHarness();
      harness.items.set(41, {
        tags: [],
        collections: [],
        fields: { title: "Paper" },
      });
      harness.items.set(700, {
        tags: [],
        collections: [],
        fields: {},
        kind: "note",
        parentItemId,
        noteHtml: html,
      });
      return harness;
    }

    function noteProposal(
      operation: "note_create" | "note_edit" | "note_append",
      parameters: Record<string, unknown>,
      requestedTargets: string[],
    ): AgentToolActionDescriptor {
      return {
        id: `${operation}:700`,
        proofDomain: "zotero_state",
        capability: "zotero.notes",
        operation,
        source: "zotero_native",
        parameters,
        requestedTargets,
        destinationCollectionIds: [],
      };
    }

    it("credits the parent paper and names the native HTML digest on a created note", async function () {
      const parameters = {
        noteMode: "create",
        targetItemId: 41,
        documentId: "doc-material-1",
        documentVersion: 2,
        contentHash: "sha256:frozen-content-hash",
      };
      const receipt = await receiptFor({
        harness: noteHarness(),
        proposal: noteProposal("note_create", parameters, ["item:41"]),
        content: {
          actionId: "action-note-1",
          noteId: 700,
          noteVerification: {
            schemaVersion: 1,
            noteId: 700,
            matches: true,
            html,
            expectedHtml: html,
          },
        },
      });
      assert.deepEqual(receipt, {
        version: 2,
        id: "note_create:700:unmatched:action-note-1",
        proposalId: "note_create:700",
        proofDomain: "zotero_state",
        capability: "zotero.notes",
        operation: "note_create",
        requestedTargets: ["item:41"],
        rejectedTargets: [],
        normalizedParameters: parameters,
        reasons: [],
        verifiedFacts: [
          "created_note:item:700",
          `native_note:700:html_sha256:${await sha256Text(html)}`,
        ],
        materialRef: {
          documentId: "doc-material-1",
          documentVersion: 2,
          contentHash: "sha256:frozen-content-hash",
        },
        evidenceRef: "action-note-1",
        verification: "verified",
        status: "applied",
        appliedTargets: ["item:41"],
        alreadySatisfiedTargets: [],
      });
    });

    it("marks a no-effect create already satisfied on the weaker text match", async function () {
      const parameters = {
        noteMode: "create",
        targetItemId: 41,
        expectedText: "Grounded summary.",
      };
      const receipt = await receiptFor({
        harness: noteHarness(),
        proposal: noteProposal("note_create", parameters, ["item:41"]),
        content: { noteId: 700 },
        effect: "none",
      });
      assert.deepEqual(receipt, {
        version: 2,
        id: "note_create:700:unmatched:result",
        proposalId: "note_create:700",
        proofDomain: "zotero_state",
        capability: "zotero.notes",
        operation: "note_create",
        requestedTargets: ["item:41"],
        rejectedTargets: [],
        normalizedParameters: parameters,
        reasons: [],
        verifiedFacts: ["created_note:item:700", "native_note:700:text_match"],
        materialRef: undefined,
        evidenceRef: undefined,
        verification: "verified",
        status: "already_satisfied",
        appliedTargets: [],
        alreadySatisfiedTargets: ["item:41"],
      });
    });

    for (const operation of ["note_edit", "note_append"] as const) {
      it(`covers the note itself on a verified ${operation}`, async function () {
        const parameters = {
          noteMode: operation === "note_edit" ? "edit" : "append",
          targetNoteId: 700,
          expectedText: "Grounded summary.",
        };
        const receipt = await receiptFor({
          harness: noteHarness(),
          proposal: noteProposal(operation, parameters, ["item:700"]),
          content: { noteId: 700 },
        });
        assert.deepEqual(receipt, {
          version: 2,
          id: `${operation}:700:unmatched:result`,
          proposalId: `${operation}:700`,
          proofDomain: "zotero_state",
          capability: "zotero.notes",
          operation,
          requestedTargets: ["item:700"],
          rejectedTargets: [],
          normalizedParameters: parameters,
          reasons: [],
          verifiedFacts: ["native_note:700:text_match"],
          materialRef: undefined,
          evidenceRef: undefined,
          verification: "verified",
          status: "applied",
          appliedTargets: ["item:700"],
          alreadySatisfiedTargets: [],
        });
      });
    }

    const noteFailures: Array<{
      name: string;
      parentItemId?: number;
      content: unknown;
      reason: string;
    }> = [
      {
        name: "the result names no note",
        content: {},
        reason: "The note mutation returned no stable note ID to verify.",
      },
      {
        name: "the created note hangs off another paper",
        parentItemId: 42,
        content: { noteId: 700 },
        reason: "Created note 700 is not attached to requested item 41.",
      },
      {
        name: "the native read-back does not prove the prepared change",
        content: {
          noteId: 700,
          noteVerification: {
            schemaVersion: 1,
            noteId: 700,
            matches: false,
            html,
            expectedHtml: html,
          },
        },
        reason:
          "The native note evidence does not prove the prepared change on the bound note.",
      },
    ];

    for (const failure of noteFailures) {
      it(`leaves the receipt unverified when ${failure.name}`, async function () {
        const parameters = { noteMode: "create", targetItemId: 41 };
        const receipt = await receiptFor({
          harness: noteHarness(failure.parentItemId),
          proposal: noteProposal("note_create", parameters, ["item:41"]),
          content: failure.content,
        });
        assert.deepEqual(receipt, {
          version: 2,
          id: "note_create:700:unmatched:result",
          proposalId: "note_create:700",
          proofDomain: "zotero_state",
          capability: "zotero.notes",
          operation: "note_create",
          requestedTargets: ["item:41"],
          rejectedTargets: [],
          normalizedParameters: parameters,
          reasons: [failure.reason],
          verifiedFacts: [],
          materialRef: undefined,
          evidenceRef: undefined,
          verification: "unverified",
          status: "unverified",
          appliedTargets: [],
          alreadySatisfiedTargets: [],
        });
      });
    }
  });

  describe("library_settings", function () {
    function settingsProposal(
      settingsValue: string,
    ): AgentToolActionDescriptor {
      return {
        id: "settings_update:automaticTags",
        proofDomain: "zotero_state",
        capability: "zotero.settings",
        operation: "settings_update",
        source: "zotero_native",
        parameters: { settingsKey: "automaticTags", settingsValue },
        requestedTargets: ["setting:automaticTags"],
        destinationCollectionIds: [],
      };
    }

    /**
     * The record `library_settings` attaches in production: the preference as
     * the plan found it, as the write recorded it, and as the user authorized
     * it.
     */
    function settingsEvidence(params: {
      previous?: unknown;
      recorded: unknown;
      authorized: unknown;
    }): AgentActionEvidence[] {
      return [
        {
          version: 1,
          source: "external_mutation",
          operation: "update_preference",
          preImage: {
            kind: "preference",
            key: "automaticTags",
            existed: params.previous !== undefined,
            value: params.previous,
          },
          postImage: {
            kind: "preference",
            key: "automaticTags",
            existed: true,
            value: params.recorded,
          },
          authorizedPostImage: {
            kind: "preference",
            key: "automaticTags",
            existed: true,
            value: params.authorized,
          },
          journalStepId: "settings-action:1",
          effect: "applied",
        },
      ];
    }

    const UNVERIFIED_REASON =
      "This update_preference write could not be verified: live Zotero state " +
      "does not hold what this write was authorized to produce.";

    function settingsReceipt(params: {
      verification: "verified" | "unverified";
      status: "applied" | "already_satisfied" | "unverified";
      settingsValue: string;
      appliedTargets: string[];
      alreadySatisfiedTargets: string[];
      rejectedTargets: string[];
    }) {
      return {
        version: 2,
        id: "settings_update:automaticTags:unmatched:result",
        proposalId: "settings_update:automaticTags",
        proofDomain: "zotero_state",
        capability: "zotero.settings",
        operation: "settings_update",
        requestedTargets: ["setting:automaticTags"],
        rejectedTargets: params.rejectedTargets,
        normalizedParameters: {
          settingsKey: "automaticTags",
          settingsValue: params.settingsValue,
        },
        // Two fields moved when this operation joined the generic evidence
        // path, and only these two: an unverified receipt now says why, and
        // the receipt names the durable step rather than its action, as every
        // library-mutation receipt already did.
        reasons: params.verification === "verified" ? [] : [UNVERIFIED_REASON],
        verifiedFacts: [],
        materialRef: undefined,
        evidenceRef: "settings-action:1",
        verification: params.verification,
        status: params.status,
        appliedTargets: params.appliedTargets,
        alreadySatisfiedTargets: params.alreadySatisfiedTargets,
      };
    }

    it("verifies a preference the native state now holds", async function () {
      const harness = createHarness();
      harness.settings.set("automaticTags", true);
      const receipt = await receiptFor({
        harness,
        proposal: settingsProposal(JSON.stringify(true)),
        actionEvidence: settingsEvidence({
          previous: false,
          recorded: true,
          authorized: true,
        }),
      });
      assert.deepEqual(
        receipt,
        settingsReceipt({
          verification: "verified",
          status: "applied",
          settingsValue: "true",
          appliedTargets: ["setting:automaticTags"],
          alreadySatisfiedTargets: [],
          rejectedTargets: [],
        }),
      );
    });

    it("reports a no-effect set as already satisfied", async function () {
      const harness = createHarness();
      harness.settings.set("automaticTags", true);
      const receipt = await receiptFor({
        harness,
        proposal: settingsProposal(JSON.stringify(true)),
        effect: "none",
        actionEvidence: settingsEvidence({
          previous: true,
          recorded: true,
          authorized: true,
        }),
      });
      assert.deepEqual(
        receipt,
        settingsReceipt({
          verification: "verified",
          status: "already_satisfied",
          settingsValue: "true",
          appliedTargets: [],
          alreadySatisfiedTargets: ["setting:automaticTags"],
          rejectedTargets: [],
        }),
      );
    });

    it("refuses a preference whose native value is not the authorized one", async function () {
      const harness = createHarness();
      harness.settings.set("automaticTags", false);
      const receipt = await receiptFor({
        harness,
        proposal: settingsProposal(JSON.stringify(true)),
        actionEvidence: settingsEvidence({
          previous: false,
          recorded: true,
          authorized: true,
        }),
      });
      assert.deepEqual(
        receipt,
        settingsReceipt({
          verification: "unverified",
          status: "unverified",
          settingsValue: "true",
          appliedTargets: [],
          alreadySatisfiedTargets: [],
          rejectedTargets: ["setting:automaticTags"],
        }),
      );
    });

    it("refuses a preference that is not set at all", async function () {
      const receipt = await receiptFor({
        harness: createHarness(),
        proposal: settingsProposal(JSON.stringify(true)),
        actionEvidence: settingsEvidence({ recorded: true, authorized: true }),
      });
      assert.deepEqual(
        receipt,
        settingsReceipt({
          verification: "unverified",
          status: "unverified",
          settingsValue: "true",
          appliedTargets: [],
          alreadySatisfiedTargets: [],
          rejectedTargets: ["setting:automaticTags"],
        }),
      );
    });

    it("refuses a native value that only matches the request after coercion", async function () {
      // The proposal froze the literal argument; the gateway writes a coerced
      // one. The receipt compares against what the user authorized, so a
      // string "true" written as boolean true is not proof of that request.
      const harness = createHarness();
      harness.settings.set("automaticTags", true);
      const receipt = await receiptFor({
        harness,
        proposal: settingsProposal(JSON.stringify("true")),
        // The gateway coerces "true" to the boolean the preference holds, and
        // records that. Only the authorized literal refuses it.
        actionEvidence: settingsEvidence({
          previous: false,
          recorded: true,
          authorized: "true",
        }),
      });
      assert.deepEqual(
        receipt,
        settingsReceipt({
          verification: "unverified",
          status: "unverified",
          settingsValue: '"true"',
          appliedTargets: [],
          alreadySatisfiedTargets: [],
          rejectedTargets: ["setting:automaticTags"],
        }),
      );
    });
  });

  describe("annotate_pdf", function () {
    const expectedAnnotation = {
      text: "A full quotation.",
      comment: "Core result",
      color: "#ffd400",
      pageLabel: "2",
      sortIndex: "00001|000000|00020",
      position: { pageIndex: 1, rects: [[20, 40, 90, 50]] },
      source: { documentFingerprint: "fixture", startChar: 0, endChar: 17 },
    };
    function annotationHarness(params: {
      annotationParent?: number;
      isAnnotation?: boolean;
    }) {
      const harness = createHarness();
      harness.items.set(900, {
        tags: [],
        collections: [],
        fields: {},
        kind: "attachment",
      });
      harness.items.set(901, {
        tags: [],
        collections: [],
        fields: {},
        annotationFields: {
          annotationType: "highlight",
          annotationText: expectedAnnotation.text,
          annotationComment: expectedAnnotation.comment,
          annotationColor: expectedAnnotation.color,
          annotationPageLabel: expectedAnnotation.pageLabel,
          annotationSortIndex: expectedAnnotation.sortIndex,
          annotationPosition: JSON.stringify(expectedAnnotation.position),
        },
        kind: params.isAnnotation === false ? "note" : "annotation",
        parentItemId: params.annotationParent ?? 900,
      });
      return harness;
    }

    const annotationProposal: AgentToolActionDescriptor = {
      id: "annotation_write:900:1",
      proofDomain: "zotero_state",
      capability: "zotero.annotations",
      operation: "annotation_write",
      source: "zotero_native",
      parameters: {
        targetItemId: 900,
        pageIndex: 1,
        expectedText: expectedAnnotation.text,
        annotationColor: expectedAnnotation.color,
        annotationComment: expectedAnnotation.comment,
      },
      requestedTargets: ["item:900"],
      destinationCollectionIds: [],
    };

    function annotationReceipt(params: {
      verification: "verified" | "unverified";
      status: "applied" | "unverified";
      target: string;
      appliedTargets: string[];
      rejectedTargets: string[];
    }) {
      return {
        version: 2,
        id: "annotation_write:900:1:unmatched:result",
        proposalId: "annotation_write:900:1",
        proofDomain: "zotero_state",
        capability: "zotero.annotations",
        operation: "annotation_write",
        requestedTargets: [params.target],
        rejectedTargets: params.rejectedTargets,
        normalizedParameters: annotationProposal.parameters,
        reasons: [],
        verifiedFacts: [],
        materialRef: undefined,
        evidenceRef: undefined,
        verification: params.verification,
        status: params.status,
        appliedTargets: params.appliedTargets,
        alreadySatisfiedTargets: [],
      };
    }

    it("retargets the receipt onto the annotation Zotero committed", async function () {
      const receipt = await receiptFor({
        harness: annotationHarness({}),
        proposal: annotationProposal,
        content: { annotationId: 901, expectedAnnotation },
      });
      assert.deepEqual(
        receipt,
        annotationReceipt({
          verification: "verified",
          status: "applied",
          target: "item:901",
          appliedTargets: ["item:901"],
          rejectedTargets: [],
        }),
      );
    });

    it("refuses wrong native content or geometry even under the correct attachment", async function () {
      for (const [field, value] of Object.entries({
        annotationText: "Wrong quotation",
        annotationComment: "Wrong comment",
        annotationColor: "#ff6666",
        annotationPageLabel: "9",
        annotationPosition: JSON.stringify({
          pageIndex: 1,
          rects: [[0, 0, 1, 1]],
        }),
      })) {
        const harness = annotationHarness({});
        harness.items.get(901)!.annotationFields![field] = value;
        const receipt = await receiptFor({
          harness,
          proposal: annotationProposal,
          content: { annotationId: 901, expectedAnnotation },
        });
        assert.equal(receipt.verification, "unverified", field);
      }
    });
    it("credits an existing matching annotation as already satisfied", async function () {
      const receipt = await receiptFor({
        harness: annotationHarness({}),
        proposal: annotationProposal,
        content: { annotationId: 901, expectedAnnotation },
        effect: "none",
      });
      assert.equal(receipt.status, "already_satisfied");
      assert.deepEqual(receipt.alreadySatisfiedTargets, ["item:901"]);
      assert.isEmpty(receipt.appliedTargets);
    });

    it("falls back to the requested attachment when no annotation ID came back", async function () {
      const receipt = await receiptFor({
        harness: annotationHarness({}),
        proposal: annotationProposal,
        content: {},
      });
      assert.deepEqual(
        receipt,
        annotationReceipt({
          verification: "unverified",
          status: "unverified",
          target: "item:900",
          appliedTargets: [],
          rejectedTargets: ["item:900"],
        }),
      );
    });

    it("checks a host selection's frozen rects against the payload Zotero committed", async function () {
      const withRects = (expectedRects: number[][]) => ({
        ...annotationProposal,
        parameters: { ...annotationProposal.parameters, expectedRects },
      });
      const matching = await receiptFor({
        harness: annotationHarness({}),
        proposal: withRects([[20, 40, 90, 50]]),
        content: { annotationId: 901, expectedAnnotation },
      });
      assert.equal(matching.verification, "verified");
      assert.equal(matching.status, "applied");

      const moved = await receiptFor({
        harness: annotationHarness({}),
        proposal: withRects([[20, 40, 90, 51]]),
        content: { annotationId: 901, expectedAnnotation },
      });
      assert.equal(
        moved.verification,
        "unverified",
        "the payload's rects differ from the selection the user saw",
      );
    });

    it("refuses an annotation that belongs to another attachment", async function () {
      const receipt = await receiptFor({
        harness: annotationHarness({ annotationParent: 902 }),
        proposal: annotationProposal,
        content: { annotationId: 901, expectedAnnotation },
      });
      assert.deepEqual(
        receipt,
        annotationReceipt({
          verification: "unverified",
          status: "unverified",
          target: "item:901",
          appliedTargets: [],
          rejectedTargets: ["item:901"],
        }),
      );
    });

    it("refuses an item that is not an annotation", async function () {
      const receipt = await receiptFor({
        harness: annotationHarness({ isAnnotation: false }),
        proposal: annotationProposal,
        content: { annotationId: 901, expectedAnnotation },
      });
      assert.deepEqual(
        receipt,
        annotationReceipt({
          verification: "unverified",
          status: "unverified",
          target: "item:901",
          appliedTargets: [],
          rejectedTargets: ["item:901"],
        }),
      );
    });
  });

  describe("an external write with no operation-specific verifier", function () {
    // The consolidation target: a Zotero write that carries no library
    // mutation operation and no branch of its own is verified from the record
    // the mutation boundary attached, by re-reading its post-image now.
    const proposal: AgentToolActionDescriptor = {
      id: "save_note:700",
      proofDomain: "zotero_state",
      capability: "zotero.notes",
      operation: "save_note",
      source: "zotero_native",
      requestedTargets: ["item:700"],
      destinationCollectionIds: [],
    };

    function preferenceImage(value: unknown) {
      return {
        kind: "preference",
        key: "automaticTags",
        existed: true,
        value,
      };
    }

    function preferenceEvidence(params: {
      recorded: unknown;
      authorized?: unknown;
    }): AgentActionEvidence[] {
      return [
        {
          version: 1,
          source: "external_mutation",
          operation: "update_preference",
          preImage: {
            kind: "preference",
            key: "automaticTags",
            existed: false,
            value: undefined,
          },
          postImage: preferenceImage(params.recorded),
          ...("authorized" in params
            ? { authorizedPostImage: preferenceImage(params.authorized) }
            : {}),
          journalStepId: "action-ext:1",
          effect: "applied",
        },
      ];
    }

    async function receiptWith(params: {
      harness: ReturnType<typeof createHarness>;
      actionEvidence?: AgentActionEvidence[];
      effect?: AgentToolEffect;
    }) {
      const prepared = await params.harness.service.prepare(
        { ...mutationTool(), describeAction: () => [proposal] },
        {},
      );
      const receipts = await params.harness.service.finalize(prepared, {
        ok: true,
        effect: params.effect ?? "applied",
        content: {},
        actionEvidence: params.actionEvidence,
      });
      return receipts[0];
    }

    it("verifies the write when live state still holds its post-image", async function () {
      const harness = createHarness();
      harness.settings.set("automaticTags", true);
      const receipt = await receiptWith({
        harness,
        actionEvidence: preferenceEvidence({ recorded: true }),
      });
      assert.equal(receipt.verification, "verified");
      assert.equal(receipt.status, "applied");
      assert.deepEqual(receipt.appliedTargets, ["item:700"]);
      assert.deepEqual(receipt.reasons, []);
      assert.equal(receipt.evidenceRef, "action-ext:1");
    });

    it("reports a write whose post-image no longer reads back", async function () {
      const harness = createHarness();
      harness.settings.set("automaticTags", false);
      const receipt = await receiptWith({
        harness,
        actionEvidence: preferenceEvidence({ recorded: true }),
      });
      assert.equal(receipt.verification, "unverified");
      assert.equal(receipt.status, "unverified");
      assert.deepEqual(receipt.rejectedTargets, ["item:700"]);
      assert.match(
        receipt.reasons.join(" "),
        /This update_preference write could not be verified: live Zotero state no longer matches what this write recorded when it applied/,
      );
    });

    it("credits a no-effect write as already satisfied", async function () {
      const harness = createHarness();
      harness.settings.set("automaticTags", true);
      const receipt = await receiptWith({
        harness,
        actionEvidence: preferenceEvidence({ recorded: true }),
        effect: "none",
      });
      assert.equal(receipt.verification, "verified");
      assert.equal(receipt.status, "already_satisfied");
      assert.deepEqual(receipt.alreadySatisfiedTargets, ["item:700"]);
    });

    it("credits the authorized image, not the one the tool recorded", async function () {
      // The tool wrote a coerced value and recorded that. The user authorized
      // the literal, so the receipt must compare live state against the
      // literal: a write that landed as something else is not the change the
      // user approved, however faithfully the tool recorded it.
      const harness = createHarness();
      harness.settings.set("automaticTags", true);
      const receipt = await receiptWith({
        harness,
        actionEvidence: preferenceEvidence({
          recorded: true,
          authorized: "true",
        }),
      });
      assert.equal(receipt.verification, "unverified");
      assert.match(
        receipt.reasons.join(" "),
        /live Zotero state does not hold what this write was authorized to produce/,
      );
    });

    it("verifies when live state holds the authorized image", async function () {
      const harness = createHarness();
      harness.settings.set("automaticTags", true);
      const receipt = await receiptWith({
        harness,
        actionEvidence: preferenceEvidence({
          recorded: true,
          authorized: true,
        }),
      });
      assert.equal(receipt.verification, "verified");
      assert.equal(receipt.status, "applied");
    });

    it("cannot read a captured library state back, and says so", async function () {
      // A library-operation post-image needs the mutation handlers and the
      // operation it was captured for; that evidence belongs on the library
      // branch, which carries both. Reaching this branch with one must read as
      // "could not check", never as agreement.
      const receipt = await receiptWith({
        harness: createHarness(),
        actionEvidence: [
          {
            version: 1,
            source: "external_mutation",
            operation: "create_pdf_annotation",
            postImage: {
              version: 1,
              operation: "trash_items",
              items: [{ itemId: 901, exists: true, deleted: false }],
            },
            journalStepId: "action-ext:1",
            effect: "applied",
          },
        ],
      });
      assert.equal(receipt.verification, "unverified");
      assert.match(
        receipt.reasons.join(" "),
        /could not be verified: the recorded post-image format cannot be read back by this version/,
      );
    });

    it("refuses a write that attached no evidence at all", async function () {
      const receipt = await receiptWith({ harness: createHarness() });
      assert.equal(receipt.verification, "unverified");
      assert.deepEqual(receipt.reasons, [
        "No native Zotero post-state verifier is registered for this action.",
      ]);
    });

    it("refuses to pick one record out of a multi-step result", async function () {
      // A multi-file export journals one step per file. Matching the first
      // would credit the whole receipt with one member's proof.
      const harness = createHarness();
      harness.settings.set("automaticTags", true);
      const receipt = await receiptWith({
        harness,
        actionEvidence: [
          ...preferenceEvidence({ recorded: true }),
          ...preferenceEvidence({ recorded: true }),
        ],
      });
      assert.equal(receipt.verification, "unverified");
      assert.deepEqual(receipt.reasons, [
        "No native Zotero post-state verifier is registered for this action.",
      ]);
    });
  });

  describe("undo and revert", function () {
    const undoProposal: AgentToolActionDescriptor = {
      id: "undo:action-7",
      proofDomain: "zotero_state",
      capability: "zotero.undo",
      operation: "undo",
      source: "zotero_native",
      requestedTargets: ["journal-action:action-7"],
      destinationCollectionIds: [],
    };

    it("verifies an undo whose every replayed step re-read as matched", async function () {
      const receipt = await receiptFor({
        harness: createHarness(),
        proposal: undoProposal,
        content: {
          status: "undone",
          actionId: "action-7",
          actionIds: ["action-7"],
          revertedSteps: [
            { actionId: "action-7", sequence: 1, verification: "matched" },
          ],
        },
      });
      assert.deepEqual(receipt, {
        version: 2,
        id: "undo:action-7:unmatched:action-7",
        proposalId: "undo:action-7",
        proofDomain: "zotero_state",
        capability: "zotero.undo",
        operation: "undo",
        requestedTargets: ["journal-action:action-7"],
        rejectedTargets: [],
        normalizedParameters: undefined,
        reasons: [],
        verifiedFacts: ["reverted_step:action-7:1:matched"],
        materialRef: undefined,
        evidenceRef: "action-7",
        verification: "verified",
        status: "applied",
        appliedTargets: ["journal-action:action-7"],
        alreadySatisfiedTargets: [],
      });
    });

    it("refuses an undo whose step re-read as mismatched", async function () {
      const receipt = await receiptFor({
        harness: createHarness(),
        proposal: undoProposal,
        content: {
          status: "undone",
          actionId: "action-7",
          actionIds: ["action-7"],
          revertedSteps: [
            {
              actionId: "action-7",
              sequence: 1,
              verification: "mismatched",
              reason: "the note changed again",
            },
          ],
        },
      });
      assert.deepEqual(receipt, {
        version: 2,
        id: "undo:action-7:unmatched:action-7",
        proposalId: "undo:action-7",
        proofDomain: "zotero_state",
        capability: "zotero.undo",
        operation: "undo",
        requestedTargets: ["journal-action:action-7"],
        rejectedTargets: ["journal-action:action-7"],
        normalizedParameters: undefined,
        reasons: [
          "Reverted step 1 of action-7 re-read as mismatched: the note changed again.",
        ],
        verifiedFacts: [],
        materialRef: undefined,
        evidenceRef: "action-7",
        verification: "unverified",
        status: "unverified",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
      });
    });
  });

  describe("file_io and execution", function () {
    const fileProposal: AgentToolActionDescriptor = {
      id: "file_write:/tmp/report.md",
      proofDomain: "file_state",
      capability: "file.write",
      operation: "file_write",
      source: "file_io",
      parameters: { filePath: "/tmp/report.md" },
      requestedTargets: ["file:/tmp/report.md"],
      destinationCollectionIds: [],
      expectedContentHash: "abc",
      expectedFiles: [
        { path: "/tmp/report.md", contentHash: "abc", byteLength: 12 },
      ],
    };

    it("verifies a file write from its readback identity", async function () {
      const receipt = await receiptFor({
        harness: createHarness(),
        proposal: fileProposal,
        content: {
          filePath: "/tmp/report.md",
          exists: true,
          contentHash: "abc",
          exportedFiles: [
            {
              filePath: "/tmp/report.md",
              exists: true,
              contentHash: "abc",
              bytesWritten: 12,
            },
          ],
        },
      });
      assert.deepEqual(receipt, {
        version: 2,
        id: "file_write:/tmp/report.md:unmatched:result:sha256:abc",
        proposalId: "file_write:/tmp/report.md",
        proofDomain: "file_state",
        capability: "file.write",
        operation: "file_write",
        requestedTargets: ["file:/tmp/report.md"],
        rejectedTargets: [],
        normalizedParameters: { filePath: "/tmp/report.md" },
        reasons: [],
        verifiedFacts: ["/tmp/report.md:sha256:abc"],
        materialRef: undefined,
        evidenceRef: "sha256:abc",
        verification: "verified",
        status: "applied",
        appliedTargets: ["file:/tmp/report.md"],
        alreadySatisfiedTargets: [],
      });
    });

    it("refuses a file write that was never read back", async function () {
      const receipt = await receiptFor({
        harness: createHarness(),
        proposal: fileProposal,
        content: { filePath: "/tmp/report.md" },
      });
      assert.deepEqual(receipt, {
        version: 2,
        id: "file_write:/tmp/report.md:unmatched:result:unverified",
        proposalId: "file_write:/tmp/report.md",
        proofDomain: "file_state",
        capability: "file.write",
        operation: "file_write",
        requestedTargets: ["file:/tmp/report.md"],
        rejectedTargets: [],
        normalizedParameters: { filePath: "/tmp/report.md" },
        reasons: [
          "The written file was not read back with an exact path and content hash.",
        ],
        verifiedFacts: [],
        materialRef: undefined,
        evidenceRef: undefined,
        verification: "unverified",
        status: "unverified",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
      });
    });

    const commandProposal: AgentToolActionDescriptor = {
      id: "command_execute:fp",
      proofDomain: "execution",
      capability: "command.execute",
      operation: "command_execute",
      source: "command",
      parameters: { commandFingerprint: "fp" },
      requestedTargets: [],
      destinationCollectionIds: [],
    };

    it("keeps a command with no re-readable state at execution_only", async function () {
      const receipt = await receiptFor({
        harness: createHarness(),
        proposal: commandProposal,
        content: { exitCode: 0 },
      });
      assert.deepEqual(receipt, {
        version: 2,
        id: "command_execute:fp:unmatched:result",
        proposalId: "command_execute:fp",
        proofDomain: "execution",
        capability: "command.execute",
        operation: "command_execute",
        requestedTargets: [],
        rejectedTargets: [],
        normalizedParameters: { commandFingerprint: "fp" },
        reasons: [],
        verifiedFacts: [],
        materialRef: undefined,
        evidenceRef: undefined,
        verification: "execution_only",
        status: "observed",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
      });
    });

    const scriptProposal: AgentToolActionDescriptor = {
      id: "zotero_script_execute:fp",
      proofDomain: "execution",
      capability: "zotero.script",
      operation: "zotero_script_execute",
      source: "zotero_script",
      requestedTargets: ["item:1"],
      destinationCollectionIds: [],
    };

    it("verifies a script run from its journalled post-image", async function () {
      const receipt = await receiptFor({
        harness: createHarness(),
        proposal: scriptProposal,
        content: {
          executionPostState: {
            verified: true,
            facts: ["script_postcondition:act-1:1:satisfied:2 targets"],
          },
        },
      });
      assert.deepEqual(receipt, {
        version: 2,
        id: "zotero_script_execute:fp:unmatched:result",
        proposalId: "zotero_script_execute:fp",
        proofDomain: "execution",
        capability: "zotero.script",
        operation: "zotero_script_execute",
        requestedTargets: ["item:1"],
        rejectedTargets: [],
        normalizedParameters: undefined,
        reasons: [],
        verifiedFacts: ["script_postcondition:act-1:1:satisfied:2 targets"],
        materialRef: undefined,
        evidenceRef: undefined,
        verification: "verified",
        status: "applied",
        appliedTargets: ["item:1"],
        alreadySatisfiedTargets: [],
      });
    });

    it("refuses a script run whose post-image no longer re-reads", async function () {
      const receipt = await receiptFor({
        harness: createHarness(),
        proposal: scriptProposal,
        content: {
          executionPostState: {
            verified: false,
            facts: ["script_postcondition:act-1:1:mismatched"],
            reason:
              "The script's recorded effect could not be confirmed: an item changed again.",
          },
        },
      });
      assert.deepEqual(receipt, {
        version: 2,
        id: "zotero_script_execute:fp:unmatched:result",
        proposalId: "zotero_script_execute:fp",
        proofDomain: "execution",
        capability: "zotero.script",
        operation: "zotero_script_execute",
        requestedTargets: ["item:1"],
        rejectedTargets: ["item:1"],
        normalizedParameters: undefined,
        reasons: [
          "The script's recorded effect could not be confirmed: an item changed again.",
        ],
        verifiedFacts: ["script_postcondition:act-1:1:mismatched"],
        materialRef: undefined,
        evidenceRef: undefined,
        verification: "unverified",
        status: "unverified",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
      });
    });
  });
});
