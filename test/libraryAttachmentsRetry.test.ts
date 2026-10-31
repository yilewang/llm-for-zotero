import { assert } from "chai";
import { AttachmentCapability } from "../src/agent/services/zotero/attachmentCapability";
import { attachmentImportExecutors } from "../src/agent/services/libraryMutation/attachmentImportExecutors";
import { libraryMutationHandlers } from "../src/agent/services/libraryMutation/handlerRegistry";
import { mutationPostconditionIsSatisfied } from "../src/agent/services/libraryMutation/handlerOperations";
import { MutationNoEffectError } from "../src/agent/services/externalMutationCoordinator";
import { planLibraryMutations } from "../src/agent/tools/write/mutateLibraryShared";
import { authorizeOriginalAction } from "../src/agent/authorization/policy";
import { formatReceiptStatus } from "../src/agent/contracts/actionEvaluation";
import { createEmptyExecutionCheckpoint } from "../src/agent/execution/checkpoint";
import {
  applyOutcomeEvidence,
  declareOutcomes,
} from "../src/agent/loop/outcomes";
import {
  buildAgentActionSummaryCard,
  type ActionCardResolvers,
} from "../src/modules/contextPanel/agentTrace/actionCardModel";
import type { AgentActionReceipt } from "../src/agent/contracts/types";
import type { LibraryMutationOperation } from "../src/agent/services/libraryMutation/contracts";
import type {
  AgentExecutionContext,
  AgentRunEventRecord,
} from "../src/agent/types";

/**
 * The W5-C review fixes: a PDF search that finds nothing is an answer, not
 * work already done; a web-page attach and Find Available PDF name their
 * network fetch; and an attach never makes a second copy on a retry.
 */
