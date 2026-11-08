import { assert } from "chai";
import {
  decidePanelIdentityAdoption,
  resolveStandaloneConversationSwitch,
  type ConversationSwitchScope,
  type StandaloneConversationSwitchInput,
} from "../src/modules/contextPanel/standaloneConversationSwitch";

const libraryChat: ConversationSwitchScope = {
  system: "upstream",
  kind: "global",
  libraryID: 1,
  basePaperItemID: 0,
  isNote: false,
};

const paperChat: ConversationSwitchScope = {
  system: "upstream",
  kind: "paper",
  libraryID: 1,
  basePaperItemID: 42,
  isNote: false,
};

function input(
  overrides: Partial<StandaloneConversationSwitchInput> = {},
): StandaloneConversationSwitchInput {
  return {
    panelAlive: true,
    standalonePanel: true,
    sidePanel: false,
    ownershipBlocked: false,
    webChat: false,
    runtimeSwitchInFlight: false,
    inlineEditOpen: false,
    current: libraryChat,
    next: libraryChat,
    ...overrides,
  };
}

describe("standaloneConversationSwitch", function () {
  it("moves in place between conversations of one runtime, mode and scope", function () {
    assert.deepEqual(resolveStandaloneConversationSwitch(input()), {
      inPlace: true,
    });
    assert.deepEqual(
      resolveStandaloneConversationSwitch(
        input({ current: paperChat, next: paperChat }),
      ),
      { inPlace: true },
    );
    for (const system of ["codex", "claude_code"] as const) {
      assert.deepEqual(
        resolveStandaloneConversationSwitch(
          input({
            current: { ...libraryChat, system },
            next: { ...libraryChat, system },
          }),
        ),
        { inPlace: true },
        system,
      );
    }
  });

  it("names the reason a switch needs a full remount", function () {
    const cases: Array<[Partial<StandaloneConversationSwitchInput>, string]> = [
      [{ panelAlive: false }, "no-panel"],
      [{ standalonePanel: false }, "not-standalone"],
      [{ sidePanel: true }, "not-standalone"],
      [{ ownershipBlocked: true }, "ownership-blocked"],
      [{ webChat: true }, "webchat"],
      [{ runtimeSwitchInFlight: true }, "busy"],
      [{ inlineEditOpen: true }, "busy"],
      [{ current: { ...libraryChat, isNote: true } }, "note"],
      [{ next: { ...libraryChat, isNote: true } }, "note"],
      [{ next: { ...libraryChat, system: "codex" } }, "runtime-changed"],
      [{ next: paperChat }, "mode-changed"],
      [{ current: paperChat, next: libraryChat }, "mode-changed"],
      [{ next: { ...libraryChat, libraryID: 2 } }, "library-changed"],
      [
        { current: paperChat, next: { ...paperChat, basePaperItemID: 43 } },
        "paper-changed",
      ],
      [
        { current: { ...paperChat, basePaperItemID: 0 }, next: paperChat },
        "paper-changed",
      ],
    ];
    for (const [overrides, reason] of cases) {
      assert.deepEqual(
        resolveStandaloneConversationSwitch(input(overrides)),
        { inPlace: false, reason },
        JSON.stringify(overrides),
      );
    }
  });

  it("checks the panel's own state before the scopes", function () {
    assert.deepEqual(
      resolveStandaloneConversationSwitch(
        input({ webChat: true, next: paperChat }),
      ),
      { inPlace: false, reason: "webchat" },
    );
  });
});

describe("decidePanelIdentityAdoption", function () {
  it("ignores the window's own switches and adopts the panel's own", function () {
    assert.equal(decidePanelIdentityAdoption(5, 5), "ignore");
    assert.equal(decidePanelIdentityAdoption(5, 9), "adopt");
    assert.equal(decidePanelIdentityAdoption(5, 0), "ignore");
    assert.equal(decidePanelIdentityAdoption(5, Number.NaN), "ignore");
  });
});
