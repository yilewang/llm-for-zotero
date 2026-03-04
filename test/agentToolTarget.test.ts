import { assert } from "chai";
import { resolveAgentToolTarget } from "../src/modules/contextPanel/Agent/ToolInfra/resolveTarget";
import type {
  AgentToolExecutionContext,
  AgentToolTarget,
} from "../src/modules/contextPanel/Agent/ToolInfra/types";
import type { PaperContextRef } from "../src/modules/contextPanel/types";

describe("agentToolTarget", function () {
  const originalZotero = globalThis.Zotero;

  const activePaper: PaperContextRef = {
    itemId: 10,
    contextItemId: 101,
    title: "Active Paper",
    firstCreator: "Kim",
    year: "2025",
  };
  const selectedPaper: PaperContextRef = {
    itemId: 11,
    contextItemId: 111,
    title: "Selected Paper",
    attachmentTitle: "Appendix PDF",
  };
  const pinnedPaper: PaperContextRef = {
    itemId: 12,
    contextItemId: 121,
    title: "Pinned Paper",
  };
  const recentPaper: PaperContextRef = {
    itemId: 13,
    contextItemId: 131,
    title: "Recent Paper",
  };
  const retrievedPaper: PaperContextRef = {
    itemId: 14,
    contextItemId: 141,
    title: "Retrieved Paper",
  };

  beforeEach(function () {
    const items = new Map<number, any>([
      [
        101,
        {
          id: 101,
          isAttachment: () => true,
          attachmentContentType: "application/pdf",
        },
      ],
      [
        111,
        {
          id: 111,
          isAttachment: () => true,
          attachmentContentType: "application/pdf",
        },
      ],
      [
        121,
        {
          id: 121,
          isAttachment: () => true,
          attachmentContentType: "application/pdf",
        },
      ],
      [
        131,
        {
          id: 131,
          isAttachment: () => true,
          attachmentContentType: "application/pdf",
        },
      ],
      [
        141,
        {
          id: 141,
          isAttachment: () => true,
          attachmentContentType: "application/pdf",
        },
      ],
    ]);
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Items: {
        get: (id: number) => items.get(id) || null,
      },
    } as typeof Zotero;
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  function buildContext(): AgentToolExecutionContext {
    return {
      question: "read full paper",
      libraryID: 5,
      panelItemId: 0,
      conversationMode: "open",
      activePaperContext: activePaper,
      selectedPaperContexts: [selectedPaper],
      pinnedPaperContexts: [pinnedPaper],
      recentPaperContexts: [recentPaper],
      retrievedPaperContexts: [retrievedPaper],
    };
  }

  function expectResolved(target: AgentToolTarget, expectedTitle: string) {
    const resolved = resolveAgentToolTarget(buildContext(), target);
    assert.equal(resolved.paperContext?.title, expectedTitle);
    assert.isNotNull(resolved.contextItem);
  }

  it("resolves active paper targets", function () {
    expectResolved({ scope: "active-paper" }, "Active Paper");
  });

  it("resolves selected, pinned, recent, and retrieved paper targets", function () {
    expectResolved({ scope: "selected-paper", index: 1 }, "Selected Paper");
    expectResolved({ scope: "pinned-paper", index: 1 }, "Pinned Paper");
    expectResolved({ scope: "recent-paper", index: 1 }, "Recent Paper");
    expectResolved({ scope: "retrieved-paper", index: 1 }, "Retrieved Paper");
    const resolved = resolveAgentToolTarget(buildContext(), {
      scope: "selected-paper",
      index: 1,
    });
    assert.include(resolved.targetLabel, "Attachment: Appendix PDF");
  });

  it("returns a structured invalid result for out-of-range targets", function () {
    const resolved = resolveAgentToolTarget(buildContext(), {
      scope: "retrieved-paper",
      index: 2,
    });
    assert.isNull(resolved.paperContext);
    assert.include(resolved.error || "", "Target was unavailable");
  });
});