describe("W5-C review: found nothing, the fetch, and retries", function () {
  type FakeItem = {
    id: number;
    key: string;
    deleted: boolean;
    attachmentLinkMode: number;
    attachmentContentType: string;
    attachmentFilename?: string;
    url?: string;
    path?: string;
    erased?: number;
    eraseTx: () => Promise<void>;
    getField: (field: string) => string;
    isFileAttachment: () => boolean;
    getFilePath: () => string | false;
  };

  const original = {
    Zotero: (globalThis as { Zotero?: unknown }).Zotero,
    IOUtils: (globalThis as { IOUtils?: unknown }).IOUtils,
  };
  afterEach(function () {
    (globalThis as { Zotero?: unknown }).Zotero = original.Zotero;
    (globalThis as { IOUtils?: unknown }).IOUtils = original.IOUtils;
  });

  let nextId = 100;
  function attachment(
    linkMode: number,
    fields: Partial<FakeItem> = {},
  ): FakeItem {
    const id = nextId++;
    const item: FakeItem = {
      id,
      key: `KEY${id}`,
      deleted: false,
      attachmentLinkMode: linkMode,
      attachmentContentType: linkMode === 3 ? "" : "text/html",
      erased: 0,
      eraseTx: async () => {
        item.erased = (item.erased || 0) + 1;
      },
      getField: (field) =>
        field === "url" ? item.url || "" : field === "title" ? `A${id}` : "",
      isFileAttachment: () => linkMode !== 3,
      getFilePath: () => item.path || false,
      ...fields,
    };
    return item;
  }

  /** A Zotero whose item 10 holds `children`, with each call recorded. */
  function install(
    children: FakeItem[],
    overrides: {
      linkFromURL?: () => Promise<FakeItem>;
      allowsLinkedFiles?: boolean;
      sizes?: Record<string, number>;
    } = {},
  ) {
    const calls: string[] = [];
    const byId = new Map(children.map((item) => [item.id, item]));
    const parent = {
      id: 10,
      libraryID: 1,
      getAttachments: () => children.map((item) => item.id),
    };
    (globalThis as { Zotero?: unknown }).Zotero = {
      Items: {
        get: (ids: number[]) => ids.map((id) => byId.get(id)),
      },
      Libraries: {
        get: () => ({ allowsLinkedFiles: overrides.allowsLinkedFiles ?? true }),
      },
      File: { getValidFileName: (name: string) => name },
      Attachments: {
        importFromURL: async (options: { url: string }) => {
          calls.push(`importFromURL ${options.url}`);
          return attachment(1, { url: options.url });
        },
        linkFromURL:
          overrides.linkFromURL ||
          (async (options: { url: string }) => {
            calls.push(`linkFromURL ${options.url}`);
            return attachment(3, { url: options.url });
          }),
        importFromFile: async (options: { file: string }) => {
          calls.push(`importFromFile ${options.file}`);
          return attachment(0, { path: options.file });
        },
        linkFromFile: async (options: { file: string }) => {
          calls.push(`linkFromFile ${options.file}`);
          return attachment(2, { path: options.file });
        },
      },
    };
    (globalThis as { IOUtils?: unknown }).IOUtils = {
      stat: async (path: string) => ({
        type: path.endsWith("/") ? "directory" : "regular",
        size: overrides.sizes?.[path] ?? 1000,
      }),
    };
    const capability = new AttachmentCapability({
      getItem: (id) => (id === 10 ? (parent as never) : null),
      resolveBibliographicItem: () => null,
    });
    return { calls, capability };
  }

  const PAGE = "https://example.org/paper";

  describe("attach_url reuses what the item already has (M4, L2)", function () {
    it("adds only the link after a crash left the snapshot", async function () {
      const snapshot = attachment(1, { url: PAGE });
      const { calls, capability } = install([snapshot]);
      const saved = await capability.attachUrl({
        parentItemId: 10,
        libraryID: 1,
        url: PAGE,
      });
      if (saved.status === "failed") assert.fail(saved.reason);
      assert.deepEqual(calls, [`linkFromURL ${PAGE}`]);
      assert.equal(saved.status, "attached");
      assert.lengthOf(saved.createdIds, 1);
      assert.include(
        saved.attachments.map((entry) => entry.attachmentId),
        snapshot.id,
      );
    });

    it("adds nothing on an exact repeat, and matches a host-only address with or without its slash", async function () {
      const link = attachment(3, { url: "https://example.org/" });
      const snapshot = attachment(1, { url: "https://example.org" });
      const { calls, capability } = install([link, snapshot]);
      const saved = await capability.attachUrl({
        parentItemId: 10,
        libraryID: 1,
        url: "https://example.org",
      });
      if (saved.status === "failed") assert.fail(saved.reason);
      assert.deepEqual(calls, []);
      assert.equal(saved.status, "already_attached");
      assert.deepEqual(saved.createdIds, []);
      assert.deepEqual(
        saved.attachments.map((entry) => entry.attachmentId),
        [link.id, snapshot.id],
      );
    });

    it("attaches a different address normally", async function () {
      const { calls, capability } = install([
        attachment(3, { url: PAGE }),
        attachment(1, { url: PAGE }),
      ]);
      const other = "https://example.org/other";
      const saved = await capability.attachUrl({
        parentItemId: 10,
        libraryID: 1,
        url: other,
      });
      if (saved.status === "failed") assert.fail(saved.reason);
      assert.deepEqual(calls, [
        `importFromURL ${other}`,
        `linkFromURL ${other}`,
      ]);
      assert.lengthOf(saved.createdIds, 2);
    });

    it("ignores a trashed link or snapshot of the address", async function () {
      const { calls, capability } = install([
        attachment(3, { url: PAGE, deleted: true }),
        attachment(1, { url: PAGE, deleted: true }),
      ]);
      await capability.attachUrl({ parentItemId: 10, libraryID: 1, url: PAGE });
      assert.lengthOf(calls, 2);
    });

    it("compares the link's address in one spelling in its postcondition", function () {
      const state = {
        version: 1 as const,
        operation: "attach_url" as const,
        items: [
          {
            itemId: 1,
            exists: true,
            deleted: false,
            parentItemId: 10,
            attachmentLinkMode: 3,
            attachmentUrl: "https://example.org/",
          },
          {
            itemId: 2,
            exists: true,
            deleted: false,
            parentItemId: 10,
            attachmentLinkMode: 1,
          },
        ],
      };
      assert.isTrue(
        mutationPostconditionIsSatisfied(
          { type: "attach_url", parentItemId: 10, url: "https://example.org" },
          state,
        ),
      );
    });

    it("trashes on undo only what the call made, and reports a repeat as no effect", async function () {
      const gateway = (saved: unknown) =>
        ({
          getItem: () => ({
            id: 10,
            libraryID: 1,
            isRegularItem: () => true,
            deleted: false,
          }),
          attachUrl: async () => saved,
        }) as never;
      const attachments = [
        {
          attachmentId: 31,
          title: "",
          linkMode: "linked_url",
          contentType: "",
        },
        {
          attachmentId: 32,
          title: "",
          linkMode: "imported_url",
          contentType: "text/html",
        },
      ];
      const operation = {
        type: "attach_url" as const,
        parentItemId: 10,
        url: PAGE,
      };
      const retried = await attachmentImportExecutors.attach_url(
        operation,
        { request: { libraryID: 1 } } as never,
        gateway({ status: "attached", attachments, createdIds: [31] }),
      );
      assert.deepEqual(retried.inverse?.inverseOperations, [
        { type: "trash_items", itemIds: [31] },
      ]);
      assert.deepEqual(
        (retried.result.result as { reusedAttachmentIds: number[] })
          .reusedAttachmentIds,
        [32],
      );
      const repeated = await attachmentImportExecutors.attach_url(
        operation,
        { request: { libraryID: 1 } } as never,
        gateway({ status: "already_attached", attachments, createdIds: [] }),
      );
      assert.notOk(repeated.inverse);
      assert.equal(
        libraryMutationHandlers.attach_url.affectedCount(
          operation,
          repeated.result.result,
        ),
        0,
      );
    });
  });

  describe("attach_url rollback when the link fails (L1)", function () {
    it("erases the snapshot it made, once, and nothing else", async function () {
      const kept = attachment(1, { url: "https://example.org/kept" });
      let made: FakeItem | undefined;
      const { capability } = install([kept], {
        linkFromURL: async () => {
          throw new Error("link refused");
        },
      });
      const zotero = (globalThis as { Zotero: any }).Zotero;
      const importFromURL = zotero.Attachments.importFromURL;
      zotero.Attachments.importFromURL = async (options: never) =>
        (made = await importFromURL(options));
      const saved = await capability.attachUrl({
        parentItemId: 10,
        libraryID: 1,
        url: PAGE,
      });
      assert.deepEqual(saved, { status: "failed", reason: "link refused" });
      assert.equal(made?.erased, 1);
      assert.equal(kept.erased, 0);
    });

    it("names the snapshot it could not erase", async function () {
      const { capability } = install([], {
        linkFromURL: async () => {
          throw new Error("link refused");
        },
      });
      const zotero = (globalThis as { Zotero: any }).Zotero;
      zotero.Attachments.importFromURL = async () =>
        attachment(1, {
          id: 77,
          key: "SNAP7777",
          url: PAGE,
          eraseTx: async () => {
            throw new Error("database locked");
          },
        });
      let message = "";
      try {
        await capability.attachUrl({
          parentItemId: 10,
          libraryID: 1,
          url: PAGE,
        });
      } catch (error) {
        message = String((error as Error).message);
      }
      assert.include(message, "attachment 77");
      assert.include(message, "key SNAP7777");
      assert.include(message, "database locked");
    });

    it("does not erase a snapshot the item already had", async function () {
      const kept = attachment(1, { url: PAGE });
      const { capability } = install([kept], {
        linkFromURL: async () => {
          throw new Error("link refused");
        },
      });
      const saved = await capability.attachUrl({
        parentItemId: 10,
        libraryID: 1,
        url: PAGE,
      });
      assert.equal(saved.status, "failed");
      assert.equal(kept.erased, 0);
    });
  });

  describe("attach_file (M3, M4, L4)", function () {
    it("refuses a link in a library that does not allow linked files, before any write", async function () {
      const { calls, capability } = install([], { allowsLinkedFiles: false });
      const attached = await capability.attachFile({
        parentItemId: 10,
        filePath: "/tmp/paper.pdf",
        link: true,
      });
      assert.equal(attached.status, "refused");
      assert.deepEqual(calls, []);
    });

    it("turns that refusal into no effect", async function () {
      let error: unknown;
      try {
        await attachmentImportExecutors.attach_file(
          {
            type: "attach_file",
            parentItemId: 10,
            filePath: "/tmp/paper.pdf",
            link: true,
          },
          { request: { libraryID: 1 } } as never,
          {
            getItem: () => ({
              id: 10,
              libraryID: 1,
              isRegularItem: () => true,
              deleted: false,
            }),
            attachFile: async () => ({
              status: "refused",
              reason: "This library does not allow linked files.",
            }),
          } as never,
        );
      } catch (caught) {
        error = caught;
      }
      assert.instanceOf(error, MutationNoEffectError);
    });

    it("refuses a directory with no effect", async function () {
      install([]);
      let error: unknown;
      try {
        await attachmentImportExecutors.attach_file(
          { type: "attach_file", parentItemId: 10, filePath: "/tmp/folder/" },
          { request: { libraryID: 1 } } as never,
          {
            getItem: () => ({
              id: 10,
              libraryID: 1,
              isRegularItem: () => true,
              deleted: false,
            }),
          } as never,
        );
      } catch (caught) {
        error = caught;
      }
      assert.instanceOf(error, MutationNoEffectError);
      assert.include(String((error as Error).message), "not a file");
    });

    it("reuses a link to the same path, and a stored copy with the same name and size", async function () {
      const link = attachment(2, { path: "/tmp/paper.pdf" });
      const copy = attachment(0, {
        attachmentFilename: "paper.pdf",
        path: "/storage/KEY/paper.pdf",
      });
      const { calls, capability } = install([link, copy], {
        sizes: { "/tmp/paper.pdf": 1000, "/storage/KEY/paper.pdf": 1000 },
      });
      for (const linked of [true, false]) {
        const attached = await capability.attachFile({
          parentItemId: 10,
          filePath: "/tmp/paper.pdf",
          link: linked,
        });
        assert.equal(attached.status, "already_attached");
        if (attached.status === "refused") return;
        assert.equal(
          attached.attachment.attachmentId,
          linked ? link.id : copy.id,
        );
      }
      assert.deepEqual(calls, []);
    });

    it("stores a second file of the same name when its size differs", async function () {
      const copy = attachment(0, {
        attachmentFilename: "paper.pdf",
        path: "/storage/KEY/paper.pdf",
      });
      const { calls, capability } = install([copy], {
        sizes: { "/tmp/paper.pdf": 2000, "/storage/KEY/paper.pdf": 1000 },
      });
      const attached = await capability.attachFile({
        parentItemId: 10,
        filePath: "/tmp/paper.pdf",
      });
      assert.equal(attached.status, "attached");
      assert.deepEqual(calls, ["importFromFile /tmp/paper.pdf"]);
    });
  });

  describe("the network fetch is named (M2)", function () {
    const service = {
      planOperation: async () => ({
        effect: "write",
        reversibility: "partial",
        description: "",
      }),
    } as never;
    const plan = (operation: LibraryMutationOperation) =>
      planLibraryMutations(service, [operation], {} as never);

    it("plans the network domain and the address for a web page and a PDF search, and not for a local file", async function () {
      const page = await plan({
        type: "attach_url",
        parentItemId: 10,
        url: PAGE,
      });
      assert.deepEqual(page.domains, ["zotero_library", "network"]);
      assert.include(page.targets, `url:${PAGE}`);
      assert.include(page.targets, "parentItemId:10");
      const search = await plan({ type: "find_pdf", itemId: 10 });
      assert.deepEqual(search.domains, ["zotero_library", "network"]);
      const file = await plan({
        type: "attach_file",
        parentItemId: 10,
        filePath: "/tmp/paper.pdf",
      });
      assert.deepEqual(file.domains, ["zotero_library"]);
    });

    it("authorizes the same way with the network domain as without it", async function () {
      const page = await plan({
        type: "attach_url",
        parentItemId: 10,
        url: PAGE,
      });
      const executionContext = { chatLibraryID: 1 } as AgentExecutionContext;
      const proposal = (domains: string[]) =>
        ({
          domains,
          effects: page.effects,
          riskSignals: [],
          reversibility: page.reversibility,
          invocationPlan: { ...page, domains },
        }) as never;
      for (const mode of ["auto", "safe", "yolo"] as const)
        assert.deepEqual(
          authorizeOriginalAction(proposal(page.domains), {
            mode,
            executionContext,
          }),
          authorizeOriginalAction(proposal(["zotero_library"]), {
            mode,
            executionContext,
          }),
          mode,
        );
    });

    it("shows the address on the action card row, and names the PDF lookup", function () {
      const resolvers: ActionCardResolvers = {
        itemLabel: (id) => ({ label: `Item ${id}`, libraryID: 1 }),
        collectionLabel: () => undefined,
        noteLabel: () => undefined,
        materialTitle: () => undefined,
      };
      const row = (operation: string, parameters: Record<string, unknown>) =>
        buildAgentActionSummaryCard(
          [
            {
              id: "e1",
              sequence: 1,
              timestamp: 1,
              payload: {
                type: "tool_result",
                callId: "c1",
                name: "library_update",
                ok: true,
                content: {},
                actionReceipts: [
                  {
                    ...observedNothing(),
                    status: "applied",
                    operation,
                    appliedTargets: ["item:10"],
                    rejectedTargets: [],
                    reasons: [],
                    normalizedParameters: parameters,
                  },
                ],
              },
            } as unknown as AgentRunEventRecord,
          ],
          resolvers,
        )!.entries[0].effects[0].objects;
      assert.deepEqual(row("attach_url", { targetItemId: 10, url: PAGE }), [
        { kind: "field", label: PAGE },
      ]);
      assert.deepEqual(row("find_pdf", { targetItemId: 10 }), [
        { kind: "field", label: "Find Available PDF (online)" },
      ]);
    });
  });

  /** The receipt a find_pdf that found nothing mints. */
  function observedNothing(): AgentActionReceipt {
    return {
      version: 2,
      id: "find_pdf:10",
      proposalId: "find_pdf:10",
      proofDomain: "zotero_state",
      capability: "zotero.attachments",
      operation: "find_pdf",
      verification: "verified",
      status: "observed",
      requestedTargets: ["item:10"],
      appliedTargets: [],
      alreadySatisfiedTargets: [],
      rejectedTargets: ["item:10"],
      reasons: ["No change: No PDF found online."],
      verifiedFacts: [],
    };
  }

  describe("a search that found nothing (M1)", function () {
    it("says found nothing in the status line the model reads", function () {
      assert.equal(
        formatReceiptStatus([observedNothing()]),
        "[Action status: find_pdf — observed 0/1; No change: No PDF found online.; Verified; proof:zotero_state]",
      );
    });

    it("does not count the item as done in the outcome ledger", function () {
      const executionContext = {
        version: 1,
        executionId: "execution-w5c",
        conversationKey: 1,
        conversationGeneration: 0,
        chatLibraryID: 1,
        permissionOwner: "original_agent",
        workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
        configuredAccess: { libraryIDs: [1], outputDirectories: [] },
      } as AgentExecutionContext;
      const ledger = declareOutcomes(
        createEmptyExecutionCheckpoint(executionContext, 1),
        [
          {
            taskId: "pdfs",
            description: "Find the PDF of the paper",
            effect: "mutation",
            capability: "zotero.attachments",
            targets: ["item:10"],
          },
        ],
        2,
      );
      const { checkpoint } = applyOutcomeEvidence(
        ledger,
        { kind: "receipt", receipt: observedNothing() },
        3,
      );
      const task = checkpoint.tasks[0];
      assert.notEqual(task.status, "completed");
      assert.notInclude(task.doneTargets || [], "item:10");
      assert.equal(task.status, "skipped");
      assert.include(String(task.reason), "No PDF found online");
    });
  });
});
