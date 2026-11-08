import { assert } from "chai";
import {
  bundledUnitPath,
  estimateWorkflowFileSeconds,
  filterTestPage,
  listWorkflowTestFiles,
  selectShard,
  shardCheckoutEntries,
} from "../scripts/workflow-test-selection.mjs";

function testPage(units: string[]): string {
  return `<body>
    <!-- Unit tests -->
    ${units.map((unit) => `<script src="${unit}"></script>`).join("\n    ")}

    <!-- Run Mocha -->
    <script class="mocha-exec">
      mocha.run();
    </script>
</body>`;
}

describe("workflow test selection", function () {
  it("keeps only the selected files' scripts in the generated test page", function () {
    const page = testPage([
      "units/a.workflow.test.js",
      "units/b.workflow.test.js",
      "units/nested/c.workflow.test.js",
    ]);
    const filtered = filterTestPage(page, [
      "a.workflow.test.ts",
      "nested/c.workflow.test.ts",
    ]);
    assert.include(
      filtered,
      '<script src="units/a.workflow.test.js"></script>',
    );
    assert.include(
      filtered,
      '<script src="units/nested/c.workflow.test.js"></script>',
    );
    assert.notInclude(filtered, "units/b.workflow.test.js");
    assert.include(filtered, "mocha.run();");
  });

  it("refuses a selected file the scaffold did not bundle", function () {
    const page = testPage(["units/a.workflow.test.js"]);
    assert.throws(
      () => filterTestPage(page, ["missing.workflow.test.ts"]),
      /not bundled: units\/missing\.workflow\.test\.js/,
    );
  });

  it("maps a workflow file to the scaffold's bundled path", function () {
    assert.equal(
      bundledUnitPath("libraryTextIndex/x.workflow.test.ts"),
      "units/libraryTextIndex/x.workflow.test.js",
    );
  });

  it("splits files into shards of similar run time, each file exactly once", function () {
    const seconds: Record<string, number> = {
      "a.ts": 60,
      "b.ts": 50,
      "c.ts": 30,
      "d.ts": 20,
      "e.ts": 10,
      "f.ts": 10,
    };
    const files = Object.keys(seconds);
    const secondsOf = (file: string) => seconds[file];
    const shards = [1, 2, 3].map((index) =>
      selectShard(files, secondsOf, index, 3),
    );
    assert.sameMembers(shards.flat(), files);
    const totals = shards.map((shard) =>
      shard.reduce((sum, file) => sum + secondsOf(file), 0),
    );
    assert.isAtMost(Math.max(...totals) - Math.min(...totals), 20);
    // The two slowest files never share a shard.
    assert.isFalse(
      shards.some((s) => s.includes("a.ts") && s.includes("b.ts")),
    );
  });

  it("rejects a shard outside its count", function () {
    assert.throws(
      () => selectShard(["a.ts"], () => 1, 4, 3),
      /between 1 and 3/,
    );
    assert.throws(() => selectShard(["a.ts"], () => 1, 1, 0), /positive/);
  });

  it("estimates an unmeasured file from its number of tests", function () {
    const source = `describe("x", () => {\n  it("one", () => {});\n  it("two", () => {});\n});`;
    assert.equal(
      estimateWorkflowFileSeconds("new.workflow.test.ts", source, {}),
      4,
    );
    assert.equal(
      estimateWorkflowFileSeconds("old.workflow.test.ts", source, {
        "old.workflow.test.ts": 30,
      }),
      30,
    );
  });

  it("finds every workflow test file, including nested folders", function () {
    const files = listWorkflowTestFiles();
    assert.include(files, "agentStopRules.workflow.test.ts");
    assert.include(
      files,
      "libraryTextIndex/libraryTextIndexDb.workflow.test.ts",
    );
    assert.isFalse(files.some((file) => file.startsWith("helpers/")));
  });

  it("links a parallel shard to everything but the scaffold output and git", function () {
    assert.deepEqual(
      shardCheckoutEntries([
        ".env",
        ".git",
        ".scaffold",
        "node_modules",
        "src",
      ]),
      [".env", "node_modules", "src"],
    );
  });
});
