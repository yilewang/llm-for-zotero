import { readFileSync } from "node:fs";
import { assert } from "chai";
import { after, beforeEach, describe, it } from "mocha";
import {
  buildPermissionAccessibleLabel,
  getOriginalPermissionOptions,
} from "../src/shared/permissionOptions";
import { buildClaudePermissionOption } from "../src/shared/permissionOptions";
import { resolvePermissionSurface } from "../src/modules/contextPanel/footerPermissionControl";
import {
  getClaudePermissionModePref,
  setClaudePermissionModePref,
} from "../src/claudeCode/prefs";
import {
  getCodexPermissionStatePref,
  readCodexPermissionStatePref,
  setCodexPermissionStatePref,
} from "../src/codexAppServer/prefs";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import { getOriginalAgentPermissionModeDescription } from "../src/shared/originalAgentPermissionMode";
import {
  migrateClaudePermissionMode,
  migrateCodexPermissionState,
  migrateOriginalAgentPermissionMode,
} from "../src/utils/migrations";
import {
  fetchClaudePermissionModeCatalog,
  reconcileClaudePermissionMode,
} from "../src/claudeCode/permissionModes";
import {
  buildCodexPermissionExecution,
  buildCodexPermissionOptionCatalog,
  getCodexPermissionCapabilities,
  subscribeCodexPermissionProcessChanges,
  type CodexPermissionCapabilities,
} from "../src/codexAppServer/permissionProfiles";
import {
  applyCodexPermissionChoice,
  CODEX_APPROVE_PERMISSION_STATE,
  CODEX_ASK_PERMISSION_STATE,
  CODEX_CUSTOM_PERMISSION_STATE,
  CODEX_FULL_PERMISSION_STATE,
  codexProfileSelectionKey,
  serializeCodexPermissionState,
  type CodexPermissionState,
} from "../src/codexAppServer/permissionState";
import type { CodexAppServerProcess } from "../src/utils/codexAppServerProcess";

const PREFIX = "extensions.zotero.llmforzotero.";

function modernCapabilities(
  overrides: Partial<CodexPermissionCapabilities> = {},
): CodexPermissionCapabilities {
  return {
    protocol: "profiles",
    profiles: [
      { id: ":read-only", description: "Read files only.", allowed: true },
      { id: ":workspace", description: "Workspace access.", allowed: true },
      {
        id: ":danger-full-access",
        description: "Full local access.",
        allowed: true,
      },
      {
        id: ":team_custom-profile",
        description: "Managed team policy.",
        allowed: true,
      },
    ],
    allowedApprovalPolicies: null,
    allowedApprovalsReviewers: null,
    guardianApprovalEnabled: true,
    supportsThreadSettingsUpdate: true,
    ...overrides,
  };
}

function preference(state: CodexPermissionState, hasUserValue = true) {
  return { state, hasUserValue, raw: serializeCodexPermissionState(state) };
}

