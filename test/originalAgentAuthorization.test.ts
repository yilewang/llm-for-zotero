import { assert } from "chai";
import {
  readOnlyInvocationPlan,
  stateChangeInvocationPlan,
} from "../src/agent/authorization/invocationPlan";
import {
  authorizeOriginalAction,
  normalizeStoredActionConstraints,
} from "../src/agent/authorization/policy";
import { buildActionProposal } from "../src/agent/authorization/proposal";
import type {
  ActionConstraint,
  ActionProposal,
} from "../src/agent/authorization/types";
import { semanticFixture } from "./helpers/semanticIntent";

function action(
  operation = "apply_tags",
  options: {
    domain?: "filesystem" | "zotero_library" | "network";
    effect?: "create" | "modify" | "delete" | "egress";
    mechanism?: "none" | "shell" | "zotero_script";
    assurance?: "runtime_enforced" | "unknown";
    riskSignals?: any[];
    capability?: string;
    read?: boolean;
  } = {},
): ActionProposal {
  const plan = options.read
    ? readOnlyInvocationPlan({ reason: "Host-confined read" })
    : stateChangeInvocationPlan({
        domains: [options.domain || "zotero_library"],
        effects: [options.effect || "modify"],
        mechanism: options.mechanism || "none",
        assurance: options.assurance || "runtime_enforced",
        riskSignals: options.riskSignals || [],
        reversibility: "full",
        reason: "Exact host effect",
      });
  const result = buildActionProposal({
    tool: {
      spec: {
        name: "test",
        description: "",
        inputSchema: {},
        executionClass: options.read ? "read" : "external_effect",
        requiresConfirmation: false,
      },
      validate: (value: unknown) => ({ ok: true, value }),
      execute: async () => ({}),
    },
    input: {},
    plan,
  });
  return {
    ...result,
    operation,
    capabilities: [options.capability || "zotero.tags"],
  };
}
const noNotes: ActionConstraint = {
  kind: "deny_effects",
  effects: ["create"],
  domains: ["zotero_library"],
  operations: ["note_create", "save_note", "save_notes_batch"],
  description: "No new notes",
};
const noZotero: ActionConstraint = {
  kind: "deny_effects",
  effects: ["create", "modify", "delete"],
  domains: ["zotero_library"],
  description: "Do not change Zotero",
};
const noShell: ActionConstraint = {
  kind: "deny_mechanisms",
  mechanisms: ["shell", "zotero_script"],
  description: "No commands or scripts",
};

