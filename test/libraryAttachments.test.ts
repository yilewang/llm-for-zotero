import { assert } from "chai";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { libraryMutationHandlers } from "../src/agent/services/libraryMutation/handlerRegistry";
import {
  createdObjectIdsForLibraryMutation,
  mutationNoChangeOutcome,
  mutationPostconditionIsSatisfied,
} from "../src/agent/services/libraryMutation/handlerOperations";
import { attachmentImportExecutors } from "../src/agent/services/libraryMutation/attachmentImportExecutors";
import { MutationNoEffectError } from "../src/agent/services/externalMutationCoordinator";
import type {
  LibraryMutationState,
  MutationItemState,
} from "../src/agent/services/libraryMutation/contracts";
import { IMPLEMENTED_BY } from "../src/agent/capabilities/libraryObjects";
import { MutationStateReader } from "../src/agent/services/libraryMutation/stateReader";

/**
 * W5-C: attach a file or a web page to an item and run Zotero's Find
 * Available PDF through library_update kind:'attachment'. These are the pure
 * parts: routing, the postconditions the receipts rest on, and the inverses
 * undo replays.
 */
describe("library_update attachments: attach a file or a web page, find a PDF", function () {
  const state = (
    operation: LibraryMutationState["operation"],
    items: MutationItemState[],
  ): LibraryMutationState => ({ version: 1, operation, items });
  const parent: MutationItemState = {
    itemId: 10,
    exists: true,
    parentItemId: null,
    deleted: false,
    childAttachmentIds: [20],
  };
  const child = (
    itemId: number,
    attachmentLinkMode: number,
    extra: Partial<MutationItemState> = {},
  ): MutationItemState => ({
    itemId,
    exists: true,
    parentItemId: 10,
    deleted: false,
    attachmentLinkMode,
    ...extra,
  });

  describe("library_update routing", function () {
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

    it("routes attach_file, attach_url and find_pdf to the attachment delegate", function () {
      const file = route({
        kind: "attachment",
        action: "attach_file",
        itemId: 10,
        filePath: "/tmp/paper.pdf",
      });
      assert.equal(file.delegateName, "attachment_update");
      assert.deepEqual(file.delegateInput.operation, {
        type: "attach_file",
        parentItemId: 10,
        filePath: "/tmp/paper.pdf",
        link: false,
      });
      const linked = route({
        kind: "attachment",
        action: "attach_file",
        itemId: 10,
        filePath: "/tmp/paper.pdf",
        link: true,
      });
      assert.isTrue(linked.delegateInput.operation.link);
      assert.deepEqual(
        route({
          kind: "attachment",
          action: "attach_url",
          itemId: 10,
          url: "https://example.org/page",
        }).delegateInput.operation,
        {
          type: "attach_url",
          parentItemId: 10,
          url: "https://example.org/page",
        },
      );
      assert.deepEqual(
        route({ kind: "attachment", action: "find_pdf", itemId: 10 })
          .delegateInput.operation,
        { type: "find_pdf", itemId: 10 },
      );
    });

    it("refuses an attach without its parent, file or web address", function () {
      for (const args of [
        { kind: "attachment", action: "attach_file", filePath: "/tmp/a.pdf" },
        { kind: "attachment", action: "attach_file", itemId: 10 },
        { kind: "attachment", action: "attach_url", itemId: 10 },
        {
          kind: "attachment",
          action: "attach_url",
          itemId: 10,
          url: "javascript:alert(1)",
        },
        { kind: "attachment", action: "find_pdf" },
      ]) {
        assert.isFalse(tool.validate(args).ok, JSON.stringify(args));
      }
    });

    it("names the new attachment actions in its enum and effect operations", function () {
      const properties = tool.spec.inputSchema.properties as Record<
        string,
        { enum?: string[] }
      >;
      assert.includeMembers(properties.action.enum!, [
        "attach_file",
        "attach_url",
        "find_pdf",
      ]);
      assert.includeMembers(tool.effectOperations || [], [
        "attach_file",
        "attach_url",
        "find_pdf",
      ]);
    });
  });

  describe("attach_file", function () {
    const operation = {
      type: "attach_file" as const,
      parentItemId: 10,
      filePath: "/tmp/paper.pdf",
    };

    it("is satisfied by a live stored copy under the parent, not by the parent before the write", function () {
      assert.isFalse(
        mutationPostconditionIsSatisfied(
          operation,
          state("attach_file", [parent]),
        ),
      );
      assert.isTrue(
        mutationPostconditionIsSatisfied(
          operation,
          state("attach_file", [child(21, 0)]),
        ),
      );
      assert.isFalse(
        mutationPostconditionIsSatisfied(
          operation,
          state("attach_file", [child(21, 2)]),
        ),
        "a link where a stored copy was asked for",
      );
      assert.isTrue(
        mutationPostconditionIsSatisfied(
          { ...operation, link: true },
          state("attach_file", [child(21, 2)]),
        ),
      );
      assert.isFalse(
        mutationPostconditionIsSatisfied(
          operation,
          state("attach_file", [child(21, 0, { deleted: true })]),
        ),
      );
      assert.isFalse(
        mutationPostconditionIsSatisfied(
          operation,
          state("attach_file", [child(21, 0, { parentItemId: 11 })]),
        ),
      );
    });

    it("binds the created attachment from its result", function () {
      assert.deepEqual(
        createdObjectIdsForLibraryMutation(operation, {
          result: { status: "attached", attachmentIds: [21] },
        }).itemIds,
        [21],
      );
      assert.isTrue(
        libraryMutationHandlers.attach_file.deferredInverse(operation),
      );
    });
  });

  describe("attach_url", function () {
    const operation = {
      type: "attach_url" as const,
      parentItemId: 10,
      url: "http://127.0.0.1:8000/page.html",
    };
    const link = child(22, 3, { attachmentUrl: operation.url });
    const snapshot = child(23, 1, { attachmentUrl: operation.url });

    it("needs both the link to the address and the stored snapshot", function () {
      assert.isTrue(
        mutationPostconditionIsSatisfied(
          operation,
          state("attach_url", [link, snapshot]),
        ),
      );
      assert.isFalse(
        mutationPostconditionIsSatisfied(
          operation,
          state("attach_url", [link]),
        ),
      );
      assert.isFalse(
        mutationPostconditionIsSatisfied(
          operation,
          state("attach_url", [snapshot]),
        ),
      );
      assert.isFalse(
        mutationPostconditionIsSatisfied(
          operation,
          state("attach_url", [
            child(22, 3, { attachmentUrl: "http://elsewhere" }),
            snapshot,
          ]),
        ),
        "a link to another address",
      );
      assert.isFalse(
        mutationPostconditionIsSatisfied(
          operation,
          state("attach_url", [parent]),
        ),
      );
    });

    it("reports the two created attachments and trashes both on undo", async function () {
      const created = [
        {
          attachmentId: 22,
          title: "page.html",
          linkMode: "linked_url" as const,
          contentType: "",
          url: operation.url,
        },
        {
          attachmentId: 23,
          title: "A page",
          linkMode: "imported_url" as const,
          contentType: "text/html",
          url: operation.url,
        },
      ];
      const execution = await attachmentImportExecutors.attach_url(
        operation,
        { request: { libraryID: 1 } } as never,
        {
          getItem: () => ({
            id: 10,
            libraryID: 1,
            isRegularItem: () => true,
            deleted: false,
          }),
          attachUrl: async () => ({
            status: "attached",
            attachments: created,
            createdIds: [22, 23],
          }),
        } as never,
      );
      const result = execution.result.result as Record<string, unknown>;
      assert.equal(result.status, "attached");
      assert.deepEqual(result.attachmentIds, [22, 23]);
      assert.deepEqual(result.attachments, created);
      assert.deepEqual(execution.inverse?.inverseOperations, [
        { type: "trash_items", itemIds: [22, 23] },
      ]);
    });

    it("writes nothing and says why when Zotero cannot save the page", async function () {
      let error: unknown;
      try {
        await attachmentImportExecutors.attach_url(
          operation,
          { request: { libraryID: 1 } } as never,
          {
            getItem: () => ({
              id: 10,
              libraryID: 1,
              isRegularItem: () => true,
              deleted: false,
            }),
            attachUrl: async () => ({
              status: "failed",
              reason: "HTTP 404",
            }),
          } as never,
        );
      } catch (caught) {
        error = caught;
      }
      assert.instanceOf(error, MutationNoEffectError);
      assert.include(String((error as Error).message), "HTTP 404");
    });
  });

  describe("find_pdf", function () {
    const operation = { type: "find_pdf" as const, itemId: 10 };
    const gateway = (outcome: unknown) =>
      ({
        getItem: () => ({
          id: 10,
          libraryID: 1,
          isRegularItem: () => true,
          deleted: false,
          getAttachments: () => [20],
        }),
        findAvailablePdf: async () => outcome,
      }) as never;

    it("reports found nothing as no effect, with the attachments the item kept", async function () {
      const execution = await attachmentImportExecutors.find_pdf(
        operation,
        { request: { libraryID: 1 } } as never,
        gateway({ status: "not_found", reason: "no file" }),
      );
      const result = execution.result.result as Record<string, unknown>;
      assert.equal(result.status, "not_found");
      assert.equal(result.reason, "no file");
      assert.notOk(execution.inverse);
      assert.equal(
        libraryMutationHandlers.find_pdf.affectedCount(operation, result),
        0,
      );
    });

    it("verifies a find by its new child, and found nothing against the state before the search", function () {
      assert.isFalse(
        mutationPostconditionIsSatisfied(
          operation,
          state("find_pdf", [parent]),
        ),
        "the state before the search proves nothing",
      );
      assert.isTrue(
        mutationPostconditionIsSatisfied(
          operation,
          state("find_pdf", [child(24, 1)]),
        ),
      );
      const before = state("find_pdf", [parent]);
      const notFound = { status: "not_found", reason: "no file" };
      assert.equal(
        mutationNoChangeOutcome(operation, notFound, before, before),
        "No change: no file",
      );
      assert.isUndefined(
        mutationNoChangeOutcome(
          operation,
          notFound,
          before,
          state("find_pdf", [{ ...parent, childAttachmentIds: [20, 24] }]),
        ),
        "an attachment appeared, so found nothing is not proved",
      );
      assert.isUndefined(
        mutationNoChangeOutcome(operation, { status: "found" }, before, before),
      );
    });

    it("trashes a found PDF on undo", async function () {
      const execution = await attachmentImportExecutors.find_pdf(
        operation,
        { request: { libraryID: 1 } } as never,
        gateway({
          status: "found",
          attachment: {
            attachmentId: 24,
            title: "Full Text PDF",
            linkMode: "imported_url",
            contentType: "application/pdf",
          },
        }),
      );
      const result = execution.result.result as Record<string, unknown>;
      assert.deepEqual(result.attachmentIds, [24]);
      assert.deepEqual(execution.inverse?.inverseOperations, [
        { type: "trash_items", itemIds: [24] },
      ]);
      assert.equal(
        libraryMutationHandlers.find_pdf.affectedCount(operation, result),
        1,
      );
    });

    it("refuses a note or an attachment as the item to search for", async function () {
      let error: unknown;
      try {
        await attachmentImportExecutors.find_pdf(
          operation,
          { request: { libraryID: 1 } } as never,
          {
            getItem: () => ({
              id: 10,
              libraryID: 1,
              isRegularItem: () => false,
            }),
          } as never,
        );
      } catch (caught) {
        error = caught;
      }
      assert.instanceOf(error, MutationNoEffectError);
    });
  });

  it("records the attachment the way the undo that trashes it reads it back", async function () {
    // The undo compares every field the attach recorded with what it reads
    // before trashing; a field only the attach captured made it a conflict.
    const attachment = {
      id: 21,
      parentID: 10,
      deleted: false,
      version: 3,
      dateModified: "2026-10-31 10:00:00",
      attachmentLinkMode: 0,
      attachmentFilename: "paper.pdf",
      isAttachment: () => true,
      isAnnotation: () => false,
      isNote: () => false,
      isRegularItem: () => false,
      getField: (field: string) => (field === "title" ? "paper.pdf" : ""),
      getTags: () => [],
      getCollections: () => [],
      getFilePathAsync: async () => "/storage/ABCD2345/paper.pdf",
    };
    const reader = new MutationStateReader({
      getItem: (id: number) => (id === 21 ? attachment : null),
      getEditableArticleMetadata: () => null,
    } as never);
    const context = { request: { libraryID: 1 } } as never;
    const attached = await reader.captureOperationState(
      { type: "attach_file", parentItemId: 10, filePath: "/tmp/paper.pdf" },
      context,
      { result: { status: "attached", attachmentIds: [21] } },
    );
    const beforeTrash = await reader.captureOperationState(
      { type: "trash_items", itemIds: [21] },
      context,
    );
    assert.equal(attached.items?.[0]?.attachmentLinkMode, 0);
    assert.deepEqual(beforeTrash.items, attached.items);
  });

  it("credits library_update with creating a child attachment", function () {
    assert.equal(IMPLEMENTED_BY["childAttachment:create"], "library_update");
  });
});
