import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
  WorkflowTestPermissionSurfaceDiagnostics,
} from "../src/modules/contextPanel/workflowTestTypes";

const PREF_PREFIX = "extensions.zotero.llmforzotero";
const CODEX_ASK_STATE = JSON.stringify({
  boundary: { kind: "profile", profileId: ":workspace" },
  approvalOverride: { policy: "on-request", reviewer: "user" },
});

function readCodexPermissionState(): Record<string, any> {
  return JSON.parse(
    String(
      Zotero.Prefs.get(`${PREF_PREFIX}.codexAppServerPermissionState`, true),
    ),
  ) as Record<string, any>;
}

async function withPrefs<T>(
  prefs: Record<string, unknown>,
  task: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, unknown>();
  for (const [key, value] of Object.entries(prefs)) {
    const fullKey = `${PREF_PREFIX}.${key}`;
    previous.set(fullKey, Zotero.Prefs.get(fullKey, true));
    Zotero.Prefs.set(fullKey, value, true);
  }
  try {
    return await task();
  } finally {
    for (const [fullKey, value] of previous) {
      if (value === undefined) {
        Zotero.Prefs.clear?.(fullKey, true);
      } else {
        Zotero.Prefs.set(fullKey, value, true);
      }
    }
  }
}

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

function assertRows(
  surface: WorkflowTestPermissionSurfaceDiagnostics,
  expected: string[],
): void {
  assert.isTrue(surface.visible, JSON.stringify(surface));
  assert.isFalse(surface.disabled, JSON.stringify(surface));
  assert.deepEqual(
    surface.rows.map((row) => row.id),
    expected,
    JSON.stringify(surface),
  );
}

