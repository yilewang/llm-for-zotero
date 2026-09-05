import { assert } from "chai";
import {
  IMPLEMENTED_BY,
  LIBRARY_OBJECT_KINDS,
  LIBRARY_OPERATIONS,
  checkCapability,
  classifyLibraryItem,
  refusalFor,
} from "../src/agent/capabilities/libraryObjects";
import { createBuiltInToolRegistry } from "../src/agent/tools";

/**
 * The point of the matrix is that it is *total*: every (operation x kind)
 * pair has a declared answer, so a capability nobody thought about fails
 * loudly here rather than silently doing nothing in production.
 */
describe("library capability matrix", function () {
  it("declares every operation for every object kind", function () {
    const undeclared: string[] = [];
    for (const kind of LIBRARY_OBJECT_KINDS) {
      for (const operation of LIBRARY_OPERATIONS) {
        if (checkCapability(operation, kind).status === "unmodelled") {
          undeclared.push(`${operation} x ${kind}`);
        }
      }
    }
    assert.deepEqual(
      undeclared,
      [],
      "every cell must be allowed or refused; add the missing ones to MATRIX",
    );
  });

  it("gives every refusal a non-empty, specific reason", function () {
    const vague: string[] = [];
    for (const kind of LIBRARY_OBJECT_KINDS) {
      for (const operation of LIBRARY_OPERATIONS) {
        const verdict = checkCapability(operation, kind);
        if (verdict.status !== "refused") continue;
        if (!verdict.reason || verdict.reason.length < 15) {
          vague.push(`${operation} x ${kind}: "${verdict.reason}"`);
        }
      }
    }
    assert.deepEqual(vague, [], "a refusal the agent cannot act on is a bug");
  });

  /**
   * Totality was the only thing this file used to check, so the table could
   * claim capabilities that no tool implemented — note reparent, item
   * relations, saved-search CRUD, collection rename, tag rename — and nothing
   * caught it. `refusalFor` has one call site reached with three operations,
   * so 82 of the 100 cells are never consulted at runtime.
   */
  describe("an allowed cell means a tool actually does it", function () {
    function registeredToolNames(): Set<string> {
      const registry = createBuiltInToolRegistry({
        zoteroGateway: {} as never,
        pdfService: {} as never,
        pdfPageService: {} as never,
        retrievalService: {} as never,
      });
      const names = new Set<string>();
      for (const spec of registry.listTools()) {
        names.add(spec.name);
      }
      return names;
    }

    it("names the implementing tool for every allowed cell", function () {
      const unbacked: string[] = [];
      for (const kind of LIBRARY_OBJECT_KINDS) {
        for (const operation of LIBRARY_OPERATIONS) {
          if (checkCapability(operation, kind).status !== "allowed") continue;
          if (!IMPLEMENTED_BY[`${kind}:${operation}`]) {
            unbacked.push(`${kind}:${operation}`);
          }
        }
      }
      assert.deepEqual(
        unbacked,
        [],
        "either wire these up and add them to IMPLEMENTED_BY, or mark them unimplemented",
      );
    });

    it("only names tools that are actually registered", function () {
      const registered = registeredToolNames();
      const missing: string[] = [];
      for (const [cell, toolName] of Object.entries(IMPLEMENTED_BY)) {
        if (toolName && !registered.has(toolName)) {
          missing.push(`${cell} -> ${toolName}`);
        }
      }
      assert.deepEqual(
        missing,
        [],
        "IMPLEMENTED_BY names a tool that does not exist",
      );
    });

    it("does not claim an implementation for a cell that is not allowed", function () {
      const contradictory: string[] = [];
      for (const kind of LIBRARY_OBJECT_KINDS) {
        for (const operation of LIBRARY_OPERATIONS) {
          const verdict = checkCapability(operation, kind);
          if (verdict.status === "allowed") continue;
          if (IMPLEMENTED_BY[`${kind}:${operation}`]) {
            contradictory.push(`${kind}:${operation}`);
          }
        }
      }
      assert.deepEqual(contradictory, []);
    });

    it("tells the agent where to go when a capability is not built yet", function () {
      const unhelpful: string[] = [];
      for (const kind of LIBRARY_OBJECT_KINDS) {
        for (const operation of LIBRARY_OPERATIONS) {
          const verdict = checkCapability(operation, kind);
          if (verdict.status !== "unimplemented") continue;
          if (!verdict.reason.includes("zotero_script")) {
            unhelpful.push(`${kind}:${operation}`);
          }
        }
      }
      // "not supported" with no route forward strands the agent; the escape
      // hatch is the whole reason a gap is not a refusal.
      assert.deepEqual(unhelpful, []);
    });

    it("has no capability left declared but unbuilt", function () {
      // Every cell is now either backed by a tool or refused for a stated
      // reason. This is the coverage statement, so it fails loudly the moment
      // a new operation or object kind is added without an implementation.
      const unbuilt: string[] = [];
      for (const kind of LIBRARY_OBJECT_KINDS) {
        for (const operation of LIBRARY_OPERATIONS) {
          if (checkCapability(operation, kind).status === "unimplemented") {
            unbuilt.push(`${kind}:${operation}`);
          }
        }
      }
      assert.deepEqual(unbuilt, []);
    });

    it("keeps unimplemented distinct from refused", function () {
      // Both stop the write, but only one is a permanent answer -- a refusal
      // states a fact about Zotero, an unimplemented cell states a gap here.
      const impossible = checkCapability("addToCollection", "childAttachment");
      assert.equal(impossible.status, "refused");
      assert.include(
        impossible.status === "refused" ? impossible.reason : "",
        "top-level",
      );
    });
  });

  it("reports an undeclared pair as a gap, not as a policy refusal", function () {
    const verdict = checkCapability(
      "reparent" as never,
      "somethingNew" as never,
    );
    assert.equal(verdict.status, "unmodelled");
    assert.include(
      verdict.status === "unmodelled" ? verdict.reason : "",
      "zotero_script",
    );
  });

  describe("the cells issue #374 turned on", function () {
    it("lets a standalone note into a collection", function () {
      assert.equal(
        checkCapability("addToCollection", "standaloneNote").status,
        "allowed",
      );
    });

    it("lets a standalone attachment into a collection", function () {
      assert.equal(
        checkCapability("addToCollection", "standaloneAttachment").status,
        "allowed",
      );
    });

    it("refuses a child attachment with the data-model reason, not a redirect", function () {
      const verdict = checkCapability("addToCollection", "childAttachment");
      assert.equal(verdict.status, "refused");
      assert.include(
        verdict.status === "refused" ? verdict.reason : "",
        "top-level",
        "the old behaviour silently filed the PARENT instead",
      );
    });

    it("allows updating a child attachment, which carries its own tags", function () {
      assert.equal(
        checkCapability("update", "childAttachment").status,
        "allowed",
      );
    });
  });

  describe("classifyLibraryItem", function () {
    const item = (over: Record<string, unknown>) =>
      ({
        isAnnotation: () => false,
        isNote: () => false,
        isAttachment: () => false,
        isRegularItem: () => false,
        ...over,
      }) as never;

    it("splits notes and attachments by whether they are top-level", function () {
      assert.equal(
        classifyLibraryItem(item({ isNote: () => true })),
        "standaloneNote",
      );
      assert.equal(
        classifyLibraryItem(item({ isNote: () => true, parentID: 5 })),
        "childNote",
      );
      assert.equal(
        classifyLibraryItem(item({ isAttachment: () => true })),
        "standaloneAttachment",
      );
      assert.equal(
        classifyLibraryItem(item({ isAttachment: () => true, parentID: 5 })),
        "childAttachment",
      );
    });

    it("checks annotations before attachments, since annotations report a parent", function () {
      assert.equal(
        classifyLibraryItem(
          item({
            isAnnotation: () => true,
            isAttachment: () => true,
            parentID: 9,
          }),
        ),
        "annotation",
      );
    });

    it("returns null rather than guessing when nothing matches", function () {
      assert.isNull(classifyLibraryItem(item({})));
      assert.isNull(classifyLibraryItem(null));
    });
  });

  describe("refusalFor", function () {
    it("distinguishes a missing item from a wrong-kind item", function () {
      assert.include(
        refusalFor("addToCollection", null, 42) || "",
        "No item with ID 42",
      );
      const childNote = {
        isAnnotation: () => false,
        isNote: () => true,
        isAttachment: () => false,
        isRegularItem: () => false,
        parentID: 7,
      } as never;
      const reason = refusalFor("addToCollection", childNote, 8) || "";
      assert.include(reason, "top-level");
      assert.notInclude(
        reason,
        "not found",
        "the item exists; saying otherwise is a lie",
      );
    });

    it("returns null when the operation is allowed", function () {
      const note = {
        isAnnotation: () => false,
        isNote: () => true,
        isAttachment: () => false,
        isRegularItem: () => false,
      } as never;
      assert.isNull(refusalFor("addToCollection", note, 8));
    });
  });
});
