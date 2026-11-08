import { assert } from "chai";
import {
  conversationRepository,
  type ConversationCatalogEntry,
} from "../src/core/conversations/repository";
import {
  isUnifiedHistoryRowListed,
  listUnifiedHistoryEntries,
  mergeUnifiedHistoryCatalogEntries,
  resolveUnifiedHistorySystems,
} from "../src/modules/contextPanel/unifiedHistorySource";
import { getHistoryRowRuntimeLabel } from "../src/modules/contextPanel/setupHandlers/controllers/conversationHistoryController";
import type { ConversationSystem } from "../src/shared/types";

function row(
  system: ConversationSystem,
  conversationKey: number,
  extra: Partial<ConversationCatalogEntry> = {},
): ConversationCatalogEntry {
  return {
    conversationID: `${system}-${conversationKey}`,
    conversationKey,
    system,
    kind: "global",
    libraryID: 1,
    createdAt: 10,
    lastActivityAt: 100,
    title: `Chat ${conversationKey}`,
    userTurnCount: 1,
    ...extra,
  };
}

describe("unifiedHistorySource", function () {
  describe("resolveUnifiedHistorySystems", function () {
    it("lists Agent and the runtimes that are on, in a fixed order", function () {
      assert.deepEqual(
        resolveUnifiedHistorySystems({
          activeSystem: "upstream",
          codexEnabled: true,
          claudeEnabled: true,
          singleSystem: false,
        }),
        ["upstream", "codex", "claude_code"],
      );
      assert.deepEqual(
        resolveUnifiedHistorySystems({
          activeSystem: "upstream",
          codexEnabled: false,
          claudeEnabled: true,
          singleSystem: false,
        }),
        ["upstream", "claude_code"],
        "a runtime turned off in Preferences is hidden",
      );
    });

    it("keeps the panel's own runtime even if it was just turned off", function () {
      assert.deepEqual(
        resolveUnifiedHistorySystems({
          activeSystem: "codex",
          codexEnabled: false,
          claudeEnabled: false,
          singleSystem: false,
        }),
        ["upstream", "codex"],
      );
    });

    it("lists only the panel's runtime in a note session or side chat", function () {
      assert.deepEqual(
        resolveUnifiedHistorySystems({
          activeSystem: "claude_code",
          codexEnabled: true,
          claudeEnabled: true,
          singleSystem: true,
        }),
        ["claude_code"],
      );
    });
  });

  it("names Codex and Claude rows and leaves Agent rows unnamed", function () {
    assert.equal(getHistoryRowRuntimeLabel("codex"), "Codex");
    assert.equal(getHistoryRowRuntimeLabel("claude_code"), "Claude");
    assert.equal(getHistoryRowRuntimeLabel("upstream"), "");
  });

  it("lists empty rows only for the panel's own runtime", function () {
    assert.isTrue(
      isUnifiedHistoryRowListed(
        { system: "upstream", userTurnCount: 0 },
        "upstream",
      ),
    );
    assert.isFalse(
      isUnifiedHistoryRowListed(
        { system: "codex", userTurnCount: 0 },
        "upstream",
      ),
    );
    assert.isTrue(
      isUnifiedHistoryRowListed(
        { system: "codex", userTurnCount: 2 },
        "upstream",
      ),
    );
  });

  describe("mergeUnifiedHistoryCatalogEntries", function () {
    it("merges runtimes newest first and keeps each row's runtime", function () {
      const merged = mergeUnifiedHistoryCatalogEntries(
        [
          {
            system: "upstream",
            rows: [row("upstream", 1, { lastActivityAt: 300 })],
          },
          {
            system: "codex",
            rows: [row("codex", 2, { lastActivityAt: 500 })],
          },
          {
            system: "claude_code",
            rows: [row("claude_code", 3, { lastActivityAt: 400 })],
          },
        ],
        { activeSystem: "upstream", limit: 10 },
      );
      assert.deepEqual(
        merged.map((entry) => [entry.system, entry.conversationKey]),
        [
          ["codex", 2],
          ["claude_code", 3],
          ["upstream", 1],
        ],
      );
    });

    it("drops web chat sessions, other runtimes' drafts, queued deletions and repeats", function () {
      const merged = mergeUnifiedHistoryCatalogEntries(
        [
          {
            system: "upstream",
            rows: [
              row("upstream", 1, { userTurnCount: 0, title: "" }),
              row("upstream", 4, { webchatSession: true }),
              row("upstream", 5),
            ],
          },
          {
            system: "codex",
            rows: [
              row("codex", 2, { userTurnCount: 0, title: "" }),
              row("codex", 6),
              row("codex", 6),
            ],
          },
        ],
        {
          activeSystem: "upstream",
          limit: 10,
          isPendingDeletion: (key) => key === 5,
        },
      );
      assert.deepEqual(
        merged.map((entry) => entry.conversationKey).sort(),
        [1, 6],
        "the active runtime's draft stays; the Codex draft does not",
      );
    });

    it("breaks a tie by the larger key and keeps at most the limit", function () {
      const merged = mergeUnifiedHistoryCatalogEntries(
        [
          {
            system: "upstream",
            rows: [row("upstream", 1), row("upstream", 3)],
          },
          { system: "codex", rows: [row("codex", 2)] },
        ],
        { activeSystem: "upstream", limit: 2 },
      );
      assert.deepEqual(
        merged.map((entry) => entry.conversationKey),
        [3, 2],
      );
    });
  });

  describe("listUnifiedHistoryEntries", function () {
    const original = conversationRepository.listCatalogEntries;
    afterEach(function () {
      conversationRepository.listCatalogEntries = original;
    });

    it("reads each runtime's scope and only the active runtime's drafts", async function () {
      const requests: Array<{
        system: ConversationSystem;
        kind: string;
        paperItemID?: number;
        includeEmpty?: boolean;
      }> = [];
      conversationRepository.listCatalogEntries = async (params) => {
        requests.push({
          system: params.system,
          kind: params.kind,
          paperItemID: params.paperItemID,
          includeEmpty: params.includeEmpty,
        });
        if (params.system === "claude_code") throw new Error("unreadable");
        return [
          row(params.system, params.system === "codex" ? 20 : 10, {
            kind: "paper",
            paperItemID: 7,
          }),
          // Another paper's row the store returned: not this scope.
          row(params.system, params.system === "codex" ? 21 : 11, {
            kind: "paper",
            paperItemID: 8,
          }),
        ];
      };
      const rows = await listUnifiedHistoryEntries({
        libraryID: 1,
        scope: "paper",
        paperItemID: 7,
        systems: ["upstream", "codex", "claude_code"],
        activeSystem: "codex",
        limit: 50,
      });
      assert.deepEqual(
        requests.map((request) => [
          request.system,
          request.kind,
          request.paperItemID,
          request.includeEmpty,
        ]),
        [
          ["upstream", "paper", 7, false],
          ["codex", "paper", 7, true],
          ["claude_code", "paper", 7, false],
        ],
      );
      assert.deepEqual(
        rows.map((entry) => entry.conversationKey).sort(),
        [10, 20],
      );
    });

    it("lists nothing for a paper scope without a paper", async function () {
      let called = false;
      conversationRepository.listCatalogEntries = async () => {
        called = true;
        return [];
      };
      const rows = await listUnifiedHistoryEntries({
        libraryID: 1,
        scope: "paper",
        systems: ["upstream"],
        activeSystem: "upstream",
        limit: 50,
      });
      assert.deepEqual(rows, []);
      assert.isFalse(called);
    });
  });
});