describe("provider permission modes", function () {
  const originalZotero = globalThis.Zotero;
  const originalServices = (globalThis as any).Services;
  let prefs: Map<string, unknown>;
  let userPrefs: Set<string>;

  beforeEach(function () {
    prefs = new Map();
    userPrefs = new Set();
    (globalThis as any).Zotero = {
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => {
          prefs.set(key, value);
          userPrefs.add(key);
        },
        prefHasUserValue: (key: string) => userPrefs.has(key),
      },
    };
    (globalThis as any).Services = {
      prefs: {
        prefHasUserValue: (key: string) => userPrefs.has(key),
      },
    };
  });

  after(function () {
    (globalThis as any).Zotero = originalZotero;
    (globalThis as any).Services = originalServices;
  });

  it("migrates the legacy Claude modes once without overwriting a new preference", function () {
    prefs.set(`${PREFIX}agentPermissionMode`, "yolo");
    userPrefs.add(`${PREFIX}agentPermissionMode`);
    migrateClaudePermissionMode();
    assert.equal(
      prefs.get(`${PREFIX}claudeCodePermissionMode`),
      "bypassPermissions",
    );

    prefs.clear();
    userPrefs.clear();
    prefs.set(`${PREFIX}agentPermissionMode`, "safe");
    userPrefs.add(`${PREFIX}agentPermissionMode`);
    prefs.set(`${PREFIX}claudeCodePermissionMode`, "plan");
    userPrefs.add(`${PREFIX}claudeCodePermissionMode`);
    migrateClaudePermissionMode();
    assert.equal(prefs.get(`${PREFIX}claudeCodePermissionMode`), "plan");
  });

  it("migrates the old Codex reviewer exactly once without inventing Full access", function () {
    prefs.set(`${PREFIX}codexAppServerApprovalsReviewer`, "auto_review");
    userPrefs.add(`${PREFIX}codexAppServerApprovalsReviewer`);
    prefs.set(
      `${PREFIX}codexAppServerPermissionProfile`,
      ":danger-full-access",
    );
    userPrefs.add(`${PREFIX}codexAppServerPermissionProfile`);
    migrateCodexPermissionState();
    assert.equal(
      prefs.get(`${PREFIX}codexAppServerPermissionState`),
      serializeCodexPermissionState(CODEX_APPROVE_PERMISSION_STATE),
    );

    const preserved = serializeCodexPermissionState(
      CODEX_CUSTOM_PERMISSION_STATE,
    );
    prefs.clear();
    userPrefs.clear();
    prefs.set(`${PREFIX}codexAppServerPermissionState`, preserved);
    userPrefs.add(`${PREFIX}codexAppServerPermissionState`);
    migrateCodexPermissionState();
    assert.equal(
      prefs.get(`${PREFIX}codexAppServerPermissionState`),
      preserved,
    );

    prefs.clear();
    userPrefs.clear();
    migrateCodexPermissionState();
    assert.isFalse(userPrefs.has(`${PREFIX}codexAppServerPermissionState`));
    assert.equal(
      prefs.get(`${PREFIX}codexAppServerPermissionStateMigrationDone`),
      true,
    );
  });

  it("round-trips provider preferences without cross-writing", function () {
    const customState: CodexPermissionState = {
      boundary: {
        kind: "profile",
        profileId: ":custom_profile-with-long-name",
      },
      approvalOverride: null,
    };
    setOriginalAgentPermissionMode("yolo");
    setClaudePermissionModePref("dontAsk");
    setCodexPermissionStatePref(customState);

    assert.equal(getOriginalAgentPermissionMode(), "yolo");
    assert.equal(getClaudePermissionModePref(), "dontAsk");
    assert.deepEqual(getCodexPermissionStatePref(), customState);
    assert.deepEqual(
      Array.from(prefs.keys()).sort(),
      [
        `${PREFIX}originalAgentPermissionMode`,
        `${PREFIX}claudeCodePermissionMode`,
        `${PREFIX}codexAppServerPermissionState`,
      ].sort(),
    );
  });

  it("migrates the library-only Original Agent preference without changing its valid value", function () {
    prefs.set(`${PREFIX}agentLibraryWriteMode`, "safe");
    userPrefs.add(`${PREFIX}agentLibraryWriteMode`);
    migrateOriginalAgentPermissionMode();
    assert.equal(prefs.get(`${PREFIX}originalAgentPermissionMode`), "safe");
  });

  it("resolves a provider-exclusive footer matrix", function () {
    const common = {
      originalSelectedId: "auto" as const,
      claudeSelectedId: "default" as const,
    };
    assert.equal(
      resolvePermissionSurface({
        ...common,
        conversationSystem: "upstream",
        runtimeMode: "chat",
      }).kind,
      "hidden",
    );
    const original = resolvePermissionSurface({
      ...common,
      conversationSystem: "upstream",
      runtimeMode: "agent",
    });
    assert.deepEqual(
      original.kind === "original"
        ? original.options.map((entry) => entry.selectionKey)
        : [],
      ["original:safe", "original:auto", "original:yolo"],
    );

    const claudeOptions = [
      "plan",
      "dontAsk",
      "default",
      "acceptEdits",
      "auto",
      "bypassPermissions",
    ].map((id) => buildClaudePermissionOption({ id: id as any }));
    const claude = resolvePermissionSurface({
      ...common,
      conversationSystem: "claude_code",
      runtimeMode: "chat",
      claudeOptions,
    });
    assert.deepEqual(
      claude.kind === "claude"
        ? claude.options.map((entry) => entry.selectionKey)
        : [],
      claudeOptions.map((entry) => entry.selectionKey),
    );

    const codexCatalog = buildCodexPermissionOptionCatalog({
      capabilities: modernCapabilities(),
      preference: preference(CODEX_ASK_PERMISSION_STATE),
    });
    const codex = resolvePermissionSurface({
      ...common,
      conversationSystem: "codex",
      runtimeMode: "chat",
      codexCatalog,
    });
    assert.deepEqual(
      codex.kind === "codex"
        ? codex.options.map((entry) => entry.selectionKey)
        : [],
      codexCatalog.options.map((entry) => entry.selectionKey),
    );
    assert.isFalse(
      codexCatalog.options.some((entry) =>
        entry.selectionKey.startsWith("original:"),
      ),
    );
  });

  it("uses concise labels while retaining exact named-profile identity", function () {
    const catalog = buildCodexPermissionOptionCatalog({
      capabilities: modernCapabilities({
        profiles: [
          ...modernCapabilities().profiles,
          {
            id: ":a-very_long-custom_profile-name",
            description: "Exact custom policy.",
            allowed: true,
          },
        ],
      }),
      preference: preference(CODEX_ASK_PERMISSION_STATE),
    });
    const named = catalog.options.find(
      (entry) =>
        entry.selectionKey ===
        codexProfileSelectionKey(":a-very_long-custom_profile-name"),
    )!;
    assert.equal(named.fullLabel, "a very long custom profile name");
    assert.equal(named.compactLabel, "a very long custom profile name");
    assert.include(
      buildPermissionAccessibleLabel(named),
      ":a-very_long-custom_profile-name",
    );
    assert.equal(
      buildClaudePermissionOption({ id: "acceptEdits" }).compactLabel,
      "edits",
    );
    assert.equal(
      buildClaudePermissionOption({ id: "dontAsk" }).compactLabel,
      "no prompts",
    );
    assert.equal(
      buildClaudePermissionOption({ id: "bypassPermissions" }).compactLabel,
      "bypass",
    );

    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    assert.include(css, "max-width: 14ch");
    assert.include(css, 'data-permission-provider="original"');
    assert.include(css, 'data-selection-key="claude:auto"');
    assert.notInclude(css, "data-permission-mode");
    assert.notInclude(css, ".llm-permission-option-level");
  });

  it("requires the Claude bridge capability and preserves managed availability", async function () {
    const fetchImpl = async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith("/healthz")) {
        return new Response(
          JSON.stringify({ ok: true, capabilities: ["permission_modes_v1"] }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          configuredDefaultMode: "plan",
          modes: [
            { id: "default", description: "Default", available: true },
            {
              id: "auto",
              description: "Auto",
              available: false,
              disabledReason: "Disabled by policy",
            },
          ],
        }),
        { status: 200 },
      );
    };
    const catalog = await fetchClaudePermissionModeCatalog({
      bridgeUrl: "http://127.0.0.1:19787",
      settingSources: ["user"],
      fetchImpl: fetchImpl as typeof fetch,
    });
    assert.equal(catalog.configuredDefaultMode, "plan");
    assert.equal(
      catalog.options.find((entry) => entry.selectionKey === "claude:auto")
        ?.available,
      false,
    );
    assert.equal(
      reconcileClaudePermissionMode({
        selectedId: "bypassPermissions",
        options: catalog.options,
      }).selectedId,
      "default",
    );
  });

  it("paginates profiles and features and applies complete managed constraints", async function () {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> =
      [];
    const proc = {
      async sendRequest(method: string, params?: Record<string, unknown>) {
        calls.push({ method, params });
        if (method === "permissionProfile/list") {
          return params?.cursor
            ? {
                data: [
                  { id: ":workspace", description: "Workspace", allowed: true },
                  {
                    id: ":danger-full-access",
                    description: "Full",
                    allowed: true,
                  },
                  { id: "custom_team", description: "Team", allowed: false },
                ],
              }
            : {
                data: [
                  { id: ":read-only", description: "Read", allowed: true },
                ],
                nextCursor: "profile-next",
              };
        }
        if (method === "experimentalFeature/list") {
          return params?.cursor
            ? { data: [{ name: "guardian_approval", enabled: true }] }
            : { data: [], nextCursor: "feature-next" };
        }
        if (method === "configRequirements/read") {
          return {
            requirements: {
              allowedApprovalPolicies: ["on-request", "never"],
              allowedApprovalsReviewers: ["user"],
            },
          };
        }
        throw new Error(`Unexpected method ${method}`);
      },
    } as CodexAppServerProcess;
    const capabilities = await getCodexPermissionCapabilities({
      proc,
      cwd: "/runtime",
      fresh: true,
    });
    assert.deepEqual(
      capabilities.profiles.map((entry) => entry.id),
      [":read-only", ":workspace", ":danger-full-access", "custom_team"],
    );
    assert.isTrue(capabilities.guardianApprovalEnabled);
    assert.deepEqual(Array.from(capabilities.allowedApprovalsReviewers || []), [
      "user",
    ]);
    assert.equal(
      calls.filter((entry) => entry.method === "permissionProfile/list").length,
      2,
    );
    assert.equal(
      calls.filter((entry) => entry.method === "experimentalFeature/list")
        .length,
      2,
    );

    const catalog = buildCodexPermissionOptionCatalog({
      capabilities,
      preference: preference(CODEX_ASK_PERMISSION_STATE),
    });
    assert.isFalse(
      catalog.options.find(
        (entry) => entry.selectionKey === "codex:preset:approve",
      )?.available,
    );
    assert.isFalse(
      catalog.options.find(
        (entry) =>
          entry.selectionKey === codexProfileSelectionKey("custom_team"),
      )?.available,
    );
  });

  it("invalidates capability state when the app-server process closes", async function () {
    let processClose: (() => void) | undefined;
    let profileId = "first-profile";
    let changeCount = 0;
    const unsubscribe = subscribeCodexPermissionProcessChanges(() => {
      changeCount += 1;
    });
    const proc = {
      onClose(handler: () => void) {
        processClose = handler;
        return () => undefined;
      },
      async sendRequest(method: string) {
        if (method === "permissionProfile/list") {
          return {
            data: [{ id: profileId, description: profileId, allowed: true }],
          };
        }
        if (method === "experimentalFeature/list") return { data: [] };
        if (method === "configRequirements/read") return {};
        throw new Error(`Unexpected method ${method}`);
      },
    } as unknown as CodexAppServerProcess;
    try {
      const first = await getCodexPermissionCapabilities({ proc, cwd: "/one" });
      profileId = "second-profile";
      processClose?.();
      const second = await getCodexPermissionCapabilities({
        proc,
        cwd: "/one",
      });
      assert.deepEqual(
        first.profiles.map((profile) => profile.id),
        ["first-profile"],
      );
      assert.deepEqual(
        second.profiles.map((profile) => profile.id),
        ["second-profile"],
      );
      assert.equal(changeCount, 1);
    } finally {
      unsubscribe();
    }
  });

  it("preserves native approval state for named profiles and replaces sticky Custom transitions", function () {
    const namedFromFull = applyCodexPermissionChoice({
      current: CODEX_FULL_PERMISSION_STATE,
      choice: { kind: "profile", profileId: "project-edit" },
    });
    assert.deepEqual(namedFromFull.approvalOverride, {
      policy: "never",
      reviewer: "user",
    });
    const namedFromCustom = applyCodexPermissionChoice({
      current: CODEX_CUSTOM_PERMISSION_STATE,
      choice: { kind: "profile", profileId: "project-edit" },
    });
    assert.isNull(namedFromCustom.approvalOverride);

    const customAfterAsk = buildCodexPermissionExecution({
      capabilities: modernCapabilities(),
      preference: preference(CODEX_CUSTOM_PERMISSION_STATE),
      hasExistingThread: true,
      appliedState: CODEX_ASK_PERMISSION_STATE,
    });
    assert.isTrue(customAfterAsk.requiresProviderThreadReplacement);
    assert.equal(customAfterAsk.replacementReason, "clear-boundary");
    assert.deepEqual(customAfterAsk.thread, {});

    const namedAfterApprove = buildCodexPermissionExecution({
      capabilities: modernCapabilities({
        profiles: [
          ...modernCapabilities().profiles,
          { id: "project-edit", description: "Project", allowed: true },
        ],
      }),
      preference: preference(namedFromCustom),
      hasExistingThread: true,
      appliedState: CODEX_APPROVE_PERMISSION_STATE,
    });
    assert.isTrue(namedAfterApprove.requiresProviderThreadReplacement);
    assert.equal(namedAfterApprove.replacementReason, "clear-approval");
    assert.deepEqual(namedAfterApprove.thread, { permissions: "project-edit" });
    assert.notProperty(namedAfterApprove.turn, "permissions");
    assert.notProperty(namedAfterApprove.turn, "sandboxPolicy");

    const confirmedCustom = buildCodexPermissionExecution({
      capabilities: modernCapabilities(),
      preference: preference(CODEX_CUSTOM_PERMISSION_STATE),
      hasExistingThread: true,
      appliedState: CODEX_CUSTOM_PERMISSION_STATE,
    });
    assert.isFalse(confirmedCustom.requiresProviderThreadReplacement);
  });

  it("keeps legacy read-only synthetic and never overwrites a modern choice", function () {
    const legacy: CodexPermissionCapabilities = {
      protocol: "legacy",
      profiles: [
        { id: ":read-only", description: "Legacy read only", allowed: true },
      ],
      allowedApprovalPolicies: null,
      allowedApprovalsReviewers: null,
      guardianApprovalEnabled: false,
      supportsThreadSettingsUpdate: false,
    };
    const synthetic = buildCodexPermissionOptionCatalog({
      capabilities: legacy,
      preference: preference(CODEX_ASK_PERMISSION_STATE, false),
    });
    assert.deepEqual(
      synthetic.options.map((entry) => entry.selectionKey),
      ["codex:legacy:read-only"],
    );
    assert.throws(
      () =>
        buildCodexPermissionExecution({
          capabilities: legacy,
          preference: preference(CODEX_ASK_PERMISSION_STATE, true),
        }),
      /Update Codex/,
    );
  });

  it("keeps malformed state visible while leaving valid recovery choices enabled", function () {
    prefs.set(
      `${PREFIX}codexAppServerPermissionState`,
      JSON.stringify({
        boundary: { kind: "config" },
        approvalOverride: { policy: "never", reviewer: "user" },
      }),
    );
    userPrefs.add(`${PREFIX}codexAppServerPermissionState`);
    const invalid = readCodexPermissionStatePref();
    assert.match(invalid.error || "", /invalid/i);
    const catalog = buildCodexPermissionOptionCatalog({
      capabilities: modernCapabilities(),
      preference: invalid,
    });
    assert.equal(catalog.selectedKey, "codex:invalid");
    assert.isFalse(
      catalog.options.find((entry) => entry.selectionKey === "codex:invalid")
        ?.available,
    );
    assert.isTrue(
      catalog.options.find((entry) => entry.selectionKey === "codex:preset:ask")
        ?.available,
    );
  });

  it("keeps the Original Agent option contract unchanged", function () {
    assert.deepEqual(
      getOriginalPermissionOptions().map((entry) => entry.selectionKey),
      ["original:safe", "original:auto", "original:yolo"],
    );
  });

  it("describes each mode by what the code actually does", function () {
    const byKey = Object.fromEntries(
      getOriginalPermissionOptions().map((entry) => [
        entry.selectionKey,
        entry.description,
      ]),
    );
    assert.include(
      byKey["original:safe"],
      "Requested new notes are created directly",
    );
    assert.include(byKey["original:safe"], "shown for review first");
    assert.notInclude(byKey["original:safe"], "filesystem reads");
    assert.include(byKey["original:auto"], "applied and then shown as a diff");
    assert.notInclude(byKey["original:auto"], "require review");
    assert.include(byKey["original:yolo"], "own judgment");
    assert.include(byKey["original:yolo"], "beyond the literal request");
    assert.include(byKey["original:yolo"], "Claude Code or Codex");
    // Every rail that still blocks in yolo has to be named, or the option
    // understates what the mode leaves enforced.
    assert.include(byKey["original:yolo"], "chat-only memory");
    assert.include(
      byKey["original:yolo"],
      "paper selection card before importing discovered papers",
    );
    assert.notInclude(byKey["original:yolo"], "require review");
    assert.notInclude(byKey["original:yolo"], "Only explicit prohibitions");
  });

  it("names the same yolo rails in the long mode description", function () {
    const description = getOriginalAgentPermissionModeDescription();
    assert.include(description, "chat-only memory");
    assert.include(
      description,
      "the paper selection card before importing discovered papers",
    );
    assert.include(description, "the change journal remain enforced");
  });

  it("falls back to auto when the preference store is unreadable", function () {
    const previous = (globalThis as { Zotero?: unknown }).Zotero;
    (globalThis as { Zotero?: unknown }).Zotero = {
      Prefs: {
        get: () => {
          throw new Error("prefs unavailable");
        },
      },
    };
    try {
      assert.equal(getOriginalAgentPermissionMode(), "auto");
    } finally {
      (globalThis as { Zotero?: unknown }).Zotero = previous;
    }
  });
});
