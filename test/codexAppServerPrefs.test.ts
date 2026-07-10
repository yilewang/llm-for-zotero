import { assert } from "chai";
import {
  getCodexAppServerApprovalsReviewerPref,
  getCodexReasoningModePref,
  getCodexRuntimeModelPref,
  isCodexZoteroMcpToolsEnabled,
  isCodexAppServerNativeApprovalsEnabled,
  isNativeZoteroMcpToolsEnabled,
  setCodexAppServerApprovalsReviewerPref,
  setCodexAppServerNativeApprovalsEnabled,
  setCodexReasoningModePref,
  setCodexRuntimeModelPref,
  setNativeZoteroMcpToolsEnabled,
} from "../src/codexAppServer/prefs";

describe("codexAppServer prefs", function () {
  it("allows arbitrary non-empty Codex app-server model names", function () {
    const globalScope = globalThis as typeof globalThis & {
      Zotero?: unknown;
    };
    const originalZotero = globalScope.Zotero;
    const prefs = new Map<string, unknown>();
    try {
      globalScope.Zotero = {
        Prefs: {
          get: (key: string) => prefs.get(key),
          set: (key: string, value: unknown) => {
            prefs.set(key, value);
          },
        },
      };

      setCodexRuntimeModelPref("gpt-5.5-codex-preview");

      assert.equal(getCodexRuntimeModelPref(), "gpt-5.5-codex-preview");
    } finally {
      if (originalZotero) {
        globalScope.Zotero = originalZotero;
      } else {
        delete globalScope.Zotero;
      }
    }
  });

  it("allows catalog-advertised Codex reasoning effort names", function () {
    const globalScope = globalThis as typeof globalThis & {
      Zotero?: unknown;
    };
    const originalZotero = globalScope.Zotero;
    const prefs = new Map<string, unknown>();
    try {
      globalScope.Zotero = {
        Prefs: {
          get: (key: string) => prefs.get(key),
          set: (key: string, value: unknown) => {
            prefs.set(key, value);
          },
        },
      };

      for (const mode of ["max", "ultra", "future-effort"]) {
        setCodexReasoningModePref(mode);
        assert.equal(getCodexReasoningModePref(), mode);
      }

      setCodexReasoningModePref("");
      assert.equal(getCodexReasoningModePref(), "auto");
    } finally {
      if (originalZotero) {
        globalScope.Zotero = originalZotero;
      } else {
        delete globalScope.Zotero;
      }
    }
  });

  it("enables Zotero MCP tools for native Codex by default", function () {
    const globalScope = globalThis as typeof globalThis & {
      Zotero?: unknown;
    };
    const originalZotero = globalScope.Zotero;
    try {
      globalScope.Zotero = {
        Prefs: {
          get: () => undefined,
        },
      };

      assert.equal(isCodexZoteroMcpToolsEnabled(), true);
      assert.equal(isNativeZoteroMcpToolsEnabled(), true);
    } finally {
      if (originalZotero) {
        globalScope.Zotero = originalZotero;
      } else {
        delete globalScope.Zotero;
      }
    }
  });

  it("keeps native Codex built-in approvals disabled with user review by default", function () {
    const globalScope = globalThis as typeof globalThis & {
      Zotero?: unknown;
    };
    const originalZotero = globalScope.Zotero;
    try {
      globalScope.Zotero = {
        Prefs: {
          get: () => undefined,
        },
      };

      assert.equal(isCodexAppServerNativeApprovalsEnabled(), false);
      assert.equal(getCodexAppServerApprovalsReviewerPref(), "user");
    } finally {
      if (originalZotero) {
        globalScope.Zotero = originalZotero;
      } else {
        delete globalScope.Zotero;
      }
    }
  });

  it("persists native Codex approval bridge and reviewer preferences", function () {
    const globalScope = globalThis as typeof globalThis & {
      Zotero?: unknown;
    };
    const originalZotero = globalScope.Zotero;
    const prefs = new Map<string, unknown>();
    try {
      globalScope.Zotero = {
        Prefs: {
          get: (key: string) => prefs.get(key),
          set: (key: string, value: unknown) => {
            prefs.set(key, value);
          },
        },
      };

      setCodexAppServerNativeApprovalsEnabled(true);
      setCodexAppServerApprovalsReviewerPref("auto_review");

      assert.equal(isCodexAppServerNativeApprovalsEnabled(), true);
      assert.equal(getCodexAppServerApprovalsReviewerPref(), "auto_review");
      assert.equal(
        prefs.get(
          "extensions.zotero.llmforzotero.codexAppServerNativeApprovalsEnabled",
        ),
        true,
      );
      assert.equal(
        prefs.get(
          "extensions.zotero.llmforzotero.codexAppServerApprovalsReviewer",
        ),
        "auto_review",
      );

      setCodexAppServerApprovalsReviewerPref("guardian_subagent" as never);
      assert.equal(getCodexAppServerApprovalsReviewerPref(), "auto_review");
    } finally {
      if (originalZotero) {
        globalScope.Zotero = originalZotero;
      } else {
        delete globalScope.Zotero;
      }
    }
  });

  it("keeps native Zotero MCP pref aliases on the legacy storage key", function () {
    const globalScope = globalThis as typeof globalThis & {
      Zotero?: unknown;
    };
    const originalZotero = globalScope.Zotero;
    const prefs = new Map<string, unknown>();
    try {
      globalScope.Zotero = {
        Prefs: {
          get: (key: string) => prefs.get(key),
          set: (key: string, value: unknown) => {
            prefs.set(key, value);
          },
        },
      };

      setNativeZoteroMcpToolsEnabled(false);

      assert.equal(isNativeZoteroMcpToolsEnabled(), false);
      assert.equal(isCodexZoteroMcpToolsEnabled(), false);
      assert.equal(
        prefs.get(
          "extensions.zotero.llmforzotero.codexAppServerZoteroMcpToolsEnabled",
        ),
        false,
      );
    } finally {
      if (originalZotero) {
        globalScope.Zotero = originalZotero;
      } else {
        delete globalScope.Zotero;
      }
    }
  });
});
