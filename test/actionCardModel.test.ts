import { assert } from "chai";
import type { AgentRunEventRecord } from "../src/agent/types";
import type { AgentActionReceipt } from "../src/agent/contracts/types";
import {
  buildAgentActionSummaryCard,
  noteEffectNoteId,
  type ActionCardResolvers,
} from "../src/modules/contextPanel/agentTrace/actionCardModel";

function receipt(
  overrides: Partial<AgentActionReceipt> & {
    id: string;
    operation: AgentActionReceipt["operation"];
  },
): AgentActionReceipt {
  return {
    version: 2,
    proposalId: overrides.id,
    proofDomain: "zotero_state",
    capability: "zotero.collections",
    verification: "verified",
    status: "applied",
    requestedTargets: ["item:11"],
    appliedTargets: ["item:11"],
    alreadySatisfiedTargets: [],
    rejectedTargets: [],
    reasons: [],
    verifiedFacts: [],
    ...overrides,
  } as AgentActionReceipt;
}

function toolResult(
  seq: number,
  receipts: AgentActionReceipt[],
): AgentRunEventRecord {
  return {
    id: `e${seq}`,
    sequence: seq,
    timestamp: seq,
    payload: {
      type: "tool_result",
      callId: `c${seq}`,
      name: "library_update",
      ok: true,
      actionReceipts: receipts,
      content: {},
    },
  } as unknown as AgentRunEventRecord;
}

const resolvers: ActionCardResolvers = {
  itemLabel: (id) => ({
    label: id === 11 ? "Smith, 2021" : id === 12 ? "Lee, 2020" : `Item ${id}`,
    libraryID: 1,
    itemKey: `K${id}`,
  }),
  collectionLabel: (id) =>
    id === 7 ? { label: "Reviews", libraryID: 1 } : undefined,
  noteLabel: (id) =>
    id === 99 ? { label: "Summary", libraryID: 1, itemKey: "N99" } : undefined,
  materialTitle: () => undefined,
};

/**
 * The same library, seen the way a note-writing receipt's target resolves: 77
 * is a child note of paper 11, and 88 is a note that hangs under nothing.
 */
const noteResolvers: ActionCardResolvers = {
  ...resolvers,
  itemLabel: (id) =>
    id === 77
      ? { label: "Smith, 2021", libraryID: 1, itemKey: "K11", itemId: 11 }
      : id === 88
        ? undefined
        : resolvers.itemLabel(id),
  noteLabel: (id) =>
    id === 77 || id === 88
      ? { label: "Reading notes", libraryID: 1, itemKey: `N${id}` }
      : resolvers.noteLabel(id),
};

