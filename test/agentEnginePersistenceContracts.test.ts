import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(here, "..", path), "utf8");
}

describe("agent engine persistence contracts", function () {
  it("refreshes assistant timestamps before normal and retry persistence", function () {
    const agentSource = source(
      "src/modules/contextPanel/agentMode/agentEngine.ts",
    );

    assert.include(
      agentSource,
      "function refreshAssistantMessageTimestampForPersistence(",
    );
    assert.include(agentSource, "Math.floor(userTimestamp) + 1");
    assert.include(agentSource, "Date.now()");
    assert.equal(
      agentSource.split(
        "const persistedTimestamp = refreshAssistantMessageTimestampForPersistence(",
      ).length - 1,
      2,
    );
    assert.equal(
      agentSource.split("timestamp: persistedTimestamp").length - 1,
      2,
    );
  });
});
