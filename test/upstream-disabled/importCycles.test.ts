import { assert } from "chai";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { checkImportCycles, formatCycle } = require("../scripts/check-import-cycles.cjs") as {
  checkImportCycles: (root?: string) => {
    unexpectedRuntime: string[][];
    staleAllowedRuntime: string[][];
    unexpectedStatic: string[][];
    staleAllowedStatic: string[][];
  };
  formatCycle: (cycle: string[]) => string;
};

function formatCycles(cycles: string[][]): string[] {
  return cycles.map((cycle) => formatCycle(cycle));
}

describe("import cycles", function () {
  it("does not introduce cycles outside the current allowlist", function () {
    const result = checkImportCycles(process.cwd());
    assert.deepEqual(formatCycles(result.unexpectedRuntime), []);
    assert.deepEqual(formatCycles(result.unexpectedStatic), []);
    assert.deepEqual(formatCycles(result.staleAllowedRuntime), []);
    assert.deepEqual(formatCycles(result.staleAllowedStatic), []);
  });
});
