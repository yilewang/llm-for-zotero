import { assert } from "chai";
import {
  buildCarriedSkillsMessage,
  buildScopeItemKeysMessage,
  CARRIED_ITEM_KEYS_MAX,
} from "../src/agent/context/restartCarry";
import {
  withScopeItemKeys,
  type TaskPaperScopeSet,
} from "../src/agent/context/taskPaperScopeListing";
import type { ExecutionCheckpoint } from "../src/agent/types";

/**
 * What a restart of the provider session carries (restartCarry.ts): the
 * skills the turn loaded mid-turn and the scope's item keys, which the
 * restart's handles would otherwise hide (eval b4v6, run 2).
 */
function loaded(
  id: string,
  instructions: string,
  toolGuidance?: string,
): { name: string; ok: boolean; content: unknown } {
  return {
    name: "load_skill",
    ok: true,
    content: {
      found: true,
      skill: { id },
      instructions,
      scopeGuard: "Scope guard.",
      ...(toolGuidance ? { toolGuidance } : {}),
    },
  };
}

describe("restart carry: loaded skills", function () {
  it("carries each skill load_skill returned, with its guidance, once", function () {
    const message = buildCarriedSkillsMessage([
      loaded("literature-review", "Review body v1.", "Tool guidance: A."),
      { name: "paper_read", ok: true, content: { instructions: "no" } },
      { name: "load_skill", ok: false, content: { found: true } },
      { name: "load_skill", ok: true, content: { found: false } },
      // Loaded again: the host returns no guidance the second time.
      loaded("literature-review", "Review body v2."),
      loaded("compare-papers", "Compare body.", "Tool guidance: B."),
    ]);
    assert.exists(message);
    const text = String(message!.content);
    assert.isTrue(message!.transient);
    assert.include(text, "do not load them again");
    assert.include(text, "### Skill: literature-review\n\nReview body v2.");
    assert.notInclude(text, "Review body v1.");
    assert.include(text, "Tool guidance: A.");
    assert.include(text, "### Skill: compare-papers\n\nCompare body.");
    assert.include(text, "Tool guidance: B.");
    assert.equal(text.split("Scope guard.").length - 1, 1);
  });

  it("carries nothing for a skill the rendered prompt holds, or when none was loaded", function () {
    assert.isNull(buildCarriedSkillsMessage([]));
    assert.isNull(
      buildCarriedSkillsMessage(
        [loaded("literature-review", "Body.", "Guidance.")],
        ["literature-review"],
      ),
    );
  });
});

describe("restart carry: the scope's item keys", function () {
  const scope = (count: number): TaskPaperScopeSet =>
    withScopeItemKeys(
      {
        wholeLibrary: false,
        itemIds: Array.from({ length: count }, (_, index) => index + 1),
        withText: count,
        papers: Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            index + 1,
            { title: `Paper ${index + 1}`, text: "pdf" as const },
          ]),
        ),
      },
      (itemId) => (itemId === 3 ? undefined : `KEY${itemId}`),
    );

  it("lists itemId=itemKey for the scope, the papers the parts name first", function () {
    const checkpoint = {
      tasks: [{ origin: "model", targets: ["item:5", "folder:9"] }],
    } as unknown as ExecutionCheckpoint;
    const message = buildScopeItemKeysMessage(scope(5), 1, checkpoint);
    assert.exists(message);
    assert.equal(
      message!.content,
      "Item keys of the papers in this turn's scope (itemId=itemKey, libraryID 1), for citation sources and record_paper_decisions: 5=KEY5, 1=KEY1, 2=KEY2, 4=KEY4",
    );
  });

  it("caps the list and says how many it left out", function () {
    const message = buildScopeItemKeysMessage(
      scope(CARRIED_ITEM_KEYS_MAX + 10),
      1,
      undefined,
    );
    const text = String(message!.content);
    assert.include(
      text,
      `(${CARRIED_ITEM_KEYS_MAX} of ${CARRIED_ITEM_KEYS_MAX + 9}; library_search lists the rest)`,
    );
    assert.equal(text.split("=KEY").length - 1, CARRIED_ITEM_KEYS_MAX);
  });

  it("carries nothing without keys, and keeps a paper whose lookup throws", function () {
    assert.isNull(buildScopeItemKeysMessage(undefined, 1, undefined));
    const keyless = withScopeItemKeys(
      {
        wholeLibrary: false,
        itemIds: [1],
        withText: 0,
        papers: { 1: { title: "One", text: "none" } },
      },
      () => {
        throw new Error("no such item");
      },
    );
    assert.deepEqual(keyless.papers, { 1: { title: "One", text: "none" } });
    assert.isNull(buildScopeItemKeysMessage(keyless, 1, undefined));
  });
});
