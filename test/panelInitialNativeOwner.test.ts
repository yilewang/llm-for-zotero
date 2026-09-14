import { assert } from "chai";
import { buildUI } from "../src/modules/contextPanel/buildUI";
import {
  bindEmbeddedPanelHost,
  evaluatePanelOwnership,
} from "../src/modules/contextPanel/panelHostOwnership";
import { createClaudePaperPortalItem } from "../src/claudeCode/portal";
import { createCodexPaperPortalItem } from "../src/codexAppServer/portal";

describe("native paper conversation initial mount", function () {
  for (const [provider, portal] of [
    ["Claude", createClaudePaperPortalItem],
    ["Codex", createCodexPaperPortalItem],
  ] as const) {
    it(`mounts ${provider} under its real paper before the ownership fence runs`, function () {
      const globals = globalThis as any;
      const saved = globals.Zotero;
      const item = {
        id: 3977,
        libraryID: 1,
        isAttachment: () => false,
        isRegularItem: () => true,
        isNote: () => false,
        getAttachments: () => [],
        getField: () => "Current paper",
      } as any;
      const root = { dataset: {}, style: {} } as any;
      const stopAfterIdentity = new Error("Identity boundary reached");
      let elements = 0;
      const doc = {
        defaultView: { HTMLElement: class {} },
        createElementNS: () => {
          if (elements++) throw stopAfterIdentity;
          return root;
        },
      };
      const body = {
        ownerDocument: doc,
        replaceChildren: () => {},
        querySelector: (selector: string) =>
          selector === "#llm-main" ? root : null,
        closest: () => null,
      } as any;
      try {
        globals.Zotero = {
          ...saved,
          Prefs: {
            ...saved?.Prefs,
            get: (key: string, ...args: any[]) =>
              [
                "extensions.zotero.llmforzotero.enableClaudeCodeMode",
                "extensions.zotero.llmforzotero.enableCodexAppServerMode",
              ].includes(key)
                ? true
                : saved?.Prefs?.get(key, ...args),
          },
          Items: { get: (id: number) => (id === 3977 ? item : null) },
        };
        const target = portal(item, 4300745500000026);
        bindEmbeddedPanelHost(body, item, "library");
        try {
          buildUI(body, target);
        } catch (error) {
          assert.strictEqual(error, stopAfterIdentity);
        }
        assert.equal(root.dataset.basePaperItemId, "3977");
        assert.equal(evaluatePanelOwnership(body, target), "match");
      } finally {
        globals.Zotero = saved;
      }
    });
  }
});
