import { assert } from "chai";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(testDir, "..", path), "utf8");
}

const SETUP_HANDLERS_PATH = "src/modules/contextPanel/setupHandlers.ts";
const SETUP_HANDLERS_DIR = "src/modules/contextPanel/setupHandlers";

function collectTypeScriptFiles(dir: string): string[] {
  const entries = readdirSync(dir).sort();
  const files: string[] = [];
  for (const entry of entries) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectTypeScriptFiles(full));
      continue;
    }
    if (full.endsWith(".ts")) files.push(full);
  }
  return files;
}

/**
 * The panel's WebChat code may live in `setupHandlers.ts` or in a module under
 * `setupHandlers/`; these characterization tests pin behaviour of the surface
 * as a whole so that moving a feature out of the monolith does not silently
 * change it.
 */
function panelSurface(): string {
  const files = collectTypeScriptFiles(
    resolve(testDir, "..", SETUP_HANDLERS_DIR),
  );
  return [
    source(SETUP_HANDLERS_PATH),
    ...files.map((file) => readFileSync(file, "utf8")),
  ].join("\n");
}

function occurrences(haystack: string, pattern: RegExp): number {
  return haystack.match(pattern)?.length ?? 0;
}

/**
 * The WebChat connection dot runs on a 5s setInterval owned by the panel's
 * setupHandlers closure. Detaching the panel body (switching Zotero items)
 * runs cleanupSetupHandlers — if that path does not stop the interval and
 * abort the preload token, every detached WebChat panel leaks a permanent
 * timer that retains its whole DOM subtree.
 */
describe("WebChat teardown", function () {
  function cleanupBody(): string {
    const setupHandlers = source(SETUP_HANDLERS_PATH);
    const start = setupHandlers.indexOf("const cleanupSetupHandlers = () => {");
    const end = setupHandlers.indexOf(
      "setupHandlersCleanupByBody.set(body, cleanupSetupHandlers);",
    );
    assert.isAbove(start, -1, "cleanupSetupHandlers not found");
    assert.isAbove(end, start, "cleanup registration not found");
    return setupHandlers.slice(start, end);
  }

  /** Effectful statements of cleanupSetupHandlers, comments stripped. */
  function cleanupStatements(): string[] {
    return cleanupBody()
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.length > 0 &&
          !line.startsWith("//") &&
          !line.startsWith("/*") &&
          !line.startsWith("*"),
      );
  }

  function indexOfStatement(match: RegExp | string, label: string): number {
    const statements = cleanupStatements();
    const index = statements.findIndex((line) =>
      typeof match === "string" ? line.includes(match) : match.test(line),
    );
    assert.isAbove(index, -1, `${label} not found in cleanupSetupHandlers`);
    return index;
  }

  it("unmounts the WebChat feature when the panel body is torn down", function () {
    // What that unmount does — stop the poll, abort the preload — is pinned
    // behaviourally in test/setupHandlersWebChatFeature.test.ts.
    assert.match(cleanupBody(), /disposeWebChatFeature\(\);/);
  });

  it("registers the feature's own unmount as the handle cleanup calls", function () {
    // The two pins above only say that cleanup calls a handle and that
    // unmount() releases the poll. Without this one, rewiring the handle to
    // anything else leaves every test green while the 5s timer leaks again.
    const setupHandlers = source(SETUP_HANDLERS_PATH);

    assert.match(
      setupHandlers,
      /import \{[^}]*\bPanelLifecycle\b[^}]*\} from "\.\/setupHandlers\/lifecycle";/,
      "the panel must use the shared PanelLifecycle",
    );
    assert.include(
      setupHandlers,
      "const panelLifecycle = new PanelLifecycle();",
      "the panel must own a real PanelLifecycle, not a local stand-in",
    );

    const construction = setupHandlers.indexOf(
      "const webChatFeature = createWebChatFeature({",
    );
    assert.isAbove(construction, -1, "the WebChat feature is not constructed");

    const registration =
      /const (\w+) = panelLifecycle\.add\(\(\) =>\s*webChatFeature\.unmount\(\),?\s*\);/.exec(
        setupHandlers,
      );
    assert.isNotNull(
      registration,
      "the WebChat feature's unmount must be what is registered on the lifecycle",
    );
    const [matched, handle] = registration as RegExpExecArray;
    assert.isAbove(
      setupHandlers.indexOf(matched),
      construction,
      "the feature must be registered after it is constructed",
    );

    // Take the handle name from the registration so this cannot drift onto
    // some other disposable that happens to be called at the same place.
    assert.include(
      cleanupBody(),
      `${handle}();`,
      "cleanup must call the handle returned by that registration",
    );
  });

  it("disposes the panel lifecycle as a safety net for later features", function () {
    assert.include(cleanupBody(), "panelLifecycle.dispose();");
  });

  it("tears WebChat down first, before any other cleanup step", function () {
    const guard = indexOfStatement(
      "setupHandlersCleaned = true;",
      "re-entry guard",
    );
    const firstWebChat = indexOfStatement(/webchat/i, "WebChat teardown");
    assert.strictEqual(
      firstWebChat,
      guard + 1,
      "WebChat teardown must be the first effectful statement after the guard",
    );
    assert.isAbove(
      indexOfStatement("disconnectObserverCleanup?.();", "observer teardown"),
      firstWebChat,
    );
    assert.isAbove(
      indexOfStatement("disposeChatRendering(body);", "chat rendering dispose"),
      firstWebChat,
    );
  });

  it("unpublishes its panel handle and deletes the four body properties it published", function () {
    const body = cleanupBody();
    for (const property of [
      "unpublishPanelHandle(body, panelHandle);",
      "delete (body as any)[SCHEDULE_QUEUED_FOLLOW_UP_DRAIN_PROPERTY];",
      "delete (body as any)[SCHEDULE_QUEUED_FOLLOW_UP_THREAD_DRAIN_PROPERTY];",
      "delete (body as any).__llmQueueTurnDeletion;",
      "delete (body as any).__llmSearchPanelHistory;",
    ]) {
      assert.include(body, property);
    }
    for (const retired of [
      "__llmApplyResolvedClaudeEffort",
      "__llmRefreshContextSourceForCurrentItem",
      "__llmScheduleClaudeQueueDrain",
      "__llmScheduleClaudeThreadQueueDrain",
    ]) {
      assert.notInclude(body, retired);
    }
  });
});

