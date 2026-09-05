import { assert } from "chai";
import { createTrashItemsTool } from "../src/agent/tools/write/trashItems";
import { createMergeItemsTool } from "../src/agent/tools/write/mergeItems";
import { createImportIdentifiersTool } from "../src/agent/tools/write/importIdentifiers";
import { createImportLocalFilesTool } from "../src/agent/tools/write/importLocalFiles";
import { createManageAttachmentsTool } from "../src/agent/tools/write/manageAttachments";
import type { AgentToolContext } from "../src/agent/types";

/**
 * The confirmation card for a destructive operation renders a real checklist
 * with real checkboxes. Before this suite, `applyConfirmation` discarded the
 * user's answer ("Checklist is informational") and every listed item was
 * trashed regardless of what they unchecked.
 *
 * These tests pin the consent contract: what the user leaves checked is what
 * happens, an empty selection is an error rather than a silent no-op, and the
 * non-HITL (`auto_approve`) path is unaffected.
 */
describe("destructive checklist consent", function () {
  const baseContext: AgentToolContext = {
    request: {
      conversationKey: 42,
      mode: "agent",
      userText: "clean these up",
      libraryID: 1,
    },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  };

  const fakeGateway = {
    getItem: (id: number) => ({
      id,
      getField: (name: string) => (name === "title" ? `Item ${id}` : ""),
    }),
  } as never;

  describe("trash_items", function () {
    function validated() {
      const tool = createTrashItemsTool(fakeGateway);
      const result = tool.validate({ itemIds: [101, 102, 103] });
      assert.isTrue(result.ok, "fixture should validate");
      if (!result.ok) throw new Error("unreachable");
      return { tool, input: result.value };
    }

    it("renders one checklist row per item, all checked", function () {
      const { tool, input } = validated();
      const pending = tool.createPendingAction?.(input, baseContext);
      const field = pending?.fields.find((f) => f.type === "checklist");
      assert.exists(field, "expected a checklist field");
      assert.equal(
        (field as never as { id: string }).id,
        "trashItemsChecklist",
      );
      const items = (
        field as never as { items: Array<{ id: string; checked: boolean }> }
      ).items;
      assert.deepEqual(
        items.map((i) => i.id),
        ["101", "102", "103"],
      );
      assert.isTrue(items.every((i) => i.checked));
    });

    it("trashes only the rows the user left checked", function () {
      const { tool, input } = validated();
      const applied = tool.applyConfirmation?.(input, {
        trashItemsChecklist: ["101", "103"],
      });
      assert.isTrue(
        applied?.ok,
        "expected the narrowed selection to be accepted",
      );
      if (!applied?.ok) return;
      assert.deepEqual(
        (applied.value as { operation: { itemIds: number[] } }).operation
          .itemIds,
        [101, 103],
        "unchecked item 102 must not be trashed",
      );
    });

    it("fails rather than trashing everything when the user unchecks all rows", function () {
      const { tool, input } = validated();
      const applied = tool.applyConfirmation?.(input, {
        trashItemsChecklist: [],
      });
      assert.isFalse(
        applied?.ok,
        "an empty selection must be an explicit error, never a silent full trash",
      );
    });

    it("passes through unchanged when there is no resolution data (auto_approve)", function () {
      const { tool, input } = validated();
      const applied = tool.applyConfirmation?.(input, undefined);
      assert.isTrue(applied?.ok);
      if (!applied?.ok) return;
      assert.deepEqual(
        (applied.value as { operation: { itemIds: number[] } }).operation
          .itemIds,
        [101, 102, 103],
      );
    });
  });

  describe("merge_items", function () {
    function validated() {
      const tool = createMergeItemsTool(fakeGateway);
      const result = tool.validate({
        masterItemId: 200,
        otherItemIds: [201, 202],
      });
      assert.isTrue(result.ok, "fixture should validate");
      if (!result.ok) throw new Error("unreachable");
      return { tool, input: result.value };
    }

    it("merges and trashes only the duplicates left checked", function () {
      const { tool, input } = validated();
      const applied = tool.applyConfirmation?.(input, {
        duplicatesChecklist: ["202"],
      });
      assert.isTrue(applied?.ok);
      if (!applied?.ok) return;
      const op = (
        applied.value as {
          operation: { masterItemId: number; otherItemIds: number[] };
        }
      ).operation;
      assert.equal(
        op.masterItemId,
        200,
        "the master is not part of the checklist",
      );
      assert.deepEqual(
        op.otherItemIds,
        [202],
        "unchecked duplicate 201 must survive",
      );
    });

    it("fails when every duplicate is unchecked", function () {
      const { tool, input } = validated();
      const applied = tool.applyConfirmation?.(input, {
        duplicatesChecklist: [],
      });
      assert.isFalse(applied?.ok);
    });

    it("passes through unchanged with no resolution data", function () {
      const { tool, input } = validated();
      const applied = tool.applyConfirmation?.(input, undefined);
      assert.isTrue(applied?.ok);
      if (!applied?.ok) return;
      assert.deepEqual(
        (applied.value as { operation: { otherItemIds: number[] } }).operation
          .otherItemIds,
        [201, 202],
      );
    });
  });

  describe('import_identifiers (row ids are array indices, so "0" is valid)', function () {
    function validated() {
      const tool = createImportIdentifiersTool(fakeGateway);
      const result = tool.validate({
        identifiers: ["10.1/aaa", "10.2/bbb", "10.3/ccc"],
      });
      assert.isTrue(result.ok, "fixture should validate");
      if (!result.ok) throw new Error("unreachable");
      return { tool, input: result.value };
    }

    it("imports only the checked identifiers, including index 0", function () {
      const { tool, input } = validated();
      const applied = tool.applyConfirmation?.(input, {
        identifiersChecklist: ["0", "2"],
      });
      assert.isTrue(applied?.ok);
      if (!applied?.ok) return;
      assert.deepEqual(
        (applied.value as { operation: { identifiers: string[] } }).operation
          .identifiers,
        ["10.1/aaa", "10.3/ccc"],
        "index 0 must survive normalization",
      );
    });

    it("fails when every identifier is unchecked", function () {
      const { tool, input } = validated();
      const applied = tool.applyConfirmation?.(input, {
        identifiersChecklist: [],
      });
      assert.isFalse(applied?.ok);
    });
  });

  describe("import_local_files (row ids are file paths)", function () {
    function validated() {
      const tool = createImportLocalFilesTool(fakeGateway);
      const result = tool.validate({
        filePaths: ["/tmp/a.pdf", "/tmp/b.pdf"],
      });
      assert.isTrue(result.ok, "fixture should validate");
      if (!result.ok) throw new Error("unreachable");
      return { tool, input: result.value };
    }

    it("imports only the checked paths", function () {
      const { tool, input } = validated();
      const applied = tool.applyConfirmation?.(input, {
        filesChecklist: ["/tmp/b.pdf"],
      });
      assert.isTrue(applied?.ok);
      if (!applied?.ok) return;
      assert.deepEqual(
        (applied.value as { operation: { filePaths: string[] } }).operation
          .filePaths,
        ["/tmp/b.pdf"],
      );
    });

    it("fails when every file is unchecked", function () {
      const { tool, input } = validated();
      const applied = tool.applyConfirmation?.(input, { filesChecklist: [] });
      assert.isFalse(applied?.ok);
    });
  });

  /**
   * Rename and re-link render "New name" / "New path" as real editable
   * inputs — there is no read-only text field in that renderer. The edit was
   * thrown away, so correcting a wrong filename did nothing, and for re-link
   * correcting the path is the entire point of the operation.
   */
  describe("attachment rename and re-link honour the edited value", function () {
    const attachmentGateway = {
      getItem: (id: number) => ({
        id,
        getDisplayTitle: () => `Attachment ${id}`,
        getField: () => "",
        isAttachment: () => true,
      }),
    } as never;

    it("renames to the value the user typed, not the model's", function () {
      const tool = createManageAttachmentsTool(attachmentGateway);
      const validated = tool.validate({
        action: "rename",
        attachmentId: 5,
        newName: "paper-final-v2.pdf",
      });
      assert.isTrue(validated.ok, JSON.stringify(validated));
      if (!validated.ok) return;

      const applied = tool.applyConfirmation?.(validated.value, {
        to: "Smith 2024 - Hippocampal replay.pdf",
      });
      assert.isTrue(applied?.ok);
      if (!applied?.ok) return;
      assert.equal(
        (applied.value as { operation: { newName: string } }).operation.newName,
        "Smith 2024 - Hippocampal replay.pdf",
      );
    });

    it("re-links to the corrected path", function () {
      const tool = createManageAttachmentsTool(attachmentGateway);
      const validated = tool.validate({
        action: "relink",
        attachmentId: 5,
        newPath: "/wrong/guess.pdf",
      });
      assert.isTrue(validated.ok, JSON.stringify(validated));
      if (!validated.ok) return;

      const applied = tool.applyConfirmation?.(validated.value, {
        path: "/Users/me/papers/real.pdf",
      });
      assert.isTrue(applied?.ok);
      if (!applied?.ok) return;
      assert.equal(
        (applied.value as { operation: { newPath: string } }).operation.newPath,
        "/Users/me/papers/real.pdf",
      );
    });

    it("refuses an emptied field rather than running the model's value", function () {
      const tool = createManageAttachmentsTool(attachmentGateway);
      const validated = tool.validate({
        action: "rename",
        attachmentId: 5,
        newName: "paper.pdf",
      });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;
      const applied = tool.applyConfirmation?.(validated.value, { to: "   " });
      assert.isFalse(applied?.ok);
    });
  });
});
