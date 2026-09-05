import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(testDir, "..", path), "utf8");
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
    const setupHandlers = source("src/modules/contextPanel/setupHandlers.ts");
    const start = setupHandlers.indexOf("const cleanupSetupHandlers = () => {");
    const end = setupHandlers.indexOf(
      "setupHandlersCleanupByBody.set(body, cleanupSetupHandlers);",
    );
    assert.isAbove(start, -1, "cleanupSetupHandlers not found");
    assert.isAbove(end, start, "cleanup registration not found");
    return setupHandlers.slice(start, end);
  }

  it("stops the connection check when the panel body is torn down", function () {
    assert.include(cleanupBody(), "stopWebChatConnectionCheck();");
  });

  it("aborts any in-flight webchat preload when the panel body is torn down", function () {
    assert.include(cleanupBody(), "abortWebChatPreload();");
  });
});