describe("WebChat connection check ownership", function () {
  it("runs exactly one five-second connection poll for the panel", function () {
    const surface = panelSurface();
    assert.strictEqual(
      occurrences(surface, /setInterval\(check, 5000\)/g),
      1,
      "expected a single connection-check interval",
    );
    assert.strictEqual(
      occurrences(surface, /clearInterval\(\w*[cC]onnectionTimer\)/g),
      1,
      "expected a single connection-check clearInterval",
    );
  });

  it("starts the poll only where the connection dots are shown", function () {
    const setupHandlers = source(SETUP_HANDLERS_PATH);
    // One poll paints both dots: the Independent tab's and the Stacked chip's.
    assert.strictEqual(
      occurrences(setupHandlers, /startConnectionCheck\(/g),
      1,
      "the connection check must be started from exactly one place",
    );
    assert.strictEqual(
      occurrences(setupHandlers, /ConnectionCheck\(dot, modeSwitchDot\)/g),
      1,
      "the one poll covers the tab's and the chip's dots",
    );

    const applyStart = setupHandlers.indexOf(
      "const applyWebChatModeUI = () => {",
    );
    assert.isAbove(applyStart, -1, "applyWebChatModeUI not found");
    const applyEnd = setupHandlers.indexOf(
      "// Initialize model and preview state",
      applyStart,
    );
    assert.isAbove(applyEnd, applyStart, "applyWebChatModeUI end not found");
    const applyBody = setupHandlers.slice(applyStart, applyEnd);

    const dotAttached = applyBody.indexOf("paperChatTabBtn.prepend(dot);");
    const chipDotAttached = applyBody.indexOf(
      "const modeSwitchDot = showSidebarModeSwitchDot(modeSwitch);",
    );
    const startCall = applyBody.search(/ConnectionCheck\(dot, modeSwitchDot\)/);
    assert.isAbove(dotAttached, -1, "mode tab dot attachment not found");
    assert.isAbove(chipDotAttached, -1, "mode chip dot attachment not found");
    assert.isAbove(
      startCall,
      dotAttached,
      "the poll must start after the dot is attached to the mode tab",
    );
    assert.isAbove(
      startCall,
      chipDotAttached,
      "the poll must start after the dot is attached to the mode chip",
    );

    const dotRemoved = applyBody.indexOf("oldDot.remove();");
    const chipDotRemoved = applyBody.indexOf(
      "removeSidebarModeSwitchDot(modeSwitch);",
    );
    const stopCall = applyBody.search(/stop\w*ConnectionCheck\(\);/);
    assert.isAbove(dotRemoved, -1, "mode tab dot removal not found");
    assert.isAbove(chipDotRemoved, -1, "mode chip dot removal not found");
    assert.isAbove(
      stopCall,
      dotRemoved,
      "the poll must stop where the dot is removed",
    );
    assert.isAbove(
      stopCall,
      chipDotRemoved,
      "the poll must stop where the chip's dot is removed",
    );
  });
});

describe("WebChat preload ownership", function () {
  it("keeps exactly two preload launch sites, each with its own abort token", function () {
    const surface = panelSurface();
    assert.strictEqual(
      occurrences(surface, /await showWebChatPreloadScreen\(/g),
      2,
      "expected two preload launch sites",
    );
    assert.strictEqual(
      occurrences(surface, /const token = [\w.]*beginPreload\(\);/g),
      2,
      "each preload launch site must take a fresh abort token",
    );
  });

  it("shows the cold-start preload only for a WebChat panel with no session yet", function () {
    const surface = panelSurface();
    assert.match(
      surface,
      /isWebChatMode\(\) &&\s*!\w*[hH]asExistingWebChatSession\w*\(\)/,
      "cold-start preload guard not found",
    );
  });
});