describe("workflow: provider-aware permission modes", function () {
  this.timeout(45000);

  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | null = null;

  beforeEach(async function () {
    api = getWorkflowTestApi();
    await api.reset();
  });

  afterEach(async function () {
    await api.closeStandalone();
    if (fixture) {
      await api.cleanupFixture(fixture);
      fixture = null;
    }
    await api.reset();
  });

  it("keeps provider rows, preferences, and delayed catalogs isolated in panel and standalone", async function () {
    await withPrefs(
      {
        enableAgentMode: true,
        enableClaudeCodeMode: true,
        enableCodexAppServerMode: true,
        conversationSystem: "upstream",
        agentLibraryWriteMode: "safe",
        claudeCodePermissionMode: "default",
        codexAppServerPermissionState: CODEX_ASK_STATE,
      },
      async () => {
        api.configurePermissionCatalogs({ delayFirstCodex: true });
        fixture = await api.createPaperWithPdfFixture({
          title: "Permission Mode Workflow Parent",
          pdfTitle: "Permission Mode Workflow PDF",
        });
        const panel = await api.renderPanelForItem(fixture.parentItemId);

        if (!api.getPanelPermissionSurface(panel.panelId).visible) {
          await api.clickPanelRuntimeModeToggle(panel.panelId);
        }
        assertRows(api.getPanelPermissionSurface(panel.panelId), [
          "original:safe",
          "original:auto",
          "original:yolo",
        ]);
        const originalPanel = api.getPanelPermissionSurface(panel.panelId);
        assert.deepEqual(
          originalPanel.rows.map((row) => row.label),
          ["Safe", "Auto", "Yolo"],
        );
        assert.deepEqual(
          originalPanel.rows.map((row) => row.level),
          ["", "", ""],
        );
        assert.isFalse(originalPanel.rows.at(-1)?.disabled);
        const openPanelMenu = await api.clickPanelPermissionToggle(
          panel.panelId,
        );
        assert.isTrue(openPanelMenu.expanded, JSON.stringify(openPanelMenu));
        assert.isTrue(openPanelMenu.menuVisible, JSON.stringify(openPanelMenu));

        await api.clickPanelSystemToggle(panel.panelId, "claude_code");
        assertRows(api.getPanelPermissionSurface(panel.panelId), [
          "claude:plan",
          "claude:dontAsk",
          "claude:default",
          "claude:acceptEdits",
          "claude:auto",
          "claude:bypassPermissions",
        ]);
        const afterClaudePlan = await api.clickPanelPermissionOption(
          panel.panelId,
          "claude:plan",
        );
        assert.equal(afterClaudePlan.compactLabel, "plan");
        assert.equal(
          Zotero.Prefs.get(`${PREF_PREFIX}.claudeCodePermissionMode`, true),
          "plan",
        );
        const afterClaude = await api.clickPanelPermissionOption(
          panel.panelId,
          "claude:bypassPermissions",
        );
        assert.equal(afterClaude.compactLabel, "bypass");
        assert.equal(
          Zotero.Prefs.get(`${PREF_PREFIX}.claudeCodePermissionMode`, true),
          "bypassPermissions",
        );
        assert.equal(
          Zotero.Prefs.get(`${PREF_PREFIX}.agentLibraryWriteMode`, true),
          "safe",
        );
        assert.equal(
          readCodexPermissionState().boundary.profileId,
          ":workspace",
        );

        await api.clickPanelSystemToggle(panel.panelId, "codex");
        await api.clickPanelSystemToggle(panel.panelId, "claude_code");
        await api.clickPanelSystemToggle(panel.panelId, "codex");
        const currentCodex = api.getPanelPermissionSurface(panel.panelId);
        assertRows(currentCodex, [
          "codex:preset:ask",
          "codex:preset:approve",
          "codex:preset:full",
          "codex:preset:custom",
          "codex:profile:%3Aread-only",
          "codex:profile:%3Ateam_custom_profile",
        ]);
        await api.resolveDelayedCodexPermissionCatalog();
        const afterStaleResponse = api.getPanelPermissionSurface(panel.panelId);
        assertRows(afterStaleResponse, [
          "codex:preset:ask",
          "codex:preset:approve",
          "codex:preset:full",
          "codex:preset:custom",
          "codex:profile:%3Aread-only",
          "codex:profile:%3Ateam_custom_profile",
        ]);
        assert.notInclude(
          afterStaleResponse.rows.map((row) => row.id),
          "codex:profile:%3Astale-profile",
        );

        await api.clickPanelPermissionOption(
          panel.panelId,
          "codex:preset:full",
        );
        const fullAccessDialog = api.getPanelConfirmationDialog(panel.panelId);
        assert.deepInclude(fullAccessDialog, {
          visible: true,
          title: "Enable Codex full access?",
          confirmLabel: "Enable full access",
          cancelLabel: "Cancel",
          destructive: true,
        });
        assert.include(fullAccessDialog.message, "unrestricted access");
        assert.equal(
          readCodexPermissionState().boundary.profileId,
          ":workspace",
        );
        await api.respondToPanelConfirmationDialog(panel.panelId, false);
        assert.isFalse(api.getPanelConfirmationDialog(panel.panelId).visible);
        assert.equal(
          readCodexPermissionState().boundary.profileId,
          ":workspace",
        );

        const afterCodex = await api.clickPanelPermissionOption(
          panel.panelId,
          "codex:preset:approve",
        );
        assert.equal(afterCodex.compactLabel, "approve");
        assert.equal(
          readCodexPermissionState().approvalOverride.reviewer,
          "auto_review",
        );
        assert.equal(
          Zotero.Prefs.get(`${PREF_PREFIX}.claudeCodePermissionMode`, true),
          "bypassPermissions",
        );
        assert.equal(
          Zotero.Prefs.get(`${PREF_PREFIX}.agentLibraryWriteMode`, true),
          "safe",
        );

        Zotero.Prefs.set(`${PREF_PREFIX}.conversationSystem`, "upstream", true);
        api.configurePermissionCatalogs();
        await api.openStandaloneForItem(fixture.parentItemId);
        assertRows(api.getStandalonePermissionSurface(), [
          "original:safe",
          "original:auto",
          "original:yolo",
        ]);
        assert.isFalse(
          api.getStandalonePermissionSurface().rows.at(-1)?.disabled,
        );
        const openStandaloneMenu = await api.clickStandalonePermissionToggle();
        assert.isTrue(
          openStandaloneMenu.expanded,
          JSON.stringify(openStandaloneMenu),
        );
        assert.isTrue(
          openStandaloneMenu.menuVisible,
          JSON.stringify(openStandaloneMenu),
        );
        await api.clickStandaloneSystemToggle("claude_code");
        assertRows(api.getStandalonePermissionSurface(), [
          "claude:plan",
          "claude:dontAsk",
          "claude:default",
          "claude:acceptEdits",
          "claude:auto",
          "claude:bypassPermissions",
        ]);
        await api.clickStandalonePermissionOption("claude:acceptEdits");
        assert.equal(
          Zotero.Prefs.get(`${PREF_PREFIX}.claudeCodePermissionMode`, true),
          "acceptEdits",
        );
        assert.equal(
          readCodexPermissionState().approvalOverride.reviewer,
          "auto_review",
        );
        await api.clickStandaloneSystemToggle("codex");
        assertRows(api.getStandalonePermissionSurface(), [
          "codex:preset:ask",
          "codex:preset:approve",
          "codex:preset:full",
          "codex:preset:custom",
          "codex:profile:%3Aread-only",
          "codex:profile:%3Ateam_custom_profile",
        ]);
        const standaloneCodex = await api.clickStandalonePermissionOption(
          "codex:profile:%3Ateam_custom_profile",
        );
        assert.equal(standaloneCodex.compactLabel, "team custom profile");
        assert.include(standaloneCodex.accessibleName, ":team_custom_profile");
        assert.equal(
          readCodexPermissionState().boundary.profileId,
          ":team_custom_profile",
        );
        assert.equal(
          Zotero.Prefs.get(`${PREF_PREFIX}.claudeCodePermissionMode`, true),
          "acceptEdits",
        );
        assert.equal(
          Zotero.Prefs.get(`${PREF_PREFIX}.agentLibraryWriteMode`, true),
          "safe",
        );
      },
    );
  });
});
