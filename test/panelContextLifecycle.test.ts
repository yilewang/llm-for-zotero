import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import { describe, it } from "mocha";

import {
  hasPanelContextOwnerChanged,
  shouldRefreshContextSourceWithoutPanelRebuild,
} from "../src/modules/contextPanel/panelContextLifecycle";

const here = dirname(fileURLToPath(import.meta.url));

describe("panelContextLifecycle", function () {
  it("refreshes context source without rebuilding for parent to child under the same owner", function () {
    const decision = {
      needsFullRender: false,
      storedItemKey: "42",
      newItemKey: "42",
      currentKind: "paper",
      currentRawContextItemKey: "42",
      rawContextItemKey: "43",
      currentContextOwnerItemKey: "42",
      newContextOwnerItemKey: "42",
      currentContextSourceStateKey: "first-child::pdf::async",
      newContextSourceStateKey: "direct-attachment:43:text:html:sync",
    };

    assert.isFalse(hasPanelContextOwnerChanged(decision));
    assert.isTrue(shouldRefreshContextSourceWithoutPanelRebuild(decision));
  });

  it("does not treat a different paper owner as a same-DOM context refresh", function () {
    const decision = {
      needsFullRender: false,
      storedItemKey: "42",
      newItemKey: "42",
      currentKind: "paper",
      currentRawContextItemKey: "42",
      rawContextItemKey: "99",
      currentContextOwnerItemKey: "42",
      newContextOwnerItemKey: "99",
      currentContextSourceStateKey: "direct-attachment:43:text:html:sync",
      newContextSourceStateKey: "direct-attachment:100:text:html:sync",
    };

    assert.isTrue(hasPanelContextOwnerChanged(decision));
    assert.isFalse(shouldRefreshContextSourceWithoutPanelRebuild(decision));
  });

  it("does not skip async lifecycle completion for an uninitialized panel shell", function () {
    const source = readFileSync(
      resolve(here, "../src/modules/contextPanel/index.ts"),
      "utf8",
    );
    const guard = source.indexOf("isPanelBodyInitialized(body) &&");
    const completedCheck = source.indexOf(
      "hasCompletedPanelLifecycleSignature(body, lifecycleSignature",
    );

    assert.isAtLeast(guard, 0);
    assert.isAtLeast(completedCheck, 0);
    assert.isBelow(guard, completedCheck);
  });

  it("uses the completed setup stamp instead of the early handler stamp", function () {
    const indexSource = readFileSync(
      resolve(here, "../src/modules/contextPanel/index.ts"),
      "utf8",
    );
    const setupSource = readFileSync(
      resolve(here, "../src/modules/contextPanel/setupHandlers.ts"),
      "utf8",
    );

    assert.include(indexSource, "dataset?.handlersInitialized");
    assert.include(setupSource, "panelRoot.dataset.handlersInitialized");
    assert.include(setupSource, "panelRoot.dataset.handlersAttached = thisGen");
    assert.include(
      setupSource,
      "if (existingPanelRoot?.dataset.handlersInitialized)",
    );
  });

  it("checks the completed setup stamp before disposing existing handlers", function () {
    const setupSource = readFileSync(
      resolve(here, "../src/modules/contextPanel/setupHandlers.ts"),
      "utf8",
    );
    const setupStart = setupSource.indexOf("export function setupHandlers(");
    const completedGuard = setupSource.indexOf(
      "if (existingPanelRoot?.dataset.handlersInitialized)",
      setupStart,
    );
    const disposeCall = setupSource.indexOf(
      "disposeSetupHandlers(body);",
      setupStart,
    );
    const generationAllocation = setupSource.indexOf(
      "const thisGen = String(++setupHandlersGeneration);",
      setupStart,
    );

    assert.isAtLeast(setupStart, 0);
    assert.isAbove(completedGuard, setupStart);
    assert.isAbove(disposeCall, completedGuard);
    assert.isAbove(generationAllocation, disposeCall);
  });

  it("keeps selected-profile lookup callable during early setup refreshes", function () {
    const setupSource = readFileSync(
      resolve(here, "../src/modules/contextPanel/setupHandlers.ts"),
      "utf8",
    );

    assert.include(setupSource, "function getSelectedProfile()");
    assert.notInclude(setupSource, "const getSelectedProfile =");
  });

  it("flushes initial panel state only after setup-local initialization is ready", function () {
    const setupSource = readFileSync(
      resolve(here, "../src/modules/contextPanel/setupHandlers.ts"),
      "utf8",
    );
    const initStart = setupSource.indexOf("Initialize model and preview state");
    const coldStartup = setupSource.indexOf(
      "[webchat] Cold startup",
      initStart,
    );
    const initBlock = setupSource.slice(initStart, coldStartup);
    const applyWebChat = initBlock.indexOf("applyWebChatModeUI();");
    const resetPreview = initBlock.indexOf("resetComposePreviewUI();");
    const firstFlush = initBlock.indexOf("flushPanelStateRefreshNow();");
    const lastFlush = initBlock.lastIndexOf("flushPanelStateRefreshNow();");

    assert.isAtLeast(initStart, 0);
    assert.isAbove(coldStartup, initStart);
    assert.isAtLeast(applyWebChat, 0);
    assert.isAtLeast(resetPreview, 0);
    assert.isAtLeast(firstFlush, 0);
    assert.strictEqual(firstFlush, lastFlush);
    assert.isBelow(applyWebChat, firstFlush);
    assert.isBelow(resetPreview, firstFlush);
  });
});