describe("action card model", function () {
  it("uses the executed result command ahead of the requested arguments", function () {
    const requested = "echo requested";
    const executed = "printf '%s\\n' '<literal>'\n  echo executed";
    const result = toolResult(2, [
      receipt({ id: "cmd", operation: "command_execute" }),
    ]);
    if (result.payload.type !== "tool_result")
      throw new Error("Expected result");
    result.payload.content = { command: executed };
    const call = {
      ...result,
      payload: {
        type: "tool_call",
        callId: "c2",
        name: "run_command",
        args: { command: requested },
      },
    } as AgentRunEventRecord;
    const card = buildAgentActionSummaryCard([call, result], resolvers)!;
    assert.equal(card.entries[0].effects[0].command, executed);
  });

  it("pairs command arguments by call identity when older results omit them", function () {
    const first = toolResult(3, [
      receipt({
        id: "a",
        operation: "command_execute",
        requestedTargets: [],
        appliedTargets: [],
      }),
    ]);
    const second = toolResult(4, [
      receipt({
        id: "b",
        operation: "command_execute",
        requestedTargets: [],
        appliedTargets: [],
      }),
    ]);
    const call = (callId: string, command: string) =>
      ({
        ...first,
        payload: {
          type: "tool_call",
          callId,
          name: "run_command",
          args: { command },
        },
      }) as AgentRunEventRecord;
    const card = buildAgentActionSummaryCard(
      [call("c4", "echo second"), call("c3", "echo first"), first, second],
      resolvers,
    )!;
    assert.deepEqual(
      card.entries.map((entry) => entry.effects[0].command),
      ["echo first", "echo second"],
    );
  });

  for (const source of ["codeBlock", "args"] as const) {
    it(`recovers connected command ${source} from its matching activity`, function () {
      const command = "printf 'connected\\n'\n  echo done";
      const result = toolResult(1, []);
      const started = {
        ...result,
        payload: {
          type: "codex_tool_activity",
          itemId: "command-1",
          phase: "started",
          ...(source === "codeBlock"
            ? { codeBlock: command }
            : { args: { command } }),
        },
      } as AgentRunEventRecord;
      const completed = {
        ...result,
        payload: {
          type: "codex_tool_activity",
          itemId: "command-1",
          phase: "completed",
          actionReceipts: [
            receipt({ id: "cmd", operation: "command_execute" }),
          ],
        },
      } as AgentRunEventRecord;
      const card = buildAgentActionSummaryCard(
        [started, completed],
        resolvers,
      )!;
      assert.equal(card.entries[0].effects[0].command, command);
    });
  }

  it("does not invent command source from fingerprints or descriptive labels", function () {
    const card = buildAgentActionSummaryCard(
      [
        toolResult(1, [
          receipt({
            id: "cmd",
            operation: "command_execute",
            normalizedParameters: {
              commandFingerprint: "abc",
              expectedText: "Inspect files",
            },
          }),
        ]),
      ],
      resolvers,
    )!;
    assert.isUndefined(card.entries[0].effects[0].command);
  });

  it("projects a move into target, verb, collection object and verdict", function () {
    const card = buildAgentActionSummaryCard(
      [
        toolResult(1, [
          receipt({
            id: "r1",
            operation: "move_to_collection",
            normalizedParameters: {
              sourceCollectionId: 3,
              destinationCollectionId: 7,
            },
          }),
        ]),
      ],
      resolvers,
    );
    assert.equal(card?.actionCount, 1);
    assert.lengthOf(card!.entries, 1);
    const entry = card!.entries[0];
    assert.deepEqual(entry.targets, [
      {
        kind: "item",
        itemId: 11,
        label: "Smith, 2021",
        libraryID: 1,
        itemKey: "K11",
      },
    ]);
    assert.equal(entry.effects[0].verb.glyph, "→");
    assert.equal(entry.effects[0].label, "Moved to collection");
    assert.deepEqual(entry.effects[0].objects, [
      { kind: "collection", label: "Reviews", collectionId: 7, libraryID: 1 },
    ]);
    assert.equal(entry.verification, "verified");
    assert.deepEqual(entry.badges, ["Verified"]);
  });

  it("calls a filing that left the item's other folders alone an add, not a move", function () {
    const card = buildAgentActionSummaryCard(
      [
        toolResult(1, [
          receipt({
            id: "r1",
            operation: "move_to_collection",
            normalizedParameters: { destinationCollectionId: 7 },
          }),
        ]),
      ],
      resolvers,
    );
    assert.equal(card!.entries[0].effects[0].label, "Added to collection");
  });

  it("groups receipts that share a target set into one row, in receipt order", function () {
    const card = buildAgentActionSummaryCard(
      [
        toolResult(1, [
          receipt({
            id: "n",
            operation: "note_create",
            capability: "zotero.notes",
            verifiedFacts: ["native_note:99:text_match"],
          }),
        ]),
        toolResult(2, [
          receipt({
            id: "m",
            operation: "move_to_collection",
            normalizedParameters: { collectionName: "Reviews" },
          }),
        ]),
      ],
      resolvers,
    );
    assert.equal(card?.actionCount, 2);
    assert.lengthOf(card!.entries, 1);
    assert.deepEqual(
      card!.entries[0].effects.map((e) => e.operation),
      ["note_create", "move_to_collection"],
    );
    assert.deepEqual(card!.entries[0].effects[0].objects, [
      {
        kind: "note",
        label: "Summary",
        noteId: 99,
        libraryID: 1,
        itemKey: "N99",
      },
    ]);
    assert.deepEqual(card!.entries[0].effects[1].objects, [
      { kind: "collection", label: "Reviews" },
    ]);
  });

  it("keeps one receipt with many targets as one row", function () {
    const card = buildAgentActionSummaryCard(
      [
        toolResult(1, [
          receipt({
            id: "m",
            operation: "move_to_collection",
            requestedTargets: ["item:11", "item:12", "item:13"],
            appliedTargets: ["item:11", "item:12", "item:13"],
            normalizedParameters: { collectionName: "Reviews" },
          }),
        ]),
      ],
      resolvers,
    );
    assert.deepEqual(
      card!.entries[0].targets.map((t) => t.label),
      ["Smith, 2021", "Lee, 2020", "Item 13"],
    );
  });

  it("lists rejected targets with the receipt's first reason", function () {
    const card = buildAgentActionSummaryCard(
      [
        toolResult(1, [
          receipt({
            id: "m",
            operation: "move_to_collection",
            status: "partial",
            requestedTargets: ["item:11", "item:12"],
            appliedTargets: ["item:11"],
            rejectedTargets: ["item:12"],
            reasons: ["already in Reviews"],
            normalizedParameters: { collectionName: "Reviews" },
          }),
        ]),
      ],
      resolvers,
    );
    assert.deepEqual(
      card!.entries[0].targets.map((t) => t.label),
      ["Smith, 2021"],
    );
    assert.deepEqual(
      card!.entries[0].rejected.map((t) => t.label),
      ["Lee, 2020"],
    );
    assert.equal(card!.entries[0].rejectedReason, "already in Reviews");
  });

  it("projects tags, removed tags, files, commands, fields and trash", function () {
    const card = buildAgentActionSummaryCard(
      [
        toolResult(1, [
          receipt({
            id: "t",
            operation: "apply_tags",
            capability: "zotero.tags",
            normalizedParameters: { tags: ["to-read", "osc"] },
          }),
        ]),
        toolResult(2, [
          receipt({
            id: "u",
            operation: "remove_tags",
            capability: "zotero.tags",
            requestedTargets: ["item:12"],
            appliedTargets: ["item:12"],
            normalizedParameters: { tags: ["triage"] },
          }),
        ]),
        toolResult(3, [
          receipt({
            id: "f",
            operation: "file_write",
            capability: "file.write",
            proofDomain: "file_state",
            requestedTargets: [],
            appliedTargets: [],
            normalizedParameters: { newPath: "notes/smith-2021.md" },
          }),
        ]),
        toolResult(4, [
          receipt({
            id: "c",
            operation: "command_execute",
            capability: "command.execute",
            proofDomain: "execution",
            verification: "execution_only",
            requestedTargets: [],
            appliedTargets: [],
            normalizedParameters: { expectedText: "pandoc a.md -o a.docx" },
          }),
        ]),
        // `status: "unverified"` is not a reported effect (`receiptReportsEffect`),
        // so it would never reach the card; the unverified *proof* is the point here.
        toolResult(5, [
          receipt({
            id: "d",
            operation: "update_metadata",
            capability: "zotero.metadata",
            verification: "unverified",
            normalizedParameters: { metadataFields: ["DOI"] },
          }),
        ]),
        toolResult(6, [
          receipt({
            id: "x",
            operation: "trash_items",
            capability: "zotero.trash",
            requestedTargets: ["item:13"],
            appliedTargets: ["item:13"],
            executionAuthority: "external_runtime",
          }),
        ]),
      ],
      resolvers,
    );
    const byOp = Object.fromEntries(
      card!.entries.flatMap((e) =>
        e.effects.map((f) => [f.operation, { e, f }]),
      ),
    );
    assert.deepEqual(byOp.apply_tags.f.objects, [
      { kind: "tag", label: "to-read" },
      { kind: "tag", label: "osc" },
    ]);
    assert.deepEqual(byOp.remove_tags.f.objects, [
      { kind: "tag", label: "triage", removed: true },
    ]);
    assert.deepEqual(byOp.file_write.f.objects, [
      {
        kind: "file",
        label: "notes/smith-2021.md",
        path: "notes/smith-2021.md",
      },
    ]);
    assert.deepEqual(byOp.command_execute.f.objects, [
      { kind: "command", label: "pandoc a.md -o a.docx" },
    ]);
    // Two receipts that named no item share no object, so they never share a
    // verdict: the file write stays verified beside the command that was not.
    assert.notStrictEqual(byOp.file_write.e, byOp.command_execute.e);
    assert.deepEqual(byOp.file_write.e.badges, ["Verified"]);
    assert.deepEqual(byOp.command_execute.e.badges, ["Ran (no state proof)"]);
    assert.deepEqual(byOp.update_metadata.f.objects, [
      { kind: "field", label: "DOI" },
    ]);
    assert.deepEqual(byOp.trash_items.f.objects, [
      // The chip opens the trash of the library the item it trashed lives in.
      { kind: "trash", libraryID: 1 },
    ]);
    assert.equal(byOp.trash_items.e.authority, "external_runtime");
    assert.deepEqual(byOp.trash_items.e.badges, [
      "Verified",
      "Authorized by connected client",
    ]);
  });

  it("shows nothing for a read-only or failed-only run and dedupes receipts by id", function () {
    assert.isNull(
      buildAgentActionSummaryCard(
        [
          toolResult(1, [
            receipt({
              id: "r",
              operation: "read_full",
              capability: "zotero.read",
            }),
          ]),
        ],
        resolvers,
      ),
    );
    const dup = receipt({
      id: "same",
      operation: "apply_tags",
      capability: "zotero.tags",
      normalizedParameters: { tags: ["a"] },
    });
    assert.equal(
      buildAgentActionSummaryCard(
        [toolResult(1, [dup]), toolResult(2, [dup])],
        resolvers,
      )?.actionCount,
      1,
    );
  });

  it("gives a merged row the weakest proof its receipts carry", function () {
    const card = buildAgentActionSummaryCard(
      [
        toolResult(1, [
          receipt({
            id: "t",
            operation: "apply_tags",
            capability: "zotero.tags",
            normalizedParameters: { tags: ["to-read"] },
          }),
        ]),
        toolResult(2, [
          receipt({
            id: "d",
            operation: "update_metadata",
            capability: "zotero.metadata",
            verification: "unverified",
            normalizedParameters: { metadataFields: ["DOI"] },
          }),
        ]),
      ],
      resolvers,
    );
    assert.lengthOf(card!.entries, 1);
    assert.equal(card!.entries[0].verification, "unverified");
    assert.deepEqual(card!.entries[0].badges, ["Unverified"]);
  });

  it("keeps a receipt that rejected a target out of a clean row on the same targets", function () {
    const card = buildAgentActionSummaryCard(
      [
        toolResult(1, [
          receipt({
            id: "m",
            operation: "move_to_collection",
            status: "partial",
            requestedTargets: ["item:11", "item:12"],
            appliedTargets: ["item:11"],
            rejectedTargets: ["item:12"],
            reasons: ["already in Reviews"],
            normalizedParameters: { collectionName: "Reviews" },
          }),
        ]),
        toolResult(2, [
          receipt({
            id: "t",
            operation: "apply_tags",
            capability: "zotero.tags",
            normalizedParameters: { tags: ["to-read"] },
          }),
        ]),
      ],
      resolvers,
    );
    assert.lengthOf(card!.entries, 2);
    assert.deepEqual(
      card!.entries[0].effects.map((e) => e.operation),
      ["move_to_collection"],
    );
    assert.deepEqual(
      card!.entries[0].rejected.map((t) => t.label),
      ["Lee, 2020"],
    );
    assert.deepEqual(
      card!.entries[1].effects.map((e) => e.operation),
      ["apply_tags"],
    );
    assert.deepEqual(card!.entries[1].rejected, []);
    assert.isUndefined(card!.entries[1].rejectedReason);
  });

  it("merges the same targets however the receipts ordered them", function () {
    const card = buildAgentActionSummaryCard(
      [
        toolResult(1, [
          receipt({
            id: "t",
            operation: "apply_tags",
            capability: "zotero.tags",
            requestedTargets: ["item:11", "item:12"],
            appliedTargets: ["item:11", "item:12"],
            normalizedParameters: { tags: ["to-read"] },
          }),
        ]),
        toolResult(2, [
          receipt({
            id: "u",
            operation: "remove_tags",
            capability: "zotero.tags",
            requestedTargets: ["item:12", "item:11"],
            appliedTargets: ["item:12", "item:11"],
            normalizedParameters: { tags: ["triage"] },
          }),
        ]),
      ],
      resolvers,
    );
    assert.lengthOf(card!.entries, 1);
    assert.deepEqual(
      card!.entries[0].effects.map((e) => e.operation),
      ["apply_tags", "remove_tags"],
    );
    assert.deepEqual(
      card!.entries[0].targets.map((t) => t.itemId),
      [11, 12],
    );
  });

  it("never merges two items that happen to read the same", function () {
    const sameLabel: ActionCardResolvers = {
      ...resolvers,
      itemLabel: () => ({ label: "Item X" }),
    };
    const card = buildAgentActionSummaryCard(
      [
        toolResult(1, [
          receipt({
            id: "t",
            operation: "apply_tags",
            capability: "zotero.tags",
            normalizedParameters: { tags: ["to-read"] },
          }),
        ]),
        toolResult(2, [
          receipt({
            id: "u",
            operation: "apply_tags",
            capability: "zotero.tags",
            requestedTargets: ["item:12"],
            appliedTargets: ["item:12"],
            normalizedParameters: { tags: ["to-read"] },
          }),
        ]),
      ],
      sameLabel,
    );
    assert.lengthOf(card!.entries, 2);
    assert.deepEqual(
      card!.entries.map((e) => e.targets.map((t) => t.itemId)),
      [[11], [12]],
    );
    assert.deepEqual(
      card!.entries.map((e) => e.targets.map((t) => t.label)),
      [["Item X"], ["Item X"]],
    );
  });

  it("draws a child note's edit on its paper's row, not as a second paper", function () {
    const card = buildAgentActionSummaryCard(
      [
        toolResult(1, [
          receipt({
            id: "e",
            operation: "note_edit",
            capability: "zotero.notes",
            requestedTargets: ["item:77"],
            appliedTargets: ["item:77"],
            verifiedFacts: ["native_note:77:html_sha256:abc"],
          }),
        ]),
        toolResult(2, [
          receipt({
            id: "t",
            operation: "apply_tags",
            capability: "zotero.tags",
            normalizedParameters: { tags: ["to-read"] },
          }),
        ]),
      ],
      noteResolvers,
    );
    assert.lengthOf(
      card!.entries,
      1,
      "the note's paper is the same row as the tag on that paper",
    );
    assert.deepEqual(card!.entries[0].targets, [
      {
        kind: "item",
        itemId: 11,
        label: "Smith, 2021",
        libraryID: 1,
        itemKey: "K11",
      },
    ]);
    assert.deepEqual(card!.entries[0].effects[0].objects, [
      {
        kind: "note",
        label: "Reading notes",
        noteId: 77,
        libraryID: 1,
        itemKey: "N77",
      },
    ]);
    assert.deepEqual(
      card!.entries[0].effects.map((e) => e.operation),
      ["note_edit", "apply_tags"],
    );
  });

  it("states a standalone note's edit as the note alone", function () {
    const card = buildAgentActionSummaryCard(
      [
        toolResult(1, [
          receipt({
            id: "e",
            operation: "note_edit",
            capability: "zotero.notes",
            requestedTargets: ["item:88"],
            appliedTargets: ["item:88"],
            verifiedFacts: ["native_note:88:html_sha256:abc"],
          }),
        ]),
      ],
      noteResolvers,
    );
    assert.deepEqual(
      card!.entries[0].targets,
      [],
      "a note with no paper draws no phantom paper beside itself",
    );
    assert.deepEqual(card!.entries[0].effects[0].objects, [
      {
        kind: "note",
        label: "Reading notes",
        noteId: 88,
        libraryID: 1,
        itemKey: "N88",
      },
    ]);
  });

  it("keeps the identity of an id the library cannot name at all", function () {
    const blind: ActionCardResolvers = {
      ...resolvers,
      itemLabel: () => undefined,
    };
    const card = buildAgentActionSummaryCard(
      [
        toolResult(1, [
          receipt({
            id: "t",
            operation: "apply_tags",
            capability: "zotero.tags",
            normalizedParameters: { tags: ["to-read"] },
          }),
        ]),
      ],
      blind,
    );
    assert.deepEqual(card!.entries[0].targets, [
      { kind: "item", itemId: 11, label: "Item 11" },
    ]);
  });

  it("sends the trash chip to the library the trashed item lives in", function () {
    const trashed = (resolvers: ActionCardResolvers) =>
      buildAgentActionSummaryCard(
        [
          toolResult(1, [
            receipt({
              id: "x",
              operation: "trash_items",
              capability: "zotero.trash",
            }),
          ]),
        ],
        resolvers,
      )!.entries[0].effects[0].objects;
    assert.deepEqual(trashed(resolvers), [{ kind: "trash", libraryID: 1 }]);
    assert.deepEqual(
      trashed({ ...resolvers, itemLabel: () => ({ label: "Smith, 2021" }) }),
      [{ kind: "trash" }],
      "a target that named no library leaves the chip to find its own",
    );
  });

  it("reads the note id from verified facts, then from parameters", function () {
    assert.equal(
      noteEffectNoteId(
        receipt({
          id: "a",
          operation: "note_edit",
          verifiedFacts: ["native_note:42:html_sha256:abc"],
        }),
      ),
      42,
    );
    assert.equal(
      noteEffectNoteId(
        receipt({
          id: "b",
          operation: "note_edit",
          normalizedParameters: { targetNoteId: 43 },
        }),
      ),
      43,
    );
    assert.isUndefined(
      noteEffectNoteId(receipt({ id: "c", operation: "apply_tags" })),
    );
  });
});
