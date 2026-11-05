import { assert } from "chai";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import {
  mutationPostconditionIsSatisfied,
  planMutationInverseFromHandler,
} from "../src/agent/services/libraryMutation/handlerOperations";
import { attachmentImportExecutors } from "../src/agent/services/libraryMutation/attachmentImportExecutors";
import { MutationNoEffectError } from "../src/agent/services/externalMutationCoordinator";
import type {
  LibraryMutationState,
  MutationItemState,
} from "../src/agent/services/libraryMutation/contracts";
import {
  IMPLEMENTED_BY,
  checkCapability,
} from "../src/agent/capabilities/libraryObjects";

/**
 * W5-C: edit an annotation's comment and color through library_update
 * kind:'annotation', with an undo that puts the old values back.
 */
describe("library_update kind:'annotation'", function () {
  const state = (
    operation: LibraryMutationState["operation"],
    items: MutationItemState[],
  ): LibraryMutationState => ({ version: 1, operation, items });

  describe("routing", function () {
    const tool = createBuiltInToolRegistry({} as never).getTool(
      "library_update",
    )!;
    const route = (args: Record<string, unknown>) => {
      const validated = tool.validate(args);
      assert.isTrue(validated.ok, validated.ok ? "" : validated.error);
      if (!validated.ok) throw new Error("unreachable");
      return validated.value as {
        delegateName: string;
        delegateInput: { operation: Record<string, unknown> };
      };
    };

    it("routes kind:'annotation' to an annotation update with a normalized comment and a hex color", function () {
      const routed = route({
        kind: "annotation",
        annotationId: 30,
        comment: "  Key result  ",
        color: "blue",
      });
      assert.equal(routed.delegateName, "annotation_update");
      assert.deepEqual(routed.delegateInput.operation, {
        type: "update_annotation",
        annotationId: 30,
        comment: "Key result",
        color: "#2ea8e5",
      });
      // An empty comment clears it, which is a real edit.
      assert.equal(
        route({ kind: "annotation", annotationId: 30, comment: "" })
          .delegateInput.operation.comment,
        "",
      );
      for (const args of [
        { kind: "annotation", comment: "x" },
        { kind: "annotation", annotationId: 30 },
        { kind: "annotation", annotationId: 30, color: "not-a-color" },
      ]) {
        assert.isFalse(tool.validate(args).ok, JSON.stringify(args));
      }
    });

    it("names the annotation kind in its enum and its effect operations", function () {
      const properties = tool.spec.inputSchema.properties as Record<
        string,
        { enum?: string[] }
      >;
      assert.include(properties.kind.enum!, "annotation");
      assert.include(tool.effectOperations || [], "update_annotation");
    });
  });

  describe("update_annotation", function () {
    const annotationState = (
      comment: string,
      color: string,
    ): MutationItemState => ({
      itemId: 30,
      exists: true,
      parentItemId: 20,
      deleted: false,
      annotation: {
        type: "highlight",
        text: "A passage",
        comment,
        color,
        pageLabel: "1",
        sortIndex: "00000|000010|00020",
        position: null,
        tags: [],
      },
    });
    const operation = {
      type: "update_annotation" as const,
      annotationId: 30,
      comment: "New comment",
      color: "#2ea8e5",
    };

    it("plans an inverse that puts back the comment and color it had", function () {
      const planned = planMutationInverseFromHandler(
        operation,
        state("update_annotation", [annotationState("Old", "#ffd400")]),
      );
      assert.deepEqual(planned.inverseOperations, [
        {
          type: "update_annotation",
          annotationId: 30,
          comment: "Old",
          color: "#ffd400",
        },
      ]);
    });

    it("checks only the fields the edit names", function () {
      assert.isTrue(
        mutationPostconditionIsSatisfied(
          operation,
          state("update_annotation", [
            annotationState("New comment", "#2ea8e5"),
          ]),
        ),
      );
      assert.isFalse(
        mutationPostconditionIsSatisfied(
          operation,
          state("update_annotation", [annotationState("Old", "#2ea8e5")]),
        ),
      );
      assert.isTrue(
        mutationPostconditionIsSatisfied(
          { type: "update_annotation", annotationId: 30, color: "#2ea8e5" },
          state("update_annotation", [annotationState("Old", "#2ea8e5")]),
        ),
      );
      assert.isFalse(
        mutationPostconditionIsSatisfied(
          operation,
          state("update_annotation", [
            { ...annotationState("New comment", "#2ea8e5"), deleted: true },
          ]),
        ),
      );
    });

    it("refuses an item that is not an annotation, and one stored inside the PDF", async function () {
      for (const item of [
        { id: 30, libraryID: 1, isAnnotation: () => false },
        {
          id: 30,
          libraryID: 1,
          isAnnotation: () => true,
          annotationIsExternal: true,
        },
      ]) {
        let error: unknown;
        try {
          await attachmentImportExecutors.update_annotation(
            operation,
            { request: { libraryID: 1 } } as never,
            { getItem: () => item } as never,
          );
        } catch (caught) {
          error = caught;
        }
        assert.instanceOf(error, MutationNoEffectError);
      }
    });

    it("returns the old and new values, which an MCP client reads in place of the card", async function () {
      const execution = await attachmentImportExecutors.update_annotation(
        operation,
        { request: { libraryID: 1 } } as never,
        {
          getItem: () => ({
            id: 30,
            libraryID: 1,
            isAnnotation: () => true,
            annotationType: "highlight",
            annotationIsExternal: false,
            deleted: false,
          }),
          updateAnnotation: async () => ({
            status: "updated",
            previous: { comment: "Old", color: "#ffd400" },
            comment: "New comment",
            color: "#2ea8e5",
          }),
        } as never,
      );
      assert.deepEqual(execution.result.result, {
        status: "updated",
        annotationId: 30,
        annotationType: "highlight",
        previous: { comment: "Old", color: "#ffd400" },
        comment: "New comment",
        color: "#2ea8e5",
      });
    });
  });

  it("credits library_update with updating an annotation", function () {
    assert.equal(IMPLEMENTED_BY["annotation:update"], "library_update");
    assert.equal(checkCapability("update", "annotation").status, "allowed");
  });
});