describe("central authorization from semantic authority", function () {
  for (const mode of ["safe", "auto", "yolo"] as const) {
    it(`${mode}: permits trusted reads without mutation authority`, function () {
      assert.equal(
        authorizeOriginalAction(action("read", { read: true }), { mode }).kind,
        "execute",
      );
    });
    it(`${mode}: rejects prohibited effects, including opaque mechanisms`, function () {
      for (const operation of [
        "note_create",
        "save_note",
        "save_notes_batch",
        "create_collection+note_create",
      ]) {
        assert.equal(
          authorizeOriginalAction(action(operation, { effect: "create" }), {
            mode,
            constraints: [noNotes],
            hasMatchingActionIntent: true,
          }).kind,
          "block",
        );
      }
      assert.equal(
        authorizeOriginalAction(
          action("zotero_script_execute", {
            effect: "create",
            mechanism: "zotero_script",
            assurance: "unknown",
          }),
          { mode, constraints: [noNotes], hasMatchingActionIntent: true },
        ).kind,
        "block",
      );
      assert.equal(
        authorizeOriginalAction(
          action("create_collection", { effect: "create" }),
          { mode, constraints: [noNotes], hasMatchingActionIntent: true },
        ).kind,
        mode === "safe" ? "confirm" : "execute",
      );
    });
    it(`${mode}: preserves independent domain and mechanism restrictions`, function () {
      assert.equal(
        authorizeOriginalAction(
          action("file_write", { domain: "filesystem" }),
          { mode, constraints: [noZotero], hasMatchingActionIntent: true },
        ).kind,
        mode === "safe" ? "confirm" : "execute",
      );
      assert.equal(
        authorizeOriginalAction(action("note_create", { effect: "create" }), {
          mode,
          constraints: [noZotero],
          hasMatchingActionIntent: true,
        }).kind,
        "block",
      );
      assert.equal(
        authorizeOriginalAction(
          action("command_execute", { mechanism: "shell" }),
          { mode, constraints: [noShell], hasMatchingActionIntent: true },
        ).kind,
        "block",
      );
    });
    it(`${mode}: preserves exact exceptions and independent blanket bans`, function () {
      const restriction: ActionConstraint = {
        kind: "deny_effects",
        domains: ["zotero_library"],
        effects: ["delete"],
        exceptOperations: ["trash_items"],
        description: "No permanent deletion",
      };
      assert.equal(
        authorizeOriginalAction(action("trash_items", { effect: "delete" }), {
          mode,
          constraints: [restriction],
          hasMatchingActionIntent: true,
        }).kind,
        mode === "safe" ? "confirm" : "execute",
      );
      assert.equal(
        authorizeOriginalAction(
          action("delete_attachment", { effect: "delete" }),
          { mode, constraints: [restriction], hasMatchingActionIntent: true },
        ).kind,
        "block",
      );
      assert.equal(
        authorizeOriginalAction(action("trash_items", { effect: "delete" }), {
          mode,
          constraints: [restriction, noZotero],
          hasMatchingActionIntent: true,
        }).kind,
        "block",
      );
    });
    it(`${mode}: uses mode policy for existing notes and preserves requested creation`, function () {
      assert.equal(
        authorizeOriginalAction(
          action("note_edit", { capability: "zotero.notes" }),
          { mode, constraints: [noNotes], hasMatchingActionIntent: true },
        ).kind,
        mode === "safe" ? "confirm" : "execute",
      );
      assert.deepEqual(
        authorizeOriginalAction(
          action("note_create", {
            effect: "create",
            capability: "zotero.notes",
          }),
          { mode, hasMatchingActionIntent: true },
        ),
        { kind: "execute", authority: "requested_note" },
      );
    });
    it(`${mode}: prevents discovery or conversational memory from granting persistence`, function () {
      for (const literature of ["discover", "select_then_import"] as const) {
        assert.equal(
          authorizeOriginalAction(
            action("import_identifiers", {
              effect: "create",
              capability: "zotero.import",
            }),
            {
              mode,
              semantic: semanticFixture({ literature }),
              hasMatchingActionIntent: true,
            },
          ).kind,
          "block",
        );
      }
      assert.equal(
        authorizeOriginalAction(
          action("note_create", {
            effect: "create",
            capability: "zotero.notes",
          }),
          {
            mode,
            semantic: semanticFixture({ conversationOnly: true }),
            hasMatchingActionIntent: true,
          },
        ).kind,
        "block",
      );
    });
    it(`${mode}: plan approval does not bypass integrity or restrictions`, function () {
      const context = { mode, hasApprovedPlanAuthority: true };
      assert.equal(authorizeOriginalAction(action(), context).kind, "execute");
      assert.equal(
        authorizeOriginalAction(action(), {
          ...context,
          constraints: [noZotero],
        }).kind,
        "block",
      );
      assert.equal(
        authorizeOriginalAction(
          action("apply_tags", { riskSignals: ["protected_target"] }),
          context,
        ).kind,
        "block",
      );
    });
    it(`${mode}: effects without an exact semantic or approved-plan match`, function () {
      const expected =
        mode === "yolo"
          ? { kind: "execute", authority: "yolo_judgment" }
          : {
              kind: "block",
              reason:
                "The proposed effect has no matching semantic action authority.",
            };
      assert.deepEqual(authorizeOriginalAction(action(), { mode }), expected);
      assert.deepEqual(
        authorizeOriginalAction(
          action("command_execute", {
            assurance: "unknown",
            mechanism: "shell",
            domain: "filesystem",
          }),
          { mode },
        ),
        expected,
      );
    });
    it(`${mode}: judgment never bypasses hard rails`, function () {
      assert.equal(
        authorizeOriginalAction(action(), { mode, constraints: [noZotero] })
          .kind,
        "block",
      );
      assert.equal(
        authorizeOriginalAction(
          action("apply_tags", { riskSignals: ["protected_target"] }),
          { mode },
        ).kind,
        "block",
      );
      assert.equal(
        authorizeOriginalAction(
          action("command_execute", {
            mechanism: "shell",
            assurance: "unknown",
          }),
          { mode, constraints: [noShell] },
        ).kind,
        "block",
      );
      assert.equal(
        authorizeOriginalAction(
          action("note_create", {
            effect: "create",
            capability: "zotero.notes",
          }),
          { mode, semantic: semanticFixture({ conversationOnly: true }) },
        ).kind,
        "block",
      );
      assert.equal(
        authorizeOriginalAction(
          action("import_identifiers", {
            effect: "create",
            capability: "zotero.import",
          }),
          { mode, semantic: semanticFixture({ literature: "discover" }) },
        ).kind,
        "block",
      );
    });
  }
  it("retains decoding of legacy execution restrictions for history", function () {
    assert.deepEqual(
      normalizeStoredActionConstraints([
        {
          kind: "deny_effects",
          effects: ["execute"],
          domains: ["local_execution"],
          description: "Legacy",
        },
      ]),
      [
        {
          kind: "deny_mechanisms",
          mechanisms: ["shell", "zotero_script"],
          description: "Legacy",
        },
      ],
    );
  });
});

describe("action interaction contract", function () {
  for (const mode of ["safe", "auto", "yolo"] as const) {
    for (const operation of [
      "apply_tags",
      "note_edit",
      "note_append",
      "update_metadata",
      "move_to_collection",
      "import_identifiers",
    ]) {
      it(`${mode}: preserves intentional review for ${operation}`, function () {
        for (const interaction of [
          { entryPoint: "action_ui", reviewPreference: "default" },
          { entryPoint: "conversation", reviewPreference: "review" },
        ] as const) {
          assert.equal(
            authorizeOriginalAction(action(operation), {
              mode,
              hasMatchingActionIntent: true,
              interaction,
            }).kind,
            "confirm",
          );
        }
      });
      it(`${mode}: direct preference respects mode for ${operation}`, function () {
        assert.equal(
          authorizeOriginalAction(action(operation), {
            mode,
            hasMatchingActionIntent: true,
            interaction: {
              entryPoint: "conversation",
              reviewPreference: "direct",
            },
          }).kind,
          mode === "safe" ? "confirm" : "execute",
        );
      });
    }
    it(`${mode}: requested review does not pause supporting reads`, function () {
      assert.equal(
        authorizeOriginalAction(action("read", { read: true }), {
          mode,
          interaction: {
            entryPoint: "conversation",
            reviewPreference: "review",
          },
        }).kind,
        "execute",
      );
    });
  }
});
