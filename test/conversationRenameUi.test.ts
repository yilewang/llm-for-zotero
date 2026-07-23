import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";

const here = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(here, "..", path), "utf8");
}

describe("conversation rename UI", function () {
  it("exposes rename beside standalone history rows and persists through the catalog", function () {
    const standaloneSource = source(
      "src/modules/contextPanel/standaloneWindow.ts",
    );
    const renderControl = standaloneSource.indexOf(
      'renameBtn.className = "llm-standalone-conv-rename"',
    );
    const renameHelper = standaloneSource.indexOf(
      "const renameStandaloneHistoryEntry = async",
      renderControl,
    );
    const catalogUpdate = standaloneSource.indexOf(
      "await conversationRepository.setCatalogTitle({",
      renameHelper,
    );
    const sidebarRefresh = standaloneSource.indexOf(
      "await renderSidebar();",
      catalogUpdate,
    );
    const clickHandler = standaloneSource.indexOf(
      '".llm-standalone-conv-rename"',
      sidebarRefresh,
    );
    const renameCall = standaloneSource.indexOf(
      "await renameStandaloneHistoryEntry(entry);",
      clickHandler,
    );

    assert.isAtLeast(renderControl, 0);
    assert.isAbove(renameHelper, renderControl);
    assert.isAbove(catalogUpdate, renameHelper);
    assert.isAbove(sidebarRefresh, catalogUpdate);
    assert.isAbove(clickHandler, sidebarRefresh);
    assert.isAbove(renameCall, clickHandler);
    assert.include(
      standaloneSource.slice(catalogUpdate, sidebarRefresh),
      "...target",
    );
    assert.include(standaloneSource, "canCommitConversationRename({");
    assert.notInclude(
      standaloneSource.slice(renameHelper, sidebarRefresh),
      "newWin.closed",
    );
    assert.include(standaloneSource, "showConversationRenameDialog");
    assert.notInclude(standaloneSource, ".prompt(");
  });

  it("makes the existing side-panel rename action visible on each history row", function () {
    const lifecycleSource = source(
      "src/modules/contextPanel/setupHandlers/controllers/historyLifecycleController.ts",
    );
    const renderControl = lifecycleSource.indexOf('"llm-history-item-rename"');
    const clickHandler = lifecycleSource.indexOf(
      'target.closest(\n        ".llm-history-item-rename"',
      renderControl,
    );
    const renameCall = lifecycleSource.indexOf(
      "void renameHistoryEntry(entry);",
      clickHandler,
    );

    assert.isAtLeast(renderControl, 0);
    assert.isAbove(clickHandler, renderControl);
    assert.isAbove(renameCall, clickHandler);
    assert.include(lifecycleSource, "showConversationRenameDialog");
    assert.include(lifecycleSource, "canRenameHistoryEntry(entry)");
    assert.include(lifecycleSource, "canCommitConversationRename({");
    assert.notInclude(lifecycleSource, ".prompt(");
  });

  it("uses the shared edit icon and reveals rename controls on row hover", function () {
    const css = source("addon/content/zoteroPane.css");

    assert.isTrue(
      existsSync(resolve(here, "../addon/content/icons/action-edit.svg")),
    );
    assert.include(css, ".llm-standalone-conv-rename::before");
    assert.include(css, ".llm-history-item-rename::before");
    assert.include(css, 'url("icons/action-edit.svg")');
    assert.include(
      css,
      ".llm-standalone-conv-item:hover .llm-standalone-conv-rename",
    );
    assert.include(css, ".llm-history-item:hover .llm-history-item-rename");
    assert.include(css, ".llm-conversation-rename-input");
    assert.include(css, "var(--color-accent, #2563eb)");
  });

  it("uses the shared in-panel modal design for all three actions", function () {
    const renameSource = source(
      "src/modules/contextPanel/conversationRenameDialog.ts",
    );
    const shortcutSource = source("src/modules/contextPanel/shortcuts.ts");
    const shortcutDialogSource = source(
      "src/modules/contextPanel/shortcutEditDialog.ts",
    );
    const confirmationSource = source(
      "src/modules/contextPanel/standaloneConfirmationDialog.ts",
    );

    for (const dialogSource of [
      renameSource,
      shortcutDialogSource,
      confirmationSource,
    ]) {
      assert.include(dialogSource, "llm-modal-overlay");
      assert.include(dialogSource, "llm-modal-dialog");
      assert.include(dialogSource, "parent.appendChild(overlay)");
      assert.include(dialogSource, "event.target === overlay");
      assert.notInclude(dialogSource, "ztoolkit.Dialog");
    }
    assert.include(shortcutSource, 'from "./shortcutEditDialog"');
    assert.include(shortcutSource, 'from "./standaloneConfirmationDialog"');
    assert.include(shortcutSource, "showShortcutEditDialog(doc, {");
    assert.include(shortcutSource, "showStandaloneConfirmationDialog(doc, {");
    assert.include(shortcutSource, 't("Reset Shortcuts")');
    assert.isFalse(
      existsSync(
        resolve(here, "../src/modules/contextPanel/nativePopupDialog.ts"),
      ),
    );
    assert.isFalse(existsSync(resolve(here, "../addon/content/dialog.css")));
  });

  it("uses the chat-panel surface for rename and shortcut fields", function () {
    const css = source("addon/content/zoteroPane.css");
    const dialogRuleStart = css.indexOf(".llm-modal-dialog {");
    const dialogRuleEnd = css.indexOf("}\n", dialogRuleStart);
    const dialogRule = css.slice(dialogRuleStart, dialogRuleEnd + 1);
    const controlRuleStart = css.indexOf(
      ".llm-conversation-rename-input,\n.llm-shortcut-edit-control {",
    );
    const controlRuleEnd = css.indexOf("}\n", controlRuleStart);
    const controlRule = css.slice(controlRuleStart, controlRuleEnd + 1);
    const focusRuleStart = css.indexOf(".llm-conversation-rename-input:focus,");
    const focusRuleEnd = css.indexOf("}", focusRuleStart);
    const focusRule = css.slice(focusRuleStart, focusRuleEnd + 1);

    assert.isAtLeast(dialogRuleStart, 0);
    assert.include(dialogRule, "--llm-modal-control-background: var(");
    assert.include(dialogRule, "--material-sidepane");
    assert.include(dialogRule, "var(--material-background, #ffffff)");
    assert.notInclude(dialogRule, "--llm-modal-control-background: color-mix(");
    assert.include(dialogRule, "--llm-modal-control-border: var(");
    assert.isAtLeast(controlRuleStart, 0);
    assert.include(
      controlRule,
      "background: var(--llm-modal-control-background)",
    );
    assert.include(
      controlRule,
      "border: 1px solid var(--llm-modal-control-border)",
    );
    assert.notInclude(controlRule, "background: var(--material-background)");
    assert.isAtLeast(focusRuleStart, 0);
    assert.include(focusRule, ".llm-conversation-rename-input:focus-visible");
    assert.include(focusRule, ".llm-shortcut-edit-control:focus-visible");
    assert.include(focusRule, "border-color: var(--llm-modal-control-border)");
    assert.include(focusRule, "outline: none");
    assert.include(focusRule, "box-shadow: none");
    assert.notInclude(focusRule, "--color-accent");
  });
});
