import { assert } from "chai";
import { createBuiltInActionRegistry } from "../src/agent/actions";
import {
  getBaseSlashMenuItems,
  resolveSlashActionChatMode,
  shouldRenderDynamicSlashMenu,
  shouldRenderSkillSlashMenu,
} from "../src/modules/contextPanel/slashMenuBehavior";

describe("slash menu behavior", function () {
  it("renders dynamic sections in original agent mode", function () {
    assert.isTrue(
      shouldRenderDynamicSlashMenu({
        itemPresent: true,
        isWebChat: false,
        runtimeMode: "agent",
        conversationSystem: "upstream",
      }),
    );
  });

  it("renders dynamic sections in Codex native mode", function () {
    assert.isTrue(
      shouldRenderDynamicSlashMenu({
        itemPresent: true,
        isWebChat: false,
        runtimeMode: "chat",
        conversationSystem: "codex",
      }),
    );
  });

  it("keeps Claude Code commands dynamic without showing original agent skills", function () {
    const params = {
      itemPresent: true,
      isWebChat: false,
      runtimeMode: "agent",
      conversationSystem: "claude_code",
    } as const;

    assert.isTrue(shouldRenderDynamicSlashMenu(params));
    assert.isFalse(shouldRenderSkillSlashMenu(params));
  });

  it("renders skills in original agent mode and Codex native mode", function () {
    assert.isTrue(
      shouldRenderSkillSlashMenu({
        itemPresent: true,
        isWebChat: false,
        runtimeMode: "agent",
        conversationSystem: "upstream",
      }),
    );
    assert.isTrue(
      shouldRenderSkillSlashMenu({
        itemPresent: true,
        isWebChat: false,
        runtimeMode: "chat",
        conversationSystem: "codex",
      }),
    );
  });

  it("does not render dynamic sections in upstream chat mode", function () {
    assert.isFalse(
      shouldRenderDynamicSlashMenu({
        itemPresent: true,
        isWebChat: false,
        runtimeMode: "chat",
        conversationSystem: "upstream",
      }),
    );
  });

  it("does not render dynamic sections in webchat", function () {
    assert.isFalse(
      shouldRenderDynamicSlashMenu({
        itemPresent: true,
        isWebChat: true,
        runtimeMode: "agent",
        conversationSystem: "codex",
      }),
    );
  });

  it("uses paper PDF base actions only for paper chat", function () {
    assert.deepEqual(
      getBaseSlashMenuItems(resolveSlashActionChatMode("global")),
      ["upload", "reference", "pastConversation"],
    );
    assert.deepEqual(
      getBaseSlashMenuItems(resolveSlashActionChatMode("paper")),
      [
        "upload",
        "reference",
        "pastConversation",
        "pdfPage",
        "pdfMultiplePages",
      ],
    );
  });

  it("keeps registered agent actions scoped by chat mode", function () {
    const registry = createBuiltInActionRegistry();
    const paperActions = registry
      .listActions("paper")
      .map((entry) => entry.name);
    const libraryActions = registry
      .listActions("library")
      .map((entry) => entry.name);

    assert.includeMembers(paperActions, [
      "auto_tag",
      "complete_metadata",
      "discover_related",
    ]);
    assert.notInclude(paperActions, "audit_library");
    assert.sameMembers(libraryActions, [
      "audit_library",
      "organize_unfiled",
      "auto_tag",
    ]);
    assert.notInclude(libraryActions, "discover_related");
    assert.notInclude(libraryActions, "complete_metadata");
    assert.notInclude(libraryActions, "library_statistics");
    assert.notInclude(libraryActions, "literature_review");
  });
});
