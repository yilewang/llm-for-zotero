/// <reference types="zotero-types" />

import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import {
  buildClaudeProfileSignature,
  getClaudeRuntimeRootDir,
} from "../src/claudeCode/projectSkills";
import { buildDefaultClaudeGlobalConversationKey } from "../src/claudeCode/constants";
import { buildClaudeScope } from "../src/claudeCode/runtime";
import {
  getLastAllocatedClaudeGlobalConversationKey,
  getLastUsedClaudeGlobalConversationKey,
  setLastAllocatedClaudeGlobalConversationKey,
  setLastUsedClaudeGlobalConversationKey,
} from "../src/claudeCode/prefs";

describe("Claude profile-aware identity", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;

  afterEach(function () {
    globalScope.Zotero = originalZotero;
  });

  it("derives distinct profile signatures from distinct profile dirs", function () {
    const a = buildClaudeProfileSignature("/profiles/a");
    const b = buildClaudeProfileSignature("/profiles/b");

    assert.notEqual(a, b);
    assert.match(a, /^profile-[a-f0-9]+$/);
    assert.match(b, /^profile-[a-f0-9]+$/);
  });

  it("uses Zotero data directory as the Claude runtime root when available", function () {
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DataDirectory: { dir: "/zotero-data" },
      Profile: { dir: "/profiles/main" },
    };

    const profileSignature = buildClaudeProfileSignature("/profiles/main");
    const runtimeRoot = getClaudeRuntimeRootDir();
    const paperScope = buildClaudeScope({
      libraryID: 7,
      kind: "paper",
      paperItemID: 42,
      paperTitle: "Paper",
    });

    assert.equal(
      runtimeRoot,
      `/zotero-data/agent-runtime/${profileSignature}`,
    );
    assert.equal(paperScope.scopeId, `${profileSignature}:7:42`);
  });

  it("keeps the home-based Claude runtime root fallback without a data directory", function () {
    const originalHome = process.env.HOME;
    try {
      process.env.HOME = "/home/claude-user";
      globalScope.Zotero = {
        ...(originalZotero || {}),
        DataDirectory: { dir: "" },
        Profile: { dir: "/profiles/main" },
      };

      const profileSignature = buildClaudeProfileSignature("/profiles/main");
      const runtimeRoot = getClaudeRuntimeRootDir();

      assert.equal(
        runtimeRoot,
        `/home/claude-user/Zotero/agent-runtime/${profileSignature}`,
      );
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it("uses the profile signature in runtime roots and scope ids", function () {
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Profile: { dir: "/profiles/main" },
    };

    const profileSignature = buildClaudeProfileSignature("/profiles/main");
    const runtimeRoot = getClaudeRuntimeRootDir();
    const paperScope = buildClaudeScope({
      libraryID: 7,
      kind: "paper",
      paperItemID: 42,
      paperTitle: "Paper",
    });
    const openScope = buildClaudeScope({
      libraryID: 7,
      kind: "global",
    });

    assert.include(runtimeRoot, `/Zotero/agent-runtime/${profileSignature}`);
    assert.equal(paperScope.scopeId, `${profileSignature}:7:42`);
    assert.equal(openScope.scopeId, `${profileSignature}:7`);
  });

  it("keeps remembered Claude global conversations separate across profiles", function () {
    const prefStore = new Map<string, unknown>();
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Prefs: {
        get: (key: string) =>
          prefStore.get(key) as string | number | boolean | undefined,
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      } as unknown as typeof Zotero.Prefs,
      Profile: { dir: "/profiles/a" },
    };

    setLastUsedClaudeGlobalConversationKey(1, 1111);
    assert.equal(getLastUsedClaudeGlobalConversationKey(1), 1111);

    globalScope.Zotero = {
      ...(originalZotero || {}),
      Prefs: {
        get: (key: string) =>
          prefStore.get(key) as string | number | boolean | undefined,
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      } as unknown as typeof Zotero.Prefs,
      Profile: { dir: "/profiles/b" },
    };

    assert.isNull(getLastUsedClaudeGlobalConversationKey(1));
    setLastUsedClaudeGlobalConversationKey(1, 2222);
    assert.equal(getLastUsedClaudeGlobalConversationKey(1), 2222);

    globalScope.Zotero = {
      ...(originalZotero || {}),
      Prefs: {
        get: (key: string) =>
          prefStore.get(key) as string | number | boolean | undefined,
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      } as unknown as typeof Zotero.Prefs,
      Profile: { dir: "/profiles/a" },
    };

    assert.equal(getLastUsedClaudeGlobalConversationKey(1), 1111);
  });

  it("keeps last allocated Claude keys separate across profiles", function () {
    const prefStore = new Map<string, unknown>();
    const setMockProfile = (dir: string) => {
      globalScope.Zotero = {
        ...(originalZotero || {}),
        Prefs: {
          get: (key: string) =>
            prefStore.get(key) as string | number | boolean | undefined,
          set: (key: string, value: unknown) => {
            prefStore.set(key, value);
          },
        } as unknown as typeof Zotero.Prefs,
        Profile: { dir },
      };
    };

    setMockProfile("/profiles/a");
    const profileAKey = buildDefaultClaudeGlobalConversationKey(1) + 10;
    setLastAllocatedClaudeGlobalConversationKey(profileAKey);
    assert.equal(getLastAllocatedClaudeGlobalConversationKey(), profileAKey);

    setMockProfile("/profiles/b");
    assert.isNull(getLastAllocatedClaudeGlobalConversationKey());
    const profileBKey = buildDefaultClaudeGlobalConversationKey(1) + 20;
    setLastAllocatedClaudeGlobalConversationKey(profileBKey);
    assert.equal(getLastAllocatedClaudeGlobalConversationKey(), profileBKey);

    setMockProfile("/profiles/a");
    assert.equal(getLastAllocatedClaudeGlobalConversationKey(), profileAKey);
  });
});
